/**
 * Explainable, dependency-free automatic Source -> MapLibre strategy selection.
 *
 * Planning is pure and renderer-neutral. Mounting consumes only the minimal
 * injected MapLibre host surface and delegates to the focused feature/raster
 * adapters where possible.
 */

import type { Source } from "../contract/types.js";
import { type HonuaErrorOptions, HonuaSdkError, mergeHonuaErrorContext } from "../core/error-envelope.js";
import { canonicalStringify, toJsonValue } from "../query-planner/canonical.js";
import { queryIrSourceIdentity } from "../query-planner/ir.js";
import { hashQueryPlan } from "../query-planner/planner.js";
import type { ExecuteQueryPlanOptions, QueryExecutionPlanV1 } from "../query-planner/types.js";
import {
  type MapLibreRasterStrategy,
  mountRasterSourceToMapLibre,
  projectRasterSourceToMapLibre,
} from "./raster-source-strategy.js";
import {
  type MapLibreGeometryKind,
  type MapLibreSourceWorkflowState,
  type SourceToMapLibreMap,
  mountSourceToMapLibre,
} from "./source-to-maplibre.js";

export const AUTOMATIC_MAPLIBRE_PLAN_KIND = "honua.maplibre-source-plan" as const;
export const AUTOMATIC_MAPLIBRE_PLAN_VERSION = "1.0" as const;
export const MAX_AUTOMATIC_GEOJSON_FEATURES = 100_000;

export type AutomaticMapLibreStrategy =
  | "geojson-query"
  | "vector-tiles"
  | "pmtiles-vector"
  | "pmtiles-raster"
  | "dynamic-query-tiles"
  | MapLibreRasterStrategy;

export type AutomaticMapLibreReasonCode =
  | "selected"
  | "eligible-not-selected"
  | "protocol-mismatch"
  | "capability-mismatch"
  | "missing-query-plan"
  | "unsupported-query-plan"
  | "plan-context-mismatch"
  | "unbounded-materialization"
  | "missing-metadata"
  | "unsafe-url"
  | "unsupported-crs"
  | "stale-evidence"
  | "override-mismatch";

export interface AutomaticMapLibreCandidate {
  readonly strategy: AutomaticMapLibreStrategy;
  readonly eligible: boolean;
  readonly reason: AutomaticMapLibreReasonCode;
  readonly fidelity: "exact" | "unsupported";
  readonly dataPath: "native" | "materialized";
  readonly requiredPeers: readonly ("maplibre-gl" | "pmtiles")[];
  readonly message: string;
}

export interface AutomaticMapLibreDiagnostic {
  readonly code: AutomaticMapLibreReasonCode;
  readonly severity: "info" | "warning" | "error";
  readonly strategy?: AutomaticMapLibreStrategy;
  readonly message: string;
}

export interface AutomaticMapLibreNativeSourceSpec {
  readonly type: "vector" | "raster";
  readonly tiles?: readonly string[];
  readonly url?: string;
  readonly scheme?: "xyz" | "tms";
  readonly tileSize?: number;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly bounds?: readonly [number, number, number, number];
  readonly attribution?: string;
  readonly promoteId?: string | Readonly<Record<string, string>>;
  readonly volatile?: boolean;
}

export interface ExplainAutomaticMapLibreOptions {
  /** Accepted, immutable query plan. Required for materialized GeoJSON. */
  readonly queryPlan?: QueryExecutionPlanV1;
  /** A source spec built by the dynamic-query-tile helpers. */
  readonly queryTileSource?: AutomaticMapLibreNativeSourceSpec;
  /** Required layer name for vector tile and vector PMTiles sources. */
  readonly sourceLayer?: string;
  /** Archive payload evidence obtained from PMTiles metadata. */
  readonly pmtilesType?: "vector" | "raster";
  readonly override?: AutomaticMapLibreStrategy;
  readonly sourceId?: string;
  readonly layerId?: string;
  readonly beforeId?: string;
  readonly geometry?: MapLibreGeometryKind | "auto";
  readonly paint?: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly tileSize?: number;
  readonly format?: string;
  readonly transparent?: boolean;
  /** Caller-observed metadata time and explicit freshness budget. */
  readonly evidence?: {
    readonly observedAt: string;
    readonly maxAgeMs: number;
    /** Explicit clock evidence keeps planning deterministic. */
    readonly now: string;
  };
}

