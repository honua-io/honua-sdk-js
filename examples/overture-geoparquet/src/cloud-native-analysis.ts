import type { Query, Result, Source, SourceDescriptor } from "@honua/sdk-js/contract";
import type { GeoparquetRuntime } from "@honua/sdk-js/geoparquet";
import {
  type GeoParquetResourceHandleV1,
  type QueryExecutionPlanV2,
  createGeoParquetResourceHandle,
  createGeoParquetResourceRegistry,
  executeQueryPlan,
  explainQuery,
  queryPlanCacheKey,
} from "@honua/sdk-js/query-planner";

import type {
  OvertureObjectManifest,
  OvertureQueryPlan,
  OvertureRangeEvidence,
  OvertureSourceManifest,
} from "./types.js";

export const CLOUD_NATIVE_ANALYSIS_EVIDENCE_FORMAT = "honua.sdk.cloud-native-analysis-evidence.v1" as const;
export const CLOUD_NATIVE_ANALYSIS_EVIDENCE_VERSION = 1 as const;

const RESOURCE_RESOLVER = "io.honua.samples.overture";
const AUTHORIZATION_SCOPE = ["public:anonymous"] as const;

export type CloudNativeMetric<T> =
  | { readonly fidelity: "exact"; readonly value: T; readonly basis: string }
  | { readonly fidelity: "approximate"; readonly value: T; readonly reason: string }
  | { readonly fidelity: "unsupported"; readonly value: null; readonly reason: string };

export interface CloudNativeAnalysisPlanReceipt {
  readonly version: "2.0";
  readonly id: string;
  readonly fingerprint: `sha256:${string}`;
  readonly cacheIdentity: string;
  readonly pushdown: "full" | "partial";
  readonly fidelity: "exact";
}

export interface CloudNativeAnalysisEvidenceV1 {
  readonly format: typeof CLOUD_NATIVE_ANALYSIS_EVIDENCE_FORMAT;
  readonly schemaVersion: typeof CLOUD_NATIVE_ANALYSIS_EVIDENCE_VERSION;
  readonly workflow: "bounded-aoi-geoparquet";
  readonly source: {
    readonly lane: OvertureQueryPlan["lane"];
    readonly release: string;
    readonly schemaVersion: string;
    readonly objectKey: string;
    readonly objectVersion: string;
    readonly crs: "OGC:CRS84";
  };
  readonly query: {
    readonly aoi: OvertureQueryPlan["aoi"];
    readonly projection: readonly string[];
    readonly category: string;
    readonly limit: number;
    readonly plan: CloudNativeAnalysisPlanReceipt;
  };
  readonly io: {
    readonly rangeBytes: CloudNativeMetric<number>;
    readonly rangeRequests: CloudNativeMetric<number>;
    readonly filesSelected: CloudNativeMetric<number>;
    readonly filesExcluded: CloudNativeMetric<number>;
  };
  readonly pruning: {
    readonly selectedObjectRows: CloudNativeMetric<number>;
    readonly candidateRowGroups: CloudNativeMetric<number>;
    readonly rowGroupsPruned: CloudNativeMetric<number>;
  };
  readonly rows: {
    readonly returned: CloudNativeMetric<number>;
    readonly scanned: CloudNativeMetric<number>;
  };
  readonly memory: {
    readonly engineCeilingBytes: CloudNativeMetric<number>;
    readonly resultCeilingBytes: CloudNativeMetric<number>;
    readonly materializedResultBytes: CloudNativeMetric<number>;
    readonly observedPeakBytes: CloudNativeMetric<number>;
  };
  readonly cache: {
    readonly policy: "bypass";
    readonly identity: string;
  };
  readonly resultFidelity: CloudNativeMetric<"exact" | "approximate">;
  readonly timing: {
    readonly sdkPlanMs: number;
    readonly sourceProbeMs: number;
    readonly engineExecutionMs: number;
    readonly totalMs: number;
  };
  readonly worker: {
    readonly boundedExecution: CloudNativeMetric<true>;
    readonly cleanup: CloudNativeMetric<true>;
  };
  readonly presentation: CloudNativeMetric<never>;
}

