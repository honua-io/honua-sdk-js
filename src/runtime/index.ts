/**
 * `@honua/sdk-js/runtime` — MapLibre GL JS-first runtime for Honua
 * `MapPackage`. Consumes a server-produced `MapPackage` and binds it to
 * a caller-provided `MaplibreMap` instance.
 *
 * @example
 * ```ts
 * import { HonuaClient } from "@honua/sdk-js";
 * import { loadMapPackage } from "@honua/sdk-js/runtime";
 * import maplibregl from "maplibre-gl";
 *
 * const map = new maplibregl.Map({ container: "map" });
 * const runtime = await loadMapPackage(pkg, map, {
 *   client: new HonuaClient({ baseUrl: "https://honua.example.com" }),
 *   popupFactory: () => new maplibregl.Popup(),
 * });
 * runtime.setLayerVisibility("parcels-fill", false);
 * await runtime.updatePackage(nextPkg);
 * ```
 *
 * @module
 */

export { loadMapPackage } from "./load-package.js";
export type { LoadMapPackageOptions, SourceErrorPolicy } from "./load-package.js";

export {
  DEFAULT_MAP_PACKAGE_PATH_PREFIX,
  defaultMapPackagePath,
  fetchMapPackage,
  loadMapPackageFromId,
  mapPackageFingerprint,
  resolveMapPackagePath,
} from "./map-package-fetch.js";
export type {
  FetchMapPackageOptions,
  FetchMapPackageResult,
  LoadMapPackageFromIdOptions,
  LoadMapPackageFromIdResult,
  MapPackageFetchCache,
  MapPackageFetchCacheEntry,
  MapPackageFetchCacheState,
  MapPackageFetchCacheStatus,
  MapPackageLocator,
  MapPackagePathResolver,
} from "./map-package-fetch.js";

export { watchMapPackage } from "./map-package-watch.js";
export type { MapPackageWatchEvent, MapPackageWatchHandle, WatchMapPackageOptions } from "./map-package-watch.js";

export { hasMapPackageDiagnosticErrors, validateMapPackage } from "./map-package-validation.js";
export type {
  HonuaMapPackageDiagnostic,
  HonuaMapPackageDiagnosticCode,
  HonuaMapPackageDiagnosticSeverity,
  ValidateMapPackageOptions,
  ValidateMapPackageResult,
} from "./map-package-validation.js";

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
  SetViewStateInput,
} from "./runtime.js";

export { HONUA_MAP_PACKAGE_FORMAT_V1 } from "./map-package.js";
export type {
  HonuaMapPackage,
  HonuaMapPackageFormat,
  HonuaMapPackageInitialView,
  HonuaMapPackageLabelBinding,
  HonuaMapPackageLegendEntry,
  HonuaMapPackageLocator,
  HonuaMapPackagePopupBinding,
  HonuaMapPackageProtocol,
  HonuaMapPackageSourceBinding,
  HonuaMapPackageStatus,
  HonuaMapPackageStyleRef,
  HonuaMapPackageThemeSpec,
  HonuaStyleRefBody,
  HonuaStyleRefLayerOverride,
} from "./map-package.js";

export { HonuaMapPackageError } from "./errors.js";
export type { HonuaMapPackageErrorStage } from "./errors.js";

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
  queryTilesForViewport,
} from "./query-tiles.js";
export type {
  MapLibreQueryTileSourceSpec,
  QueryTileCacheSnapshot,
  QueryTileDiagnostic,
  QueryTileDiagnosticCode,
  QueryTileDiagnosticSeverity,
  QueryTileFetcher,
  QueryTileLifecycleEvent,
  QueryTileLifecycleListener,
  QueryTileRequest,
  QueryTileRequestControllerOptions,
  QueryTileRequestTileOptions,
  QueryTileSourceSpecOptions,
  QueryTileUrlTemplateOptions,
  QueryTileViewport,
  QueryTileViewportRequestOptions,
  QueryTileViewportRequestResult,
} from "./query-tiles.js";

export { diffPackages } from "./diff.js";
export type { MapPackageDiff } from "./diff.js";

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
