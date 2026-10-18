import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { LOCAL_WORKSPACE_AGENT_GRANTS, installHonuaLocal, renderLocalCompose } from "../src/local-install.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const nativeWorkspace = {
  serverImage: `example.invalid/server@sha256:${"a".repeat(64)}`,
  consoleImage: `example.invalid/console@sha256:${"b".repeat(64)}`,
  releaseId: "isolated-preview",
  gatewayCommand: "/qualified/preview/honua-agent-mcp",
};

it("binds a separate verified workspace credential, preserves it on reinstall, and never lends the human key to Console", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "honua-workspace-installer-"));
  directories.push(directory);
  const keys: { id: string; name: string; key: string; permissions: string[]; status: string; keyPrefix: string }[] =
    [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/healthz/ready") return new Response("ready");
    if (url.pathname === "/api/v1/agent/target") return Response.json({ targetId: "persisted-server-target" });
    if (url.pathname === "/api/v1/admin/api-keys" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const id = keys.length ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111";
      const key = `hnua_${keys.length}_transport-only-secret-material`;
      const record = { ...body, id, key, keyPrefix: key.slice(0, 12), status: "active" };
      keys.push(record);
      return Response.json({ success: true, data: { apiKey: record, key } }, { status: 201 });
    }
    if (url.pathname === "/api/v1/admin/api-keys") return Response.json({ success: true, data: keys });
    const key = keys.find((value) => url.pathname === `/api/v1/admin/api-keys/${value.id}/effective-permissions`);
    if (key) return Response.json({ success: true, data: { ...key, canAuthenticate: true } });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const first = await installHonuaLocal({ directory, nativeWorkspace }, { fetchFn, run });
  expect(keys).toHaveLength(2);
  expect(keys[0]?.permissions).toEqual(["admin:read", "admin:write", "read:*"]);
  expect(keys[1]?.permissions).toEqual(LOCAL_WORKSPACE_AGENT_GRANTS);
  const env = readFileSync(first.envFile, "utf8");
  expect(env).toContain("HONUA_AGENT_PRINCIPAL_ID=apikey:api-key:22222222-2222-4222-8222-222222222222");
  const compose = parse(readFileSync(first.composeFile, "utf8"));
  expect(compose.services.honua.environment.Studio__EndUserAuthorization__Enabled).toBe("true");
  expect(compose.services.console.environment.Studio__EmbedJsStudio).toBe("true");
  expect(compose.services.console.environment.HONUA_AGENT_API_KEY).toBe("${HONUA_AGENT_API_KEY:-}");
  expect(compose.services.console.environment).not.toHaveProperty("HONUA_ADMIN_API_KEY");
  expect(compose.services.console.environment).not.toHaveProperty("Authentication__OperatorBearer__SigningKey");
  expect(compose.services.console.environment.HONUA_LOCAL_HUMAN_BRIDGE_KEY).toBe("${HONUA_LOCAL_HUMAN_BRIDGE_KEY}");
  expect(compose.services.honua.environment.Authentication__OperatorBearer__SigningKey).toBe(
    "${HONUA_LOCAL_OPERATOR_SIGNING_KEY}",
  );
  expect(compose.services.honua.environment.AgentWorkspace__LocalHumanBridge__TenantId).toBe("public");
  expect(JSON.stringify(first)).not.toContain(keys[1]?.key);
  expect(first.workspaceQualification).toBe("preview-requires-human-pairing");
  const mcp = JSON.parse(readFileSync(first.mcpConfigFile, "utf8"));
  expect(mcp.mcpServers.honua).toEqual({
    command: nativeWorkspace.gatewayCommand,
    args: [],
    env: { HONUA_AGENT_INSTALL_DIRECTORY: directory },
  });
  expect(JSON.stringify(mcp)).not.toContain(keys[0]?.key);
  expect(JSON.stringify(mcp)).not.toContain(keys[1]?.key);
  const second = await installHonuaLocal({ directory, nativeWorkspace }, { fetchFn, run });
  expect(keys).toHaveLength(2);
  expect(second.workspaceCredential?.provisioned).toBe(false);
  expect(readFileSync(first.envFile, "utf8")).toBe(env);
  keys[1]!.permissions.push("write:*");
  await expect(installHonuaLocal({ directory, nativeWorkspace }, { fetchFn, run })).rejects.toThrow("scope");
});

it("requires explicit immutable preview artifacts before starting Docker", async () => {
  const run = vi.fn();
  await expect(
    installHonuaLocal(
      { directory: "/unused", nativeWorkspace: { ...nativeWorkspace, serverImage: "server:latest" } },
      { run },
    ),
  ).rejects.toThrow("immutable");
  expect(run).not.toHaveBeenCalled();
  const compose = parse(renderLocalCompose({ profile: "quickstart" }));
  expect(compose.services).not.toHaveProperty("console");
  expect(compose.services.honua.environment.AgentWorkspace__DeploymentId).toBe("${HONUA_AGENT_DEPLOYMENT_ID}");
});
