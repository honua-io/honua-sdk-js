import { WORKFLOW_KNOWLEDGE as SDK_WORKFLOW_KNOWLEDGE } from "@honua/sdk-js/studio-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { DevOpsExtension } from "../src/agent/devops-runtime.js";
import { HonuaAgentGateway, connectAgentUpstream } from "../src/agent/gateway.js";
import type { AgentRuntime } from "../src/agent/local-runtime.js";
import { WORKFLOW_KNOWLEDGE_URI } from "../src/agent/workflow-knowledge.js";
import { startFixture } from "./fixtures/initialize-view/harness.mjs";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(
  options: {
    installed?: boolean;
    collision?: boolean;
    boundCollision?: boolean;
    fail?: boolean;
    devops?: DevOpsExtension;
    workflowView?: unknown;
    turnReadStatus?: number;
    turnRead?: (input: URL) => Promise<Response>;
  } = {},
) {
  let installed = options.installed ?? false;
  const calls: unknown[] = [];
  const views: (string | undefined)[] = [];
  const bindings: ({ workspaceId: string; turnId: string } | undefined)[] = [];
  const resourceReads: Record<string, unknown>[] = [];
  let notified = 0;
  let cancelled = false;
  const upstreamServers: Server[] = [];
  const makeUpstream = () => {
    const upstream = new Server(
      { name: "fixture", version: "1" },
      {
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      },
    );
    upstream.setRequestHandler(ListToolsRequestSchema, async (request) => ({
      tools: [
        {
          name:
            options.collision || (options.boundCollision && upstreamConnections >= 2 && request.params?.cursor)
              ? "honua_agent_status"
              : request.params?.cursor
                ? "second"
                : "echo",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
      ...(!request.params?.cursor ? { nextCursor: "second-page" } : {}),
      _meta: { revision: "fixture.v1" },
    }));
    upstream.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls.push(request);
      if (request.params.name === "progress" && request.params._meta?.progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: request.params._meta.progressToken,
            progress: 1,
            total: 2,
            message: "Preparing",
          },
        });
      }
      if (request.params.name === "forbidden")
        return {
          isError: true,
          content: [{ type: "text", text: "Access denied" }],
          structuredContent: { code: "permission_denied", requiredGrant: "admin:approve" },
        };
      if (request.params.name === "wait") {
        await new Promise<void>((resolve) =>
          extra.signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolve();
            },
            { once: true },
          ),
        );
      }
      return {
        content: [{ type: "text", text: "done" }],
        structuredContent: { args: request.params.arguments ?? {} },
        _meta: { receipt: "receipt-1" },
      };
    });
    upstream.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ name: "Fixture", uri: "honua://fixture" }],
    }));
    upstream.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [{ name: "Fixture template", uriTemplate: "honua://fixture/{id}" }],
    }));
    // Independent upstream declares the Server's documented resource-window extension.
    upstream.setRequestHandler(
      ReadResourceRequestSchema.extend({
        params: ReadResourceRequestSchema.shape.params.extend({
          cursor: z.string().optional(),
          maxChars: z.number().int().positive().max(1_000_000).optional(),
        }),
      }),
      async (request) => {
        resourceReads.push(request.params);
        if (request.params.uri !== "honua://catalog/processes")
          return { contents: [{ uri: request.params.uri, text: "canonical resource" }] };
        const document = JSON.stringify({
          processes: [
            { processId: "first", description: "GIS workflow 🗺️ ".repeat(6_000) },
            { processId: "last", executionKind: "Job" },
          ],
        });
        const offset = request.params.cursor ? Number(request.params.cursor.slice("window:".length)) : 0;
        const end = Math.min(offset + (request.params.maxChars ?? 64_000), document.length);
        return {
          contents: [{ uri: request.params.uri, mimeType: "application/json", text: document.slice(offset, end) }],
          ...(end < document.length ? { nextCursor: `window:${end}` } : {}),
          _meta: { catalogVersion: "fixture.window.v1" },
        };
      },
    );
    upstream.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "fixture-prompt" }] }));
    upstream.setRequestHandler(GetPromptRequestSchema, async () => ({
      messages: [{ role: "user", content: { type: "text", text: "canonical prompt" } }],
    }));
    upstreamServers.push(upstream);
    return upstream;
  };
  const upstream = makeUpstream();
  let upstreamConnections = 0;
  const runtime: AgentRuntime = {
    inspect: vi.fn(async () => ({ ready: true })),
    install: vi.fn(async () => {
      installed = true;
    }),
    resolve: vi.fn(async () => {
      if (!installed || options.fail) throw new Error("private-key-MUST-NOT-LEAK");
      return {
        target: { id: "target-1", endpoint: "http://127.0.0.1:8080/mcp", credentialId: "credential-1" },
        transport: { remoteUrl: "http://127.0.0.1:8080/mcp", apiKey: "private-key-MUST-NOT-LEAK" },
        credentialKind: "workspace-agent" as const,
        releaseId: "release-1",
        deploymentId: "server-target-1",
      };
    }),
  };
  const gateway = new HonuaAgentGateway(
    runtime,
    async (_connection, view, binding) => {
      views.push(view);
      bindings.push(binding);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const connected = new Client({ name: "gateway", version: "1" });
      await (upstreamConnections++ === 0 ? upstream : makeUpstream()).connect(b);
      await connected.connect(a);
      return connected;
    },
    options.devops,
    {
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        if (options.turnRead) return options.turnRead(new URL(String(input)));
        const match = /^\/api\/v1\/agent\/workspaces\/([^/]+)\/turns\/([^/]+)$/.exec(path);
        if (!match) return Response.json({}, { status: 404 });
        if (options.turnReadStatus) return Response.json({}, { status: options.turnReadStatus });
        return Response.json({
          turnId: match[2],
          context: { workspaceId: match[1], targetId: "server-target-1", tenantId: "tenant-1" },
        });
      },
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const send = a.send.bind(a);
  a.send = (message, transportOptions) =>
    send(
      "method" in message && message.method === "initialize" && "workflowView" in options
        ? { ...message, params: { ...message.params, _meta: { "honua.io/workflow-view": options.workflowView } } }
        : message,
      transportOptions,
    );
  const client = new Client({ name: "test-host", version: "1" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notified++;
  });
  cleanup.push(
    async () => {
      for (const server of upstreamServers) await server.close();
    },
    () => gateway.close(),
    () => client.close(),
  );
  await gateway.connect(b);
  await client.connect(a);
  await vi.waitFor(async () => {
    const status = await client.callTool({ name: "honua_agent_status" });
    expect(status.structuredContent?.state).not.toBe("connecting");
  });
  return {
    client,
    gateway,
    upstream,
    upstreamServers,
    runtime,
    calls,
    resourceReads,
    views,
    bindings,
    notifications: () => notified,
    cancelled: () => cancelled,
  };
}

