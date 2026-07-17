import type { Query, Result, Source, SourceDescriptor } from "@honua/sdk-js/contract";
import type { GeoparquetRuntime } from "@honua/sdk-js/geoparquet";
import {
  type GeoParquetResourceHandleV1,
  type QueryExecutionPlanV2,
  canonicalStringify,
  createGeoParquetResourceHandle,
  createGeoParquetResourceRegistry,
  executeQueryPlan,
  explainQuery,
  parseGeoParquetResourceHandle,
  queryPlanCacheKey,
  sha256,
  toJsonValue,
} from "@honua/sdk-js/query-planner";

import {
  OVERTURE_HARD_LIMITS,
  OverturePlanRejectedError,
  validateIsoTimestamp,
  validateOvertureManifest,
  validateOvertureQueryPlan,
} from "./planner.js";
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
const RANGE_FOOTER_PROBE_BYTES = 65_536;

export interface CloudNativeEngineIdentity {
  readonly name: string;
  readonly version: string | null;
  readonly verification: "caller-declared" | "unavailable";
  readonly cacheScope: "execution-only";
}

const UNKNOWN_ENGINE_IDENTITY: CloudNativeEngineIdentity = Object.freeze({
  name: "unverified-geoparquet-runtime",
  version: null,
  verification: "unavailable",
  cacheScope: "execution-only",
});

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
    readonly scope: CloudNativeEngineIdentity["cacheScope"];
    readonly identity: string;
    readonly sdkPlanIdentity: string;
    readonly engine: CloudNativeEngineIdentity;
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
  /** Optional caller declaration; it remains unverified and execution-only in S1 evidence. */
  readonly engineIdentity?: CloudNativeEngineIdentity;
  readonly signal?: AbortSignal;
  /** Monotonic milliseconds; injectable so fixture receipts can be deterministic. */
  readonly now?: () => number;
}

export type CloudNativeAnalysisRejectionCode =
  | "invalid-workflow-input"
  | "unsupported-range-io"
  | "unsafe-materialization"
  | "engine-budget-exceeded";

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
  suppliedResource?: GeoParquetResourceHandleV1,
): CloudNativeAnalysisPlanReceipt {
  const acceptedManifest = acceptedManifestInput(manifest);
  const acceptedPlan = acceptedPlanInput(workflowPlan, acceptedManifest);
  const object = selectedObject(acceptedPlan, acceptedManifest, descriptor);
  const resource = acceptedResourceHandle(suppliedResource, acceptedPlan, descriptor, object);
  return planReceipt(buildSdkPlan(acceptedPlan, acceptedManifest, descriptor, object, resource));
}

/** Credential-free identity for the complete bounded workflow, not just the SDK query plan. */
export function cloudNativeAnalysisCacheIdentity(
  workflowPlan: OvertureQueryPlan,
  manifest: OvertureSourceManifest,
  suppliedEngineIdentity?: CloudNativeEngineIdentity,
): string {
  const acceptedManifest = acceptedManifestInput(manifest);
  const acceptedPlan = acceptedPlanInput(workflowPlan, acceptedManifest);
  const object = selectedPlanObject(acceptedPlan);
  const engine = validateEngineIdentity(suppliedEngineIdentity);
  const digest = sha256(
    `honua.sdk.cloud-native-analysis-cache.v1\n${canonicalStringify(
      toJsonValue({
        source: {
          lane: acceptedPlan.lane,
          release: acceptedManifest.release,
          schemaVersion: acceptedManifest.schemaVersion,
          objectKey: object.objectKey,
          objectVersion: object.etag,
          objectBytes: object.bytes,
        },
        query: {
          aoi: acceptedPlan.aoi,
          crs: acceptedManifest.crs,
          projection: acceptedPlan.projection,
          category: acceptedPlan.category,
          limit: acceptedPlan.limit,
        },
        policy: acceptedPlan.policy,
        engine,
      }),
    )}`,
  );
  return `honua-cloud-native-analysis:v1:${digest}`;
}

/**
 * Execute a reviewed plan through public planner and GeoParquet adapter
 * surfaces. The runner owns no query SQL, query evaluator, or renderer logic;
 * its only SQL is the bounded DuckDB worker-session policy.
 */
