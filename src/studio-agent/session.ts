/**
 * `StudioAgentSession` — one agent conversation that drives a live map.
 *
 * The session owns the turn loop that the Studio surface needs and nothing
 * else: stream a chat turn through honua-server's provider-neutral AI proxy,
 * dispatch the tool calls the model emits, feed the results back, repeat
 * until the model stops asking for tools.
 *
 * Two tool planes, one vocabulary:
 *
 *  - **Local runtime verbs** — the camelCase `@honua/sdk-js/agent-tools`
 *    vocabulary (`setViewport`, `setFilter`, `bindInteraction`, …) executed
 *    against the caller's own runtime through a {@link HonuaAiMapKit}, under
 *    that kit's policy (allowActions / dry-run / allowed sources / audit).
 *  - **Draft-mutating composition tools** — the Studio MCP tools the *server*
 *    advertises through `tools/list`, routed through {@link McpClient} to the
 *    server that owns the composition draft.
 *
 * **The composition plane is discovered, not hard-coded.** On the first
 * `chat()` the session pages `tools/list` to completion, applies its
 * {@link StudioToolPolicy}, and merges the approved descriptors into the tool
 * set it advertises. Selection requires a positive signal — server-owned
 * family/view classification, or an explicit configured allowlist — never a
 * `honua_studio_` name prefix; `./tool-catalog.ts` documents why and what the
 * server contract (honua-server#3695) looks like. The catalog is cached and
 * invalidated by {@link StudioAgentSession.refreshTools} and
 * {@link StudioAgentSession.reconnect}. Runtime-kit tools always win a name
 * collision, so a server can never shadow a local runtime verb.
 *
 * **Opt in to `watchToolListChanged` and the catalog also refreshes itself.**
 * A server that adds, retires, or re-authorizes a Studio tool mid-session
 * announces it with `notifications/tools/list_changed`, which arrives on the
 * standalone `GET /mcp` SSE stream rather than on any `POST` answer. With the
 * option set the session subscribes after its first successful discovery pass
 * and re-runs discovery on every such notification; left unset (the default)
 * no stream is ever opened, so an existing consumer's network behavior is
 * unchanged. {@link StudioAgentSession.close} and
 * {@link StudioAgentSession.reconnect} tear the subscription down.
 *
 * Both planes are serialized through one promise queue, so a multi-tool
 * assistant turn applies strictly in order and two calls never race the same
 * draft generation. A `failed_precondition` from a composition tool triggers
 * exactly one reload (`honua_studio_get_draft`) + retry against the fresh
 * generation — the same semantics honua-studio's `ToolCallOrchestrator`
 * (`src/mcp/orchestrator.ts`) established; a second failure is surfaced, not
 * retried again.
 *
 * **The session never throws mid-stream.** Transport failure, provider error
 * events, tool rejection, and cancellation are all outcomes of
 * {@link StudioAgentSession.chat}, reported on the returned turn — a host
 * never has to wrap the call in its own try/catch to keep a UI responsive.
 *
 * @experimental Tracks honua-server's Studio AI proxy and `honua_studio_*`
 * tool contracts; both may gain fields.
 *
 * @module
 */
import {
  type HonuaAgentToolCall,
  type HonuaAgentToolDefinitionLike,
  type HonuaAgentToolResult,
  type HonuaAiMapKit,
  convertHonuaAgentToolDefinitions,
} from "../agent-tools/index.js";
import type {
  StudioAiCapabilitiesResponse,
  StudioAiCapability,
  StudioAiChatEvent,
  StudioAiChatMessage,
  StudioAiChatRequest,
  StudioAiStopReason,
  StudioAiTokenSource,
  StudioAiToolChoice,
  StudioAiToolDefinition,
  StudioAiTranscriptCertification,
} from "./ai-contract.js";
import { McpClient, type McpToolListing } from "./mcp-client.js";
import { isMcpGenerationConflict, isMcpToolError } from "./mcp-errors.js";
import {
  MCP_TOOL_LIST_CHANGED_NOTIFICATION,
  type McpNotificationStream,
  type McpNotificationStreamStatus,
  type McpNotificationWatchOptions,
} from "./mcp-notifications.js";
import {
  HONUA_STUDIO_MCP_TOOL_NAMES,
  type McpToolErrorCode,
  type McpToolsCallResult,
  type StudioMcpDraft,
} from "./mcp-protocol.js";
import { SseChatTransport, fetchStudioAiCapabilities } from "./sse-transport.js";
import { StudioToolCatalog, type StudioToolDiscoveryReport, type StudioToolPolicy } from "./tool-catalog.js";
import type { StudioAiTranscriptVerifier } from "./transcript-verifier.js";
import type { ChatTransport } from "./transport.js";

/** The live composition draft `honua_studio_*` calls are applied to. */
export interface StudioAgentDraftBinding {
  readonly draftId: string;
  readonly generation: number;
}

