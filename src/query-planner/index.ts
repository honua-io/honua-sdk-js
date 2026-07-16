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
export { compileDuckDbQuery, compileDuckDbQueryV2, compileSemanticDuckDbQuery } from "./duckdb.js";
export { executeQueryPlan } from "./executor.js";
export { compileGeoServicesQuery } from "./geoservices.js";
export { compileGrpcQuery, compileSemanticGrpcQuery } from "./grpc.js";
export { compileOgcApiFeaturesQuery, compileSemanticOgcApiFeaturesQuery } from "./ogc-features.js";
export { compileOdataQuery } from "./odata.js";
export { compileWfsQuery } from "./wfs.js";
export {
  canonicalizeQuery,
  createGeoParquetQueryIr,
  createQueryIr,
  hashQueryIr,
  queryFromCanonical,
} from "./ir.js";
export {
  explainQuery,
  hashQueryPlan,
  migrateGeoParquetQueryPlanV1,
  parseQueryPlan,
  queryPlanCacheKey,
  serializeQueryPlan,
} from "./planner.js";
export {
  QUERY_RESOURCE_HANDLE_KIND,
  QUERY_RESOURCE_HANDLE_VERSION,
  createGeoParquetResourceHandle,
  createGeoParquetResourceRegistry,
  hashGeoParquetResourceHandle,
  parseGeoParquetResourceHandle,
  resolveGeoParquetResource,
} from "./resource.js";
export {
  SEMANTIC_QUERY_CANONICAL_KIND,
  SEMANTIC_QUERY_CANONICAL_VERSION,
  SEMANTIC_QUERY_HASH_DOMAIN,
  canonicalSemanticQueryBytes,
  hashSemanticQuery,
  serializeCanonicalSemanticQuery,
} from "./semantic-canonical.js";
export { legacyWhereToNativeFilter } from "./semantic-compat.js";
export type {
  SemanticCompilationResult,
  SemanticCompilerDiagnostic,
  SemanticCompilerFidelity,
  SemanticCompilerLoss,
  SemanticCompilerUnsupportedCode,
  SemanticSqlParameter,
} from "./semantic-compiler.js";
export { semanticFilterFromCql2Json, semanticFilterToCql2Json } from "./cql2-json.js";
export {
  MAX_SEMANTIC_QUERY_BYTES,
  MAX_SEMANTIC_QUERY_COLLECTION_ITEMS,
  MAX_SEMANTIC_QUERY_DEPTH,
  MAX_SEMANTIC_QUERY_NODES,
  MAX_SEMANTIC_QUERY_TEXT_BYTES,
  createSemanticQueryBuilder,
  defineSemanticQuery,
  defineSpatialNode,
  parseSemanticQuery,
  temporalLiteral,
} from "./semantic.js";
export type { SemanticQueryBuilder } from "./semantic.js";
export type {
  AggregateMetric,
  BuiltInNativeDialect,
  CanonicalSemanticQueryOptions,
  Cql2JsonExpression,
  Cql2JsonInterchangeOptions,
  ComparisonNode,
  CountMetric,
  DistanceOperand,
  DistanceSpatialPredicate,
  DistanceUnit,
  EqualityOperator,
  ExtremumMetric,
  FieldName,
  FirstPageRequest,
  GeometryFieldName,
  GeometryProjectionFor,
  GroupableFieldName,
  ListNode,
  LegacyWhereDialectFor,
  LegacyWhereProtocol,
  LiteralNode,
  NativeDialectFor,
  NativeFilter,
  NativePayloadFor,
  NullNode,
  NumericFieldName,
  NumericMetric,
  OffsetPageRequest,
  OrderableFieldName,
  OrderedComparisonOperator,
  OutputCrsFor,
  ParseSemanticQueryOptions,
  PatternNode,
  PropertyNode,
  QueryFilter,
  QueryLiteral,
  RangeNode,
  ScalarFieldName,
  SemanticAggregateQuery,
  SemanticFeatureQuery,
  SemanticFilter,
  SemanticPageRequest,
  SemanticQuery,
  SemanticSort,
  SourceSpatiality,
  SpatialNode,
  SpatialPredicate,
  SpatialityForSchema,
  StringFieldName,
  TemporalFieldName,
  TemporalLiteralNode,
  TemporalNode,
  TemporalPredicate,
  TemporalValue,
  TopologicalSpatialPredicate,
} from "./semantic-types.js";
export type {
  SemanticDuckDbCompileOptions,
  SemanticDuckDbCompiledQueryV1,
  SemanticDuckDbGeometrySource,
  SemanticDuckDbOutputGeometry,
  SemanticDuckDbSpatialCompilation,
} from "./duckdb.js";
export type {
  SemanticGrpcCompileOptions,
  SemanticGrpcCompiledQueryV1,
  SemanticGrpcCoordinate,
  SemanticGrpcCoordinateSequence,
  SemanticGrpcGeometry,
  SemanticGrpcSourceIdentity,
  SemanticGrpcSpatialReference,
  SemanticGrpcSpatialRelationship,
} from "./grpc.js";
export type {
  Cql2FilterLanguage,
  OgcApiFeaturesFilterConformanceEvidence,
  SemanticOgcApiFeaturesCompileOptions,
  SemanticOgcApiFeaturesCompiledQueryV1,
  SemanticOgcApiFeaturesSourceIdentity,
} from "./ogc-features.js";
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
  QUERY_IR_V2_VERSION,
  QUERY_PLAN_V2_VERSION,
} from "./types.js";
export type {
  CanonicalQuery,
  CanonicalSpatialFilter,
  DuckDbCompiledQueryV1,
  DuckDbCompiledQueryV2,
  DuckDbGeometryEncoding,
  ExecuteQueryPlanOptions,
  ExplainGeoParquetQueryOptions,
  ExplainQueryOptions,
  GeoParquetRemoteQueryPlanStepV2,
  GeoServicesCompiledQueryV1,
  GrpcCompiledQueryV1,
  GrpcSpatialRelationship,
  GrpcStatisticType,
  JsonPrimitive,
  JsonValue,
  LocalAggregatePlanStep,
  OgcApiFeaturesCompiledQueryV1,
  OdataCompiledQueryV1,
  QueryExecutionPlan,
  QueryExecutionPlanV1,
  QueryExecutionPlanV2,
  QueryFallbackPolicy,
  QueryIrGeoparquetIdentity,
  QueryIrGeoparquetResourceIdentity,
  QueryIrSourceIdentity,
  QueryIrSourceIdentityV2,
  QueryIrV1,
  QueryIrV2,
  QueryPlanExecution,
  QueryPlanExecutionErrorCode,
  QueryPlanExecutor,
  QueryPlanningErrorCode,
  QueryPlanningEstimates,
  RemoteCompiledQueryV1,
  QueryPlanStep,
  QueryPlanStepV2,
  RemoteQueryPlanStep,
  WfsCompiledQueryV1,
} from "./types.js";
export type {
  CreateGeoParquetResourceHandleInput,
  GeoParquetResolverResourceReferenceV1,
  GeoParquetResourceHandleV1,
  GeoParquetResourceRegistry,
  GeoParquetResourceRegistryOptions,
  GeoParquetResourceResolutionContext,
  GeoParquetResourceResolver,
  RegisterGeoParquetResourceInput,
  ResolvedGeoParquetResource,
} from "./resource.js";
