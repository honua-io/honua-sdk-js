import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { LOCAL_WORKSPACE_AGENT_GRANTS, installHonuaLocal, renderLocalCompose } from "../src/local-install.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const nativeWorkspace = {
  serverImage: `example.invalid/server@sha256:${"a".repeat(64)}`,
  consoleImage: `example.invalid/console@sha256:${"b".repeat(64)}`,
  releaseId: "isolated-preview",
  gatewayCommand: "/qualified/preview/honua-agent-mcp",
};

it("binds a separate verified workspace credential, preserves it on reinstall, and never lends the human key to Console", async () => {
  const nativeWithModel = {
    ...nativeWorkspace,
    localProcesses: { url: "http://host.docker.internal:7194", keyEnvironmentVariable: "PRIVATE_GP_KEY" },
    gatewayHttp: {
      url: "http://operator-selected-gateway:3010/",
      keyEnvironmentVariable: "HONUA_TEST_GATEWAY_BRIDGE_KEY",
    },
    modelProvider: {
      kind: "openai" as const,
      endpoint: "https://model.example/v1",
      model: "operator-selected-model",
      apiKeyEnvironmentVariable: "HONUA_TEST_NATIVE_MODEL_KEY",
    },
  };
  vi.stubEnv("HONUA_TEST_NATIVE_MODEL_KEY", "private-test-provider-key");
  vi.stubEnv("PRIVATE_GP_KEY", "separate-private-local-process-service-key");
  vi.stubEnv("HONUA_TEST_GATEWAY_BRIDGE_KEY", "independent-private-test-bridge-key-material");
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
  const first = await installHonuaLocal({ directory, nativeWorkspace: nativeWithModel }, { fetchFn, run });
  expect(keys).toHaveLength(2);
  expect(keys[0]?.permissions).toEqual(["admin:read", "admin:write", "read:*"]);
  expect(keys[1]?.permissions).toEqual(LOCAL_WORKSPACE_AGENT_GRANTS);
  const env = readFileSync(first.envFile, "utf8");
  const seed = env
    .split("\n")
    .find((line) => line.startsWith("HONUA_NATIVE_TRANSCRIPT_SEED="))
    ?.split("=")
    .slice(1)
    .join("=");
  expect(Buffer.from(seed!, "base64")).toHaveLength(32);
  expect(seed).not.toEqual(
    env
      .split("\n")
      .find((line) => line.startsWith("HONUA_LOCAL_OPERATOR_SIGNING_KEY="))
      ?.slice("HONUA_LOCAL_OPERATOR_SIGNING_KEY=".length),
  );
  expect(env).toContain("HONUA_NATIVE_MODEL_API_KEY=private-test-provider-key");
  expect(env).toContain("HONUA_AGENT_PRINCIPAL_ID=apikey:api-key:22222222-2222-4222-8222-222222222222");
  const compose = parse(readFileSync(first.composeFile, "utf8"));
  expect(compose.services.honua.environment.Studio__EndUserAuthorization__Enabled).toBe("true");
  const importPrefix = "AgentWorkspace__DatasetImport__LocalStorage__";
  const importSettings = Object.fromEntries(
    Object.entries(compose.services.honua.environment)
      .filter(([key]) => key.startsWith(importPrefix))
      .map(([key, value]) => [key.slice(importPrefix.length), value]),
  );
  expect(importSettings).toEqual({
    Enabled: "true",
    RootDirectory: "/var/lib/honua/storage/dataset-import",
    DomainId: "imports-${HONUA_AGENT_DEPLOYMENT_ID}",
    GlobalBytes: "${HONUA_IMPORT_GLOBAL_BYTES:-34359738368}",
    TenantBytes: "${HONUA_IMPORT_TENANT_BYTES:-25769803776}",
    OwnerBytes: "${HONUA_IMPORT_OWNER_BYTES:-17179869184}",
    MaximumObjects: "256",
    JournalCapacity: "256",
    MaximumScratchBytes: "${HONUA_IMPORT_MAX_SCRATCH_BYTES:-8589934592}",
    MaximumFileBytes: "${HONUA_IMPORT_MAX_FILE_BYTES:-4294967296}",
  });
  expect(compose.services.honua.volumes).toContain("honua_storage:/var/lib/honua/storage");
  expect(Object.keys(compose.services.console.environment).some((key) => key.startsWith(importPrefix))).toBe(false);
  expect(compose.services.console.environment.Studio__EmbedJsStudio).toBe("true");
  expect(compose.services.console.environment.HONUA_AGENT_API_KEY).toBe("${HONUA_AGENT_API_KEY:-}");
  expect(compose.services.console.environment.HONUA_AGENT_GATEWAY_URL).toBe("${HONUA_AGENT_GATEWAY_URL:-}");
  expect(compose.services.console.environment.HONUA_AGENT_GATEWAY_KEY).toBe("${HONUA_AGENT_GATEWAY_KEY:-}");
  expect(compose.services.honua.environment).not.toHaveProperty("HONUA_AGENT_GATEWAY_KEY");
  expect(compose.services.honua.environment.LocalProcesses__WorkspaceUrl).toBe("${HONUA_GP_WORKSPACE_URL:-}");
  expect(compose.services.honua.environment.HONUA_GP_WORKSPACE_KEY).toBe("${HONUA_GP_WORKSPACE_KEY:-}");
  expect(compose.services.console.environment).not.toHaveProperty("HONUA_GP_WORKSPACE_KEY");
  expect(compose.services.honua.extra_hosts).toEqual(["host.docker.internal:host-gateway"]);
  expect(compose.services.console.extra_hosts).toEqual(["host.docker.internal:host-gateway"]);
  expect(env).toContain("HONUA_GP_WORKSPACE_KEY=separate-private-local-process-service-key");
  expect(JSON.stringify(first)).not.toContain("separate-private-local-process-service-key");
  expect(JSON.stringify(first)).not.toContain("independent-private-test-bridge-key-material");
  expect(compose.services.console.environment).not.toHaveProperty("HONUA_NATIVE_TRANSCRIPT_SEED");
  expect(compose.services.console.environment).not.toHaveProperty("HONUA_STUDIOAI_NATIVE_API_KEY");
  expect(compose.services.honua.environment.StudioAiProxy__TranscriptSigning__PrivateKeyReference).toBe(
    "env:HONUA_NATIVE_TRANSCRIPT_SEED",
  );
  expect(compose.services.honua.environment.HONUA_STUDIOAI_NATIVE_API_KEY).toBe("${HONUA_NATIVE_MODEL_API_KEY:-}");
  expect(JSON.stringify(first)).not.toContain("private-test-provider-key");
  expect(JSON.stringify(first)).not.toContain(seed);
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
  // Reconcile the exact prior generated template; unrelated user edits remain protected.
  const previousCompose = readFileSync(first.composeFile, "utf8")
    .replace(/^ {6}AgentWorkspace__DatasetImport__LocalStorage__.*\n/gm, "")
    .replaceAll('    extra_hosts: ["host.docker.internal:host-gateway"]\n', "")
    .replace(
      "      LocalProcesses__WorkspaceUrl: ${HONUA_GP_WORKSPACE_URL:-}\n      HONUA_GP_WORKSPACE_KEY: ${HONUA_GP_WORKSPACE_KEY:-}\n",
      "",
    );
  writeFileSync(first.composeFile, previousCompose);
  const second = await installHonuaLocal({ directory, nativeWorkspace: nativeWithModel }, { fetchFn, run });
  expect(keys).toHaveLength(2);
  expect(second.workspaceCredential?.provisioned).toBe(false);
  expect(readFileSync(first.envFile, "utf8")).toBe(env);
  expect(parse(readFileSync(second.composeFile, "utf8")).services.honua.environment).toMatchObject(
    compose.services.honua.environment,
  );
  const humanBridge = env
    .split("\n")
    .find((line) => line.startsWith("HONUA_LOCAL_HUMAN_BRIDGE_KEY="))!
    .split("=")
    .slice(1)
    .join("=");
  vi.stubEnv("HONUA_TEST_GATEWAY_BRIDGE_KEY", humanBridge);
  run.mockClear();
  await expect(installHonuaLocal({ directory, nativeWorkspace: nativeWithModel }, { fetchFn, run })).rejects.toThrow(
    "independent",
  );
  expect(run).not.toHaveBeenCalled();
  vi.stubEnv("HONUA_TEST_GATEWAY_BRIDGE_KEY", "independent-private-test-bridge-key-material");
  vi.stubEnv("HONUA_TEST_NATIVE_MODEL_KEY", humanBridge);
  run.mockClear();
  await expect(installHonuaLocal({ directory, nativeWorkspace: nativeWithModel }, { fetchFn, run })).rejects.toThrow(
    "independent",
  );
  expect(run).not.toHaveBeenCalled();
  vi.stubEnv("HONUA_TEST_NATIVE_MODEL_KEY", "private-test-provider-key");
  vi.stubEnv("PRIVATE_GP_KEY", humanBridge);
  await expect(installHonuaLocal({ directory, nativeWorkspace: nativeWithModel }, { fetchFn, run })).rejects.toThrow(
    "independent",
  );
  expect(run).not.toHaveBeenCalled();
  vi.stubEnv("PRIVATE_GP_KEY", "independent-private-test-bridge-key-material");
  await expect(installHonuaLocal({ directory, nativeWorkspace: nativeWithModel }, { fetchFn, run })).rejects.toThrow(
    "independent",
  );
  expect(run).not.toHaveBeenCalled();
  vi.stubEnv("PRIVATE_GP_KEY", "separate-private-local-process-service-key");
  await installHonuaLocal(
    {
      directory,
      nativeWorkspace: {
        ...nativeWorkspace,
        modelProvider: { kind: "openai", endpoint: "http://host.docker.internal:11434/v1", model: "local-model" },
      },
    },
    { fetchFn, run },
  );
  expect(readFileSync(first.envFile, "utf8")).not.toContain("private-test-provider-key");
  expect(readFileSync(first.envFile, "utf8")).not.toContain("separate-private-local-process-service-key");
  expect(readFileSync(first.envFile, "utf8")).toContain("HONUA_GP_WORKSPACE_URL=\n");
  expect(readFileSync(first.envFile, "utf8")).toContain(`HONUA_NATIVE_TRANSCRIPT_SEED=${seed}`);
  keys[1]!.permissions.push("write:*");
  await expect(installHonuaLocal({ directory, nativeWorkspace: nativeWithModel }, { fetchFn, run })).rejects.toThrow(
    "scope",
  );
});