export interface AutomaticMapLibrePlan {
  readonly kind: typeof AUTOMATIC_MAPLIBRE_PLAN_KIND;
  readonly version: typeof AUTOMATIC_MAPLIBRE_PLAN_VERSION;
  readonly id: string;
  readonly sourceId: string;
  readonly protocol: string;
  readonly selected?: AutomaticMapLibreCandidate;
  readonly candidates: readonly AutomaticMapLibreCandidate[];
  readonly diagnostics: readonly AutomaticMapLibreDiagnostic[];
  readonly bounds?: readonly [number, number, number, number];
  readonly freshness: Readonly<{
    mode: string;
    observedAt?: string;
    maxAgeMs?: number;
    stale: boolean;
  }>;
  readonly provenance: Readonly<{
    endpoint: string;
    sourceVersion?: string;
    schemaVersion?: string;
    authorizationScope: readonly string[];
    queryPlanId?: string;
    queryPlanFingerprint?: string;
  }>;
  readonly cache: "source-owned" | "immutable-archive" | "query-plan-bypass";
  readonly source?: AutomaticMapLibreNativeSourceSpec;
  readonly layers: readonly Readonly<Record<string, unknown>>[];
}

export type AutomaticMapLibreWorkflowState = MapLibreSourceWorkflowState | "cancelled";

export interface MountedAutomaticMapLibreSource {
  readonly strategy: AutomaticMapLibreStrategy;
  readonly sourceId: string;
  readonly layerIds: readonly string[];
  readonly state: AutomaticMapLibreWorkflowState;
  readonly diagnostics: readonly AutomaticMapLibreDiagnostic[];
  readonly ready: Promise<AutomaticMapLibrePlan>;
  refresh(options?: ExecuteQueryPlanOptions): Promise<AutomaticMapLibrePlan>;
  cancel(reason?: unknown): void;
  dispose(): void;
}

export type AutomaticMapLibreErrorCode =
  | "no-eligible-strategy"
  | "stale-plan"
  | "source-conflict"
  | "layer-conflict"
  | "map-mutation-failed"
  | "cancelled"
  | "disposed";

export class HonuaAutomaticMapLibreStrategyError extends HonuaSdkError {
  public constructor(
    public readonly code: AutomaticMapLibreErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(AUTOMATIC_MAPLIBRE_ERROR_CODES[code], message, {
      ...options,
      context: mergeHonuaErrorContext(detail, options.context),
    });
    this.name = "HonuaAutomaticMapLibreStrategyError";
  }
}

const AUTOMATIC_MAPLIBRE_ERROR_CODES = {
  "no-eligible-strategy": "map.automatic-strategy.no-eligible-strategy",
  "stale-plan": "map.automatic-strategy.stale-plan",
  "source-conflict": "map.automatic-strategy.source-conflict",
  "layer-conflict": "map.automatic-strategy.layer-conflict",
  "map-mutation-failed": "map.automatic-strategy.map-mutation-failed",
  cancelled: "map.automatic-strategy.cancelled",
  disposed: "map.automatic-strategy.disposed",
} as const satisfies Record<AutomaticMapLibreErrorCode, `map.automatic-strategy.${string}`>;

const STRATEGIES: readonly AutomaticMapLibreStrategy[] = [
  "dynamic-query-tiles",
  "pmtiles-vector",
  "pmtiles-raster",
  "vector-tiles",
  "native-raster-tiles",
  "wms-raster",
  "wmts-raster",
  "geojson-query",
];

