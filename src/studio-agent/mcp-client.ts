/**
 * A minimal MCP client over honua-server's `/mcp` HTTP transport. JSON-RPC
 * 2.0 over `POST /mcp`: `initialize` handshake, `tools/list`, `tools/call`, and `resources/read`.
 * Resource reads preserve Honua continuation cursors; there are no
 * prompts/sampling/roots implementations.
 *
 * **Origin.** Ported verbatim from `honua-studio`'s `src/mcp/client.ts`
 * (honua-studio#7 REQ-001), where it is zero-import, DOM-free, and
 * node-tested. The SDK-vs-hand-rolled decision recorded below is ported with
 * it, deliberately: it is the reason this module exists at all.
 *
 * ## SDK vs. hand-rolled (the decision this module records)
 *
 * `@modelcontextprotocol/sdk` was evaluated and rejected for this client:
 *
 *  - It is a `node_modules`-heavy, transport-and-protocol-agnostic kit built
 *    around `Server`/`Client` classes, stdio transports, and a request-router
 *    abstraction sized for building an MCP SERVER or a general-purpose agent
 *    host — this is neither. It only ever issues four method calls against
 *    one already-known HTTP endpoint.
 *  - It pulls in `zod` (schema validation this surface does not otherwise
 *    need) and a `content-type`/`raw-body`/`eventsource-parser` chain sized
 *    for its own SSE + stdio transports, none of which are exercised by a
 *    request/response POST client.
 *  - This surface already hand-rolls an equally protocol-sensitive streaming
 *    client (`./sse-transport.ts` + `./sse-parser.ts`) rather than reach for
 *    a dependency — the same call applies here, and the surface is smaller
 *    (four JSON-RPC methods, no streaming to parse in the common case).
 *  - Bundle size matters: `@honua/sdk-js` ships to a browser tab and is
 *    budgeted per entrypoint, and the SDK is not tree-shake-friendly against
 *    a four-method usage.
 *
 * A ~250-line hand-rolled client that speaks exactly the transport
 * honua-server documents is safer for bundle size and matches this
 * package's established pattern of thin, dependency-free fetch wrappers with
 * a typed error channel. If a future need for resources/prompts/sampling/roots
 * emerges, or the SDK publishes a slim browser-only transport package,
 * revisit this decision — nothing about the {@link McpClient} public surface
 * below is SDK-shaped in a way that would make swapping it out later
 * disruptive.
 *
 * ## Session handling
 *
 * `POST /mcp` issues a session id on `initialize` (`Mcp-Session-Id` response
 * header) and validates it on every later request. {@link McpClient.initialize}
 * captures it; every subsequent request attaches it. `initialize` must never
 * be batched with anything else (`-32600` if it is) — this client only ever
 * sends single requests, so that constraint is satisfied structurally.
 *
 * ## Transport response shape
 *
 * A `POST /mcp` response is either a single JSON-RPC object
 * (`content-type: application/json`) or, for a server running the
 * streaming-capable profile, a one-shot SSE frame carrying the same JSON-RPC
 * object (`content-type: text/event-stream`) — `#parseResponseBody` handles
 * both.
 *
 * ## Server-initiated notifications
 *
 * `POST /mcp` can only ever carry an answer to something this client asked
 * for, so it cannot deliver `notifications/tools/list_changed`. That travels
 * the transport's other stream — the standalone `GET /mcp` SSE subscription —
 * which {@link McpClient.watchNotifications} opens on demand. It is strictly
 * opt-in: nothing on the request/response path starts it, and a server that
 * does not offer the channel answers `405` and the subscription ends
 * `unsupported` without erroring. See `./mcp-notifications.ts`.
 *
 * @module
 */
import type { StudioAiTokenSource } from "./ai-contract.js";
import { McpProtocolError, McpToolError, McpTransportError } from "./mcp-errors.js";
import { McpNotificationStream, type McpNotificationWatchOptions } from "./mcp-notifications.js";
import {
  type JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  type McpInitializeResult,
  type McpToolDescriptor,
  type McpToolsCallParams,
  type McpToolsCallResult,
  type McpToolsListParams,
  type McpToolsListResult,
  isJsonRpcErrorResponse,
} from "./mcp-protocol.js";

