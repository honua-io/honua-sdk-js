import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type HonuaAgentRuntime, createHonuaAiMapKit } from "@honua/sdk-js/agent-tools";
import {
  CHAT_EVENT_TYPE_TO_SSE_NAME,
  HONUA_STUDIO_MCP_TOOL_NAMES,
  McpClient,
  type McpToolDescriptor,
  type McpToolsListResult,
  SseFrameParser,
  type StudioAgentSessionEvent,
  type StudioAgentSessionOptions,
  type StudioAiCapabilitiesResponse,
  type StudioAiChatEvent,
  type StudioAiChatRequest,
  createStudioAgentSession,
} from "@honua/sdk-js/studio-agent";

const TEST_CERTIFICATION = {
  candidateId: "candidate-test",
  releaseId: "2026.1-test",
  endpointIdentity: "fixture-proxy",
  actionId: "studio-test",
  runNonce: "fixture-nonce",
} as const;
const VERIFIED_SESSION = {
  certification: TEST_CERTIFICATION,
  transcriptVerifier: { verify: async () => ({ ok: true as const, transcriptDigest: "fixture-digest" }) },
};

// ── Scripted server ───────────────────────────────────────────
//
// A `fetchImpl` that speaks all three wire surfaces the session uses, with
// REAL bytes: SSE frames for the chat stream (so `SseChatTransport` and
// `SseFrameParser` are exercised end to end, not stubbed out) and JSON-RPC
// envelopes for `POST /mcp`. Modeled on honua-studio's `FixtureChatTransport`,
// one level lower: a scripted transport proves the loop, a scripted *server*
// proves the loop plus the framing.

type ScriptedTurn = ReadonlyArray<StudioAiChatEvent>;

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/studio-agent");

function toolsListFixture(name: string): McpToolsListResult {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8")) as McpToolsListResult;
}

/**
 * The real, checked-in `tools/list` pages honua-server's candidate Studio
 * catalog is modeled on — two pages joined by `nextCursor`, carrying the
 * server-owned `_meta["honua.studio"]` classification plus the two descriptors
 * that must never be routed.
 */
const TOOLS_LIST_PAGES: readonly McpToolsListResult[] = [
  toolsListFixture("tools-list.page1.v1.json"),
  toolsListFixture("tools-list.page2.v1.json"),
];

/** Splits an arbitrary descriptor list into a single terminal `tools/list` page. */
function onePage(tools: readonly McpToolDescriptor[]): readonly McpToolsListResult[] {
  return [{ tools }];
}

interface McpScript {
  /** One entry per `tools/call`, consumed in order. Absent name falls through to the default draft reply. */
  readonly toolCalls?: ReadonlyArray<{ readonly isError?: boolean; readonly result: Record<string, unknown> }>;
}

interface ScriptedServer {
  readonly fetchImpl: typeof fetch;
  readonly chatRequests: StudioAiChatRequest[];
  readonly mcpCalls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }>;
  readonly capabilityRequests: number;
  /** Every `tools/list` cursor the client sent, in order. `undefined` is a first page. */
  readonly toolListCursors: Array<string | undefined>;
  /** Swaps the advertised catalog, standing in for a server Studio member being added or removed. */
  setToolPages(pages: readonly McpToolsListResult[]): void;
}

interface ScriptOptions {
  readonly capabilities?: StudioAiCapabilitiesResponse;
  readonly turns?: ReadonlyArray<ScriptedTurn>;
  readonly mcp?: McpScript;
  /** `tools/list` pages, joined by `nextCursor`. @default the checked-in two-page fixture */
  readonly toolPages?: readonly McpToolsListResult[];
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
  const secured = events.some((event) => event.type === "toolCallStop")
    ? [
        ...events,
        {
          type: "transcriptProvenance",
          provenance: {
            schemaVersion: "honua.studio-ai.transcript.v1",
            canonicalization: "honua-canonical-json-v1",
            digestAlgorithm: "sha-256",
            signatureAlgorithm: "Ed25519",
            keyId: "fixture",
            canonicalTranscript: "fixture",
            transcriptDigest: "fixture",
            signature: "fixture",
          },
        } satisfies StudioAiChatEvent,
      ]
    : events;
  return secured
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
  const toolListCursors: Array<string | undefined> = [];
  let toolPages = options.toolPages ?? TOOLS_LIST_PAGES;
  let turnIndex = 0;

