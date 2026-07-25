/**
 * `@honua/sdk-js/kepler` — optional, protocol-neutral bridge that projects an
 * accepted Honua result, columnar artifact, or supported remote source into a
 * Kepler.gl workspace while keeping capability truth, provenance, bounded
 * execution, auth safety, and shared exploration state.
 *
 * `kepler.gl`, `react`, `react-dom`, and `redux` are optional peers. Nothing in
 * this entrypoint imports them; {@link loadKeplerPeers} resolves
 * `@kepler.gl/actions` with a dynamic import, and every projection, mapping,
 * and reconciliation function works with no peer present at all.
 *
 * @example Open a bounded result without a GeoJSON round trip
 * ```ts
 * import { projectResultToKeplerDataset } from "@honua/sdk-js/kepler";
 *
 * const projection = projectResultToKeplerDataset({
 *   datasetId: "incidents",
 *   result: { features: [{ attributes: { id: 1 }, geometry: { x: -122.4, y: 37.8 } }], exceededTransferLimit: false },
 *   provenance: { sourceId: "incidents", planId: "plan-1" },
 * });
 * // projection.diagnostic.geoJsonBytes === 0
 * ```
 *
 * @experimental
 * @packageDocumentation
 */

export {
  assertKeplerCompatibility,
  createKeplerWorkspaceBridge,
  DEFAULT_KEPLER_BRIDGE_LIMITS,
  evaluateKeplerCompatibility,
  KEPLER_BRIDGE_CAPABILITIES,
  loadKeplerPeers,
} from "./bridge.js";
export type {
  CreateKeplerWorkspaceBridgeOptions,
  KeplerOpenedDataset,
  KeplerWorkspaceBridge,
  KeplerWorkspaceMetrics,
} from "./bridge.js";

export {
  KEPLER_DATE_FORMAT,
  KEPLER_TIMESTAMP_FORMAT,
  inferKeplerFieldType,
  isKnownColumnarType,
  keplerField,
  keplerTypeForColumnarType,
  keplerTypeForEsriFieldType,
  normalizeKeplerValue,
  resolveKeplerCrs,
} from "./fields.js";

export { jsonByteLength, pointCoordinates, toKeplerGeoJsonGeometry } from "./geometry.js";
export type { KeplerGeoJsonGeometry } from "./geometry.js";

export {
  KEPLER_GEOJSON_COLUMN,
  KEPLER_LATITUDE_COLUMN,
  KEPLER_LONGITUDE_COLUMN,
  normalizeKeplerLimits,
  projectResultToKeplerDataset,
} from "./ingest.js";
export { projectColumnarBatchToKeplerDataset } from "./ingest-columnar.js";
export { projectRemoteSourceToKepler } from "./ingest-remote.js";

export {
  KEPLER_LINKED_STATE_MAPPINGS,
  createKeplerLinkedStateSync,
  extentToKeplerMapState,
  honuaClauseToKeplerFilter,
  honuaClauseToTemporalWindow,
  keplerFilterToHonuaClause,
  keplerLinkedStateMapping,
  keplerMapStateToExtent,
  keplerSelectionFilterValue,
  keplerTimeRangeToTemporalWindow,
  temporalWindowToHonuaClause,
} from "./linked-state.js";
export type {
  CreateKeplerLinkedStateSyncOptions,
  KeplerExtent,
  KeplerFilterProjection,
  KeplerLinkedStateChannel,
  KeplerLinkedStateDiagnostic,
  KeplerLinkedStateDirection,
  KeplerLinkedStateMapping,
  KeplerLinkedStateSync,
  KeplerLinkedStateUpdate,
  KeplerLinkedStateUpdateKind,
  KeplerTemporalWindow,
  KeplerViewportSize,
} from "./linked-state.js";

export { keplerDatasetStateFromProjection, reconcileKeplerDataset } from "./reconciliation.js";
export type {
  KeplerDeltaDelete,
  KeplerDeltaUpsert,
  KeplerRebuildReason,
  KeplerReconciliationDiagnostic,
  KeplerReconciliationEvent,
  KeplerReconciliationOperation,
  KeplerReconciliationPlan,
  KeplerWorkspaceDatasetState,
} from "./reconciliation.js";

export {
  KEPLER_REDACTED,
  assertCredentialFreeScalar,
  assertCredentialFreeUrl,
  credentialQueryParameters,
  isSensitiveKeplerKey,
  looksLikeCredentialValue,
  redactKeplerExportState,
} from "./redaction.js";
export type {
  KeplerRedaction,
  KeplerRedactionKind,
  KeplerRedactionResult,
  RedactKeplerExportStateOptions,
} from "./redaction.js";

export {
  HonuaKeplerBridgeError,
  KEPLER_BRIDGE_CONTRACT_VERSION,
  KEPLER_COMPATIBILITY_RANGE,
} from "./types.js";
export type {
  HonuaKeplerBridgeErrorCode,
  KeplerAction,
  KeplerBridgeCapability,
  KeplerBridgeLimits,
  KeplerColumnarProjectionRequest,
  KeplerColumnInput,
  KeplerCompatibility,
  KeplerCrsDecision,
  KeplerDatasetData,
  KeplerDatasetInfo,
  KeplerDatasetMetadata,
  KeplerDatasetProjection,
  KeplerDegradedNote,
  KeplerFidelityLoss,
  KeplerFidelityLossKind,
  KeplerField,
  KeplerFieldType,
  KeplerFilter,
  KeplerFilterType,
  KeplerFreshness,
  KeplerIngestionDiagnostic,
  KeplerIngestionStrategy,
  KeplerMapState,
  KeplerMapStyleEntry,
  KeplerModuleImporter,
  KeplerPeers,
  KeplerProjectionMetrics,
  KeplerProjectionShape,
  KeplerProtoDataset,
  KeplerRemoteSourceInput,
  KeplerRemoteSourceKind,
  KeplerRemoteSourceProjection,
  KeplerRemoteSourceProjectionRequest,
  KeplerResultInput,
  KeplerResultProjectionRequest,
  KeplerSourceProvenance,
  KeplerTilesetDescriptor,
  KeplerWorkspaceHost,
  LoadKeplerPeersOptions,
} from "./types.js";
