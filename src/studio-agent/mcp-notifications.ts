/**
 * The server-to-client notification channel: MCP's optional standalone
 * `GET /mcp` SSE stream.
 *
 * `POST /mcp` is request/response — the server can only ever answer something
 * this client asked for. Everything the server wants to say *unprompted*
 * (`notifications/tools/list_changed` above all) travels the other stream the
 * Streamable HTTP transport defines: a plain `GET` on the same URL with
 * `Accept: text/event-stream`, carrying JSON-RPC notification envelopes as SSE
 * frames until one side hangs up.
 *
 * ## Why this is a client-side change and not a server one
 *
 * Nothing about the channel needs new server surface. The reference
 * `StreamableHTTPClientTransport`
 * (`@modelcontextprotocol/sdk/client/streamableHttp`, which this repo's own
 * `mcp/src/proxy.ts` connects upstream with) opens it with exactly a
 * `fetch(url, { method: "GET", headers: { accept: "text/event-stream",
 * "mcp-session-id": …, "last-event-id": … } })` — the same three inputs
 * {@link McpClient} already holds. That is why the stdio proxy can forward
 * `list_changed` upstream today: its transport is subscribed to this stream.
 * A server that does not offer it answers `405 Method Not Allowed`, which the
 * spec designates as the "no push channel here" reply — handled below as a
 * terminal, non-error {@link McpNotificationStreamStatus.unsupported} outcome
 * rather than something to retry.
 *
 * ## Bounds
 *
 * "Subscribe until the server stops talking" is an unbounded instruction
 * handed to a remote party, so the loop is bounded three ways:
 *
 *  - **Reconnect budget** ({@link McpNotificationWatchOptions.maxReconnectAttempts})
 *    — a server that accepts the `GET` and immediately drops it cannot spin
 *    this client forever; the stream ends `failed` instead.
 *  - **Exponential backoff** between attempts, capped by
 *    {@link McpNotificationWatchOptions.maxReconnectDelayMs}.
 *  - **A flap guard.** The attempt counter resets only when a connection
 *    proved itself — it delivered at least one frame, or stayed open at least
 *    {@link McpNotificationWatchOptions.stableStreamMs}. Without that, a
 *    server that accepts every `GET` and EOFs instantly would reset the budget
 *    on each cycle and the budget would bound nothing.
 *
 * Cancellation is real teardown, not "stop listening": {@link
 * McpNotificationStream.close} (and the caller's `signal`) aborts the in-flight
 * `fetch`, so the HTTP request itself ends rather than being left to the host's
 * connection pool.
 *
 * @experimental Tracks MCP's Streamable HTTP notification channel.
 *
 * @module
 */

import type { StudioAiTokenSource } from "./ai-contract.js";
import { McpTransportError } from "./mcp-errors.js";
import { SseFrameParser } from "./sse-parser.js";

/** The notification a server sends when its `tools/list` catalog changed. */
export const MCP_TOOL_LIST_CHANGED_NOTIFICATION = "notifications/tools/list_changed";

/** HTTP statuses that mean "this endpoint has no `GET` push channel" — terminal, and not a failure. */
const UNSUPPORTED_STATUSES = new Set([405, 501]);

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_BACKOFF_FACTOR = 2;

/**
 * Lifecycle of one subscription.
 *
 * `unsupported`, `failed`, and `closed` are terminal — the stream never leaves
 * them, and a consumer that wants another subscription opens a new one.
 */
export type McpNotificationStreamStatus =
  /** Constructed, not yet started. */
  | "idle"
  /** The first `GET` is in flight. */
  | "connecting"
  /** Subscribed; frames are being read. */
  | "open"
  /** The stream dropped; a backoff delay is running before the next attempt. */
  | "reconnecting"
  /** The server answered `405`/`501`: it offers no `GET` notification stream. Terminal. */
  | "unsupported"
  /** The reconnect budget was exhausted. Terminal. */
  | "failed"
  /** Torn down by {@link McpNotificationStream.close} or the caller's signal. Terminal. */
  | "closed";

function isTerminal(status: McpNotificationStreamStatus): boolean {
  return status === "unsupported" || status === "failed" || status === "closed";
}

