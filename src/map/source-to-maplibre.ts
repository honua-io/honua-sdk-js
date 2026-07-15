/**
 * Plan-bound canonical Source → MapLibre GeoJSON workflow.
 *
 * This module is peer-injected and safe to import in Node/SSR/worker code: it
 * never imports `maplibre-gl`. The first production slice deliberately covers
 * exact feature-query plans; tile and realtime strategies remain separate.
 */

import type { Result, Source } from "../contract/types.js";
import {
  type HonuaErrorOptions,
  HonuaSdkError,
  mergeHonuaErrorContext,
  withHonuaErrorClassification,
} from "../core/error-base.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import { canonicalStringify, toJsonValue } from "../query-planner/canonical.js";
import { queryFromCanonical, queryIrSourceIdentity } from "../query-planner/ir.js";
import { hashQueryPlanV1 } from "../query-planner/planner.js";
import {
  type ExecuteQueryPlanOptions,
  HonuaQueryPlanExecutionError,
  type QueryExecutionPlanV1,
} from "../query-planner/types.js";
import type { AdapterGeoJsonFeatureCollection } from "./feature-service-adapter.js";
import {
  type MapLibreGeometryKind,
  canonicalFeaturesToGeoJson,
  defaultPaint,
  geometryKind,
  geometryKinds,
  layerType,
  mapLibreGeometryType,
  removeUndefined,
  safeId,
} from "./geojson-projection.js";

export type MapLibreSourceStrategy = "geojson-query";
export type { MapLibreGeometryKind } from "./geojson-projection.js";
export type MapLibreSourceWorkflowState = "ready" | "empty" | "degraded" | "disposed";

export type MapLibreSourceDiagnosticCode =
  | "strategy-selected"
  | "empty-result"
  | "transfer-limit"
  | "source-degraded"
  | "geometry-unsupported"
  | "geometry-mismatch"
  | "mixed-geometry"
  | "incremental-update"
  | "incremental-update-failed";

