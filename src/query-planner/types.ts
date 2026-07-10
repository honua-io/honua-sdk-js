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
  readonly schemaVersion?: string;
  readonly sourceVersion?: string;
  readonly authorizationScope: readonly string[];
  readonly capabilities: readonly Capability[];
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

export interface RemoteQueryPlanStep {
  readonly id: string;
  readonly engine: "remote";
  readonly operation: "query" | "queryAll" | "queryAggregate";
  readonly pushdown: "full" | "partial";
  readonly fidelity: "exact";
  readonly reason: string;
  readonly requests: number;
  readonly query: CanonicalQuery;
  readonly compiled: GeoServicesCompiledQueryV1;
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

export class HonuaQueryPlanningError extends Error {
  public constructor(
    public readonly code: QueryPlanningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HonuaQueryPlanningError";
  }
}

export type QueryPlanExecutionErrorCode = "invalid-plan" | "plan-context-mismatch" | "unsafe-materialization";

export class HonuaQueryPlanExecutionError extends Error {
  public constructor(
    public readonly code: QueryPlanExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HonuaQueryPlanExecutionError";
  }
}

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