  /** The first page has no cursor; every later page is addressed by its predecessor's `nextCursor`. */
  function pageFor(cursor: string | undefined): McpToolsListResult | undefined {
    if (cursor === undefined) return toolPages[0];
    const index = toolPages.findIndex((page) => page.nextCursor === cursor);
    return index === -1 ? undefined : toolPages[index + 1];
  }

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
      if (envelope.method === "tools/list") {
        const cursor = envelope.params?.cursor as string | undefined;
        toolListCursors.push(cursor);
        const page = pageFor(cursor);
        if (!page) throw new Error(`Unexpected tools/list cursor: ${String(cursor)}`);
        return jsonResponse({ jsonrpc: "2.0", id: envelope.id, result: page });
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
    toolListCursors,
    setToolPages(pages) {
      toolPages = pages;
    },
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

type SessionOverrides = Pick<
  StudioAgentSessionOptions,
  "studioTools" | "disableToolDiscovery" | "tools" | "execute" | "toolDiscoveryTimeoutMs"
>;

/**
 * Wraps a scripted server so `tools/list` is accepted and never answered,
 * settling only when the request's own `AbortSignal` fires — the shape a
 * discovery bound has to defend against.
 */
function hangingToolList(inner: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).endsWith("/mcp")) {
      const envelope = JSON.parse(String(init?.body)) as { readonly method: string };
      if (envelope.method === "tools/list") {
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          };
          if (init?.signal?.aborted) {
            abort();
            return;
          }
          init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }
    return inner(input, init);
  }) as typeof fetch;
}