export interface CloudNativeAnalysisRun<T> {
  readonly result: Result<T>;
  readonly evidence: CloudNativeAnalysisEvidenceV1;
}

export interface RunCloudNativeAnalysisOptions<T> {
  readonly workflowPlan: OvertureQueryPlan;
  readonly manifest: OvertureSourceManifest;
  readonly range: OvertureRangeEvidence;
  readonly source: Source<T>;
  /** Dedicated public runtime that owns `source` and its worker lifecycle. */
  readonly runtime: GeoparquetRuntime;
  readonly signal?: AbortSignal;
  /** Monotonic milliseconds; injectable so fixture receipts can be deterministic. */
  readonly now?: () => number;
}

export type CloudNativeAnalysisRejectionCode =
  | "invalid-workflow-input"
  | "unsupported-range-io"
  | "unsafe-materialization";

export class CloudNativeAnalysisRejectedError extends Error {
  public constructor(
    public readonly code: CloudNativeAnalysisRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "CloudNativeAnalysisRejectedError";
  }
}

/** Build the one canonical query shared by fixture and pinned-public lanes. */
export function cloudNativeAnalysisQuery<T>(plan: OvertureQueryPlan, signal?: AbortSignal): Query<T> {
  const [xmin, ymin, xmax, ymax] = plan.aoi;
  const query: Query<T> = {
    spatialFilter: {
      geometry: { xmin, ymin, xmax, ymax },
      geometryType: "esriGeometryEnvelope",
      spatialRel: "esriSpatialRelIntersects",
    },
    outFields: [...plan.projection],
    orderBy: [{ field: "confidence", direction: "desc" }],
    pagination: { limit: plan.limit },
    returnGeometry: false,
    ...(signal ? { signal } : {}),
  };
  if (plan.category !== "all") {
    const category = plan.category.replaceAll("'", "''");
    query.where = plan.lane === "live" ? `categories.primary = '${category}'` : `category = '${category}'`;
  }
  return query;
}

/**
 * Explain the workflow through the public v2 planner. The opaque handle keeps
 * the raw object locator out of persisted plans and cache identities.
 */
export function explainCloudNativeAnalysis(
  workflowPlan: OvertureQueryPlan,
  manifest: OvertureSourceManifest,
  descriptor: SourceDescriptor,
  resource = resourceHandle(workflowPlan, descriptor),
): CloudNativeAnalysisPlanReceipt {
  const object = selectedObject(workflowPlan, manifest, descriptor);
  return planReceipt(buildSdkPlan(workflowPlan, manifest, descriptor, object, resource));
}

/**
 * Execute a reviewed plan through public planner and GeoParquet adapter
 * surfaces. The runner owns no query SQL, query evaluator, or renderer logic;
 * its only SQL is the bounded DuckDB worker-session policy.
 */