export async function runCloudNativeAnalysis<T>(
  options: RunCloudNativeAnalysisOptions<T>,
): Promise<CloudNativeAnalysisRun<T>> {
  const { source, runtime } = options;
  const clock = options.now ?? defaultClock;
  const registry = createGeoParquetResourceRegistry({ resolver: RESOURCE_RESOLVER, maxEntries: 1 });
  let workflowPlan: OvertureQueryPlan | undefined;
  let manifest: OvertureSourceManifest | undefined;
  let range: OvertureRangeEvidence | undefined;
  let engineIdentity: CloudNativeEngineIdentity | undefined;
  let executedObject: OvertureObjectManifest | undefined;
  let execution: Awaited<ReturnType<typeof executeQueryPlan<T>>> | undefined;
  let receipt: CloudNativeAnalysisPlanReceipt | undefined;
  let workflowCacheIdentity: string | undefined;
  let deadline: ExecutionDeadline | undefined;
  let resultBytes = 0;
  let planMs = 0;
  let engineMs = 0;
  let sourceProbeMs = 0;

  try {
    const acceptedManifest = acceptedManifestInput(options.manifest);
    const acceptedPlan = acceptedPlanInput(options.workflowPlan, acceptedManifest);
    const acceptedEngineIdentity = validateEngineIdentity(options.engineIdentity);
    manifest = acceptedManifest;
    workflowPlan = acceptedPlan;
    engineIdentity = acceptedEngineIdentity;
    const authorizationContextId = authorizationContext(acceptedPlan);
    const object = selectedObject(acceptedPlan, acceptedManifest, source.descriptor);
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
    range = validateRangeEvidence(options.range, acceptedPlan, object);
    sourceProbeMs = range.durationMs;

    const planStarted = readClock(clock);
    const plan = buildSdkPlan<T>(acceptedPlan, acceptedManifest, source.descriptor, object, resource);
    planMs = elapsed(planStarted, readClock(clock));
    receipt = planReceipt(plan);
    workflowCacheIdentity = cloudNativeAnalysisCacheIdentity(acceptedPlan, acceptedManifest, acceptedEngineIdentity);

    const engineStarted = readClock(clock);
    const executionDeadline = createExecutionDeadline(acceptedPlan.maxEngineMs, options.signal, () => {
      void runtime.dispose();
    });
    deadline = executionDeadline;
    execution = await waitForAbort(async () => {
      await runtime.query(runtimePolicySql(acceptedPlan), { signal: executionDeadline.signal });
      return executeQueryPlan(plan, source, {
        signal: executionDeadline.signal,
        schemaVersion: acceptedManifest.schemaVersion,
        sourceVersion: `${acceptedManifest.release}:${object.etag}`,
        authorizationScope: AUTHORIZATION_SCOPE,
        authorizationContextId,
        geoParquetResourceResolver: registry.resolver,
      });
    }, executionDeadline.signal);
    engineMs = elapsed(engineStarted, readClock(clock));
    if (engineMs > acceptedPlan.maxEngineMs) {
      throw new CloudNativeAnalysisRejectedError(
        "engine-budget-exceeded",
        `Cloud-native engine execution exceeded the ${acceptedPlan.maxEngineMs} ms budget.`,
      );
    }

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
  } catch (cause) {
    if (deadline?.timedOut) throw deadline.reason;
    throw cause;
  } finally {
    deadline?.dispose();
    try {
      registry.dispose();
    } finally {
      await runtime.dispose();
    }
  }

  if (
    !workflowPlan ||
    !manifest ||
    !range ||
    !engineIdentity ||
    !executedObject ||
    !execution ||
    !receipt ||
    !workflowCacheIdentity
  ) {
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
      resultCeilingBytes: exact(
        workflowPlan.maxResultBytes,
        "Post-materialization rejection ceiling; the adapter may allocate a row before this JSON check can measure it.",
      ),
      materializedResultBytes: exact(
        resultBytes,
        "UTF-8 byte length measured after the adapter materialized the accepted SDK Result JSON.",
      ),
      observedPeakBytes: unsupported(
        "The browser worker does not expose a reliable per-query peak-memory counter through the public SDK runtime.",
      ),
    },
    cache: {
      policy: "bypass",
      scope: engineIdentity.cacheScope,
      identity: workflowCacheIdentity,
      sdkPlanIdentity: receipt.cacheIdentity,
      engine: engineIdentity,
    },
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
  if (
    !Number.isSafeInteger(plan.memoryLimitMiB) ||
    plan.memoryLimitMiB < 1 ||
    plan.memoryLimitMiB > OVERTURE_HARD_LIMITS.memoryLimitMiB
  ) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      `Worker memory ceiling must be a safe integer from 1 through ${OVERTURE_HARD_LIMITS.memoryLimitMiB} MiB.`,
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

function acceptedResourceHandle(
  supplied: GeoParquetResourceHandleV1 | undefined,
  plan: OvertureQueryPlan,
  descriptor: SourceDescriptor,
  object: OvertureObjectManifest,
): GeoParquetResourceHandleV1 {
  const expected = resourceHandle(plan, descriptor);
  if (!supplied) return expected;
  let accepted: GeoParquetResourceHandleV1;
  try {
    accepted = parseGeoParquetResourceHandle(supplied);
  } catch {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Supplied GeoParquet resource handle is invalid.",
    );
  }
  if (
    accepted.resource.resolver !== RESOURCE_RESOLVER ||
    accepted.resource.id !== descriptor.id ||
    accepted.authorizationContextId !== authorizationContext(plan) ||
    accepted.resourceVersion !== object.etag ||
    canonicalStringify(toJsonValue(accepted)) !== canonicalStringify(toJsonValue(expected))
  ) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Supplied GeoParquet resource handle does not match the selected object and authorization context.",
    );
  }
  return accepted;
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