/** One server-initiated JSON-RPC notification (a message with a `method` and no `id`). */
export interface McpNotification {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface McpNotificationWatchOptions {
  /** Called for every server-initiated notification. Never called after a terminal status. */
  readonly onNotification?: (notification: McpNotification) => void;
  /** Observes every lifecycle transition, including the terminal one. */
  readonly onStatusChange?: (status: McpNotificationStreamStatus, detail?: string) => void;
  /**
   * Observes recoverable failures — a dropped connection, a non-2xx `GET`, a
   * malformed frame. A stream that is still retrying reports here and keeps
   * going; the terminal outcome arrives through {@link onStatusChange}.
   */
  readonly onError?: (error: unknown) => void;
  /** Tears the subscription down — the in-flight `GET` is aborted, not merely ignored. */
  readonly signal?: AbortSignal;
  /** Reconnect budget. `0` never reconnects. @default 5 */
  readonly maxReconnectAttempts?: number;
  /** @default 1000 */
  readonly initialReconnectDelayMs?: number;
  /** @default 30000 */
  readonly maxReconnectDelayMs?: number;
  /** @default 2 */
  readonly reconnectBackoffFactor?: number;
  /**
   * How long a connection must stay open, with no frames at all, before it
   * counts as healthy and resets the reconnect budget. See the module doc's
   * flap guard. @default maxReconnectDelayMs
   */
  readonly stableStreamMs?: number;
}

export interface McpNotificationStreamOptions extends McpNotificationWatchOptions {
  /** The `/mcp` endpoint's base — the stream opens `GET ${baseUrl}/mcp`. @default "/api" */
  readonly baseUrl?: string;
  readonly auth?: StudioAiTokenSource;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Reads the LIVE `Mcp-Session-Id` on every connect attempt — a function, not
   * a value, because a reconnect after the owning client re-handshook must
   * carry the new session, never the one captured when the watch started.
   */
  readonly sessionId?: () => string | undefined;
  /** Sent as `mcp-protocol-version` when supplied. */
  readonly protocolVersion?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * A subscription to one MCP server's standalone `GET /mcp` SSE stream, with
 * bounded reconnection. Construct through {@link McpClient.watchNotifications}
 * so the endpoint, credentials, and live session id come from the client that
 * negotiated them.
 */
export class McpNotificationStream {
  readonly #baseUrl: string;
  readonly #auth: StudioAiTokenSource | undefined;
  readonly #fetchImpl: typeof fetch;
  readonly #readSessionId: (() => string | undefined) | undefined;
  readonly #protocolVersion: string | undefined;
  readonly #onNotification: ((notification: McpNotification) => void) | undefined;
  readonly #onStatusChange: ((status: McpNotificationStreamStatus, detail?: string) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #maxReconnectAttempts: number;
  readonly #initialReconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #reconnectBackoffFactor: number;
  readonly #stableStreamMs: number;
  readonly #controller = new AbortController();
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort = (): void => this.close();
  #status: McpNotificationStreamStatus = "idle";
  #lastEventId: string | undefined;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #wakeRetry: (() => void) | undefined;
  #loop: Promise<void> = Promise.resolve();

  public constructor(options: McpNotificationStreamOptions) {
    this.#baseUrl = options.baseUrl ?? "/api";
    this.#auth = options.auth;
    // Bound to globalThis for the same reason `McpClient` binds it: browser
    // `fetch` is receiver-sensitive and a private-field call passes the
    // instance as `this`.
    this.#fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.#readSessionId = options.sessionId;
    this.#protocolVersion = options.protocolVersion;
    this.#onNotification = options.onNotification;
    this.#onStatusChange = options.onStatusChange;
    this.#onError = options.onError;
    this.#maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS);
    this.#initialReconnectDelayMs = Math.max(0, options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS);
    this.#maxReconnectDelayMs = Math.max(0, options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS);
    this.#reconnectBackoffFactor = Math.max(1, options.reconnectBackoffFactor ?? DEFAULT_RECONNECT_BACKOFF_FACTOR);
    this.#stableStreamMs = Math.max(0, options.stableStreamMs ?? this.#maxReconnectDelayMs);
    this.#externalSignal = options.signal;
  }

  public get status(): McpNotificationStreamStatus {
    return this.#status;
  }