export async function runCloudNativeAnalysis<T>(
  options: RunCloudNativeAnalysisOptions<T>,
): Promise<CloudNativeAnalysisRun<T>> {
  const { workflowPlan, manifest, range, source, runtime } = options;
  const clock = options.now ?? defaultClock;
  const authorizationContextId = authorizationContext(workflowPlan);
  const registry = createGeoParquetResourceRegistry({ resolver: RESOURCE_RESOLVER, maxEntries: 1 });
  let executedObject: OvertureObjectManifest | undefined;
  let execution: Awaited<ReturnType<typeof executeQueryPlan<T>>> | undefined;
  let receipt: CloudNativeAnalysisPlanReceipt | undefined;
  let resultBytes = 0;
  let planMs = 0;
  let engineMs = 0;
  let sourceProbeMs = 0;

  try {
    const object = selectedObject(workflowPlan, manifest, source.descriptor);
    executedObject = object;
    const resource = registry.register({
      id: source.descriptor.id,
      authorizationContextId,
      resourceVersion: object.etag,
      sources: [object.url],
    });
    if (source.protocol("geoparquet")?.runtime !== runtime) {
      throw new CloudNativeAnalysisRejectedError(
        "invalid-workflow-input",
        "The GeoParquet Source and dedicated worker runtime must share one lifecycle.",
      );
    }
    if (range.status === "unsupported") {
      throw new CloudNativeAnalysisRejectedError("unsupported-range-io", range.limitation);
    }
    if (range.objectBytes !== object.bytes) {
      throw new CloudNativeAnalysisRejectedError(
        "invalid-workflow-input",
        "Range evidence object size does not match the selected object manifest.",
      );
    }
    if (
      !Number.isSafeInteger(range.bytes) ||
      range.bytes < 0 ||
      range.bytes > object.bytes ||
      !Number.isSafeInteger(range.ranges) ||
      range.ranges < 1
    ) {
      throw new CloudNativeAnalysisRejectedError(
        "invalid-workflow-input",
        "Range evidence must contain bounded integer byte and request counts.",
      );
    }
    sourceProbeMs = finiteDuration(range.durationMs);

    const planStarted = readClock(clock);
    const plan = buildSdkPlan<T>(workflowPlan, manifest, source.descriptor, object, resource);
    planMs = elapsed(planStarted, readClock(clock));
    receipt = planReceipt(plan);

    const engineStarted = readClock(clock);
    await runtime.query(runtimePolicySql(workflowPlan), options.signal ? { signal: options.signal } : undefined);
    execution = await executeQueryPlan(plan, source, {
      ...(options.signal ? { signal: options.signal } : {}),
      schemaVersion: manifest.schemaVersion,
      sourceVersion: `${manifest.release}:${object.etag}`,
      authorizationScope: AUTHORIZATION_SCOPE,
      authorizationContextId,
      geoParquetResourceResolver: registry.resolver,
    });
    engineMs = elapsed(engineStarted, readClock(clock));

    if (execution.result.features.length > workflowPlan.limit) {
      throw new CloudNativeAnalysisRejectedError(
        "unsafe-materialization",
        `Result materialized ${execution.result.features.length} rows beyond the ${workflowPlan.limit}-row ceiling.`,
      );
    }
    resultBytes = boundedResultBytes(execution.result);
    if (resultBytes > workflowPlan.maxResultBytes) {
      throw new CloudNativeAnalysisRejectedError(
        "unsafe-materialization",
        `Result materialized ${resultBytes} bytes beyond the ${workflowPlan.maxResultBytes}-byte ceiling.`,
      );
    }
  } finally {
    registry.dispose();
    await runtime.dispose();
  }

  if (!executedObject || !execution || !receipt) {
    throw new CloudNativeAnalysisRejectedError("invalid-workflow-input", "Cloud-native analysis did not execute.");
  }
  const object = executedObject;
  const degradationReasons = (execution.result.degraded ?? []).map((entry) => entry.reason);
  const resultFidelity: CloudNativeMetric<"exact" | "approximate"> =
    degradationReasons.length === 0
      ? exact("exact", "The accepted SDK plan is exact and the adapter reported no degradation.")
      : {
          fidelity: "approximate",
          value: "approximate",
          reason: degradationReasons.join("; "),
        };
  const evidence: CloudNativeAnalysisEvidenceV1 = {
    format: CLOUD_NATIVE_ANALYSIS_EVIDENCE_FORMAT,
    schemaVersion: CLOUD_NATIVE_ANALYSIS_EVIDENCE_VERSION,
    workflow: "bounded-aoi-geoparquet",
    source: {
      lane: workflowPlan.lane,
      release: manifest.release,
      schemaVersion: manifest.schemaVersion,
      objectKey: object.objectKey,
      objectVersion: object.etag,
      crs: manifest.crs,
    },
    query: {
      aoi: workflowPlan.aoi,
      projection: workflowPlan.projection,
      category: workflowPlan.category,
      limit: workflowPlan.limit,
      plan: receipt,
    },
    io: {
      rangeBytes: exact(range.bytes, `${range.status} byte accounting from the bounded source stage.`),
      rangeRequests: exact(range.ranges, `${range.status} request accounting from the bounded source stage.`),
      filesSelected: exact(workflowPlan.filesSelected, "Pinned manifest AOI intersection."),
      filesExcluded: exact(manifest.totalFiles - workflowPlan.filesSelected, "Pinned manifest AOI intersection."),
    },
    pruning: {
      selectedObjectRows: exact(
        workflowPlan.selectedObjectRows,
        "Pinned object metadata; this is not an engine rows-scanned counter.",
      ),
      candidateRowGroups: exact(
        workflowPlan.selectedObjectRowGroups,
        "Pinned object metadata; this is a pruning opportunity, not observed engine pruning.",
      ),
      rowGroupsPruned: unsupported(
        "DuckDB-WASM does not expose an observed row-group-pruned counter through the public SDK runtime.",
      ),
    },
    rows: {
      returned: exact(execution.result.features.length, "Length of the accepted SDK Result feature array."),
      scanned: unsupported("DuckDB-WASM does not expose an observed rows-scanned counter through this runtime."),
    },
    memory: {
      engineCeilingBytes: exact(
        workflowPlan.memoryLimitMiB * 1024 * 1024,
        "Configured DuckDB memory ceiling; this is not observed peak memory.",
      ),
      resultCeilingBytes: exact(workflowPlan.maxResultBytes, "Fail-closed JavaScript materialization policy."),
      materializedResultBytes: exact(resultBytes, "UTF-8 byte length of the accepted SDK Result JSON."),
      observedPeakBytes: unsupported(
        "The browser worker does not expose a reliable per-query peak-memory counter through the public SDK runtime.",
      ),
    },
    cache: { policy: "bypass", identity: receipt.cacheIdentity },
    resultFidelity,
    timing: {
      sdkPlanMs: planMs,
      sourceProbeMs,
      engineExecutionMs: engineMs,
      totalMs: planMs + sourceProbeMs + engineMs,
    },
    worker: {
      boundedExecution: exact(
        true,
        "The dedicated public runtime accepted the memory, single-thread, and insertion-order policy before execution.",
      ),
      cleanup: exact(true, "The bound public runtime disposer completed before this receipt was returned."),
    },
    presentation: unsupported(
      "Renderer UI and direct GeoArrow/deck.gl transfer remain outside S1 pending the renderer and transfer contracts.",
    ),
  };
  return { result: execution.result, evidence };
}

