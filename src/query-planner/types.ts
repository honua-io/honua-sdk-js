import type {
  AggregationSpec,
  Capability,
  CapabilityPolicy,
  Protocol,
  Query,
  Result,
  Source,
  SourceDescriptor,
} from "../contract/types.js";
import { type HonuaErrorOptions, HonuaSdkError } from "../core/error-envelope.js";
import type { EsriGeometryType, EsriSpatialRel } from "../core/types.js";
import type { GeoParquetResourceHandleV1, GeoParquetResourceResolver } from "./resource.js";

export const QUERY_IR_VERSION = "1.0" as const;
export const QUERY_PLAN_VERSION = "1.0" as const;
export const QUERY_IR_V2_VERSION = "2.0" as const;
export const QUERY_PLAN_V2_VERSION = "2.0" as const;
export const QUERY_PLAN_DIAGNOSTICS_VERSION = "1.0" as const;
export const QUERY_PLANNER_VERSION = "honua-query-planner@1" as const;
export const QUERY_IR_KIND = "honua.query-ir" as const;
export const QUERY_PLAN_KIND = "honua.query-plan" as const;

/** Hard safety ceiling for this first in-process fallback implementation. */
export const MAX_LOCAL_MATERIALIZATION_ROWS = 100_000;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CanonicalSpatialFilter {
  readonly geometry: { readonly [key: string]: JsonValue };
  readonly geometryType: EsriGeometryType;
  readonly spatialRel?: EsriSpatialRel;
}

/**
 * Serializable form of the current canonical {@link Query}. `AbortSignal` is
 * deliberately excluded: cancellation belongs to execution, never identity.
 */
export interface CanonicalQuery {
  /** The current contract carries a source-native string escape hatch. */
  readonly where?: { readonly kind: "source-native"; readonly expression: string };
  readonly spatialFilter?: CanonicalSpatialFilter;
  readonly outFields?: readonly string[];
  readonly orderBy?: readonly { readonly field: string; readonly direction: "asc" | "desc" }[];
  readonly pagination?: { readonly offset?: number; readonly limit?: number };
  readonly aggregation?: AggregationSpec;
  readonly returnGeometry?: boolean;
  readonly outSr?: string | number;
}

export interface QueryIrSourceIdentity {
  readonly id: string;
  readonly protocol: Protocol;
  /** Credential-free endpoint identity: origin/path plus protocol locator ids. */
  readonly endpoint: string;
  readonly serviceId?: string;
  readonly layerId?: number;
  readonly collectionId?: string | number;
  readonly typeName?: string;
  readonly entitySet?: string;
  /** Descriptor-derived geometry property used by the metadata-free OData compiler. */
  readonly geometryProperty?: string;
  readonly srsName?: string;
  readonly schemaVersion?: string;
  readonly sourceVersion?: string;
  /** DuckDB/GeoParquet addressing derived from the descriptor for the SQL compiler. */
  readonly geoparquet?: QueryIrGeoparquetIdentity;
  readonly authorizationScope: readonly string[];
  readonly capabilities: readonly Capability[];
}

/** Physical geometry encoding of a GeoParquet column, per the DuckDB SQL compiler. */
export type DuckDbGeometryEncoding = "wkb" | "native" | "geojson";

/**
 * Deterministic GeoParquet addressing carried on the IR so the DuckDB SQL
 * compiler can build `read_parquet(...)` SQL with spatial pushdown without a
 * profiling round-trip. Derived from `locator.url`, `locator.geoparquet`, and
 * the descriptor schema.
 */
export interface QueryIrGeoparquetIdentity {
  /** Parquet file URL(s) / hive glob(s) read as one relation. */
  readonly sources: readonly string[];
  /** Geometry column name, when the source is spatial. */
  readonly geometryColumn?: string;
  /** Physical encoding of the geometry column (defaults to `wkb`). */
  readonly geometryEncoding?: DuckDbGeometryEncoding;
  /** Optional GeoParquet 1.1 bbox-covering struct column for row-group pruning. */
  readonly bboxColumn?: string;
}