/** JSON-RPC's reserved "internal error" code, used for a server that misuses `tools/list` pagination. */
const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * Page budget for {@link McpClient.listAllTools}. Generous relative to any real
 * Studio catalog (honua-server pages `tools/list` well under this), tight
 * enough that a looping server fails fast.
 */
export const MCP_DEFAULT_MAX_TOOL_LIST_PAGES = 50;

export interface McpListAllToolsOptions {
  /** @default MCP_DEFAULT_MAX_TOOL_LIST_PAGES */
  readonly maxPages?: number;
  /**
   * Aborts the `initialize` handshake and every `tools/list` page. Without it a
   * server that accepts a request and never answers holds the walk open for as
   * long as the host's `fetch` allows — which, for a browser `fetch` with no
   * deadline of its own, is indefinitely.
   */
  readonly signal?: AbortSignal;
  /** Copied onto every `tools/list` page so a bounded view cannot expire after page one. */
  readonly view?: string;
}

/** Every descriptor `tools/list` advertised, plus how many pages it took. */
export interface McpToolListing {
  readonly tools: readonly McpToolDescriptor[];
  readonly pages: number;
  /** View metadata from the pages. Absent when the server did not send `_meta`. */
  readonly metadata?: Record<string, unknown>;
}

/** Honua resource-window options; echo the opaque cursor from the previous result. */
export interface McpReadResourceOptions {
  readonly cursor?: string;
  /** Per-request character budget, from 1 through 1,000,000. Server default is 64,000. */
  readonly maxChars?: number;
  /** Aborts both lazy initialization and this resource request. */
  readonly signal?: AbortSignal;
}

/** A resource chunk. Concatenate text per URI until nextCursor is absent. */
export interface McpReadResourceResult {
  readonly contents?: readonly Record<string, unknown>[];
  readonly nextCursor?: string | null;
}

export interface McpClientOptions {
  /** The `/mcp` endpoint's base — the client POSTs to `${baseUrl}/mcp`. @default "/api" */
  readonly baseUrl?: string;
  readonly auth?: StudioAiTokenSource;
  /**
   * API key sent as `x-api-key`, the same scheme as `honua-mcp-proxy`.
   * Mutually exclusive with {@link McpClientOptions.auth}.
   */
  readonly apiKey?: string;
  /** Advertised in `initialize`'s `clientInfo`. */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Server-authored workflow view negotiated for this session; omitted for the server default. */
  readonly workflowView?: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

let requestSeq = 0;
interface McpInitialization {
  readonly controller: AbortController;
  readonly promise: Promise<McpInitializeResult>;
  waiters: number;
}

function nextRequestId(): string {
  requestSeq += 1;
  return `honua-sdk-js-mcp-${requestSeq}`;
}

/**
 * A minimal, hand-rolled MCP client for honua-server's `POST /mcp` Streamable
 * HTTP transport — see the module doc for the SDK-vs-hand-rolled decision.
 * One instance owns one session (`Mcp-Session-Id`); call
 * {@link McpClient.initialize} once before {@link McpClient.listTools} /
 * {@link McpClient.callTool} (both call it lazily on first use if it hasn't
 * run yet, so callers that only need `callTool` don't have to sequence it
 * themselves).
 */
export class McpClient {
  readonly #baseUrl: string;
  readonly #auth: StudioAiTokenSource | undefined;
  readonly #clientName: string;
  readonly #clientVersion: string;
  readonly #workflowView: string | undefined;
  readonly #apiKey: string | undefined;
  readonly #fetchImpl: typeof fetch;
  #sessionId: string | undefined;
  #initializeResult: McpInitializeResult | undefined;
  #initializing: McpInitialization | undefined;