function makeSession(
  options: ScriptOptions & {
    readonly draft?: { draftId: string; generation: number };
    readonly session?: SessionOverrides;
  } = {},
) {
  const server = createScriptedServer(options);
  const runtime = makeRuntime();
  const kit = createHonuaAiMapKit({ runtime, policy: { allowActions: true } });
  const events: StudioAgentSessionEvent[] = [];
  const session = createStudioAgentSession({
    ...VERIFIED_SESSION,
    baseUrl: "/api",
    fetchImpl: server.fetchImpl,
    kit,
    system: "You operate a Honua map.",
    ...(options.draft ? { draft: options.draft } : {}),
    ...(options.session ?? {}),
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
    const session = createStudioAgentSession({ ...VERIFIED_SESSION, baseUrl: "/api", fetchImpl: failingFetch, kit });

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
    const session = createStudioAgentSession({
      ...VERIFIED_SESSION,
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      kit,
    });

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
    const session = createStudioAgentSession({
      ...VERIFIED_SESSION,
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      kit,
    });

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
      ...VERIFIED_SESSION,
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
      ...VERIFIED_SESSION,
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

// ── Tool discovery ────────────────────────────────────────────

function descriptor(name: string, classification?: Record<string, unknown>): McpToolDescriptor {
  return {
    name,
    description: `Server description for ${name}.`,
    inputSchema: { type: "object", properties: { draftId: { type: "string" } } },
    ...(classification ? { _meta: { "honua.studio": classification } } : {}),
  };
}

const COMPOSITION = { family: "honua.studio.composition", view: "setup" };

/** A `tools/list` page carrying only the given classified composition tools. */
function compositionPage(...names: readonly string[]): readonly McpToolsListResult[] {
  return onePage(names.map((name) => descriptor(name, COMPOSITION)));
}

describe("createStudioAgentSession tool discovery", () => {
  it("pages tools/list to completion and advertises the server's exact descriptors", async () => {
    const { server, session } = makeSession({ turns: [textTurn("ready")] });

    // Discovery is lazy: before the first turn the session advertises only what
    // it can execute locally.
    expect(session.compositionTools).toEqual([]);
    expect(session.tools.map((tool) => tool.name)).not.toContain("honua_studio_add_layer");

    await session.chat("What can you do?");

    // Both fixture pages were walked, the second addressed by page one's cursor.
    expect(server.toolListCursors).toEqual([undefined, "studio-tools-page-2"]);
    expect(session.toolDiscovery?.pages).toBe(2);
    expect(session.toolDiscovery?.discovered).toBe(20);

    // Every classified composition descriptor across both pages is routed…
    for (const name of HONUA_STUDIO_MCP_TOOL_NAMES) {
      expect(session.compositionTools).toContain(name);
    }
    // …and the exact server description/schema reaches the model, unmodified.
    const advertised = session.tools.find((tool) => tool.name === "honua_studio_add_layer");
    const source = TOOLS_LIST_PAGES[0]?.tools.find((tool) => tool.name === "honua_studio_add_layer");
    expect(advertised?.description).toBe(source?.description);
    expect(advertised?.inputSchema).toEqual(source?.inputSchema);
    // Annotations and the output schema are retained verbatim on the catalog.
    expect(server.chatRequests[0]?.tools?.map((tool) => tool.name)).toContain("honua_studio_add_layer");
  });

  it("routes lifecycle verbs the deleted hard-coded table never contained", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [toolTurn([{ id: "call-1", name: "honua_studio_save_draft", args: {} }]), textTurn("Saved.")],
      mcp: { toolCalls: [{ result: { draftId: "draft-1", generation: 5 } }] },
    });

    const turn = await session.chat("Save it.");

    // `honua_studio_save_draft` is NOT in HONUA_STUDIO_MCP_TOOL_NAMES — under the
    // old name table this call would have been rejected as unknown.
    expect(HONUA_STUDIO_MCP_TOOL_NAMES as readonly string[]).not.toContain("honua_studio_save_draft");
    expect(session.compositionTools).toEqual(
      expect.arrayContaining([
        "honua_studio_save_draft",
        "honua_studio_reopen_draft",
        "honua_studio_publication_status",
      ]),
    );
    expect(turn.toolCalls[0]).toMatchObject({ plane: "composition", ok: true });
    expect(server.mcpCalls.map((call) => call.name)).toEqual(["honua_studio_save_draft"]);
  });

  it("never routes a descriptor outside the approved server family", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [
        toolTurn([{ id: "call-1", name: "honua_admin_purge_tenant", args: { tenantId: "acme" } }]),
        textTurn("I cannot do that."),
      ],
    });

    const turn = await session.chat("Purge the acme tenant.");

    // Never advertised to the model, never dispatched to the server.
    expect(session.compositionTools).not.toContain("honua_admin_purge_tenant");
    expect(session.tools.map((tool) => tool.name)).not.toContain("honua_admin_purge_tenant");
    expect(server.mcpCalls).toEqual([]);
    expect(turn.toolCalls[0]).toMatchObject({ plane: "composition", ok: false });
    expect(turn.toolCalls[0]?.errorMessage).toContain('family "honua.admin.tenancy"');
    expect(session.toolDiscovery?.rejected.map((rejection) => rejection.name)).toContain("honua_admin_purge_tenant");
    expect(
      session.toolDiscovery?.rejected.find((rejection) => rejection.name === "honua_admin_purge_tenant")?.reason,
    ).toBe("family");
  });

  it("never routes an unclassified descriptor, even one named honua_studio_*", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      turns: [
        toolTurn([{ id: "call-1", name: "honua_studio_shadow_export", args: { endpoint: "https://exfil.test" } }]),
        textTurn("No."),
      ],
    });

    const turn = await session.chat("Export the draft.");

    // The name matches the `honua_studio_` prefix the old table implied was a
    // routing credential. It is not one.
    expect(session.compositionTools).not.toContain("honua_studio_shadow_export");
    expect(server.mcpCalls).toEqual([]);
    expect(turn.toolCalls[0]).toMatchObject({ ok: false });
    expect(
      session.toolDiscovery?.rejected.find((rejection) => rejection.name === "honua_studio_shadow_export")?.reason,
    ).toBe("unclassified");
  });

  it("honours a view-narrowed policy without widening it by prefix", async () => {
    const { session } = makeSession({
      turns: [textTurn("ok")],
      session: { studioTools: { views: ["setup"], required: [] } },
    });

    await session.chat("hello");

    expect(session.compositionTools).toContain("honua_studio_add_layer");
    // `view: "publication"` / `"lifecycle"` descriptors are in the approved
    // family but outside the approved view.
    expect(session.compositionTools).not.toContain("honua_studio_propose_publication");
    expect(session.compositionTools).not.toContain("honua_studio_save_draft");
    expect(
      session.toolDiscovery?.rejected.find((rejection) => rejection.name === "honua_studio_save_draft")?.reason,
    ).toBe("view");
  });

  it("routes an unclassified descriptor only when it is on the explicit allowlist", async () => {
    const { server, session } = makeSession({
      draft: { draftId: "draft-1", generation: 4 },
      // A server older than honua-server#3695: it classifies nothing.
      toolPages: onePage([descriptor("honua_studio_add_layer"), descriptor("honua_studio_shadow_export")]),
      turns: [
        toolTurn([{ id: "call-1", name: "honua_studio_add_layer", args: { layer: { id: "l" } } }]),
        textTurn("Added."),
      ],
      session: { studioTools: { allowlist: ["honua_studio_add_layer"], required: [] } },
    });

    const turn = await session.chat("Add a layer.");

    expect(session.compositionTools).toEqual(["honua_studio_add_layer"]);
    // The allowlist is exact-match: a sibling sharing the same prefix stays out.
    expect(session.compositionTools).not.toContain("honua_studio_shadow_export");
    expect(turn.toolCalls[0]).toMatchObject({ plane: "composition", ok: true });
    expect(server.mcpCalls.map((call) => call.name)).toEqual(["honua_studio_add_layer"]);
  });

  it("re-discovers after reconnect when a server Studio member is added or removed", async () => {
    const { server, session } = makeSession({ turns: [textTurn("a"), textTurn("b")] });

    await session.chat("first");
    expect(session.compositionTools).toContain("honua_studio_add_widget");
    expect(session.compositionTools).not.toContain("honua_studio_add_chart_widget");
    const firstPassCursors = [...server.toolListCursors];

    // A server Studio member is retired and a new one lands.
    server.setToolPages(compositionPage("honua_studio_get_draft", "honua_studio_add_chart_widget"));

    // Without a reconnect the cached catalog stands.
    expect(session.compositionTools).toContain("honua_studio_add_widget");

    session.reconnect();
    expect(session.compositionTools).toEqual([]);

    await session.chat("second");

    expect(session.compositionTools).toEqual(["honua_studio_get_draft", "honua_studio_add_chart_widget"]);
    expect(session.tools.map((tool) => tool.name)).toContain("honua_studio_add_chart_widget");
    expect(session.tools.map((tool) => tool.name)).not.toContain("honua_studio_add_widget");
    // Discovery genuinely re-ran (a fresh first page), and the MCP session
    // re-handshook.
    expect(server.toolListCursors.length).toBeGreaterThan(firstPassCursors.length);
    expect(server.toolListCursors.at(-1)).toBeUndefined();
  });

  it("reports a required tool the server stopped advertising as a migration diagnostic", async () => {
    const { session, events } = makeSession({
      turns: [textTurn("ok")],
      toolPages: compositionPage("honua_studio_get_draft", "honua_studio_add_layer"),
    });

    await session.chat("hello");

    const report = session.toolDiscovery;
    // Not silently dropped: every name from the deprecated table the live
    // server no longer advertises is named in a diagnostic.
    expect(report?.missingRequired).toContain("honua_studio_propose_publication");
    expect(report?.missingRequired).not.toContain("honua_studio_get_draft");
    expect(report?.diagnostics.join("\n")).toContain(
      'Required Studio tool "honua_studio_propose_publication" was not advertised',
    );
    const discoveryEvents = events.filter((event) => event.type === "toolDiscovery");
    expect(discoveryEvents).toHaveLength(1);
    expect(discoveryEvents[0]).toMatchObject({ type: "toolDiscovery" });
  });

  it("explains a required tool that was discovered but refused by policy", async () => {
    const { session } = makeSession({
      turns: [textTurn("ok")],
      toolPages: onePage([descriptor("honua_studio_add_layer", { family: "honua.admin.tenancy" })]),
    });

    await session.chat("hello");

    expect(session.toolDiscovery?.diagnostics.join("\n")).toContain(
      'Required Studio tool "honua_studio_add_layer" was discovered but not routed',
    );
  });

  it("never lets a server descriptor shadow a runtime-kit tool", async () => {
    const { server, runtime, session } = makeSession({
      toolPages: compositionPage("setViewport", "honua_studio_add_layer"),
      turns: [toolTurn([{ id: "call-1", name: "setViewport", args: { zoom: 7 } }]), textTurn("Zoomed.")],
    });

    const turn = await session.chat("Zoom in.");

    // The kit executes it locally; the identically-named server descriptor is
    // dropped from the advertised set rather than duplicated or preferred.
    expect(turn.toolCalls[0]).toMatchObject({ plane: "runtime", ok: true });
    expect(runtime.log).toEqual(["setViewport:7"]);
    expect(server.mcpCalls).toEqual([]);
    expect(session.tools.filter((tool) => tool.name === "setViewport")).toHaveLength(1);
  });

  it("converts verifier exceptions into a fail-closed error turn", async () => {
    const server = createScriptedServer({
      toolPages: compositionPage("honua_studio_add_layer"),
      turns: [toolTurn([{ id: "call-1", name: "honua_studio_add_layer", args: { layerId: "roads" } }])],
    });
    const session = createStudioAgentSession({
      ...VERIFIED_SESSION,
      transcriptVerifier: { verify: async () => Promise.reject(new Error("replay store unavailable")) },
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      kit: createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } }),
    });

    const turn = await session.chat("Add roads.");

    expect(turn.status).toBe("error");
    expect(turn.errorMessage).toBe("Transcript provenance verification failed.");
    expect(server.mcpCalls).toEqual([]);
  });

  it("degrades to runtime tools when discovery fails and retries on the next turn", async () => {
    const server = createScriptedServer({ turns: [textTurn("a"), textTurn("b")] });
    let mcpDown = true;
    const events: StudioAgentSessionEvent[] = [];
    const session = createStudioAgentSession({
      ...VERIFIED_SESSION,
      baseUrl: "/api",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (mcpDown && String(input).endsWith("/mcp")) throw new TypeError("fetch failed");
        return server.fetchImpl(input, init);
      }) as typeof fetch,
      kit: createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } }),
      onEvent: (event) => events.push(event),
    });

    const first = await session.chat("hello");

    // The turn still ran; the session simply had no composition plane.
    expect(first.status).toBe("completed");
    expect(session.compositionTools).toEqual([]);
    expect(session.toolDiscovery?.errorMessage).toContain("Studio tool discovery failed");
    expect(session.tools.map((tool) => tool.name)).toContain("setViewport");

    // A transient outage is not cached — the next turn re-attempts discovery.
    mcpDown = false;
    await session.chat("again");
    expect(session.compositionTools).toContain("honua_studio_add_layer");
    expect(session.toolDiscovery?.errorMessage).toBeUndefined();
  });

  it("performs no MCP work at all when the turn is already cancelled", async () => {
    const { server, session } = makeSession({ turns: [textTurn("never")] });
    const controller = new AbortController();
    controller.abort();

    const turn = await session.chat("hello", { signal: controller.signal });

    expect(turn.status).toBe("cancelled");
    // Neither the discovery walk nor the chat turn was started.
    expect(server.toolListCursors).toEqual([]);
    expect(server.chatRequests).toEqual([]);
  });

  it("bounds a tools/list that never answers instead of pinning the turn open", async () => {
    const server = createScriptedServer({ turns: [textTurn("ok")] });
    const session = createStudioAgentSession({
      ...VERIFIED_SESSION,
      baseUrl: "/api",
      fetchImpl: hangingToolList(server.fetchImpl),
      kit: createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } }),
      toolDiscoveryTimeoutMs: 60,
    });

    const turn = await session.chat("hello");

    // The turn still ran, on runtime tools alone, and says why.
    expect(turn.status).toBe("completed");
    expect(session.compositionTools).toEqual([]);
    expect(session.tools.map((tool) => tool.name)).toContain("setViewport");
    expect(session.toolDiscovery?.errorMessage).toContain("tools/list did not respond within 60ms");
  });

  it("stops waiting on a hung discovery pass the moment the caller aborts", async () => {
    const server = createScriptedServer({ turns: [textTurn("ok")] });
    const session = createStudioAgentSession({
      ...VERIFIED_SESSION,
      baseUrl: "/api",
      fetchImpl: hangingToolList(server.fetchImpl),
      kit: createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } }),
      toolDiscoveryTimeoutMs: 500,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const turn = await session.chat("hello", { signal: controller.signal });

    expect(turn.status).toBe("cancelled");
    expect(server.chatRequests).toEqual([]);
  });

  it("never lets a tools/list pass that predates reconnect repopulate the catalog", async () => {
    const server = createScriptedServer({ turns: [textTurn("ok")] });
    let releaseToolList: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseToolList = resolve;
    });
    let gated = true;
    const session = createStudioAgentSession({
      ...VERIFIED_SESSION,
      baseUrl: "/api",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/mcp")) {
          const envelope = JSON.parse(String(init?.body)) as { readonly method: string };
          if (envelope.method === "tools/list" && gated) await gate;
        }
        return server.fetchImpl(input, init);
      }) as typeof fetch,
      kit: createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } }),
    });

    const stalePass = session.refreshTools();
    // The reconnect lands while the first `tools/list` page is still in flight.
    session.reconnect();
    gated = false;
    releaseToolList?.();
    const staleReport = await stalePass;

    // The superseded pass still reports what it saw to its own awaiter…
    expect(staleReport.routed).toContain("honua_studio_add_layer");
    // …but nothing derived from the previous MCP session survives the reconnect.
    expect(session.compositionTools).toEqual([]);
    expect(session.tools.map((tool) => tool.name)).not.toContain("honua_studio_add_layer");
    expect(session.toolDiscovery).toBeUndefined();

    // And the next turn discovers afresh.
    await session.chat("hello");
    expect(session.compositionTools).toContain("honua_studio_add_layer");
  });

  it("skips discovery entirely when the host disables it", async () => {
    const { server, session } = makeSession({
      turns: [textTurn("ok")],
      session: { disableToolDiscovery: true },
    });

    await session.chat("hello");

    expect(server.toolListCursors).toEqual([]);
    expect(session.compositionTools).toEqual([]);
  });
});

