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
export { createGeoArrowBatch, decodeGeoArrowBatch, inspectGeoArrowBatch } from "./geoarrow.js";
export {
  GEOARROW_SPEC_VERSION,
  HONUA_GEOARROW_LAYOUT_VERSION,
  HonuaGeoArrowError,
} from "./geoarrow-types.js";
export type {
  CreateGeoArrowBatchInput,
  CreatedGeoArrowBatch,
  DecodedGeoArrowBatch,
  DecodedGeoArrowRow,
  GeoArrowBatchInspection,
  GeoArrowConversionLimits,
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
  HonuaGeoArrowErrorCode,
} from "./geoarrow-types.js";
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