export interface MapLibreSourceDiagnostic {
  readonly code: MapLibreSourceDiagnosticCode;
  readonly severity: "info" | "warning";
  readonly stage: "project" | "execute" | "update";
  readonly fidelity: "exact" | "equivalent" | "unsupported";
  readonly sourceId: string;
  readonly planId: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type MapLibreSourceAdapterErrorCode =
  | "disposed"
  | "source-conflict"
  | "layer-conflict"
  | "unsupported-plan"
  | "invalid-option"
  | "map-mutation-failed";

/** A stable, machine-readable adapter failure. */
export class HonuaMapLibreSourceAdapterError extends HonuaSdkError {
  public constructor(
    public readonly code: MapLibreSourceAdapterErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(
      MAPLIBRE_SOURCE_ADAPTER_CODES[code],
      message,
      withHonuaErrorClassification(
        { ...options, context: mergeHonuaErrorContext(detail, options.context) },
        "map",
        code === "unsupported-plan" ? "capability" : code === "map-mutation-failed" ? "internal" : "validation",
        false,
      ),
    );
    this.name = "HonuaMapLibreSourceAdapterError";
  }
}

const MAPLIBRE_SOURCE_ADAPTER_CODES = {
  disposed: "map.source-adapter.disposed",
  "source-conflict": "map.source-adapter.source-conflict",
  "layer-conflict": "map.source-adapter.layer-conflict",
  "unsupported-plan": "map.source-adapter.unsupported-plan",
  "invalid-option": "map.source-adapter.invalid-option",
  "map-mutation-failed": "map.source-adapter.map-mutation-failed",
} as const satisfies Record<MapLibreSourceAdapterErrorCode, `map.source-adapter.${string}`>;

/** Minimal injected MapLibre map surface. */
export interface SourceToMapLibreMap {
  getSource(id: string): unknown;
  addSource(id: string, source: unknown): void;
  removeSource(id: string): void;
  getLayer(id: string): unknown;
  addLayer(layer: unknown, beforeId?: string): void;
  removeLayer(id: string): void;
}

interface GeoJsonSourceHandle {
  setData(data: AdapterGeoJsonFeatureCollection): void;
}

export interface ProjectSourceToMapLibreOptions {
  readonly sourceId?: string;
  readonly layerId?: string;
  readonly beforeId?: string;
  readonly geometry?: MapLibreGeometryKind | "auto";
  readonly cluster?: boolean;
  readonly clusterRadius?: number;
  readonly attribution?: string;
  readonly paint?: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
}

export interface MapLibreSourceProjection {
  readonly strategy: MapLibreSourceStrategy;
  readonly sourceId: string;
  readonly layerId: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly sourceVersion?: string;
  readonly schemaVersion?: string;
  readonly authorizationScope: readonly string[];
  readonly source: Readonly<Record<string, unknown>>;
  readonly layers: readonly Readonly<Record<string, unknown>>[];
  readonly diagnostics: readonly MapLibreSourceDiagnostic[];
  readonly state: Exclude<MapLibreSourceWorkflowState, "disposed">;
}

export interface MountSourceToMapLibreOptions extends ProjectSourceToMapLibreOptions, ExecuteQueryPlanOptions {}

export interface MountedMapLibreSource {
  readonly strategy: MapLibreSourceStrategy;
  readonly sourceId: string;
  readonly layerIds: readonly string[];
  readonly planId: string;
  readonly planFingerprint: string;
  readonly state: MapLibreSourceWorkflowState;
  readonly diagnostics: readonly MapLibreSourceDiagnostic[];
  refresh(options?: ExecuteQueryPlanOptions): Promise<MapLibreSourceProjection>;
  dispose(): void;
}

/**
 * Project an already-executed plan result into native MapLibre source/layers.
 * This function is deterministic and does not mutate a map.
 */
export function projectSourceToMapLibre<T>(
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  result: Result<T>,
  options: ProjectSourceToMapLibreOptions = {},
): MapLibreSourceProjection {
  assertProjectionPlanContext(source, plan);
  assertFeaturePlan(plan, result);
  assertQueryable(source);
  validateStaticOptions(options);
  const sourceId = options.sourceId ?? `honua-${safeId(source.descriptor.id)}`;
  const layerId = options.layerId ?? `${sourceId}-features`;
  const converted = canonicalFeaturesToGeoJson(result.features, source.descriptor.schema?.primaryKey);
  const presentKinds = geometryKinds(converted.data.features);
  const requestedKind = options.geometry === "auto" || options.geometry === undefined ? undefined : options.geometry;
  // Auto mode installs a stable three-layer geometry matrix. Refresh can then
  // move between geometry kinds through setData without structural layer churn.
  const renderKinds: readonly MapLibreGeometryKind[] = requestedKind
    ? [requestedKind]
    : options.cluster
      ? ["point"]
      : ["point", "line", "polygon"];
  if (
    options.cluster &&
    (requestedKind !== undefined ? requestedKind !== "point" : presentKinds.some((kind) => kind !== "point"))
  ) {
    throw new HonuaMapLibreSourceAdapterError(
      "invalid-option",
      "MapLibre clustering is supported only for point GeoJSON sources.",
      { sourceId, geometryKinds: renderKinds },
    );
  }

  const diagnostics: MapLibreSourceDiagnostic[] = [
    diagnostic(
      source,
      plan,
      "strategy-selected",
      "info",
      "project",
      "exact",
      "Selected exact bounded GeoJSON query strategy.",
    ),
  ];
  if (result.features.length === 0) {
    diagnostics.push(
      diagnostic(source, plan, "empty-result", "info", "execute", "exact", "The accepted plan returned no features.", {
        rowCount: 0,
      }),
    );
  }
  if (result.exceededTransferLimit) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "transfer-limit",
        "warning",
        "execute",
        "equivalent",
        "The accepted bounded query returned a page while additional source rows exist.",
        { renderedRowCount: result.features.length },
      ),
    );
  }
  if (result.degraded && result.degraded.length > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "source-degraded",
        "warning",
        "execute",
        "equivalent",
        "The source reported degraded execution semantics.",
        { reasons: result.degraded.map((entry) => entry.reason) },
      ),
    );
  }
  if (converted.unsupported > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "geometry-unsupported",
        "warning",
        "project",
        "unsupported",
        `${converted.unsupported} feature geometry value(s) could not be projected and remain attribute-only.`,
        { unsupportedGeometryCount: converted.unsupported },
      ),
    );
  }
  const mismatchedGeometryCount = requestedKind
    ? converted.data.features.filter((feature) => {
        const kind = geometryKind(feature.geometry);
        return kind !== undefined && kind !== requestedKind;
      }).length
    : 0;
  if (requestedKind && mismatchedGeometryCount > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "geometry-mismatch",
        "warning",
        "project",
        "unsupported",
        `${mismatchedGeometryCount} feature(s) do not match the explicit ${requestedKind} geometry layer and will not render.`,
        {
          requestedGeometry: requestedKind,
          mismatchedGeometryCount,
          renderedGeometryCount: result.features.length - mismatchedGeometryCount - converted.unsupported,
        },
      ),
    );
  }
  if (presentKinds.length > 1 && !requestedKind) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "mixed-geometry",
        "warning",
        "project",
        "equivalent",
        "Mixed geometry output uses one filtered layer per geometry kind.",
        {
          geometryKinds: presentKinds,
        },
      ),
    );
  }

  const mapSource: Record<string, unknown> = {
    type: "geojson",
    data: converted.data,
    promoteId: source.descriptor.schema?.primaryKey,
    attribution: options.attribution ?? source.descriptor.attribution,
    ...(options.cluster
      ? { cluster: true, clusterRadius: positiveInteger(options.clusterRadius, 50, "clusterRadius") }
      : {}),
  };
  removeUndefined(mapSource);

  return Object.freeze({
    strategy: "geojson-query" as const,
    sourceId,
    layerId,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    sourceVersion: plan.ir.source.sourceVersion,
    schemaVersion: plan.ir.source.schemaVersion,
    authorizationScope: plan.ir.source.authorizationScope,
    source: Object.freeze(mapSource),
    layers: Object.freeze(
      renderKinds.map((kind, index) =>
        Object.freeze({
          id: renderKinds.length === 1 ? layerId : `${layerId}-${kind}`,
          type: layerType(kind),
          source: sourceId,
          filter: ["==", ["geometry-type"], mapLibreGeometryType(kind)],
          paint: { ...defaultPaint(kind), ...(options.paint ?? {}) },
          ...(options.layout ? { layout: { ...options.layout } } : {}),
          metadata: {
            "honua:strategy": "geojson-query",
            "honua:planId": plan.id,
            "honua:planFingerprint": plan.fingerprint,
            "honua:sourceVersion": plan.ir.source.sourceVersion,
            "honua:geometryOrder": index,
          },
        }),
      ),
    ),
    diagnostics: Object.freeze(diagnostics),
    state: diagnostics.some((entry) => entry.severity === "warning")
      ? ("degraded" as const)
      : result.features.length === 0
        ? ("empty" as const)
        : ("ready" as const),
  });
}