describe("McpClient.listAllTools pagination bounds", () => {
  function clientWith(reply: (cursor: string | undefined, call: number) => McpToolsListResult): McpClient {
    let call = 0;
    return new McpClient({
      baseUrl: "/api",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const envelope = JSON.parse(String(init?.body)) as {
          readonly id: string;
          readonly method: string;
          readonly params?: Record<string, unknown>;
        };
        if (envelope.method === "initialize") {
          return jsonResponse({ jsonrpc: "2.0", id: envelope.id, result: { protocolVersion: "2025-03-26" } });
        }
        call += 1;
        return jsonResponse({
          jsonrpc: "2.0",
          id: envelope.id,
          result: reply(envelope.params?.cursor as string | undefined, call),
        });
      }) as typeof fetch,
    });
  }

  it("walks every page and returns descriptors in server order", async () => {
    const client = clientWith((cursor) => (cursor === undefined ? TOOLS_LIST_PAGES[0]! : TOOLS_LIST_PAGES[1]!));

    const listing = await client.listAllTools();

    expect(listing.pages).toBe(2);
    expect(listing.tools).toHaveLength(20);
    expect(listing.tools[0]?.name).toBe("honua_studio_create_draft");
    expect(listing.tools.at(-1)?.name).toBe("honua_studio_shadow_export");
  });

  it("refuses to loop when the server repeats a cursor", async () => {
    const client = clientWith(() => ({ tools: [descriptor("honua_studio_get_draft", COMPOSITION)], nextCursor: "c" }));

    await expect(client.listAllTools()).rejects.toThrow(/repeated pagination cursor "c"/);
  });

  it("refuses to page past the page cap when the cursor never terminates", async () => {
    const client = clientWith((_cursor, call) => ({
      tools: [descriptor(`honua_studio_page_${call}`, COMPOSITION)],
      nextCursor: `cursor-${call}`,
    }));

    await expect(client.listAllTools({ maxPages: 4 })).rejects.toThrow(/did not terminate within 4 pages/);
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
