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
export { compileDuckDbQuery } from "./duckdb.js";
export { executeQueryPlan } from "./executor.js";
export { compileGeoServicesQuery } from "./geoservices.js";
export { compileGrpcQuery } from "./grpc.js";
export { compileOgcApiFeaturesQuery } from "./ogc-features.js";
export { compileOdataQuery } from "./odata.js";
export { compileWfsQuery } from "./wfs.js";
export { canonicalizeQuery, createQueryIr, hashQueryIr, queryFromCanonical } from "./ir.js";
export { explainQuery, hashQueryPlan } from "./planner.js";
export {
  QUERY_RESOURCE_HANDLE_KIND,
  QUERY_RESOURCE_HANDLE_VERSION,
  createGeoParquetResourceRegistry,
  hashGeoParquetResourceHandle,
  parseGeoParquetResourceHandle,
  resolveGeoParquetResource,
} from "./resource.js";
export {
  COLUMNAR_WORKER_CANCEL_KIND,
  COLUMNAR_WORKER_ERROR_KIND,
  COLUMNAR_WORKER_PROGRESS_KIND,
  COLUMNAR_WORKER_PROTOCOL_VERSION,
  COLUMNAR_WORKER_REQUEST_KIND,
  COLUMNAR_WORKER_RESULT_KIND,
  ColumnarBatchLease,
  HonuaColumnarWorkerError,
  createColumnarBatch,
  createColumnarWorkerSession,
  inspectColumnarBatch,
  leaseColumnarBatch,
  startColumnarWorkerHost,
} from "../columnar/index.js";
export {
  COLUMNAR_BATCH_KIND,
  COLUMNAR_BATCH_VERSION,
  COLUMNAR_TRANSFER_KIND,
  DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
  DEFAULT_COLUMNAR_BATCH_MAX_BUFFER_VIEWS,
  DEFAULT_COLUMNAR_BATCH_MAX_METADATA_ENTRIES,
  DEFAULT_COLUMNAR_BATCH_MAX_ROWS,
  DEFAULT_COLUMNAR_BATCH_MAX_SCHEMA_NODES,
  DEFAULT_COLUMNAR_BATCH_MAX_STRING_BYTES,
  HonuaColumnarTransferError,
} from "../columnar/index.js";
export type {
  ColumnarBatchLeaseState,
  ColumnarBatchLimits,
  ColumnarBatchMetrics,
  ColumnarBatchV1,
  ColumnarBufferRole,
  ColumnarBufferV1,
  ColumnarFieldV1,
  ColumnarSchemaV1,
  ColumnarTransferErrorCode,
  ColumnarTransferMessageV1,
  ColumnarTransferOptions,
  ColumnarTransferReceipt,
  ColumnarTransferTarget,
  ColumnarTypeV1,
  CreateColumnarBatchInput,
  ColumnarWorkerCancelV1,
  ColumnarWorkerErrorCode,
  ColumnarWorkerErrorV1,
  ColumnarWorkerExecutionProgress,
  ColumnarWorkerExecutionResult,
  ColumnarWorkerFactory,
  ColumnarWorkerFaultEvent,
  ColumnarWorkerHost,
  ColumnarWorkerMessageEvent,
  ColumnarWorkerOperation,
  ColumnarWorkerOperationContext,
  ColumnarWorkerProgressV1,
  ColumnarWorkerRequestV1,
  ColumnarWorkerResultV1,
  ColumnarWorkerSession,
  ColumnarWorkerSessionState,
  ColumnarWorkerTransport,
  CreateColumnarWorkerSessionOptions,
  ExecuteColumnarWorkerOperationOptions,
  StartColumnarWorkerHostOptions,
} from "../columnar/index.js";
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
  DuckDbCompiledQueryV1,
  DuckDbGeometryEncoding,
  ExecuteQueryPlanOptions,
  ExplainQueryOptions,
  GeoServicesCompiledQueryV1,
  GrpcCompiledQueryV1,
  GrpcSpatialRelationship,
  GrpcStatisticType,
  JsonPrimitive,
  JsonValue,
  LocalAggregatePlanStep,
  OgcApiFeaturesCompiledQueryV1,
  OdataCompiledQueryV1,
  QueryExecutionPlanV1,
  QueryFallbackPolicy,
  QueryIrGeoparquetIdentity,
  QueryIrSourceIdentity,
  QueryIrV1,
  QueryPlanExecution,
  QueryPlanExecutionErrorCode,
  QueryPlanExecutor,
  QueryPlanningErrorCode,
  QueryPlanningEstimates,
  RemoteCompiledQueryV1,
  QueryPlanStep,
  RemoteQueryPlanStep,
  WfsCompiledQueryV1,
} from "./types.js";
export type {
  GeoParquetResolverResourceReferenceV1,
  GeoParquetResourceHandleV1,
  GeoParquetResourceRegistry,
  GeoParquetResourceRegistryOptions,
  GeoParquetResourceResolutionContext,
  GeoParquetResourceResolver,
  RegisterGeoParquetResourceInput,
  ResolvedGeoParquetResource,
} from "./resource.js";