function runtimePolicySql(plan: OvertureQueryPlan): string {
  if (!Number.isSafeInteger(plan.memoryLimitMiB) || plan.memoryLimitMiB < 1 || plan.memoryLimitMiB > 4_096) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Worker memory ceiling must be a safe integer from 1 through 4096 MiB.",
    );
  }
  return `SET memory_limit='${plan.memoryLimitMiB}MB'; SET threads=1; SET preserve_insertion_order=false;`;
}

function buildSdkPlan<T>(
  workflowPlan: OvertureQueryPlan,
  manifest: OvertureSourceManifest,
  descriptor: SourceDescriptor,
  object: OvertureObjectManifest,
  resource: GeoParquetResourceHandleV1,
): QueryExecutionPlanV2 {
  return explainQuery({
    descriptor,
    geoparquetResource: resource,
    query: cloudNativeAnalysisQuery<T>(workflowPlan),
    capabilityPolicy: "strict",
    fallback: { mode: "disabled" },
    schemaVersion: manifest.schemaVersion,
    sourceVersion: `${manifest.release}:${object.etag}`,
    authorizationScope: AUTHORIZATION_SCOPE,
    estimates: {
      rows: workflowPlan.selectedObjectRows,
      bytes: object.bytes,
      // This estimates the accepted remote query, not the independently
      // observed range-probe requests reported in the evidence receipt.
      requests: 1,
    },
  });
}

