import type { Result } from "@honua/sdk-js/contract";
import { canonicalStringify, sha256, toJsonValue } from "@honua/sdk-js/query-planner";

import type {
  CloudNativeAnalysisEvidenceV1,
  CloudNativeAnalysisRun,
  CloudNativeMetric,
} from "./cloud-native-analysis.js";
import type { Bbox, OverturePlaceRow } from "./types.js";

export const LINKED_ANALYSIS_ARTIFACT_FORMAT = "honua.sdk.cloud-native-linked-analysis.v1" as const;
export const LINKED_ANALYSIS_PRESENTATION_FORMAT = "honua.sdk.cloud-native-presentation.v1" as const;

const DEFAULT_MAX_CHART_BUCKETS = 16;
const MAX_STRING_LENGTH = 512;

export interface LinkedAnalysisMapFeature {
  readonly type: "Feature";
  readonly id: string;
  readonly geometry: {
    readonly type: "Point";
    readonly coordinates: readonly [number, number];
  };
  readonly properties: {
    readonly name: string;
    readonly category: string;
    readonly confidence: number;
  };
}

export interface LinkedAnalysisMapFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: readonly LinkedAnalysisMapFeature[];
}

export interface LinkedAnalysisChartBucket {
  readonly category: string;
  readonly count: number;
  readonly averageConfidence: number;
  readonly featureIds: readonly string[];
}

export interface LinkedAnalysisMaterializationPolicy {
  readonly maxRows: number;
  readonly maxGeometryFeatures: number;
  readonly maxChartBuckets: number;
  readonly maxMaterializedBytes: number;
}

export interface CloudNativeLinkedAnalysisArtifactV1 {
  readonly format: typeof LINKED_ANALYSIS_ARTIFACT_FORMAT;
  readonly schemaVersion: 1;
  readonly id: `artifact_${string}`;
  readonly state: "ready" | "empty" | "degraded";
  readonly acceptedPlan: {
    readonly id: string;
    readonly fingerprint: `sha256:${string}`;
    readonly cacheIdentity: string;
  };
  /** The complete S1 source/query/engine/provenance receipt that produced this artifact. */
  readonly execution: CloudNativeAnalysisEvidenceV1;
  readonly rows: readonly OverturePlaceRow[];
  readonly map: LinkedAnalysisMapFeatureCollection;
  readonly chart: readonly LinkedAnalysisChartBucket[];
  readonly materialization: {
    readonly policy: LinkedAnalysisMaterializationPolicy;
    readonly rowCount: number;
    readonly geometryFeatureCount: number;
    readonly chartBucketCount: number;
    readonly materializedBytes: number;
    readonly sdkResultBytes: number;
  };
}

export interface CloudNativeLinkedPresentationReceiptV1 {
  readonly format: typeof LINKED_ANALYSIS_PRESENTATION_FORMAT;
  readonly schemaVersion: 1;
  readonly artifactId: CloudNativeLinkedAnalysisArtifactV1["id"];
  readonly resultCache: "hit" | "miss";
  readonly renderer: {
    readonly strategy: "maplibre-bounded-geojson-fallback";
    readonly state: "degraded";
    readonly fidelity: "bounded-object-fallback";
    readonly reason: string;
    readonly optionalRecipe: "kepler-analytics";
  };
  readonly materialized: {
    readonly rows: number;
    readonly geometries: number;
    readonly chartBuckets: number;
  };
  readonly timing: {
    /** Immutable timing recorded when the cached artifact was originally produced. */
    readonly artifactProduction: {
      readonly sdkPlanMs: number;
      readonly sourceProbeMs: number;
      readonly engineExecutionMs: number;
      readonly totalMs: number;
    };
    /** Work performed for this delivery. Cache hits report no SDK/source/engine rerun. */
    readonly delivery: {
      readonly sdkPlanMs: number;
      readonly sourceProbeMs: number;
      readonly engineExecutionMs: number;
      readonly rendererMs: number;
      readonly wallMs: number;
    };
  };
}