  public constructor(options: McpClientOptions = {}) {
    if (options.apiKey && options.auth) {
      throw new Error("Configure exactly one MCP authentication scheme.");
    }
    this.#baseUrl = options.baseUrl ?? "/api";
    this.#auth = options.auth;
    this.#apiKey = options.apiKey;
    this.#clientName = options.clientName ?? "honua-sdk-js";
    this.#clientVersion = options.clientVersion ?? "0.0.0";
    this.#workflowView = options.workflowView;
    // Bound to globalThis: calling `this.#fetchImpl(...)` below invokes it
    // with `this` = the McpClient instance (private-field method-call
    // semantics), and browser `fetch` is receiver-sensitive — an unbound
    // reference called with a `this` other than `window` throws
    // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`.
    // Only the DEFAULT needs this; a caller-supplied `fetchImpl` (tests) is
    // used exactly as given.
    this.#fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /** The `Mcp-Session-Id` this client was bound to on `initialize`, or `undefined` before the first call. */
  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** The result of the last (or in-flight) `initialize` call — `protocolVersion`/`serverInfo`/`capabilities`. */
  public get serverInfo(): McpInitializeResult | undefined {
    return this.#initializeResult;
  }

  /**
   * Runs the `initialize` handshake, capturing the `Mcp-Session-Id` response
   * header for every later call. Safe to call more than once — concurrent
   * callers share one in-flight request; a session already established is NOT
   * re-initialized. Each caller can cancel independently. The shared request
   * is aborted when every waiter has cancelled or the session is reset.
   */
  public async initialize(signal?: AbortSignal): Promise<McpInitializeResult> {
    if (signal?.aborted) {
      throw new McpTransportError(`Could not reach the MCP endpoint at ${this.#baseUrl}/mcp.`, signal.reason);
    }
    if (this.#initializeResult) return this.#initializeResult;
    if (!this.#initializing) {
      const controller = new AbortController();
      const state: McpInitialization = { controller, promise: this.#doInitialize(controller.signal), waiters: 0 };
      this.#initializing = state;
      const clear = (): void => {
        if (this.#initializing === state) this.#initializing = undefined;
      };
      void state.promise.then(clear, clear);
    }
    const state = this.#initializing;
    return new Promise<McpInitializeResult>((resolve, reject) => {
      state.waiters += 1;
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        state.controller.signal.removeEventListener("abort", abortShared);
        state.waiters -= 1;
        if (state.waiters === 0 && this.#initializing === state && !this.#initializeResult) {
          this.#initializing = undefined;
          state.controller.abort();
        }
        return true;
      };
      const abort = (): void => {
        if (finish()) {
          reject(new McpTransportError(`Could not reach the MCP endpoint at ${this.#baseUrl}/mcp.`, signal?.reason));
        }
      };
      const abortShared = (): void => {
        if (finish()) {
          reject(
            new McpTransportError(
              `Could not reach the MCP endpoint at ${this.#baseUrl}/mcp.`,
              state.controller.signal.reason,
            ),
          );
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      state.controller.signal.addEventListener("abort", abortShared, { once: true });
      if (signal?.aborted) abort();
      state.promise.then(
        (result) => {
          if (finish()) resolve(result);
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  async #doInitialize(signal: AbortSignal | undefined): Promise<McpInitializeResult> {
    const result = await this.#send<McpInitializeResult>(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.#clientName, version: this.#clientVersion },
        ...(this.#workflowView !== undefined ? { _meta: { "honua.io/workflow-view": this.#workflowView } } : {}),
      },
      signal,
    );
    signal?.throwIfAborted();
    this.#initializeResult = result;
    return result;
  }

  /** `tools/list` — paginated per MCP 2025-03-26; pass `cursor` back from a prior `nextCursor` to fetch the next page. */
  public async listTools(params: McpToolsListParams = {}, signal?: AbortSignal): Promise<McpToolsListResult> {
    await this.initialize(signal);
    return this.#send<McpToolsListResult>("tools/list", params, signal);
  }

  /**
   * Walks `tools/list` to completion, following `nextCursor` until the server
   * stops issuing one, and returns every descriptor in server order.
   *
   * The loop is bounded twice, because "follow the cursor until it stops" is an
   * unbounded instruction handed to a remote party:
   *
   *  - **Page cap** ({@link McpListAllToolsOptions.maxPages}, default
   *    {@link MCP_DEFAULT_MAX_TOOL_LIST_PAGES}) — a server that keeps issuing
   *    fresh cursors forever cannot spin this client forever.
   *  - **Repeat-cursor guard** — a server that hands back a cursor it already
   *    handed back is looping; that is caught on the first repeat instead of
   *    burning the whole page budget on the same page.
   *
   * Both bounds throw {@link McpProtocolError} rather than silently returning a
   * truncated catalog, because a partial tool catalog is indistinguishable from
   * a narrower server authorization and must never be mistaken for one.
   *
   * Neither bound helps against a server that accepts a page request and never
   * answers it, so {@link McpListAllToolsOptions.signal} is threaded into the
   * handshake and every page — that is the only bound on a request in flight.
   */
  public async listAllTools(options: McpListAllToolsOptions = {}): Promise<McpToolListing> {
    const maxPages = options.maxPages ?? MCP_DEFAULT_MAX_TOOL_LIST_PAGES;
    const tools: McpToolDescriptor[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let metadata: Record<string, unknown> | undefined;

    while (pages < maxPages) {
      const page = await this.listTools(
        {
          ...(options.view !== undefined ? { view: options.view } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        },
        options.signal,
      );
      pages += 1;
      if (page._meta) {
        if (metadata && stableMeta(metadata) !== stableMeta(page._meta)) {
          throw new McpProtocolError(
            `MCP tools/list changed view metadata after ${pages} pages; refusing a partial catalog.`,
            JSON_RPC_INTERNAL_ERROR,
          );
        }
        metadata = page._meta;
      }
      if (Array.isArray(page.tools)) tools.push(...page.tools);

      const next = page.nextCursor;
      if (next === undefined || next === "") {
        return { tools, pages, ...(metadata ? { metadata } : {}) };
      }
      if (seenCursors.has(next)) {
        throw new McpProtocolError(
          `MCP tools/list repeated pagination cursor "${next}" after ${pages} pages; refusing to loop.`,
          JSON_RPC_INTERNAL_ERROR,
        );
      }
      seenCursors.add(next);
      cursor = next;
    }

    throw new McpProtocolError(
      `MCP tools/list did not terminate within ${maxPages} pages; refusing to page further.`,
      JSON_RPC_INTERNAL_ERROR,
    );
  }

  /**
   * Subscribes to the server's standalone `GET /mcp` SSE stream and reports
   * every server-initiated notification — `notifications/tools/list_changed`
   * above all — until the subscription is closed, the server declines the
   * channel, or the reconnect budget runs out.
   *
   * The returned stream reads this client's session id on every connect
   * attempt, so a {@link resetSession} plus re-handshake is carried
   * automatically. Call this only after (or alongside) a request that has
   * established a session: an un-handshaken client sends no `Mcp-Session-Id`,
   * which a session-enforcing server rejects.
   *
   * Nothing else on this client starts a stream — a consumer that never calls
   * this never opens one.
   */
  public watchNotifications(options: McpNotificationWatchOptions = {}): McpNotificationStream {
    return new McpNotificationStream({
      baseUrl: this.#baseUrl,
      ...(this.#auth ? { auth: this.#auth } : {}),
      fetchImpl: this.#fetchImpl,
      sessionId: () => this.#sessionId,
      protocolVersion: MCP_PROTOCOL_VERSION,
      ...options,
    }).start();
  }

  /**
   * Drops the negotiated `Mcp-Session-Id` and `initialize` result so the next
   * call re-handshakes. Callers use this to reconnect — a new server session
   * may advertise a different tool catalog, so whoever calls this is
   * responsible for invalidating anything derived from the old one
   * (`StudioAgentSession.reconnect` invalidates its tool catalog here).
   */
  public resetSession(): void {
    this.#initializing?.controller.abort();
    this.#initializing = undefined;
    this.#sessionId = undefined;
    this.#initializeResult = undefined;
  }

  /**
   * `resources/read`. Binary artifacts come back as base64 `blob` contents.
   * A text chunk may not be valid JSON on its own: echo nextCursor in options
   * and concatenate text per URI before parsing the complete document.
   */
  public async readResource(uri: string, options: McpReadResourceOptions = {}): Promise<McpReadResourceResult> {
    await this.initialize(options.signal);
    return this.#send(
      "resources/read",
      {
        uri,
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
      },
      options.signal,
    );
  }

  /**
   * `tools/call`. Throws {@link McpToolError} when the tool reported failure
   * (`result.isError: true`) — never returns a result the caller has to
   * remember to check `.isError` on.
   */
  public async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolsCallResult> {
    await this.initialize();
    const params: McpToolsCallParams = { name, arguments: args };
    const result = await this.#send<McpToolsCallResult>("tools/call", params);
    if (result.isError) {
      throw parseToolError(result, name);
    }
    return result;
  }

  async #send<TResult>(method: string, params: unknown, signal?: AbortSignal): Promise<TResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    if (this.#apiKey) headers["x-api-key"] = this.#apiKey;
    if (this.#auth) {
      const token = await this.#auth.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }

    const body = JSON.stringify({ jsonrpc: "2.0", id: nextRequestId(), method, params });

    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}/mcp`, {
        method: "POST",
        headers,
        body,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new McpTransportError(`Could not reach the MCP endpoint at ${this.#baseUrl}/mcp.`, error);
    }

    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader && !signal?.aborted) this.#sessionId = sessionHeader;

    if (!response.ok && response.status !== 200) {
      // A handful of honua-server error paths (unauthenticated, malformed
      // envelope) return a non-2xx with no JSON-RPC body at all — surface
      // those as transport failures rather than trying to parse a body that
      // isn't there. A well-formed JSON-RPC error (tool rejected, invalid
      // params) is always HTTP 200 per the spec and is handled below.
      let detail: string | undefined;
      try {
        detail = await response.text();
      } catch {
        detail = undefined;
      }
      throw new McpTransportError(
        `MCP endpoint responded ${response.status} for "${method}"${detail ? `: ${detail}` : "."}`,
      );
    }

    const envelope = await this.#parseResponseBody(response, method);
    if (isJsonRpcErrorResponse(envelope)) {
      throw new McpProtocolError(envelope.error.message, envelope.error.code, envelope.error.data);
    }
    return envelope.result as TResult;
  }

  async #parseResponseBody(response: Response, method: string): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (contentType.includes("text/event-stream")) {
      // A one-shot SSE frame carrying the same JSON-RPC envelope (see the
      // module doc's "Transport response shape" note) — extract the first
      // `data:` line's JSON payload.
      const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) {
        throw new McpTransportError(`MCP endpoint returned an empty SSE response for "${method}".`);
      }
      return JSON.parse(dataLine.slice("data:".length).trim()) as JsonRpcResponse;
    }
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch (error) {
      throw new McpTransportError(`MCP endpoint returned a malformed response for "${method}".`, error);
    }
  }
}

/**
 * Builds an {@link McpToolError} from a `tools/call` result reporting
 * failure. Reads `result.structuredContent` as `{ code, message }` first
 * (this client's primary interpretation of the documented error contract);
 * falls back to parsing the first text content block as JSON with the same
 * shape; falls back to `code: "unknown"` with the first text block's raw text
 * (or a generic message) rather than ever throwing an unstructured error for
 * a structured failure contract.
 */
function stableMeta(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

function parseToolError(result: McpToolsCallResult, toolName: string): McpToolError {
  const structured = result.structuredContent;
  if (structured && typeof structured.code === "string" && typeof structured.message === "string") {
    return new McpToolError(structured.message, structured.code, toolName, structured);
  }
  const firstText = result.content?.find((block) => block.type === "text")?.text;
  if (firstText) {
    try {
      const parsed = JSON.parse(firstText) as Record<string, unknown>;
      if (typeof parsed.code === "string" && typeof parsed.message === "string") {
        return new McpToolError(parsed.message, parsed.code, toolName, parsed);
      }
    } catch {
      // Not JSON — fall through to the raw-text case below.
    }
    return new McpToolError(firstText, "unknown", toolName, result);
  }
  return new McpToolError(`Tool "${toolName}" failed with no structured error detail.`, "unknown", toolName, result);
}
