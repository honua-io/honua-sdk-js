/**
 * Agent-facing tool schemas and executors for bounded map/runtime actions.
 *
 * The executor is intentionally runtime-agnostic: apps can adapt a
 * HonuaController, generated-app runtime, MapPackage runtime, or test double
 * to the small {@link HonuaAgentRuntime} interface. Tool definitions are plain
 * JSON Schema-compatible objects so they can be reused by MCP, provider-native
 * function calling, or local policy engines.
 *
 * This entrypoint is part of the SDK's stable tier: symbols reachable from
 * `@honua/sdk-js/agent-tools` are covered by the semver contract (see
 * `docs/decisions/agent-surface-stabilization.md`).
 *
 * @module
 */

import {
  CAPABILITIES,
  type Capability,
  type FeatureId,
  PROTOCOLS,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type Query,
  type SourceId,
} from "../contract/index.js";
import { type HonuaErrorCode, HonuaSdkError, mergeHonuaErrorContext } from "../core/error-envelope.js";
import type { HonuaExtent } from "../core/types.js";
import {
  type FeatureSelectionTarget,
  type FilterClause,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "../exploration/index.js";

export const HONUA_AGENT_TOOL_NAMES = [
  "inspectMap",
  "listSources",
  "listCapabilities",
  "setViewport",
  "addLayer",
  "setFilter",
  "selectFeature",
  "summarizeSelection",
  "runWidgetQuery",
  "explainCapabilityGap",
] as const;

export type HonuaAgentToolName = (typeof HONUA_AGENT_TOOL_NAMES)[number];
export type HonuaAgentToolMode = "read" | "action";
export type HonuaAgentToolStatus = "ok" | "dry-run" | "denied" | "error";
export type HonuaAgentProviderToolFormat = "honua" | "mcp" | "openai";

export interface HonuaAgentJsonSchema {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, HonuaAgentJsonSchema>>;
  readonly items?: HonuaAgentJsonSchema;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | HonuaAgentJsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: unknown;
}

export interface HonuaAgentToolDefinition<TName extends HonuaAgentToolName = HonuaAgentToolName> {
  readonly name: TName;
  readonly title: string;
  readonly description: string;
  readonly mode: HonuaAgentToolMode;
  readonly requiresOptIn: boolean;
  readonly inputSchema: HonuaAgentJsonSchema;
}

/**
 * Structural superset of {@link HonuaAgentToolDefinition} accepted by the
 * provider-format exporters, so higher layers (for example
 * `@honua/sdk-js/nl-map-control`) can publish additional tools through the
 * same MCP / OpenAI conversion path without widening the canonical tool-name
 * union.
 */
export interface HonuaAgentToolDefinitionLike {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly mode?: HonuaAgentToolMode;
  readonly requiresOptIn?: boolean;
  readonly inputSchema: HonuaAgentJsonSchema;
}

export interface HonuaAgentViewport {
  readonly bbox?: readonly [number, number, number, number];
  readonly center?: readonly [number, number];
  readonly zoom?: number;
  readonly pitch?: number;
  readonly bearing?: number;
  readonly crs?: string;
}

export interface HonuaAgentSourceSummary {
  readonly id: SourceId;
  readonly title?: string;
  readonly protocol?: Protocol;
  readonly capabilities?: ReadonlyArray<Capability>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaAgentLayerSummary {
  readonly id: string;
  readonly sourceId?: SourceId;
  readonly type?: string;
  readonly title?: string;
  readonly visible?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaAgentMapSnapshot {
  readonly appId?: string;
  readonly mapPackageId?: string;
  readonly snapshotTimestamp?: string;
  readonly sourceVersion?: string;
  readonly viewport?: HonuaAgentViewport;
  readonly sources: ReadonlyArray<HonuaAgentSourceSummary>;
  readonly layers: ReadonlyArray<HonuaAgentLayerSummary>;
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly filters?: Readonly<Record<string, FilterClause>>;
  readonly realtime?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaAgentSelectionSummary {
  readonly count: number;
  readonly bySource: ReadonlyArray<{ readonly sourceId: SourceId | "unqualified"; readonly count: number }>;
  readonly targets: ReadonlyArray<FeatureSelectionTarget>;
}

export interface HonuaAgentWidgetQueryRequest {
  readonly sourceId: SourceId;
  readonly kind: "count" | "formula" | "categories" | "histogram" | "range" | "top-values" | "time-series";
  readonly field?: string;
  readonly metric?: string;
  readonly query?: Query<Record<string, unknown>>;
  readonly limit?: number;
}

export interface HonuaAgentWidgetQueryResult {
  readonly sourceId: SourceId;
  readonly kind: HonuaAgentWidgetQueryRequest["kind"];
  readonly data: unknown;
  readonly cache?: Readonly<Record<string, unknown>>;
  readonly degraded?: ReadonlyArray<HonuaAgentToolDegradedReason>;
}

export interface HonuaAgentToolDegradedReason {
  readonly code: string;
  readonly message: string;
  readonly sourceId?: SourceId;
  readonly capability?: Capability;
  readonly protocol?: Protocol;
}

export interface HonuaAgentRuntime {
  readonly id?: string;
  inspectMap?(options?: InspectMapArgs): MaybePromise<HonuaAgentMapSnapshot>;
  snapshot?(): MaybePromise<Partial<HonuaAgentMapSnapshot>>;
  getViewport?(): MaybePromise<HonuaAgentViewport | undefined>;
  setViewport?(viewport: HonuaAgentViewport): MaybePromise<unknown>;
  listSources?(): MaybePromise<ReadonlyArray<HonuaAgentSourceSummary>>;
  listLayers?(): MaybePromise<ReadonlyArray<HonuaAgentLayerSummary>>;
  getSelection?(): MaybePromise<ReadonlyArray<FeatureSelectionTarget>>;
  addLayer?(layer: Readonly<Record<string, unknown>>, beforeId?: string): MaybePromise<unknown>;
  setFilter?(id: string, clause: FilterClause | undefined): MaybePromise<unknown>;
  selectFeature?(
    target: FeatureSelectionTarget,
    options?: { readonly replace?: boolean },
  ): MaybePromise<ReadonlyArray<FeatureSelectionTarget> | void>;
  summarizeSelection?(): MaybePromise<HonuaAgentSelectionSummary>;
  runWidgetQuery?(request: HonuaAgentWidgetQueryRequest): MaybePromise<HonuaAgentWidgetQueryResult>;
}

export interface InspectMapArgs {
  readonly includeSources?: boolean;
  readonly includeLayers?: boolean;
  readonly includeSelection?: boolean;
}

export interface ListSourcesArgs {
  readonly sourceId?: SourceId;
}

export interface ListCapabilitiesArgs {
  readonly sourceId?: SourceId;
}

export interface SetViewportArgs extends HonuaAgentViewport {
  readonly dryRun?: boolean;
}

export interface AddLayerArgs {
  readonly layer: Readonly<Record<string, unknown>>;
  readonly beforeId?: string;
  readonly dryRun?: boolean;
}

export interface SetFilterArgs {
  readonly id: string;
  readonly clause?: FilterClause;
  readonly dryRun?: boolean;
}

export interface SelectFeatureArgs {
  readonly sourceId: SourceId;
  readonly id: FeatureId;
  readonly replace?: boolean;
  readonly dryRun?: boolean;
}

export interface SummarizeSelectionArgs {
  readonly includeTargets?: boolean;
}

export interface RunWidgetQueryArgs extends HonuaAgentWidgetQueryRequest {}

export interface ExplainCapabilityGapArgs {
  readonly capability: Capability;
  readonly protocol?: Protocol;
  readonly sourceId?: SourceId;
  readonly declaredCapabilities?: ReadonlyArray<Capability>;
}

export type HonuaAgentToolCall =
  | { readonly name: "inspectMap"; readonly args?: InspectMapArgs }
  | { readonly name: "listSources"; readonly args?: ListSourcesArgs }
  | { readonly name: "listCapabilities"; readonly args?: ListCapabilitiesArgs }
  | { readonly name: "setViewport"; readonly args: SetViewportArgs }
  | { readonly name: "addLayer"; readonly args: AddLayerArgs }
  | { readonly name: "setFilter"; readonly args: SetFilterArgs }
  | { readonly name: "selectFeature"; readonly args: SelectFeatureArgs }
  | { readonly name: "summarizeSelection"; readonly args?: SummarizeSelectionArgs }
  | { readonly name: "runWidgetQuery"; readonly args: RunWidgetQueryArgs }
  | { readonly name: "explainCapabilityGap"; readonly args: ExplainCapabilityGapArgs };

export interface HonuaAgentAuditEvent {
  readonly tool: HonuaAgentToolName;
  readonly actor?: string;
  readonly status: HonuaAgentToolStatus;
  readonly dryRun: boolean;
  readonly action: boolean;
  readonly sourceId?: SourceId;
  readonly layerId?: string;
  readonly targetIds?: ReadonlyArray<string>;
  readonly capability?: Capability;
  readonly protocol?: Protocol;
  readonly outcome: "allowed" | "denied" | "dry-run" | "error";
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly message?: string;
  readonly timestamp: string;
}

export interface HonuaAgentToolResult<TData = unknown> {
  readonly tool: HonuaAgentToolName;
  readonly status: HonuaAgentToolStatus;
  readonly data?: TData;
  readonly deniedReason?: string;
  readonly degraded?: ReadonlyArray<HonuaAgentToolDegradedReason>;
  readonly audit: HonuaAgentAuditEvent;
}

export interface HonuaAgentToolExecutorOptions {
  readonly actor?: string;
  readonly allowActions?: boolean;
  readonly dryRun?: boolean;
  readonly allowedTools?: ReadonlyArray<HonuaAgentToolName>;
  readonly allowedSourceIds?: ReadonlyArray<SourceId>;
  readonly allowedLayerIds?: ReadonlyArray<string>;
  readonly maxResults?: number;
  readonly now?: () => string;
  readonly onAudit?: (event: HonuaAgentAuditEvent) => void;
}

export interface HonuaAiMapKitPolicy extends HonuaAgentToolExecutorOptions {
  readonly readOnly?: boolean;
}

export interface HonuaAgentContextOptions {
  readonly actor?: string;
  readonly maxSources?: number;
  readonly maxLayers?: number;
  readonly maxSelectionTargets?: number;
  readonly maxPromptChars?: number;
  readonly includeSafeExamples?: boolean;
  readonly now?: () => string;
}

export interface HonuaAgentSemanticMapContext {
  readonly generatedAt: string;
  readonly actor?: string;
  readonly appId?: string;
  readonly mapPackageId?: string;
  readonly snapshotTimestamp?: string;
  readonly sourceVersion?: string;
  readonly visibleExtent?: HonuaAgentViewport;
  readonly sources: ReadonlyArray<HonuaAgentSourceSummary>;
  readonly layers: ReadonlyArray<HonuaAgentLayerSummary>;
  readonly capabilities: ReadonlyArray<{
    readonly sourceId: SourceId;
    readonly protocol?: Protocol;
    readonly capabilities: ReadonlyArray<Capability>;
  }>;
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly realtime?: Readonly<Record<string, unknown>>;
  readonly staleState?: string;
  readonly safeExamples: ReadonlyArray<{
    readonly user: string;
    readonly toolCall: HonuaAgentToolCall;
  }>;
  readonly omitted: Readonly<Record<string, number>>;
}

export interface HonuaMcpCompatibleToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: HonuaAgentJsonSchema;
}

export interface HonuaOpenAiToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: HonuaAgentJsonSchema;
  };
}

export type HonuaProviderToolDefinition =
  | HonuaAgentToolDefinition
  | HonuaAgentToolDefinitionLike
  | HonuaMcpCompatibleToolDefinition
  | HonuaOpenAiToolDefinition;

export interface HonuaAiMapKitOptions {
  readonly runtime?: HonuaAgentRuntime;
  readonly controller?: HonuaControllerLike;
  readonly generatedAppRuntime?: HonuaGeneratedAppRuntimeLikeForAgents;
  readonly policy?: HonuaAiMapKitPolicy;
  readonly context?: HonuaAgentContextOptions;
  readonly tools?: ReadonlyArray<HonuaAgentToolName>;
  readonly providerFormat?: HonuaAgentProviderToolFormat;
}

export interface HonuaAiMapKit {
  readonly runtime: HonuaAgentRuntime;
  readonly policy: HonuaAgentToolExecutorOptions;
  readonly tools: ReadonlyArray<HonuaAgentToolDefinition>;
  readonly providerTools: ReadonlyArray<HonuaProviderToolDefinition>;
  readonly mcpTools: ReadonlyArray<HonuaMcpCompatibleToolDefinition>;
  execute(call: HonuaAgentToolCall): Promise<HonuaAgentToolResult>;
  context(options?: HonuaAgentContextOptions): Promise<HonuaAgentSemanticMapContext>;
  systemPrompt(options?: HonuaAgentContextOptions): Promise<string>;
}

export interface HonuaControllerLike {
  readonly id?: string;
  readonly context?: {
    readonly state?: {
      readonly filters?: Readonly<Record<string, FilterClause>>;
      readonly selection?: ReadonlyArray<FeatureSelectionTarget>;
      readonly extent?: HonuaExtent;
      readonly page?: { readonly limit?: number };
    };
    dispatch?(intent: unknown): void;
  };
  getViewport?(): HonuaAgentViewport;
  setViewport?(viewport: HonuaAgentViewport): void;
  getSelection?(options?: { readonly sourceId?: SourceId }): ReadonlyArray<FeatureSelectionTarget>;
  selectFeature?(
    sourceId: SourceId | { readonly sourceId: SourceId; readonly id: FeatureId },
    idOrOptions?: FeatureId | { readonly replace?: boolean },
    options?: { readonly replace?: boolean },
  ): void;
  snapshot?(): {
    readonly viewport?: HonuaAgentViewport;
    readonly exploration?: {
      readonly state?: {
        readonly filters?: Readonly<Record<string, FilterClause>>;
        readonly selection?: ReadonlyArray<FeatureSelectionTarget>;
        readonly extent?: HonuaExtent;
      };
    };
    readonly visibility?: Readonly<Record<string, unknown>>;
  };
}

export interface HonuaGeneratedAppRuntimeLikeForAgents {
  readonly context?: HonuaControllerLike["context"];
  readonly manifest?: {
    readonly appId?: string;
    readonly title?: string;
    readonly data?: { readonly sourceId?: SourceId };
    readonly layout?: { readonly widgets?: ReadonlyArray<Readonly<Record<string, unknown>>> };
  };
  readonly mapRuntime?: {
    readonly mapPackage?: { readonly id?: string };
    readonly composedStyle?: {
      readonly sources?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      readonly layers?: ReadonlyArray<Readonly<Record<string, unknown>>>;
    };
  };
  snapshot?(): unknown;
  render?(): { readonly visibleCount?: number; readonly totalCount?: number; readonly snapshot?: unknown };
  setFilter?(widgetId: string, value: string | number | boolean | undefined): unknown;
  selectRecord?(widgetId: string, id: FeatureId, options?: { readonly replace?: boolean }): unknown;
}

type MaybePromise<T> = T | Promise<T>;

const stringSchema = (description: string): HonuaAgentJsonSchema => ({ type: "string", description });
const numberSchema = (description: string): HonuaAgentJsonSchema => ({ type: "number", description });
const booleanSchema = (description: string, defaultValue?: boolean): HonuaAgentJsonSchema => ({
  type: "boolean",
  description,
  ...(defaultValue !== undefined ? { default: defaultValue } : {}),
});
const capabilitySchema: HonuaAgentJsonSchema = {
  type: "string",
  description: "Honua capability identifier.",
  enum: CAPABILITIES,
};
const protocolSchema: HonuaAgentJsonSchema = {
  type: "string",
  description: "Honua protocol identifier.",
  enum: PROTOCOLS,
};
const featureIdSchema: HonuaAgentJsonSchema = {
  type: ["string", "number"],
  description: "Feature id to select.",
};
const viewportProperties: Readonly<Record<string, HonuaAgentJsonSchema>> = {
  bbox: {
    type: "array",
    description: "Viewport bounding box [xmin, ymin, xmax, ymax].",
    items: numberSchema("Coordinate"),
  },
  center: {
    type: "array",
    description: "Viewport center [x, y].",
    items: numberSchema("Coordinate"),
  },
  zoom: numberSchema("Map zoom."),
  pitch: numberSchema("Map pitch."),
  bearing: numberSchema("Map bearing."),
  crs: stringSchema("Coordinate reference system."),
};

export const HONUA_AGENT_TOOL_DEFINITIONS: readonly HonuaAgentToolDefinition[] = [
  {
    name: "inspectMap",
    title: "Inspect map",
    description: "Return the current map snapshot, including viewport, sources, layers, selection, and metadata.",
    mode: "read",
    requiresOptIn: false,
    inputSchema: {
      type: "object",
      properties: {
        includeSources: booleanSchema("Include source summaries.", true),
        includeLayers: booleanSchema("Include layer summaries.", true),
        includeSelection: booleanSchema("Include selected feature targets.", true),
      },
      additionalProperties: false,
    },
  },
  {
    name: "listSources",
    title: "List sources",
    description: "List map/runtime sources and their protocol metadata.",
    mode: "read",
    requiresOptIn: false,
    inputSchema: {
      type: "object",
      properties: { sourceId: stringSchema("Optional source id filter.") },
      additionalProperties: false,
    },
  },
  {
    name: "listCapabilities",
    title: "List capabilities",
    description: "List source capabilities resolved from runtime source metadata and protocol defaults.",
    mode: "read",
    requiresOptIn: false,
    inputSchema: {
      type: "object",
      properties: { sourceId: stringSchema("Optional source id filter.") },
      additionalProperties: false,
    },
  },
  {
    name: "setViewport",
    title: "Set viewport",
    description: "Move the map viewport. Requires action opt-in and supports dry-run.",
    mode: "action",
    requiresOptIn: true,
    inputSchema: {
      type: "object",
      properties: { ...viewportProperties, dryRun: booleanSchema("Validate without applying the viewport change.") },
      additionalProperties: false,
    },
  },
  {
    name: "addLayer",
    title: "Add layer",
    description: "Add a runtime layer. Requires action opt-in and supports dry-run.",
    mode: "action",
    requiresOptIn: true,
    inputSchema: {
      type: "object",
      required: ["layer"],
      properties: {
        layer: {
          type: "object",
          description: "Layer specification to add.",
          additionalProperties: true,
        },
        beforeId: stringSchema("Optional layer id before which to insert the new layer."),
        dryRun: booleanSchema("Validate without adding the layer."),
      },
      additionalProperties: false,
    },
  },
  {
    name: "setFilter",
    title: "Set filter",
    description: "Set or clear an exploration filter. Requires action opt-in and supports dry-run.",
    mode: "action",
    requiresOptIn: true,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: stringSchema("Filter id."),
        clause: {
          type: "object",
          description: "Filter clause. Omit to clear the filter.",
          additionalProperties: true,
        },
        dryRun: booleanSchema("Validate without applying the filter."),
      },
      additionalProperties: false,
    },
  },
  {
    name: "selectFeature",
    title: "Select feature",
    description: "Select a source-qualified feature. Requires action opt-in and supports dry-run.",
    mode: "action",
    requiresOptIn: true,
    inputSchema: {
      type: "object",
      required: ["sourceId", "id"],
      properties: {
        sourceId: stringSchema("Source id."),
        id: featureIdSchema,
        replace: booleanSchema("Replace the current selection.", true),
        dryRun: booleanSchema("Validate without changing selection."),
      },
      additionalProperties: false,
    },
  },
  {
    name: "summarizeSelection",
    title: "Summarize selection",
    description: "Summarize selected feature targets without fetching feature details.",
    mode: "read",
    requiresOptIn: false,
    inputSchema: {
      type: "object",
      properties: { includeTargets: booleanSchema("Include raw selected targets.", true) },
      additionalProperties: false,
    },
  },
  {
    name: "runWidgetQuery",
    title: "Run widget query",
    description: "Run a read-only widget data query through the runtime.",
    mode: "read",
    requiresOptIn: false,
    inputSchema: {
      type: "object",
      required: ["sourceId", "kind"],
      properties: {
        sourceId: stringSchema("Source id."),
        kind: {
          type: "string",
          description: "Widget query kind.",
          enum: ["count", "formula", "categories", "histogram", "range", "top-values", "time-series"],
        },
        field: stringSchema("Field used by the widget query."),
        metric: stringSchema("Metric used by the widget query."),
        limit: { type: "number", description: "Maximum result rows.", minimum: 1 },
        query: { type: "object", description: "Optional canonical query projection.", additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "explainCapabilityGap",
    title: "Explain capability gap",
    description: "Explain whether a source/protocol supports a capability and what to do when it does not.",
    mode: "read",
    requiresOptIn: false,
    inputSchema: {
      type: "object",
      required: ["capability"],
      properties: {
        capability: capabilitySchema,
        protocol: protocolSchema,
        sourceId: stringSchema("Optional source id."),
        declaredCapabilities: {
          type: "array",
          description:
            "Optional source-declared capabilities. If omitted, protocol defaults or runtime source metadata are used.",
          items: capabilitySchema,
        },
      },
      additionalProperties: false,
    },
  },
] as const;

/**
 * Legacy detailed reason codes mapped to registered `agent.tool.*` `sdkCode`
 * values. Any other runtime string (defensively, since `.code` is typed
 * `string` for legacy callers) projects to `agent.tool.internal` without
 * changing the local `.code`/message.
 */
const AGENT_TOOL_ERROR_SDK_CODES = {
  "unknown-tool": "agent.tool.unknown-tool",
  "missing-runtime": "agent.tool.missing-runtime",
  "unqualified-selection": "agent.tool.unqualified-selection",
  "missing-runtime-method": "agent.tool.missing-runtime-method",
} as const satisfies Readonly<Record<string, HonuaErrorCode>>;

type KnownHonuaAgentToolErrorCode = keyof typeof AGENT_TOOL_ERROR_SDK_CODES;

function isKnownAgentToolErrorCode(code: unknown): code is KnownHonuaAgentToolErrorCode {
  return typeof code === "string" && Object.hasOwn(AGENT_TOOL_ERROR_SDK_CODES, code);
}

function agentToolSdkCode(code: unknown): HonuaErrorCode {
  return isKnownAgentToolErrorCode(code) ? AGENT_TOOL_ERROR_SDK_CODES[code] : "agent.tool.internal";
}

/**
 * Tagged agent-tools failure. Participates in the shared SDK error envelope
 * (`isHonuaError`, `serializeHonuaError`) while preserving the legacy `.code`
 * string and `.tool` name. Only the tool name — one of the ten fixed
 * {@link HonuaAgentToolName} values — is ever placed in serialized context;
 * no tool arguments, results, prompts, or runtime metadata cross the
 * boundary.
 */
export class HonuaAgentToolError extends HonuaSdkError {
  public readonly code: string;
  public readonly tool: HonuaAgentToolName | undefined;

  public constructor(code: string, message: string, options: { readonly tool?: HonuaAgentToolName } = {}) {
    super(agentToolSdkCode(code), message, {
      context: mergeHonuaErrorContext(options.tool ? { tool: options.tool } : undefined),
    });
    this.name = "HonuaAgentToolError";
    this.code = code;
    this.tool = options.tool;
  }
}

export function getHonuaAgentToolDefinition(name: HonuaAgentToolName): HonuaAgentToolDefinition {
  const definition = HONUA_AGENT_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    throw new HonuaAgentToolError("unknown-tool", `Unknown Honua agent tool "${name}"`, { tool: name });
  }
  return definition;
}

export function createHonuaAiMapKit(options: HonuaAiMapKitOptions): HonuaAiMapKit {
  const runtime =
    options.runtime ??
    (options.controller ? adaptHonuaControllerToAgentRuntime(options.controller) : undefined) ??
    (options.generatedAppRuntime
      ? adaptHonuaGeneratedAppRuntimeToAgentRuntime(options.generatedAppRuntime)
      : undefined);
  if (!runtime) {
    throw new HonuaAgentToolError(
      "missing-runtime",
      "createHonuaAiMapKit requires a runtime, controller, or generated-app runtime.",
    );
  }

  const policy = normalizeAiMapKitPolicy(options.policy);
  const tools = HONUA_AGENT_TOOL_DEFINITIONS.filter(
    (definition) =>
      (!options.tools || options.tools.includes(definition.name)) &&
      (!policy.allowedTools || policy.allowedTools.includes(definition.name)),
  );
  const execute = createHonuaAgentToolExecutor(runtime, policy);
  return {
    runtime,
    policy,
    tools,
    providerTools: convertHonuaAgentToolDefinitions(tools, options.providerFormat ?? "honua"),
    mcpTools: toHonuaMcpToolDefinitions(tools),
    execute,
    context(contextOptions = {}) {
      return createHonuaAgentMapContext(runtime, { ...options.context, ...contextOptions });
    },
    systemPrompt(contextOptions = {}) {
      return createHonuaAgentSystemPrompt(runtime, { ...options.context, ...contextOptions });
    },
  };
}

export function normalizeAiMapKitPolicy(policy: HonuaAiMapKitPolicy = {}): HonuaAgentToolExecutorOptions {
  const readOnly = policy.readOnly === true;
  return {
    ...(policy.actor ? { actor: policy.actor } : {}),
    allowActions: readOnly ? false : policy.allowActions === true,
    dryRun: readOnly ? true : policy.dryRun,
    ...(policy.allowedTools ? { allowedTools: [...policy.allowedTools] } : {}),
    ...(policy.allowedSourceIds ? { allowedSourceIds: [...policy.allowedSourceIds] } : {}),
    ...(policy.allowedLayerIds ? { allowedLayerIds: [...policy.allowedLayerIds] } : {}),
    ...(policy.maxResults !== undefined ? { maxResults: policy.maxResults } : {}),
    ...(policy.now ? { now: policy.now } : {}),
    ...(policy.onAudit ? { onAudit: policy.onAudit } : {}),
  };
}

export function convertHonuaAgentToolDefinitions(
  definitions: ReadonlyArray<HonuaAgentToolDefinitionLike> = HONUA_AGENT_TOOL_DEFINITIONS,
  format: HonuaAgentProviderToolFormat = "honua",
): ReadonlyArray<HonuaProviderToolDefinition> {
  switch (format) {
    case "honua":
      return definitions.map((definition) => ({ ...definition }));
    case "mcp":
      return toHonuaMcpToolDefinitions(definitions);
    case "openai":
      return toHonuaOpenAiToolDefinitions(definitions);
  }
}

export function toHonuaMcpToolDefinitions(
  definitions: ReadonlyArray<HonuaAgentToolDefinitionLike> = HONUA_AGENT_TOOL_DEFINITIONS,
): ReadonlyArray<HonuaMcpCompatibleToolDefinition> {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  }));
}

