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
 *  - **Draft-mutating composition tools** — the `honua_studio_*` MCP tools
 *    (including `honua_studio_bind_interaction` /
 *    `honua_studio_remove_interaction`), routed through {@link McpClient} to
 *    the server that owns the composition draft.
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
} from "./ai-contract.js";
import { McpClient } from "./mcp-client.js";
import { isMcpGenerationConflict } from "./mcp-errors.js";
import { type McpToolsCallResult, type StudioMcpDraft, isHonuaStudioMcpToolName } from "./mcp-protocol.js";
import { SseChatTransport, fetchStudioAiCapabilities } from "./sse-transport.js";
import type { ChatTransport } from "./transport.js";

/** The live composition draft `honua_studio_*` calls are applied to. */
export interface StudioAgentDraftBinding {
  readonly draftId: string;
  readonly generation: number;
}

export interface StudioAgentSessionOptions {
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
  /** Replaces the MCP client used for `honua_studio_*` routing. */
  readonly mcpClient?: McpClient;
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
  | { readonly type: "toolResult"; readonly result: StudioAgentToolDispatch };

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
  /** The tool definitions advertised to the proxy, in the `{ name, description, inputSchema }` HTTP shape. */
  readonly tools: ReadonlyArray<StudioAiToolDefinition>;
  /** `GET /v1/studio/ai/capabilities`, fetched once and cached. */
  capabilities(): Promise<StudioAiCapabilitiesResponse>;
  /** The provider descriptor this session routes to, or `undefined` when it is not declared. */
  resolveProvider(): Promise<StudioAiCapability | undefined>;
  /** Runs one user turn to completion. Never throws. */
  chat(text: string, options?: StudioAgentChatOptions): Promise<StudioAgentTurn>;
  /** Attaches (or re-attaches) the composition draft. */
  attachDraft(draft: StudioAgentDraftBinding): void;
  /** Clears the conversation history. Draft binding and capabilities cache survive. */
  reset(): void;
}

const DEFAULT_MAX_TOOL_ROUNDS = 8;

export function createStudioAgentSession(options: StudioAgentSessionOptions): StudioAgentSession {
  return new StudioAgentSessionImpl(options);
}

class StudioAgentSessionImpl implements StudioAgentSession {
  readonly #options: StudioAgentSessionOptions;
  readonly #transport: ChatTransport;
  readonly #tools: ReadonlyArray<StudioAiToolDefinition>;
  readonly #runtimeToolNames: ReadonlySet<string>;
  readonly #execute: ((call: HonuaAgentToolCall) => Promise<HonuaAgentToolResult>) | undefined;
  readonly #messages: StudioAiChatMessage[] = [];
  #mcpClient: McpClient | undefined;
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
    this.#tools = convertHonuaAgentToolDefinitions(
      dedupeByName(definitions),
      "mcp",
    ) as ReadonlyArray<StudioAiToolDefinition>;
    this.#runtimeToolNames = new Set(this.#tools.map((tool) => tool.name));
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

  public attachDraft(draft: StudioAgentDraftBinding): void {
    this.#draft = draft;
  }

  public reset(): void {
    this.#messages.length = 0;
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

  public async chat(text: string, chatOptions: StudioAgentChatOptions = {}): Promise<StudioAgentTurn> {
    const refusal = await this.#refusalReason();
    if (refusal) {
      return { status: "refused", text: "", toolCalls: [], events: [], errorMessage: refusal, rounds: 0 };
    }

    this.#messages.push({ role: "user", content: text });

    const signal = chatOptions.signal ?? new AbortController().signal;
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
    const pending = new Map<string, PendingToolCall>();
    const order: string[] = [];
    const roundText: string[] = [];
    let stopReason: StudioAiStopReason | undefined;
    let inBandError: string | undefined;

    try {
      for await (const event of this.#transport.streamChat(request, signal)) {
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

    return {
      pending: ready,
      ...(stopReason ? { stopReason } : {}),
      ...(inBandError ? { errorMessage: inBandError } : {}),
    };
  }

  #buildRequest(system: string | undefined, toolChoice: StudioAiToolChoice | undefined): StudioAiChatRequest {
    const choice = toolChoice ?? this.#options.toolChoice;
    return {
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
    if (isHonuaStudioMcpToolName(call.toolName)) {
      return this.#dispatchComposition(call);
    }
    if (this.#runtimeToolNames.has(call.toolName)) {
      return this.#dispatchRuntime(call);
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
        return reject(call, "composition", errorMessage(error));
      }
      // One reload + retry against the fresh generation, then surface.
      try {
        const refreshed = await this.#reloadDraft(client, this.#draft.draftId);
        retried = true;
        result = await client.callTool(call.toolName, { ...args, generation: refreshed.generation });
      } catch (retryError) {
        return reject(call, "composition", errorMessage(retryError));
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
): StudioAgentToolDispatch {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    plane,
    ok: false,
    errorMessage: message,
    content: stringify({ status: "error", message }),
  };
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