/** Explain every strategy and select the first exact eligible candidate. */
export function explainAutomaticSourceToMapLibre<T>(
  source: Source<T>,
  options: ExplainAutomaticMapLibreOptions = {},
): AutomaticMapLibrePlan {
  const descriptor = source.descriptor;
  const stale = isStale(options.evidence);
  const candidates = STRATEGIES.map((strategy) => evaluateCandidate(strategy, source, options, stale));
  const selected = options.override
    ? candidates.find((candidate) => candidate.strategy === options.override && candidate.eligible)
    : candidates.find((candidate) => candidate.eligible);
  const diagnostics: AutomaticMapLibreDiagnostic[] = candidates.map((candidate) =>
    Object.freeze({
      code: candidate.eligible && candidate !== selected ? "eligible-not-selected" : candidate.reason,
      severity: candidate.eligible && candidate === selected ? "info" : candidate.eligible ? "warning" : "error",
      strategy: candidate.strategy,
      message:
        candidate.eligible && candidate !== selected
          ? `${candidate.message} A higher-priority exact strategy was selected.`
          : candidate.message,
    }),
  );
  if (options.override && !selected) {
    diagnostics.push(
      Object.freeze({
        code: "override-mismatch",
        severity: "error",
        strategy: options.override,
        message: `The explicit ${options.override} override is not eligible; no fallback was selected.`,
      }),
    );
  }

  const sourceId = options.sourceId ?? `honua-${safeId(descriptor.id)}`;
  const native = selected ? nativeProjection(selected.strategy, source, options, sourceId) : undefined;
  const queryPlan = options.queryPlan;
  const observedAt = options.evidence?.observedAt;
  return Object.freeze({
    kind: AUTOMATIC_MAPLIBRE_PLAN_KIND,
    version: AUTOMATIC_MAPLIBRE_PLAN_VERSION,
    id: `${AUTOMATIC_MAPLIBRE_PLAN_VERSION}:${safeId(descriptor.id)}:${selected?.strategy ?? "unsupported"}`,
    sourceId,
    protocol: descriptor.protocol,
    ...(selected ? { selected } : {}),
    candidates: Object.freeze(candidates),
    diagnostics: Object.freeze(diagnostics),
    ...(options.queryTileSource?.bounds ? { bounds: options.queryTileSource.bounds } : {}),
    freshness: Object.freeze({
      mode: descriptor.analytics?.freshness?.mode ?? (descriptor.protocol === "pmtiles" ? "snapshot" : "source-owned"),
      ...(observedAt ? { observedAt } : {}),
      ...(options.evidence ? { maxAgeMs: options.evidence.maxAgeMs } : {}),
      stale,
    }),
    provenance: Object.freeze({
      endpoint: credentialFreeEndpoint(descriptor.locator.url),
      sourceVersion: queryPlan?.ir.source.sourceVersion,
      schemaVersion: queryPlan?.ir.source.schemaVersion,
      authorizationScope: Object.freeze([...(queryPlan?.ir.source.authorizationScope ?? [])]),
      queryPlanId: queryPlan?.id,
      queryPlanFingerprint: queryPlan?.fingerprint,
    }),
    cache:
      selected?.strategy === "geojson-query"
        ? "query-plan-bypass"
        : selected?.strategy.startsWith("pmtiles")
          ? "immutable-archive"
          : "source-owned",
    ...(native ? { source: native.source, layers: native.layers } : { layers: Object.freeze([]) }),
  });
}

