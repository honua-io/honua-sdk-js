import type {
  AggregationSpec,
  Capability,
  CapabilityPolicy,
  GeoParquetGeometryEncoding,
  GeoParquetGeometryExecution,
  GeoParquetGeometryUnsupportedReason,
  Protocol,
  Query,
  Result,
  Source,
  SourceDescriptor,
} from "../contract/types.js";
import { type HonuaErrorOptions, HonuaSdkError } from "../core/error-envelope.js";
import type { EsriGeometryType, EsriSpatialRel } from "../core/types.js";

export const QUERY_IR_VERSION = "1.0" as const;
export const QUERY_PLAN_VERSION = "1.0" as const;
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

/** Executable geometry representation accepted by the DuckDB SQL compiler. */
export type DuckDbGeometryEncoding = GeoParquetGeometryExecution;

export interface QueryIrGeoparquetGeometryIdentity {
  readonly column: string;
  readonly primary: boolean;
  readonly geometryEncoding: GeoParquetGeometryEncoding;
  readonly geometryExecution?: DuckDbGeometryEncoding;
  readonly spatialRuntimeAvailable: boolean;
  readonly unsupportedReason?: GeoParquetGeometryUnsupportedReason;
  readonly bboxColumn?: string;
}

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
  /** Exact descriptive identity of the primary geometry column. */
  readonly geometryEncoding?: GeoParquetGeometryEncoding;
  /** Reviewed installed-runtime representation. Never inferred by the planner. */
  readonly geometryExecution?: DuckDbGeometryEncoding;
  readonly geometrySpatialRuntimeAvailable?: boolean;
  readonly geometryUnsupportedReason?: GeoParquetGeometryUnsupportedReason;
  readonly geometries?: readonly QueryIrGeoparquetGeometryIdentity[];
  /** Optional GeoParquet 1.1 bbox-covering struct column for row-group pruning. */
  readonly bboxColumn?: string;
}

export interface QueryIrV1 {
  readonly kind: typeof QUERY_IR_KIND;
  readonly version: typeof QUERY_IR_VERSION;
  readonly source: QueryIrSourceIdentity;
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
  readonly geometryEncoding?: GeoParquetGeometryEncoding;
  readonly geometryExecution?: DuckDbGeometryEncoding;
  /** True when a non-envelope spatial filter was reduced to its bounding box. */
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
  readonly fidelity: "exact";
  readonly reason: string;
  readonly requests: number;
  readonly query: CanonicalQuery;
  readonly compiled: RemoteCompiledQueryV1;
}

export interface LocalAggregatePlanStep {
  readonly id: string;
  readonly engine: "client";
  readonly operation: "aggregate";
  readonly pushdown: "none";
  readonly fidelity: "exact";
  readonly reason: string;
  readonly inputStepId: string;
  readonly aggregation: AggregationSpec;
  readonly maxRows: number;
  readonly maxBytes?: number;
}

export type QueryPlanStep = RemoteQueryPlanStep | LocalAggregatePlanStep;

export interface QueryExecutionPlanV1 {
  readonly kind: typeof QUERY_PLAN_KIND;
  readonly version: typeof QUERY_PLAN_VERSION;
  readonly id: string;
  readonly fingerprint: `sha256:${string}`;
  readonly ir: QueryIrV1;
  readonly capabilityPolicy: CapabilityPolicy;
  readonly fallback: QueryFallbackPolicy;
  readonly pushdown: "full" | "partial";
  readonly fidelity: "exact";
  readonly cache: "bypass";
  readonly estimates: QueryPlanningEstimates;
  readonly steps: readonly QueryPlanStep[];
  readonly warnings: readonly string[];
}

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
  | "unsafe-materialization"
  | "invalid-resource-handle"
  | "resource-unavailable"
  | "resource-expired"
  | "resource-resolution-failed";

export class HonuaQueryPlanExecutionError extends HonuaSdkError {
  public constructor(
    public readonly code: QueryPlanExecutionErrorCode,
    message: string,
    options: HonuaErrorOptions = {},
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
  "unsafe-materialization": "query.execution.unsafe-materialization",
  "invalid-resource-handle": "query.execution.invalid-resource-handle",
  "resource-unavailable": "query.execution.resource-unavailable",
  "resource-expired": "query.execution.resource-expired",
  "resource-resolution-failed": "query.execution.resource-resolution-failed",
} as const satisfies Record<QueryPlanExecutionErrorCode, `query.execution.${string}`>;

export interface ExecuteQueryPlanOptions {
  readonly signal?: AbortSignal;
  readonly schemaVersion?: string;
  readonly sourceVersion?: string;
  readonly authorizationScope?: readonly string[];
}

export interface QueryPlanExecution<T = Record<string, unknown>> {
  readonly planId: string;
  readonly fingerprint: `sha256:${string}`;
  readonly result: Result<T>;
}

/** Executor signature exported for dependency injection and test doubles. */
export type QueryPlanExecutor = <T>(
  plan: QueryExecutionPlanV1,
  source: Source<T>,
  options?: ExecuteQueryPlanOptions,
) => Promise<QueryPlanExecution<T>>;