export function toHonuaOpenAiToolDefinitions(
  definitions: ReadonlyArray<HonuaAgentToolDefinitionLike> = HONUA_AGENT_TOOL_DEFINITIONS,
): ReadonlyArray<HonuaOpenAiToolDefinition> {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  }));
}

export async function createHonuaAgentMapContext(
  runtime: HonuaAgentRuntime,
  options: HonuaAgentContextOptions = {},
): Promise<HonuaAgentSemanticMapContext> {
  const snapshot = await inspectMap(runtime);
  const maxSources = positiveLimit(options.maxSources, 12);
  const maxLayers = positiveLimit(options.maxLayers, 24);
  const maxSelectionTargets = positiveLimit(options.maxSelectionTargets, 25);
  const sources = snapshot.sources.slice(0, maxSources).map(sanitizeSourceSummary);
  const layers = snapshot.layers.slice(0, maxLayers).map(sanitizeLayerSummary);
  const selection = snapshot.selection.slice(0, maxSelectionTargets);
  const context: HonuaAgentSemanticMapContext = {
    generatedAt: options.now?.() ?? new Date().toISOString(),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(snapshot.appId ? { appId: snapshot.appId } : {}),
    ...(snapshot.mapPackageId ? { mapPackageId: snapshot.mapPackageId } : {}),
    ...(snapshot.snapshotTimestamp ? { snapshotTimestamp: snapshot.snapshotTimestamp } : {}),
    ...(snapshot.sourceVersion ? { sourceVersion: snapshot.sourceVersion } : {}),
    ...(snapshot.viewport ? { visibleExtent: snapshot.viewport } : {}),
    sources,
    layers,
    capabilities: sources.map((source) => ({
      sourceId: source.id,
      ...(source.protocol ? { protocol: source.protocol } : {}),
      capabilities: capabilitiesFor(source),
    })),
    filters: snapshot.filters ?? {},
    selection,
    ...(snapshot.realtime ? { realtime: sanitizeRecord(snapshot.realtime) } : {}),
    ...(realtimeStateNote(snapshot) ? { staleState: realtimeStateNote(snapshot) } : {}),
    safeExamples: options.includeSafeExamples === false ? [] : safeToolExamples(sources, layers),
    omitted: {
      sources: Math.max(0, snapshot.sources.length - sources.length),
      layers: Math.max(0, snapshot.layers.length - layers.length),
      selection: Math.max(0, snapshot.selection.length - selection.length),
    },
  };
  const maxPromptChars = positiveLimit(options.maxPromptChars, 12_000);
  if (JSON.stringify(context).length <= maxPromptChars) return context;
  return { ...context, safeExamples: [], selection: context.selection.slice(0, Math.min(5, context.selection.length)) };
}