function acceptedManifestInput(manifest: OvertureSourceManifest): OvertureSourceManifest {
  try {
    return validateOvertureManifest(manifest);
  } catch (cause) {
    throw invalidWorkflowCause(cause);
  }
}

function acceptedPlanInput(plan: OvertureQueryPlan, manifest: OvertureSourceManifest): OvertureQueryPlan {
  try {
    return validateOvertureQueryPlan(plan, manifest);
  } catch (cause) {
    throw invalidWorkflowCause(cause);
  }
}

function invalidWorkflowCause(cause: unknown): CloudNativeAnalysisRejectedError {
  return new CloudNativeAnalysisRejectedError(
    "invalid-workflow-input",
    cause instanceof OverturePlanRejectedError ? cause.message : "Workflow input validation failed.",
  );
}

function validateRangeEvidence(
  range: OvertureRangeEvidence,
  plan: OvertureQueryPlan,
  object: OvertureObjectManifest,
): OvertureRangeEvidence {
  if (!isPlainRecord(range)) {
    throw new CloudNativeAnalysisRejectedError("invalid-workflow-input", "Range evidence must be a plain object.");
  }
  if (range.status !== "local-buffer" && range.status !== "verified" && range.status !== "unsupported") {
    throw new CloudNativeAnalysisRejectedError("invalid-workflow-input", "Range evidence status is invalid.");
  }
  let observedAt: string;
  try {
    observedAt = validateIsoTimestamp(range.observedAt, "Range evidence observedAt");
  } catch (cause) {
    throw invalidWorkflowCause(cause);
  }
  if (new Date(observedAt).valueOf() > Date.now() + 5 * 60_000) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Range evidence observedAt cannot be more than five minutes in the future.",
    );
  }
  if (
    range.lane !== plan.lane ||
    range.objectKey !== object.objectKey ||
    range.objectVersion !== object.etag ||
    range.objectBytes !== object.bytes
  ) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Range evidence must identify the selected lane, object key, version, and byte size exactly.",
    );
  }
  if (
    !Number.isSafeInteger(range.bytes) ||
    range.bytes < 0 ||
    range.bytes > object.bytes ||
    !Number.isSafeInteger(range.ranges) ||
    range.ranges < 0 ||
    typeof range.acceptRanges !== "boolean" ||
    !Number.isFinite(range.durationMs) ||
    range.durationMs < 0 ||
    range.durationMs > plan.maxSourceProbeMs ||
    typeof range.cacheStatus !== "string" ||
    range.cacheStatus.length < 1 ||
    range.cacheStatus.length > 256 ||
    typeof range.limitation !== "string" ||
    range.limitation.length < 1 ||
    range.limitation.length > 2_048
  ) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Range evidence contains invalid counts, duration, or bounded text fields.",
    );
  }
  if (range.status === "unsupported") {
    throw new CloudNativeAnalysisRejectedError("unsupported-range-io", range.limitation);
  }
  if (plan.lane === "fixture") {
    if (
      range.status !== "local-buffer" ||
      range.bytes !== object.bytes ||
      range.ranges !== 1 ||
      range.acceptRanges ||
      range.etag !== null ||
      range.lastModified !== null
    ) {
      throw new CloudNativeAnalysisRejectedError(
        "invalid-workflow-input",
        "Fixture range evidence must account for the exact selected local buffer and no HTTP ranges.",
      );
    }
  } else {
    const expectedProbeBytes = 1 + Math.min(RANGE_FOOTER_PROBE_BYTES, object.bytes);
    if (
      range.status !== "verified" ||
      range.bytes !== expectedProbeBytes ||
      range.ranges !== 2 ||
      range.etag !== object.etag ||
      range.lastModified !== object.lastModified
    ) {
      throw new CloudNativeAnalysisRejectedError(
        "invalid-workflow-input",
        "Live range evidence must prove the exact pinned ETag, object bytes, and two bounded range probes.",
      );
    }
  }
  return Object.freeze({
    lane: range.lane,
    objectKey: range.objectKey,
    objectVersion: range.objectVersion,
    status: range.status,
    observedAt,
    bytes: range.bytes,
    ranges: range.ranges,
    objectBytes: range.objectBytes,
    acceptRanges: range.acceptRanges,
    etag: range.etag,
    lastModified: range.lastModified,
    cacheStatus: range.cacheStatus,
    durationMs: range.durationMs,
    limitation: range.limitation,
  });
}

