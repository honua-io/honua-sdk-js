import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

vi.mock("../src/control-plane/generated/admin-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control-plane/generated/admin-operations.js")>()),
  ADMIN_RELEASE_CONTRACT_COMPATIBLE: false,
  ADMIN_RELEASE_OPERATION_COUNT: 395,
  ADMIN_RELEASE_CONTRACT_STATUS: "blocked-server-pin-regresses-admin-contract",
}));

import {
  LOCAL_INSTALL_MCP_PACKAGE,
  LOCAL_INSTALL_MCP_PACKAGE_NAME,
  LOCAL_INSTALL_MCP_PACKAGE_VERSION,
  LOCAL_INSTALL_SERVER_IMAGE,
  LOCAL_POSTGIS_BOOTSTRAP_SQL,
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
  it("renders the manifest-pinned server, PostGIS, and Redis", () => {
    const quickstart = renderLocalCompose({ profile: "quickstart" });
    expect(LOCAL_INSTALL_SERVER_IMAGE).toContain("@sha256:");
    expect(quickstart).toContain("pgrouting/pgrouting:17-3.5-3.7.3");
    expect(quickstart).toContain(
      'HONUA_LOCAL_DB_PASSWORD: "Host=postgres;Database=honua;Username=honua;Password=${POSTGRES_PASSWORD}"',
    );
    expect(LOCAL_POSTGIS_BOOTSTRAP_SQL).toContain("public.zero_to_map_parcels");
    expect(quickstart).toContain("postgis-bootstrap.sql:/bootstrap.sql:ro");
    expect(LOCAL_POSTGIS_BOOTSTRAP_SQL).toContain("CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public");
    expect(LOCAL_POSTGIS_BOOTSTRAP_SQL).toContain("n.nspname <> 'public'");
    expect(quickstart).toContain("service_completed_successfully");
    expect(quickstart).toContain("redis:7.4-alpine");
    expect(quickstart).toContain("image: ${HONUA_SERVER_IMAGE}");
  });

  it.each(["quickstart", "gp-dev"] as const)("uses the 2026.1 disabled-licensing policy for %s", (profile) => {
    const compose = parse(renderLocalCompose({ profile }));
    const environment = compose.services.honua.environment as Record<string, string>;
    expect(Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("Licensing__")))).toEqual({
      Licensing__Mode: "Disabled",
    });
    expect(
      Object.fromEntries(
        Object.entries(environment).filter(([key]) => key.startsWith("Security__RequestSecretReferences__")),
      ),
    ).toEqual({
      Security__RequestSecretReferences__AllowedEnvironmentVariables__0: "HONUA_LOCAL_DB_PASSWORD",
    });
    expect(environment.HONUA_ADMIN_PASSWORD).toBe("${HONUA_ADMIN_PASSWORD}");
  });

  it.each(["quickstart", "gp-dev"] as const)("waits for TCP PostgreSQL before bootstrapping %s", (profile) => {
    const compose = parse(renderLocalCompose({ profile }));
    expect(compose.services.postgres.healthcheck.test).toEqual([
      "CMD-SHELL",
      "pg_isready -h 127.0.0.1 -U honua -d honua",
    ]);
    expect(compose.services["postgis-bootstrap"].environment.PGHOST).toBe("postgres");
    expect(compose.services["postgis-bootstrap"].depends_on.postgres.condition).toBe("service_healthy");
    expect(compose.services.honua.depends_on["postgis-bootstrap"].condition).toBe("service_completed_successfully");
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

  it("pins the generated MCP configuration to an exact candidate artifact, never a floating package", () => {
    const config = JSON.parse(renderMcpConfig("http://127.0.0.1:9090", "key")) as {
      mcpServers: { honua: { args: string[] } };
    };
    expect(config.mcpServers.honua.args).toEqual(["-y", "--package", LOCAL_INSTALL_MCP_PACKAGE, "honua-mcp-proxy"]);
    expect(LOCAL_INSTALL_MCP_PACKAGE).toBe(`${LOCAL_INSTALL_MCP_PACKAGE_NAME}@${LOCAL_INSTALL_MCP_PACKAGE_VERSION}`);
    // `npx -y --package @honua/mcp-server@latest` would resolve to whatever the
    // registry serves at run time; the terminal journey must install a reviewed,
    // digest-recorded candidate. See test/verify-mcp-pin.test.ts for the lineage
    // and registry proofs.
    expect(LOCAL_INSTALL_MCP_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
