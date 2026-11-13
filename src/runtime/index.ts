/**
 * `@honua/sdk-js/runtime` — MapLibre GL JS-first runtime for Honua
 * `HonuaMapDocument`. Consumes a server-produced `HonuaMapDocument` and binds it to
 * a caller-provided `MaplibreMap` instance.
 *
 * @example
 * ```ts
 * import { HonuaClient } from "@honua/sdk-js";
 * import { loadMapDocument } from "@honua/sdk-js/runtime";
 * import * as maplibregl from "maplibre-gl";
 *
 * const map = new maplibregl.Map({ container: "map" });
 * const runtime = await loadMapDocument(pkg, map, {
 *   client: new HonuaClient({ baseUrl: "https://honua.example.com" }),
 *   popupFactory: () => new maplibregl.Popup(),
 * });
 * runtime.setLayerVisibility("parcels-fill", false);
 * await runtime.updateMapDocument(nextPkg);
 * ```
 *
 * @packageDocumentation
 */

export { loadMapDocument } from "./load-package.js";
export type { LoadMapDocumentOfflineRegion, LoadMapDocumentOptions, SourceErrorPolicy } from "./load-package.js";

export { maplibreRenderer } from "./maplibre-renderer.js";
export type {
  MapLibreRendererFactoryOptions,
  MapLibreRendererMap,
  MapLibreRendererOptions,
  MapLibreRendererPeer,
} from "./maplibre-renderer.js";

export {
  BoundedMapDocumentFetchCache,
  DEFAULT_MAP_DOCUMENT_CACHE_LIMIT,
  DEFAULT_MAP_DOCUMENT_PATH_PREFIX,
  defaultMapDocumentPath,
  fetchMapDocument,
  loadMapDocumentFromId,
  mapDocumentFingerprint,
  resolveMapDocumentPath,
} from "./map-package-fetch.js";
export type {
  FetchMapDocumentOptions,
  FetchMapDocumentResult,
  LoadMapDocumentFromIdOptions,
  LoadMapDocumentFromIdResult,
  MapDocumentFetchCache,
  MapDocumentFetchCacheEntry,
  MapDocumentFetchCacheState,
  MapDocumentFetchCacheStatus,
  MapDocumentLocator,
  MapDocumentPathResolver,
} from "./map-package-fetch.js";

export {
  MAP_DOCUMENT_REALTIME_CHANNEL_V1,
  createMapDocumentServerSentEventsTransport,
  decodeMapDocumentRealtimeMessage,
  encodeMapDocumentRealtimeUrl,
  readMapDocumentRealtimeAdvertisement,
} from "./map-package-realtime.js";
export type {
  MapDocumentRealtimeAdvertisement,
  MapDocumentRealtimeAuth,
  MapDocumentRealtimeChannel,
  MapDocumentRealtimeCheckpoint,
  MapDocumentRealtimeDisconnectedMessage,
  MapDocumentRealtimeErrorMessage,
  MapDocumentRealtimeEventSource,
  MapDocumentRealtimeEventSourceFactory,
  MapDocumentRealtimeFallbackMode,
  MapDocumentRealtimeHeartbeatMessage,
  MapDocumentRealtimeMessage,
  MapDocumentRealtimeMessageBase,
  MapDocumentRealtimeObserver,
  MapDocumentRealtimeReadyMessage,
  MapDocumentRealtimeReconnectOptions,
  MapDocumentRealtimeRefetchRequiredMessage,
  MapDocumentRealtimeReloadRequiredMessage,
  MapDocumentRealtimeStaleMessage,
  MapDocumentRealtimeSubscribeRequest,
  MapDocumentRealtimeSubscriptionHandle,
  MapDocumentRealtimeTransport,
  MapDocumentRealtimeTransportKind,
  MapDocumentRealtimeUpdate,
  MapDocumentRealtimeUpdatedMessage,
  MapDocumentRealtimeWatchOptions,
  MapDocumentServerSentEventsTransportOptions,
} from "./map-package-realtime.js";
export { watchMapDocument } from "./map-package-watch.js";
export type { MapDocumentWatchEvent, MapDocumentWatchHandle, WatchMapDocumentOptions } from "./map-package-watch.js";

export { hasMapDocumentDiagnosticErrors, validateMapDocument } from "./map-package-validation.js";
export type {
  HonuaMapDocumentDiagnostic,
  HonuaMapDocumentDiagnosticCode,
  HonuaMapDocumentDiagnosticSeverity,
  ValidateMapDocumentOptions,
  ValidateMapDocumentResult,
} from "./map-package-validation.js";

