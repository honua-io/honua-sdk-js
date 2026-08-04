/**
 * Dependency-free columnar batch and worker-transfer contracts exported by
 * `@honua/sdk-js/query-planner` for large geospatial results.
 *
 * The Honua envelope includes a normative dependency-free GeoArrow 0.2 mapping
 * without importing an Arrow implementation. Transfers expose exact
 * backing-allocation and payload-copy metrics, deduplicate shared backing
 * buffers, enforce conservative default ceilings, and use a one-owner lease
 * with deterministic cancellation, acknowledgement, error, and disposal
 * behavior.
 *
 * @experimental
 */

export { ColumnarBatchLease, createColumnarBatch, inspectColumnarBatch, leaseColumnarBatch } from "./transfer.js";
export { fromApacheArrowRecordBatch, loadApacheArrow, toApacheArrowRecordBatch } from "./apache-arrow.js";
export { createGeoArrowBatch, decodeGeoArrowBatch, inspectGeoArrowBatch } from "./geoarrow.js";
export {
  DEFAULT_COLUMNAR_RESULT_MAX_FEATURES,
  columnarBatchToResult,
  columnarBatchToResultPages,
  resultToColumnarBatch,
} from "./result.js";
export type {
  ColumnarBatchToResultOptions,
  ColumnarBatchToResultPagesOptions,
  ColumnarGeoJsonGeometry,
  ColumnarGeoJsonGeometryType,
  ColumnarResult,
  ColumnarResultAttributeBinding,
  ColumnarResultDictionaryBinding,
  ColumnarResultFeatureIdBinding,
  ColumnarResultGeometryDescriptor,
  ColumnarResultProvenance,
  ColumnarResultTemporalBinding,
  ResultToColumnarBatchAttributeOptions,
  ResultToColumnarBatchGeometryOptions,
  ResultToColumnarBatchOptions,
  ResultToColumnarBatchResult,
} from "./result.js";
export { createGeoArrowReprojectOperation } from "./geoarrow-reproject.js";
export type { CreateGeoArrowReprojectOperationOptions } from "./geoarrow-reproject.js";
export {
  DEFAULT_GEOARROW_AGGREGATE_MAX_GROUPS,
  DEFAULT_GEOARROW_AGGREGATE_YIELD_ROWS,
  GEOARROW_AGGREGATE_ABORT_CHECK_ROWS,
  GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX,
  HONUA_GEOARROW_AGGREGATE_LAYOUT_VERSION,
  createGeoArrowAggregateOperation,
  readGeoArrowAggregateBatch,
} from "./geoarrow-aggregate.js";
export type {
  CreateGeoArrowAggregateOperationOptions,
  GeoArrowAggregateDictionaryGroupSpec,
  GeoArrowAggregateGridGroupSpec,
  GeoArrowAggregateGroupSpec,
  GeoArrowAggregateMetricKind,
  GeoArrowAggregateMetricSpec,
  GeoArrowAggregateNullKeyPolicy,
  GeoArrowAggregateNumericColumn,
  GeoArrowAggregateResult,
  GeoArrowAggregateRow,
  GeoArrowAggregateSource,
  GeoArrowAggregateTemporalGroupSpec,
  GeoArrowAggregateTruncationUnit,
} from "./geoarrow-aggregate.js";
export {
  createGeoArrowFilterOperation,
  createGeoArrowProjectionOperation,
  createGeoArrowTransformOperation,
} from "./operators.js";
export {
  GEOARROW_ENVELOPE_MIGRATIONS,
  HONUA_GEOARROW_ENVELOPE_KIND,
  HONUA_GEOARROW_ENVELOPE_VERSION,
  deserializeGeoArrowBatch,
  planGeoArrowEnvelopeMigration,
  readableGeoArrowEnvelopeVersions,
  serializeGeoArrowBatch,
} from "./geoarrow-serialization.js";
export {
  DEFAULT_COLUMNAR_BATCH_CACHE_MAX_AGE_MS,
  DEFAULT_COLUMNAR_BATCH_CACHE_MAX_RECORDS,
  DEFAULT_COLUMNAR_BATCH_CACHE_QUOTA_BYTES,
  HONUA_COLUMNAR_BATCH_CACHE_FORMAT,
  MAX_COLUMNAR_BATCH_CACHE_MAX_AGE_MS,
  MAX_COLUMNAR_BATCH_CACHE_MAX_RECORDS,
  MAX_COLUMNAR_BATCH_CACHE_QUOTA_BYTES,
  columnarAuthorizationScopeDigest,
  columnarBatchCacheKey,
  columnarBatchCacheOrderingDigest,
  createColumnarBatchCache,
  createMemoryColumnarBatchCacheStorage,
  planColumnarBatchCacheAdmission,
} from "./batch-cache.js";
export type {
  ColumnarBatchCacheAdmissionV1,
  ColumnarBatchCacheDiagnosticV1,
  ColumnarBatchCacheEntryV1,
  ColumnarBatchCacheFreshnessV1,
  ColumnarBatchCacheHandle,
  ColumnarBatchCacheMissReason,
  ColumnarBatchCacheOptions,
  ColumnarBatchCacheReadOptions,
  ColumnarBatchCacheReadV1,
  ColumnarBatchCacheRecordV1,
  ColumnarBatchCacheRefusalReason,
  ColumnarBatchCacheStaleReason,
  ColumnarBatchCacheStorage,
  ColumnarBatchCacheWriteOptions,
  ColumnarBatchCacheWriteV1,
} from "./batch-cache.js";
export { createIndexedDbColumnarBatchCacheStorage } from "./batch-cache-indexeddb.js";
export type { IndexedDbColumnarBatchCacheStorageOptions } from "./batch-cache-indexeddb.js";
export {
  COLUMNAR_BATCH_CACHE_CONFORMANCE_CASES,
  HONUA_COLUMNAR_BATCH_CACHE_CONFORMANCE_KIND,
  HONUA_COLUMNAR_BATCH_CACHE_CONFORMANCE_VERSION,
  columnarBatchCacheFixtureBatch,
  columnarBatchCacheFixtureIdentity,
  columnarBatchCacheLegacyEntry,
  runColumnarBatchCacheConformance,
} from "./batch-cache-conformance.js";
export type {
  ColumnarBatchCacheConformanceCaseResultV1,
  ColumnarBatchCacheConformanceOptions,
  ColumnarBatchCacheConformanceReportV1,
} from "./batch-cache-conformance.js";
export {
  GEOARROW_SPEC_VERSION,
  HONUA_GEOARROW_LAYOUT_VERSION,
  HonuaGeoArrowError,
} from "./geoarrow-types.js";
export type {
  GeoArrowEnvelopeMigrationPlanV1,
  GeoArrowEnvelopeMigrationRefusal,
  GeoArrowEnvelopeMigrationV1,
} from "./geoarrow-types.js";
export type {
  ApacheArrowAdapterMetrics,
  ApacheArrowAdapterOptions,
  ApacheArrowDataLike,
  ApacheArrowFieldLike,
  ApacheArrowModuleImporter,
  ApacheArrowModuleLike,
  ApacheArrowRecordBatchLike,
  ApacheArrowRecordBatchResult,
  ApacheArrowTypeLike,
  ApacheArrowVectorLike,
  CreateGeoArrowBatchInput,
  CreatedGeoArrowBatch,
  DecodedGeoArrowBatch,
  DecodedGeoArrowRow,
  GeoArrowBatchInspection,
  GeoArrowBatchSerializationResult,
  GeoArrowConversionLimits,
  GeoArrowSerializationMetrics,
  GeoArrowSerializationOptions,
  GeoArrowConversionMetrics,
  GeoArrowCoordinateLayout,
  GeoArrowCrs,
  GeoArrowDictionaryBuffers,
  GeoArrowDictionaryColumnInput,
  GeoArrowDimensions,
  GeoArrowEdges,
  GeoArrowFeatureIdColumnInput,
  GeoArrowGeometryBuffers,
  GeoArrowGeometryColumnInput,
  GeoArrowGeometryKind,
  GeoArrowLineString,
  GeoArrowLineStringColumnInput,
  GeoArrowPoint,
  GeoArrowPointColumnInput,
  GeoArrowPolygon,
  GeoArrowPolygonColumnInput,
  GeoArrowPosition,
  GeoArrowTemporalBuffers,
  GeoArrowTemporalColumnInput,
  GeoArrowTimestampUnit,
  FromApacheArrowRecordBatchOptions,
  GeoArrowBatchFromApacheResult,
  HonuaGeoArrowErrorCode,
  LoadApacheArrowOptions,
} from "./geoarrow-types.js";
export type {
  CreateGeoArrowFilterOperationOptions,
  CreateGeoArrowProjectionOperationOptions,
  CreateGeoArrowTransformOperationOptions,
  GeoArrowProjectionColumn,
  GeoArrowRowPredicate,
} from "./operators.js";
export {
  COLUMNAR_WORKER_CANCEL_KIND,
  COLUMNAR_WORKER_ERROR_KIND,
  COLUMNAR_WORKER_PROGRESS_KIND,
  COLUMNAR_WORKER_PROTOCOL_VERSION,
  COLUMNAR_WORKER_REQUEST_KIND,
  COLUMNAR_WORKER_RESULT_KIND,
  HonuaColumnarWorkerError,
  createColumnarWorkerSession,
  startColumnarWorkerHost,
} from "./worker.js";
export type {
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
  ColumnarWorkerStreamOrdering,
  ColumnarWorkerTransport,
  CreateColumnarWorkerSessionOptions,
  ExecuteColumnarWorkerOperationOptions,
  StartColumnarWorkerHostOptions,
} from "./worker.js";
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
} from "./types.js";
export type {
  ColumnarBatchLeaseState,
  ColumnarBatchIdentityV1,
  ColumnarBatchLimits,
  ColumnarBatchMetrics,
  ColumnarBatchV1,
  ColumnarBufferRole,
  ColumnarBufferV1,
  ColumnarFieldV1,
  ColumnarFreshnessV1,
  ColumnarOrderingKeyV1,
  ColumnarOrderingV1,
  ColumnarSchemaV1,
  ColumnarTransferErrorCode,
  ColumnarTransferMessageV1,
  ColumnarTransferOptions,
  ColumnarTransferReceipt,
  ColumnarTransferTarget,
  ColumnarTypeV1,
  CreateColumnarBatchInput,
} from "./types.js";
