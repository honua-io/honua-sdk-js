/**
 * Agent-facing tool schemas and executors for bounded map/runtime actions.
 *
 * The executor is intentionally runtime-agnostic: apps can adapt a
 * HonuaController, generated-app runtime, MapPackage runtime, or test double
 * to the small {@link HonuaAgentRuntime} interface. Tool definitions are plain
 * JSON Schema-compatible objects so they can be reused by MCP, provider-native
 * function calling, or local policy engines.
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
  readonly sourceId?: SourceId;
  readonly layerId?: string;
  readonly capability?: Capability;
  readonly protocol?: Protocol;
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
  readonly now?: () => string;
  readonly onAudit?: (event: HonuaAgentAuditEvent) => void;
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

export class HonuaAgentToolError extends Error {
  public readonly code: string;
  public readonly tool: HonuaAgentToolName | undefined;

  public constructor(code: string, message: string, options: { readonly tool?: HonuaAgentToolName } = {}) {
    super(message);
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
  const args = ((call as { readonly args?: unknown }).args ?? {}) as Readonly<Record<string, unknown>>;
  const deniedReason = deniedToolReason(definition, args, options);
  if (deniedReason) {
    return result(call.name, "denied", args, options, { deniedReason });
  }

  const dryRun = isDryRun(args, options);
  try {
    switch (call.name) {
      case "inspectMap":
        return result(call.name, "ok", args, options, { data: await inspectMap(runtime, call.args) });
      case "listSources":
        return result(call.name, "ok", args, options, { data: await listSources(runtime, call.args) });
      case "listCapabilities":
        return result(call.name, "ok", args, options, { data: await listCapabilities(runtime, call.args) });
      case "setViewport":
        if (dryRun)
          return result(call.name, "dry-run", args, options, { data: { viewport: viewportFromArgs(call.args) } });
        requireRuntimeMethod(runtime.setViewport, call.name);
        return result(call.name, "ok", args, options, { data: await runtime.setViewport(viewportFromArgs(call.args)) });
      case "addLayer":
        if (dryRun) return result(call.name, "dry-run", args, options, { data: { layer: call.args.layer } });
        requireRuntimeMethod(runtime.addLayer, call.name);
        return result(call.name, "ok", args, options, {
          data: await runtime.addLayer(call.args.layer, call.args.beforeId),
        });
      case "setFilter":
        if (dryRun)
          return result(call.name, "dry-run", args, options, { data: { id: call.args.id, clause: call.args.clause } });
        requireRuntimeMethod(runtime.setFilter, call.name);
        return result(call.name, "ok", args, options, {
          data: await runtime.setFilter(call.args.id, call.args.clause),
        });
      case "selectFeature": {
        const target = sourceFeatureSelectionTarget(call.args.sourceId, call.args.id);
        if (dryRun) return result(call.name, "dry-run", args, options, { data: { target } });
        requireRuntimeMethod(runtime.selectFeature, call.name);
        return result(call.name, "ok", args, options, {
          data: await runtime.selectFeature(target, { replace: call.args.replace ?? true }),
        });
      }
      case "summarizeSelection":
        return result(call.name, "ok", args, options, { data: await summarizeSelection(runtime, call.args) });
      case "runWidgetQuery":
        requireRuntimeMethod(runtime.runWidgetQuery, call.name);
        return result(call.name, "ok", args, options, { data: await runtime.runWidgetQuery(call.args) });
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
  const sourceId = typeof parameters.sourceId === "string" ? parameters.sourceId : undefined;
  const layerId =
    typeof parameters.layerId === "string"
      ? parameters.layerId
      : asRecord(parameters.layer)?.id && typeof asRecord(parameters.layer)?.id === "string"
        ? (asRecord(parameters.layer)?.id as string)
        : undefined;
  const protocol =
    typeof parameters.protocol === "string" && PROTOCOLS.includes(parameters.protocol as Protocol)
      ? (parameters.protocol as Protocol)
      : undefined;
  const capability = isCapability(parameters.capability) ? parameters.capability : undefined;
  return {
    tool,
    ...(options.actor ? { actor: options.actor } : {}),
    status,
    dryRun: options.dryRun === true || parameters.dryRun === true,
    ...(sourceId ? { sourceId } : {}),
    ...(layerId ? { layerId } : {}),
    ...(protocol ? { protocol } : {}),
    ...(capability ? { capability } : {}),
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