/** Credential-free GeoParquet identity used by v2 plans. */
export interface QueryIrGeoparquetResourceIdentity {
  readonly resource: GeoParquetResourceHandleV1;
  /** Geometry metadata is safe planner input and never requires locator resolution. */
  readonly geometryColumn?: string;
  readonly geometryEncoding?: DuckDbGeometryEncoding;
  readonly bboxColumn?: string;
}

/** GeoParquet-only v2 source identity. Raw locators are deliberately absent. */
export interface QueryIrSourceIdentityV2 {
  /** Stable logical id copied from the validated opaque handle. */
  readonly id: string;
  readonly protocol: "geoparquet";
  readonly endpoint: "[opaque-resource]";
  /** Safe descriptor metadata needed to reconstruct bounded-local plans exactly. */
  readonly primaryKey?: string;
  readonly schemaVersion?: string;
  readonly sourceVersion?: string;
  readonly geoparquet: QueryIrGeoparquetResourceIdentity;
  readonly authorizationScope: readonly string[];
  readonly capabilities: readonly Capability[];
}

export interface QueryIrV1 {
  readonly kind: typeof QUERY_IR_KIND;
  readonly version: typeof QUERY_IR_VERSION;
  readonly source: QueryIrSourceIdentity;
  readonly query: CanonicalQuery;
}

export interface QueryIrV2 {
  readonly kind: typeof QUERY_IR_KIND;
  readonly version: typeof QUERY_IR_V2_VERSION;
  readonly source: QueryIrSourceIdentityV2;
  readonly query: CanonicalQuery;
}

export type QueryFallbackPolicy =
  | { readonly mode: "disabled" }
  | {
      readonly mode: "bounded-local";
      /** Maximum feature objects that may enter local execution. */
      readonly maxRows: number;
      /** Optional additional ceiling measured from the materialized JSON payload. */
      readonly maxBytes?: number;
    };

export interface QueryPlanningEstimates {
  readonly rows?: number;
  readonly bytes?: number;
  readonly requests?: number;
}

export type QueryPlanBoundConfidence = "exact" | "bounded" | "estimated" | "unknown";
export type QueryPlanBoundSource = "compiler" | "query-limit" | "fallback-policy" | "caller-estimate" | "unavailable";

/** One deterministic quantity bound. Missing numbers are deliberately unknown, never zero. */
export interface QueryPlanQuantityBound {
  readonly unit: "request" | "row" | "byte";
  readonly confidence: QueryPlanBoundConfidence;
  readonly source: QueryPlanBoundSource;
  readonly lower?: number;
  readonly upper?: number;
  readonly estimate?: number;
}

/** Versioned cost and safety bounds used at both plan and step scope. */
export interface QueryPlanBoundsV1 {
  readonly version: typeof QUERY_PLAN_DIAGNOSTICS_VERSION;
  readonly requests: QueryPlanQuantityBound;
  readonly rows: QueryPlanQuantityBound;
  readonly bytes: QueryPlanQuantityBound;
  readonly transferBytes: QueryPlanQuantityBound;
  readonly materializationBytes: QueryPlanQuantityBound;
}

export type QueryPlanCachePolicy = "bypass" | "prefer-cache" | "require-fresh";
export type QueryPlanCacheFreshness = "fresh" | "stale" | "unknown";
export type QueryPlanCacheAction = "bypass" | "reuse" | "revalidate" | "refresh";
export type QueryPlanValidatorKind = "etag" | "last-modified" | "revision" | "fingerprint";

export interface QueryPlanValidatorInput {
  readonly kind: QueryPlanValidatorKind;
  /** Raw validators are accepted at planning only and persisted as a digest. */
  readonly value?: string;
  /** Safe reconstruction path for already-digested persisted provenance. */
  readonly fingerprint?: `sha256:${string}`;
}

