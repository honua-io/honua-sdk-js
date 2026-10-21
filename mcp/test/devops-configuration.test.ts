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
    fixture.fetcher.mockImplementation(async () =>
      Response.json({
        targetId: "server-1",
        deployTargetId: "ecs-cell-1",
        environment: "dev",
        runtimeKind,
        backend,
      }),
    );
    const integration = await configuredDevOps(fixture.file, fixture.runtime);
    await integration.listTools();
    expect(createDevOpsExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeKind,
        env: expect.objectContaining({
          HONUA_DEVOPS_RUNTIME_KIND: runtimeKind,
          HONUA_DEVOPS_RUNTIME_BACKEND: backend,
          HONUA_DEVOPS_SERVER_TARGET_ID: "server-1",
          HONUA_DEVOPS_TERRAFORM_TARGETS: terraformTarget,
          HONUA_DEVOPS_HONUA_API_KEY: "scoped-agent-key",
        }),
      }),
      expect.any(Function),
    );
    fixture.fetcher.mockImplementation(async () =>
      Response.json({
        targetId: "server-1",
        deployTargetId: "ecs-cell-1",
        environment: "dev",
        runtimeKind,
        backend: "honua-gitops-kubernetes",
      }),
    );
    await expect(integration.callTool("describe_environment", {})).rejects.toThrow("runtime changed");
    await integration.close();
  });

  it.each(["honua-kubernetes-argo-rollouts", "honua-gitops-kubernetes"])(
    "refuses EKS authorization through the unsupported %s backend",
    async (backend) => {
      const fixture = await setup({ runtimeKind: "aws-eks" });
      fixture.fetcher.mockImplementation(async () =>
        Response.json({
          targetId: "server-1",
          deployTargetId: "ecs-cell-1",
          environment: "dev",
          runtimeKind: "aws-eks",
          backend,
        }),
      );
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
    expect(createDevOpsExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ HONUA_DEVOPS_HONUA_API_BASE_URL: "http://127.0.0.1:8080/tenant" }),
      }),
      expect.any(Function),
    );
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

  it("pins private child and authorization to the verified turn, then replaces the child on a turn switch", async () => {
    const fixture = await setup({
      env: {
        HONUA_DEVOPS_HONUA_WORKSPACE_ID: "untrusted-host-value",
        HONUA_DEVOPS_HONUA_TURN_ID: "untrusted-host-value",
      },
    });
    let bound = { workspaceId: "workspace-1", turnId: "turn-1" };
    const integration = await configuredDevOps(fixture.file, fixture.runtime, fetch, () => bound);
    await integration.listTools();
    const first = vi.mocked(createDevOpsExtension).mock.calls[0]?.[0];
    expect(first?.env).toMatchObject({
      HONUA_DEVOPS_HONUA_WORKSPACE_ID: "workspace-1",
      HONUA_DEVOPS_HONUA_TURN_ID: "turn-1",
    });
    expect(first?.requireTurnBindingCapability).toBe(true);
    const request = fixture.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request[1].headers).toMatchObject({ "X-Honua-Workspace": "workspace-1", "X-Honua-Turn": "turn-1" });
    bound = { workspaceId: "workspace-1", turnId: "turn-2" };
    await integration.listTools();
    expect(createDevOpsExtension).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createDevOpsExtension).mock.calls[1]?.[0].env).toMatchObject({
      HONUA_DEVOPS_HONUA_WORKSPACE_ID: "workspace-1",
      HONUA_DEVOPS_HONUA_TURN_ID: "turn-2",
    });
    await integration.close();
  });

  it("keeps an earlier turn's private child alive until its in-flight action completes", async () => {
    const fixture = await setup();
    let bound = { workspaceId: "workspace-1", turnId: "turn-a" };
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstClose = vi.fn(async () => {});
    vi.mocked(createDevOpsExtension).mockImplementationOnce((_config, authorize) => ({
      listTools: async () => [],
      callTool: async (name, args) => {
        await authorize({ canonicalTool: name, arguments: args });
        started();
        await held;
        return { content: [] };
      },
      close: firstClose,
    }));
    const integration = await configuredDevOps(fixture.file, fixture.runtime, fetch, () => bound);
    const first = integration.callTool("describe_environment", {});
    await entered;
    bound = { workspaceId: "workspace-1", turnId: "turn-b" };
    await integration.listTools();
    expect(createDevOpsExtension).toHaveBeenCalledTimes(2);
    expect(firstClose).not.toHaveBeenCalled();
    expect(
      vi.mocked(createDevOpsExtension).mock.calls.map(([config]) => config.env?.HONUA_DEVOPS_HONUA_TURN_ID),
    ).toEqual(["turn-a", "turn-b"]);
    expect((fixture.fetcher.mock.calls as unknown as [URL, RequestInit][]).map(([, init]) => init.headers)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ "X-Honua-Turn": "turn-a" }),
        expect.objectContaining({ "X-Honua-Turn": "turn-b" }),
      ]),
    );
    release();
    await first;
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
    await integration.close();
  });

  it("caps eight in-flight turn children before starting a ninth and frees slots after completion", async () => {
    const fixture = await setup();
    let bound = { workspaceId: "workspace-1", turnId: "turn-1" };
    const entered: Promise<void>[] = [];
    const release: (() => void)[] = [];
    vi.mocked(createDevOpsExtension).mockImplementation((_config, authorize) => {
      let started!: () => void;
      entered.push(
        new Promise<void>((resolve) => {
          started = resolve;
        }),
      );
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      release.push(finish);
      return {
        listTools: async () => [],
        callTool: async (name, args) => {
          await authorize({ canonicalTool: name, arguments: args });
          started();
          await held;
          return { content: [] };
        },
        close: async () => {},
      };
    });
    const integration = await configuredDevOps(fixture.file, fixture.runtime, fetch, () => bound);
    const running: Promise<unknown>[] = [];
    for (let index = 1; index <= 8; index++) {
      bound = { workspaceId: "workspace-1", turnId: `turn-${index}` };
      running.push(integration.callTool("describe_environment", {}));
      await vi.waitFor(() => expect(entered).toHaveLength(index));
      await entered[index - 1];
    }
    bound = { workspaceId: "workspace-1", turnId: "turn-9" };
    await expect(integration.listTools()).rejects.toThrow("child session capacity reached");
    expect(createDevOpsExtension).toHaveBeenCalledTimes(8);
    release[0]?.();
    await running[0];
    await vi.waitFor(async () => {
      await integration.listTools();
      expect(createDevOpsExtension).toHaveBeenCalledTimes(9);
    });
    for (const finish of release) finish();
    await Promise.all(running);
    await integration.close();
  });

  it("counts children with pending close against the same process cap", async () => {
    const fixture = await setup();
    let bound = { workspaceId: "workspace-1", turnId: "turn-1" };
    const releaseClose: (() => void)[] = [];
    vi.mocked(createDevOpsExtension).mockImplementation(() => {
      let finish!: () => void;
      const pendingClose = new Promise<void>((resolve) => {
        finish = resolve;
      });
      releaseClose.push(finish);
      return {
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        close: async () => pendingClose,
      };
    });
    const integration = await configuredDevOps(fixture.file, fixture.runtime, fetch, () => bound);
    for (let index = 1; index <= 8; index++) {
      bound = { workspaceId: "workspace-1", turnId: `turn-${index}` };
      await integration.listTools();
    }
    bound = { workspaceId: "workspace-1", turnId: "turn-9" };
    await expect(integration.listTools()).rejects.toThrow("child session capacity reached");
    expect(createDevOpsExtension).toHaveBeenCalledTimes(8);
    releaseClose[0]?.();
    await vi.waitFor(async () => {
      await integration.listTools();
      expect(createDevOpsExtension).toHaveBeenCalledTimes(9);
    });
    for (const finish of releaseClose) finish();
    await integration.close();
  });

  it("refuses malformed turn context before private authorization or child startup", async () => {
    const fixture = await setup();
    const integration = await configuredDevOps(fixture.file, fixture.runtime, fetch, () => ({
      workspaceId: "../other",
      turnId: "turn-1",
    }));
    await expect(integration.listTools()).rejects.toThrow("Invalid private integration turn binding");
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(createDevOpsExtension).not.toHaveBeenCalled();
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
