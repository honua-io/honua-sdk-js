/**
 * Protocol-neutral temporal data-history contracts.
 *
 * Honua exposes temporal history — "git over data" — from many surfaces:
 * Console, MCP clients in Claude/GPT, the QGIS plugin, and Studio-generated
 * maps, dashboards, and reports. This module is the single shared vocabulary
 * those surfaces speak so AI prompts and UI builders do not drift from server
 * truth. It mirrors the server contract tracked in honua-server#1166 and the
 * Console information model in
 * `honua-console/docs/architecture/temporal-data-viewer-information-model.md`.
 *
 * It is intentionally a contract surface only: it describes the request
 * envelopes SDK callers send and the response shapes apps render. Unsupported
 * capabilities are represented explicitly (`mode: "none"`, capability flags,
 * and {@link TemporalError} codes) rather than inferred from missing fields,
 * so a read-only history source is never confused with named-version editing
 * (honua-server#371).
 *
 * The {@link createTemporalClient} factory layers thin request builders over
 * any client that can issue a JSON request (the SDK's `HonuaClient` satisfies
 * it via `pipelineRequestJson`); it does not couple to a concrete transport.
 *
 * @module
 */

import type { SpatialFilter } from "../core/spatial-filter.js";
import type { HonuaExtent } from "../core/types.js";
import type { FeatureId, SourceId } from "./types.js";

export const TEMPORAL_SCHEMA_VERSION = "honua.temporal.v1" as const;
export const TEMPORAL_CAPABILITY = "temporalHistory" as const;

/** Route prefix every temporal endpoint shares. */
export const TEMPORAL_ROUTE_PREFIX = "/temporal" as const;

/**
 * Canonical request routes. Large diff and rollback operations return job
 * references (see {@link TemporalDiff.job} / {@link TemporalRollbackOperation})
 * rather than forcing synchronous responses.
 */
export const TEMPORAL_ROUTES = {
  capabilities: "/temporal/capabilities",
  checkpoints: "/temporal/checkpoints",
  queryAsOf: "/temporal/query-as-of",
  diff: "/temporal/diff",
  diffStatus: "/temporal/diffs/{diffId}",
  featureTimeline: "/temporal/features/{featureId}/timeline",
  rollbackPlans: "/temporal/rollback-plans",
  rollbackOperations: "/temporal/rollback-operations",
  rollbackOperationStatus: "/temporal/rollback-operations/{operationId}",
} as const;

/**
 * What a layer or table can support. `none` means temporal history is
 * unavailable; the richer modes are additive (`rollback` implies `diff`,
 * `history`, and `as_of` are also offered). Capability discovery is
 * server-owned — clients must not infer a mode from the presence of fields.
 */
export type TemporalMode = "none" | "as_of" | "history" | "diff" | "rollback";

/** Underlying history model. Opaque to apps; surfaced for diagnostics only. */
export type TemporalHistoryModel =
  | "system_versioned"
  | "valid_time"
  | "transaction_time"
  | "bitemporal"
  | "delta_log"
  | "external_audit";

/** Cursor kinds a checkpoint can address. */
export type TemporalCursorType = "timestamp" | "transaction" | "release" | "job" | "named_checkpoint";

/** Operation that produced a revision. */
export type TemporalRevisionOperation = "insert" | "update" | "delete" | "restore";

/** Operation that produced a change set. */
export type TemporalChangeSetOperationKind =
  | "interactive_edit"
  | "bulk_import"
  | "etl_job"
  | "metadata_release"
  | "sync"
  | "rollback";

/** Per-feature change classification within a diff. */
export type TemporalFeatureChangeType = "added" | "removed" | "updated" | "unchanged";

/** Scope a rollback targets. */
export type TemporalRollbackScope = "feature" | "selection" | "layer" | "change_set" | "release";

/** How a rollback would be carried out. */
export type TemporalRollbackMode =
  | "metadata_only"
  | "data_revert"
  | "service_revision_switch"
  | "script_required"
  | "manual";