export interface QueryPlanCacheOptions {
  readonly policy?: QueryPlanCachePolicy;
  readonly freshness?: QueryPlanCacheFreshness;
  readonly validator?: QueryPlanValidatorInput;
}

export interface QueryPlanCacheDecisionV1 {
  readonly version: typeof QUERY_PLAN_DIAGNOSTICS_VERSION;
  readonly policy: QueryPlanCachePolicy;
  readonly action: QueryPlanCacheAction;
  readonly freshness: QueryPlanCacheFreshness;
  readonly validator?: { readonly kind: QueryPlanValidatorKind; readonly fingerprint: `sha256:${string}` };
  readonly reason: "policy-bypass" | "fresh-entry" | "validator-available" | "stale-entry" | "cache-miss";
}

export type QueryPlanFidelity = "exact" | "equivalent" | "approximate";

export interface QueryPlanFidelityLoss {
  readonly code: "spatial-envelope-reduction";
  readonly path: string;
  readonly description: string;
  readonly remediation: string;
}

export type QueryPlanDiscoveryState = "metadata" | "declared" | "inferred" | "unavailable";

export interface QueryPlanDiscoveryContext {
  readonly state: QueryPlanDiscoveryState;
  /** Raw discovery source is planning-only and persisted as a digest. */
  readonly source?: string;
  readonly sourceFingerprint?: `sha256:${string}`;
  readonly validator?: QueryPlanValidatorInput;
}

export interface QueryPlanProvenanceV1 {
  readonly version: typeof QUERY_PLAN_DIAGNOSTICS_VERSION;
  readonly source: {
    readonly id: string;
    readonly protocol: Protocol;
    readonly endpointFingerprint: `sha256:${string}`;
    readonly descriptorFingerprint: `sha256:${string}`;
  };
  readonly schema:
    | { readonly state: "known"; readonly fingerprint: `sha256:${string}`; readonly basis: "schema-v2" | "version" }
    | { readonly state: "unavailable"; readonly reason: "not-provided" };
  readonly discovery: {
    readonly state: QueryPlanDiscoveryState;
    readonly sourceFingerprint?: `sha256:${string}`;
    readonly validator?: { readonly kind: QueryPlanValidatorKind; readonly fingerprint: `sha256:${string}` };
    readonly fingerprint: `sha256:${string}`;
  };
  readonly authorizationScope: { readonly fingerprint: `sha256:${string}`; readonly count: number };
}

export interface QueryPlanStepProvenanceV1 {
  readonly version: typeof QUERY_PLAN_DIAGNOSTICS_VERSION;
  readonly sourceFingerprint: `sha256:${string}`;
  readonly schemaFingerprint?: `sha256:${string}`;
  readonly discoveryFingerprint: `sha256:${string}`;
  readonly authorizationScopeFingerprint: `sha256:${string}`;
}

export type QueryPlanExecutionMode = "snapshot" | "delta";

export interface QueryPlanValidityV1 {
  readonly version: typeof QUERY_PLAN_DIAGNOSTICS_VERSION;
  readonly plannerVersion: typeof QUERY_PLANNER_VERSION;
  readonly contractVersion: string;
  readonly executionMode: QueryPlanExecutionMode;
  readonly sourceFingerprint: `sha256:${string}`;
  readonly schemaFingerprint: `sha256:${string}`;
  readonly discoveryFingerprint: `sha256:${string}`;
  readonly authorizationScopeFingerprint: `sha256:${string}`;
  readonly queryFingerprint: `sha256:${string}`;
  readonly crsFingerprint: `sha256:${string}`;
  readonly policyFingerprint: `sha256:${string}`;
  readonly fingerprint: `sha256:${string}`;
}

export type QueryPlanWarningCode =
  | "bounded-local-fallback"
  | "geometry-transfer-required"
  | "approximate-spatial-filter";