export interface CreateCloudNativeLinkedArtifactOptions {
  readonly maxRows?: number;
  readonly maxGeometryFeatures?: number;
  readonly maxChartBuckets?: number;
  readonly maxMaterializedBytes?: number;
}

export interface CreateCloudNativePresentationReceiptOptions {
  readonly resultCache: "hit" | "miss";
  readonly rendererMs: number;
  readonly deliveryWallMs: number;
  readonly renderedRows: number;
  readonly renderedGeometries: number;
  readonly renderedChartBuckets: number;
}

export interface LinkedAnalysisSelectionController {
  readonly selectedId: string | null;
  readonly disposed: boolean;
  select(featureId: string): void;
  clear(): void;
  subscribe(listener: (featureId: string | null) => void): () => void;
  dispose(): void;
}

export type LinkedAnalysisViewportBounds = [[number, number], [number, number]];

/**
 * Derive every linked view from the one bounded SDK Result accepted by S1.
 * The helper performs no network, engine, cache, or renderer work.
 */
export function createCloudNativeLinkedArtifact(
  run: CloudNativeAnalysisRun<Record<string, unknown>>,
  options: CreateCloudNativeLinkedArtifactOptions = {},
): CloudNativeLinkedAnalysisArtifactV1 {
  const execution = cloneExecutionReceipt(run.evidence);
  validateExecutionReceipt(execution, run.result);
  const resultCeiling = exactNonNegativeInteger(execution.memory.resultCeilingBytes, "result byte ceiling");
  const sdkResultBytes = exactNonNegativeInteger(
    execution.memory.materializedResultBytes,
    "SDK-result materialized bytes",
  );
  const policy = normalizePolicy(execution.query.limit, resultCeiling, options);
  const rows = normalizeRows(run.result, execution.query.aoi, policy.maxRows);
  if (sdkResultBytes !== utf8Bytes(run.result)) {
    throw new Error("S1 materialized-byte evidence does not match the accepted SDK Result.");
  }
  const map = mapProjection(rows, policy.maxGeometryFeatures);
  const chart = chartProjection(rows, policy.maxChartBuckets);
  const materializedBytes = utf8Bytes({ rows, map, chart });
  if (materializedBytes > policy.maxMaterializedBytes) {
    throw new Error(
      `Linked analysis materialized ${materializedBytes} bytes beyond the ${policy.maxMaterializedBytes}-byte ceiling.`,
    );
  }
  const state = rows.length === 0 ? "empty" : execution.resultFidelity.fidelity === "exact" ? "ready" : "degraded";
  const idDigest = sha256(
    `honua.sdk.cloud-native-linked-analysis.v1\n${canonicalStringify(
      toJsonValue({
        plan: execution.query.plan.fingerprint,
        cacheIdentity: execution.cache.identity,
        sourceVersion: execution.source.objectVersion,
        rows,
        map,
        chart,
      }),
    )}`,
  ).slice("sha256:".length);
  return deepFreeze({
    format: LINKED_ANALYSIS_ARTIFACT_FORMAT,
    schemaVersion: 1 as const,
    id: `artifact_${idDigest}` as const,
    state,
    acceptedPlan: {
      id: execution.query.plan.id,
      fingerprint: execution.query.plan.fingerprint,
      cacheIdentity: execution.query.plan.cacheIdentity,
    },
    execution,
    rows,
    map,
    chart,
    materialization: {
      policy,
      rowCount: rows.length,
      geometryFeatureCount: map.features.length,
      chartBucketCount: chart.length,
      materializedBytes,
      sdkResultBytes,
    },
  });
}