/** Coarse risk band the server assigns to a rollback plan. */
export type TemporalRiskLevel = "low" | "medium" | "high";

/** Lifecycle of a rollback operation. Mirrors {@link import("./jobs.js").JobStatus}. */
export type TemporalRollbackStatus = "accepted" | "running" | "successful" | "failed" | "dismissed";

/** Lifecycle of an asynchronously produced diff. */
export type TemporalDiffStatus = "accepted" | "running" | "successful" | "failed" | "dismissed";

/**
 * Stable machine codes for temporal error/status conditions. Servers and SDK
 * helpers use these so consumers branch on a code rather than parse prose.
 */
export type TemporalErrorCode =
  | "unsupported-history"
  | "masked-fields"
  | "expired-retention"
  | "large-diff-job-required"
  | "rollback-blocked"
  | "approval-required";

/** Error/status envelope shared by every temporal surface. */
export interface TemporalError {
  code: TemporalErrorCode;
  message: string;
  /** Fields the server masked from the response when `code` is `masked-fields`. */
  maskedFields?: readonly string[];
  /** Job reference to follow when `code` is `large-diff-job-required`. */
  job?: TemporalJobRef;
  /** Approver roles/identities required when `code` is `approval-required`. */
  requiredApprovals?: readonly string[];
  /** Optional retention boundary the request fell outside of. */
  retentionExpiresAt?: string;
  details?: unknown;
}

/** Reference to a server job that produces a large diff or runs a rollback. */
export interface TemporalJobRef {
  jobRunId: string;
  /** Stable status code if the server reports one inline. */
  status?: TemporalDiffStatus | TemporalRollbackStatus;
  /** Links to artifacts (diff pages, rollback evidence) when produced. */
  artifactRefs?: readonly string[];
}

/**
 * What a source supports. Read-only history (`rollbackSupported: false`) is
 * always distinguishable from named-version editing, which is a separate
 * contract (honua-server#371).
 */
export interface TemporalSourceCapability {
  sourceId: SourceId;
  resourceId?: string;
  layerId?: string | number;
  mode: TemporalMode;
  historyModel?: TemporalHistoryModel;
  stableFeatureIdField?: string;
  validFromField?: string;
  validToField?: string;
  transactionIdField?: string;
  actorField?: string;
  operationIdField?: string;
  geometryHistorySupported: boolean;
  attributeHistorySupported: boolean;
  rollbackSupported: boolean;
  retentionPolicyId?: string;
  schemaEvolutionPolicy?: string;
  /** Smallest snapshot granularity, e.g. ISO-8601 duration `"PT1H"`. */
  minimumSnapshotGranularity?: string;
  /** Largest diff window the server will compute synchronously, ISO-8601. */
  maxDiffWindow?: string;
  changeTrackingSupported?: boolean;
}

/** Named or implicit point usable as a history cursor. */
export interface TemporalCheckpoint {
  checkpointId: string;
  sourceId: SourceId;
  resourceId?: string;
  cursorType: TemporalCursorType;
  /** Cursor payload; an ISO-8601 timestamp, transaction id, release id, etc. */
  cursorValue: string;
  label?: string;
  createdAt?: string;
  createdBy?: string;
  operationRef?: string;
  gitRef?: string;
  jobRunId?: string;
  metadataReleaseId?: string;
}

/** One committed state of one feature or row. */
export interface TemporalRevision {
  revisionId: string;
  sourceId: SourceId;
  featureId: FeatureId;
  validFrom?: string;
  validTo?: string;
  transactionTime?: string;
  operation: TemporalRevisionOperation;
  actorId?: string;
  actorDisplayName?: string;
  sourceClient?: string;
  jobRunId?: string;
  releaseOperationId?: string;
  editSessionId?: string;
  reason?: string;
  schemaVersion?: string;
  geometryDigest?: string;
  attributeDigest?: string;
}

