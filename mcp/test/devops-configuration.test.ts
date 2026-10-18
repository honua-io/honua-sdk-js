import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredDevOps } from "../src/agent/devops-configuration.js";
import {
  type DevOpsAuthorization,
  type DevOpsProcessConfiguration,
  createDevOpsExtension,
} from "../src/agent/devops-runtime.js";
import type { AgentConnection, AgentRuntime } from "../src/agent/local-runtime.js";

vi.mock("../src/agent/devops-runtime.js", () => ({
  createDevOpsExtension: vi.fn((_config: DevOpsProcessConfiguration, authorize: DevOpsAuthorization) => ({
    async listTools() {
      await authorize({ canonicalTool: null });
      return [];
    },
    async callTool(name: string, args: Record<string, unknown>) {
      await authorize({ canonicalTool: name, arguments: args });
      return { content: [] };
    },
    async close() {},
  })),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "honua-private-config-"));
  directories.push(directory);
  const file = path.join(directory, "devops.json");
  await writeFile(
    file,
    JSON.stringify({
      serverTargetId: "server-1",
      environment: "dev",
      deployTargetId: "ecs-cell-1",
      command: process.execPath,
      env: {
        HONUA_DEVOPS_HONUA_API_KEY: "broad-key-must-not-be-used",
        HONUA_DEVOPS_HONUA_API_BASE_URL: "https://wrong.test",
      },
      ...overrides,
    }),
    { mode: 0o600 },
  );
  let current: AgentConnection = {
    target: { id: "connection-1", endpoint: "http://127.0.0.1:8080/mcp", credentialId: "key-1" },
    transport: { remoteUrl: "http://127.0.0.1:8080/mcp", apiKey: "scoped-agent-key" },
  };
  const runtime: AgentRuntime = { inspect: async () => ({}), install: async () => {}, resolve: async () => current };
  const fetcher = vi.fn(async () =>
    Response.json({ targetId: "server-1", deployTargetId: "ecs-cell-1", environment: "dev" }),
  );
  vi.stubGlobal("fetch", fetcher);
  return {
    file,
    runtime,
    fetcher,
    replaceConnection(value: AgentConnection) {
      current = value;
    },
  };
}