  /** True once the stream reached a terminal status and will never reconnect. */
  public get terminated(): boolean {
    return isTerminal(this.#status);
  }

  /** The last SSE `id:` seen, replayed as `Last-Event-ID` on the next connect attempt. */
  public get lastEventId(): string | undefined {
    return this.#lastEventId;
  }

  /** Resolves when the subscription reaches a terminal status. Never rejects. */
  public get done(): Promise<void> {
    return this.#loop;
  }

  /** Starts the subscription. Idempotent — a second call is a no-op. */
  public start(): this {
    if (this.#status !== "idle") return this;
    if (this.#externalSignal?.aborted) {
      this.#setStatus("closed", "The caller's signal was already aborted.");
      return this;
    }
    this.#externalSignal?.addEventListener("abort", this.#onExternalAbort, { once: true });
    this.#loop = this.#run();
    return this;
  }

  /**
   * Tears the subscription down: aborts the in-flight `GET` (and any pending
   * backoff delay) and moves to `closed`. Idempotent, and safe to call from a
   * notification handler.
   */
  public close(): void {
    if (isTerminal(this.#status)) return;
    this.#setStatus("closed");
    this.#teardown();
  }

  #teardown(): void {
    this.#externalSignal?.removeEventListener("abort", this.#onExternalAbort);
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#wakeRetry?.();
    this.#wakeRetry = undefined;
    if (!this.#controller.signal.aborted) this.#controller.abort();
  }

  #setStatus(status: McpNotificationStreamStatus, detail?: string): void {
    // Terminal is terminal: a late failure from an aborted `fetch` must not
    // reopen a stream the consumer already closed.
    if (isTerminal(this.#status)) return;
    this.#status = status;
    try {
      this.#onStatusChange?.(status, detail);
    } catch {
      // A consumer's observer must never break the stream it observes.
    }
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Same contract as `#setStatus`: observers cannot break the stream.
    }
  }

  async #run(): Promise<void> {
    while (!isTerminal(this.#status)) {
      this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting");

      let response: Response | "unsupported";
      try {
        response = await this.#open();
      } catch (error) {
        if (isTerminal(this.#status)) break;
        this.#report(error);
        if (!(await this.#waitForRetry())) return;
        continue;
      }

      if (response === "unsupported") {
        this.#setStatus("unsupported", `${this.#baseUrl}/mcp offers no GET notification stream.`);
        this.#teardown();
        return;
      }

      this.#setStatus("open");
      const openedAt = Date.now();
      // Counted through a shared object rather than a return value: a stream
      // that delivered frames and THEN errored still proved itself, and a
      // thrown `#consume` would have discarded a returned count.
      const delivered = { frames: 0 };
      try {
        await this.#consume(response, delivered);
      } catch (error) {
        if (isTerminal(this.#status)) break;
        this.#report(error);
      }
      if (isTerminal(this.#status)) break;

      // Flap guard (see the module doc): only a connection that proved itself
      // clears the reconnect budget.
      if (delivered.frames > 0 || Date.now() - openedAt >= this.#stableStreamMs) this.#attempt = 0;

      if (!(await this.#waitForRetry())) return;
    }
    this.#setStatus("closed");
    this.#teardown();
  }

  /** Opens the `GET` stream. Returns `"unsupported"` for the spec's "no push channel" reply. */
  async #open(): Promise<Response | "unsupported"> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    const sessionId = this.#readSessionId?.();
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (this.#protocolVersion) headers["mcp-protocol-version"] = this.#protocolVersion;
    if (this.#lastEventId) headers["last-event-id"] = this.#lastEventId;
    if (this.#auth) {
      const token = await this.#auth.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}/mcp`, {
        method: "GET",
        headers,
        signal: this.#controller.signal,
      });
    } catch (error) {
      throw new McpTransportError(`Could not open the MCP notification stream at ${this.#baseUrl}/mcp.`, error);
    }

    if (UNSUPPORTED_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return "unsupported";
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpTransportError(`MCP notification stream responded ${response.status} to GET ${this.#baseUrl}/mcp.`);
    }
    if (!response.body) {
      throw new McpTransportError(`MCP notification stream at ${this.#baseUrl}/mcp had no body to read.`);
    }
    return response;
  }

  /** Reads frames until the server ends the stream, counting them into `delivered`. */
  async #consume(response: Response, delivered: { frames: number }): Promise<void> {
    // `#open` rejects a bodyless response, so this is a narrowing, not a guess.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          delivered.frames += 1;
          this.#handleFrame(frame.id, frame.data);
        }
        if (isTerminal(this.#status)) break;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released (stream errored/closed) — fine to ignore.
      }
    }
  }

  #handleFrame(id: string | undefined, data: string): void {
    // An `id:` field with an empty value is how the SSE spec says a server
    // clears its event cursor. Treating `""` as "no id present" kept the old
    // cursor, so the next reconnect replayed from an event the server had
    // explicitly retired. `undefined` (no field at all) still means "leave the
    // cursor alone"; `""` means "forget it".
    if (id !== undefined) this.#lastEventId = id === "" ? undefined : id;
    if (!data) return;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      this.#report(new McpTransportError("MCP notification stream delivered a malformed JSON-RPC frame.", error));
      return;
    }

    for (const message of Array.isArray(payload) ? payload : [payload]) {
      const record = asRecord(message);
      if (!record || typeof record.method !== "string") continue;
      // A message carrying an `id` is a server-to-client REQUEST (sampling,
      // roots, elicitation), not a notification. This client declares none of
      // those capabilities, so such a request is ignored rather than answered.
      if (record.id !== undefined && record.id !== null) continue;
      const params = asRecord(record.params);
      try {
        this.#onNotification?.({ method: record.method, ...(params ? { params } : {}) });
      } catch (error) {
        this.#report(error);
      }
    }
  }

  /** Applies the reconnect budget and backoff. `false` means the loop must stop. */
  async #waitForRetry(): Promise<boolean> {
    if (this.#attempt >= this.#maxReconnectAttempts) {
      this.#setStatus(
        "failed",
        `MCP notification stream gave up after ${this.#maxReconnectAttempts} reconnect attempt(s) against ${this.#baseUrl}/mcp.`,
      );
      this.#teardown();
      return false;
    }
    const delay = Math.min(
      this.#initialReconnectDelayMs * this.#reconnectBackoffFactor ** this.#attempt,
      this.#maxReconnectDelayMs,
    );
    this.#attempt += 1;
    this.#setStatus("reconnecting", `Reconnecting in ${Math.round(delay)}ms (attempt ${this.#attempt}).`);
    await this.#sleep(delay);
    return !isTerminal(this.#status);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.#retryTimer = undefined;
        this.#wakeRetry = undefined;
        resolve();
      };
      this.#wakeRetry = finish;
      this.#retryTimer = setTimeout(finish, ms);
    });
  }
}