/** A grouped set of revisions caused by one operation. */
export interface TemporalChangeSet {
  changeSetId: string;
  sourceId: SourceId;
  operationRef?: string;
  operationKind: TemporalChangeSetOperationKind;
  startedAt?: string;
  completedAt?: string;
  actorId?: string;
  status?: string;
  featureCounts?: Readonly<Record<string, number>>;
  fieldCounts?: Readonly<Record<string, number>>;
  geometryChangeCount?: number;
  validationSummary?: unknown;
  /** Whether this change set can be the target of a rollback. */
  rollbackEligibility?: "eligible" | "ineligible" | "requires-approval";
}

/** Field-level before/after change. `before`/`after` are absent when masked. */
export interface TemporalAttributeChange {
  field: string;
  before?: unknown;
  after?: unknown;
  /** True when policy masked the values; see {@link TemporalError} `masked-fields`. */
  masked?: boolean;
}

/** Summary of a geometry change between two revisions. */
export interface TemporalGeometryChange {
  changed: boolean;
  fromDigest?: string;
  toDigest?: string;
  /** Optional server-computed magnitude, e.g. area or vertex delta. */
  magnitude?: number;
}

/** Per-feature comparison within a diff or feature timeline. */
export interface TemporalFeatureDiff {
  featureId: FeatureId;
  changeType: TemporalFeatureChangeType;
  fromRevisionId?: string;
  toRevisionId?: string;
  attributeChanges?: readonly TemporalAttributeChange[];
  geometryChange?: TemporalGeometryChange;
  actorIds?: readonly string[];
  operationRefs?: readonly string[];
  validationFindings?: readonly unknown[];
}

/** Aggregate counts for a diff. */
export interface TemporalDiffSummary {
  addedFeatures: number;
  removedFeatures: number;
  updatedFeatures: number;
  geometryChangedFeatures: number;
  attributeChangedFeatures: number;
  unchangedFeatures?: number;
}

/** Server-generated comparison between two checkpoints or time cursors. */
export interface TemporalDiff {
  diffId: string;
  sourceId: SourceId;
  fromCheckpointId: string;
  toCheckpointId: string;
  status: TemporalDiffStatus;
  extent?: HonuaExtent;
  summary?: TemporalDiffSummary;
  /** A page of per-feature changes; large diffs page via {@link nextCursor}. */
  sampleFeatureChanges?: readonly TemporalFeatureDiff[];
  nextCursor?: string;
  generatedAt?: string;
  expiresAt?: string;
  /** Set when the diff is produced asynchronously by the job runner. */
  job?: TemporalJobRef;
  /** Present on `failed` / unsupported responses. */
  error?: TemporalError;
}

/** The complete revision history for one feature. */
export interface TemporalFeatureTimeline {
  sourceId: SourceId;
  featureId: FeatureId;
  revisions: readonly TemporalRevision[];
  /** Per-revision change detail, parallel to {@link revisions}. */
  changes?: readonly TemporalFeatureDiff[];
  nextCursor?: string;
  error?: TemporalError;
}

/** Server-authored plan for a proposed rollback. Immutable evidence. */
export interface TemporalRollbackPlan {
  rollbackPlanId: string;
  sourceId: SourceId;
  targetScope: TemporalRollbackScope;
  targetCheckpointId: string;
  currentCheckpointId?: string;
  affectedFeatureCount?: number;
  validationFindings?: readonly unknown[];
  compatibilityFindings?: readonly unknown[];
  requiresJob: boolean;
  requiresApproval: boolean;
  rollbackMode: TemporalRollbackMode;
  generatedScriptRef?: string;
  /** Estimated duration as an ISO-8601 duration. */
  estimatedDuration?: string;
  riskLevel?: TemporalRiskLevel;
  /** Set when the plan cannot be produced or rollback is blocked. */
  error?: TemporalError;
}