export async function createHonuaAgentSystemPrompt(
  runtime: HonuaAgentRuntime,
  options: HonuaAgentContextOptions = {},
): Promise<string> {
  const context = await createHonuaAgentMapContext(runtime, options);
  return [
    "You are operating a Honua map through bounded SDK tools.",
    "Use read tools for inspection first. Action tools require explicit opt-in or dry-run.",
    "Do not assume stale or realtime snapshots are current unless snapshotTimestamp/sourceVersion indicate freshness.",
    "Semantic map context:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

export function adaptHonuaControllerToAgentRuntime(
  controller: HonuaControllerLike,
  options: {
    readonly sources?: ReadonlyArray<HonuaAgentSourceSummary>;
    readonly layers?: ReadonlyArray<HonuaAgentLayerSummary>;
  } = {},
): HonuaAgentRuntime {
  return {
    id: controller.id,
    snapshot: () => {
      const snapshot = controller.snapshot?.();
      const state = snapshot?.exploration?.state ?? controller.context?.state;
      const viewport: HonuaAgentViewport | undefined = state?.extent
        ? { ...(snapshot?.viewport ?? controller.getViewport?.()), bbox: bboxFromExtent(state.extent) }
        : (snapshot?.viewport ?? controller.getViewport?.());
      return {
        appId: controller.id,
        ...(viewport ? { viewport } : {}),
        sources: options.sources ?? [],
        layers: options.layers ?? [],
        selection: state?.selection ?? controller.getSelection?.() ?? [],
        ...(state?.filters ? { filters: state.filters } : {}),
      };
    },
    getViewport: () => controller.getViewport?.(),
    setViewport: (viewport) => controller.setViewport?.(viewport),
    getSelection: () => controller.getSelection?.() ?? controller.context?.state?.selection ?? [],
    setFilter: (id, clause) =>
      controller.context?.dispatch?.(clause ? { kind: "set-filter", id, clause } : { kind: "clear-filter", id }),
    selectFeature: (target, selectOptions) => {
      if (!isSourceQualifiedSelectionTarget(target)) {
        throw new HonuaAgentToolError(
          "unqualified-selection",
          "Controller adapter requires source-qualified selections.",
          {
            tool: "selectFeature",
          },
        );
      }
      if (!controller.selectFeature) {
        controller.context?.dispatch?.({ kind: "select", ids: [target], replace: selectOptions?.replace ?? true });
        return controller.context?.state?.selection ?? [target];
      }
      controller.selectFeature(target.sourceId, target.id, selectOptions);
      return controller.getSelection?.() ?? controller.context?.state?.selection;
    },
  };
}

export function adaptHonuaGeneratedAppRuntimeToAgentRuntime(
  runtime: HonuaGeneratedAppRuntimeLikeForAgents,
): HonuaAgentRuntime {
  const sourceId = runtime.manifest?.data?.sourceId;
  return {
    id: runtime.manifest?.appId,
    snapshot: () => ({
      appId: runtime.manifest?.appId,
      mapPackageId: runtime.mapRuntime?.mapPackage?.id,
      sources: sourceId ? [{ id: sourceId, title: runtime.manifest?.title, capabilities: ["query"] }] : [],
      layers:
        runtime.mapRuntime?.composedStyle?.layers?.map((layer) => ({
          id: typeof layer.id === "string" ? layer.id : String(layer.id ?? "layer"),
          sourceId: typeof layer.source === "string" ? layer.source : undefined,
          type: typeof layer.type === "string" ? layer.type : undefined,
        })) ?? [],
      selection: runtime.context?.state?.selection ?? [],
      filters: runtime.context?.state?.filters ?? {},
      ...(runtime.context?.state?.extent ? { viewport: { bbox: bboxFromExtent(runtime.context.state.extent) } } : {}),
      metadata: {
        visibleCount: runtime.render?.().visibleCount,
        totalCount: runtime.render?.().totalCount,
      },
    }),
    getSelection: () => runtime.context?.state?.selection ?? [],
    setFilter: (id, clause) => {
      const value = clause?.value as string | number | boolean | undefined;
      runtime.setFilter?.(id, value);
      if (!runtime.setFilter)
        runtime.context?.dispatch?.(clause ? { kind: "set-filter", id, clause } : { kind: "clear-filter", id });
    },
    selectFeature: (target, selectOptions) => {
      if (!isSourceQualifiedSelectionTarget(target)) {
        throw new HonuaAgentToolError(
          "unqualified-selection",
          "Generated app adapter requires source-qualified selections.",
          {
            tool: "selectFeature",
          },
        );
      }
      const widgetId = firstWidgetId(runtime, "table") ?? firstWidgetId(runtime, "list") ?? "table";
      runtime.selectRecord?.(widgetId, target.id, selectOptions);
      if (!runtime.selectRecord) {
        runtime.context?.dispatch?.({ kind: "select", ids: [target], replace: selectOptions?.replace ?? true });
      }
      return runtime.context?.state?.selection ?? [target];
    },
  };
}

export function createHonuaAgentToolExecutor(
  runtime: HonuaAgentRuntime,
  options: HonuaAgentToolExecutorOptions = {},
): (call: HonuaAgentToolCall) => Promise<HonuaAgentToolResult> {
  return (call) => executeHonuaAgentTool(runtime, call, options);
}

export async function executeHonuaAgentTool(
  runtime: HonuaAgentRuntime,
  call: HonuaAgentToolCall,
  options: HonuaAgentToolExecutorOptions = {},
): Promise<HonuaAgentToolResult> {
  const definition = getHonuaAgentToolDefinition(call.name);
  const args = enforceMaxResults(
    call.name,
    ((call as { readonly args?: unknown }).args ?? {}) as Readonly<Record<string, unknown>>,
    options,
  );
  const deniedReason = deniedToolReason(definition, args, options);
  if (deniedReason) {
    return result(call.name, "denied", args, options, { deniedReason });
  }

  const dryRun = isDryRun(args, options);
  try {
    switch (call.name) {
      case "inspectMap":
        return result(call.name, "ok", args, options, {
          data: sanitizeMapSnapshot(await inspectMap(runtime, call.args)),
        });
      case "listSources":
        return result(call.name, "ok", args, options, {
          data: (await listSources(runtime, call.args)).map(sanitizeSourceSummary),
        });
      case "listCapabilities":
        return result(call.name, "ok", args, options, { data: await listCapabilities(runtime, call.args) });
      case "setViewport":
        if (dryRun)
          return result(call.name, "dry-run", args, options, {
            data: { viewport: viewportFromArgs(args as SetViewportArgs) },
          });
        requireRuntimeMethod(runtime.setViewport, call.name);
        return result(call.name, "ok", args, options, {
          data: await runtime.setViewport(viewportFromArgs(args as SetViewportArgs)),
        });
      case "addLayer":
        if (dryRun)
          return result(call.name, "dry-run", args, options, {
            data: { layer: (args as unknown as AddLayerArgs).layer },
          });
        requireRuntimeMethod(runtime.addLayer, call.name);
        return result(call.name, "ok", args, options, {
          data: await runtime.addLayer(
            (args as unknown as AddLayerArgs).layer,
            (args as unknown as AddLayerArgs).beforeId,
          ),
        });
      case "setFilter":
        if (dryRun)
          return result(call.name, "dry-run", args, options, {
            data: { id: (args as unknown as SetFilterArgs).id, clause: (args as unknown as SetFilterArgs).clause },
          });
        requireRuntimeMethod(runtime.setFilter, call.name);
        return result(call.name, "ok", args, options, {
          data: await runtime.setFilter(
            (args as unknown as SetFilterArgs).id,
            (args as unknown as SetFilterArgs).clause,
          ),
        });
      case "selectFeature": {
        const selectArgs = args as unknown as SelectFeatureArgs;
        const target = sourceFeatureSelectionTarget(selectArgs.sourceId, selectArgs.id);
        if (dryRun) return result(call.name, "dry-run", args, options, { data: { target } });
        requireRuntimeMethod(runtime.selectFeature, call.name);
        return result(call.name, "ok", args, options, {
          data: await runtime.selectFeature(target, { replace: selectArgs.replace ?? true }),
        });
      }
      case "summarizeSelection":
        return result(call.name, "ok", args, options, { data: await summarizeSelection(runtime, call.args) });
      case "runWidgetQuery":
        requireRuntimeMethod(runtime.runWidgetQuery, call.name);
        return result(call.name, "ok", args, options, {
          data: await runtime.runWidgetQuery(args as unknown as RunWidgetQueryArgs),
        });
      case "explainCapabilityGap":
        return result(call.name, "ok", args, options, { data: await explainCapabilityGap(runtime, call.args) });
    }
  } catch (error) {
    return result(call.name, "error", args, options, {
      data: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function explainHonuaCapabilityGap(input: ExplainCapabilityGapArgs): {
  readonly supported: boolean;
  readonly sourceId?: SourceId;
  readonly protocol?: Protocol;
  readonly capability: Capability;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly message: string;
  readonly suggestedAction: string;
} {
  const capabilities = capabilitiesFor(input);
  const supported = capabilities.includes(input.capability);
  return {
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.protocol ? { protocol: input.protocol } : {}),
    capability: input.capability,
    capabilities,
    supported,
    message: supported
      ? capabilitySupportedMessage(input)
      : `Capability "${input.capability}" is not advertised${input.protocol ? ` for protocol "${input.protocol}"` : ""}.`,
    suggestedAction: supported
      ? "Run the requested operation through the source runtime and preserve capability metadata in audit output."
      : "Choose a source that advertises the capability, use a protocol-specific escape hatch, or return a degraded result with an explicit reason.",
  };
}

async function inspectMap(runtime: HonuaAgentRuntime, args: InspectMapArgs = {}): Promise<HonuaAgentMapSnapshot> {
  const snapshot = runtime.inspectMap ? await runtime.inspectMap(args) : await runtimeSnapshot(runtime);
  return {
    ...snapshot,
    sources: args.includeSources === false ? [] : snapshot.sources,
    layers: args.includeLayers === false ? [] : snapshot.layers,
    selection: args.includeSelection === false ? [] : snapshot.selection,
  };
}

async function runtimeSnapshot(runtime: HonuaAgentRuntime): Promise<HonuaAgentMapSnapshot> {
  const snapshot = runtime.snapshot ? await runtime.snapshot() : {};
  const [viewport, sources, layers, selection] = await Promise.all([
    snapshot.viewport ?? runtime.getViewport?.(),
    snapshot.sources ?? runtime.listSources?.(),
    snapshot.layers ?? runtime.listLayers?.(),
    snapshot.selection ?? runtime.getSelection?.(),
  ]);
  return {
    appId: snapshot.appId ?? runtime.id,
    ...(snapshot.mapPackageId ? { mapPackageId: snapshot.mapPackageId } : {}),
    ...(snapshot.snapshotTimestamp ? { snapshotTimestamp: snapshot.snapshotTimestamp } : {}),
    ...(snapshot.sourceVersion ? { sourceVersion: snapshot.sourceVersion } : {}),
    ...(viewport ? { viewport } : {}),
    sources: sources ?? [],
    layers: layers ?? [],
    selection: selection ?? [],
    ...(snapshot.filters ? { filters: snapshot.filters } : {}),
    ...(snapshot.realtime ? { realtime: snapshot.realtime } : {}),
    ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}),
  };
}

async function listSources(
  runtime: HonuaAgentRuntime,
  args: ListSourcesArgs = {},
): Promise<ReadonlyArray<HonuaAgentSourceSummary>> {
  const sources = runtime.listSources ? await runtime.listSources() : (await runtimeSnapshot(runtime)).sources;
  return args.sourceId ? sources.filter((source) => source.id === args.sourceId) : sources;
}

async function listCapabilities(runtime: HonuaAgentRuntime, args: ListCapabilitiesArgs = {}) {
  const sources = await listSources(runtime, { sourceId: args.sourceId });
  return sources.map((source) => ({
    sourceId: source.id,
    ...(source.protocol ? { protocol: source.protocol } : {}),
    capabilities: capabilitiesFor(source),
  }));
}

async function explainCapabilityGap(runtime: HonuaAgentRuntime, args: ExplainCapabilityGapArgs) {
  if (args.declaredCapabilities || args.protocol) return explainHonuaCapabilityGap(args);
  const source = args.sourceId ? (await listSources(runtime, { sourceId: args.sourceId }))[0] : undefined;
  return explainHonuaCapabilityGap({
    ...args,
    ...(source?.protocol ? { protocol: source.protocol } : {}),
    ...(source?.capabilities ? { declaredCapabilities: source.capabilities } : {}),
  });
}

async function summarizeSelection(
  runtime: HonuaAgentRuntime,
  args: SummarizeSelectionArgs = {},
): Promise<HonuaAgentSelectionSummary> {
  if (runtime.summarizeSelection) {
    const summary = await runtime.summarizeSelection();
    return args.includeTargets === false ? { ...summary, targets: [] } : summary;
  }

  const targets = runtime.getSelection ? await runtime.getSelection() : (await runtimeSnapshot(runtime)).selection;
  const bySourceCounts = new Map<SourceId | "unqualified", number>();
  for (const target of targets) {
    const sourceId = isSourceQualifiedSelectionTarget(target) ? target.sourceId : "unqualified";
    bySourceCounts.set(sourceId, (bySourceCounts.get(sourceId) ?? 0) + 1);
  }
  return {
    count: targets.length,
    bySource: [...bySourceCounts.entries()].map(([sourceId, count]) => ({ sourceId, count })),
    targets: args.includeTargets === false ? [] : targets,
  };
}

function viewportFromArgs(args: SetViewportArgs): HonuaAgentViewport {
  const { dryRun: _dryRun, ...viewport } = args;
  return viewport;
}

function capabilitiesFor(input: {
  readonly protocol?: Protocol;
  readonly declaredCapabilities?: ReadonlyArray<Capability>;
  readonly capabilities?: ReadonlyArray<Capability>;
}): ReadonlyArray<Capability> {
  const declared = input.declaredCapabilities ?? input.capabilities;
  if (declared) return [...new Set(declared)].filter(isCapability);
  if (!input.protocol) return [];
  return [...PROTOCOL_DEFAULT_CAPABILITIES[input.protocol]].filter(isCapability);
}

function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && CAPABILITIES.includes(value as Capability);
}

function capabilitySupportedMessage(input: ExplainCapabilityGapArgs): string {
  const target = input.sourceId
    ? `source "${input.sourceId}"`
    : input.protocol
      ? `protocol "${input.protocol}"`
      : "source";
  return `Capability "${input.capability}" is advertised for ${target}.`;
}

function deniedToolReason(
  definition: HonuaAgentToolDefinition,
  args: Readonly<Record<string, unknown>>,
  options: HonuaAgentToolExecutorOptions,
): string | undefined {
  if (options.allowedTools && !options.allowedTools.includes(definition.name)) {
    return `Tool "${definition.name}" is not in the allowed tool list.`;
  }
  const sourceId = sourceIdFromParameters(args);
  if (sourceId && options.allowedSourceIds && !options.allowedSourceIds.includes(sourceId)) {
    return `Source "${sourceId}" is not in the allowed source list.`;
  }
  const layerId = layerIdFromParameters(args, definition.name);
  if (layerId && options.allowedLayerIds && !options.allowedLayerIds.includes(layerId)) {
    return `Layer "${layerId}" is not in the allowed layer list.`;
  }
  if (definition.mode === "action" && !options.allowActions && !isDryRun(args, options)) {
    return `Tool "${definition.name}" mutates runtime state and requires allowActions=true or dryRun=true.`;
  }
  return undefined;
}

function isDryRun(args: Readonly<Record<string, unknown>>, options: HonuaAgentToolExecutorOptions): boolean {
  return options.dryRun === true || args.dryRun === true;
}

function requireRuntimeMethod<T>(method: T | undefined, tool: HonuaAgentToolName): asserts method is T {
  if (typeof method === "function") return;
  throw new HonuaAgentToolError("missing-runtime-method", `Runtime does not implement tool "${tool}"`, { tool });
}

function result<TData>(
  tool: HonuaAgentToolName,
  status: HonuaAgentToolStatus,
  parameters: Readonly<Record<string, unknown>>,
  options: HonuaAgentToolExecutorOptions,
  extra: {
    readonly data?: TData;
    readonly deniedReason?: string;
    readonly degraded?: ReadonlyArray<HonuaAgentToolDegradedReason>;
  } = {},
): HonuaAgentToolResult<TData> {
  const audit = auditEvent(tool, status, parameters, options, extra.deniedReason);
  options.onAudit?.(audit);
  return {
    tool,
    status,
    ...(extra.data !== undefined ? { data: extra.data } : {}),
    ...(extra.deniedReason ? { deniedReason: extra.deniedReason } : {}),
    ...(extra.degraded ? { degraded: extra.degraded } : {}),
    audit,
  };
}

function auditEvent(
  tool: HonuaAgentToolName,
  status: HonuaAgentToolStatus,
  parameters: Readonly<Record<string, unknown>>,
  options: HonuaAgentToolExecutorOptions,
  message?: string,
): HonuaAgentAuditEvent {
  const definition = getHonuaAgentToolDefinition(tool);
  const sourceId = sourceIdFromParameters(parameters);
  const layerId = layerIdFromParameters(parameters, tool);
  const protocol =
    typeof parameters.protocol === "string" && PROTOCOLS.includes(parameters.protocol as Protocol)
      ? (parameters.protocol as Protocol)
      : undefined;
  const capability = isCapability(parameters.capability) ? parameters.capability : undefined;
  const dryRun = options.dryRun === true || parameters.dryRun === true || status === "dry-run";
  return {
    tool,
    ...(options.actor ? { actor: options.actor } : {}),
    status,
    dryRun,
    action: definition.mode === "action",
    ...(sourceId ? { sourceId } : {}),
    ...(layerId ? { layerId } : {}),
    ...(targetIdsFromParameters(parameters).length > 0 ? { targetIds: targetIdsFromParameters(parameters) } : {}),
    ...(protocol ? { protocol } : {}),
    ...(capability ? { capability } : {}),
    outcome: auditOutcome(status),
    parameters,
    ...(message ? { message } : {}),
    timestamp: options.now?.() ?? new Date().toISOString(),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function enforceMaxResults(
  tool: HonuaAgentToolName,
  parameters: Readonly<Record<string, unknown>>,
  options: HonuaAgentToolExecutorOptions,
): Readonly<Record<string, unknown>> {
  if (tool !== "runWidgetQuery" || options.maxResults === undefined) return parameters;
  const limit = typeof parameters.limit === "number" ? parameters.limit : undefined;
  if (limit === undefined || limit <= options.maxResults) return parameters;
  return { ...parameters, limit: options.maxResults };
}

function sourceIdFromParameters(parameters: Readonly<Record<string, unknown>>): SourceId | undefined {
  return typeof parameters.sourceId === "string" ? parameters.sourceId : undefined;
}

function layerIdFromParameters(
  parameters: Readonly<Record<string, unknown>>,
  tool?: HonuaAgentToolName,
): string | undefined {
  if (typeof parameters.layerId === "string") return parameters.layerId;
  const layer = asRecord(parameters.layer);
  if (typeof layer?.id === "string") return layer.id;
  return tool === "setFilter" && typeof parameters.id === "string" ? parameters.id : undefined;
}

function targetIdsFromParameters(parameters: Readonly<Record<string, unknown>>): ReadonlyArray<string> {
  const ids: string[] = [];
  if (parameters.id !== undefined && (typeof parameters.id === "string" || typeof parameters.id === "number")) {
    ids.push(String(parameters.id));
  }
  const layerId = layerIdFromParameters(parameters);
  if (layerId) ids.push(layerId);
  const sourceId = sourceIdFromParameters(parameters);
  if (sourceId) ids.push(sourceId);
  return [...new Set(ids)];
}

function auditOutcome(status: HonuaAgentToolStatus): HonuaAgentAuditEvent["outcome"] {
  if (status === "denied") return "denied";
  if (status === "dry-run") return "dry-run";
  if (status === "error") return "error";
  return "allowed";
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Redact secret-bearing metadata from a full map snapshot before it leaves the
 * tool executor for an LLM. `inspectMap` returns raw runtime metadata
 * (connection strings, tokens) on sources/layers/realtime/metadata; the
 * context/system-prompt path already sanitizes, but the executor result builder
 * did not, so tool results bypassed redaction.
 */
function sanitizeMapSnapshot(snapshot: HonuaAgentMapSnapshot): HonuaAgentMapSnapshot {
  return {
    ...snapshot,
    sources: snapshot.sources.map(sanitizeSourceSummary),
    layers: snapshot.layers.map(sanitizeLayerSummary),
    ...(snapshot.realtime ? { realtime: sanitizeRecord(snapshot.realtime) } : {}),
    ...(snapshot.metadata ? { metadata: sanitizeRecord(snapshot.metadata) } : {}),
  };
}

function sanitizeSourceSummary(source: HonuaAgentSourceSummary): HonuaAgentSourceSummary {
  return {
    id: source.id,
    ...(source.title ? { title: source.title } : {}),
    ...(source.protocol ? { protocol: source.protocol } : {}),
    ...(source.capabilities ? { capabilities: [...source.capabilities].filter(isCapability) } : {}),
    ...(source.metadata ? { metadata: sanitizeRecord(source.metadata) } : {}),
  };
}

function sanitizeLayerSummary(layer: HonuaAgentLayerSummary): HonuaAgentLayerSummary {
  return {
    id: layer.id,
    ...(layer.sourceId ? { sourceId: layer.sourceId } : {}),
    ...(layer.type ? { type: layer.type } : {}),
    ...(layer.title ? { title: layer.title } : {}),
    ...(layer.visible !== undefined ? { visible: layer.visible } : {}),
    ...(layer.metadata ? { metadata: sanitizeRecord(layer.metadata) } : {}),
  };
}

/**
 * Keys whose values are redacted from snapshot metadata before it leaves the
 * tool executor for an LLM. Covers tokens, passwords, API keys, bearer/auth
 * material, private keys/passphrases, and connection strings/DSNs — the latter
 * frequently embed `user:password@host` credentials. Matched case-insensitively
 * as a substring so e.g. `dbConnectionString`, `x-api-key`, `privateKey`, and
 * `connectionUri` are all caught.
 */
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passphrase|credential|apikey|api[-_ ]?key|authorization|auth|bearer|private[-_ ]?key|connection|connectionstring|connectionuri|dsn/i;

/**
 * Deeply redact secret-bearing fields from arbitrary metadata. Recurses into
 * plain objects and arrays so nested shapes such as
 * `{ database: { connectionString: "postgres://u:pw@h/db" } }` or
 * `{ auth: { token: "…" } }` are scrubbed rather than copied whole. Class
 * instances / exotic objects are passed through unchanged (they are not the
 * plain `Record<string, unknown>` runtime metadata shapes this guards), and
 * functions/`undefined` are dropped.
 */
function sanitizeRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return sanitizeValue(record) as Readonly<Record<string, unknown>>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      if (child === undefined || typeof child === "function") continue;
      sanitized[key] = sanitizeValue(child);
    }
    return sanitized;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function realtimeStateNote(snapshot: HonuaAgentMapSnapshot): string | undefined {
  if (!snapshot.realtime && !snapshot.snapshotTimestamp && !snapshot.sourceVersion) return undefined;
  const timestamp = snapshot.snapshotTimestamp ?? "unknown timestamp";
  const sourceVersion = snapshot.sourceVersion ?? "unknown source version";
  return `Snapshot timestamp: ${timestamp}; source version: ${sourceVersion}. Treat live state as bounded to this snapshot.`;
}

function safeToolExamples(
  sources: ReadonlyArray<HonuaAgentSourceSummary>,
  layers: ReadonlyArray<HonuaAgentLayerSummary>,
): HonuaAgentSemanticMapContext["safeExamples"] {
  const sourceId = sources[0]?.id ?? "source-id";
  const layerId = layers[0]?.id ?? "layer-id";
  return [
    {
      user: "What sources and capabilities are available?",
      toolCall: { name: "listCapabilities", args: { sourceId } },
    },
    {
      user: "Preview a map move without changing state.",
      toolCall: { name: "setViewport", args: { zoom: 12, dryRun: true } },
    },
    {
      user: "Apply a source-scoped equality filter after approval.",
      toolCall: {
        name: "setFilter",
        args: { id: layerId, clause: { field: "status", operator: "=", value: "open", appliesTo: [sourceId] } },
      },
    },
  ];
}

function firstWidgetId(runtime: HonuaGeneratedAppRuntimeLikeForAgents, kind: string): string | undefined {
  const widget = runtime.manifest?.layout?.widgets?.find((entry) => entry.kind === kind);
  return typeof widget?.id === "string" ? widget.id : undefined;
}

function bboxFromExtent(extent: HonuaExtent): readonly [number, number, number, number] {
  return [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
}