export {
  DEFAULT_MAX_EMBEDDED_BYTES,
  DEFAULT_MAX_MAP_DOCUMENT_BYTES,
  HONUA_MAP_DOCUMENT_EXPORT_KIND_V1,
  exportMapDocument,
  importMapDocument,
} from "./map-package-export.js";
export type {
  ExportMapDocumentOptions,
  HonuaMapDocumentExport,
  ImportMapDocumentOptions,
  ImportMapDocumentResult,
} from "./map-package-export.js";
// The failure surface of `exportMapDocument` / `importMapDocument`. Re-exported
// here so a `@honua/sdk` consumer can catch and inspect it without reaching
// into `@honua/app-platform`, which re-exports the same symbols for the
// component kit's export pipeline.
export { HonuaExportSafetyError } from "../core/credential-redaction.js";
export type { HonuaExportRedaction, HonuaExportRedactionReason } from "../core/credential-redaction.js";

export { HonuaMapRuntime } from "./runtime.js";
export type {
  HonuaMapRuntimeInternals,
  HonuaMapRuntimeReload,
  HonuaRuntimeEvent,
  HonuaRuntimeEventListener,
  HonuaRuntimeTelemetry,
  HonuaRuntimeTelemetrySpan,
  HonuaRuntimeTelemetrySpanResult,
  MaplibreMap,
  RuntimeHitTestOptions,
  RuntimePointerInteractionHandler,
  RuntimePointerInteractionOptions,
  SetViewStateInput,
} from "./runtime.js";

export { HONUA_MAP_DOCUMENT_FORMAT_V1 } from "./map-package.js";
export type {
  HonuaMapDocument,
  HonuaMapDocumentAttribution,
  HonuaMapDocumentDependency,
  HonuaMapDocumentFormat,
  HonuaMapDocumentInitialView,
  HonuaMapDocumentLabelBinding,
  HonuaMapDocumentLegendEntry,
  HonuaMapDocumentLocator,
  HonuaMapDocumentPopupBinding,
  HonuaMapDocumentProtocol,
  HonuaMapDocumentProvenance,
  HonuaMapDocumentSourceBinding,
  HonuaMapDocumentStatus,
  HonuaMapDocumentStyleRef,
  HonuaMapDocumentThemeSpec,
  HonuaMapDocumentWidget,
  HonuaStyleRefBody,
  HonuaStyleRefLayerBinding,
  HonuaStyleRefLayerOverride,
} from "./map-package.js";

export { HonuaMapDocumentError } from "./errors.js";
export type { HonuaMapDocumentErrorStage } from "./errors.js";

export { buildLegend } from "./legend.js";
export type { LegendEntry } from "./legend.js";

export { bindPopup, defaultPopupRenderer } from "./popups.js";
export type {
  BindPopupOptions,
  PopupBindingHandle,
  PopupFactory,
  PopupFeature,
  PopupHandle,
  PopupRenderContext,
  PopupRenderer,
} from "./popups.js";

export { applyStyleRefs, applyTheme, composeStyle } from "./style-compose.js";
export type { StyleComposeOptions, StyleRefResolver, ThemeResolver } from "./style-compose.js";

export {
  PMTILES_PROTOCOL_SCHEME,
  ensurePmtilesProtocol,
  isPmtilesProtocolRegistered,
  resetPmtilesProtocol,
  styleUsesPmtiles,
} from "./pmtiles-protocol.js";
export type {
  EnsurePmtilesProtocolDeps,
  MaplibreProtocolRegistrar,
  PmtilesProtocolLike,
  PmtilesProtocolModuleLike,
} from "./pmtiles-protocol.js";

export {
  ensureOfflineRegionProtocol,
  isOfflineRegionProtocolRegistered,
  OFFLINE_REGION_PROTOCOL_SCHEME,
  resetOfflineRegionProtocol,
  styleUsesOfflineRegion,
} from "./offline-region-protocol.js";
export type { EnsureOfflineRegionProtocolDeps, OfflineRegionTileHandler } from "./offline-region-protocol.js";
export { revertOfflineRegionStyleRewrite, rewriteStyleTilesForOfflineRegion } from "./offline-region-style.js";
export type {
  OfflineRegionStyleRefusalReason,
  OfflineRegionStyleRefusalV1,
  OfflineRegionStyleRewriteEntryV1,
  OfflineRegionStyleRewriteV1,
  RewriteStyleTilesForOfflineRegionOptions,
} from "./offline-region-style.js";

export {
  DEFAULT_OGC_STYLES_PATH_PREFIX,
  MAPLIBRE_STYLE_MEDIA_TYPE,
  OgcStylesClient,
  createOgcStyleRefResolver,
  styleDocumentToRefBody,
} from "./ogc-styles.js";
export type {
  OgcStyleLink,
  OgcStyleList,
  OgcStyleListEntry,
  OgcStyleRefResolverOptions,
  OgcStylesClientOptions,
  OgcStylesRequestOptions,
} from "./ogc-styles.js";

export {
  prepareRuntimeStyleSpecValidation,
  validateRuntimeFilterStyleSpec,
  validateRuntimeLayerStyleSpec,
  validateRuntimeSourceStyleSpec,
  validateRuntimeStyleExpressionStyleSpec,
  validateRuntimeStyleSpec,
} from "./style-spec-validation.js";
export type { RuntimeStyleSpecValidationMode, RuntimeStyleSpecValidationOptions } from "./style-spec-validation.js";