/** Tracked execution record for a rollback. */
export interface TemporalRollbackOperation {
  rollbackOperationId: string;
  rollbackPlanId: string;
  jobRunId?: string;
  status: TemporalRollbackStatus;
  requestedBy?: string;
  approvedBy?: string;
  startedAt?: string;
  completedAt?: string;
  resultCheckpointId?: string;
  auditEventIds?: readonly string[];
  artifactRefs?: readonly string[];
  failureReason?: string;
  error?: TemporalError;
}

/** Shared filter for as-of, diff, and timeline reads. */
export interface TemporalFilter {
  actorIds?: readonly string[];
  jobRunIds?: readonly string[];
  serviceIds?: readonly string[];
  releaseOperationIds?: readonly string[];
  fields?: readonly string[];
  featureIds?: readonly FeatureId[];
  extent?: HonuaExtent;
  spatialFilter?: SpatialFilter;
  /** Inclusive ISO-8601 time range. */
  from?: string;
  to?: string;
}

/** A history cursor: a checkpoint id, or a typed cursor value. */
export interface TemporalCursor {
  checkpointId?: string;
  cursorType?: TemporalCursorType;
  cursorValue?: string;
}

/** Request to read a source's state at a checkpoint or timestamp. */
export interface TemporalAsOfRequest {
  sourceId: SourceId;
  /** The point in time to read. Provide a checkpoint id or a typed cursor. */
  cursor: TemporalCursor;
  where?: string;
  outFields?: readonly string[];
  filter?: TemporalFilter;
  /** Page size hint for the returned feature window. */
  limit?: number;
  cursorToken?: string;
}

/** Request to compute a diff between two cursors. */
export interface TemporalDiffRequest {
  sourceId: SourceId;
  from: TemporalCursor;
  to: TemporalCursor;
  filter?: TemporalFilter;
  /** Include field-level before/after values when policy allows it. */
  includeAttributeChanges?: boolean;
  includeGeometryChanges?: boolean;
  limit?: number;
}

/** Request to read a feature's revision timeline. */
export interface TemporalFeatureTimelineRequest {
  sourceId: SourceId;
  featureId: FeatureId;
  filter?: TemporalFilter;
  limit?: number;
  cursorToken?: string;
}

/** Request to author a rollback plan. */
export interface TemporalRollbackPlanRequest {
  sourceId: SourceId;
  targetScope: TemporalRollbackScope;
  targetCheckpointId: string;
  /** Required for `feature` / `selection` scopes. */
  featureIds?: readonly FeatureId[];
  /** Required for `layer` scope. */
  layerId?: string | number;
  /** Required for `change_set` scope. */
  changeSetId?: string;
  /** Required for `release` scope. */
  releaseOperationId?: string;
  reason?: string;
}

/** Request to execute a previously authored rollback plan. */
export interface TemporalRollbackExecuteRequest {
  rollbackPlanId: string;
  /** Approver identity when the plan requires approval. */
  approvedBy?: string;
  reason?: string;
}

/**
 * Fixture envelope for Console and Studio temporal viewer prototypes. Captures
 * a coherent set of states for one source so apps and tests can render the
 * full viewer without a live server.
 */
export interface TemporalContractFixture {
  schemaVersion: typeof TEMPORAL_SCHEMA_VERSION;
  capability: TemporalSourceCapability;
  checkpoints: readonly TemporalCheckpoint[];
  asOf: {
    request: TemporalAsOfRequest;
    revisions: readonly TemporalRevision[];
  };
  diff: {
    request: TemporalDiffRequest;
    response: TemporalDiff;
  };
  featureTimeline: {
    request: TemporalFeatureTimelineRequest;
    response: TemporalFeatureTimeline;
  };
  rollback: {
    planRequest: TemporalRollbackPlanRequest;
    plan: TemporalRollbackPlan;
    operation: TemporalRollbackOperation;
  };
  /** Representative error/status envelopes, keyed by code. */
  errors: Readonly<Record<TemporalErrorCode, TemporalError>>;
}

const MODE_RANK: Readonly<Record<TemporalMode, number>> = {
  none: 0,
  as_of: 1,
  history: 2,
  diff: 3,
  rollback: 4,
};