describe("persistent Honua agent gateway", () => {
  it("binds an observed current human turn on the same registration", async () => {
    const fixture = await setup({ installed: true });
    const bound = await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    expect(bound.structuredContent).toMatchObject({
      state: "attached",
      turnBinding: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    expect(fixture.bindings).toEqual([undefined, { workspaceId: "workspace-1", turnId: "turn-2" }]);
    expect((await fixture.client.callTool({ name: "echo", arguments: {} })).isError).not.toBe(true);
    expect(fixture.runtime.install).not.toHaveBeenCalled();
  });

  it("advertises only an empty connect request or the complete workspace/turn pair", async () => {
    const fixture = await setup({ installed: true });
    const connect = (await fixture.client.listTools()).tools.find((tool) => tool.name === "honua_agent_connect");
    expect(connect?.inputSchema).toMatchObject({
      oneOf: [{ maxProperties: 0 }, { required: ["workspaceId", "turnId"] }],
    });
  });

  it("explicitly switches an idle connector to a separately authorized turn", async () => {
    const fixture = await setup({ installed: true });
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    const switchTurn = await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-3" },
    });
    expect(switchTurn.isError).not.toBe(true);
    expect(fixture.bindings).toEqual([
      undefined,
      { workspaceId: "workspace-1", turnId: "turn-2" },
      { workspaceId: "workspace-1", turnId: "turn-3" },
    ]);
    expect((await fixture.client.callTool({ name: "honua_agent_status" })).structuredContent?.turnBinding).toEqual({
      workspaceId: "workspace-1",
      turnId: "turn-3",
    });
    expect((await fixture.client.callTool({ name: "echo", arguments: {} })).isError).not.toBe(true);
  });

  it("rejects a reserved tool on the bound catalog's later page before switching clients", async () => {
    const options = { installed: true, boundCollision: true };
    const fixture = await setup(options);
    const answer = await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    expect(answer.isError).toBe(true);
    expect(fixture.bindings).toEqual([undefined, { workspaceId: "workspace-1", turnId: "turn-2" }]);
    await expect(fixture.client.callTool({ name: "echo", arguments: {} })).rejects.toThrow();
    options.boundCollision = false;
    expect(
      (
        await fixture.client.callTool({
          name: "honua_agent_connect",
          arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
        })
      ).isError,
    ).not.toBe(true);
    expect((await fixture.client.callTool({ name: "echo", arguments: {} })).isError).not.toBe(true);
  });

  it("forwards catalog notifications from the bound client", async () => {
    const fixture = await setup({ installed: true });
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    const before = fixture.notifications();
    await fixture.upstreamServers.at(-1)?.notification({ method: "notifications/tools/list_changed" });
    await vi.waitFor(() => expect(fixture.notifications()).toBeGreaterThan(before));
  });

  it("recovers a transiently unavailable original binding only after an authorized same-turn read", async () => {
    const options = { installed: true, turnReadStatus: 0 };
    const fixture = await setup(options);
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    options.turnReadStatus = 503;
    await expect(fixture.client.callTool({ name: "echo", arguments: {} })).rejects.toThrow();
    const recoveryTools = (await fixture.client.listTools()).tools.map((tool) => tool.name);
    expect(recoveryTools).toContain("honua_agent_connect");
    expect(recoveryTools).toContain("honua_agent_status");
    expect(recoveryTools).not.toContain("echo");
    options.turnReadStatus = 0;
    const recovered = await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    expect(recovered.structuredContent).toMatchObject({
      state: "attached",
      turnBinding: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    expect((await fixture.client.callTool({ name: "echo", arguments: {} })).isError).not.toBe(true);
  });

  it("never forwards a concurrent call after another preflight revokes the binding", async () => {
    const waiting: ((response: Response) => void)[] = [];
    let reads = 0;
    const fixture = await setup({
      installed: true,
      turnRead: async () => {
        reads++;
        if (reads === 1)
          return Response.json({
            turnId: "turn-2",
            context: { workspaceId: "workspace-1", targetId: "server-target-1", tenantId: "tenant-1" },
          });
        return new Promise<Response>((resolve) => waiting.push(resolve));
      },
    });
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    const first = fixture.client.callTool({ name: "echo", arguments: { call: "first" } }).catch(() => undefined);
    const second = fixture.client.callTool({ name: "echo", arguments: { call: "second" } }).catch(() => undefined);
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting[0]?.(Response.json({}, { status: 403 }));
    await first;
    waiting[1]?.(
      Response.json({
        turnId: "turn-2",
        context: { workspaceId: "workspace-1", targetId: "server-target-1", tenantId: "tenant-1" },
      }),
    );
    await second;
    expect(fixture.calls).toHaveLength(0);
    expect((await fixture.client.callTool({ name: "honua_agent_status" })).structuredContent?.state).toBe(
      "unavailable",
    );
  });

  it("refuses malformed, denied and stale turn bindings without unbound fallback", async () => {
    const fixture = await setup({ installed: true, turnReadStatus: 403 });
    for (const args of [
      { workspaceId: "workspace-1" },
      { workspaceId: "bad/workspace", turnId: "turn-2" },
      { workspaceId: "workspace-1", turnId: "turn-2" },
    ]) {
      const answer = await fixture.client.callTool({ name: "honua_agent_connect", arguments: args });
      expect(answer.isError).toBe(true);
    }
    expect(fixture.bindings).toEqual([undefined]);
  });

  it("refuses unbound calls after a denied first bind, then permits an explicit verified retry", async () => {
    const options = { installed: true, turnReadStatus: 403 };
    const fixture = await setup(options);
    const binding = { workspaceId: "workspace-1", turnId: "turn-2" };
    expect((await fixture.client.callTool({ name: "honua_agent_connect", arguments: binding })).isError).toBe(true);
    await expect(fixture.client.callTool({ name: "echo", arguments: {} })).rejects.toThrow();
    expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).not.toContain("echo");
    expect((await fixture.client.listResources()).resources.map((resource) => resource.uri)).toEqual([
      WORKFLOW_KNOWLEDGE_URI,
    ]);
    expect((await fixture.client.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect((await fixture.client.listPrompts()).prompts).toEqual([]);
    expect((await fixture.client.callTool({ name: "honua_agent_status" })).structuredContent?.state).toBe(
      "unavailable",
    );
    options.turnReadStatus = 0;
    expect((await fixture.client.callTool({ name: "honua_agent_connect", arguments: binding })).isError).not.toBe(true);
    expect((await fixture.client.callTool({ name: "echo", arguments: {} })).isError).not.toBe(true);
    expect((await fixture.client.listResources()).resources.map((resource) => resource.uri)).toContain(
      "honua://fixture",
    );
    expect((await fixture.client.listResourceTemplates()).resourceTemplates).toHaveLength(1);
    expect((await fixture.client.listPrompts()).prompts).toHaveLength(1);
  });

  it("recovers a failed first bind after the retained unbound upstream closes", async () => {
    const options = { installed: true, turnReadStatus: 403 };
    const fixture = await setup(options);
    const binding = { workspaceId: "workspace-1", turnId: "turn-2" };
    expect((await fixture.client.callTool({ name: "honua_agent_connect", arguments: binding })).isError).toBe(true);
    await fixture.upstream.close();
    await vi.waitFor(async () =>
      expect((await fixture.client.callTool({ name: "honua_agent_status" })).structuredContent?.state).toBe(
        "unavailable",
      ),
    );
    expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).not.toContain("echo");
    options.turnReadStatus = 0;
    expect((await fixture.client.callTool({ name: "honua_agent_connect", arguments: binding })).isError).not.toBe(true);
    expect((await fixture.client.callTool({ name: "echo", arguments: {} })).isError).not.toBe(true);
  });

  it("refuses the old context after a failed idle switch until the new turn is verified", async () => {
    const options = { installed: true, turnReadStatus: 0 };
    const fixture = await setup(options);
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    options.turnReadStatus = 403;
    expect(
      (
        await fixture.client.callTool({
          name: "honua_agent_connect",
          arguments: { workspaceId: "workspace-1", turnId: "turn-3" },
        })
      ).isError,
    ).toBe(true);
    await expect(fixture.client.callTool({ name: "echo", arguments: {} })).rejects.toThrow();
    options.turnReadStatus = 0;
    expect(
      (
        await fixture.client.callTool({
          name: "honua_agent_connect",
          arguments: { workspaceId: "workspace-1", turnId: "turn-3" },
        })
      ).isError,
    ).not.toBe(true);
    expect((await fixture.client.callTool({ name: "echo", arguments: {} })).isError).not.toBe(true);
  });

  it("invalidates a bound turn when its current credential changes", async () => {
    const fixture = await setup({ installed: true });
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    vi.mocked(fixture.runtime.resolve).mockResolvedValue({
      target: { id: "target-2", endpoint: "http://127.0.0.1:8080/mcp", credentialId: "credential-2" },
      transport: { remoteUrl: "http://127.0.0.1:8080/mcp", apiKey: "rotated-key" },
      credentialKind: "workspace-agent",
      releaseId: "release-1",
    });
    await expect(fixture.client.callTool({ name: "echo", arguments: {} })).rejects.toThrow();
    const retry = await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    expect(retry.isError).toBe(true);
  });

  it("invalidates a bound turn when the installed release changes", async () => {
    const fixture = await setup({ installed: true });
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    vi.mocked(fixture.runtime.resolve).mockResolvedValue({
      target: { id: "target-1", endpoint: "http://127.0.0.1:8080/mcp", credentialId: "credential-1" },
      transport: { remoteUrl: "http://127.0.0.1:8080/mcp", apiKey: "private-key-MUST-NOT-LEAK" },
      credentialKind: "workspace-agent",
      releaseId: "release-2",
    });
    await expect(fixture.client.callTool({ name: "echo", arguments: {} })).rejects.toThrow();
    expect(
      (await fixture.client.callTool({ name: "honua_agent_status", arguments: {} })).structuredContent,
    ).toMatchObject({ state: "unavailable" });
  });

  it("invalidates a bound turn when its authorized read is revoked", async () => {
    const options = { installed: true, turnReadStatus: 0 };
    const fixture = await setup(options);
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    options.turnReadStatus = 403;
    const beforeNotifications = fixture.notifications();
    await expect(fixture.client.callTool({ name: "echo", arguments: {} })).rejects.toThrow();
    await vi.waitFor(() => expect(fixture.notifications()).toBeGreaterThan(beforeNotifications));
    expect((await fixture.client.listResources()).resources.map((resource) => resource.uri)).toEqual([
      WORKFLOW_KNOWLEDGE_URI,
    ]);
    expect((await fixture.client.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect((await fixture.client.listPrompts()).prompts).toEqual([]);
    expect(
      (await fixture.client.callTool({ name: "honua_agent_status", arguments: {} })).structuredContent,
    ).toMatchObject({ state: "unavailable" });
  });

  it("refuses a turn from a different installed Server deployment", async () => {
    const fixture = await setup({
      installed: true,
      turnRead: async () =>
        Response.json({
          turnId: "turn-2",
          context: { workspaceId: "workspace-1", targetId: "foreign-deployment", tenantId: "tenant-1" },
        }),
    });
    const attempted = await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    expect(attempted.isError).toBe(true);
    expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).not.toContain("echo");
  });

  it("refuses a turn switch while an old snapshot has an in-flight call", async () => {
    const fixture = await setup({ installed: true });
    await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-2" },
    });
    const abort = new AbortController();
    const call = fixture.client.callTool({ name: "wait" }, undefined, { signal: abort.signal });
    await vi.waitFor(() =>
      expect(fixture.calls.some((item) => (item as { params?: { name?: string } }).params?.name === "wait")).toBe(true),
    );
    const switchTurn = await fixture.client.callTool({
      name: "honua_agent_connect",
      arguments: { workspaceId: "workspace-1", turnId: "turn-3" },
    });
    expect(switchTurn.isError).toBe(true);
    expect(fixture.bindings).toEqual([undefined, { workspaceId: "workspace-1", turnId: "turn-2" }]);
    expect((await fixture.client.callTool({ name: "echo", arguments: {} })).isError).not.toBe(true);
    abort.abort();
    await call.catch(() => {});
  });
  it.each([
    [undefined, "full"],
    [null, "full"],
    ["", "full"],
    ["   ", "full"],
    ["setup", "setup"],
    ["workspace", "workspace"],
    ["processes", "processes"],
  ])("selects upstream view %s as %s without changing the target", async (workflowView, expected) => {
    const fixture = await setup({ installed: true, workflowView });
    expect(fixture.views).toEqual([expected]);
    const status = await fixture.client.callTool({ name: "honua_agent_status" });
    expect(status.structuredContent?.target).toEqual({
      id: "target-1",
      endpoint: "http://127.0.0.1:8080/mcp",
      credentialId: "credential-1",
    });
    await fixture.upstream.close();
    const reconnected = await fixture.client.callTool({ name: "honua_agent_connect" });
    expect(reconnected.structuredContent?.state).toBe("attached");
    expect(fixture.views).toEqual([expected, expected]);
  });

  it.each([false, { invalid: "setup" }, "x".repeat(65)])("refuses malformed view metadata %s", async (workflowView) => {
    await expect(setup({ installed: true, workflowView })).rejects.toThrow("Invalid workflow view");
  });

  it("advertises the canonical full HTTP catalog to an ordinary host with no view metadata", async () => {
    const remote = await startFixture();
    cleanup.push(() => remote.close());
    const gateway = new HonuaAgentGateway({
      inspect: vi.fn(),
      install: vi.fn(),
      resolve: vi.fn(async () => ({
        target: { id: "http-fixture", endpoint: remote.url, credentialId: "fixture" },
        transport: { remoteUrl: remote.url, apiKey: "test-credential" },
      })),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ordinary-mcp-host", version: "1" });
    cleanup.push(
      () => gateway.close(),
      () => client.close(),
    );
    await gateway.connect(b);
    await client.connect(a);
    await vi.waitFor(async () => {
      expect((await client.callTool({ name: "honua_agent_status" })).structuredContent?.state).toBe("attached");
    });
    const catalog = await client.listTools();
    expect(catalog.tools.filter((tool) => !tool.name.startsWith("honua_agent_"))).toHaveLength(32);
    expect(catalog._meta?.revision).toBe("full.v1");
    expect([...remote.sessions.values()]).toEqual(["full"]);
    const initialize = JSON.parse(
      remote.traffic.find((event: { direction: string }) => event.direction === "http-request").body,
    );
    expect(initialize.params._meta).toEqual({ "honua.io/workflow-view": "full" });
    expect(initialize.params.clientInfo.name).toBe("honua-agent-gateway");
  });

  it("serves versioned workflow knowledge before installation and after attachment", async () => {
    const fixture = await setup();
    expect((await fixture.client.listResources()).resources).toContainEqual(
      expect.objectContaining({ uri: WORKFLOW_KNOWLEDGE_URI }),
    );
    const read = await fixture.client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI });
    expect(JSON.stringify(read)).toContain("contract-guidance-only");
    const knowledge = JSON.parse(String(read.contents[0]?.text));
    expect(knowledge).toEqual(SDK_WORKFLOW_KNOWLEDGE);
    const context = knowledge.workflows.find((workflow: { id: string }) => workflow.id === "shared-workspace-context");
    const importFlow = knowledge.workflows.find((workflow: { id: string }) => workflow.id === "data-and-services");
    expect(context.actions.join(" ")).toContain("honua_workspace_conversation");
    expect(context.actions.join(" ")).toContain("honua_agent_connect");
    expect(importFlow.actions.join(" ")).toContain("browserFileSelection");
    expect(importFlow.actions.join(" ")).toContain("honua_workspace_submit_dataset_import");
    await fixture.client.callTool({ name: "honua_agent_install_local", arguments: { confirm: true } });
    const resources = (await fixture.client.listResources()).resources;
    expect(resources).toContainEqual(expect.objectContaining({ uri: WORKFLOW_KNOWLEDGE_URI }));
    expect(resources).toContainEqual(expect.objectContaining({ uri: "honua://fixture" }));
    const attachedKnowledge = await fixture.client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI });
    expect(JSON.parse(String(attachedKnowledge.contents[0]?.text))).toEqual(SDK_WORKFLOW_KNOWLEDGE);
  });

  it.each([false, true])("honors workflow resource windows with installed=%s", async (installed) => {
    const { client, resourceReads } = await setup({ installed });
    let page = await client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI, maxChars: 257 });
    let document = "";
    const cursors = new Set<string>();
    for (let pages = 0; pages < 512; pages++) {
      const chunk = page.contents[0];
      if (!(chunk && "text" in chunk)) throw new Error("Expected a text resource");
      expect(chunk.uri).toBe(WORKFLOW_KNOWLEDGE_URI);
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.text.length).toBeLessThanOrEqual(257);
      document += chunk.text;
      if (typeof page.nextCursor !== "string") break;
      expect(cursors.size).toBeLessThan(512);
      expect(cursors.has(page.nextCursor)).toBe(false);
      cursors.add(page.nextCursor);
      page = await client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI, cursor: page.nextCursor, maxChars: 257 });
    }
    expect(page.nextCursor).toBeUndefined();
    expect(cursors.size).toBeGreaterThan(0);
    expect(document).toBe(JSON.stringify(SDK_WORKFLOW_KNOWLEDGE));
    expect(JSON.parse(document)).toEqual(SDK_WORKFLOW_KNOWLEDGE);
    expect(resourceReads).toEqual([]);
  });

  it("allows workflow continuation with a different budget, including single-character windows", async () => {
    const { client } = await setup();
    const first = await client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI, maxChars: 1 });
    expect(first.contents[0]?.text).toBe("{");
    if (typeof first.nextCursor !== "string") throw new Error("Expected the first continuation cursor");
    const second = await client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI, cursor: first.nextCursor, maxChars: 1 });
    expect(second.contents[0]?.text).toBe('"');
    if (typeof second.nextCursor !== "string") throw new Error("Expected the second continuation cursor");
    const last = await client.readResource({
      uri: WORKFLOW_KNOWLEDGE_URI,
      cursor: second.nextCursor,
      maxChars: 1_000_000,
    });
    expect(last.nextCursor).toBeUndefined();
    expect(String(first.contents[0]?.text) + String(second.contents[0]?.text) + String(last.contents[0]?.text)).toBe(
      JSON.stringify(SDK_WORKFLOW_KNOWLEDGE),
    );
  });

  it.each(["", "not:a:cursor", "a".repeat(257), Buffer.from(`${"0".repeat(64)}:1`).toString("base64url")])(
    "refuses an invalid or stale workflow cursor %s without upstream dispatch",
    async (cursor) => {
      const { client, resourceReads } = await setup({ installed: true });
      await expect(client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI, cursor, maxChars: 257 })).rejects.toThrow(
        "Invalid workflow knowledge continuation cursor",
      );
      expect(resourceReads).toEqual([]);
    },
  );

  it("shares the registration with the optional private adapter without replaying failed mutations", async () => {
    const devops: DevOpsExtension = {
      listTools: vi.fn(async () => [
        { name: "honua_agent_devops_describe_environment", inputSchema: { type: "object" as const } },
      ]),
      callTool: vi.fn(async () => {
        throw new Error("private-secret");
      }),
      close: vi.fn(async () => {}),
    };
    const fixture = await setup({ installed: true, devops });
    expect((await fixture.client.listTools()).tools).toContainEqual(
      expect.objectContaining({ name: "honua_agent_devops_describe_environment" }),
    );
    await expect(fixture.client.callTool({ name: "honua_agent_devops_describe_environment" })).rejects.toThrow(
      "outcome may be unknown",
    );
    expect(devops.callTool).toHaveBeenCalledTimes(1);
    expect(fixture.calls).toHaveLength(0);
    await fixture.gateway.close();
    expect(devops.close).toHaveBeenCalled();
  });

  it("preserves server RBAC refusal and never retries with elevated credentials", async () => {
    const fixture = await setup({ installed: true });
    const denied = await fixture.client.callTool({ name: "forbidden" });
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { code: "permission_denied", requiredGrant: "admin:approve" },
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.runtime.resolve).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(denied)).not.toContain("private-key");
  });

  it("negotiates its own HTTP session with the selected workflow view", async () => {
    const remote = await startFixture();
    const client = await connectAgentUpstream(
      {
        target: { id: "http-fixture", endpoint: remote.url, credentialId: "fixture" },
        transport: { remoteUrl: remote.url, apiKey: "test-credential" },
      },
      "setup",
    );
    try {
      const catalog = await client.listTools();
      expect(catalog.tools).toHaveLength(25);
      expect(catalog._meta?.revision).toBe("setup.v2");
      expect([...remote.sessions.values()]).toEqual(["setup"]);
      const initialize = JSON.parse(
        remote.traffic.find((event: { direction: string }) => event.direction === "http-request").body,
      );
      expect(initialize.params.clientInfo.name).toBe("honua-agent-gateway");
      expect(initialize.params._meta).toEqual({ "honua.io/workflow-view": "setup" });
    } finally {
      await client.close();
      await remote.close();
    }
  });
  it("forwards the immutable workspace/turn snapshot with every upstream HTTP request", async () => {
    const remote = await startFixture();
    const headers: Headers[] = [];
    const client = await connectAgentUpstream(
      {
        target: { id: "http-fixture", endpoint: remote.url, credentialId: "fixture" },
        transport: { remoteUrl: remote.url, apiKey: "test-credential" },
      },
      "workspace",
      async (input, init) => {
        const sent = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => sent.set(name, value));
        headers.push(sent);
        return fetch(input, init);
      },
      { workspaceId: "workspace-1", turnId: "turn-2" },
    );
    try {
      await client.listTools();
      expect(headers.length).toBeGreaterThan(1);
      for (const sent of headers) {
        expect(sent.get("X-Honua-Workspace")).toBe("workspace-1");
        expect(sent.get("X-Honua-Turn")).toBe("turn-2");
        expect(sent.get("x-api-key")).toBe("test-credential");
      }
    } finally {
      await client.close();
      await remote.close();
    }
  });
  it("installs and exposes the canonical paginated catalog on the same MCP session", async () => {
    const { client, runtime } = await setup();
    expect((await client.listTools()).tools.map((t) => t.name)).toHaveLength(4);
    const installed = await client.callTool({ name: "honua_agent_install_local", arguments: { confirm: true } });
    expect(installed.structuredContent?.state).toBe("attached");
    expect(JSON.stringify(installed)).not.toContain("private-key");
    expect(runtime.install).toHaveBeenCalledExactlyOnceWith({ confirm: true, profile: "quickstart", httpPort: 8080 });
    const first = await client.listTools();
    expect(first.tools.map((t) => t.name)).toEqual([
      "honua_agent_status",
      "honua_agent_inspect_local",
      "honua_agent_connect",
      "honua_agent_install_local",
      "echo",
    ]);
    expect(first._meta).toEqual({ revision: "fixture.v1" });
    expect((await client.listTools({ cursor: first.nextCursor })).tools.map((t) => t.name)).toEqual(["second"]);
  });

  it("automatically reattaches an existing installation without installing it again", async () => {
    const { client, runtime } = await setup({ installed: true });
    expect((await client.callTool({ name: "honua_agent_status" })).structuredContent?.state).toBe("attached");
    expect(runtime.install).not.toHaveBeenCalled();
    const denied = await client.callTool({ name: "honua_agent_install_local", arguments: { confirm: true } });
    expect(denied.isError).toBe(true);
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it("keeps metadata, resources and prompts on canonical contracts", async () => {
    const { client, calls } = await setup({ installed: true });
    const answer = await client.callTool({
      name: "echo",
      arguments: { id: 7 },
      _meta: { "honua.commandId": "command-1" },
    });
    expect(answer).toMatchObject({ structuredContent: { args: { id: 7 } }, _meta: { receipt: "receipt-1" } });
    expect(calls).toContainEqual(
      expect.objectContaining({ params: expect.objectContaining({ _meta: { "honua.commandId": "command-1" } }) }),
    );
    expect((await client.listResources()).resources).toContainEqual(
      expect.objectContaining({ uri: "honua://fixture" }),
    );
    expect((await client.readResource({ uri: "honua://fixture" })).contents[0].text).toBe("canonical resource");
    expect((await client.listResourceTemplates()).resourceTemplates).toContainEqual(
      expect.objectContaining({ uriTemplate: "honua://fixture/{id}" }),
    );
    expect((await client.listPrompts()).prompts[0].name).toBe("fixture-prompt");
    expect((await client.getPrompt({ name: "fixture-prompt" })).messages[0].content).toMatchObject({
      text: "canonical prompt",
    });
  });

  it("preserves opaque resource cursors and character budgets through both MCP transports", async () => {
    const { client, resourceReads } = await setup({ installed: true });
    const uri = "honua://catalog/processes";
    let page = await client.readResource({ uri });
    const first = page.contents[0];
    if (!("text" in first)) throw new Error("Expected a text resource");
    expect(first.text.length).toBe(64_000);
    expect(() => JSON.parse(first.text)).toThrow();
    let document = first.text;
    let pages = 1;
    const cursors = new Set<string>();
    while (typeof page.nextCursor === "string") {
      expect(pages).toBeLessThan(16);
      expect(cursors.has(page.nextCursor)).toBe(false);
      cursors.add(page.nextCursor);
      const params = { uri, cursor: page.nextCursor, maxChars: 8_192, _meta: { "honua.trace": "catalog" } };
      page = await client.readResource(params);
      expect(resourceReads.at(-1)).toEqual(params);
      expect(page._meta).toEqual({ catalogVersion: "fixture.window.v1" });
      const chunk = page.contents[0];
      if (!("text" in chunk)) throw new Error("Expected a text resource");
      expect(chunk.text.length).toBeLessThanOrEqual(8_192);
      document += chunk.text;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    const catalog = JSON.parse(document);
    expect(catalog.processes[0].description).toBe("GIS workflow 🗺️ ".repeat(6_000));
    expect(catalog.processes.at(-1)).toEqual({ processId: "last", executionKind: "Job" });
  });

  it.each([0, -1, 1.5, 1_000_001, "64000"])(
    "rejects an invalid resource budget %s before upstream dispatch",
    async (maxChars) => {
      const { client, resourceReads } = await setup({ installed: true });
      const params = { uri: "honua://catalog/processes", maxChars };
      await expect(client.readResource(params)).rejects.toThrow();
      expect(resourceReads).toHaveLength(0);
    },
  );

  it("refreshes the downstream catalog on upstream notifications", async () => {
    const fixture = await setup({ installed: true });
    const before = fixture.notifications();
    await fixture.upstream.sendToolListChanged();
    await vi.waitFor(() => expect(fixture.notifications()).toBeGreaterThan(before));
  });

  it("relays progress to the originating downstream request", async () => {
    const { client } = await setup({ installed: true });
    const onprogress = vi.fn();
    await client.callTool({ name: "progress" }, undefined, { onprogress });
    expect(onprogress).toHaveBeenCalledWith(expect.objectContaining({ progress: 1, total: 2, message: "Preparing" }));
  });

  it("refuses a connector transition while an upstream request is running", async () => {
    const fixture = await setup({ installed: true });
    const abort = new AbortController();
    const call = fixture.client.callTool({ name: "wait" }, undefined, { signal: abort.signal });
    const rejected = expect(call).rejects.toBeDefined();
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
    expect((await fixture.client.callTool({ name: "honua_agent_connect" })).isError).toBe(true);
    expect(fixture.runtime.resolve).toHaveBeenCalledTimes(1);
    abort.abort();
    await rejected;
  });

  it("propagates cancellation without retrying an upstream action", async () => {
    const fixture = await setup({ installed: true });
    const abort = new AbortController();
    const call = fixture.client.callTool({ name: "wait" }, undefined, { signal: abort.signal });
    const rejected = expect(call).rejects.toBeDefined();
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(fixture.cancelled()).toBe(true));
    expect(fixture.calls).toHaveLength(1);
  });

  it("refuses namespace collisions and never exposes a partially accepted catalog", async () => {
    const { client } = await setup({ installed: true, collision: true });
    expect((await client.callTool({ name: "honua_agent_status" })).structuredContent?.state).toBe("unattached");
    expect((await client.listTools()).tools).toHaveLength(4);
  });

  it("does not accept model-controlled credential paths or install without consent", async () => {
    const { client, runtime } = await setup();
    for (const args of [{}, { confirm: false }, { confirm: true, directory: "/someone-else" }]) {
      expect((await client.callTool({ name: "honua_agent_install_local", arguments: args })).isError).toBe(true);
    }
    expect(runtime.install).not.toHaveBeenCalled();
    expect(
      (await client.callTool({ name: "honua_agent_connect", arguments: { endpoint: "https://attacker.invalid" } }))
        .isError,
    ).toBe(true);
  });

  it("keeps failed handoff exceptions out of model responses", async () => {
    const { client } = await setup({ fail: true });
    const answer = await client.callTool({ name: "honua_agent_connect" });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer)).not.toContain("private-key");
    expect((await client.listTools()).tools).toHaveLength(4);
  });
});
