import { describe, expect, it } from "vitest";

import { type HonuaAgentRuntime, createHonuaAiMapKit } from "@honua/sdk-js/agent-tools";
import {
  CHAT_EVENT_TYPE_TO_SSE_NAME,
  SseFrameParser,
  type StudioAgentSessionEvent,
  type StudioAiCapabilitiesResponse,
  type StudioAiChatEvent,
  type StudioAiChatRequest,
  createStudioAgentSession,
} from "@honua/sdk-js/studio-agent";

// ── Scripted server ───────────────────────────────────────────
//
// A `fetchImpl` that speaks all three wire surfaces the session uses, with
// REAL bytes: SSE frames for the chat stream (so `SseChatTransport` and
// `SseFrameParser` are exercised end to end, not stubbed out) and JSON-RPC
// envelopes for `POST /mcp`. Modeled on honua-studio's `FixtureChatTransport`,
// one level lower: a scripted transport proves the loop, a scripted *server*
// proves the loop plus the framing.

type ScriptedTurn = ReadonlyArray<StudioAiChatEvent>;

interface McpScript {
  /** One entry per `tools/call`, consumed in order. Absent name falls through to the default draft reply. */
  readonly toolCalls?: ReadonlyArray<{ readonly isError?: boolean; readonly result: Record<string, unknown> }>;
}

interface ScriptedServer {
  readonly fetchImpl: typeof fetch;
  readonly chatRequests: StudioAiChatRequest[];
  readonly mcpCalls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }>;
  readonly capabilityRequests: number;
}

interface ScriptOptions {
  readonly capabilities?: StudioAiCapabilitiesResponse;
  readonly turns?: ReadonlyArray<ScriptedTurn>;
  readonly mcp?: McpScript;
  /** Bytes-per-chunk for the SSE body. `1` splits every frame across many chunks. */
  readonly chunkSize?: number;
  /** Rejects the chat fetch, standing in for a network failure. */
  readonly failChat?: boolean;
  /** Called with the abort signal for each chat request, so a test can cancel mid-stream. */
  readonly onChatStream?: (signal: AbortSignal | undefined) => void;
}

const DEFAULT_CAPABILITIES: StudioAiCapabilitiesResponse = {
  enabled: true,
  defaultProvider: "anthropic",
  providers: [
    {
      provider: "anthropic",
      kind: "anthropic",
      model: "test-model",
      maxTokens: 4096,
      toolSupport: true,
      streaming: true,
      isDefault: true,
      configured: true,
    },
  ],
};

