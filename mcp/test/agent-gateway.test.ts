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
  options: { installed?: boolean; collision?: boolean; fail?: boolean; devops?: DevOpsExtension } = {},
) {
  let installed = options.installed ?? false;
  const calls: unknown[] = [];
  const views: (string | undefined)[] = [];
  const resourceReads: Record<string, unknown>[] = [];
  let notified = 0;
  let cancelled = false;
  const upstream = new Server(
    { name: "fixture", version: "1" },
    {
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
    },
  );
  upstream.setRequestHandler(ListToolsRequestSchema, async (request) => ({
    tools: [
      {
        name: options.collision ? "honua_agent_status" : request.params?.cursor ? "second" : "echo",
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
  upstream.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
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
      };
    }),
  };
  const gateway = new HonuaAgentGateway(
    runtime,
    async (_connection, view) => {
      views.push(view);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const connected = new Client({ name: "gateway", version: "1" });
      await upstream.connect(b);
      await connected.connect(a);
      return connected;
    },
    options.devops,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "1" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notified++;
  });
  await gateway.connect(b);
  await client.connect(a);
  cleanup.push(
    () => upstream.close(),
    () => gateway.close(),
    () => client.close(),
  );
  await vi.waitFor(async () => {
    const status = await client.callTool({ name: "honua_agent_status" });
    expect(status.structuredContent?.state).not.toBe("connecting");
  });
  return {
    client,
    gateway,
    upstream,
    runtime,
    calls,
    resourceReads,
    views,
    notifications: () => notified,
    cancelled: () => cancelled,
  };
}

describe("persistent Honua agent gateway", () => {
  it("serves versioned workflow knowledge before installation and after attachment", async () => {
    const fixture = await setup();
    expect((await fixture.client.listResources()).resources).toContainEqual(
      expect.objectContaining({ uri: WORKFLOW_KNOWLEDGE_URI }),
    );
    const read = await fixture.client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI });
    expect(JSON.stringify(read)).toContain("contract-guidance-only");
    expect(JSON.parse(String(read.contents[0]?.text))).toEqual(SDK_WORKFLOW_KNOWLEDGE);
    await fixture.client.callTool({ name: "honua_agent_install_local", arguments: { confirm: true } });
    const resources = (await fixture.client.listResources()).resources;
    expect(resources).toContainEqual(expect.objectContaining({ uri: WORKFLOW_KNOWLEDGE_URI }));
    expect(resources).toContainEqual(expect.objectContaining({ uri: "honua://fixture" }));
    const attachedKnowledge = await fixture.client.readResource({ uri: WORKFLOW_KNOWLEDGE_URI });
    expect(JSON.parse(String(attachedKnowledge.contents[0]?.text))).toEqual(SDK_WORKFLOW_KNOWLEDGE);
  });

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
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
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
