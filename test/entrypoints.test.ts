import { describe, expect, it } from "vitest";

import { createHonuaController as appControllerCreateHonuaController } from "../src/app-controller/index.js";
import {
  createHonuaAppWorkspace as appWorkspaceCreateHonuaAppWorkspace,
  selectHonuaAppWorkspaceMetadataCacheModel as appWorkspaceSelectMetadataCacheModel,
} from "../src/app-workspace/index.js";
import {
  CAPABILITIES,
  PROTOCOLS,
  PROTOCOL_DEFAULT_CAPABILITIES,
  capabilities,
  createDataset,
  createEditSession,
  geoServicesFeatureSource,
  geoServicesGPServiceSource,
  geoServicesGeometryServiceSource,
  geoServicesImageSource,
  geoServicesMapServiceSource,
  normalizeEditWorkflowFailures,
  odataSource,
  ogcFeaturesSource,
  ogcMapsSource,
  ogcRecordsSource,
  ogcTilesSource,
  stacSearchSource,
} from "../src/contract/index.js";
import {
  AreaMeasurement2DCompat,
  AttributionCompat,
  BasemapCompat,
  BasemapGalleryCompat,
  BasemapLayerListCompat,
  BasemapToggleCompat,
  BookmarksCompat,
  ClassBreaksRendererCompat,
  ColorCompat,
  CompassCompat,
  CompatEventBus,
  CoordinateConversionCompat,
  DirectionsCompat,
  DistanceMeasurement2DCompat,
  EditorCompat,
  EsriRequestInterceptorRegistry,
  ExpandCompat,
  ExtentCompat,
  FeatureCompat,
  FeatureFormCompat,
  FeatureLayerCompat,
  FeatureSetCompat,
  FeatureTableCompat,
  FeatureTableHighlightIdsCompat,
  FeatureTemplatesCompat,
  FullscreenCompat,
  GraphicCompat,
  GraphicsLayerCompat,
  GroupLayerCompat,
  HomeCompat,
  IdentifyCompat,
  LabelClassCompat,
  LayerListCompat,
  LegendCompat,
  LocateCompat,
  MapCompat,
  MapImageLayerCompat,
  MapImageSublayerCompat,
  MapViewCompat,
  MapViewUiCompat,
  MeasurementCompat,
  OAuthInfoCompat,
  PictureMarkerSymbolCompat,
  PointCompat,
  PolygonCompat,
  PolylineCompat,
  PopupCompat,
  PopupTemplateCompat,
  PrintCompat,
  QueryCompat,
  RouteLayerCompat,
  RouteTaskCompat,
  ScaleBarCompat,
  SceneViewCompat,
  SearchCompat,
  SimpleFillSymbolCompat,
  SimpleLineSymbolCompat,
  SimpleMarkerSymbolCompat,
  SimpleRendererCompat,
  SketchCompat,
  SpatialReferenceCompat,
  SwipeCompat,
  TableListCompat,
  TextSymbolCompat,
  TileLayerCompat,
  TimeSliderCompat,
  TrackCompat,
  UniqueValueRendererCompat,
  WebMapCompat,
  ZoomCompat,
  createArcGisTokenInterceptor,
  createEsriRequestInterceptors,
  esriConfig,
  esriRequest,
  getEsriConfigHonuaInterceptors,
  identityManager,
  parseMapServiceUrl,
  reactiveUtils,
  resetEsriConfig,
  watch,
  when,
  whenOnce,
} from "../src/esri-compat-entry.js";
import {
  EMPTY_STATE,
  LINKED_VIEW_PRESETS,
  SLICES,
  createExplorationContext,
  featureSelectionKey,
  isSourceQualifiedSelectionTarget,
  reduce,
  selectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget,
} from "../src/exploration/index.js";
import {
  HonuaClient,
  HonuaFeatureLayer,
  HonuaGeometryService,
  HonuaGeoprocessingService,
  HonuaHttpError,
  HonuaImageService,
  HonuaMapLayer,
  HonuaMapService,
  HonuaOgcFeatureCollection,
  HonuaOgcFeatures,
  HonuaOgcRecordCollection,
  HonuaOgcRecords,
  HonuaProcessRunner,
  HonuaService,
  HonuaWfsExceptionError,
  createHonuaCacheState,
  createHonuaOgcFeatures,
  createHonuaOgcRecords,
  createHonuaProcessRunner,
  createHonuaService,
  bindQueryProjectionToExploration as honuaBindQueryProjectionToExploration,
  createEditSession as honuaCreateEditSession,
  createHonuaAppWorkspace as honuaCreateHonuaAppWorkspace,
  createHonuaController as honuaCreateHonuaController,
  createSceneWorkspace as honuaCreateSceneWorkspace,
  preparePrimaryDetailModel as honuaPreparePrimaryDetailModel,
  selectLinkedViewQueryProjection as honuaSelectLinkedViewQueryProjection,
  selectHonuaAppWorkspaceMetadataCacheModel as honuaSelectMetadataCacheModel,
  sourceFeatureSelectionTarget as honuaSourceFeatureSelectionTarget,
} from "../src/honua.js";
import {
  HonuaWfsExceptionError as HonuaWfsExceptionErrorRoot,
  bindChartToExploration,
  bindMapSelectionToExploration,
  bindQueryProjectionToExploration,
  createHonuaAppWorkspace,
  createHonuaController,
  preparePrimaryDetailModel,
  createEditSession as rootCreateEditSession,
  createSceneWorkspace as rootCreateSceneWorkspace,
  selectLinkedViewQueryProjection as rootSelectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget as rootSourceFeatureSelectionTarget,
  selectHonuaAppWorkspaceMetadataCacheModel,
  syncFeatureStateSelection,
} from "../src/index.js";
import {
  bindChartToExploration as interactionsBindChartToExploration,
  selectLinkedViewQueryProjection as interactionsSelectLinkedViewQueryProjection,
} from "../src/interactions/index.js";
import {
  buildJsMigrationReport,
  evaluateMigrationGates,
  getJsParityMatrix,
  runEsriCompatCodemod,
  runLayerReconciliation,
  scanArcGisUsage,
  summarizeJsParityMatrix,
} from "../src/migration-entry.js";
import {
  createRealtimeFeatureStore,
  emptyRealtimeFeatureState,
  reduceRealtimeFeatureState,
} from "../src/realtime/index.js";
import {
  HonuaRuntimeDiagnosticError,
  validateRuntimeFilterExpression,
  validateRuntimeStyleExpression,
} from "../src/runtime/index.js";
import { createSceneWorkspace, sceneWorkspaceIntentFromAdapterEvent } from "../src/scene-workspace/index.js";

