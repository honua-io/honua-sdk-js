/**
 * Plan-bound canonical Source → MapLibre GeoJSON workflow.
 *
 * This module is peer-injected and safe to import in Node/SSR/worker code: it
 * never imports `maplibre-gl`. The first production slice deliberately covers
 * exact feature-query plans; tile and realtime strategies remain separate.
 */

import type { Result, Source } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { HonuaTypedFeature } from "../core/types.js";
import { canonicalStringify, toJsonValue } from "../query-planner/canonical.js";
import { executeQueryPlan } from "../query-planner/executor.js";
import { queryIrSourceIdentity } from "../query-planner/ir.js";
import { hashQueryPlan } from "../query-planner/planner.js";
import {
  type ExecuteQueryPlanOptions,
  HonuaQueryPlanExecutionError,
  type QueryExecutionPlanV1,
} from "../query-planner/types.js";
import { esriGeometryToGeoJson } from "./feature-service-adapter.js";
import type {
  AdapterGeoJsonFeature,
  AdapterGeoJsonFeatureCollection,
  AdapterGeoJsonGeometry,
} from "./feature-service-adapter.js";

export type MapLibreSourceStrategy = "geojson-query";
export type MapLibreGeometryKind = "point" | "line" | "polygon";
export type MapLibreSourceWorkflowState = "ready" | "empty" | "degraded" | "disposed";

export type MapLibreSourceDiagnosticCode =
  | "strategy-selected"
  | "empty-result"
  | "transfer-limit"
  | "source-degraded"
  | "geometry-unsupported"
  | "mixed-geometry"
  | "incremental-update";

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
  | "invalid-option"
  | "map-mutation-failed";

/** A stable, machine-readable adapter failure. */
export class HonuaMapLibreSourceAdapterError extends Error {
  public constructor(
    public readonly code: MapLibreSourceAdapterErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaMapLibreSourceAdapterError";
  }
}

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
  assertQueryable(source);
  assertProjectionPlanContext(source, plan);
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
  const execution = await executeQueryPlan(plan, source, executeOptions);
  let projection = projectSourceToMapLibre(source, plan, execution.result, options);
  assertMapIdsAvailable(map, projection);
  const addedLayers: string[] = [];
  try {
    map.addSource(projection.sourceId, projection.source);
    for (const layer of projection.layers) {
      map.addLayer(layer, options.beforeId);
      addedLayers.push(String(layer.id));
    }
  } catch (cause) {
    rollbackMapMutation(map, projection.sourceId, addedLayers);
    throw new HonuaMapLibreSourceAdapterError(
      "map-mutation-failed",
      `Failed to mount source "${projection.sourceId}" transactionally.`,
      { sourceId: projection.sourceId, addedLayers },
      { cause },
    );
  }

  let state: MapLibreSourceWorkflowState = projection.state;
  let diagnostics = [...projection.diagnostics];
  const layerIds = projection.layers.map((layer) => String(layer.id));
  const isDisposed = (): boolean => state === "disposed";
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
    async refresh(refreshOptions = {}) {
      if (isDisposed())
        throw new HonuaMapLibreSourceAdapterError("disposed", "Cannot refresh a disposed MapLibre source mount.");
      const nextExecution = await executeQueryPlan(plan, source, {
        ...executeOptions,
        ...refreshOptions,
        signal: combineSignals([lifecycleController.signal, refreshOptions.signal]),
      });
      if (isDisposed())
        throw new HonuaMapLibreSourceAdapterError("disposed", "MapLibre source mount was disposed during refresh.");
      const next = projectSourceToMapLibre(source, plan, nextExecution.result, options);
      const handle = map.getSource(projection.sourceId) as GeoJsonSourceHandle | undefined;
      if (!handle || typeof handle.setData !== "function") {
        throw new HonuaMapLibreSourceAdapterError(
          "map-mutation-failed",
          `Mounted source "${projection.sourceId}" no longer exposes setData().`,
        );
      }
      handle.setData(next.source.data as AdapterGeoJsonFeatureCollection);
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
    },
    dispose() {
      if (state === "disposed") return;
      lifecycleController.abort("MapLibre source mount disposed");
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
  if (hashQueryPlan(plan) !== plan.fingerprint) {
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
  if (canonicalStringify(toJsonValue(identity)) !== canonicalStringify(toJsonValue(plan.ir.source))) {
    throw new HonuaQueryPlanExecutionError(
      "plan-context-mismatch",
      "Source identity or capabilities do not match the accepted plan projection context.",
    );
  }
}

function canonicalFeaturesToGeoJson<T>(
  features: readonly HonuaTypedFeature<T>[],
  primaryKey?: string,
): { data: AdapterGeoJsonFeatureCollection; unsupported: number } {
  let unsupported = 0;
  const converted = features.map((feature): AdapterGeoJsonFeature => {
    const geometry = toGeoJsonGeometry(feature.geometry);
    if (feature.geometry && !geometry) unsupported += 1;
    const attributes = asAttributes(feature.attributes);
    const id = primaryKey ? attributes[primaryKey] : undefined;
    return {
      type: "Feature",
      ...(typeof id === "string" || typeof id === "number" ? { id } : {}),
      geometry,
      properties: attributes,
    };
  });
  return { data: { type: "FeatureCollection", features: converted }, unsupported };
}

function toGeoJsonGeometry(geometry: unknown): AdapterGeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  const record = geometry as Record<string, unknown>;
  if (typeof record.type === "string" && "coordinates" in record) {
    return { type: record.type, coordinates: record.coordinates };
  }
  if (Array.isArray(record.points)) return esriGeometryToGeoJson(record, "esriGeometryMultipoint");
  if (Array.isArray(record.paths)) return esriGeometryToGeoJson(record, "esriGeometryPolyline");
  if (Array.isArray(record.rings)) return esriGeometryToGeoJson(record, "esriGeometryPolygon");
  if ("xmin" in record && "ymin" in record && "xmax" in record && "ymax" in record) {
    return esriGeometryToGeoJson(record, "esriGeometryEnvelope");
  }
  return esriGeometryToGeoJson(record, "esriGeometryPoint");
}

