/**
 * `@honua/sdk-js/query-planner` — deterministic query IR, explain plans, and
 * bounded execution for the protocol-neutral contract.
 *
 * Planning is synchronous and side-effect free: it uses a caller-supplied
 * descriptor/capability snapshot and never fetches metadata or result rows.
 * Execution is separate and validates the accepted fingerprint and source
 * context before invoking a `Source`.
 *
 * @experimental
 * @packageDocumentation
 */

export { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
export { executeQueryPlan } from "./executor.js";
export { compileGeoServicesQuery } from "./geoservices.js";
export { canonicalizeQuery, createQueryIr, hashQueryIr, queryFromCanonical } from "./ir.js";
export { explainQuery, hashQueryPlan } from "./planner.js";
export {
  HonuaQueryPlanExecutionError,
  HonuaQueryPlanningError,
  MAX_LOCAL_MATERIALIZATION_ROWS,
  QUERY_IR_KIND,
  QUERY_IR_VERSION,
  QUERY_PLAN_KIND,
  QUERY_PLAN_VERSION,
} from "./types.js";
export type {
  CanonicalQuery,
  CanonicalSpatialFilter,
  ExecuteQueryPlanOptions,
  ExplainQueryOptions,
  GeoServicesCompiledQueryV1,
  JsonPrimitive,
  JsonValue,
  LocalAggregatePlanStep,
  QueryExecutionPlanV1,
  QueryFallbackPolicy,
  QueryIrSourceIdentity,
  QueryIrV1,
  QueryPlanExecution,
  QueryPlanExecutionErrorCode,
  QueryPlanExecutor,
  QueryPlanningErrorCode,
  QueryPlanningEstimates,
  QueryPlanStep,
  RemoteQueryPlanStep,
} from "./types.js";