it.each([
  "http://localhost:7194",
  "http://127.0.0.1:7194",
  "http://[::1]:7194",
  "http://0.0.0.0:7194",
  "https://public.example",
  "http://8.8.8.8:7194",
  "http://172.32.0.1:7194",
  "http://host.docker.internal:7194/project",
  "http://host.docker.internal:7194/?key=x",
  "http://host.docker.internal:7194/#fragment",
  "http://user:secret@host.docker.internal:7194",
  "ftp://host.docker.internal:7194",
])("rejects unreachable or unsafe Docker process origins before Docker: %s", async (url) => {
  const run = vi.fn();
  await expect(
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: { ...nativeWorkspace, localProcesses: { url, keyEnvironmentVariable: "PRIVATE_GP_KEY" } },
      },
      { run },
    ),
  ).rejects.toThrow("private host origin");
  expect(run).not.toHaveBeenCalled();
});

it("rejects missing process credentials and authority aliases before Docker", async () => {
  const run = vi.fn();
  const install = (keyEnvironmentVariable: string) =>
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: {
          ...nativeWorkspace,
          localProcesses: { url: "http://host.docker.internal:7194", keyEnvironmentVariable },
        },
      },
      { run },
    );
  vi.stubEnv("PRIVATE_GP_KEY", undefined);
  await expect(install("PRIVATE_GP_KEY")).rejects.toThrow("unavailable");
  for (const name of [
    "HONUA_ADMIN_KEY",
    "HONUA_AGENT_API_KEY",
    "HONUA_AGENT_GATEWAY_KEY",
    "HONUA_NATIVE_MODEL_API_KEY",
  ])
    await expect(install(name)).rejects.toThrow("independent");
  vi.stubEnv("PRIVATE_GP_KEY", "independent-service-credential-material");
  vi.stubEnv("HONUA_ADMIN_KEY", "independent-service-credential-material");
  await expect(install("PRIVATE_GP_KEY")).rejects.toThrow("independent");
  expect(run).not.toHaveBeenCalled();
});

