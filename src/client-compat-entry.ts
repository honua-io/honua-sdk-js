export { FeatureLayerCompat } from "./client-compat/feature-layer.js";
export type {
  FeatureLayerAddAttachmentOptions,
  FeatureLayerAttachmentData,
  FeatureLayerCreateQueryResult,
  FeatureLayerDeleteAttachmentsOptions,
  FeatureLayerHandleCompat,
  FeatureLayerLoadStatusCompat,
  FeatureLayerListAttachmentsOptions,
  FeatureLayerQueryAllOptions,
  FeatureLayerQueryAttachmentsOptions,
  FeatureLayerQueryCountOptions,
  FeatureLayerUpdateAttachmentOptions,
} from "./client-compat/feature-layer.js";
export { FeatureCompat } from "./client-compat/feature.js";
export type {
  FeatureCompatOptions,
  FeatureHandleCompat,
  FeatureLoadStatusCompat,
} from "./client-compat/feature.js";
export { FeatureFormCompat } from "./client-compat/feature-form.js";
export type {
  FeatureFormCompatOptions,
  FeatureFormFieldErrorCompat,
  FeatureFormHandleCompat,
  FeatureFormLoadStatusCompat,
  FeatureFormSubmitResultCompat,
  FeatureFormValidationFn,
} from "./client-compat/feature-form.js";
export { FeatureTemplatesCompat } from "./client-compat/feature-templates.js";
export type {
  FeatureTemplatesHandleCompat,
  FeatureTemplatesLoadStatusCompat,
  FeatureTemplateItemCompat,
  FeatureTemplatesCompatOptions,
} from "./client-compat/feature-templates.js";
export { FeatureTableCompat } from "./client-compat/feature-table.js";
export { FeatureTableHighlightIdsCompat } from "./client-compat/feature-table.js";
export type {
  FeatureTableCompatOptions,
  FeatureTableHighlightIdsChangeEventCompat,
  FeatureTableHandleCompat,
  FeatureTableHighlightIdsHandleCompat,
  FeatureTableLoadStatusCompat,
  FeatureTableQueryRelatedRecordsOptions,
  FeatureTableRowCompat,
  FeatureTableStateCompat,
} from "./client-compat/feature-table.js";
export { FeatureSetCompat } from "./client-compat/feature-set.js";
export type {
  FeatureSetCompatOptions,
  FeatureSetHandleCompat,
  FeatureSetLoadStatusCompat,
} from "./client-compat/feature-set.js";
export { ColorCompat } from "./client-compat/color.js";
export type {
  ColorCompatInput,
  ColorHandleCompat,
  ColorLoadStatusCompat,
} from "./client-compat/color.js";
export { parseFeatureLayerUrl, parseMapServiceUrl } from "./client-compat/url.js";
export type { ParsedFeatureLayerUrl, ParsedMapServiceUrl } from "./client-compat/url.js";
export { PortalCompat, PortalError } from "./client-compat/portal.js";
export type {
  PortalCompatOptions,
  PortalFeatureServiceOpenResult,
  PortalGenerateTokenOptions,
  PortalGetItemOptions,
  PortalInfo,
  PortalItem,
  PortalOpenOptions,
  PortalOpenResult,
  PortalSearchOptions,
  PortalSearchResult,
  PortalSelf,
  PortalServiceOpenResult,
  PortalTokenCredential,
} from "./client-compat/portal.js";
export {
  createArcGisTokenInterceptor,
  createEsriRequestInterceptors,
  EsriRequestInterceptorRegistry,
} from "./client-compat/request.js";
export type {
  ArcGisTokenInterceptorOptions,
  EsriBeforeRequestParams,
  EsriRequestInterceptorHandle,
  EsriRequestInterceptorCompat,
  EsriRequestOptionsLike,
  EsriUrlPattern,
} from "./client-compat/request.js";
export { esriRequest } from "./client-compat/esri-request.js";
export type {
  EsriRequestCompatOptions,
  EsriRequestCompatResponse,
  EsriRequestResponseTypeCompat,
} from "./client-compat/esri-request.js";
export {
  esriConfig,
  getEsriConfigHonuaInterceptors,
  resetEsriConfig,
} from "./client-compat/esri-config.js";
export type { EsriConfigCompat, EsriConfigRequestCompat } from "./client-compat/esri-config.js";
export { identityManager } from "./client-compat/identity-manager.js";
export type {
  IdentityCredentialCompat,
  IdentityManagerOAuth2Engine,
  IdentityTokenRegistrationCompat,
} from "./client-compat/identity-manager.js";
export { OAuthInfoCompat } from "./client-compat/oauth-info.js";
export type {
  OAuthInfoCompatOptions,
  OAuthInfoHandleCompat,
  OAuthInfoLoadStatusCompat,
  OAuthInfoToConfigOptions,
} from "./client-compat/oauth-info.js";
export { CompatEventBus } from "./client-compat/event-bus.js";
export type {
  CompatEvent,
  CompatEventListener,
  CompatEventPayloads,
  CompatEventSubscription,
} from "./client-compat/event-bus.js";
export {
  AttributionCompat,
  BasemapToggleCompat,
  CompassCompat,
  FullscreenCompat,
  HomeCompat,
  LocateCompat,
  ScaleBarCompat,
  ZoomCompat,
} from "./client-compat/controls.js";
export type {
  AttributionCompatOptions,
  BasemapToggleCompatOptions,
  CompassCompatOptions,
  ControlHandleCompat,
  ControlLoadStatusCompat,
  ControlViewpointLike,
  FullscreenCompatOptions,
  HomeCompatOptions,
  HomeViewpointCompat,
  LocateCompatOptions,
  LocatePositionCompat,
  ScaleBarCompatOptions,
  ScaleBarUnitCompat,
  ZoomCompatOptions,
} from "./client-compat/controls.js";
export { BasemapGalleryCompat } from "./client-compat/basemap-gallery.js";
export type {
  BasemapGalleryCompatOptions,
  BasemapGalleryHandleCompat,
  BasemapGalleryLoadStatusCompat,
} from "./client-compat/basemap-gallery.js";
export { BasemapCompat } from "./client-compat/basemap.js";
export type {
  BasemapCompatOptions,
  BasemapHandleCompat,
  BasemapLoadStatusCompat,
} from "./client-compat/basemap.js";
export { BasemapLayerListCompat } from "./client-compat/basemap-layer-list.js";
export type {
  BasemapLayerListCompatOptions,
  BasemapLayerListHandleCompat,
  BasemapLayerListLoadStatusCompat,
} from "./client-compat/basemap-layer-list.js";
export { BookmarksCompat } from "./client-compat/bookmarks.js";
export type {
  BookmarkCompatItem,
  BookmarksCompatOptions,
  BookmarksHandleCompat,
  BookmarksLoadStatusCompat,
} from "./client-compat/bookmarks.js";
export { ExpandCompat } from "./client-compat/expand.js";
export type {
  ExpandCompatOptions,
  ExpandHandleCompat,
  ExpandLoadStatusCompat,
} from "./client-compat/expand.js";
export { GraphicsLayerCompat } from "./client-compat/graphics-layer.js";
export type {
  GraphicsLayerCompatOptions,
  GraphicsLayerHandleCompat,
  GraphicsLayerLoadStatusCompat,
  GraphicsLayerQueryResult,
} from "./client-compat/graphics-layer.js";
export { GraphicCompat } from "./client-compat/graphic.js";
export type {
  GraphicCompatOptions,
  GraphicHandleCompat,
  GraphicLoadStatusCompat,
} from "./client-compat/graphic.js";
export { PointCompat } from "./client-compat/point.js";
export type {
  PointCompatOptions,
  PointHandleCompat,
  PointLoadStatusCompat,
} from "./client-compat/point.js";
export { PolylineCompat } from "./client-compat/polyline.js";
export type {
  PolylineCompatOptions,
  PolylineHandleCompat,
  PolylineLoadStatusCompat,
} from "./client-compat/polyline.js";
export { PolygonCompat } from "./client-compat/polygon.js";
export type {
  PolygonCompatOptions,
  PolygonHandleCompat,
  PolygonLoadStatusCompat,
} from "./client-compat/polygon.js";
export { ExtentCompat } from "./client-compat/extent.js";
export type {
  ExtentCompatOptions,
  ExtentHandleCompat,
  ExtentLoadStatusCompat,
} from "./client-compat/extent.js";
export { SpatialReferenceCompat } from "./client-compat/spatial-reference.js";
export type {
  SpatialReferenceCompatOptions,
  SpatialReferenceHandleCompat,
  SpatialReferenceLoadStatusCompat,
} from "./client-compat/spatial-reference.js";
export { SimpleLineSymbolCompat } from "./client-compat/simple-line-symbol.js";
export type {
  SimpleLineSymbolCompatOptions,
  SimpleLineSymbolHandleCompat,
  SimpleLineSymbolLoadStatusCompat,
} from "./client-compat/simple-line-symbol.js";
export { SimpleFillSymbolCompat } from "./client-compat/simple-fill-symbol.js";
export type {
  SimpleFillSymbolCompatOptions,
  SimpleFillSymbolHandleCompat,
  SimpleFillSymbolLoadStatusCompat,
} from "./client-compat/simple-fill-symbol.js";
export { SimpleMarkerSymbolCompat } from "./client-compat/simple-marker-symbol.js";
export type {
  SimpleMarkerSymbolCompatOptions,
  SimpleMarkerSymbolHandleCompat,
  SimpleMarkerSymbolLoadStatusCompat,
} from "./client-compat/simple-marker-symbol.js";
export { PictureMarkerSymbolCompat } from "./client-compat/picture-marker-symbol.js";
export type {
  PictureMarkerSymbolCompatOptions,
  PictureMarkerSymbolHandleCompat,
  PictureMarkerSymbolLoadStatusCompat,
} from "./client-compat/picture-marker-symbol.js";
export { TextSymbolCompat } from "./client-compat/text-symbol.js";
export type {
  TextSymbolCompatOptions,
  TextSymbolHandleCompat,
  TextSymbolLoadStatusCompat,
} from "./client-compat/text-symbol.js";
export { LabelClassCompat } from "./client-compat/label-class.js";
export type {
  LabelClassCompatOptions,
  LabelClassHandleCompat,
  LabelClassLoadStatusCompat,
} from "./client-compat/label-class.js";
export { ClassBreaksRendererCompat } from "./client-compat/class-breaks-renderer.js";
export type {
  ClassBreakInfoCompat,
  ClassBreaksRendererHandleCompat,
  ClassBreaksRendererLoadStatusCompat,
  ClassBreaksRendererCompatOptions,
} from "./client-compat/class-breaks-renderer.js";
export { SimpleRendererCompat } from "./client-compat/simple-renderer.js";
export type {
  SimpleRendererCompatOptions,
  SimpleRendererHandleCompat,
  SimpleRendererLoadStatusCompat,
} from "./client-compat/simple-renderer.js";
export { UniqueValueRendererCompat } from "./client-compat/unique-value-renderer.js";
export type {
  UniqueValueInfoCompat,
  UniqueValueRendererHandleCompat,
  UniqueValueRendererLoadStatusCompat,
  UniqueValueRendererCompatOptions,
} from "./client-compat/unique-value-renderer.js";
// First-class renderer object emission (issue #497). All @experimental.
export {
  convertSimpleRendererCompat,
  rendererObjectFromClassBreaksCompat,
  rendererObjectFromUniqueValueCompat,
} from "./client-compat/renderer-objects.js";
export type { CompatRendererProjection } from "./client-compat/renderer-objects.js";
export { GroupLayerCompat } from "./client-compat/group-layer.js";
export type {
  GroupLayerCompatOptions,
  GroupLayerHandleCompat,
  GroupLayerLoadStatusCompat,
} from "./client-compat/group-layer.js";
export { MapCompat } from "./client-compat/map.js";
export type { MapCompatHandle, MapCompatOptions, MapLoadStatusCompat } from "./client-compat/map.js";
export { MapImageLayerCompat, MapImageSublayerCompat } from "./client-compat/map-image-layer.js";
export type {
  MapImageLayerApplyEditsOptions,
  MapImageLayerCreateQueryResult,
  MapImageLayerHandleCompat,
  MapImageLayerFindOptions,
  MapImageLayerIdentifyOptions,
  MapImageLayerCompatOptions,
  MapImageLayerExportOptions,
  MapImageLayerLoadStatusCompat,
  MapImageLayerLegendOptions,
  MapImageLayerQueryCountOptions,
  MapImageLayerQueryAllOptions,
  MapImageLayerQueryExtentOptions,
  MapImageLayerQueryExtentResponse,
  MapImageLayerQueryObjectIdsOptions,
  MapImageLayerQueryRelatedFeaturesOptions,
  MapImageLayerQueryOptions,
  MapImageSublayerApplyEditsOptions,
  MapImageSublayerCompatOptions,
  MapImageSublayerCreateQueryResult,
  MapImageSublayerQueryCountOptions,
  MapImageSublayerQueryAllOptions,
  MapImageSublayerQueryExtentOptions,
  MapImageSublayerQueryObjectIdsOptions,
  MapImageSublayerQueryRelatedFeaturesOptions,
  MapImageSublayerQueryOptions,
  MapImageLayerSublayerLookupId,
} from "./client-compat/map-image-layer.js";
export { TileLayerCompat } from "./client-compat/tile-layer.js";
export type {
  TileLayerCompatOptions,
  TileLayerHandleCompat,
  TileLayerLoadStatusCompat,
} from "./client-compat/tile-layer.js";
export { IdentifyCompat } from "./client-compat/identify.js";
export type {
  IdentifyHandleCompat,
  IdentifyLoadStatusCompat,
  IdentifyCompatLayerError,
  IdentifyCompatLayerResult,
  IdentifyCompatOptions,
  IdentifyCompatRequest,
  IdentifyCompatResult,
} from "./client-compat/identify.js";
export { RouteLayerCompat } from "./client-compat/route-layer.js";
export type {
  RouteLayerCompatOptions,
  RouteLayerHandleCompat,
  RouteLayerLoadStatusCompat,
  RouteSolveResultCompat,
  RouteStopCompat,
} from "./client-compat/route-layer.js";
export { RouteTaskCompat } from "./client-compat/route-task.js";
export type {
  RouteTaskHandleCompat,
  RouteTaskLoadStatusCompat,
  RouteTaskCompatOptions,
  RouteTaskDirectionsFeatureCompat,
  RouteTaskDirectionsSummaryCompat,
  RouteTaskResultGraphicCompat,
  RouteTaskRouteResultCompat,
  RouteTaskSolveParametersCompat,
  RouteTaskSolveResultCompat,
  RouteTaskStopFeatureCompat,
  RouteTaskStopsFeatureSetCompat,
} from "./client-compat/route-task.js";
export {
  LocatorCompat,
  LocatorSearchSourceCompat,
  locatorAddressToLocations,
  locatorAddressesToLocations,
  locatorLocationToAddress,
  locatorSuggestLocations,
} from "./client-compat/locator.js";
export type {
  AddressToLocationsParamsCompat,
  AddressesToLocationsParamsCompat,
  LocationToAddressParamsCompat,
  LocatorAddressCandidateCompat,
  LocatorAddressInputCompat,
  LocatorBatchAddressCompat,
  LocatorCompatOptions,
  LocatorExtentCompat,
  LocatorHandleCompat,
  LocatorLoadStatusCompat,
  LocatorPointCompat,
  LocatorSearchSourceCompatOptions,
  LocatorSpatialReferenceLike,
  LocatorSuggestionCompat,
  SuggestLocationsParamsCompat,
} from "./client-compat/locator.js";
export { DirectionsCompat, DirectionsViewModelCompat } from "./client-compat/directions.js";
export type {
  DirectionsCompatOptions,
  DirectionsHandleCompat,
  DirectionsLoadStatusCompat,
  DirectionsSolveSummaryCompat,
} from "./client-compat/directions.js";
export { CoordinateConversionCompat } from "./client-compat/coordinate-conversion.js";
export type {
  CoordinateConversionHandleCompat,
  CoordinateConversionLoadStatusCompat,
  CoordinateConversionCompatOptions,
  CoordinateConversionResultCompat,
  CoordinateFormatCompat,
} from "./client-compat/coordinate-conversion.js";
export { HonuaWidgetHost, registerHonuaWidgetKit } from "./client-compat/widget-host.js";
export type { HonuaWidgetHostElement, HonuaWidgetKitLike, HonuaWidgetKitSource } from "./client-compat/widget-host.js";
export { LayerListCompat } from "./client-compat/layer-list.js";
export type {
  LayerListActionCompat,
  LayerListCompatOptions,
  LayerListHandleCompat,
  LayerListItemCompat,
  LayerListLoadStatusCompat,
  LayerListListItemCreatedEventCompat,
  LayerListTriggerActionEventCompat,
  LayerListUpdatedEventCompat,
} from "./client-compat/layer-list.js";
export { LegendCompat } from "./client-compat/legend.js";
export type {
  LegendHandleCompat,
  LegendCompatOptions,
  LegendItemCompat,
  LegendLayerGroupCompat,
  LegendLoadStatusCompat,
} from "./client-compat/legend.js";
export {
  MapViewCompat,
  MapViewLayerViewCompat,
  MapViewPopupCompat,
  MapViewUiCompat,
} from "./client-compat/map-view.js";
export type {
  MapViewCenterLike,
  MapViewCompatOptions,
  MapViewConstraintsLike,
  MapViewExtentLike,
  MapViewGoToExtentLike,
  MapViewGoToInput,
  MapViewGoToOptions,
  MapViewGoToPointLike,
  MapViewGoToTarget,
  MapViewHandle,
  MapViewHighlightOptionsLike,
  MapViewHitTestEvent,
  MapViewHitTestResult,
  MapViewHitTestResultItem,
  MapViewLayerViewHighlightHandle,
  MapViewLayerViewHighlightOptions,
  MapViewLayerViewHighlightRecord,
  MapViewLoadStatusCompat,
  MapViewMapPoint,
  MapViewPaddingLike,
  MapViewPopupOpenOptions,
  MapViewScreenPoint,
  MapViewSpatialReferenceLike,
  MapViewTakeScreenshotArea,
  MapViewTakeScreenshotOptions,
  MapViewTakeScreenshotResult,
  MapViewUiAddOptions,
  MapViewUiComponentRecord,
  MapViewUiPosition,
} from "./client-compat/map-view.js";
export { PopupCompat } from "./client-compat/popup.js";
export type {
  PopupCompatOptions,
  PopupHandleCompat,
  PopupLoadStatusCompat,
  PopupOpenOptionsCompat,
} from "./client-compat/popup.js";
export { PopupTemplateCompat } from "./client-compat/popup-template.js";
export type {
  PopupTemplateAction,
  PopupTemplateCompatOptions,
  PopupTemplateExpressionInfo,
  PopupTemplateFieldInfo,
  PopupTemplateHandleCompat,
  PopupTemplateLoadStatusCompat,
} from "./client-compat/popup-template.js";
export { reactiveUtils, watch, when, whenOnce } from "./client-compat/reactive-utils.js";
export type {
  ReactiveUtilsHandleCompat,
  ReactiveUtilsWatchOptionsCompat,
  ReactiveUtilsWhenOptionsCompat,
} from "./client-compat/reactive-utils.js";
export { QueryCompat } from "./client-compat/query.js";
export type {
  QueryCompatOptions,
  QueryHandleCompat,
  QueryLoadStatusCompat,
} from "./client-compat/query.js";
export { PrintCompat } from "./client-compat/print.js";
export type {
  PrintHandleCompat,
  PrintLoadStatusCompat,
  PrintCompatOptions,
  PrintExecuteOptionsCompat,
  PrintResultCompat,
  PrintTemplateOptionsCompat,
} from "./client-compat/print.js";
export { SceneViewCompat } from "./client-compat/scene-view.js";
export type {
  SceneViewCompatOptions,
  SceneViewHandleCompat,
  SceneViewLoadStatusCompat,
} from "./client-compat/scene-view.js";
export { WebMapCompat } from "./client-compat/web-map.js";
export type {
  WebMapCompatOptions,
  WebMapHandleCompat,
  WebMapLoadStatusCompat,
} from "./client-compat/web-map.js";
export { SearchCompat } from "./client-compat/search.js";
export type {
  SearchCompatOptions,
  SearchExtentLike,
  SearchHandleCompat,
  SearchLoadStatusCompat,
  SearchPointLike,
  SearchRequestCompat,
  SearchResponseCompat,
  SearchResultCompat,
  SearchSourceCompat,
  SearchSuggestionCompat,
  SuggestResponseCompat,
} from "./client-compat/search.js";
export { SwipeCompat } from "./client-compat/swipe.js";
export type {
  SwipeCompatOptions,
  SwipeHandleCompat,
  SwipeLoadStatusCompat,
} from "./client-compat/swipe.js";
export { TrackCompat } from "./client-compat/track.js";
export type {
  TrackCompatOptions,
  TrackHandleCompat,
  TrackLoadStatusCompat,
  TrackPositionCompat,
} from "./client-compat/track.js";
export { MeasurementCompat } from "./client-compat/measurement.js";
export type {
  AreaUnitCompat,
  LinearUnitCompat,
  MeasurementHandleCompat,
  MeasurementLoadStatusCompat,
  MeasurementCompatOptions,
  MeasurementResultCompat,
  MeasurementToolCompat,
} from "./client-compat/measurement.js";
export { AreaMeasurement2DCompat, DistanceMeasurement2DCompat } from "./client-compat/measurement-2d.js";
export type {
  AreaMeasurement2DHandleCompat,
  AreaMeasurement2DLoadStatusCompat,
  AreaMeasurement2DCompatOptions,
  DistanceMeasurement2DHandleCompat,
  DistanceMeasurement2DLoadStatusCompat,
  DistanceMeasurement2DCompatOptions,
} from "./client-compat/measurement-2d.js";
export { TimeSliderCompat } from "./client-compat/time-slider.js";
export type {
  TimeSliderHandleCompat,
  TimeSliderLoadStatusCompat,
  TimeExtentCompat,
  TimeSliderCompatOptions,
  TimeSliderIntervalUnitCompat,
  TimeSliderModeCompat,
  TimeSliderStopsCompat,
} from "./client-compat/time-slider.js";
export { TableListCompat } from "./client-compat/table-list.js";
export type {
  TableListCompatOptions,
  TableListHandleCompat,
  TableListLoadStatusCompat,
} from "./client-compat/table-list.js";
export { SketchCompat, resolveSketchToolBindingCompat } from "./client-compat/sketch.js";
export type {
  SketchCompatOptions,
  SketchCreateOptionsCompat,
  SketchCreateResultCompat,
  SketchCreationModeCompat,
  SketchHandleCompat,
  SketchLoadStatusCompat,
  SketchToolBindingCompat,
  SketchToolCompat,
  SketchUpdateOptionsCompat,
} from "./client-compat/sketch.js";
export { EditorCompat } from "./client-compat/editor.js";
export type {
  EditorHandleCompat,
  EditorLoadStatusCompat,
  EditorCompatOptions,
  EditorLayerInfoCompat,
  EditorWorkflowCompat,
} from "./client-compat/editor.js";
export { snappingOptionsToSnappingConfig } from "./client-compat/snapping.js";
export type { SnappingFeatureSourceCompat, SnappingOptionsCompat } from "./client-compat/snapping.js";
export { FeatureEffectCompat } from "./client-compat/feature-effect.js";
export type { FeatureEffectCompatOptions } from "./client-compat/feature-effect.js";
export { FeatureFilterCompat } from "./client-compat/feature-filter.js";
export type {
  FeatureFilterCompatOptions,
  FeatureFilterEsriProperties,
  FeatureFilterGeometryCompat,
  FeatureFilterHandleCompat,
  FeatureFilterLoadStatusCompat,
  FeatureFilterSpatialRelationshipCompat,
  FeatureFilterTimeExtentCompat,
} from "./client-compat/feature-filter.js";
export { VectorTileLayerCompat } from "./client-compat/vector-tile-layer.js";
export type {
  VectorTileLayerCompatOptions,
  VectorTileLayerHandleCompat,
  VectorTileLayerLoadStatusCompat,
} from "./client-compat/vector-tile-layer.js";
export { GeoJSONLayerCompat } from "./client-compat/geojson-layer.js";
export type {
  GeoJSONLayerCompatOptions,
  GeoJSONLayerHandleCompat,
  GeoJSONLayerLoadStatusCompat,
  GeoJSONLayerQueryOptions,
  GeoJSONLayerQueryResult,
} from "./client-compat/geojson-layer.js";
export { WMSLayerCompat, WMSSublayerCompat } from "./client-compat/wms-layer.js";
export type {
  WMSLayerCompatOptions,
  WMSLayerHandleCompat,
  WMSLayerLoadStatusCompat,
  WMSSublayerCompatOptions,
} from "./client-compat/wms-layer.js";
export { WFSLayerCompat } from "./client-compat/wfs-layer.js";
export type {
  WFSLayerCompatOptions,
  WFSLayerHandleCompat,
  WFSLayerLoadStatusCompat,
  WFSLayerQueryOptions,
  WFSLayerQueryResult,
} from "./client-compat/wfs-layer.js";
export { ImageryLayerCompat } from "./client-compat/imagery-layer.js";
export type {
  ImageryLayerCompatOptions,
  ImageryLayerExportOptions,
  ImageryLayerHandleCompat,
  ImageryLayerIdentifyOptions,
  ImageryLayerLoadStatusCompat,
  ImageryLayerQueryOptions,
} from "./client-compat/imagery-layer.js";
export {
  buffer as geometryEngineBuffer,
  contains as geometryEngineContains,
  convexHull as geometryEngineConvexHull,
  difference as geometryEngineDifference,
  geodesicArea as geometryEngineGeodesicArea,
  geodesicLength as geometryEngineGeodesicLength,
  geometryEngineAsyncCompat,
  geometryEngineCompat,
  intersect as geometryEngineIntersect,
  intersects as geometryEngineIntersects,
  planarArea as geometryEnginePlanarArea,
  planarLength as geometryEnginePlanarLength,
  simplify as geometryEngineSimplify,
  union as geometryEngineUnion,
} from "./client-compat/geometry-engine.js";
export type {
  EsriAreaUnit,
  EsriLinearUnit,
  GeometryEngineInput,
} from "./client-compat/geometry-engine.js";