/** Execute an accepted plan, mount its projection, and return one lifecycle. */
export async function mountSourceToMapLibre<T>(
  map: SourceToMapLibreMap,
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  options: MountSourceToMapLibreOptions = {},
): Promise<MountedMapLibreSource> {
  assertProjectionPlanContext(source, plan);
  assertFeaturePlan(plan);
  assertQueryable(source);
  validateStaticOptions(options);
  const intendedSourceId = options.sourceId ?? `honua-${safeId(source.descriptor.id)}`;
  if (map.getSource(intendedSourceId)) {
    throw new HonuaMapLibreSourceAdapterError(
      "source-conflict",
      `MapLibre source "${intendedSourceId}" already exists.`,
      {
        sourceId: intendedSourceId,
      },
    );
  }
  for (const layerId of projectedLayerIds(intendedSourceId, options)) {
    if (map.getLayer(layerId)) {
      throw new HonuaMapLibreSourceAdapterError("layer-conflict", `MapLibre layer "${layerId}" already exists.`, {
        layerId,
      });
    }
  }
  const lifecycleController = new AbortController();
  const executeOptions = {
    ...executionOptions(options),
    signal: combineSignals([lifecycleController.signal, options.signal]),
  };
  assertExecutionContext(source, plan, executeOptions);
  const result = await executeAcceptedFeaturePlan(plan, source, executeOptions.signal);
  throwIfAborted(executeOptions.signal);
  let projection = projectSourceToMapLibre(source, plan, result, options);
  throwIfAborted(executeOptions.signal);
  assertMapIdsAvailable(map, projection);
  const attemptedLayerIds: string[] = [];
  try {
    map.addSource(projection.sourceId, projection.source);
    for (const layer of projection.layers) {
      attemptedLayerIds.push(String(layer.id));
      map.addLayer(layer, options.beforeId);
    }
  } catch (cause) {
    const rollbackFailures = rollbackMapMutation(map, projection.sourceId, attemptedLayerIds);
    throw new HonuaMapLibreSourceAdapterError(
      "map-mutation-failed",
      `Failed to mount source "${projection.sourceId}" transactionally.`,
      {
        sourceId: projection.sourceId,
        attemptedLayerIds,
        rollbackFailureCount: rollbackFailures.length,
        rollbackFailures: rollbackFailures.map(errorMessage),
      },
      { cause },
    );
  }

  let state: MapLibreSourceWorkflowState = projection.state;
  let diagnostics = [...projection.diagnostics];
  const layerIds = projection.layers.map((layer) => String(layer.id));
  const isDisposed = (): boolean => state === "disposed";
  let refreshTail: Promise<void> = Promise.resolve();
  const runRefresh = async (refreshOptions: ExecuteQueryPlanOptions): Promise<MapLibreSourceProjection> => {
    if (isDisposed())
      throw new HonuaMapLibreSourceAdapterError("disposed", "Cannot refresh a disposed MapLibre source mount.");
    const effectiveSignal = combineSignals([lifecycleController.signal, refreshOptions.signal]);
    throwIfAborted(effectiveSignal);
    const nextExecutionOptions = {
      ...executeOptions,
      ...refreshOptions,
      signal: effectiveSignal,
    };
    assertExecutionContext(source, plan, nextExecutionOptions);
    const nextResult = await executeAcceptedFeaturePlan(plan, source, effectiveSignal);
    throwIfAborted(effectiveSignal);
    if (isDisposed())
      throw new HonuaMapLibreSourceAdapterError("disposed", "MapLibre source mount was disposed during refresh.");
    const next = projectSourceToMapLibre(source, plan, nextResult, options);
    throwIfAborted(effectiveSignal);
    const handle = map.getSource(projection.sourceId) as GeoJsonSourceHandle | undefined;
    if (!handle || typeof handle.setData !== "function") {
      throw new HonuaMapLibreSourceAdapterError(
        "map-mutation-failed",
        `Mounted source "${projection.sourceId}" no longer exposes setData().`,
      );
    }
    throwIfAborted(effectiveSignal);
    const previousData = projection.source.data as AdapterGeoJsonFeatureCollection;
    try {
      handle.setData(next.source.data as AdapterGeoJsonFeatureCollection);
    } catch (cause) {
      let rollbackFailure: unknown;
      try {
        handle.setData(previousData);
      } catch (error) {
        rollbackFailure = error;
      }
      state = "degraded";
      diagnostics = [
        ...diagnostics,
        diagnostic(
          source,
          plan,
          "incremental-update-failed",
          "warning",
          "update",
          "unsupported",
          rollbackFailure
            ? "MapLibre setData failed and the previous projection could not be restored."
            : "MapLibre setData failed; the previous projection was restored.",
          { rollbackSucceeded: rollbackFailure === undefined },
        ),
      ];
      throw new HonuaMapLibreSourceAdapterError(
        "map-mutation-failed",
        `Failed to refresh mounted source "${projection.sourceId}" through setData().`,
        {
          sourceId: projection.sourceId,
          planId: plan.id,
          rollbackSucceeded: rollbackFailure === undefined,
          ...(rollbackFailure ? { rollbackFailure: errorMessage(rollbackFailure) } : {}),
        },
        { cause },
      );
    }
    diagnostics = [
      ...next.diagnostics,
      diagnostic(
        source,
        plan,
        "incremental-update",
        "info",
        "update",
        "exact",
        "Updated GeoJSON data in place with setData().",
      ),
    ];
    projection = { ...next, diagnostics };
    state = next.state;
    return projection;
  };
  const enqueueRefresh = (refreshOptions: ExecuteQueryPlanOptions): Promise<MapLibreSourceProjection> => {
    const result = refreshTail.then(() => runRefresh(refreshOptions));
    refreshTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    strategy: "geojson-query",
    sourceId: projection.sourceId,
    layerIds,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    get state() {
      return state;
    },
    get diagnostics() {
      return diagnostics;
    },
    refresh(refreshOptions = {}) {
      return enqueueRefresh(refreshOptions);
    },
    dispose() {
      if (state === "disposed") return;
      lifecycleController.abort(new DOMException("MapLibre source mount disposed", "AbortError"));
      const failures: unknown[] = [];
      for (const layerId of [...layerIds].reverse()) {
        try {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        if (map.getSource(projection.sourceId)) map.removeSource(projection.sourceId);
      } catch (error) {
        failures.push(error);
      }
      state = "disposed";
      if (failures.length > 0) {
        throw new HonuaMapLibreSourceAdapterError(
          "map-mutation-failed",
          `MapLibre source "${projection.sourceId}" disposal completed with ${failures.length} renderer failure(s).`,
          { sourceId: projection.sourceId, failureCount: failures.length },
          { cause: failures[0] },
        );
      }
    },
  };
}

function assertQueryable<T>(source: Source<T>): void {
  if (!source.capabilities.has("query")) {
    throw new HonuaCapabilityNotSupportedError("query", source.descriptor.protocol, source.descriptor.id);
  }
}

function assertProjectionPlanContext<T>(source: Source<T>, plan: QueryExecutionPlanV1): void {
  if (hashQueryPlanV1(plan) !== plan.fingerprint) {
    throw new HonuaQueryPlanExecutionError(
      "invalid-plan",
      "Plan content does not match its fingerprint; project only the accepted immutable plan.",
    );
  }
  const identity = queryIrSourceIdentity(source.descriptor, {
    schemaVersion: plan.ir.source.schemaVersion,
    sourceVersion: plan.ir.source.sourceVersion,
    authorizationScope: plan.ir.source.authorizationScope,
  });
  const runtimeCapabilities = [...source.capabilities].sort();
  const descriptorCapabilities = [...source.descriptor.capabilities].sort();
  const planCapabilities = [...plan.ir.source.capabilities].sort();
  if (
    canonicalStringify(toJsonValue(identity)) !== canonicalStringify(toJsonValue(plan.ir.source)) ||
    canonicalStringify(toJsonValue(runtimeCapabilities)) !== canonicalStringify(toJsonValue(descriptorCapabilities)) ||
    canonicalStringify(toJsonValue(runtimeCapabilities)) !== canonicalStringify(toJsonValue(planCapabilities))
  ) {
    throw new HonuaQueryPlanExecutionError(
      "plan-context-mismatch",
      "Source identity, descriptor capabilities, or runtime capabilities do not match the accepted plan projection context.",
    );
  }
}

function assertExecutionContext<T>(
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  options: ExecuteQueryPlanOptions,
): void {
  const current = queryIrSourceIdentity(source.descriptor, options);
  if (canonicalStringify(toJsonValue(current)) !== canonicalStringify(toJsonValue(plan.ir.source))) {
    throw new HonuaQueryPlanExecutionError(
      "plan-context-mismatch",
      "Source identity, version, capabilities, or authorization scope changed after planning; explain a replacement plan",
    );
  }
}

function executeAcceptedFeaturePlan<T>(
  plan: QueryExecutionPlanV1,
  source: Source<T>,
  signal: AbortSignal,
): Promise<Result<T>> {
  const step = plan.steps[0];
  if (!step || step.engine !== "remote" || (step.operation !== "query" && step.operation !== "queryAll")) {
    throw new HonuaMapLibreSourceAdapterError(
      "unsupported-plan",
      "MapLibre GeoJSON mounting requires one remote feature-query step.",
      { planId: plan.id },
    );
  }
  const query = queryFromCanonical<T>(step.query, signal);
  return step.operation === "queryAll" ? source.queryAll(query) : source.query(query);
}

function assertFeaturePlan<T>(plan: QueryExecutionPlanV1, result?: Result<T>): void {
  const first = plan.steps[0];
  const featureShape =
    plan.ir.query.aggregation === undefined &&
    plan.ir.query.returnGeometry !== false &&
    plan.steps.length === 1 &&
    first?.engine === "remote" &&
    (first.operation === "query" || first.operation === "queryAll");
  if (!featureShape || result?.aggregateRows !== undefined) {
    throw new HonuaMapLibreSourceAdapterError(
      "unsupported-plan",
      "MapLibre GeoJSON mounting requires a feature-query plan; aggregate or client-materialization plans are not renderable by this strategy.",
      { planId: plan.id, operations: plan.steps.map((step) => step.operation) },
    );
  }
}

function assertMapIdsAvailable(map: SourceToMapLibreMap, projection: MapLibreSourceProjection): void {
  if (map.getSource(projection.sourceId)) {
    throw new HonuaMapLibreSourceAdapterError(
      "source-conflict",
      `MapLibre source "${projection.sourceId}" already exists.`,
      {
        sourceId: projection.sourceId,
      },
    );
  }
  for (const layer of projection.layers) {
    if (map.getLayer(String(layer.id))) {
      throw new HonuaMapLibreSourceAdapterError(
        "layer-conflict",
        `MapLibre layer "${String(layer.id)}" already exists.`,
        {
          layerId: layer.id,
        },
      );
    }
  }
}

function rollbackMapMutation(map: SourceToMapLibreMap, sourceId: string, layerIds: readonly string[]): unknown[] {
  const failures: unknown[] = [];
  for (const layerId of [...layerIds].reverse()) {
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

function diagnostic<T>(
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  code: MapLibreSourceDiagnosticCode,
  severity: MapLibreSourceDiagnostic["severity"],
  stage: MapLibreSourceDiagnostic["stage"],
  fidelity: MapLibreSourceDiagnostic["fidelity"],
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): MapLibreSourceDiagnostic {
  return {
    code,
    severity,
    stage,
    fidelity,
    sourceId: source.descriptor.id,
    planId: plan.id,
    message,
    ...(detail ? { detail } : {}),
  };
}

function executionOptions(options: MountSourceToMapLibreOptions): ExecuteQueryPlanOptions {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.schemaVersion ? { schemaVersion: options.schemaVersion } : {}),
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(options.authorizationScope ? { authorizationScope: options.authorizationScope } : {}),
  };
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return available.length === 1 ? (available[0] as AbortSignal) : AbortSignal.any(available);
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new HonuaMapLibreSourceAdapterError("invalid-option", `${name} must be a positive integer.`, {
      [name]: value,
    });
  }
  return value;
}

function validateStaticOptions(options: ProjectSourceToMapLibreOptions): void {
  if (options.clusterRadius !== undefined && options.cluster !== true) {
    throw new HonuaMapLibreSourceAdapterError("invalid-option", "clusterRadius requires cluster: true.", {
      clusterRadius: options.clusterRadius,
    });
  }
  if (options.cluster) {
    positiveInteger(options.clusterRadius, 50, "clusterRadius");
    if (options.geometry !== undefined && options.geometry !== "auto" && options.geometry !== "point") {
      throw new HonuaMapLibreSourceAdapterError(
        "invalid-option",
        "MapLibre clustering is supported only for point GeoJSON sources.",
        { geometry: options.geometry },
      );
    }
  }
}

function projectedLayerIds(sourceId: string, options: ProjectSourceToMapLibreOptions): readonly string[] {
  const base = options.layerId ?? `${sourceId}-features`;
  const kind = options.geometry === "auto" ? undefined : options.geometry;
  const kinds: readonly MapLibreGeometryKind[] = kind
    ? [kind]
    : options.cluster
      ? ["point"]
      : ["point", "line", "polygon"];
  return kinds.length === 1 ? [base] : kinds.map((entry) => `${base}-${entry}`);
}
