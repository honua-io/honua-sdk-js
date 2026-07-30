/**
 * `@honua/sdk-js/deckgl` — bounded binary projection into injected deck.gl
 * layer constructors. deck.gl is an optional peer and is never imported by
 * the SDK root entrypoint.
 *
 * @experimental
 * @packageDocumentation
 */

export {
  createDeckGlAdapter,
  DECK_GL_CAPABILITIES,
  DEFAULT_DECK_GL_PROJECTION_LIMITS,
  loadDeckGlAdapter,
  loadDeckGlPeers,
} from "./adapter.js";
export type { CreateDeckGlAdapterOptions } from "./adapter.js";
export {
  bindColumnarBatchToDeckGl,
  bindGeoArrowLineBatchToDeckGl,
  bindGeoArrowPointBatchToDeckGl,
  bindGeoArrowPolygonBatchToDeckGl,
} from "./columnar.js";
export type {
  ColumnarComponentType,
  ColumnarDeckGlAttributeBinding,
  ColumnarDeckGlIdentity,
  ColumnarDeckGlProjectionRequest,
  ColumnarDeckGlStartIndicesBinding,
  GeoArrowLineDeckGlBinding,
  GeoArrowLineDeckGlBindingMetrics,
  GeoArrowLineDeckGlProjectionRequest,
  GeoArrowPointDeckGlBinding,
  GeoArrowPointDeckGlBindingMetrics,
  GeoArrowPointDeckGlProjectionRequest,
  GeoArrowPolygonDeckGlBinding,
  GeoArrowPolygonDeckGlBindingMetrics,
  GeoArrowPolygonDeckGlProjectionRequest,
} from "./columnar.js";
export { DECK_GL_ADAPTER_CONTRACT_VERSION, HonuaDeckGlAdapterError } from "./types.js";
export type {
  DeckGlAdapter,
  DeckGlBinaryAttribute,
  DeckGlBinaryData,
  DeckGlCapability,
  DeckGlDisposalHandle,
  DeckGlExecutionDiagnostic,
  DeckGlLayer,
  DeckGlLayerConstructor,
  DeckGlLayerHost,
  LoadDeckGlAdapterOptions,
  DeckGlLayerKind,
  DeckGlModuleImporter,
  DeckGlMountedProjection,
  DeckGlPeers,
  DeckGlPickedSelection,
  DeckGlProjection,
  DeckGlProjectionLimits,
  DeckGlProjectionMetrics,
  DeckGlProjectionRequest,
  DeckGlSelectionIdentity,
  HonuaDeckGlAdapterErrorCode,
  LoadDeckGlPeersOptions,
} from "./types.js";
export {
  bindDeckGlPickToExploration,
  deckGlPickedSelectionTarget,
  selectedFeatureIdSet,
} from "./selection-sync.js";
export type { DeckGlSelectionExplorationBindingOptions } from "./selection-sync.js";
export { bindDeckGlViewportToMap, readMapCameraState } from "./view-sync.js";
export type {
  BindDeckGlViewportToMapOptions,
  DeckGlCameraState,
  DeckGlMapCameraSource,
  DeckGlOverlayViewTarget,
} from "./view-sync.js";
export { bindDeckGlContextLossRecovery, combineDeckGlDisposal } from "./lifecycle.js";
export type { DeckGlContextLossRecoveryOptions, DeckGlContextLossTarget } from "./lifecycle.js";