describe("host-configured private integration identity", () => {
  it.each([
    ["aws-lambda", "lambda", "honua-gitops-aws-lambda"],
    ["aws-eks", "eks", "honua-kubernetes-deployment"],
  ])("binds %s only to its server-verified actuator on every call", async (runtimeKind, terraformTarget, backend) => {
    const fixture = await setup({ runtimeKind });
    fixture.fetcher.mockImplementation(async () => Response.json({
      targetId: "server-1", deployTargetId: "ecs-cell-1", environment: "dev", runtimeKind, backend,
    }));
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await integration.listTools();
    expect(createDevOpsExtension).toHaveBeenCalledWith(expect.objectContaining({
      runtimeKind,
      env: expect.objectContaining({
        HONUA_DEVOPS_RUNTIME_KIND: runtimeKind,
        HONUA_DEVOPS_RUNTIME_BACKEND: backend,
        HONUA_DEVOPS_SERVER_TARGET_ID: "server-1",
        HONUA_DEVOPS_TERRAFORM_TARGETS: terraformTarget,
        HONUA_DEVOPS_HONUA_API_KEY: "scoped-agent-key",
      }),
    }), expect.any(Function));
    fixture.fetcher.mockImplementation(async () => Response.json({
      targetId: "server-1", deployTargetId: "ecs-cell-1", environment: "dev", runtimeKind, backend: "honua-gitops-kubernetes",
    }));
    await expect(integration.callTool("describe_environment", {})).rejects.toThrow("runtime changed");
    await integration.close();
  });

  it.each(["honua-kubernetes-argo-rollouts", "honua-gitops-kubernetes"])(
    "refuses EKS authorization through the unsupported %s backend",
    async (backend) => {
      const fixture = await setup({ runtimeKind: "aws-eks" });
      fixture.fetcher.mockImplementation(async () => Response.json({
        targetId: "server-1", deployTargetId: "ecs-cell-1", environment: "dev",
        runtimeKind: "aws-eks", backend,
      }));
      const integration = await configuredDevOps(fixture.file, fixture.runtime);
      await expect(integration.listTools()).rejects.toThrow("runtime changed");
      expect(createDevOpsExtension).not.toHaveBeenCalled();
    },
  );

  it.each(["aws-lambda", "aws-eks"])("refuses an old authorization response for %s", async (runtimeKind) => {
    const fixture = await setup({ runtimeKind });
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await expect(integration.listTools()).rejects.toThrow("runtime changed");
    expect(createDevOpsExtension).not.toHaveBeenCalled();
    await integration.close();
  });

  it("preserves the authorized server path prefix for the API and private process", async () => {
    const fixture = await setup();
    fixture.replaceConnection({
      target: { id: "connection-1", endpoint: "http://127.0.0.1:8080/tenant/mcp", credentialId: "key-1" },
      transport: { remoteUrl: "http://127.0.0.1:8080/tenant/mcp", apiKey: "scoped-agent-key" },
    });
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await integration.listTools();
    const request = fixture.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(request[0])).toBe("http://127.0.0.1:8080/tenant/api/v1/agent/devops/authorize");
    expect(createDevOpsExtension).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ HONUA_DEVOPS_HONUA_API_BASE_URL: "http://127.0.0.1:8080/tenant" }),
    }), expect.any(Function));
    await integration.close();
  });

  it("rejects an unknown runtime before authorization or child startup", async () => {
    const fixture = await setup({ runtimeKind: "kubernetes" });
    await expect(configuredDevOps(fixture.file, fixture.runtime)).rejects.toThrow();
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(createDevOpsExtension).not.toHaveBeenCalled();
  });

  it("never lends the host's broad key or server URL and pins the environment and deployment", async () => {
    const fixture = await setup();
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await integration.listTools();
    expect(createDevOpsExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          HONUA_DEVOPS_HONUA_API_KEY: "scoped-agent-key",
          HONUA_DEVOPS_HONUA_API_BASE_URL: "http://127.0.0.1:8080",
          HONUA_DEVOPS_ALLOWED_ENVIRONMENTS: "dev",
          HONUA_DEVOPS_DEPLOY_TARGET_ID: "ecs-cell-1",
          HONUA_DEVOPS_TERRAFORM_TARGETS: "ecs",
        }),
      }),
      expect.any(Function),
    );
    const request = fixture.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(request[0])).toBe("http://127.0.0.1:8080/api/v1/agent/devops/authorize");
    expect(request[1].headers).toMatchObject({ "x-api-key": "scoped-agent-key" });
    expect(JSON.parse(String(request[1].body))).toMatchObject({
      targetId: "server-1",
      deployTargetId: "ecs-cell-1",
      environment: "dev",
      canonicalTool: null,
    });
    await integration.close();
  });

  it("rechecks credentials before each call and refuses rotation without reconnecting", async () => {
    const fixture = await setup();
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await integration.listTools();
    fixture.fetcher.mockClear();
    fixture.replaceConnection({
      target: { id: "connection-2", endpoint: "http://127.0.0.1:8081/mcp", credentialId: "key-2" },
      transport: { remoteUrl: "http://127.0.0.1:8081/mcp", apiKey: "other-key" },
    });
    await expect(integration.callTool("describe_environment", {})).rejects.toThrow("identity changed");
    expect(fixture.fetcher).not.toHaveBeenCalled();
    await integration.close();
  });

  it("refuses authorization and target mismatch before starting a private process", async () => {
    const fixture = await setup();
    fixture.fetcher.mockImplementationOnce(async () => new Response(null, { status: 403 }));
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await expect(integration.listTools()).rejects.toThrow("unauthorized");
    expect(createDevOpsExtension).not.toHaveBeenCalled();
    fixture.fetcher.mockImplementationOnce(async () => Response.json({ targetId: "other-server" }));
    await expect(integration.listTools()).rejects.toThrow("target changed");
    expect(createDevOpsExtension).not.toHaveBeenCalled();
    await integration.close();
  });

  it("sends effective action scope for per-call deployment and operation authorization", async () => {
    const fixture = await setup();
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await integration.listTools();
    fixture.fetcher.mockClear();
    const args = { operationId: "canonical-op", environmentsCsv: "dev" };
    await integration.callTool("get_devops_operation_status", args);
    const request = fixture.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(request[1].body))).toEqual({
      targetId: "server-1",
      deployTargetId: "ecs-cell-1",
      environment: "dev",
      canonicalTool: "get_devops_operation_status",
      arguments: args,
    });
    await integration.close();
  });

  it("rejects a receipt for another deployment or environment", async () => {
    const fixture = await setup();
    fixture.fetcher.mockImplementationOnce(async () =>
      Response.json({ targetId: "server-1", deployTargetId: "other-cell", environment: "dev" }),
    );
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await expect(integration.listTools()).rejects.toThrow("target changed");
    expect(createDevOpsExtension).not.toHaveBeenCalled();
    fixture.fetcher.mockImplementationOnce(async () =>
      Response.json({ targetId: "server-1", deployTargetId: "ecs-cell-1", environment: "prod" }),
    );
    await expect(integration.listTools()).rejects.toThrow("target changed");
    expect(createDevOpsExtension).not.toHaveBeenCalled();
    await integration.close();
  });

  it.skipIf(process.platform === "win32")("refuses configuration readable by other users", async () => {
    const fixture = await setup();
    await chmod(fixture.file, 0o644);
    await expect(configuredDevOps(fixture.file, fixture.runtime)).rejects.toThrow("private, bounded regular file");
    expect(createDevOpsExtension).not.toHaveBeenCalled();
  });
});