function sseBody(events: ScriptedTurn): string {
  return events
    .map((event) => {
      const { type, ...rest } = event;
      const name = CHAT_EVENT_TYPE_TO_SSE_NAME[type];
      return `event: ${name}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
    })
    .join("");
}

function chunkedStream(body: string, chunkSize: number, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException("Aborted", "AbortError"));
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function createScriptedServer(options: ScriptOptions = {}): ScriptedServer {
  const chatRequests: StudioAiChatRequest[] = [];
  const mcpCalls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [];
  const turns = [...(options.turns ?? [])];
  const toolCalls = [...(options.mcp?.toolCalls ?? [])];
  const counters = { capabilityRequests: 0 };
  let turnIndex = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.endsWith("/v1/studio/ai/capabilities")) {
      counters.capabilityRequests += 1;
      return jsonResponse({ success: true, data: options.capabilities ?? DEFAULT_CAPABILITIES });
    }

    if (url.endsWith("/v1/studio/ai/chat")) {
      if (options.failChat) throw new TypeError("fetch failed");
      chatRequests.push(JSON.parse(String(init?.body)) as StudioAiChatRequest);
      options.onChatStream?.(init?.signal ?? undefined);
      const events = turns[turnIndex++] ?? [{ type: "messageStop", stopReason: "endTurn" }];
      return new Response(chunkedStream(sseBody(events), options.chunkSize ?? 4096, init?.signal ?? undefined), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    if (url.endsWith("/mcp")) {
      const envelope = JSON.parse(String(init?.body)) as {
        readonly id: string;
        readonly method: string;
        readonly params?: Record<string, unknown>;
      };
      if (envelope.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: envelope.id, result: { protocolVersion: "2025-03-26" } },
          { "mcp-session-id": "session-1" },
        );
      }
      const name = String(envelope.params?.name);
      const args = (envelope.params?.arguments ?? {}) as Record<string, unknown>;
      mcpCalls.push({ name, arguments: args });
      const scripted = toolCalls.shift();
      const result = scripted ?? { result: { draftId: "draft-1", generation: 2 } };
      return jsonResponse({
        jsonrpc: "2.0",
        id: envelope.id,
        result: { structuredContent: result.result, ...(result.isError ? { isError: true } : {}) },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  return {
    fetchImpl,
    chatRequests,
    mcpCalls,
    get capabilityRequests() {
      return counters.capabilityRequests;
    },
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

// ── Fixtures ──────────────────────────────────────────────────

function textTurn(text: string): ScriptedTurn {
  return [
    { type: "messageStart", model: "test-model" },
    { type: "textDelta", text },
    { type: "messageStop", stopReason: "endTurn" },
  ];
}

function toolTurn(calls: ReadonlyArray<{ id: string; name: string; args: unknown }>): ScriptedTurn {
  const events: StudioAiChatEvent[] = [{ type: "messageStart", model: "test-model" }];
  for (const call of calls) {
    events.push({ type: "toolCallStart", toolCallId: call.id, toolName: call.name });
    events.push({ type: "toolCallDelta", toolCallId: call.id, toolArgumentsDelta: JSON.stringify(call.args) });
    events.push({ type: "toolCallStop", toolCallId: call.id, toolArguments: call.args });
  }
  events.push({ type: "messageStop", stopReason: "toolCall" });
  return events;
}

function makeRuntime(): HonuaAgentRuntime & { readonly log: string[] } {
  const log: string[] = [];
  return {
    id: "ops",
    log,
    snapshot: () => ({
      appId: "ops",
      sources: [{ id: "incidents", protocol: "geoservices-feature-service", capabilities: ["query"] }],
      layers: [{ id: "incident-points", sourceId: "incidents" }],
      selection: [],
    }),
    setFilter: (id, clause) => {
      log.push(`setFilter:${id}:${String(clause?.value)}`);
      return { id };
    },
    setViewport: (viewport) => {
      log.push(`setViewport:${viewport.zoom ?? "-"}`);
      return viewport;
    },
  };
}

function makeSession(options: ScriptOptions & { readonly draft?: { draftId: string; generation: number } } = {}) {
  const server = createScriptedServer(options);
  const runtime = makeRuntime();
  const kit = createHonuaAiMapKit({ runtime, policy: { allowActions: true } });
  const events: StudioAgentSessionEvent[] = [];
  const session = createStudioAgentSession({
    baseUrl: "/api",
    fetchImpl: server.fetchImpl,
    kit,
    system: "You operate a Honua map.",
    ...(options.draft ? { draft: options.draft } : {}),
    onEvent: (event) => events.push(event),
  });
  return { server, runtime, kit, session, events };
}

// ── Tests ─────────────────────────────────────────────────────

describe("@honua/sdk-js/studio-agent SSE framing", () => {
  it("parses frames split at every byte boundary", () => {
    const body = sseBody(textTurn("hello world"));
    const parser = new SseFrameParser();
    const frames = [];
    for (const character of body) frames.push(...parser.push(character));

    expect(frames.map((frame) => frame.event)).toEqual(["message_start", "text_delta", "message_stop"]);
    expect(JSON.parse(frames[1]!.data)).toMatchObject({ type: "textDelta", text: "hello world" });
  });
});

describe("createStudioAgentSession capabilities", () => {
  it("fetches capabilities once and caches them", async () => {
    const { server, session } = makeSession({ turns: [textTurn("hi")] });

    const first = await session.capabilities();
    const second = await session.capabilities();
    const provider = await session.resolveProvider();

    expect(first).toBe(second);
    expect(server.capabilityRequests).toBe(1);
    expect(provider).toMatchObject({ provider: "anthropic", model: "test-model", toolSupport: true });
  });

  it("publishes tools in the proxy's { name, description, inputSchema } HTTP shape", async () => {
    const { session } = makeSession();
    expect(session.tools.length).toBeGreaterThan(0);
    for (const tool of session.tools) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
    }
    expect(session.tools.map((tool) => tool.name)).toContain("bindInteraction");
  });

  it("refuses a tool turn against a provider without tool support", async () => {
    const { server, session } = makeSession({
      capabilities: {
        enabled: true,
        defaultProvider: "text-only",
        providers: [
          {
            provider: "text-only",
            kind: "openai",
            model: "no-tools",
            maxTokens: 1024,
            toolSupport: false,
            streaming: true,
            isDefault: true,
            configured: true,
          },
        ],
      },
      turns: [textTurn("should never run")],
    });

    const turn = await session.chat("Filter to open incidents.");

    expect(turn.status).toBe("refused");
    expect(turn.errorMessage).toContain("does not support tool calls");
    expect(server.chatRequests).toEqual([]);
    // A refused turn does not enter the history.
    expect(session.messages).toEqual([]);
  });

  it("refuses when the proxy is disabled entirely", async () => {
    const { session } = makeSession({
      capabilities: { enabled: false, defaultProvider: "none", providers: [] },
    });
    const turn = await session.chat("hello");
    expect(turn.status).toBe("refused");
    expect(turn.errorMessage).toContain("disabled");
  });

  it("proceeds when the capabilities probe itself fails — an outage is not a refusal", async () => {
    const server = createScriptedServer({ turns: [textTurn("still works")] });
    const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/capabilities")) throw new TypeError("fetch failed");
      return server.fetchImpl(input, init);
    }) as typeof fetch;
    const kit = createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } });
    const session = createStudioAgentSession({ baseUrl: "/api", fetchImpl: failingFetch, kit });

    const turn = await session.chat("hello");

    expect(turn.status).toBe("completed");
    expect(turn.text).toBe("still works");
  });
});

describe("createStudioAgentSession turn loop", () => {
  it("streams a text-only turn and records history", async () => {
    const { server, session } = makeSession({
      turns: [
        [
          { type: "messageStart" },
          { type: "textDelta", text: "Two " },
          { type: "textDelta", text: "layers." },
          { type: "messageStop", stopReason: "endTurn" },
        ],
      ],
    });

    const turn = await session.chat("What is on the map?");

    expect(turn).toMatchObject({ status: "completed", text: "Two layers.", stopReason: "endTurn", rounds: 1 });
    expect(turn.toolCalls).toEqual([]);
    expect(session.messages).toEqual([
      { role: "user", content: "What is on the map?" },
      { role: "assistant", content: "Two layers." },
    ]);
    expect(server.chatRequests[0]).toMatchObject({ system: "You operate a Honua map." });
  });

  it("dispatches a runtime verb through the kit executor and continues the turn", async () => {
    const { server, runtime, session } = makeSession({
      turns: [
        toolTurn([
          {
            id: "call-1",
            name: "setFilter",
            args: { id: "status", clause: { field: "status", operator: "=", value: "open" } },
          },
        ]),
        textTurn("Filtered to open incidents."),
      ],
    });

    const turn = await session.chat("Show only open incidents.");

    expect(turn.status).toBe("completed");
    expect(turn.rounds).toBe(2);
    expect(turn.text).toBe("Filtered to open incidents.");
    expect(runtime.log).toEqual(["setFilter:status:open"]);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "setFilter",
      plane: "runtime",
      ok: true,
    });
    // The tool result goes back as a role:tool message keyed to the call id.
    expect(session.messages.at(-2)).toMatchObject({ role: "tool", toolCallId: "call-1", toolName: "setFilter" });
    expect(JSON.parse(session.messages.at(-2)!.content)).toMatchObject({ status: "ok" });
    // The second round carries the tool result forward.
    expect(server.chatRequests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("surfaces a policy denial as a failed tool result without stopping the turn", async () => {
    const server = createScriptedServer({
      turns: [
        toolTurn([{ id: "call-1", name: "setViewport", args: { zoom: 12 } }]),
        textTurn("I cannot move the map."),
      ],
    });
    // No action opt-in and no dry-run: every action tool is denied outright.
    const kit = createHonuaAiMapKit({ runtime: makeRuntime(), policy: {} });
    const session = createStudioAgentSession({ baseUrl: "/api", fetchImpl: server.fetchImpl, kit });

    const turn = await session.chat("Zoom in.");

    expect(turn.status).toBe("completed");
    expect(turn.toolCalls[0]).toMatchObject({ plane: "runtime", ok: false });
    expect(turn.toolCalls[0]?.errorMessage).toContain("requires allowActions=true or dryRun=true");
    expect(JSON.parse(turn.toolCalls[0]!.content)).toMatchObject({ status: "denied" });
  });

  it("treats a read-only kit's dry-run as a successful, non-mutating tool result", async () => {
    const server = createScriptedServer({
      turns: [toolTurn([{ id: "call-1", name: "setViewport", args: { zoom: 12 } }]), textTurn("Previewed.")],
    });
    const runtime = makeRuntime();
    const kit = createHonuaAiMapKit({ runtime, policy: { readOnly: true } });
    const session = createStudioAgentSession({ baseUrl: "/api", fetchImpl: server.fetchImpl, kit });

    const turn = await session.chat("Zoom in.");

    expect(turn.toolCalls[0]).toMatchObject({ plane: "runtime", ok: true });
    expect(JSON.parse(turn.toolCalls[0]!.content)).toMatchObject({ status: "dry-run" });
    // Read-only means the runtime was never touched.
    expect(runtime.log).toEqual([]);
  });

  it("applies multiple tool calls from one round strictly in order", async () => {
    const { runtime, session } = makeSession({
      turns: [
        toolTurn([
          { id: "a", name: "setFilter", args: { id: "one", clause: { field: "f", operator: "=", value: "1" } } },
          { id: "b", name: "setFilter", args: { id: "two", clause: { field: "f", operator: "=", value: "2" } } },
          { id: "c", name: "setViewport", args: { zoom: 9 } },
        ]),
        textTurn("done"),
      ],
    });

    const turn = await session.chat("Do three things.");

    expect(runtime.log).toEqual(["setFilter:one:1", "setFilter:two:2", "setViewport:9"]);
    expect(turn.toolCalls.map((call) => call.toolCallId)).toEqual(["a", "b", "c"]);
  });

  it("reports an unknown tool name as a structured tool result, not a throw", async () => {
    const { session } = makeSession({
      turns: [toolTurn([{ id: "call-1", name: "deleteEverything", args: {} }]), textTurn("I cannot do that.")],
    });

    const turn = await session.chat("Delete everything.");

    expect(turn.status).toBe("completed");
    expect(turn.toolCalls[0]).toMatchObject({ plane: "unknown", ok: false });
    expect(turn.toolCalls[0]?.errorMessage).toContain('No tool named "deleteEverything"');
  });

  it("stops after maxToolRounds instead of looping forever", async () => {
    const server = createScriptedServer({
      turns: Array.from({ length: 6 }, () => toolTurn([{ id: "x", name: "setViewport", args: { zoom: 3 } }])),
    });
    const kit = createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } });
    const session = createStudioAgentSession({
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      kit,
      maxToolRounds: 2,
    });

    const turn = await session.chat("Keep zooming.");

    expect(turn.rounds).toBe(2);
    expect(turn.toolCalls).toHaveLength(2);
  });

  it("re-reads the system prompt on every chat() when it is a function", async () => {
    const server = createScriptedServer({ turns: [textTurn("a"), textTurn("b")] });
    const kit = createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } });
    let calls = 0;
    const session = createStudioAgentSession({
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      kit,
      system: () => {
        calls += 1;
        return `prompt-${calls}`;
      },
    });

    await session.chat("one");
    await session.chat("two");

    expect(server.chatRequests.map((request) => request.system)).toEqual(["prompt-1", "prompt-2"]);
  });
});

describe("createStudioAgentSession composition plane", () => {
  const interaction = {
    id: "select-parcel-filters-chart",
    on: { ref: "layer:parcels", event: "featureSelect" },
    do: { ref: "widget:area-chart", verb: "setFilter", args: { field: "parcelId", value: "$event.featureId" } },
  };

  it("routes honua_studio_set_layer_visibility and retains a not_found error code", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [
        toolTurn([
          {
            id: "call-1",
            name: "honua_studio_set_layer_visibility",
            args: { layerId: "missing", visible: false },
          },
        ]),
        textTurn("The layer was not found."),
      ],
      mcp: { toolCalls: [{ isError: true, result: { code: "not_found", message: "unknown layer" } }] },
    });

    const turn = await session.chat("Hide the missing layer.");

    expect(server.mcpCalls).toEqual([
      {
        name: "honua_studio_set_layer_visibility",
        arguments: { draftId: "draft-1", generation: 4, layerId: "missing", visible: false },
      },
    ]);
    expect(turn.toolCalls[0]).toMatchObject({ plane: "composition", ok: false, errorCode: "not_found" });
    expect(JSON.parse(turn.toolCalls[0]?.content ?? "{}")).toMatchObject({ code: "not_found" });
  });

  it("routes honua_studio_bind_interaction through MCP with session-owned draft identity", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [
        toolTurn([
          // The model supplies a stale generation; the session's own value wins.
          { id: "call-1", name: "honua_studio_bind_interaction", args: { interaction, generation: 1 } },
        ]),
        textTurn("Bound."),
      ],
      mcp: { toolCalls: [{ result: { draftId: "draft-1", generation: 5 } }] },
    });

    const turn = await session.chat("Wire the map click to the chart.");

    expect(turn.status).toBe("completed");
    expect(server.mcpCalls.map((call) => call.name)).toEqual(["honua_studio_bind_interaction"]);
    expect(server.mcpCalls[0]?.arguments).toMatchObject({ draftId: "draft-1", generation: 4, interaction });
    expect(turn.toolCalls[0]).toMatchObject({ plane: "composition", ok: true, draft: { generation: 5 } });
    // The returned draft's generation becomes the session's.
    expect(session.draft).toEqual({ draftId: "draft-1", generation: 5 });
  });

  it("reloads and retries exactly once on a generation conflict", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [
        toolTurn([{ id: "call-1", name: "honua_studio_remove_interaction", args: { interactionId: interaction.id } }]),
        textTurn("Removed."),
      ],
      mcp: {
        toolCalls: [
          { isError: true, result: { code: "failed_precondition", message: "stale generation" } },
          { result: { draftId: "draft-1", generation: 9 } },
          { result: { draftId: "draft-1", generation: 10 } },
        ],
      },
    });

    const turn = await session.chat("Unwire it.");

    expect(server.mcpCalls.map((call) => call.name)).toEqual([
      "honua_studio_remove_interaction",
      "honua_studio_get_draft",
      "honua_studio_remove_interaction",
    ]);
    expect(server.mcpCalls[2]?.arguments).toMatchObject({ generation: 9 });
    expect(turn.toolCalls[0]).toMatchObject({ ok: true, retriedAfterConflict: true, draft: { generation: 10 } });
    expect(session.draft).toEqual({ draftId: "draft-1", generation: 10 });
  });

  it("surfaces a second generation conflict rather than retrying again", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [
        toolTurn([{ id: "call-1", name: "honua_studio_add_widget", args: { widget: { id: "w", kind: "chart" } } }]),
        textTurn("Could not add it."),
      ],
      mcp: {
        toolCalls: [
          { isError: true, result: { code: "failed_precondition", message: "stale generation" } },
          { result: { draftId: "draft-1", generation: 9 } },
          { isError: true, result: { code: "failed_precondition", message: "stale again" } },
        ],
      },
    });

    const turn = await session.chat("Add a chart.");

    expect(server.mcpCalls).toHaveLength(3);
    expect(turn.status).toBe("completed");
    expect(turn.toolCalls[0]).toMatchObject({ plane: "composition", ok: false });
    expect(turn.toolCalls[0]?.errorCode).toBe("failed_precondition");
    expect(turn.toolCalls[0]?.errorMessage).toContain("stale again");
  });

  it("surfaces a non-conflict tool failure without reloading the draft", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [
        toolTurn([{ id: "call-1", name: "honua_studio_bind_interaction", args: { interaction } }]),
        textTurn("Rejected."),
      ],
      mcp: {
        toolCalls: [{ isError: true, result: { code: "invalid_argument", message: "ref does not resolve" } }],
      },
    });

    const turn = await session.chat("Wire it to a widget that isn't there.");

    expect(server.mcpCalls.map((call) => call.name)).toEqual(["honua_studio_bind_interaction"]);
    expect(turn.toolCalls[0]).toMatchObject({ ok: false });
    expect(turn.toolCalls[0]?.errorMessage).toContain("ref does not resolve");
  });
});

describe("createStudioAgentSession failure and cancellation", () => {
  it("never throws on a transport failure — the turn comes back as an error", async () => {
    const { session } = makeSession({ failChat: true });

    const turn = await session.chat("hello");

    expect(turn.status).toBe("error");
    expect(turn.errorMessage).toContain("Could not reach the Studio AI proxy");
    expect(turn.text).toBe("");
  });

  it("reports an in-band provider error event as an error turn", async () => {
    const { session } = makeSession({
      turns: [[{ type: "messageStart" }, { type: "error", errorMessage: "upstream rate limit" }]],
    });

    const turn = await session.chat("hello");

    expect(turn.status).toBe("error");
    expect(turn.errorMessage).toBe("upstream rate limit");
  });

  it("marks a cancelled turn cancelled, not errored", async () => {
    const controller = new AbortController();
    const { session } = makeSession({
      // One byte per chunk, so the abort lands mid-stream.
      chunkSize: 1,
      turns: [
        [
          { type: "messageStart" },
          { type: "textDelta", text: "partial" },
          { type: "textDelta", text: " more" },
          { type: "messageStop", stopReason: "endTurn" },
        ],
      ],
    });

    const promise = session.chat("hello", { signal: controller.signal });
    // Abort after the first frame has had a chance to arrive.
    await Promise.resolve();
    controller.abort();
    const turn = await promise;

    expect(turn.status).toBe("cancelled");
  });

  it("does not run a turn at all when the signal is already aborted", async () => {
    const { server, session } = makeSession({ turns: [textTurn("never")] });
    const controller = new AbortController();
    controller.abort();

    const turn = await session.chat("hello", { signal: controller.signal });

    expect(turn.status).toBe("cancelled");
    expect(server.chatRequests).toEqual([]);
  });

  it("reset() clears history but keeps the draft binding and capabilities cache", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [textTurn("a"), textTurn("b")],
    });

    await session.chat("one");
    session.reset();
    await session.chat("two");

    expect(session.messages.map((message) => message.content)).toEqual(["two", "b"]);
    expect(session.draft).toEqual({ draftId: "draft-1", generation: 4 });
    expect(server.capabilityRequests).toBe(1);
  });

  it("emits every streamed event and every tool result to onEvent", async () => {
    const { events, session } = makeSession({
      turns: [toolTurn([{ id: "call-1", name: "setViewport", args: { zoom: 5 } }]), textTurn("ok")],
    });

    await session.chat("Zoom to 5.");

    const chatEvents = events.filter((event) => event.type === "chat");
    const toolResults = events.filter((event) => event.type === "toolResult");
    expect(chatEvents.length).toBeGreaterThan(4);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ type: "toolResult", result: { toolName: "setViewport", ok: true } });
  });
});
