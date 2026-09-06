/**
 * `@honua/sdk-js` — reviewed common workflow.
 *
 * The root owns the shortest protocol-neutral path: connect to a source,
 * query it, inspect/explain the accepted query, and mount it through the
 * lightweight MapLibre source bridge. Advanced protocol clients, renderers,
 * app state, migration, styling, realtime, offline, and analysis APIs remain
 * supported from their focused subpaths. The root stabilizes only the planner
 * vocabulary required to explain and mount this common workflow; the complete
 * `@honua/sdk-js/query-planner` subpath remains experimental.
 *
 * The exact runtime and declaration surface is governed by
 * `config/root-surface.json`; `npm run verify:root-surface` fails on barrel,
 * migration, or replacement drift.
 *
 * @packageDocumentation
 */

export { HONUA_MINIMUM_SUPPORTED_SERVER_VERSION, HonuaClient } from "./core/client.js";
export {
  HONUA_CONNECT_ADAPTER_VERSION,
  HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
  HONUA_CONNECT_PROJECTION_VERSION,
  connect,
} from "./connect.js";
export type {
  ConnectCacheStatus,
  ConnectDiscoveryCache,
  ConnectDiscoveryCacheContext,
  ConnectDiscoverySnapshot,
  ConnectDiscoverySourceSnapshot,
  ConnectOptions,
  ConnectProtocolHint,
  ConnectResolvedProtocol,
  GeoParquetSourceProfiler,
  HonuaConnection,
  HonuaConnectionInspection,
} from "./connect.js";
export { createHonua } from "./kernel/index.js";
export type {
  ConnectLocator,
  ConnectionInspection,
  ExecutionReceipt,
  ExplainOptions,
  FeatureQueryResult,
  HonuaKernel,
  HonuaKernelConnectOptions,
  HonuaKernelConnection,
  HonuaKernelOptions,
  InspectOptions,
  MountOptions,
  MountedMap,
  MountedMapRefreshOptions,
  QueryOptions,
  RendererAdapter,
  RendererDiagnostic,
  RendererEnvironment,
  RendererKind,
  RendererMountRequest,
  RendererOwnership,
  RendererSession,
  RendererTarget,
} from "./kernel/index.js";

export {
  HonuaAbortError,
  HonuaAuthError,
  HonuaCapabilityNotSupportedError,
  HonuaDiscoveryError,
  HonuaGrpcError,
  HonuaGeometryError,
  HonuaHttpError,
  HonuaNetworkError,
  HonuaTimeoutError,
  isHonuaError,
} from "./core/errors.js";
export {
  HONUA_ERROR_KIND,
  HonuaSdkError,
  isHonuaErrorCode,
  sanitizeHonuaErrorContext,
  serializeHonuaError,
} from "./core/error-envelope.js";
export { HONUA_ERROR_CODE_REGISTRY } from "./core/error-code-registry.js";
export type {
  HonuaErrorEnvelopeContext,
  HonuaErrorEnvelopeContextValue,
  HonuaErrorMetadata,
  HonuaErrorOptions,
  HonuaFailureKind,
  HonuaFieldFailure,
  HonuaProtocolMetadata,
  HonuaTerminalFailureReceipt,
  SerializedHonuaError,
  SerializedHonuaErrorCause,
} from "./core/error-envelope.js";
export type {
  HonuaErrorCategory,
  HonuaErrorCode,
  HonuaErrorCodeDescriptor,
  HonuaErrorDomain,
} from "./core/error-code-registry.js";
export type {
  HonuaAuthErrorCode,
  HonuaDiscoveryErrorCode,
  HonuaGeometryErrorCode,
  HonuaError,
  HonuaGrpcErrorOptions,
  HonuaHttpErrorOptions,
} from "./core/errors.js";

export {
  bufferEnvelope,
  envelope,
  point,
  polygon,
  spatialContains,
  spatialIntersects,
  spatialWithin,
} from "./core/spatial-filter.js";
export type { SpatialFilter } from "./core/spatial-filter.js";

export type {
  HonuaAuthCredentials,
  HonuaAuthCredentialsProvider,
  HonuaAuthProvider,
  HonuaAuthProviderContext,
  HonuaAuthProviderResult,
  HonuaClientOptions,
  HonuaTransport,
} from "./core/types.js";

export {
  PROTOCOL_DEFAULT_CAPABILITIES,
  capabilities,
  createDataset,
  queryFilter,
} from "./contract/index.js";
export type {
  AdapterFor,
  AdapterKind,
  AdapterTypeMap,
  AggregationFn,
  AggregationHistogramBucketAliases,
  AggregationHistogramBucketSpec,
  AggregationMetric,
  AggregationSpec,
  AggregationTimeIntervalSpec,
  AggregationTimeIntervalUnit,
  AggregationTimeSeriesAliases,
  AggregationTimeSeriesSpec,
  CanonicalFeature,
  Capabilities,
  Capability,
  CapabilityPolicy,
  CreateDatasetOptions,
  Dataset,
  DatasetId,
  DegradedReason,
  FeatureId,
  PaginationSpec,
  Protocol,
  Query,
  QueryFilterExpression,
  QueryFilterSpatialNode,
  QueryFilterSpatialPredicate,
  QueryFilterTemporalNode,
  QueryFilterTemporalPredicate,
  QueryTemporalFilter,
  Result,
  SortSpec,
  Source,
  SourceAnalyticsCapabilities,
  SourceDescriptor,
  SourceFreshnessContract,
  SourceHistogramCapabilityMetadata,
  SourceId,
  SourceLocator,
  SourceResolver,
  SourceSchema,
  SourceTimeSeriesCapabilityMetadata,
} from "./contract/index.js";

export { executeQueryPlan } from "./query-planner/executor.js";
export { explainQuery, hashQueryPlan } from "./query-planner/planner.js";
export {
  HonuaQueryPlanExecutionError,
  HonuaQueryPlanningError,
  MAX_LOCAL_MATERIALIZATION_ROWS,
  QUERY_IR_KIND,
  QUERY_IR_VERSION,
  QUERY_PLAN_KIND,
  QUERY_PLAN_VERSION,
} from "./query-planner/types.js";
export type {
  CanonicalQuery,
  CanonicalSpatialFilter,
  ExecuteQueryPlanOptions,
  ExplainQueryOptions,
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
  RemoteCompiledQueryV1,
  RemoteQueryPlanStep,
} from "./query-planner/types.js";

export { HonuaMapLibreSourceAdapterError, mountSourceToMapLibre } from "./map/source-to-maplibre.js";
export type {
  MapLibreGeometryKind,
  MapLibreSourceAdapterErrorCode,
  MapLibreSourceDiagnostic,
  MapLibreSourceDiagnosticCode,
  MapLibreSourceProjection,
  MapLibreSourceStrategy,
  MapLibreSourceWorkflowState,
  MountedMapLibreSource,
  MountSourceToMapLibreOptions,
  SourceToMapLibreMap,
} from "./map/source-to-maplibre.js";