it.each(["\u0001", "\u007f", "é"])("rejects process keys the server cannot accept: %j", async (character) => {
  const run = vi.fn();
  vi.stubEnv("PRIVATE_GP_KEY", `${"valid-credential-prefix".repeat(2)}${character}`);
  await expect(
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: {
          ...nativeWorkspace,
          localProcesses: { url: "http://host.docker.internal:7194", keyEnvironmentVariable: "PRIVATE_GP_KEY" },
        },
      },
      { run },
    ),
  ).rejects.toThrow("unavailable or invalid");
  expect(run).not.toHaveBeenCalled();
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

it("rejects unavailable credential references before Docker or persistence", async () => {
  const run = vi.fn();
  await expect(
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: {
          ...nativeWorkspace,
          modelProvider: {
            kind: "openai",
            model: "selected",
            endpoint: "https://model.example/v1",
            apiKeyEnvironmentVariable: "HONUA_UNSET_NATIVE_MODEL_KEY",
          },
        },
      },
      { run },
    ),
  ).rejects.toThrow("unavailable");
  expect(run).not.toHaveBeenCalled();
});

it("rejects malformed optional Bedrock endpoints and reserved authority references before Docker", async () => {
  const run = vi.fn();
  await expect(
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: {
          ...nativeWorkspace,
          modelProvider: { kind: "bedrock", model: "selected", endpoint: "https://model.example/\nINJECT=value" },
        },
      },
      { run },
    ),
  ).rejects.toThrow("endpoint");
  await expect(
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: {
          ...nativeWorkspace,
          modelProvider: {
            kind: "openai",
            model: "selected",
            endpoint: "https://model.example/",
            apiKeyEnvironmentVariable: "HONUA_AGENT_API_KEY",
          },
        },
      },
      { run },
    ),
  ).rejects.toThrow("independent");
  expect(run).not.toHaveBeenCalled();
});