/**
 * `true` when `capability` advertises at least `required`. The modes are
 * additive, so a `rollback` source also supports `diff`, `history`, and
 * `as_of`. A `none` source never satisfies any positive requirement.
 */
export function temporalModeSupports(capability: TemporalSourceCapability, required: TemporalMode): boolean {
  if (required === "none") return true;
  return MODE_RANK[capability.mode] >= MODE_RANK[required];
}

/**
 * `true` when the source exposes read-only temporal history but not rollback
 * — the case that must stay distinct from named-version editing.
 */
export function isReadOnlyTemporalHistory(capability: TemporalSourceCapability): boolean {
  return capability.mode !== "none" && !capability.rollbackSupported;
}

/** Validation issue from {@link validateTemporalRollbackPlanRequest}. */
export interface TemporalValidationIssue {
  path: string;
  message: string;
}

/**
 * Validate the scope-specific fields a rollback plan request must carry.
 * Returns an empty array when valid.
 */
export function validateTemporalRollbackPlanRequest(
  request: TemporalRollbackPlanRequest,
): readonly TemporalValidationIssue[] {
  const issues: TemporalValidationIssue[] = [];
  if (!request.sourceId) issues.push({ path: "sourceId", message: "sourceId is required" });
  if (!request.targetCheckpointId) {
    issues.push({ path: "targetCheckpointId", message: "targetCheckpointId is required" });
  }
  if ((request.targetScope === "feature" || request.targetScope === "selection") && !hasItems(request.featureIds)) {
    issues.push({ path: "featureIds", message: `${request.targetScope} rollback requires featureIds` });
  }
  if (request.targetScope === "layer" && request.layerId === undefined) {
    issues.push({ path: "layerId", message: "layer rollback requires layerId" });
  }
  if (request.targetScope === "change_set" && !request.changeSetId) {
    issues.push({ path: "changeSetId", message: "change_set rollback requires changeSetId" });
  }
  if (request.targetScope === "release" && !request.releaseOperationId) {
    issues.push({ path: "releaseOperationId", message: "release rollback requires releaseOperationId" });
  }
  return issues;
}

/** Throwing variant of {@link validateTemporalRollbackPlanRequest}. */
export function assertValidTemporalRollbackPlanRequest(request: TemporalRollbackPlanRequest): void {
  const issues = validateTemporalRollbackPlanRequest(request);
  if (issues.length > 0) {
    throw new Error(`Invalid temporal rollback plan request: ${issues.map((issue) => issue.path).join(", ")}`);
  }
}

/**
 * Minimal client surface the temporal helpers need. The SDK's `HonuaClient`
 * satisfies this via `pipelineRequestJson`; tests can pass a stub. Query
 * parameters belong on `path`.
 */