export function createCloudNativePresentationReceipt(
  artifact: CloudNativeLinkedAnalysisArtifactV1,
  options: CreateCloudNativePresentationReceiptOptions,
): CloudNativeLinkedPresentationReceiptV1 {
  const rendererMs = finiteNonNegative(options.rendererMs, "rendererMs");
  const deliveryWallMs = finiteNonNegative(options.deliveryWallMs, "deliveryWallMs");
  if (deliveryWallMs < rendererMs) throw new Error("deliveryWallMs cannot be less than rendererMs.");
  if (options.renderedRows !== artifact.materialization.rowCount) {
    throw new Error("Presentation row count does not match the accepted linked artifact.");
  }
  if (options.renderedGeometries !== artifact.materialization.geometryFeatureCount) {
    throw new Error("Presentation geometry count does not match the accepted linked artifact.");
  }
  if (options.renderedChartBuckets !== artifact.materialization.chartBucketCount) {
    throw new Error("Presentation chart count does not match the accepted linked artifact.");
  }
  const timing = artifact.execution.timing;
  return deepFreeze({
    format: LINKED_ANALYSIS_PRESENTATION_FORMAT,
    schemaVersion: 1 as const,
    artifactId: artifact.id,
    resultCache: options.resultCache,
    renderer: {
      strategy: "maplibre-bounded-geojson-fallback" as const,
      state: "degraded" as const,
      fidelity: "bounded-object-fallback" as const,
      reason:
        "The bounded object Result is rendered through MapLibre GeoJSON. Direct GeoArrow/deck.gl remains gated by #536 and the bounded #388 adapter slice.",
      optionalRecipe: "kepler-analytics" as const,
    },
    materialized: {
      rows: options.renderedRows,
      geometries: options.renderedGeometries,
      chartBuckets: options.renderedChartBuckets,
    },
    timing: {
      artifactProduction: {
        sdkPlanMs: timing.sdkPlanMs,
        sourceProbeMs: timing.sourceProbeMs,
        engineExecutionMs: timing.engineExecutionMs,
        totalMs: timing.totalMs,
      },
      delivery: {
        sdkPlanMs: options.resultCache === "hit" ? 0 : timing.sdkPlanMs,
        sourceProbeMs: options.resultCache === "hit" ? 0 : timing.sourceProbeMs,
        engineExecutionMs: options.resultCache === "hit" ? 0 : timing.engineExecutionMs,
        rendererMs,
        wallMs: deliveryWallMs,
      },
    },
  });
}