/** Mount an explained plan through one cross-strategy lifecycle. */
export async function mountAutomaticSourceToMapLibre<T>(
  map: SourceToMapLibreMap,
  source: Source<T>,
  plan: AutomaticMapLibrePlan,
  options: ExplainAutomaticMapLibreOptions & ExecuteQueryPlanOptions = {},
): Promise<MountedAutomaticMapLibreSource> {
  assertPlanContext(source, plan, options);
  if (options.signal?.aborted) {
    throw new HonuaAutomaticMapLibreStrategyError(
      "cancelled",
      "Automatic MapLibre mounting was cancelled before mutation.",
      { sourceId: plan.sourceId },
    );
  }
  const selected = plan.selected;
  if (!selected) {
    throw new HonuaAutomaticMapLibreStrategyError(
      "no-eligible-strategy",
      "The strategy plan has no eligible selection.",
      {
        sourceId: plan.sourceId,
        diagnostics: plan.diagnostics,
      },
    );
  }
  if (selected.strategy === "geojson-query") {
    if (!options.queryPlan) {
      throw new HonuaAutomaticMapLibreStrategyError(
        "no-eligible-strategy",
        "GeoJSON mounting requires its accepted query plan.",
      );
    }
    const mounted = await mountSourceToMapLibre(map, source, options.queryPlan, options);
    let cancelled = false;
    return {
      strategy: selected.strategy,
      sourceId: mounted.sourceId,
      layerIds: mounted.layerIds,
      get state() {
        return cancelled ? "cancelled" : mounted.state;
      },
      get diagnostics() {
        return plan.diagnostics;
      },
      ready: Promise.resolve(plan),
      async refresh(refreshOptions = {}) {
        await mounted.refresh(refreshOptions);
        return plan;
      },
      cancel() {
        if (mounted.state === "disposed") return;
        cancelled = true;
        mounted.dispose();
      },
      dispose() {
        mounted.dispose();
      },
    };
  }

  if (isRasterStrategy(selected.strategy)) {
    const mounted = mountRasterSourceToMapLibre(map, source.descriptor, options);
    return staticLifecycle(plan, mounted.sourceId, [mounted.layerId], () => mounted.dispose());
  }

  return mountNative(map, plan, options.beforeId);
}