export interface TemporalRequestClient {
  pipelineRequestJson<T = unknown>(
    method: "GET" | "POST",
    path: string,
    init?: { headers?: HeadersInit; body?: BodyInit | null },
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Options accepted by every temporal client method. */
export interface TemporalClientCallOptions {
  signal?: AbortSignal;
}

/**
 * Thin request builders over a {@link TemporalRequestClient}. Every method
 * targets a route in {@link TEMPORAL_ROUTES} and returns the canonical shape;
 * unsupported capabilities surface as {@link TemporalError} on the response or
 * as a server error, never as silently empty data.
 */
export interface TemporalClient {
  /** Discover what a source supports. */
  capabilities(resourceId: string, options?: TemporalClientCallOptions): Promise<TemporalSourceCapability>;
  /** List checkpoints (history cursors) for a source. */
  listCheckpoints(sourceId: SourceId, options?: TemporalClientCallOptions): Promise<readonly TemporalCheckpoint[]>;
  /** Read a source's state at a checkpoint or timestamp. */
  queryAsOf(request: TemporalAsOfRequest, options?: TemporalClientCallOptions): Promise<readonly TemporalRevision[]>;
  /** Request a diff between two cursors. May return a job reference. */
  requestDiff(request: TemporalDiffRequest, options?: TemporalClientCallOptions): Promise<TemporalDiff>;
  /** Read the status / next page of a previously requested diff. */
  getDiff(diffId: string, options?: TemporalClientCallOptions & { cursor?: string }): Promise<TemporalDiff>;
  /** Read a feature's revision timeline. */
  featureTimeline(
    request: TemporalFeatureTimelineRequest,
    options?: TemporalClientCallOptions,
  ): Promise<TemporalFeatureTimeline>;
  /** Author a rollback plan. */
  createRollbackPlan(
    request: TemporalRollbackPlanRequest,
    options?: TemporalClientCallOptions,
  ): Promise<TemporalRollbackPlan>;
  /** Execute a previously authored rollback plan. */
  executeRollback(
    request: TemporalRollbackExecuteRequest,
    options?: TemporalClientCallOptions,
  ): Promise<TemporalRollbackOperation>;
  /** Read the status of a rollback operation. */
  rollbackOperationStatus(operationId: string, options?: TemporalClientCallOptions): Promise<TemporalRollbackOperation>;
}

/** Build a {@link TemporalClient} bound to a request client. */
export function createTemporalClient(client: TemporalRequestClient): TemporalClient {
  const jsonInit = (body: unknown): { headers: HeadersInit; body: BodyInit } => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    capabilities(resourceId, options) {
      const path = `${TEMPORAL_ROUTES.capabilities}?resourceId=${encodeURIComponent(resourceId)}`;
      return client.pipelineRequestJson<TemporalSourceCapability>("GET", path, undefined, options?.signal);
    },
    listCheckpoints(sourceId, options) {
      const path = `${TEMPORAL_ROUTES.checkpoints}?sourceId=${encodeURIComponent(String(sourceId))}`;
      return client.pipelineRequestJson<readonly TemporalCheckpoint[]>("GET", path, undefined, options?.signal);
    },
    queryAsOf(request, options) {
      return client.pipelineRequestJson<readonly TemporalRevision[]>(
        "POST",
        TEMPORAL_ROUTES.queryAsOf,
        jsonInit(request),
        options?.signal,
      );
    },
    requestDiff(request, options) {
      return client.pipelineRequestJson<TemporalDiff>("POST", TEMPORAL_ROUTES.diff, jsonInit(request), options?.signal);
    },
    getDiff(diffId, options) {
      const base = TEMPORAL_ROUTES.diffStatus.replace("{diffId}", encodeURIComponent(diffId));
      const path = options?.cursor ? `${base}?cursor=${encodeURIComponent(options.cursor)}` : base;
      return client.pipelineRequestJson<TemporalDiff>("GET", path, undefined, options?.signal);
    },
    featureTimeline(request, options) {
      const path = TEMPORAL_ROUTES.featureTimeline.replace(
        "{featureId}",
        encodeURIComponent(String(request.featureId)),
      );
      return client.pipelineRequestJson<TemporalFeatureTimeline>("POST", path, jsonInit(request), options?.signal);
    },
    async createRollbackPlan(request, options) {
      assertValidTemporalRollbackPlanRequest(request);
      return client.pipelineRequestJson<TemporalRollbackPlan>(
        "POST",
        TEMPORAL_ROUTES.rollbackPlans,
        jsonInit(request),
        options?.signal,
      );
    },
    executeRollback(request, options) {
      return client.pipelineRequestJson<TemporalRollbackOperation>(
        "POST",
        TEMPORAL_ROUTES.rollbackOperations,
        jsonInit(request),
        options?.signal,
      );
    },
    rollbackOperationStatus(operationId, options) {
      const path = TEMPORAL_ROUTES.rollbackOperationStatus.replace("{operationId}", encodeURIComponent(operationId));
      return client.pipelineRequestJson<TemporalRollbackOperation>("GET", path, undefined, options?.signal);
    },
  };
}

function hasItems<T>(value: readonly T[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}
