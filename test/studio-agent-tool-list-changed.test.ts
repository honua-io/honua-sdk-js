/**
 * The `notifications/tools/list_changed` refresh path, and the discovery
 * surface a downstream consumer migrates its own hard-coded Studio tool list
 * onto.
 *
 * `POST /mcp` is request/response, so nothing on it can carry a server-initiated
 * notification. These tests drive the OTHER stream the MCP Streamable HTTP
 * transport defines — a standalone `GET /mcp` SSE subscription — with real SSE
 * bytes and a controllable server, so the framing, the reconnect budget, and
 * the teardown are exercised rather than stubbed.
 */
import { describe, expect, it } from "vitest";

import {
  HONUA_STUDIO_MCP_TOOL_NAMES,
  HONUA_STUDIO_TOOL_FAMILY,
  MCP_TOOL_LIST_CHANGED_NOTIFICATION,
  type McpToolDescriptor,
  type McpToolsListResult,
  type StudioAgentSessionEvent,
  StudioToolCatalog,
  createStudioAgentSession,
} from "@honua/sdk-js/studio-agent";

// ── Scripted `/mcp` server ────────────────────────────────────

interface OpenStream {
  /** Writes raw SSE text to the open subscription. */
  push(chunk: string): void;
  /** Ends the subscription the way a server hanging up does. */
  end(): void;
}

interface McpTestServer {
  readonly fetchImpl: typeof fetch;
  /** One entry per `GET /mcp`, in order. */
  readonly getHeaders: Array<Record<string, string>>;
  readonly getSignals: Array<AbortSignal | undefined>;
  /** The subscriptions that were actually opened (405 replies do not appear here). */
  readonly streams: OpenStream[];
  readonly getCount: number;
  readonly listCalls: number;
  setPages(pages: readonly McpToolsListResult[]): void;
}

interface McpTestServerOptions {
  readonly pages?: readonly McpToolsListResult[];
  /** Status for the Nth `GET /mcp` (0-based). @default 200 */
  readonly getStatus?: (attempt: number) => number;
  /** Ends every subscription the instant it opens — a flapping push channel. */
  readonly dropImmediately?: boolean;
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers as Record<string, string>)) out[key.toLowerCase()] = value;
  return out;
}

function sseStreamResponse(signal: AbortSignal | undefined, register: (stream: OpenStream) => void): Response {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  // A real `fetch` errors the body stream when the request is aborted; the
  // scripted one has to do it by hand or `close()` would look like a clean EOF.
  signal?.addEventListener(
    "abort",
    () => {
      try {
        controller.error(new DOMException("Aborted", "AbortError"));
      } catch {
        // Already closed.
      }
    },
    { once: true },
  );
  register({
    push: (chunk) => controller.enqueue(encoder.encode(chunk)),
    end: () => {
      try {
        controller.close();
      } catch {
        // Already closed/errored.
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createMcpTestServer(options: McpTestServerOptions = {}): McpTestServer {
  let pages: readonly McpToolsListResult[] = options.pages ?? [{ tools: [] }];
  const getHeaders: Array<Record<string, string>> = [];
  const getSignals: Array<AbortSignal | undefined> = [];
  const streams: OpenStream[] = [];
  const counters = { get: 0, list: 0 };

  function pageFor(cursor: string | undefined): McpToolsListResult | undefined {
    if (cursor === undefined) return pages[0];
    const index = pages.findIndex((page) => page.nextCursor === cursor);
    return index === -1 ? undefined : pages[index + 1];
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.endsWith("/mcp")) throw new Error(`Unexpected request: ${url}`);

    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      const attempt = counters.get;
      counters.get += 1;
      getHeaders.push(headersToObject(init?.headers));
      getSignals.push(init?.signal ?? undefined);
      const status = options.getStatus?.(attempt) ?? 200;
      if (status !== 200) return new Response(null, { status });
      return sseStreamResponse(init?.signal ?? undefined, (stream) => {
        streams.push(stream);
        if (options.dropImmediately) stream.end();
      });
    }

    const envelope = JSON.parse(String(init?.body)) as {
      readonly id: string;
      readonly method: string;
      readonly params?: Record<string, unknown>;
    };
    if (envelope.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: { protocolVersion: "2025-03-26" } }),
        {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
        },
      );
    }
    if (envelope.method === "tools/list") {
      counters.list += 1;
      const page = pageFor(envelope.params?.cursor as string | undefined);
      if (!page) throw new Error(`Unexpected tools/list cursor: ${String(envelope.params?.cursor)}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: page }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected MCP method: ${envelope.method}`);
  }) as typeof fetch;

  return {
    fetchImpl,
    getHeaders,
    getSignals,
    streams,
    setPages(next) {
      pages = next;
    },
    get getCount() {
      return counters.get;
    },
    get listCalls() {
      return counters.list;
    },
  };
}