function evaluateCandidate<T>(
  strategy: AutomaticMapLibreStrategy,
  source: Source<T>,
  options: ExplainAutomaticMapLibreOptions,
  stale: boolean,
): AutomaticMapLibreCandidate {
  const dataPath = strategy === "geojson-query" ? "materialized" : "native";
  const peers = strategy.startsWith("pmtiles") ? (["maplibre-gl", "pmtiles"] as const) : (["maplibre-gl"] as const);
  const reject = (reason: AutomaticMapLibreReasonCode, message: string): AutomaticMapLibreCandidate =>
    Object.freeze({
      strategy,
      eligible: false,
      reason,
      fidelity: "unsupported",
      dataPath,
      requiredPeers: peers,
      message,
    });
  if (stale) return reject("stale-evidence", "Caller-supplied strategy evidence is stale.");
  if (!sameStrings(source.capabilities, source.descriptor.capabilities)) {
    return reject("capability-mismatch", "Runtime and descriptor capability evidence do not match.");
  }
  if (!supportedCrs(source.descriptor.locator.srsName)) {
    return reject(
      "unsupported-crs",
      `CRS ${String(source.descriptor.locator.srsName)} is not WebMercator/WGS84 compatible.`,
    );
  }
  if (strategy === "geojson-query") {
    if (!source.capabilities.has("query")) return reject("capability-mismatch", "The source does not advertise query.");
    const plan = options.queryPlan;
    if (!plan) return reject("missing-query-plan", "No accepted feature query plan was supplied.");
    if (!queryPlanMatchesSource(source, plan)) {
      return reject(
        "plan-context-mismatch",
        "The accepted query plan does not match current source identity or capabilities.",
      );
    }
    const step = plan.steps[0];
    if (
      plan.steps.length !== 1 ||
      plan.ir.query.aggregation !== undefined ||
      plan.ir.query.returnGeometry === false ||
      step?.engine !== "remote" ||
      step.operation !== "query"
    ) {
      return reject("unsupported-query-plan", "The accepted plan is not one remote geometry-bearing feature query.");
    }
    const limit = plan.ir.query.pagination?.limit;
    if (!Number.isSafeInteger(limit) || (limit ?? 0) < 1 || (limit ?? 0) > MAX_AUTOMATIC_GEOJSON_FEATURES) {
      return reject(
        "unbounded-materialization",
        `GeoJSON materialization requires a 1-${MAX_AUTOMATIC_GEOJSON_FEATURES} feature limit.`,
      );
    }
  } else if (strategy === "dynamic-query-tiles") {
    if (!options.queryTileSource)
      return reject("missing-metadata", "No accepted dynamic query-tile source spec was supplied.");
    if (!source.capabilities.has("tiles")) return reject("capability-mismatch", "The source does not advertise tiles.");
    if (!safeNativeSpec(options.queryTileSource))
      return reject("unsafe-url", "The query-tile source contains an unsafe URL.");
    if (!nonEmpty(options.sourceLayer))
      return reject("missing-metadata", "Vector rendering requires sourceLayer metadata.");
  } else if (strategy === "vector-tiles") {
    if (source.descriptor.protocol !== "maplibre-vector" && source.descriptor.protocol !== "ogc-tiles") {
      return reject("protocol-mismatch", "The protocol is not a native vector-tile protocol.");
    }
    if (!source.capabilities.has("tiles")) return reject("capability-mismatch", "The source does not advertise tiles.");
    if (!safeHttpUrl(source.descriptor.locator.url)) return reject("unsafe-url", "The vector tile URL is unsafe.");
    if (!nonEmpty(options.sourceLayer))
      return reject("missing-metadata", "Vector rendering requires sourceLayer metadata.");
  } else if (strategy === "pmtiles-vector" || strategy === "pmtiles-raster") {
    if (source.descriptor.protocol !== "pmtiles") return reject("protocol-mismatch", "The protocol is not PMTiles.");
    const expected = strategy === "pmtiles-vector" ? "vector" : "raster";
    if (options.pmtilesType !== expected)
      return reject("missing-metadata", `Accepted PMTiles ${expected} payload evidence is required.`);
    if (!source.capabilities.has("tiles")) return reject("capability-mismatch", "The source does not advertise tiles.");
    if (!safePmtilesUrl(source.descriptor.locator.url))
      return reject("unsafe-url", "The PMTiles archive URL is unsafe.");
    if (expected === "vector" && !nonEmpty(options.sourceLayer))
      return reject("missing-metadata", "Vector PMTiles requires sourceLayer metadata.");
  } else {
    const protocol =
      strategy === "native-raster-tiles" ? "maplibre-raster" : strategy === "wms-raster" ? "wms" : "wmts";
    if (source.descriptor.protocol !== protocol) return reject("protocol-mismatch", `The protocol is not ${protocol}.`);
    if (!source.capabilities.has("tiles") || !source.capabilities.has("render")) {
      return reject("capability-mismatch", "Raster selection requires tiles and render capabilities.");
    }
    if (!safeHttpUrl(source.descriptor.locator.url)) return reject("unsafe-url", "The raster endpoint URL is unsafe.");
    try {
      projectRasterSourceToMapLibre(source.descriptor, options);
    } catch {
      return reject("missing-metadata", `Metadata required by ${strategy} is missing or invalid.`);
    }
  }
  return Object.freeze({
    strategy,
    eligible: true,
    reason: "selected",
    fidelity: "exact",
    dataPath,
    requiredPeers: peers,
    message: `Exact ${strategy} strategy is eligible.`,
  });
}

function nativeProjection<T>(
  strategy: AutomaticMapLibreStrategy,
  source: Source<T>,
  options: ExplainAutomaticMapLibreOptions,
  sourceId: string,
): { source: AutomaticMapLibreNativeSourceSpec; layers: readonly Readonly<Record<string, unknown>>[] } | undefined {
  if (strategy === "geojson-query") return undefined;
  if (isRasterStrategy(strategy)) {
    const projection = projectRasterSourceToMapLibre(source.descriptor, options);
    return {
      source: Object.freeze({ ...projection.source }),
      layers: Object.freeze([projection.layer]),
    };
  }
  const vector = strategy !== "pmtiles-raster";
  let spec: AutomaticMapLibreNativeSourceSpec;
  if (strategy === "dynamic-query-tiles") {
    spec = Object.freeze({ ...options.queryTileSource }) as AutomaticMapLibreNativeSourceSpec;
  } else if (strategy.startsWith("pmtiles")) {
    spec = Object.freeze({
      type: vector ? "vector" : "raster",
      url: toPmtilesUrl(source.descriptor.locator.url),
      ...(source.descriptor.attribution ? { attribution: source.descriptor.attribution } : {}),
    });
  } else {
    spec = Object.freeze({
      type: "vector",
      tiles: Object.freeze([source.descriptor.locator.url]),
      ...(source.descriptor.attribution ? { attribution: source.descriptor.attribution } : {}),
    });
  }
  const layerId = options.layerId ?? `${sourceId}-${vector ? "features" : "raster"}`;
  const layer = Object.freeze({
    id: layerId,
    type: vector ? "fill" : "raster",
    source: sourceId,
    ...(vector ? { "source-layer": options.sourceLayer } : {}),
    ...(options.minzoom !== undefined ? { minzoom: options.minzoom } : {}),
    ...(options.maxzoom !== undefined ? { maxzoom: options.maxzoom } : {}),
    ...(options.paint ? { paint: { ...options.paint } } : {}),
    ...(options.layout ? { layout: { ...options.layout } } : {}),
    metadata: { "honua:strategy": strategy },
  });
  return { source: spec, layers: Object.freeze([layer]) };
}

