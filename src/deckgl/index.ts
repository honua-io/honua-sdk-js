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
  loadDeckGlPeers,
} from "./adapter.js";
export type { CreateDeckGlAdapterOptions } from "./adapter.js";
export { bindColumnarBatchToDeckGl } from "./columnar.js";
export type {
  ColumnarComponentType,
  ColumnarDeckGlAttributeBinding,
  ColumnarDeckGlIdentity,
  ColumnarDeckGlProjectionRequest,
} from "./columnar.js";
export { DECK_GL_ADAPTER_CONTRACT_VERSION, HonuaDeckGlAdapterError } from "./types.js";
export type {
  DeckGlAdapter,
  DeckGlBinaryAttribute,
  DeckGlBinaryData,
  DeckGlCapability,
  DeckGlExecutionDiagnostic,
  DeckGlLayer,
  DeckGlLayerConstructor,
  DeckGlLayerHost,
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