export interface StudioAgentSessionOptions {
  /** Exact candidate/action binding sent to the proxy for every tool-capable round. */
  readonly certification?: StudioAiTranscriptCertification;
  /** Independent verifier required before any model-selected tool is dispatched. */
  readonly transcriptVerifier?: StudioAiTranscriptVerifier;
  /** Base of the honua-server API — the session calls `${baseUrl}/v1/studio/ai/*` and `${baseUrl}/mcp`. @default "/api" */
  readonly baseUrl?: string;
  /** Bearer-token source. The model's own credentials never leave the server. */
  readonly auth?: StudioAiTokenSource;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** The local runtime tool plane. */
  readonly kit?: HonuaAiMapKit;
  /** Explicit tool definitions, when not supplying a `kit`. Merged with the kit's tools when both are present. */
  readonly tools?: ReadonlyArray<HonuaAgentToolDefinitionLike>;
  /** Explicit executor, when not supplying a `kit`. */
  readonly execute?: (call: HonuaAgentToolCall) => Promise<HonuaAgentToolResult>;
  /** Replaces the SSE transport. Supply a scripted transport to drive a session with no model. */
  readonly transport?: ChatTransport;
  /** Replaces the MCP client used for composition-tool routing. */
  readonly mcpClient?: McpClient;
  /**
   * Which server-advertised Studio descriptors this session may route and
   * advertise. Defaults approve the canonical server family in every view, keep
   * the allowlist empty, and use the deprecated
   * {@link HONUA_STUDIO_MCP_TOOL_NAMES} table as the migration-diagnostic
   * `required` baseline. See `./tool-catalog.ts`.
   */
  readonly studioTools?: StudioToolPolicy;
  /**
   * Skips `tools/list` discovery entirely. The session then advertises and
   * routes only its runtime-kit tools. Use for a host with no MCP endpoint.
   * @default false
   */
  readonly disableToolDiscovery?: boolean;
  /**
   * Subscribes to the server's `GET /mcp` notification stream after the first
   * successful discovery pass and re-runs discovery on every
   * `notifications/tools/list_changed`, so a catalog the server changes
   * mid-session does not go stale until the next `reconnect()`.
   *
   * Off by default: opening a second long-lived HTTP request is a network
   * behavior change no existing consumer asked for, and a server that offers
   * no such stream would be probed for nothing. When the server declines the
   * channel (`405`/`501`) the subscription ends `unsupported` and the session
   * carries on exactly as it does today.
   * @default false
   */
  readonly watchToolListChanged?: boolean;
  /**
   * Backoff, budget, and observer overrides for the
   * {@link watchToolListChanged} subscription. The session supplies
   * `onNotification` itself; everything else is passed through.
   */
  readonly toolListChangedWatch?: Omit<McpNotificationWatchOptions, "onNotification">;
  /**
   * Wall-clock bound on one `tools/list` discovery pass (handshake plus every
   * page). An MCP endpoint that accepts the request and never answers would
   * otherwise hold every `chat()` open forever, since `fetch` has no deadline
   * of its own. On expiry the pass fails like any other discovery failure: the
   * turn degrades to runtime-kit tools, the reason is reported on
   * {@link StudioAgentSession.toolDiscovery}, and the next turn retries.
   * `0` disables the bound.
   * @default 15000
   */
  readonly toolDiscoveryTimeoutMs?: number;
  /**
   * System prompt. A function is awaited once per `chat()` call, so a kit's
   * `systemPrompt()` re-reads live map context on every turn.
   */
  readonly system?: string | (() => string | Promise<string>);
  readonly provider?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly toolChoice?: StudioAiToolChoice;
  /** Composition draft `honua_studio_*` tools mutate. */
  readonly draft?: StudioAgentDraftBinding;
  /** Assistant rounds per `chat()` before the loop stops asking. @default 8 */
  readonly maxToolRounds?: number;
  /** Observes every streamed event and every tool dispatch. Never throws into the loop. */
  readonly onEvent?: (event: StudioAgentSessionEvent) => void;
}

export type StudioAgentSessionEvent =
  | { readonly type: "chat"; readonly event: StudioAiChatEvent }
  | { readonly type: "toolResult"; readonly result: StudioAgentToolDispatch }
  /** One completed `tools/list` discovery pass, including migration diagnostics. */
  | { readonly type: "toolDiscovery"; readonly report: StudioToolDiscoveryReport }
  /** A lifecycle transition of the opt-in `tools/list_changed` subscription. */
  | {
      readonly type: "toolWatch";
      readonly status: McpNotificationStreamStatus;
      readonly detail?: string;
    };

export type StudioAgentToolPlane = "runtime" | "composition";

/** The outcome of one dispatched tool call. */
export interface StudioAgentToolDispatch {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly plane: StudioAgentToolPlane | "unknown";
  readonly ok: boolean;
  /** The local executor's structured result, for `plane: "runtime"`. */
  readonly runtimeResult?: HonuaAgentToolResult;
  /** The draft the composition tool returned, for `plane: "composition"`. */
  readonly draft?: StudioMcpDraft;
  /** Set when the composition call succeeded only after one generation-conflict reload+retry. */
  readonly retriedAfterConflict?: boolean;
  /** Structured MCP tool error code, when the composition server supplied one. */
  readonly errorCode?: McpToolErrorCode;
  readonly errorMessage?: string;
  /** The exact JSON string sent back to the model as the `role: "tool"` message. */
  readonly content: string;
}

export type StudioAgentTurnStatus = "completed" | "cancelled" | "error" | "refused";

export interface StudioAgentTurn {
  readonly status: StudioAgentTurnStatus;
  /** Concatenated assistant text across every round of this turn. */
  readonly text: string;
  readonly toolCalls: ReadonlyArray<StudioAgentToolDispatch>;
  readonly events: ReadonlyArray<StudioAiChatEvent>;
  readonly stopReason?: StudioAiStopReason;
  /** Populated for `status: "error"` and `status: "refused"`. */
  readonly errorMessage?: string;
  /** Assistant rounds actually streamed. */
  readonly rounds: number;
}