export {
  buildWmsRasterSourceSpec,
  buildWmtsRasterSourceSpec,
  projectSourceBindings,
  toHonuaSourceSpec,
} from "./source-bridge.js";
export type { NativeMapLibreSourceEntry, SourceBridgeProjection } from "./source-bridge.js";

export {
  QueryTileRequestController,
  buildMapLibreQueryTileSourceSpec,
  buildQueryTileJson,
  buildQueryTileUrl,
  buildQueryTileUrlTemplate,
  createQueryTileRequestController,
  diagnoseQueryTileSourceSupport,
  fetchQueryTileFeatureDetail,
  fetchQueryTileJson,
  queryTilesForViewport,
  QueryTileServerResponseError,
} from "./query-tiles.js";
export type {
  FetchQueryTileFeatureDetailOptions,
  FetchQueryTileJsonOptions,
  MapLibreQueryTileSourceSpec,
  QueryTileFeatureDetailFetchResult,
  QueryTileCacheSnapshot,
  QueryTileDiagnostic,
  QueryTileDiagnosticCode,
  QueryTileDiagnosticSeverity,
  QueryTileFetcher,
  QueryTileJsonFetchResult,
  QueryTileLifecycleEvent,
  QueryTileLifecycleListener,
  QueryTileRequest,
  QueryTileRequestControllerOptions,
  QueryTileRequestTileOptions,
  QueryTileServerFetch,
  QueryTileServerFetchOptions,
  QueryTileSourceSpecOptions,
  QueryTileUrlTemplateOptions,
  QueryTileViewport,
  QueryTileViewportRequestOptions,
  QueryTileViewportRequestResult,
} from "./query-tiles.js";

export { diffMapDocuments } from "./diff.js";
export type { MapDocumentDiff } from "./diff.js";

export {
  HonuaRuntimeDiagnosticError,
  featureStateTargetFromSelection,
  featureStateTargetKey,
  featureTargetForLayer,
  materializeRuntimeLayer,
  materializeRuntimeSource,
  materializeStyleValue,
  protocolForSource,
  rendererRuntimeDiagnosticError,
  resolveFeatureIdFromEventFeature,
  resolveRuntimeBeforeId,
  selectionTargetForLayer,
  sourceContextForLayer,
  throwRuntimeDiagnostics,
  validateRuntimeFilterExpression,
  validateRuntimeLayer,
  validateRuntimeSource,
  validateRuntimeStyleExpression,
} from "./style-interactions.js";
export type {
  HonuaRuntimeDiagnostic,
  HonuaRuntimeDiagnosticSeverity,
  NativeMapLibreSourceSpecification,
  RuntimeClickInteractionHandler,
  RuntimeClickInteractionOptions,
  RuntimeExplorationSelectionOptions,
  RuntimeFeatureInteractionEvent,
  RuntimeFeatureStateTarget,
  RuntimeFilterExpression,
  RuntimeHoverInteractionOptions,
  RuntimeLayerOrder,
  RuntimeLayerOrderOptions,
  RuntimeLayerSpecification,
  RuntimeLayerUpdate,
  RuntimeLayoutSpecification,
  RuntimePaintSpecification,
  RuntimeSelectionInteractionOptions,
  RuntimeSourceSpecification,
  RuntimeStyleValue,
} from "./style-interactions.js";

export { bindEditSketchSnapping } from "./edit-snapping.js";
export type {
  BindEditSketchSnappingOptions,
  EditSketchSnapIndicatorOptions,
  EditSketchSnappingEvents,
  EditSketchSnappingHandle,
  SnappingMap,
} from "./edit-snapping.js";

export {
  TERRA_DRAW_SKETCH_TOOL_MODES,
  bindTerraDrawSketch,
  createTerraDrawSketch,
  createTerraDrawSnapping,
  editSketchToolForTerraDrawMode,
  terraDrawSketchToolCapabilities,
} from "./terra-draw-sketch.js";
export type {
  BindTerraDrawSketchOptions,
  CreateTerraDrawSketchOptions,
  CreateTerraDrawSnappingOptions,
  TerraDrawSketchController,
  TerraDrawSketchFeature,
  TerraDrawSketchFeatureId,
  TerraDrawSketchFinishContext,
  TerraDrawSketchFinishEvent,
  TerraDrawSketchHandle,
  TerraDrawSketchInstance,
  TerraDrawSnapContext,
  TerraDrawSnapEvent,
} from "./terra-draw-sketch.js";

export {
  HONUA_ONLINE_BASEMAP_STYLES,
  HonuaOnlineBasemapBinding,
  resolveHonuaOnlineBasemapStyle,
} from "./online-basemap.js";
export type {
  HonuaOnlineBasemapTheme,
  HonuaOnlineBasemapOptions,
  HonuaOnlineBasemapMap,
  HonuaOnlineBasemapBindingOptions,
} from "./online-basemap.js";
