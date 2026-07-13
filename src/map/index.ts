/**
 * `@honua/sdk-js/map` — `HonuaMap` programmatic map container.
 *
 * A small, renderer-neutral map handle for tests and headless workflows that
 * mirrors the subset of the MapLibre / Cesium runtime API the SDK contracts
 * against.
 *
 * @example
 * ```ts
 * import { HonuaMap } from "@honua/sdk-js/map";
 *
 * const map = new HonuaMap({ extent: { xmin: -158, ymin: 21, xmax: -157, ymax: 22 } });
 * map.on("extentchange", (event) => console.log(event.extent));
 * map.setSourceVisible("parcels", false);
 * ```
 *
 * @packageDocumentation
 */
export { HonuaMap } from "./honua-map.js";
export { HonuaDataToMapBridgeError, explainDataToMapStrategy, mountSource } from "./data-to-map-bridge.js";
export type {
  DataToMapBridgeErrorCode,
  DataToMapDiagnostic,
  DataToMapDiagnosticCode,
  DataToMapLibreMap,
  DataToMapOverflow,
  DataToMapStrategy,
  DataToMapStrategyExplanation,
  MountedSource,
  MountedSourceDiagnostics,
  MountSourceOptions,
  MountSourcePopupContext,
  MountSourcePopupOptions,
} from "./data-to-map-bridge.js";
export {
  AUTOMATIC_MAPLIBRE_PLAN_KIND,
  AUTOMATIC_MAPLIBRE_PLAN_VERSION,
  HonuaAutomaticMapLibreStrategyError,
  MAX_AUTOMATIC_GEOJSON_FEATURES,
  explainAutomaticSourceToMapLibre,
  mountAutomaticSourceToMapLibre,
} from "./automatic-source-strategy.js";
export type {
  AutomaticMapLibreCandidate,
  AutomaticMapLibreDiagnostic,
  AutomaticMapLibreErrorCode,
  AutomaticMapLibreNativeSourceSpec,
  AutomaticMapLibrePlan,
  AutomaticMapLibreReasonCode,
  AutomaticMapLibreStrategy,
  AutomaticMapLibreWorkflowState,
  ExplainAutomaticMapLibreOptions,
  MountedAutomaticMapLibreSource,
} from "./automatic-source-strategy.js";
export {
  HonuaAutomaticMapLibreIntegrationError,
  attachAutomaticMapLibreInteractions,
} from "./automatic-mount-integration.js";
export type {
  AutomaticMapLibreIntegration,
  AutomaticMapLibreIntegrationDiagnostic,
  AutomaticMapLibreIntegrationDiagnosticCode,
  AutomaticMapLibreIntegrationErrorCode,
  AutomaticMapLibreIntegrationMap,
  AutomaticMapLibreIntegrationOptions,
  BindFilterRegistryOptions,
  RealtimeFeatureStateDelta,
} from "./automatic-mount-integration.js";
export type {
  HonuaMapOptions,
  HonuaMapEvent,
  HonuaMapEventListener,
  LayerSnapshot,
  ResolvedMapSource,
} from "./honua-map.js";
export {
  createHonuaFeatureServiceLayer,
  createHonuaMapLibreMapOptions,
  createHonuaMapLibreStyle,
  createHonuaMapServiceLayer,
  createHonuaTileServiceLayer,
} from "./maplibre-target.js";
export type {
  HonuaFeatureServiceLayerOptions,
  HonuaMapLibreLayerDefinition,
  HonuaMapLibreLayerOptionsBase,
  HonuaMapLibreMapOptions,
  HonuaMapLibreRasterSourceSpecification,
  HonuaMapLibreStyleOptions,
  HonuaMapServiceLayerOptions,
  HonuaTileServiceLayerOptions,
} from "./maplibre-target.js";
export {
  esriFeaturesToGeoJson,
  esriGeometryToGeoJson,
  loadHonuaFeatureServiceGeoJson,
  registerHonuaFeatureServiceSources,
} from "./feature-service-adapter.js";
export type {
  AdapterGeoJsonFeature,
  AdapterGeoJsonFeatureCollection,
  AdapterGeoJsonGeometry,
  FeatureServiceAdapterMap,
  LoadHonuaFeatureServiceGeoJsonOptions,
  MapLibreGeoJsonSourceSpecification,
  RegisterHonuaFeatureServiceSourcesResult,
} from "./feature-service-adapter.js";
export {
  HonuaMapLibreSourceAdapterError,
  mountSourceToMapLibre,
  projectSourceToMapLibre,
} from "./source-to-maplibre.js";
export { buildWmsRasterSourceSpec, buildWmtsRasterSourceSpec } from "./raster-source-spec.js";
export type {
  MapLibreRasterSourceSpec,
  RasterSourceSpecOptions,
  WmsRasterSourceSpecOptions,
  WmtsRasterSourceSpecOptions,
} from "./raster-source-spec.js";
export {
  HonuaMapLibreRasterStrategyError,
  mountRasterSourceToMapLibre,
  projectRasterSourceToMapLibre,
} from "./raster-source-strategy.js";
export type {
  MapLibreRasterDiagnostic,
  MapLibreRasterDiagnosticCode,
  MapLibreRasterProjection,
  MapLibreRasterStrategy,
  MapLibreRasterStrategyErrorCode,
  MapLibreRasterWorkflowState,
  MountedMapLibreRasterSource,
  ProjectRasterSourceToMapLibreOptions,
  RasterSourceToMapLibreMap,
} from "./raster-source-strategy.js";
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
  ProjectSourceToMapLibreOptions,
  SourceToMapLibreMap,
} from "./source-to-maplibre.js";
export { webmapJsonToMapLibreStyle } from "./webmap-maplibre.js";
export type {
  WebMapJsonToMapLibreStyleOptions,
  WebMapJsonToMapLibreStyleResult,
  WebMapMapLibreGapKind,
  WebMapMapLibreManualGap,
} from "./webmap-maplibre.js";