function mountNative(
  map: SourceToMapLibreMap,
  plan: AutomaticMapLibrePlan,
  beforeId?: string,
): MountedAutomaticMapLibreSource {
  if (!plan.source)
    throw new HonuaAutomaticMapLibreStrategyError("no-eligible-strategy", "Native source projection is missing.");
  if (map.getSource(plan.sourceId) !== undefined)
    throw new HonuaAutomaticMapLibreStrategyError("source-conflict", `Source ${plan.sourceId} already exists.`);
  const layerIds = plan.layers.map((layer) => String(layer.id));
  for (const layerId of layerIds) {
    if (map.getLayer(layerId) !== undefined)
      throw new HonuaAutomaticMapLibreStrategyError("layer-conflict", `Layer ${layerId} already exists.`);
  }
  const attempted: string[] = [];
  try {
    map.addSource(plan.sourceId, plan.source);
    for (const layer of plan.layers) {
      attempted.push(String(layer.id));
      map.addLayer(layer, beforeId);
    }
  } catch (cause) {
    for (const layerId of [...attempted].reverse()) {
      try {
        if (map.getLayer(layerId) !== undefined) map.removeLayer(layerId);
      } catch {
        /* best effort rollback */
      }
    }
    try {
      if (map.getSource(plan.sourceId) !== undefined) map.removeSource(plan.sourceId);
    } catch {
      /* best effort rollback */
    }
    throw new HonuaAutomaticMapLibreStrategyError(
      "map-mutation-failed",
      `Failed to mount ${plan.sourceId} transactionally.`,
      { sourceId: plan.sourceId },
      { cause },
    );
  }
  return staticLifecycle(plan, plan.sourceId, layerIds, () => {
    for (const layerId of [...layerIds].reverse()) if (map.getLayer(layerId) !== undefined) map.removeLayer(layerId);
    if (map.getSource(plan.sourceId) !== undefined) map.removeSource(plan.sourceId);
  });
}

function staticLifecycle(
  plan: AutomaticMapLibrePlan,
  sourceId: string,
  layerIds: readonly string[],
  cleanup: () => void,
): MountedAutomaticMapLibreSource {
  let state: AutomaticMapLibreWorkflowState = "ready";
  const dispose = () => {
    if (state === "disposed" || state === "cancelled") return;
    state = "disposed";
    cleanup();
  };
  return {
    strategy: plan.selected?.strategy ?? "geojson-query",
    sourceId,
    layerIds,
    get state() {
      return state;
    },
    diagnostics: plan.diagnostics,
    ready: Promise.resolve(plan),
    async refresh() {
      if (state === "disposed" || state === "cancelled")
        throw new HonuaAutomaticMapLibreStrategyError("disposed", "Cannot refresh a disposed automatic mount.");
      return plan;
    },
    cancel() {
      if (state === "disposed" || state === "cancelled") return;
      state = "cancelled";
      cleanup();
    },
    dispose,
  };
}