export interface QueryPlanWarning {
  readonly code: QueryPlanWarningCode;
  readonly severity: "warning";
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

export interface ExplainQueryOptions<T = Record<string, unknown>> {
  readonly descriptor: SourceDescriptor;
  readonly query?: Readonly<Query<T>>;
  readonly capabilityPolicy?: CapabilityPolicy;
  readonly fallback?: QueryFallbackPolicy;
  readonly schemaVersion?: string;
  readonly sourceVersion?: string;
  /** Stable scope identifiers only. Never pass credentials or tokens. */
  readonly authorizationScope?: readonly string[];
  /** Caller-supplied metadata estimates; explaining never reads result data. */
  readonly estimates?: QueryPlanningEstimates;
  /** Stable cache state only. Observation clocks never enter a plan fingerprint. */
  readonly cache?: QueryPlanCacheOptions;
  /** Credential-safe discovery identity. Raw sources/validators are digested. */
  readonly discovery?: QueryPlanDiscoveryContext;
  /** Realtime delta plans carry mode only; live cursor bytes remain transport state. */
  readonly executionMode?: QueryPlanExecutionMode;
}

/** Opt-in GeoParquet v2 planning options. */
export interface ExplainGeoParquetQueryOptions<T = Record<string, unknown>> extends ExplainQueryOptions<T> {
  /** Opaque stable identity; the locator remains private to the injected resolver. */
  readonly geoparquetResource: GeoParquetResourceHandleV1;
}

export interface GeoServicesCompiledQueryV1 {
  readonly compiler: "geoservices-rest-query-v1";
  readonly serviceId: string;
  readonly layerId: number;
  readonly where?: string;
  readonly outFields?: readonly string[];
  readonly returnGeometry?: boolean;
  readonly outSr?: string | number;
  readonly orderByFields?: string;
  readonly geometry?: { readonly [key: string]: JsonValue };
  readonly geometryType?: EsriGeometryType;
  readonly spatialRel?: EsriSpatialRel;
  readonly resultOffset?: number;
  readonly resultRecordCount?: number;
  readonly outStatistics?: readonly {
    readonly statisticType: string;
    readonly onStatisticField: string;
    readonly outStatisticFieldName: string;
  }[];
  readonly groupByFieldsForStatistics?: string;
}

/** Inspectable OGC API Features `/items` request produced without I/O. */
export interface OgcApiFeaturesCompiledQueryV1 {
  readonly compiler: "ogc-api-features-query-v1";
  readonly collectionId: string | number;
  readonly filter?: string;
  readonly filterLang?: "cql2-text";
  readonly properties?: readonly string[];
  readonly sortby?: string;
  readonly bbox?: string;
  readonly crs?: string;
  readonly offset?: number;
  readonly limit?: number;
}

/** Inspectable WFS 2.0 GetFeature request produced without I/O. */
export interface WfsCompiledQueryV1 {
  readonly compiler: "wfs-2.0-get-feature-v1";
  readonly typeName: string;
  readonly filter?: string;
  readonly propertyName?: readonly string[];
  readonly sortBy?: string;
  readonly startIndex?: number;
  readonly count?: number;
  readonly srsName?: string;
}

/** Inspectable OData v4 entity-set query produced without I/O. */
export interface OdataCompiledQueryV1 {
  readonly compiler: "odata-v4-query-v1";
  readonly entitySet: string;
  readonly filter?: string;
  readonly select?: readonly string[];
  readonly expand?: readonly string[];
  readonly orderBy?: readonly string[];
  readonly skip?: number;
  readonly top?: number;
}

/** Inspectable DuckDB `SELECT` over `read_parquet(...)` produced without I/O. */
export interface DuckDbCompiledQueryV1 {
  readonly compiler: "duckdb-sql-v1";
  /** Deterministic, injection-safe DuckDB SQL text. */
  readonly sql: string;
  /** Parquet file URL(s) / glob(s) the SQL reads. */
  readonly sources: readonly string[];
  readonly geometryColumn?: string;
  readonly geometryEncoding?: DuckDbGeometryEncoding;
  /** True when a non-envelope spatial filter was reduced to its bounding box. */
  readonly bboxApproximated?: boolean;
}

/** Credential-free DuckDB template compiled for execution-time resource binding. */
export interface DuckDbCompiledQueryV2 {
  readonly compiler: "duckdb-sql-v2";
  /** Inspectable SQL over a fixed non-runnable placeholder, never a raw locator. */
  readonly sqlTemplate: string;
  readonly resource: GeoParquetResourceHandleV1;
  readonly geometryColumn?: string;
  readonly geometryEncoding?: DuckDbGeometryEncoding;
  readonly bboxApproximated?: boolean;
}

/** Proto spatial-relationship enum value name emitted by the gRPC compiler. */
export type GrpcSpatialRelationship =
  | "SPATIAL_RELATIONSHIP_INTERSECTS"
  | "SPATIAL_RELATIONSHIP_WITHIN"
  | "SPATIAL_RELATIONSHIP_CONTAINS"
  | "SPATIAL_RELATIONSHIP_ENVELOPE_INTERSECTS"
  | "SPATIAL_RELATIONSHIP_CROSSES"
  | "SPATIAL_RELATIONSHIP_TOUCHES"
  | "SPATIAL_RELATIONSHIP_OVERLAPS"
  | "SPATIAL_RELATIONSHIP_DISJOINT";

/** Proto statistic-type enum value name emitted by the gRPC compiler. */
export type GrpcStatisticType =
  | "STATISTIC_TYPE_COUNT"
  | "STATISTIC_TYPE_SUM"
  | "STATISTIC_TYPE_MIN"
  | "STATISTIC_TYPE_MAX"
  | "STATISTIC_TYPE_AVG"
  | "STATISTIC_TYPE_STDDEV"
  | "STATISTIC_TYPE_VAR";

/**
 * Inspectable `honua.v1.FeatureService/QueryFeatures` unary request produced
 * without pulling in the protobuf runtime. Field names and enum value names
 * mirror the generated `QueryFeaturesRequest` message so the plan is a faithful,
 * deterministic description of the wire request.
 */
export interface GrpcCompiledQueryV1 {
  readonly compiler: "honua-grpc-query-features-v1";
  readonly service: "honua.v1.FeatureService";
  readonly method: "QueryFeatures";
  readonly serviceId: string;
  readonly layerId: number;
  readonly where?: string;
  readonly outFields?: readonly string[];
  readonly returnGeometry?: boolean;
  readonly outSr?: string | number;
  readonly orderBy?: string;
  readonly resultOffset?: number;
  readonly resultRecordCount?: number;
  readonly spatialFilter?: {
    readonly geometry: { readonly [key: string]: JsonValue };
    readonly geometryType: EsriGeometryType;
    readonly spatialRelationship: GrpcSpatialRelationship;
  };
  readonly outStatistics?: readonly {
    readonly statisticType: GrpcStatisticType;
    readonly onStatisticField: string;
    readonly outStatisticFieldName: string;
  }[];
  readonly groupBy?: readonly string[];
}

export type RemoteCompiledQueryV1 =
  | GeoServicesCompiledQueryV1
  | OgcApiFeaturesCompiledQueryV1
  | WfsCompiledQueryV1
  | OdataCompiledQueryV1
  | DuckDbCompiledQueryV1
  | GrpcCompiledQueryV1;

export interface RemoteQueryPlanStep {
  readonly id: string;
  readonly engine: "remote";
  readonly operation: "query" | "queryAll" | "queryAggregate";
  readonly pushdown: "full" | "partial";
  readonly fidelity: QueryPlanFidelity;
  readonly losses: readonly QueryPlanFidelityLoss[];
  readonly bounds: QueryPlanBoundsV1;
  readonly provenance: QueryPlanStepProvenanceV1;
  readonly reason: string;
  readonly requests: number;
  readonly query: CanonicalQuery;
  readonly compiled: RemoteCompiledQueryV1;
}

export interface GeoParquetRemoteQueryPlanStepV2 {
  readonly id: string;
  readonly engine: "remote";
  readonly operation: "query" | "queryAll" | "queryAggregate";
  readonly pushdown: "full" | "partial";
  readonly fidelity: QueryPlanFidelity;
  readonly losses: readonly QueryPlanFidelityLoss[];
  readonly bounds: QueryPlanBoundsV1;
  readonly provenance: QueryPlanStepProvenanceV1;
  readonly reason: string;
  readonly requests: number;
  readonly query: CanonicalQuery;
  readonly compiled: DuckDbCompiledQueryV2;
}

export interface LocalAggregatePlanStep {
  readonly id: string;
  readonly engine: "client";
  readonly operation: "aggregate";
  readonly pushdown: "none";
  readonly fidelity: "equivalent";
  readonly losses: readonly QueryPlanFidelityLoss[];
  readonly bounds: QueryPlanBoundsV1;
  readonly provenance: QueryPlanStepProvenanceV1;
  readonly reason: string;
  readonly inputStepId: string;
  readonly aggregation: AggregationSpec;
  readonly maxRows: number;
  readonly maxBytes?: number;
}

export type QueryPlanStep = RemoteQueryPlanStep | LocalAggregatePlanStep;
export type QueryPlanStepV2 = GeoParquetRemoteQueryPlanStepV2 | LocalAggregatePlanStep;

export interface QueryExecutionPlanV1 {
  readonly kind: typeof QUERY_PLAN_KIND;
  readonly version: typeof QUERY_PLAN_VERSION;
  readonly id: string;
  readonly fingerprint: `sha256:${string}`;
  readonly ir: QueryIrV1;
  readonly capabilityPolicy: CapabilityPolicy;
  readonly fallback: QueryFallbackPolicy;
  readonly pushdown: "full" | "partial";
  readonly diagnosticsVersion: typeof QUERY_PLAN_DIAGNOSTICS_VERSION;
  readonly fidelity: QueryPlanFidelity;
  readonly losses: readonly QueryPlanFidelityLoss[];
  readonly bounds: QueryPlanBoundsV1;
  readonly cache: QueryPlanCacheDecisionV1;
  readonly provenance: QueryPlanProvenanceV1;
  readonly validity: QueryPlanValidityV1;
  readonly estimates: QueryPlanningEstimates;
  readonly steps: readonly QueryPlanStep[];
  readonly warnings: readonly QueryPlanWarning[];
}

export interface QueryExecutionPlanV2 {
  readonly kind: typeof QUERY_PLAN_KIND;
  readonly version: typeof QUERY_PLAN_V2_VERSION;
  readonly id: string;
  readonly fingerprint: `sha256:${string}`;
  readonly ir: QueryIrV2;
  readonly capabilityPolicy: CapabilityPolicy;
  readonly fallback: QueryFallbackPolicy;
  readonly pushdown: "full" | "partial";
  readonly diagnosticsVersion: typeof QUERY_PLAN_DIAGNOSTICS_VERSION;
  readonly fidelity: QueryPlanFidelity;
  readonly losses: readonly QueryPlanFidelityLoss[];
  readonly bounds: QueryPlanBoundsV1;
  readonly cache: QueryPlanCacheDecisionV1;
  readonly provenance: QueryPlanProvenanceV1;
  readonly validity: QueryPlanValidityV1;
  readonly estimates: QueryPlanningEstimates;
  readonly steps: readonly QueryPlanStepV2[];
  readonly warnings: readonly QueryPlanWarning[];
}

export type QueryExecutionPlan = QueryExecutionPlanV1 | QueryExecutionPlanV2;

export type QueryPlanningErrorCode =
  | "invalid-query"
  | "unsupported-compiler"
  | "unsupported-query"
  | "capability-not-supported"
  | "fallback-disabled"
  | "unsafe-materialization";

export class HonuaQueryPlanningError extends HonuaSdkError {
  public constructor(
    public readonly code: QueryPlanningErrorCode,
    message: string,
    options: HonuaErrorOptions = {},
  ) {
    super(QUERY_PLANNING_CODES[code], message, options);
    this.name = "HonuaQueryPlanningError";
  }
}

export type QueryPlanExecutionErrorCode =
  | "invalid-plan"
  | "plan-context-mismatch"
  | "stale-plan"
  | "foreign-plan"
  | "unsafe-materialization"
  | "invalid-resource-handle"
  | "resource-unavailable"
  | "resource-expired"
  | "resource-resolution-failed"
  | "resource-execution-failed";

export class HonuaQueryPlanExecutionError extends HonuaSdkError {
  public constructor(
    public readonly code: QueryPlanExecutionErrorCode,
    message: string,
    options: HonuaErrorOptions = {},
    public readonly reason?: QueryPlanExecutionFailureReason,
  ) {
    super(QUERY_EXECUTION_CODES[code], message, options);
    this.name = "HonuaQueryPlanExecutionError";
  }
}

const QUERY_PLANNING_CODES = {
  "invalid-query": "query.planning.invalid-query",
  "unsupported-compiler": "query.planning.unsupported-compiler",
  "unsupported-query": "query.planning.unsupported-query",
  "capability-not-supported": "query.planning.capability-not-supported",
  "fallback-disabled": "query.planning.fallback-disabled",
  "unsafe-materialization": "query.planning.unsafe-materialization",
} as const satisfies Record<QueryPlanningErrorCode, `query.planning.${string}`>;

const QUERY_EXECUTION_CODES = {
  "invalid-plan": "query.execution.invalid-plan",
  "plan-context-mismatch": "query.execution.plan-context-mismatch",
  "stale-plan": "query.execution.plan-context-mismatch",
  "foreign-plan": "query.execution.plan-context-mismatch",
  "unsafe-materialization": "query.execution.unsafe-materialization",
  "invalid-resource-handle": "query.execution.invalid-resource-handle",
  "resource-unavailable": "query.execution.resource-unavailable",
  "resource-expired": "query.execution.resource-expired",
  "resource-resolution-failed": "query.execution.resource-resolution-failed",
  "resource-execution-failed": "query.execution.resource-execution-failed",
} as const satisfies Record<QueryPlanExecutionErrorCode, `query.execution.${string}`>;

export interface ExecuteQueryPlanOptions {
  readonly signal?: AbortSignal;
  readonly schemaVersion?: string;
  readonly sourceVersion?: string;
  readonly authorizationScope?: readonly string[];
  readonly discovery?: QueryPlanDiscoveryContext;
  readonly executionMode?: QueryPlanExecutionMode;
  /** Exact non-secret partition id required by a GeoParquet v2 resource handle. */
  readonly authorizationContextId?: string;
  /** Lifecycle-scoped resolver used only at the trusted v2 execution boundary. */
  readonly geoParquetResourceResolver?: GeoParquetResourceResolver;
}

export type QueryPlanExecutionFailureReason =
  | "source-identity-changed"
  | "authorization-scope-changed"
  | "source-version-changed"
  | "schema-changed"
  | "capabilities-changed"
  | "discovery-changed"
  | "execution-mode-changed";

export interface QueryPlanExecution<T = Record<string, unknown>> {
  readonly planId: string;
  readonly fingerprint: `sha256:${string}`;
  readonly result: Result<T>;
}

/** Executor signature exported for dependency injection and test doubles. */
export type QueryPlanExecutor = <T>(
  plan: QueryExecutionPlan,
  source: Source<T>,
  options?: ExecuteQueryPlanOptions,
) => Promise<QueryPlanExecution<T>>;