export interface StudioAgentChatOptions {
  /** Cancels the turn mid-stream. The turn comes back `status: "cancelled"`, never thrown. */
  readonly signal?: AbortSignal;
  /** One-off override of the session's tool choice. */
  readonly toolChoice?: StudioAiToolChoice;
}

export interface StudioAgentSession {
  /** Conversation history so far, oldest first. */
  readonly messages: ReadonlyArray<StudioAiChatMessage>;
  /** The draft `honua_studio_*` tools mutate, with the latest generation the session has seen. */
  readonly draft: StudioAgentDraftBinding | undefined;
  /**
   * The tool definitions advertised to the proxy, in the
   * `{ name, description, inputSchema }` HTTP shape — runtime-kit tools, plus
   * every server-discovered composition tool this session's policy approved.
   * Before the first `chat()` (or {@link refreshTools}) this is the runtime-kit
   * set alone, since discovery is asynchronous and lazy.
   */
  readonly tools: ReadonlyArray<StudioAiToolDefinition>;
  /** The composition tool names discovery selected, or `[]` before it has run. */
  readonly compositionTools: ReadonlyArray<string>;
  /** The last completed discovery pass, or `undefined` before the first one. */
  readonly toolDiscovery: StudioToolDiscoveryReport | undefined;
  /**
   * Lifecycle status of the `tools/list_changed` subscription, or `undefined`
   * when `watchToolListChanged` is off or the subscription has not started.
   */
  readonly toolWatchStatus: McpNotificationStreamStatus | undefined;
  /** `GET /v1/studio/ai/capabilities`, fetched once and cached. */
  capabilities(): Promise<StudioAiCapabilitiesResponse>;
  /** The provider descriptor this session routes to, or `undefined` when it is not declared. */
  resolveProvider(): Promise<StudioAiCapability | undefined>;
  /** Runs one user turn to completion. Never throws. */
  chat(text: string, options?: StudioAgentChatOptions): Promise<StudioAgentTurn>;
  /**
   * Discards the cached tool catalog and re-runs `tools/list` discovery.
   * Call after a server `notifications/tools/list_changed`, or after a server
   * identity/profile/view revision change. Never throws — a failed pass leaves
   * the previous catalog in place and is reported on the returned report.
   */
  refreshTools(): Promise<StudioToolDiscoveryReport>;
  /**
   * Drops the negotiated MCP session and invalidates the tool catalog, so the
   * next turn re-handshakes and re-discovers. A reconnected principal may have
   * a different catalog; nothing derived from the old one survives.
   */
  reconnect(): void;
  /** Attaches (or re-attaches) the composition draft. */
  attachDraft(draft: StudioAgentDraftBinding): void;
  /** Clears the conversation history. Draft binding, tool catalog, and capabilities cache survive. */
  reset(): void;
  /**
   * Releases the session's long-lived resources — today, the opt-in
   * `tools/list_changed` subscription, whose in-flight `GET` is aborted rather
   * than left to the host's connection pool. Idempotent. A closed session can
   * still `chat()`; it simply stops watching for catalog changes.
   */
  close(): void;
}

const DEFAULT_MAX_TOOL_ROUNDS = 8;
/** Wall-clock bound on one `tools/list` discovery pass. See `toolDiscoveryTimeoutMs`. */
const DEFAULT_TOOL_DISCOVERY_TIMEOUT_MS = 15_000;

/** A turn the caller cancelled before it did any work. */
function cancelledTurn(): StudioAgentTurn {
  return { status: "cancelled", text: "", toolCalls: [], events: [], rounds: 0 };
}

export function createStudioAgentSession(options: StudioAgentSessionOptions): StudioAgentSession {
  return new StudioAgentSessionImpl(options);
}

class StudioAgentSessionImpl implements StudioAgentSession {
  readonly #options: StudioAgentSessionOptions;
  readonly #transport: ChatTransport;
  readonly #runtimeTools: ReadonlyArray<StudioAiToolDefinition>;
  readonly #runtimeToolNames: ReadonlySet<string>;
  readonly #execute: ((call: HonuaAgentToolCall) => Promise<HonuaAgentToolResult>) | undefined;
  readonly #messages: StudioAiChatMessage[] = [];
  /** Runtime tools plus the discovered composition tools. Recomputed on every discovery pass. */
  #tools: ReadonlyArray<StudioAiToolDefinition>;
  /** The routing authority for the composition plane. Empty until discovery runs. */
  #catalog: StudioToolCatalog = StudioToolCatalog.empty();
  #discovery: Promise<StudioToolDiscoveryReport> | undefined;
  #discoveryReport: StudioToolDiscoveryReport | undefined;
  /**
   * Bumped by every `refreshTools()`/`reconnect()`. A pass that started under
   * an older generation may not publish its result: `tools/list` already in
   * flight when a reconnect lands describes the PREVIOUS MCP session and
   * principal, and the reconnect contract says nothing derived from that
   * catalog survives.
   */
  #discoveryGeneration = 0;
  /** A `tools/list_changed` refresh is running; see `#refreshFromNotification`. */
  #toolRefreshInFlight = false;
  /** A notification arrived mid-refresh and owes us one trailing walk. */
  #toolRefreshPending = false;
  #mcpClient: McpClient | undefined;
  /** The opt-in `tools/list_changed` subscription. `undefined` until the first successful discovery pass. */
  #toolWatch: McpNotificationStream | undefined;
  /**
   * Set by {@link close} and never cleared. `reconnect()` also tears the
   * subscription down, but it means "resubscribe under the new session"; only
   * an explicit `close()` means "stop watching for good".
   */
  #toolWatchClosed = false;
  #draft: StudioAgentDraftBinding | undefined;
  #capabilities: Promise<StudioAiCapabilitiesResponse> | undefined;
  /** Serializes tool dispatch so a burst of tool calls applies strictly in order. */
  #queue: Promise<unknown> = Promise.resolve();