export function createLinkedAnalysisSelection(
  artifact: CloudNativeLinkedAnalysisArtifactV1,
): LinkedAnalysisSelectionController {
  const ids = new Set(artifact.rows.map((row) => row.id));
  const listeners = new Set<(featureId: string | null) => void>();
  let selectedId: string | null = null;
  let disposed = false;

  const publish = (next: string | null): void => {
    if (disposed) throw new Error("Linked analysis selection controller is disposed.");
    if (next !== null && !ids.has(next)) throw new Error(`Feature ${JSON.stringify(next)} is not in the artifact.`);
    if (selectedId === next) return;
    selectedId = next;
    for (const listener of listeners) listener(selectedId);
  };

  return Object.freeze({
    get selectedId() {
      return selectedId;
    },
    get disposed() {
      return disposed;
    },
    select(featureId: string) {
      publish(featureId);
    },
    clear() {
      publish(null);
    },
    subscribe(listener: (featureId: string | null) => void) {
      if (disposed) throw new Error("Linked analysis selection controller is disposed.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      selectedId = null;
      listeners.clear();
    },
  });
}

/** Keep every bounded materialized point visible even when an intersecting bbox centroid falls outside the AOI. */
export function linkedAnalysisViewportBounds(
  artifact: CloudNativeLinkedAnalysisArtifactV1,
): LinkedAnalysisViewportBounds {
  const aoi = artifact.execution.query.aoi;
  let xmin = aoi[0];
  let ymin = aoi[1];
  let xmax = aoi[2];
  let ymax = aoi[3];
  for (const feature of artifact.map.features) {
    const longitude = finite(feature.geometry.coordinates[0], `map feature ${JSON.stringify(feature.id)} longitude`);
    const latitude = finite(feature.geometry.coordinates[1], `map feature ${JSON.stringify(feature.id)} latitude`);
    xmin = Math.min(xmin, longitude);
    ymin = Math.min(ymin, latitude);
    xmax = Math.max(xmax, longitude);
    ymax = Math.max(ymax, latitude);
  }
  return [
    [xmin, ymin],
    [xmax, ymax],
  ];
}

function normalizePolicy(
  queryLimit: number,
  resultCeiling: number,
  options: CreateCloudNativeLinkedArtifactOptions,
): LinkedAnalysisMaterializationPolicy {
  const maxRows = boundedPositiveInteger(options.maxRows ?? queryLimit, "maxRows");
  const maxGeometryFeatures = boundedPositiveInteger(options.maxGeometryFeatures ?? maxRows, "maxGeometryFeatures");
  const maxChartBuckets = boundedPositiveInteger(
    options.maxChartBuckets ?? DEFAULT_MAX_CHART_BUCKETS,
    "maxChartBuckets",
  );
  const maxMaterializedBytes = boundedPositiveInteger(
    options.maxMaterializedBytes ?? resultCeiling,
    "maxMaterializedBytes",
  );
  if (maxRows > queryLimit || maxGeometryFeatures > queryLimit || maxMaterializedBytes > resultCeiling) {
    throw new Error("Linked analysis materialization policy cannot widen the accepted query policy.");
  }
  return Object.freeze({ maxRows, maxGeometryFeatures, maxChartBuckets, maxMaterializedBytes });
}

function validateExecutionReceipt(
  evidence: CloudNativeAnalysisEvidenceV1,
  result: Result<Record<string, unknown>>,
): void {
  if (evidence.format !== "honua.sdk.cloud-native-analysis-evidence.v1" || evidence.schemaVersion !== 1) {
    throw new Error("Linked analysis requires the S1 cloud-native evidence contract.");
  }
  if (evidence.worker.boundedExecution.fidelity !== "exact" || evidence.worker.boundedExecution.value !== true) {
    throw new Error("Linked analysis requires exact bounded-worker execution evidence.");
  }
  if (evidence.worker.cleanup.fidelity !== "exact" || evidence.worker.cleanup.value !== true) {
    throw new Error("Linked analysis requires exact worker-cleanup evidence.");
  }
  if (evidence.presentation.fidelity !== "unsupported" || evidence.presentation.value !== null) {
    throw new Error("The S1 execution receipt must remain renderer-free.");
  }
  const returned = exactNonNegativeInteger(evidence.rows.returned, "returned rows");
  if (returned !== result.features.length) {
    throw new Error("S1 returned-row evidence does not match the accepted SDK Result.");
  }
  if (evidence.cache.policy !== "bypass" || evidence.cache.scope !== "execution-only") {
    throw new Error("Linked analysis refuses portable or undeclared engine-cache evidence.");
  }
  if (evidence.resultFidelity.fidelity !== "exact" && evidence.resultFidelity.fidelity !== "approximate") {
    throw new Error("Linked analysis requires an explicit exact or approximate result fidelity.");
  }
}

function normalizeRows(
  result: Result<Record<string, unknown>>,
  aoi: Bbox,
  maxRows: number,
): readonly OverturePlaceRow[] {
  if (result.features.length > maxRows) {
    throw new Error(`Linked analysis received ${result.features.length} rows beyond the ${maxRows}-row ceiling.`);
  }
  const rows = result.features.map((feature, index) => normalizeRow(feature.attributes, aoi, index));
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`Linked analysis feature id ${JSON.stringify(row.id)} is duplicated.`);
    ids.add(row.id);
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function normalizeRow(attributes: Record<string, unknown>, aoi: Bbox, index: number): OverturePlaceRow {
  const bbox = record(attributes.bbox, `features[${index}].attributes.bbox`);
  const names = optionalRecord(attributes.names);
  const categories = optionalRecord(attributes.categories);
  const xmin = finite(bbox.xmin, `features[${index}].bbox.xmin`);
  const ymin = finite(bbox.ymin, `features[${index}].bbox.ymin`);
  const xmax = finite(bbox.xmax, `features[${index}].bbox.xmax`);
  const ymax = finite(bbox.ymax, `features[${index}].bbox.ymax`);
  if (xmin > xmax || ymin > ymax) throw new Error(`features[${index}] has an inverted bbox.`);
  if (xmin < -180 || xmax > 180 || ymin < -90 || ymax > 90) {
    throw new Error(`features[${index}] has a bbox outside OGC:CRS84 bounds.`);
  }
  const longitude = (xmin + xmax) / 2;
  const latitude = (ymin + ymax) / 2;
  if (xmax < aoi[0] || xmin > aoi[2] || ymax < aoi[1] || ymin > aoi[3]) {
    throw new Error(`features[${index}] does not intersect the accepted AOI.`);
  }
  return {
    id: boundedString(attributes.id, `features[${index}].id`),
    name: boundedString(attributes.name ?? names?.primary ?? "Unnamed place", `features[${index}].name`),
    category: boundedString(
      attributes.category ?? categories?.primary ?? "uncategorized",
      `features[${index}].category`,
    ),
    confidence: confidence(attributes.confidence, `features[${index}].confidence`),
    longitude,
    latitude,
  };
}

function mapProjection(
  rows: readonly OverturePlaceRow[],
  maxGeometryFeatures: number,
): LinkedAnalysisMapFeatureCollection {
  if (rows.length > maxGeometryFeatures) {
    throw new Error(`Linked map requires ${rows.length} geometries beyond the ${maxGeometryFeatures}-feature ceiling.`);
  }
  return {
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature",
      id: row.id,
      geometry: { type: "Point", coordinates: [row.longitude, row.latitude] },
      properties: { name: row.name, category: row.category, confidence: row.confidence },
    })),
  };
}