function planReceipt(plan: QueryExecutionPlanV2): CloudNativeAnalysisPlanReceipt {
  return {
    version: plan.version,
    id: plan.id,
    fingerprint: plan.fingerprint,
    cacheIdentity: queryPlanCacheKey(plan),
    pushdown: plan.pushdown,
    fidelity: plan.fidelity,
  };
}

function resourceHandle(plan: OvertureQueryPlan, descriptor: SourceDescriptor): GeoParquetResourceHandleV1 {
  return createGeoParquetResourceHandle({
    resolver: RESOURCE_RESOLVER,
    id: descriptor.id,
    authorizationContextId: authorizationContext(plan),
    resourceVersion: selectedPlanObject(plan).etag,
  });
}

function authorizationContext(plan: OvertureQueryPlan): string {
  return `public:anonymous:${plan.lane}`;
}

function selectedObject(
  plan: OvertureQueryPlan,
  manifest: OvertureSourceManifest,
  descriptor: SourceDescriptor,
): OvertureObjectManifest {
  if (descriptor.protocol !== "geoparquet" || plan.lane !== manifest.lane || plan.filesSelected !== 1) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Cloud-native analysis requires one GeoParquet object from the matching manifest lane.",
    );
  }
  const object = selectedPlanObject(plan);
  const manifestObject = manifest.objects.find((candidate) => candidate.objectKey === object.objectKey);
  if (
    !manifestObject ||
    manifestObject.id !== object.id ||
    manifestObject.url !== object.url ||
    manifestObject.etag !== object.etag ||
    manifestObject.bytes !== object.bytes ||
    manifestObject.rows !== object.rows ||
    manifestObject.rowGroups !== object.rowGroups ||
    manifestObject.lastModified !== object.lastModified ||
    !sameBbox(manifestObject.bbox, object.bbox)
  ) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Selected object identity does not match the pinned source manifest.",
    );
  }
  return object;
}

function sameBbox(left: OvertureObjectManifest["bbox"], right: OvertureObjectManifest["bbox"]): boolean {
  return left.every((value, index) => value === right[index]);
}

function selectedPlanObject(plan: OvertureQueryPlan): OvertureObjectManifest {
  const object = plan.selectedObjects[0];
  if (!object || plan.selectedObjects.length !== 1) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Cloud-native analysis requires exactly one selected object.",
    );
  }
  return object;
}

function boundedResultBytes(result: Result<unknown>): number {
  try {
    return new TextEncoder().encode(JSON.stringify(result)).byteLength;
  } catch {
    throw new CloudNativeAnalysisRejectedError(
      "unsafe-materialization",
      "Result cannot be represented as bounded JSON evidence.",
    );
  }
}

function exact<T>(value: T, basis: string): CloudNativeMetric<T> {
  return { fidelity: "exact", value, basis };
}

function unsupported(reason: string): CloudNativeMetric<never> {
  return { fidelity: "unsupported", value: null, reason };
}

function defaultClock(): number {
  return performance.now();
}

function readClock(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value)) {
    throw new CloudNativeAnalysisRejectedError("invalid-workflow-input", "Workflow clock must return finite values.");
  }
  return value;
}

function elapsed(start: number, end: number): number {
  if (end < start) {
    throw new CloudNativeAnalysisRejectedError("invalid-workflow-input", "Workflow clock must be monotonic.");
  }
  return end - start;
}

function finiteDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Source evidence duration must be finite and non-negative.",
    );
  }
  return value;
}