// ── Fixtures / helpers ────────────────────────────────────────

/** A descriptor carrying the server-owned classification the default policy approves. */
function classified(name: string): McpToolDescriptor {
  return {
    name,
    inputSchema: { type: "object" },
    _meta: { "honua.studio": { family: HONUA_STUDIO_TOOL_FAMILY, view: "setup" } },
  };
}

/** A descriptor with NO server classification — selectable only by an exact allowlist. */
function unclassified(name: string): McpToolDescriptor {
  return { name, inputSchema: { type: "object" } };
}

function notificationFrame(method: string, id?: string): string {
  const data = JSON.stringify({ jsonrpc: "2.0", method });
  return `${id ? `id: ${id}\n` : ""}data: ${data}\n\n`;
}

async function waitFor(predicate: () => boolean, label: string, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function makeWatchingSession(
  server: McpTestServer,
  overrides: {
    readonly watchToolListChanged?: boolean;
    readonly maxReconnectAttempts?: number;
    readonly events?: StudioAgentSessionEvent[];
  } = {},
) {
  return createStudioAgentSession({
    baseUrl: "/api",
    fetchImpl: server.fetchImpl,
    tools: [],
    watchToolListChanged: overrides.watchToolListChanged ?? true,
    toolListChangedWatch: {
      // Real timers, zero delay: the budget and the backoff ORDER are what these
      // tests assert, not wall-clock durations. `stableStreamMs` is pinned high
      // rather than left to default off `maxReconnectDelayMs`, so an instantly
      // dropped connection can never count as "proved itself" and silently
      // reset the budget these tests are asserting on.
      initialReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      stableStreamMs: 60_000,
      ...(overrides.maxReconnectAttempts !== undefined ? { maxReconnectAttempts: overrides.maxReconnectAttempts } : {}),
    },
    ...(overrides.events ? { onEvent: (event) => overrides.events?.push(event) } : {}),
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe("tools/list_changed subscription", () => {
  it("is opt-in: a session that did not ask for it never opens a GET stream", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const session = createStudioAgentSession({
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      tools: [],
    });

    await session.refreshTools();

    expect(session.compositionTools).toEqual(["honua_studio_add_layer"]);
    expect(server.getCount).toBe(0);
    expect(session.toolWatchStatus).toBeUndefined();
    session.close();
  });

  it("subscribes after discovery and carries the negotiated session id", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const session = makeWatchingSession(server);

    await session.refreshTools();
    await waitFor(() => server.getCount === 1, "the notification stream to open");

    expect(server.getHeaders[0]?.accept).toBe("text/event-stream");
    expect(server.getHeaders[0]?.["mcp-session-id"]).toBe("session-1");
    expect(server.getHeaders[0]?.["mcp-protocol-version"]).toBe("2025-03-26");
    await waitFor(() => session.toolWatchStatus === "open", "the stream to report open");
    session.close();
  });

  it("re-discovers the catalog when the server announces tools/list_changed", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const events: StudioAgentSessionEvent[] = [];
    const session = makeWatchingSession(server, { events });

    await session.refreshTools();
    expect(session.compositionTools).toEqual(["honua_studio_add_layer"]);
    await waitFor(() => server.streams.length === 1, "the notification stream to open");

    // The server grows a lifecycle verb and says so.
    server.setPages([{ tools: [classified("honua_studio_add_layer"), classified("honua_studio_add_widget")] }]);
    server.streams[0]?.push(notificationFrame(MCP_TOOL_LIST_CHANGED_NOTIFICATION));

    await waitFor(() => session.compositionTools.length === 2, "the catalog to be re-discovered");
    expect(session.compositionTools).toEqual(["honua_studio_add_layer", "honua_studio_add_widget"]);
    expect(session.tools.map((tool) => tool.name)).toContain("honua_studio_add_widget");
    // Re-discovery is a second `tools/list` walk, not a re-subscription.
    expect(server.listCalls).toBe(2);
    expect(server.getCount).toBe(1);
    expect(events.filter((event) => event.type === "toolDiscovery")).toHaveLength(2);
    session.close();
  });

  it("ignores notifications that are not tools/list_changed", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const session = makeWatchingSession(server);

    await session.refreshTools();
    await waitFor(() => server.streams.length === 1, "the notification stream to open");
    server.streams[0]?.push(notificationFrame("notifications/resources/list_changed"));
    server.streams[0]?.push(notificationFrame("notifications/message"));
    // A server-to-client REQUEST (has an `id`) is not a notification either.
    server.streams[0]?.push(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "sampling/createMessage" })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.listCalls).toBe(1);
    session.close();
  });

  it("never routes an unclassified honua_studio_* descriptor a refresh introduces", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const session = makeWatchingSession(server);

    await session.refreshTools();
    await waitFor(() => server.streams.length === 1, "the notification stream to open");

    // A server (or one a caller was tricked into pointing at) announces a
    // change and then advertises an unclassified, non-allowlisted name whose
    // only credential is its prefix.
    server.setPages([
      { tools: [classified("honua_studio_add_layer"), unclassified("honua_studio_delete_everything")] },
    ]);
    server.streams[0]?.push(notificationFrame(MCP_TOOL_LIST_CHANGED_NOTIFICATION));
    await waitFor(() => server.listCalls === 2, "the refresh to complete");

    expect(session.compositionTools).toEqual(["honua_studio_add_layer"]);
    expect(session.toolDiscovery?.rejected.map((rejection) => rejection.name)).toContain(
      "honua_studio_delete_everything",
    );
    expect(session.toolDiscovery?.rejected.find((r) => r.name === "honua_studio_delete_everything")?.reason).toBe(
      "unclassified",
    );
    session.close();
  });

  it("treats a 405 as 'no push channel here' and stops, without erroring", async () => {
    const server = createMcpTestServer({
      pages: [{ tools: [classified("honua_studio_add_layer")] }],
      getStatus: () => 405,
    });
    const session = makeWatchingSession(server);

    await session.refreshTools();
    await waitFor(() => session.toolWatchStatus === "unsupported", "the stream to report unsupported");

    // One probe, no retries — and the session keeps the catalog it discovered.
    expect(server.getCount).toBe(1);
    expect(session.compositionTools).toEqual(["honua_studio_add_layer"]);
    session.close();
  });

  it("reconnects with the last event id after the stream drops", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const session = makeWatchingSession(server, { maxReconnectAttempts: 3 });

    await session.refreshTools();
    await waitFor(() => server.streams.length === 1, "the notification stream to open");

    server.streams[0]?.push(notificationFrame("notifications/message", "evt-7"));
    server.streams[0]?.push(notificationFrame(MCP_TOOL_LIST_CHANGED_NOTIFICATION, "evt-8"));
    await waitFor(() => server.listCalls === 2, "the refresh triggered by the first stream");

    server.streams[0]?.end();
    await waitFor(() => server.getCount === 2, "the stream to reconnect");
    expect(server.getHeaders[1]?.["last-event-id"]).toBe("evt-8");

    // The resumed subscription is live: a second announcement still refreshes.
    server.streams[1]?.push(notificationFrame(MCP_TOOL_LIST_CHANGED_NOTIFICATION, "evt-9"));
    await waitFor(() => server.listCalls === 3, "the refresh triggered by the resumed stream");
    session.close();
  });

  it("bounds reconnection: a flapping server exhausts the budget and stops", async () => {
    const server = createMcpTestServer({
      pages: [{ tools: [classified("honua_studio_add_layer")] }],
      dropImmediately: true,
    });
    const events: StudioAgentSessionEvent[] = [];
    const session = makeWatchingSession(server, { maxReconnectAttempts: 2, events });

    await session.refreshTools();
    await waitFor(() => session.toolWatchStatus === "failed", "the reconnect budget to be exhausted");

    // The initial attempt plus exactly two reconnects — a stream that never
    // proved itself must not reset the budget on every cycle.
    expect(server.getCount).toBe(3);
    const watchStatuses = events.filter((event) => event.type === "toolWatch").map((event) => event.status);
    expect(watchStatuses).toContain("reconnecting");
    expect(watchStatuses.at(-1)).toBe("failed");
    session.close();
  });

  it("close() aborts the in-flight GET rather than leaving it open", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const session = makeWatchingSession(server);

    await session.refreshTools();
    await waitFor(() => session.toolWatchStatus === "open", "the stream to report open");

    session.close();

    expect(session.toolWatchStatus).toBe("closed");
    expect(server.getSignals[0]?.aborted).toBe(true);
    // Terminal is terminal: the torn-down stream does not reconnect.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.getCount).toBe(1);
  });

  it("reconnect() drops the subscription bound to the old session and opens a fresh one", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const session = makeWatchingSession(server);

    await session.refreshTools();
    await waitFor(() => session.toolWatchStatus === "open", "the stream to report open");

    session.reconnect();
    expect(server.getSignals[0]?.aborted).toBe(true);
    expect(session.compositionTools).toEqual([]);

    await session.refreshTools();
    await waitFor(() => server.getCount === 2, "a fresh subscription after re-handshake");
    expect(session.toolWatchStatus).toBe("open");
    session.close();
  });

  it("does not watch when tool discovery is disabled", async () => {
    const server = createMcpTestServer({ pages: [{ tools: [classified("honua_studio_add_layer")] }] });
    const session = createStudioAgentSession({
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      tools: [],
      watchToolListChanged: true,
      disableToolDiscovery: true,
    });

    await session.refreshTools();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.getCount).toBe(0);
    expect(session.toolWatchStatus).toBeUndefined();
    session.close();
  });
});

