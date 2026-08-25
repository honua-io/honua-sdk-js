/**
 * A minimal MCP client over honua-server's `/mcp` HTTP transport. JSON-RPC
 * 2.0 over `POST /mcp`: `initialize` handshake, `tools/list`, `tools/call` —
 * nothing else (no resources/prompts/sampling; a Studio tool plane never
 * needs them).
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
 *    host — this is neither. It only ever issues three method calls against
 *    one already-known HTTP endpoint.
 *  - It pulls in `zod` (schema validation this surface does not otherwise
 *    need) and a `content-type`/`raw-body`/`eventsource-parser` chain sized
 *    for its own SSE + stdio transports, none of which are exercised by a
 *    request/response POST client.
 *  - This surface already hand-rolls an equally protocol-sensitive streaming
 *    client (`./sse-transport.ts` + `./sse-parser.ts`) rather than reach for
 *    a dependency — the same call applies here, and the surface is smaller
 *    (three JSON-RPC methods, no streaming to parse in the common case).
 *  - Bundle size matters: `@honua/sdk-js` ships to a browser tab and is
 *    budgeted per entrypoint, and the SDK is not tree-shake-friendly against
 *    a three-method usage.
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
 * both; this client never opens the optional standalone `GET /mcp` push
 * stream (off by default server-side, and irrelevant to a request/response
 * tool call).
 *
 * @module
 */
import type { StudioAiTokenSource } from "./ai-contract.js";
import { McpProtocolError, McpToolError, McpTransportError } from "./mcp-errors.js";
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
}

/** Every descriptor `tools/list` advertised, plus how many pages it took. */
export interface McpToolListing {
  readonly tools: readonly McpToolDescriptor[];
  readonly pages: number;
}

export interface McpClientOptions {
  /** The `/mcp` endpoint's base — the client POSTs to `${baseUrl}/mcp`. @default "/api" */
  readonly baseUrl?: string;
  readonly auth?: StudioAiTokenSource;
  /** Advertised in `initialize`'s `clientInfo`. */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

let requestSeq = 0;
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
  readonly #fetchImpl: typeof fetch;
  #sessionId: string | undefined;
  #initializeResult: McpInitializeResult | undefined;
  #initializing: Promise<McpInitializeResult> | undefined;

  public constructor(options: McpClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "/api";
    this.#auth = options.auth;
    this.#clientName = options.clientName ?? "honua-sdk-js";
    this.#clientVersion = options.clientVersion ?? "0.0.0";
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
   * re-initialized.
   */
  public async initialize(signal?: AbortSignal): Promise<McpInitializeResult> {
    if (this.#initializeResult) return this.#initializeResult;
    if (!this.#initializing) {
      this.#initializing = this.#doInitialize(signal).finally(() => {
        this.#initializing = undefined;
      });
    }
    return this.#initializing;
  }

  async #doInitialize(signal: AbortSignal | undefined): Promise<McpInitializeResult> {
    const result = await this.#send<McpInitializeResult>(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.#clientName, version: this.#clientVersion },
      },
      signal,
    );
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

    while (pages < maxPages) {
      const page = await this.listTools(cursor === undefined ? {} : { cursor }, options.signal);
      pages += 1;
      if (Array.isArray(page.tools)) tools.push(...page.tools);

      const next = page.nextCursor;
      if (next === undefined || next === "") {
        return { tools, pages };
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
   * Drops the negotiated `Mcp-Session-Id` and `initialize` result so the next
   * call re-handshakes. Callers use this to reconnect — a new server session
   * may advertise a different tool catalog, so whoever calls this is
   * responsible for invalidating anything derived from the old one
   * (`StudioAgentSession.reconnect` invalidates its tool catalog here).
   */
  public resetSession(): void {
    this.#sessionId = undefined;
    this.#initializeResult = undefined;
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
    if (sessionHeader) this.#sessionId = sessionHeader;

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