it("rejects unsafe native gateway origins and authority aliases before Docker", async () => {
  const run = vi.fn();
  vi.stubEnv("HONUA_TEST_GATEWAY_BRIDGE_KEY", "independent-private-test-bridge-key-material");
  for (const url of [
    "file:///tmp/key",
    "https://gateway/other",
    "https://gateway/?key=x",
    "https://user:secret@gateway/",
  ])
    await expect(
      installHonuaLocal(
        {
          directory: "/unused",
          nativeWorkspace: {
            ...nativeWorkspace,
            gatewayHttp: { url, keyEnvironmentVariable: "HONUA_TEST_GATEWAY_BRIDGE_KEY" },
          },
        },
        { run },
      ),
    ).rejects.toThrow("gateway");
  await expect(
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: {
          ...nativeWorkspace,
          gatewayHttp: { url: "http://gateway/", keyEnvironmentVariable: "HONUA_AGENT_API_KEY" },
        },
      },
      { run },
    ),
  ).rejects.toThrow("independent");
  vi.stubEnv("HONUA_ADMIN_KEY", "independent-private-test-bridge-key-material");
  await expect(
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: {
          ...nativeWorkspace,
          gatewayHttp: { url: "http://gateway/", keyEnvironmentVariable: "HONUA_TEST_GATEWAY_BRIDGE_KEY" },
        },
      },
      { run },
    ),
  ).rejects.toThrow("independent");
  expect(run).not.toHaveBeenCalled();
});

it("rejects model credential values aliased to host authority before Docker", async () => {
  const run = vi.fn();
  vi.stubEnv("HONUA_ADMIN_KEY", "same-private-authority-value");
  vi.stubEnv("HONUA_TEST_NATIVE_MODEL_KEY", "same-private-authority-value");
  await expect(
    installHonuaLocal(
      {
        directory: "/unused",
        nativeWorkspace: {
          ...nativeWorkspace,
          modelProvider: {
            kind: "openai",
            model: "selected",
            endpoint: "https://model.example/",
            apiKeyEnvironmentVariable: "HONUA_TEST_NATIVE_MODEL_KEY",
          },
        },
      },
      { run },
    ),
  ).rejects.toThrow("independent");
  expect(run).not.toHaveBeenCalled();
});