function geometryKinds(features: readonly AdapterGeoJsonFeature[]): MapLibreGeometryKind[] {
  const kinds = new Set<MapLibreGeometryKind>();
  for (const feature of features) {
    const type = feature.geometry?.type;
    if (type === "Point" || type === "MultiPoint") kinds.add("point");
    else if (type === "LineString" || type === "MultiLineString") kinds.add("line");
    else if (type === "Polygon" || type === "MultiPolygon") kinds.add("polygon");
  }
  const order: readonly MapLibreGeometryKind[] = ["point", "line", "polygon"];
  return order.filter((kind) => kinds.has(kind));
}

function defaultPaint(kind: MapLibreGeometryKind): Readonly<Record<string, unknown>> {
  if (kind === "point")
    return {
      "circle-color": "#16735b",
      "circle-radius": 6,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    };
  if (kind === "line") return { "line-color": "#16735b", "line-width": 2.5 };
  return { "fill-color": "#37a887", "fill-opacity": 0.55, "fill-outline-color": "#0e5643" };
}

function layerType(kind: MapLibreGeometryKind): "circle" | "line" | "fill" {
  return kind === "point" ? "circle" : kind === "line" ? "line" : "fill";
}

function mapLibreGeometryType(kind: MapLibreGeometryKind): "Point" | "LineString" | "Polygon" {
  return kind === "point" ? "Point" : kind === "line" ? "LineString" : "Polygon";
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

function rollbackMapMutation(map: SourceToMapLibreMap, sourceId: string, layerIds: readonly string[]): void {
  for (const layerId of [...layerIds].reverse()) {
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    } catch {
      // Best-effort rollback preserves the original mutation error as cause.
    }
  }
  try {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    // Best-effort rollback preserves the original mutation error as cause.
  }
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

function asAttributes(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

function safeId(value: string): string {
  const id = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return id || "source";
}

function removeUndefined(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
}