describe("entrypoint modules", () => {
  it("exposes honua-first core entrypoint", () => {
    expect(HonuaClient).toBeTypeOf("function");
    expect(HonuaHttpError).toBeTypeOf("function");
    expect(HonuaService).toBeTypeOf("function");
    expect(HonuaFeatureLayer).toBeTypeOf("function");
    expect(HonuaMapLayer).toBeTypeOf("function");
    expect(HonuaMapService).toBeTypeOf("function");
    expect(HonuaOgcFeatures).toBeTypeOf("function");
    expect(HonuaOgcFeatureCollection).toBeTypeOf("function");
    expect(HonuaOgcRecords).toBeTypeOf("function");
    expect(HonuaOgcRecordCollection).toBeTypeOf("function");
    expect(HonuaImageService).toBeTypeOf("function");
    expect(HonuaGeometryService).toBeTypeOf("function");
    expect(HonuaGeoprocessingService).toBeTypeOf("function");
    expect(HonuaProcessRunner).toBeTypeOf("function");
    expect(createHonuaService).toBeTypeOf("function");
    expect(createHonuaProcessRunner).toBeTypeOf("function");
    expect(createHonuaOgcFeatures).toBeTypeOf("function");
    expect(createHonuaOgcRecords).toBeTypeOf("function");
    expect(HonuaWfsExceptionError).toBeTypeOf("function");
    expect(HonuaWfsExceptionErrorRoot).toBe(HonuaWfsExceptionError);
    expect(createHonuaCacheState).toBeTypeOf("function");
    expect(honuaCreateHonuaController).toBe(appControllerCreateHonuaController);
    expect(createHonuaController).toBe(appControllerCreateHonuaController);
  });

  it("exposes esri-compat entrypoint", () => {
    expect(FeatureLayerCompat).toBeTypeOf("function");
    expect(HomeCompat).toBeTypeOf("function");
    expect(BasemapCompat).toBeTypeOf("function");
    expect(BasemapToggleCompat).toBeTypeOf("function");
    expect(BasemapGalleryCompat).toBeTypeOf("function");
    expect(BasemapLayerListCompat).toBeTypeOf("function");
    expect(BookmarksCompat).toBeTypeOf("function");
    expect(CompassCompat).toBeTypeOf("function");
    expect(ExpandCompat).toBeTypeOf("function");
    expect(AttributionCompat).toBeTypeOf("function");
    expect(FullscreenCompat).toBeTypeOf("function");
    expect(ZoomCompat).toBeTypeOf("function");
    expect(GraphicCompat).toBeTypeOf("function");
    expect(PointCompat).toBeTypeOf("function");
    expect(PolylineCompat).toBeTypeOf("function");
    expect(PolygonCompat).toBeTypeOf("function");
    expect(ExtentCompat).toBeTypeOf("function");
    expect(SpatialReferenceCompat).toBeTypeOf("function");
    expect(ColorCompat).toBeTypeOf("function");
    expect(LocateCompat).toBeTypeOf("function");
    expect(ScaleBarCompat).toBeTypeOf("function");
    expect(CoordinateConversionCompat).toBeTypeOf("function");
    expect(CompatEventBus).toBeTypeOf("function");
    expect(createEsriRequestInterceptors).toBeTypeOf("function");
    expect(createArcGisTokenInterceptor).toBeTypeOf("function");
    expect(EsriRequestInterceptorRegistry).toBeTypeOf("function");
    expect(esriConfig).toBeTypeOf("object");
    expect(esriRequest).toBeTypeOf("function");
    expect(getEsriConfigHonuaInterceptors).toBeTypeOf("function");
    expect(resetEsriConfig).toBeTypeOf("function");
    expect(identityManager).toBeTypeOf("object");
    expect(DirectionsCompat).toBeTypeOf("function");
    expect(EditorCompat).toBeTypeOf("function");
    expect(FeatureCompat).toBeTypeOf("function");
    expect(FeatureFormCompat).toBeTypeOf("function");
    expect(FeatureSetCompat).toBeTypeOf("function");
    expect(FeatureTemplatesCompat).toBeTypeOf("function");
    expect(GraphicsLayerCompat).toBeTypeOf("function");
    expect(FeatureTableCompat).toBeTypeOf("function");
    expect(FeatureTableHighlightIdsCompat).toBeTypeOf("function");
    expect(GroupLayerCompat).toBeTypeOf("function");
    expect(IdentifyCompat).toBeTypeOf("function");
    expect(LayerListCompat).toBeTypeOf("function");
    expect(LegendCompat).toBeTypeOf("function");
    expect(MapCompat).toBeTypeOf("function");
    expect(MapImageLayerCompat).toBeTypeOf("function");
    expect(MapImageSublayerCompat).toBeTypeOf("function");
    expect(MapViewCompat).toBeTypeOf("function");
    expect(MapViewUiCompat).toBeTypeOf("function");
    expect(PrintCompat).toBeTypeOf("function");
    expect(MeasurementCompat).toBeTypeOf("function");
    expect(AreaMeasurement2DCompat).toBeTypeOf("function");
    expect(DistanceMeasurement2DCompat).toBeTypeOf("function");
    expect(PopupCompat).toBeTypeOf("function");
    expect(PopupTemplateCompat).toBeTypeOf("function");
    expect(OAuthInfoCompat).toBeTypeOf("function");
    expect(QueryCompat).toBeTypeOf("function");
    expect(RouteLayerCompat).toBeTypeOf("function");
    expect(RouteTaskCompat).toBeTypeOf("function");
    expect(reactiveUtils.watch).toBeTypeOf("function");
    expect(SwipeCompat).toBeTypeOf("function");
    expect(TableListCompat).toBeTypeOf("function");
    expect(SketchCompat).toBeTypeOf("function");
    expect(TrackCompat).toBeTypeOf("function");
    expect(TimeSliderCompat).toBeTypeOf("function");
    expect(TileLayerCompat).toBeTypeOf("function");
    expect(parseMapServiceUrl).toBeTypeOf("function");
    expect(SceneViewCompat).toBeTypeOf("function");
    expect(SearchCompat).toBeTypeOf("function");
    expect(SimpleLineSymbolCompat).toBeTypeOf("function");
    expect(SimpleFillSymbolCompat).toBeTypeOf("function");
    expect(SimpleMarkerSymbolCompat).toBeTypeOf("function");
    expect(PictureMarkerSymbolCompat).toBeTypeOf("function");
    expect(TextSymbolCompat).toBeTypeOf("function");
    expect(LabelClassCompat).toBeTypeOf("function");
    expect(ClassBreaksRendererCompat).toBeTypeOf("function");
    expect(SimpleRendererCompat).toBeTypeOf("function");
    expect(UniqueValueRendererCompat).toBeTypeOf("function");
    expect(WebMapCompat).toBeTypeOf("function");
    expect(watch).toBeTypeOf("function");
    expect(when).toBeTypeOf("function");
    expect(whenOnce).toBeTypeOf("function");
  });

  it("exposes migration tooling entrypoint", () => {
    expect(scanArcGisUsage).toBeTypeOf("function");
    expect(runEsriCompatCodemod).toBeTypeOf("function");
    expect(buildJsMigrationReport).toBeTypeOf("function");
    expect(evaluateMigrationGates).toBeTypeOf("function");
    expect(getJsParityMatrix).toBeTypeOf("function");
    expect(runLayerReconciliation).toBeTypeOf("function");
    expect(summarizeJsParityMatrix).toBeTypeOf("function");
  });

  it("exposes the canonical contract entrypoint", () => {
    // Eighteen canonical protocols: gRPC, five GeoServices service
    // types (FeatureServer, MapServer, ImageServer, Geometry, GP), OGC
    // API Features / Tiles / Maps / Records, STAC, WFS / WMS / WMTS /
    // OData, and three MapLibre-native sources.
    expect(PROTOCOLS).toHaveLength(18);
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    expect(Object.keys(PROTOCOL_DEFAULT_CAPABILITIES)).toEqual([...PROTOCOLS]);
    expect(capabilities).toBeTypeOf("function");
    expect(createDataset).toBeTypeOf("function");
    expect(createEditSession).toBeTypeOf("function");
    expect(rootCreateEditSession).toBe(createEditSession);
    expect(honuaCreateEditSession).toBe(createEditSession);
    expect(normalizeEditWorkflowFailures).toBeTypeOf("function");
    expect(geoServicesFeatureSource).toBeTypeOf("function");
    expect(geoServicesMapServiceSource).toBeTypeOf("function");
    expect(geoServicesImageSource).toBeTypeOf("function");
    expect(geoServicesGeometryServiceSource).toBeTypeOf("function");
    expect(geoServicesGPServiceSource).toBeTypeOf("function");
    expect(ogcFeaturesSource).toBeTypeOf("function");
    expect(ogcTilesSource).toBeTypeOf("function");
    expect(ogcMapsSource).toBeTypeOf("function");
    expect(ogcRecordsSource).toBeTypeOf("function");
    expect(stacSearchSource).toBeTypeOf("function");
    expect(odataSource).toBeTypeOf("function");
  });

  it("exposes the exploration entrypoint", () => {
    expect(EMPTY_STATE.preset).toBe("globalLinked");
    expect(SLICES[0]).toBe("all");
    expect(reduce).toBeTypeOf("function");
    expect(createExplorationContext).toBeTypeOf("function");
    const target = sourceFeatureSelectionTarget("parcels", 101);
    expect(isSourceQualifiedSelectionTarget(target)).toBe(true);
    expect(featureSelectionKey(target)).toContain("parcels");
    expect(rootSourceFeatureSelectionTarget("parcels", 101)).toEqual(target);
    expect(honuaSourceFeatureSelectionTarget("parcels", 101)).toEqual(target);
    expect(bindMapSelectionToExploration).toBeTypeOf("function");
    expect(syncFeatureStateSelection).toBeTypeOf("function");
    expect(selectLinkedViewQueryProjection).toBeTypeOf("function");
    expect(rootSelectLinkedViewQueryProjection).toBe(selectLinkedViewQueryProjection);
    expect(honuaSelectLinkedViewQueryProjection).toBe(selectLinkedViewQueryProjection);
    expect(interactionsSelectLinkedViewQueryProjection).toBe(selectLinkedViewQueryProjection);
    expect(bindQueryProjectionToExploration).toBeTypeOf("function");
    expect(honuaBindQueryProjectionToExploration).toBe(bindQueryProjectionToExploration);
    expect(preparePrimaryDetailModel).toBeTypeOf("function");
    expect(honuaPreparePrimaryDetailModel).toBe(preparePrimaryDetailModel);
    expect(bindChartToExploration).toBeTypeOf("function");
    expect(interactionsBindChartToExploration).toBe(bindChartToExploration);
    expect(Object.keys(LINKED_VIEW_PRESETS)).toEqual([
      "globalLinked",
      "mapDriven",
      "gridDriven",
      "chartDriven",
      "decoupled",
    ]);
  });

  it("exposes the realtime entrypoint", () => {
    expect(emptyRealtimeFeatureState).toBeTypeOf("function");
    expect(reduceRealtimeFeatureState).toBeTypeOf("function");
    expect(createRealtimeFeatureStore).toBeTypeOf("function");
  });

  it("exposes the runtime style and interaction helper entrypoint", () => {
    expect(HonuaRuntimeDiagnosticError).toBeTypeOf("function");
    expect(validateRuntimeFilterExpression).toBeTypeOf("function");
    expect(validateRuntimeStyleExpression).toBeTypeOf("function");
  });

  it("exposes the app workspace entrypoint", () => {
    expect(createHonuaAppWorkspace).toBeTypeOf("function");
    expect(appWorkspaceCreateHonuaAppWorkspace).toBe(createHonuaAppWorkspace);
    expect(honuaCreateHonuaAppWorkspace).toBe(createHonuaAppWorkspace);
    expect(selectHonuaAppWorkspaceMetadataCacheModel).toBeTypeOf("function");
    expect(appWorkspaceSelectMetadataCacheModel).toBe(selectHonuaAppWorkspaceMetadataCacheModel);
    expect(honuaSelectMetadataCacheModel).toBe(selectHonuaAppWorkspaceMetadataCacheModel);
  });

  it("exposes the scene workspace entrypoint", () => {
    expect(createSceneWorkspace).toBeTypeOf("function");
    expect(sceneWorkspaceIntentFromAdapterEvent).toBeTypeOf("function");
    expect(rootCreateSceneWorkspace).toBe(createSceneWorkspace);
    expect(honuaCreateSceneWorkspace).toBe(createSceneWorkspace);
  });
});