function assertPlanContext<T>(
  source: Source<T>,
  plan: AutomaticMapLibrePlan,
  options: ExplainAutomaticMapLibreOptions,
): void {
  const current = explainAutomaticSourceToMapLibre(source, options);
  if (
    plan.kind !== AUTOMATIC_MAPLIBRE_PLAN_KIND ||
    plan.version !== AUTOMATIC_MAPLIBRE_PLAN_VERSION ||
    plan.id !== current.id ||
    plan.sourceId !== current.sourceId ||
    plan.protocol !== source.descriptor.protocol ||
    plan.selected?.strategy !== current.selected?.strategy ||
    plan.provenance.endpoint !== current.provenance.endpoint ||
    plan.provenance.queryPlanFingerprint !== current.provenance.queryPlanFingerprint ||
    canonicalStringify(toJsonValue(plan.source ?? null)) !== canonicalStringify(toJsonValue(current.source ?? null)) ||
    canonicalStringify(toJsonValue(plan.layers)) !== canonicalStringify(toJsonValue(current.layers))
  ) {
    throw new HonuaAutomaticMapLibreStrategyError(
      "stale-plan",
      "The automatic strategy plan no longer matches its source and policy context.",
    );
  }
}

function isRasterStrategy(strategy: AutomaticMapLibreStrategy): strategy is MapLibreRasterStrategy {
  return strategy === "native-raster-tiles" || strategy === "wms-raster" || strategy === "wmts-raster";
}

function queryPlanMatchesSource<T>(source: Source<T>, plan: QueryExecutionPlanV1): boolean {
  try {
    if (hashQueryPlan(plan) !== plan.fingerprint) return false;
    const identity = queryIrSourceIdentity(source.descriptor, {
      schemaVersion: plan.ir.source.schemaVersion,
      sourceVersion: plan.ir.source.sourceVersion,
      authorizationScope: plan.ir.source.authorizationScope,
    });
    return (
      canonicalStringify(toJsonValue(identity)) === canonicalStringify(toJsonValue(plan.ir.source)) &&
      sameStrings(source.capabilities, plan.ir.source.capabilities)
    );
  } catch {
    return false;
  }
}

function sameStrings(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isStale(evidence: ExplainAutomaticMapLibreOptions["evidence"]): boolean {
  if (!evidence || !Number.isFinite(evidence.maxAgeMs) || evidence.maxAgeMs < 0) return evidence !== undefined;
  const observed = Date.parse(evidence.observedAt);
  const now = Date.parse(evidence.now);
  return !Number.isFinite(observed) || !Number.isFinite(now) || now - observed > evidence.maxAgeMs;
}

function supportedCrs(crs: string | number | undefined): boolean {
  if (crs === undefined) return true;
  const normalized = String(crs).toUpperCase();
  return (
    normalized === "4326" ||
    normalized === "3857" ||
    normalized.includes("EPSG::4326") ||
    normalized.includes("EPSG:4326") ||
    normalized.includes("EPSG::3857") ||
    normalized.includes("EPSG:3857") ||
    normalized.includes("CRS84") ||
    normalized === "WEBMERCATORQUAD"
  );
}

function safeNativeSpec(spec: AutomaticMapLibreNativeSourceSpec): boolean {
  const urls = [...(spec.tiles ?? []), ...(spec.url ? [spec.url] : [])];
  return urls.length > 0 && urls.every(safeHttpUrl);
}

function safePmtilesUrl(value: string): boolean {
  return safeHttpUrl(value.startsWith("pmtiles://") ? value.slice("pmtiles://".length) : value);
}

function safeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return false;
    for (const key of url.searchParams.keys())
      if (/^(token|access_token|api_key|apikey|key|signature|sig)$/i.test(key)) return false;
    return true;
  } catch {
    return false;
  }
}

function credentialFreeEndpoint(value: string): string {
  const raw = value.startsWith("pmtiles://") ? value.slice("pmtiles://".length) : value;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

function toPmtilesUrl(value: string): string {
  return value.startsWith("pmtiles://") ? value : `pmtiles://${value}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .join("-");
  return normalized || "source";
}