function validateEngineIdentity(supplied?: CloudNativeEngineIdentity): CloudNativeEngineIdentity {
  const engine = supplied ?? UNKNOWN_ENGINE_IDENTITY;
  if (
    !isPlainRecord(engine) ||
    typeof engine.name !== "string" ||
    !/^[a-z0-9@][a-z0-9@/._-]{0,127}$/.test(engine.name) ||
    (engine.version !== null &&
      (typeof engine.version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/.test(engine.version))) ||
    (engine.verification !== "caller-declared" && engine.verification !== "unavailable") ||
    engine.cacheScope !== "execution-only" ||
    (engine.verification === "caller-declared" && engine.version === null) ||
    (engine.verification === "unavailable" && engine.version !== null)
  ) {
    throw new CloudNativeAnalysisRejectedError(
      "invalid-workflow-input",
      "Engine identity must be a bounded caller declaration and remains execution-only until runtime verification exists.",
    );
  }
  return Object.freeze({
    name: engine.name,
    version: engine.version,
    verification: engine.verification,
    cacheScope: "execution-only",
  });
}

interface ExecutionDeadline {
  readonly signal: AbortSignal;
  readonly reason: CloudNativeAnalysisRejectedError;
  readonly timedOut: boolean;
  dispose(): void;
}

function createExecutionDeadline(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  onTimeout: () => void,
): ExecutionDeadline {
  const controller = new AbortController();
  const reason = new CloudNativeAnalysisRejectedError(
    "engine-budget-exceeded",
    `Cloud-native engine execution exceeded the ${timeoutMs} ms budget.`,
  );
  let timedOut = false;
  const abortFromCaller = () => controller.abort(cancellationReason());
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = controller.signal.aborted
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        controller.abort(reason);
        onTimeout();
      }, timeoutMs);
  return {
    signal: controller.signal,
    reason,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function waitForAbort<T>(startOperation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? cancellationReason());
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? cancellationReason());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    let operation: Promise<T>;
    try {
      operation = startOperation();
    } catch (cause) {
      cleanup();
      reject(cause);
      return;
    }
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

function cancellationReason(): DOMException {
  return new DOMException("Cloud-native analysis was cancelled.", "AbortError");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
