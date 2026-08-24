import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_INSTALL_SERVER_IMAGE,
  cloudInstallHandoff,
  getHonuaLocalStatus,
  installHonuaLocal,
  renderLocalCompose,
  renderMcpConfig,
} from "../src/local-install.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "honua-local-install-"));
  cleanup.push(directory);
  return directory;
}

describe("local Honua installer", () => {
  it("renders the manifest-pinned server, PostGIS, Redis, and the GP entitlement only for gp-dev", () => {
    const quickstart = renderLocalCompose({ profile: "quickstart" });
    const gp = renderLocalCompose({ profile: "gp-dev" });
    expect(LOCAL_INSTALL_SERVER_IMAGE).toContain("@sha256:");
    expect(quickstart).toContain("pgrouting/pgrouting:17-3.5-3.7.3");
    expect(quickstart).toContain("redis:7.4-alpine");
    expect(quickstart).toContain("image: ${HONUA_SERVER_IMAGE}");
    expect(quickstart).toContain('Licensing__DevGrantEdition: ""');
    expect(gp).toContain('Licensing__DevGrantEdition: "Pro"');
  });

  it("fails before Docker when the immutable release image regresses the generated Admin contract", async () => {
    const directory = tempDirectory();
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const run = async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    await expect(installHonuaLocal({ directory, profile: "gp-dev" }, { run })).rejects.toThrow(
      /manifest-pinned server.*395.*requires 396/s,
    );
    expect(commands).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("reports installed readiness and emits the cloud handoff without wrapping terraform", async () => {
    const directory = tempDirectory();
    expect(await getHonuaLocalStatus(directory)).toEqual({ installed: false, ready: false, directory });
    expect(cloudInstallHandoff("aws-serverless")).toEqual({
      status: "handoff-required",
      stack: "aws-serverless",
      iacPath: "honua-iac/infrastructure/terraform/examples/aws-serverless",
      mcpTool: "provision_infrastructure",
    });
    expect(() => cloudInstallHandoff("gcp")).toThrow(/Unknown cloud stack/);
  });

  it("writes a proxy configuration that uses the remote MCP surface", () => {
    expect(JSON.parse(renderMcpConfig("http://127.0.0.1:9090", "key"))).toMatchObject({
      mcpServers: {
        honua: {
          command: "npx",
          env: { HONUA_MCP_REMOTE_URL: "http://127.0.0.1:9090/mcp", HONUA_ADMIN_KEY: "key" },
        },
      },
    });
  });
});