  public constructor(options: StudioAgentSessionOptions) {
    this.#options = options;
    this.#transport =
      options.transport ??
      new SseChatTransport({
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    this.#mcpClient = options.mcpClient;
    this.#draft = options.draft;

    const definitions: HonuaAgentToolDefinitionLike[] = [...(options.kit?.tools ?? []), ...(options.tools ?? [])];
    // The proxy forwards `tools` verbatim, and its HTTP tool shape is the same
    // `{ name, description, inputSchema }` triple the MCP exporter produces.
    this.#runtimeTools = convertHonuaAgentToolDefinitions(
      dedupeByName(definitions),
      "mcp",
    ) as ReadonlyArray<StudioAiToolDefinition>;
    this.#runtimeToolNames = new Set(this.#runtimeTools.map((tool) => tool.name));
    // Composition tools are discovered asynchronously on the first `chat()`;
    // until then the session advertises exactly what it can execute locally.
    this.#tools = this.#runtimeTools;
    this.#execute = options.execute ?? options.kit?.execute.bind(options.kit);
  }

  public get messages(): ReadonlyArray<StudioAiChatMessage> {
    return this.#messages;
  }

  public get draft(): StudioAgentDraftBinding | undefined {
    return this.#draft;
  }

  public get tools(): ReadonlyArray<StudioAiToolDefinition> {
    return this.#tools;
  }

  public get compositionTools(): ReadonlyArray<string> {
    return this.#catalog.names;
  }

  public get toolDiscovery(): StudioToolDiscoveryReport | undefined {
    return this.#discoveryReport;
  }

  public get toolWatchStatus(): McpNotificationStreamStatus | undefined {
    return this.#toolWatch?.status;
  }

  public attachDraft(draft: StudioAgentDraftBinding): void {
    this.#draft = draft;
  }

  public reset(): void {
    this.#messages.length = 0;
  }

  public refreshTools(): Promise<StudioToolDiscoveryReport> {
    this.#discoveryGeneration += 1;
    this.#discovery = undefined;
    return this.#ensureToolCatalog();
  }

  public close(): void {
    this.#toolWatchClosed = true;
    // The stream reference is kept, not dropped: a consumer reading
    // `toolWatchStatus` after `close()` should see `"closed"`, not `undefined`
    // ("never started").
    this.#toolWatch?.close();
  }

  public reconnect(): void {
    // The subscription is bound to the session id that is about to be dropped;
    // a stream left open would keep replaying the OLD principal's catalog
    // changes. Unlike `close()`, this is not a permanent stop — the next
    // successful discovery pass opens a fresh one under the new session.
    this.#toolWatch?.close();
    this.#toolWatch = undefined;
    this.#mcpClient?.resetSession();
    // Invalidate before clearing: a `tools/list` pass still in flight resolves
    // with the old session's descriptors, and must not repopulate what the two
    // lines below are clearing.
    this.#discoveryGeneration += 1;
    this.#discovery = undefined;
    this.#catalog = StudioToolCatalog.empty();
    this.#tools = this.#runtimeTools;
  }

  public capabilities(): Promise<StudioAiCapabilitiesResponse> {
    if (!this.#capabilities) {
      this.#capabilities = fetchStudioAiCapabilities({
        ...(this.#options.baseUrl !== undefined ? { baseUrl: this.#options.baseUrl } : {}),
        ...(this.#options.auth ? { auth: this.#options.auth } : {}),
        ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
      }).catch((error: unknown) => {
        // Do not cache a failure: a transient capabilities outage must not
        // permanently refuse every later turn.
        this.#capabilities = undefined;
        throw error;
      });
    }
    return this.#capabilities;
  }

  public async resolveProvider(): Promise<StudioAiCapability | undefined> {
    const capabilities = await this.capabilities();
    const wanted = this.#options.provider ?? capabilities.defaultProvider;
    return (
      capabilities.providers.find((provider) => provider.provider === wanted) ??
      capabilities.providers.find((provider) => provider.isDefault)
    );
  }

  // ── Tool discovery ──────────────────────────────────────────

  /**
   * Runs (or joins) one `tools/list` discovery pass. Concurrent callers share
   * the in-flight pass; a completed pass is cached until
   * {@link refreshTools}/{@link reconnect} invalidates it.
   *
   * A FAILED pass is never cached: a transient MCP outage must not permanently
   * strip the composition plane from every later turn. The previous catalog
   * (empty, on a first failure) stays in force so the session degrades to its
   * runtime-kit tools instead of throwing into the turn loop.
   */
  #ensureToolCatalog(): Promise<StudioToolDiscoveryReport> {
    if (this.#options.disableToolDiscovery) {
      this.#discovery ??= Promise.resolve(this.#publishDiscovery(StudioToolCatalog.empty().report(0)));
      return this.#discovery;
    }
    if (!this.#discovery) {
      const generation = this.#discoveryGeneration;
      this.#discovery = this.#discoverTools(generation).catch((error: unknown) => {
        const report = {
          ...this.#catalog.report(0),
          errorMessage: `Studio tool discovery failed: ${errorMessage(error)}`,
        };
        // A superseded pass reports its own failure to whoever was awaiting it,
        // but neither clears the newer pass's cache entry nor publishes over
        // the newer pass's report.
        if (generation !== this.#discoveryGeneration) return report;
        this.#discovery = undefined;
        return this.#publishDiscovery(report);
      });
    }
    return this.#discovery;
  }

  async #discoverTools(generation: number): Promise<StudioToolDiscoveryReport> {
    const listing = await this.#listAllToolsBounded();
    const policy = this.#options.studioTools ?? {};
    const catalog = StudioToolCatalog.fromDescriptors(listing.tools, {
      ...policy,
      // The historical hard-coded table is now only the migration-diagnostic
      // baseline: a name here the live server does not advertise (or the policy
      // does not approve) is REPORTED, never silently dropped, and never
      // routed on the strength of appearing in this list.
      required: policy.required ?? HONUA_STUDIO_MCP_TOOL_NAMES,
    });
    const report = catalog.report(listing.pages);
    if (generation !== this.#discoveryGeneration) {
      // `refreshTools()`/`reconnect()` superseded this pass while `tools/list`
      // was in flight. These descriptors belong to the previous MCP session and
      // principal, so they are returned to this pass's own awaiter and go no
      // further — the catalog, the advertised tool set, and the published
      // report all stay with the newer pass.
      return report;
    }
    this.#catalog = catalog;
    // Runtime tools first and unconditionally; a discovered descriptor sharing a
    // runtime verb's name is dropped rather than merged, so a server can never
    // shadow a local runtime tool the session executes itself.
    this.#tools = [
      ...this.#runtimeTools,
      ...catalog.toolDefinitions().filter((tool) => !this.#runtimeToolNames.has(tool.name)),
    ];
    const published = this.#publishDiscovery(report);
    // Only now: the subscription needs the `Mcp-Session-Id` this pass's
    // `initialize` negotiated, and a pass that failed or was superseded has no
    // session worth subscribing with.
    this.#ensureToolWatch();
    return published;
  }

  // ── tools/list_changed subscription ─────────────────────────

  /**
   * Opens the `GET /mcp` notification subscription, if this session opted in
   * and one is not already live. Idempotent, and safe to call from the
   * discovery path a `list_changed` notification itself triggers — a live
   * subscription short-circuits, so refreshing never restarts the stream that
   * asked for the refresh.
   */
  #ensureToolWatch(): void {
    if (!this.#options.watchToolListChanged) return;
    if (this.#options.disableToolDiscovery) return;
    if (this.#toolWatchClosed) return;
    if (this.#toolWatch && !this.#toolWatch.terminated) return;

    const overrides = this.#options.toolListChangedWatch ?? {};
    this.#toolWatch = this.#ensureMcpClient().watchNotifications({
      ...overrides,
      onStatusChange: (status, detail) => {
        this.#options.onEvent?.({ type: "toolWatch", status, ...(detail !== undefined ? { detail } : {}) });
        overrides.onStatusChange?.(status, detail);
      },
      onNotification: (notification) => {
        if (notification.method !== MCP_TOOL_LIST_CHANGED_NOTIFICATION) return;
        void this.#refreshFromNotification();
      },
    });
  }

  /**
   * Collapse a burst of `tools/list_changed` notifications into one trailing
   * refresh.
   *
   * `refreshTools()` invalidates the shared discovery promise and starts a
   * fresh paginated walk, so calling it per notification made a burst of N
   * notifications into N concurrent walks against the same server — a
   * thundering herd produced by the very mechanism meant to keep the catalog
   * cheap to maintain.
   *
   * At most two refreshes are ever in play: the one running, and one queued
   * behind it. A notification that arrives mid-refresh sets the pending flag
   * rather than starting a walk, because that refresh may have already read
   * the server state the notification is announcing; the trailing run is what
   * guarantees the final state is observed.
   */
  async #refreshFromNotification(): Promise<void> {
    if (this.#toolRefreshInFlight) {
      this.#toolRefreshPending = true;
      return;
    }
    this.#toolRefreshInFlight = true;
    try {
      do {
        this.#toolRefreshPending = false;
        // `refreshTools()` reports its own failures on the returned report and
        // never rejects; the `catch` is belt-and-braces so an unexpected
        // rejection can never become an unhandled rejection on the stream's
        // read loop.
        await this.refreshTools().catch(() => undefined);
      } while (this.#toolRefreshPending);
    } finally {
      this.#toolRefreshInFlight = false;
      this.#toolRefreshPending = false;
    }
  }

  /**
   * One `tools/list` walk under a wall-clock bound. `fetch` imposes no deadline
   * of its own, so without this an endpoint that accepts the POST and never
   * responds blocks every `chat()` indefinitely. Expiry is surfaced as a plain
   * discovery failure, which the caller already degrades to runtime-only tools
   * and retries on the next turn.
   */
  async #listAllToolsBounded(): Promise<McpToolListing> {
    const timeoutMs = this.#options.toolDiscoveryTimeoutMs ?? DEFAULT_TOOL_DISCOVERY_TIMEOUT_MS;
    const client = this.#ensureMcpClient();
    if (!(timeoutMs > 0)) return client.listAllTools();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await client.listAllTools({ signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new Error(`tools/list did not respond within ${timeoutMs}ms.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Awaits the shared discovery pass, but stops waiting the moment `signal`
   * aborts. The pass itself is deliberately NOT cancelled: it is shared by
   * every concurrent turn, and one caller walking away must not strip the
   * composition plane from the others.
   */
  #awaitDiscovery(signal: AbortSignal): Promise<void> {
    const discovery = this.#ensureToolCatalog().then(() => undefined);
    return new Promise<void>((resolve) => {
      const onAbort = (): void => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      void discovery.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  #publishDiscovery(report: StudioToolDiscoveryReport): StudioToolDiscoveryReport {
    this.#discoveryReport = report;
    this.#options.onEvent?.({ type: "toolDiscovery", report });
    return report;
  }

  public async chat(text: string, chatOptions: StudioAgentChatOptions = {}): Promise<StudioAgentTurn> {
    const signal = chatOptions.signal ?? new AbortController().signal;
    // Read the caller's cancellation BEFORE anything else. Discovery is an MCP
    // `initialize` plus a full `tools/list` walk; an already-cancelled turn
    // must not perform it.
    if (signal.aborted) {
      return cancelledTurn();
    }

    // Discovery next: the refusal check and the advertised tool set both read
    // `#tools`, and a tool-carrying turn must know its full vocabulary. The
    // wait is bounded by the caller's signal as well as by the pass's own
    // timeout, so a hung MCP endpoint can no longer pin `chat()` open.
    await this.#awaitDiscovery(signal);
    if (signal.aborted) {
      return cancelledTurn();
    }

    const refusal = await this.#refusalReason();
    if (refusal) {
      return { status: "refused", text: "", toolCalls: [], events: [], errorMessage: refusal, rounds: 0 };
    }

    this.#messages.push({ role: "user", content: text });

    const maxRounds = this.#options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const events: StudioAiChatEvent[] = [];
    const dispatches: StudioAgentToolDispatch[] = [];
    const assistantText: string[] = [];
    let stopReason: StudioAiStopReason | undefined;
    let rounds = 0;

    let system: string | undefined;
    try {
      system = await this.#resolveSystem();
    } catch (error) {
      return {
        status: "error",
        text: "",
        toolCalls: [],
        events: [],
        errorMessage: `Could not build the system prompt: ${errorMessage(error)}`,
        rounds: 0,
      };
    }

    for (let round = 0; round < maxRounds; round++) {
      if (signal.aborted) {
        return finish("cancelled");
      }
      rounds += 1;

      const request = this.#buildRequest(system, chatOptions.toolChoice);
      const roundResult = await this.#streamRound(request, signal, events, assistantText);
      if (roundResult.stopReason) stopReason = roundResult.stopReason;

      if (roundResult.transportError) {
        return finish("error", roundResult.transportError);
      }
      if (signal.aborted) {
        return finish("cancelled");
      }
      if (roundResult.errorMessage) {
        return finish("error", roundResult.errorMessage);
      }
      if (roundResult.pending.length === 0) {
        return finish("completed");
      }

      for (const pending of roundResult.pending) {
        const dispatch = await this.#enqueue(() => this.#dispatch(pending));
        dispatches.push(dispatch);
        this.#options.onEvent?.({ type: "toolResult", result: dispatch });
        this.#messages.push({
          role: "tool",
          content: dispatch.content,
          toolCallId: dispatch.toolCallId,
          toolName: dispatch.toolName,
        });
      }
    }

    return finish("completed");

    function finish(status: StudioAgentTurnStatus, message?: string): StudioAgentTurn {
      return {
        status,
        text: assistantText.join(""),
        toolCalls: dispatches,
        events,
        ...(stopReason ? { stopReason } : {}),
        ...(message ? { errorMessage: message } : {}),
        rounds,
      };
    }
  }

  // ── Streaming ───────────────────────────────────────────────

  async #streamRound(
    request: StudioAiChatRequest,
    signal: AbortSignal,
    events: StudioAiChatEvent[],
    assistantText: string[],
  ): Promise<{
    readonly pending: ReadonlyArray<PendingToolCall>;
    readonly stopReason?: StudioAiStopReason;
    readonly errorMessage?: string;
    readonly transportError?: string;
  }> {
    const roundEventStart = events.length;
    const pending = new Map<string, PendingToolCall>();
    const order: string[] = [];
    const roundText: string[] = [];
    let stopReason: StudioAiStopReason | undefined;
    let inBandError: string | undefined;
    let provenance: StudioAiChatEvent["provenance"];
    let provenanceCount = 0;
    let eventAfterProvenance = false;

    try {
      for await (const event of this.#transport.streamChat(request, signal)) {
        if (provenanceCount > 0) eventAfterProvenance = true;
        events.push(event);
        this.#options.onEvent?.({ type: "chat", event });
        switch (event.type) {
          case "textDelta":
            if (event.text) {
              roundText.push(event.text);
              assistantText.push(event.text);
            }
            break;
          case "toolCallStart": {
            const id = event.toolCallId ?? `tool-${order.length + 1}`;
            if (!pending.has(id)) order.push(id);
            pending.set(id, { toolCallId: id, toolName: event.toolName ?? "", argumentText: "" });
            break;
          }
          case "toolCallDelta": {
            const id = event.toolCallId ?? order[order.length - 1];
            const current = id ? pending.get(id) : undefined;
            if (current && event.toolArgumentsDelta) {
              current.argumentText += event.toolArgumentsDelta;
            }
            break;
          }
          case "toolCallStop": {
            const id = event.toolCallId ?? order[order.length - 1];
            const current = id ? pending.get(id) : undefined;
            if (!current) break;
            // The server sends fully parsed arguments when assembly
            // succeeded; the accumulated delta text is the fallback.
            current.args = event.toolArguments !== undefined ? event.toolArguments : parseJson(current.argumentText);
            current.ready = true;
            if (event.toolName) current.toolName = event.toolName;
            break;
          }
          case "messageStop":
            stopReason = event.stopReason;
            break;
          case "error":
            inBandError = event.errorMessage ?? "The Studio AI proxy reported an error.";
            break;
          case "transcriptProvenance":
            provenanceCount += 1;
            provenance = event.provenance;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return { pending: [], ...(stopReason ? { stopReason } : {}) };
      }
      return { pending: [], ...(stopReason ? { stopReason } : {}), transportError: errorMessage(error) };
    }

    if (roundText.length > 0) {
      this.#messages.push({ role: "assistant", content: roundText.join("") });
    }

    const ready = order
      .map((id) => pending.get(id))
      .filter((call): call is PendingToolCall => call !== undefined && call.ready === true);

    if (ready.length > 0) {
      if (
        !this.#options.certification ||
        !this.#options.transcriptVerifier ||
        !provenance ||
        provenanceCount !== 1 ||
        eventAfterProvenance
      ) {
        return {
          pending: [],
          ...(stopReason ? { stopReason } : {}),
          errorMessage: "Model-selected actions require exactly one terminal verified transcript provenance event.",
        };
      }
      const roundEvents = events.slice(roundEventStart);
      const verification = await this.#options.transcriptVerifier.verify(
        provenance,
        request,
        roundEvents.filter((event) => event.type !== "transcriptProvenance"),
      );
      if (!verification.ok)
        return {
          pending: [],
          ...(stopReason ? { stopReason } : {}),
          errorMessage: `Transcript provenance rejected: ${verification.reason}.`,
        };
    }

    return {
      pending: ready,
      ...(stopReason ? { stopReason } : {}),
      ...(inBandError ? { errorMessage: inBandError } : {}),
    };
  }

  #buildRequest(system: string | undefined, toolChoice: StudioAiToolChoice | undefined): StudioAiChatRequest {
    const choice = toolChoice ?? this.#options.toolChoice;
    return {
      ...(this.#options.certification ? { certification: this.#options.certification } : {}),
      ...(this.#options.provider ? { provider: this.#options.provider } : {}),
      ...(this.#options.model ? { model: this.#options.model } : {}),
      ...(system ? { system } : {}),
      messages: [...this.#messages],
      ...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
      ...(choice ? { toolChoice: choice } : {}),
      ...(this.#options.maxTokens !== undefined ? { maxTokens: this.#options.maxTokens } : {}),
      ...(this.#options.temperature !== undefined ? { temperature: this.#options.temperature } : {}),
    };
  }

  async #resolveSystem(): Promise<string | undefined> {
    const system = this.#options.system;
    if (typeof system === "function") return await system();
    return system;
  }

  /**
   * Refuses a tool-carrying turn against a provider that cannot call tools —
   * the model would silently answer in prose and every composition verb would
   * be lost. A capabilities outage is NOT a refusal: the turn proceeds and the
   * proxy decides.
   */
  async #refusalReason(): Promise<string | undefined> {
    if (this.#tools.length === 0) return undefined;
    let provider: StudioAiCapability | undefined;
    try {
      const capabilities = await this.capabilities();
      if (!capabilities.enabled) {
        return "The Studio AI proxy is disabled on this server; no tool turn can run.";
      }
      provider = await this.resolveProvider();
    } catch {
      return undefined;
    }
    if (!provider) return undefined;
    if (provider.toolSupport) return undefined;
    return `Provider "${provider.provider}" (model "${provider.model}") does not support tool calls, so this session refuses to run a ${this.#tools.length}-tool turn against it.`;
  }

  // ── Tool dispatch ───────────────────────────────────────────

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    // Swallow so one failed call never poisons the queue for the next one.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #dispatch(call: PendingToolCall): Promise<StudioAgentToolDispatch> {
    // Runtime first, matching the merge order in `#discoverTools`: a local
    // runtime verb is never shadowed by a server descriptor of the same name.
    if (this.#runtimeToolNames.has(call.toolName)) {
      return this.#dispatchRuntime(call);
    }
    // The discovered, policy-approved catalog is the ONLY routing authority for
    // the composition plane. A `honua_studio_`-prefixed name the server did not
    // advertise (or the policy did not approve) is rejected here rather than
    // being handed this session's draft identity and credentials.
    if (this.#catalog.has(call.toolName)) {
      return this.#dispatchComposition(call);
    }
    const rejection = this.#catalog.rejections.find((candidate) => candidate.name === call.toolName);
    if (rejection) {
      return reject(
        call,
        "composition",
        `Tool "${call.toolName}" is not routable by this session: ${rejection.detail}`,
      );
    }
    return reject(call, "unknown", `No tool named "${call.toolName}" is available to this session.`);
  }

  async #dispatchRuntime(call: PendingToolCall): Promise<StudioAgentToolDispatch> {
    const execute = this.#execute;
    if (!execute) {
      return reject(call, "runtime", "This session has no tool executor; supply `kit` or `execute`.");
    }
    let result: HonuaAgentToolResult;
    try {
      result = await execute({ name: call.toolName, args: asRecord(call.args) } as HonuaAgentToolCall);
    } catch (error) {
      // The executor's own contract is structured results, not throws — but a
      // custom `execute` may still throw, and the turn loop must survive it.
      return reject(call, "runtime", errorMessage(error));
    }
    const ok = result.status === "ok" || result.status === "dry-run";
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      plane: "runtime",
      ok,
      runtimeResult: result,
      ...(ok ? {} : { errorMessage: result.deniedReason ?? `Tool "${call.toolName}" returned ${result.status}.` }),
      content: stringify({
        status: result.status,
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.deniedReason ? { deniedReason: result.deniedReason } : {}),
      }),
    };
  }

  async #dispatchComposition(call: PendingToolCall): Promise<StudioAgentToolDispatch> {
    const client = this.#ensureMcpClient();
    const args = { ...asRecord(call.args) };
    if (this.#draft) {
      // The session owns draft identity and the optimistic-concurrency token;
      // a model-supplied `generation` is never trusted over the session's.
      args.draftId = args.draftId ?? this.#draft.draftId;
      args.generation = this.#draft.generation;
    }

    let result: McpToolsCallResult;
    let retried = false;
    try {
      result = await client.callTool(call.toolName, args);
    } catch (error) {
      if (!isMcpGenerationConflict(error) || !this.#draft) {
        return reject(call, "composition", errorMessage(error), mcpErrorCode(error));
      }
      // One reload + retry against the fresh generation, then surface.
      try {
        const refreshed = await this.#reloadDraft(client, this.#draft.draftId);
        retried = true;
        result = await client.callTool(call.toolName, { ...args, generation: refreshed.generation });
      } catch (retryError) {
        return reject(call, "composition", errorMessage(retryError), mcpErrorCode(retryError));
      }
    }

    const draft = parseStudioDraftResult(result);
    if (draft) this.#draft = { draftId: draft.draftId, generation: draft.generation };
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      plane: "composition",
      ok: true,
      ...(draft ? { draft } : {}),
      ...(retried ? { retriedAfterConflict: true } : {}),
      content: stringify({ status: "ok", ...(draft ? { draft } : { result: toolResultPayload(result) }) }),
    };
  }

  async #reloadDraft(client: McpClient, draftId: string): Promise<StudioAgentDraftBinding> {
    const result = await client.callTool("honua_studio_get_draft", { draftId });
    const draft = parseStudioDraftResult(result);
    if (!draft) {
      throw new Error(`honua_studio_get_draft returned no draft for "${draftId}".`);
    }
    const binding = { draftId: draft.draftId, generation: draft.generation };
    this.#draft = binding;
    return binding;
  }

  #ensureMcpClient(): McpClient {
    if (!this.#mcpClient) {
      this.#mcpClient = new McpClient({
        ...(this.#options.baseUrl !== undefined ? { baseUrl: this.#options.baseUrl } : {}),
        ...(this.#options.auth ? { auth: this.#options.auth } : {}),
        ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
      });
    }
    return this.#mcpClient;
  }
}

interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  argumentText: string;
  args?: unknown;
  ready?: boolean;
}

function reject(
  call: PendingToolCall,
  plane: StudioAgentToolPlane | "unknown",
  message: string,
  errorCode?: McpToolErrorCode,
): StudioAgentToolDispatch {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    plane,
    ok: false,
    ...(errorCode ? { errorCode } : {}),
    errorMessage: message,
    content: stringify({ status: "error", ...(errorCode ? { code: errorCode } : {}), message }),
  };
}

function mcpErrorCode(error: unknown): McpToolErrorCode | undefined {
  return isMcpToolError(error) ? error.code : undefined;
}

/**
 * Reads a `StudioPackageDraft` out of a `tools/call` result — structured
 * content first (the documented shape), then the first text block parsed as
 * JSON, then `undefined` for a tool whose result is not a draft at all
 * (`validate`, `preview`).
 */
export function parseStudioDraftResult(result: McpToolsCallResult): StudioMcpDraft | undefined {
  const candidates: unknown[] = [];
  if (result.structuredContent) candidates.push(result.structuredContent);
  const firstText = result.content?.find((block) => block.type === "text")?.text;
  if (firstText) candidates.push(parseJson(firstText));
  for (const candidate of candidates) {
    const draft = asDraft(candidate);
    if (draft) return draft;
  }
  return undefined;
}

function asDraft(value: unknown): StudioMcpDraft | undefined {
  const record = asRecord(value);
  const nested = asRecord(record.draft);
  const source = typeof record.draftId === "string" ? record : typeof nested.draftId === "string" ? nested : undefined;
  if (!source) return undefined;
  if (typeof source.generation !== "number") return undefined;
  return source as unknown as StudioMcpDraft;
}

function toolResultPayload(result: McpToolsCallResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const firstText = result.content?.find((block) => block.type === "text")?.text;
  return firstText !== undefined ? parseJson(firstText) : null;
}

function dedupeByName(definitions: ReadonlyArray<HonuaAgentToolDefinitionLike>): HonuaAgentToolDefinitionLike[] {
  const byName = new Map<string, HonuaAgentToolDefinitionLike>();
  for (const definition of definitions) {
    if (!byName.has(definition.name)) byName.set(definition.name, definition);
  }
  return [...byName.values()];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '{"status":"error","message":"Tool result could not be serialized."}';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
