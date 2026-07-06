import { describe, expect, it } from "vitest";

// Experimental subpaths are imported from their own entrypoints (never the root
// barrel). The "exposes ... entrypoint" tests verify the experimental tier still
// exports its symbols; the "keeps experimental subpaths off the root entrypoint"
// test enforces the stable/experimental split against an actual src/index.js import.
import { createHonuaController } from "../src/app-controller/index.js";
import { createHonuaAppWorkspace, selectHonuaAppWorkspaceMetadataCacheModel } from "../src/app-workspace/index.js";
import {
  CAPABILITIES,
  PROTOCOLS,
  PROTOCOL_DEFAULT_CAPABILITIES,
  WIDGET_SOURCE_SCHEMA_VERSION,
  capabilities,
  createDataset,
  createEditSession,
  createEditSketchWorkflow,
  createWidgetSource,
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
  resolveSpatialAggregationWidgetSummary,
  stacSearchSource,
  wfsSource,
  wmsSource,
  wmtsSource,
} from "../src/contract/index.js";
import {
  HONUA_CONTROL_PLANE_BASE_PATH,
  HonuaControlPlaneClient,
  createHonuaControlPlane,
} from "../src/control-plane/index.js";
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
import type {
  FeatureFormValidationFn,
  MapImageLayerApplyEditsOptions,
  MapViewCenterLike,
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
import { createFilterRegistry, projectFilterRegistryToQuery } from "../src/filter-registry/index.js";
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
  createEditSketchWorkflow as honuaCreateEditSketchWorkflow,
  createFilterRegistry as honuaCreateFilterRegistry,
  createWidgetSource as honuaCreateWidgetSource,
  EXPLORATION_EMPTY_STATE as honuaExplorationEmptyState,
  EXPLORATION_SLICES as honuaExplorationSlices,
  ogcRecordsSource as honuaOgcRecordsSource,
  preparePrimaryDetailModel as honuaPreparePrimaryDetailModel,
  projectFilterRegistryToQuery as honuaProjectFilterRegistryToQuery,
  reduceExplorationState as honuaReduceExplorationState,
  resolveSpatialAggregationWidgetSummary as honuaResolveSpatialAggregationWidgetSummary,
  selectLinkedViewQueryProjection as honuaSelectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget as honuaSourceFeatureSelectionTarget,
  wfsSource as honuaWfsSource,
  wmsSource as honuaWmsSource,
  wmtsSource as honuaWmtsSource,
} from "../src/honua.js";
import {
  EXPLORATION_EMPTY_STATE,
  EXPLORATION_SLICES,
  HonuaWfsExceptionError as HonuaWfsExceptionErrorRoot,
  bindChartToExploration,
  bindMapSelectionToExploration,
  bindQueryProjectionToExploration,
  preparePrimaryDetailModel,
  reduceExplorationState,
  createEditSession as rootCreateEditSession,
  createEditSketchWorkflow as rootCreateEditSketchWorkflow,
  createFilterRegistry as rootCreateFilterRegistry,
  createWidgetSource as rootCreateWidgetSource,
  ogcRecordsSource as rootOgcRecordsSource,
  projectFilterRegistryToQuery as rootProjectFilterRegistryToQuery,
  resolveSpatialAggregationWidgetSummary as rootResolveSpatialAggregationWidgetSummary,
  selectLinkedViewQueryProjection as rootSelectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget as rootSourceFeatureSelectionTarget,
  wfsSource as rootWfsSource,
  wmsSource as rootWmsSource,
  wmtsSource as rootWmtsSource,
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
  HONUA_OPERATE_BASE_PATH,
  HonuaAlertRulesClient,
  HonuaAlertsClient,
  HonuaEventsClient,
  HonuaGeofencesClient,
  HonuaInvestigationsClient,
  HonuaJobsClient,
  HonuaLogsClient,
  HonuaOperateClient,
  HonuaTelemetryClient,
  createHonuaOperate,
} from "../src/operate/index.js";
import {
  createRealtimeFeatureStore,
  emptyRealtimeFeatureState,
  reduceRealtimeFeatureState,
} from "../src/realtime/index.js";
import {
  HonuaReplicaSyncClient,
  createFixtureReplicaSyncTransport,
  createHonuaReplicaSync,
  isUnsupportedReplicaSyncError,
} from "../src/replica-sync/index.js";
import {
  HonuaRuntimeDiagnosticError,
  validateRuntimeFilterExpression,
  validateRuntimeStyleExpression,
} from "../src/runtime/index.js";
import {
  createMapLibreSceneAdapter,
  createSceneWorkspace,
  sceneWorkspaceIntentFromAdapterEvent,
} from "../src/scene-workspace/index.js";

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
  });

  it("exposes the experimental control-plane subpath", () => {
    expect(HONUA_CONTROL_PLANE_BASE_PATH).toBe("/api/v1/admin");
    expect(HonuaControlPlaneClient).toBeTypeOf("function");
    expect(createHonuaControlPlane).toBeTypeOf("function");
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

  it("exposes esri-compat option member types", () => {
    const validationFunction: FeatureFormValidationFn = () => undefined;
    const applyEditsOptions: MapImageLayerApplyEditsOptions = { layerId: 0 };
    const center: MapViewCenterLike = [0, 0];

    expect(validationFunction("status", "open")).toBeUndefined();
    expect(applyEditsOptions.layerId).toBe(0);
    expect(center[0]).toBe(0);
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

  it("keeps migration tooling off the root entrypoint", async () => {
    const root = await import("../src/index.js");

    expect(root).not.toHaveProperty("runEsriCompatCodemod");
    expect(root).not.toHaveProperty("scanArcGisUsage");
    expect(root).not.toHaveProperty("buildJsMigrationReport");
  });

  it("exposes the canonical contract entrypoint", () => {
    // Twenty canonical protocols: gRPC, five GeoServices service
    // types (FeatureServer, MapServer, ImageServer, Geometry, GP), OGC
    // API Features / Tiles / Maps / Records, STAC, WFS / WMS / WMTS /
    // OData, PMTiles, GeoParquet, and three MapLibre-native sources.
    expect(PROTOCOLS).toHaveLength(20);
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    expect(Object.keys(PROTOCOL_DEFAULT_CAPABILITIES)).toEqual([...PROTOCOLS]);
    expect(WIDGET_SOURCE_SCHEMA_VERSION).toBe("honua.widget-source.v1");
    expect(capabilities).toBeTypeOf("function");
    expect(createDataset).toBeTypeOf("function");
    expect(createEditSession).toBeTypeOf("function");
    expect(rootCreateEditSession).toBe(createEditSession);
    expect(honuaCreateEditSession).toBe(createEditSession);
    expect(createEditSketchWorkflow).toBeTypeOf("function");
    expect(rootCreateEditSketchWorkflow).toBe(createEditSketchWorkflow);
    expect(honuaCreateEditSketchWorkflow).toBe(createEditSketchWorkflow);
    expect(createWidgetSource).toBeTypeOf("function");
    expect(rootCreateWidgetSource).toBe(createWidgetSource);
    expect(honuaCreateWidgetSource).toBe(createWidgetSource);
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
    expect(rootOgcRecordsSource).toBe(ogcRecordsSource);
    expect(honuaOgcRecordsSource).toBe(ogcRecordsSource);
    expect(stacSearchSource).toBeTypeOf("function");
    expect(odataSource).toBeTypeOf("function");
    expect(wfsSource).toBeTypeOf("function");
    expect(rootWfsSource).toBe(wfsSource);
    expect(honuaWfsSource).toBe(wfsSource);
    expect(wmsSource).toBeTypeOf("function");
    expect(rootWmsSource).toBe(wmsSource);
    expect(honuaWmsSource).toBe(wmsSource);
    expect(wmtsSource).toBeTypeOf("function");
    expect(rootWmtsSource).toBe(wmtsSource);
    expect(honuaWmtsSource).toBe(wmtsSource);
    expect(resolveSpatialAggregationWidgetSummary).toBeTypeOf("function");
    expect(rootResolveSpatialAggregationWidgetSummary).toBe(resolveSpatialAggregationWidgetSummary);
    expect(honuaResolveSpatialAggregationWidgetSummary).toBe(resolveSpatialAggregationWidgetSummary);
  });

  it("exposes the exploration entrypoint", () => {
    expect(EMPTY_STATE.preset).toBe("globalLinked");
    expect(EXPLORATION_EMPTY_STATE).toBe(EMPTY_STATE);
    expect(honuaExplorationEmptyState).toBe(EMPTY_STATE);
    expect(SLICES[0]).toBe("all");
    expect(EXPLORATION_SLICES).toBe(SLICES);
    expect(honuaExplorationSlices).toBe(SLICES);
    expect(reduce).toBeTypeOf("function");
    expect(reduceExplorationState).toBe(reduce);
    expect(honuaReduceExplorationState).toBe(reduce);
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

  it("exposes the filter registry entrypoint", () => {
    expect(createFilterRegistry).toBeTypeOf("function");
    expect(projectFilterRegistryToQuery).toBeTypeOf("function");
    expect(rootCreateFilterRegistry).toBe(createFilterRegistry);
    expect(rootProjectFilterRegistryToQuery).toBe(projectFilterRegistryToQuery);
    expect(honuaCreateFilterRegistry).toBe(createFilterRegistry);
    expect(honuaProjectFilterRegistryToQuery).toBe(projectFilterRegistryToQuery);
  });

  it("exposes the realtime entrypoint", () => {
    expect(emptyRealtimeFeatureState).toBeTypeOf("function");
    expect(reduceRealtimeFeatureState).toBeTypeOf("function");
    expect(createRealtimeFeatureStore).toBeTypeOf("function");
  });

  it("exposes the replica-sync entrypoint", () => {
    expect(HonuaReplicaSyncClient).toBeTypeOf("function");
    expect(createHonuaReplicaSync).toBeTypeOf("function");
    expect(createFixtureReplicaSyncTransport).toBeTypeOf("function");
    expect(isUnsupportedReplicaSyncError).toBeTypeOf("function");
  });

  it("exposes the operate observability entrypoint", () => {
    expect(HONUA_OPERATE_BASE_PATH).toBe("/api/v1/operate");
    expect(createHonuaOperate).toBeTypeOf("function");
    expect(HonuaOperateClient).toBeTypeOf("function");
    expect(HonuaTelemetryClient).toBeTypeOf("function");
    expect(HonuaEventsClient).toBeTypeOf("function");
    expect(HonuaLogsClient).toBeTypeOf("function");
    expect(HonuaAlertsClient).toBeTypeOf("function");
    expect(HonuaAlertRulesClient).toBeTypeOf("function");
    expect(HonuaGeofencesClient).toBeTypeOf("function");
    expect(HonuaInvestigationsClient).toBeTypeOf("function");
    expect(HonuaJobsClient).toBeTypeOf("function");
  });

  it("exposes the runtime style and interaction helper entrypoint", () => {
    expect(HonuaRuntimeDiagnosticError).toBeTypeOf("function");
    expect(validateRuntimeFilterExpression).toBeTypeOf("function");
    expect(validateRuntimeStyleExpression).toBeTypeOf("function");
  });

  it("exposes the app workspace entrypoint", () => {
    expect(createHonuaAppWorkspace).toBeTypeOf("function");
    expect(selectHonuaAppWorkspaceMetadataCacheModel).toBeTypeOf("function");
  });

  it("exposes the scene workspace entrypoint", () => {
    expect(createSceneWorkspace).toBeTypeOf("function");
    expect(createMapLibreSceneAdapter).toBeTypeOf("function");
    expect(sceneWorkspaceIntentFromAdapterEvent).toBeTypeOf("function");
  });

  it("exposes the experimental app-controller subpath", () => {
    expect(createHonuaController).toBeTypeOf("function");
  });

  it("keeps experimental subpaths off the root entrypoint", async () => {
    // The experimental tiers above (app-controller, control-plane, app-workspace,
    // scene-workspace) must NOT leak onto the stable root barrel. Assert against an
    // actual import of src/index.js rather than comparing two imports of the same
    // experimental module (which would be a vacuous always-true identity check).
    const root = await import("../src/index.js");

    expect(root).not.toHaveProperty("createHonuaController");
    expect(root).not.toHaveProperty("HonuaControlPlaneClient");
    expect(root).not.toHaveProperty("createHonuaAppWorkspace");
    expect(root).not.toHaveProperty("selectHonuaAppWorkspaceMetadataCacheModel");
    expect(root).not.toHaveProperty("createSceneWorkspace");
    expect(root).not.toHaveProperty("createMapLibreSceneAdapter");
    expect(root).not.toHaveProperty("sceneWorkspaceIntentFromAdapterEvent");
  });
});