function chartProjection(
  rows: readonly OverturePlaceRow[],
  maxChartBuckets: number,
): readonly LinkedAnalysisChartBucket[] {
  const grouped = new Map<string, { ids: string[]; confidence: number }>();
  for (const row of rows) {
    const bucket = grouped.get(row.category) ?? { ids: [], confidence: 0 };
    bucket.ids.push(row.id);
    bucket.confidence += row.confidence;
    grouped.set(row.category, bucket);
    if (grouped.size > maxChartBuckets) {
      throw new Error(`Linked chart exceeded the ${maxChartBuckets}-bucket ceiling.`);
    }
  }
  return [...grouped]
    .map(([category, bucket]) => ({
      category,
      count: bucket.ids.length,
      averageConfidence: bucket.ids.length === 0 ? 0 : bucket.confidence / bucket.ids.length,
      featureIds: [...bucket.ids],
    }))
    .sort(
      (left, right) =>
        right.count - left.count || (left.category < right.category ? -1 : left.category > right.category ? 1 : 0),
    );
}

function cloneExecutionReceipt(evidence: CloudNativeAnalysisEvidenceV1): CloudNativeAnalysisEvidenceV1 {
  return structuredClone(evidence);
}

function exactNonNegativeInteger(metric: CloudNativeMetric<number>, label: string): number {
  if (metric.fidelity !== "exact" || !Number.isSafeInteger(metric.value) || metric.value < 0) {
    throw new Error(`Linked analysis requires an exact non-negative ${label}.`);
  }
  return metric.value;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function finiteNonNegative(value: unknown, label: string): number {
  const accepted = finite(value, label);
  if (accepted < 0 || accepted > 60_000) throw new Error(`${label} must be between 0 and 60000.`);
  return accepted;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH) {
    throw new Error(`${label} must contain between 1 and ${MAX_STRING_LENGTH} characters.`);
  }
  return value;
}

function confidence(value: unknown, label: string): number {
  const accepted = finite(value, label);
  if (accepted < 0 || accepted > 1) throw new Error(`${label} must be between 0 and 1.`);
  return accepted;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