// ── The surface a downstream consumer migrates its own list onto ──
//
// honua-studio owns a 12-name `STUDIO_MCP_TOOL_NAMES` table
// (`src/mcp/studio-tools.ts`) plus a `StudioMcpToolName` union derived from it,
// and routes composition tools off a static bridge table. This block pins the
// exported SDK surface that lets it delete that table: the SDK's own name list
// is usable verbatim as an EXACT allowlist while honua-server#3428's
// classification metadata is pending, discovery narrows it to what the live
// server actually advertises, and the report names the gap. Nothing here
// declares a tool-name array of its own — that is the point.

describe("StudioToolCatalog as a downstream consumer's migration target", () => {
  it("routes the server catalog with the SDK's name table as the exact allowlist", () => {
    const catalog = StudioToolCatalog.fromDescriptors(
      [
        unclassified("honua_studio_add_layer"),
        unclassified("honua_studio_set_layer_style"),
        unclassified("some_other_server_tool"),
      ],
      { allowlist: HONUA_STUDIO_MCP_TOOL_NAMES, required: HONUA_STUDIO_MCP_TOOL_NAMES },
    );

    expect(catalog.names).toEqual(["honua_studio_add_layer", "honua_studio_set_layer_style"]);
    expect(catalog.has("some_other_server_tool")).toBe(false);
    // A discovered name is a plain `string`, so a consumer's compile-time
    // `StudioMcpToolName` union widens away rather than needing a replacement.
    const routed: readonly string[] = catalog.names;
    expect(routed).toHaveLength(2);
  });

  it("reports the required names the live server never advertised", () => {
    const catalog = StudioToolCatalog.fromDescriptors([unclassified("honua_studio_add_layer")], {
      allowlist: HONUA_STUDIO_MCP_TOOL_NAMES,
      required: ["honua_studio_add_layer", "honua_studio_set_layer_visibility", "honua_studio_bind_interaction"],
    });

    expect(catalog.missingRequired).toEqual(["honua_studio_set_layer_visibility", "honua_studio_bind_interaction"]);
    expect(catalog.report(1).diagnostics.join("\n")).toContain("honua_studio_set_layer_visibility");
  });

  it("prefers server classification over the allowlist once the server publishes it", () => {
    const catalog = StudioToolCatalog.fromDescriptors(
      [classified("honua_studio_set_layer_visibility"), classified("honua_studio_bind_interaction")],
      // Deliberately empty: classified descriptors need no consumer-side list.
      { allowlist: [] },
    );

    expect(catalog.names).toEqual(["honua_studio_set_layer_visibility", "honua_studio_bind_interaction"]);
    expect(catalog.entries.every((entry) => entry.source === "metadata")).toBe(true);
  });

  it("gates a consumer's local bridge table on the discovered catalog, never on a name prefix", () => {
    // Stand-in for honua-studio's `TOOL_BRIDGE_TABLE`: it still owns the
    // argument translation, but no longer decides what may be dispatched.
    const bridge: Readonly<Record<string, string>> = {
      honua_studio_add_layer: "addLayer",
      honua_studio_remove_layer: "removeLayer",
      honua_studio_delete_everything: "shouldNeverResolve",
    };
    const catalog = StudioToolCatalog.fromDescriptors(
      [unclassified("honua_studio_add_layer"), unclassified("honua_studio_delete_everything")],
      { allowlist: HONUA_STUDIO_MCP_TOOL_NAMES },
    );
    const dispatchable = Object.keys(bridge).filter((name) => catalog.has(name));

    expect(dispatchable).toEqual(["honua_studio_add_layer"]);
    expect(catalog.has("honua_studio_delete_everything")).toBe(false);
  });
});
