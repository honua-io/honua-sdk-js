/**
 * `@honua/app-platform/scene-workspace` — framework-neutral 3D scene workspace
 * state and the Cesium renderer adapter. `@honua/sdk-js/scene-workspace` is a
 * deprecated 0.1.x forwarder onto this module.
 *
 * This barrel carries two support tiers, and they are enumerated symbol by
 * symbol in `config/support-manifest.v1.json` (projected into
 * `config/public-surface.json`) rather than inferred from the directory. The
 * support gate fails on an export that no tier classifies, so nothing is
 * promoted by proximity.
 *
 * @beta The renderer-neutral workspace state, the scene primitive contract, and
 *   the Cesium primitive adapter keep their shape through `@honua/app-platform`
 *   0.1.x: no export is renamed or removed, primitive discriminants and
 *   diagnostic codes grow additively only, and Cesium stays a lazily imported
 *   optional peer. Additive union members can still require a new arm in an
 *   exhaustive `switch`, the `cesium` peer floor can rise within 0.1.x, and the
 *   server-authored 3D style types track the Honua Server styling contract.
 * @experimental Held back from the beta tier: Honua Server scene discovery, the
 *   `SceneView` container, and the elevation/analysis widgets (server-attached,
 *   outside the open-endpoint evidence), plus the bounded accepted-plan
 *   `Source`-to-Cesium-entity slice and the `mountCesiumScene` owner that
 *   composes it with the primitive mount. Those may change in any minor release.
 * @module
 */

export {
  createSceneWorkspace,
  emptySceneWorkspaceState,
  reduceSceneWorkspaceState,
  sceneWorkspaceIntentFromAdapterEvent,
  selectSceneDiagnosticsByStatus,
  selectSceneEvidenceForFeature,
  selectScenePrimitivesByKind,
  selectSceneVisibleLayers,
} from "./workspace.js";
export {
  SCENE_STATE_SYNC_KIND,
  SCENE_STATE_SYNC_SLICES,
  SCENE_STATE_SYNC_SLICE_WORKSPACE_CROSSWALK,
  SCENE_STATE_SYNC_VERSION,
  HonuaSceneStateSyncError,
  createSceneStateSynchronizer,
  defaultSceneStateSyncMappings,
} from "./state-sync.js";
export {
  DEFAULT_MAPLIBRE_CAMERA_GEOMETRY,
  DEFAULT_MAPLIBRE_CAMERA_LIMITS,
  EARTH_CIRCUMFERENCE_METERS,
  WEB_MERCATOR_MAX_LATITUDE,
  mapLibreCameraHeightToZoom,
  mapLibreGroundResolutionMeters,
  mapLibreViewToSceneCamera,
  mapLibreZoomToCameraHeight,
  sceneCameraToMapLibreView,
} from "./camera-correspondence.js";
export type {
  MapLibreCameraGeometry,
  MapLibreCameraLimits,
  MapLibreCameraProjection,
  MapLibreCameraView,
  SceneCameraDegradation,
  SceneCameraDegradationCode,
} from "./camera-correspondence.js";
export { sceneAttributionId, sceneAttributionValue } from "./state-sync-port-kit.js";
export type {
  SceneStateSyncPortDegradation,
  SceneStateSyncPortDegradationCode,
  SceneStateSyncPublishOutcome,
  SceneStateSyncRendererPort,
} from "./state-sync-port-kit.js";
export { createMapLibreStateSyncPort } from "./maplibre-state-sync.js";
export type { CreateMapLibreStateSyncPortOptions, MapLibreStateSyncTarget } from "./maplibre-state-sync.js";
export { createCesiumStateSyncPort } from "./cesium-state-sync.js";
export type {
  CesiumStateSyncEntity,
  CesiumStateSyncEntityCollection,
  CesiumStateSyncEvent,
  CesiumStateSyncModule,
  CesiumStateSyncTarget,
  CreateCesiumStateSyncPortOptions,
} from "./cesium-state-sync.js";
export type {
  CreateSceneStateSynchronizerOptions,
  SceneStateSyncAttributionValue,
  SceneStateSyncDelivery,
  SceneStateSyncDiagnostic,
  SceneStateSyncDiagnosticCode,
  SceneStateSyncEnvelope,
  SceneStateSyncErrorCode,
  SceneStateSyncEvent,
  SceneStateSyncFidelity,
  SceneStateSyncIdentity,
  SceneStateSyncInput,
  SceneStateSyncMapping,
  SceneStateSyncMappings,
  SceneStateSyncOrigin,
  SceneStateSyncPort,
  SceneStateSyncRealtimeValue,
  SceneStateSyncRenderer,
  SceneStateSyncSlice,
  SceneStateSyncSnapshot,
  SceneStateSyncValueMap,
  SceneStateSynchronizer,
} from "./state-sync.js";
export {
  MAPLIBRE_SCENE_CAPABILITIES,
  RENDERER_WGS84_SPATIAL_CAPABILITIES,
  applyMapLibreScenePrimitives,
  compileMapLibreFilterSet,
  compileMapLibreFilters,
  createMapLibreSceneAdapter,
  createSceneRuntimeAdapter,
  diagnoseScenePrimitive,
  diagnoseScenePrimitives,
  summarizeDiagnosticStatus,
  toMapLibreExtrusionLayer,
  toMapLibreTerrainPatch,
} from "./primitives.js";
export {
  CESIUM_SCENE_CAPABILITIES,
  addCesium3DTileset,
  addCesiumImageryLayer,
  addCesiumModel,
  applyCameraStateToCesiumCamera,
  applyCesiumScenePrimitives,
  applyCesiumTerrain,
  applyHonua3DStyle,
  applyTilesetServerStyle,
  cameraStateToCesiumView,
  cesiumCameraToSceneState,
  createCesiumSceneAdapter,
  fetchHonua3DStyleSpec,
  honua3DStyleToCesiumStyleOptions,
  loadHonua3DStyle,
  modelLayerToCesiumPlacement,
  pickCesiumFeatureAttributes,
  readHonua3DStyleDescriptor,
  resolveCesiumModelScale,
  resolveHonua3DStyleUri,
  resolvePickedFeatureAttributes,
  setTilesetStyle,
} from "./cesium-adapter.js";
export {
  SCENE_REBUILD_BOUNDARIES,
  applyCesiumClockPlan,
  applyCesiumSceneTime,
  bindTemporalPlaybackToCesium,
  cesiumClockPlanWrites,
  isCesiumClockRuntime,
  readCesiumClock,
  restoreCesiumClock,
  sceneRebuildBoundaryReport,
  sceneTimelineToCesiumClockPlan,
} from "./cesium-time.js";
export type {
  BindTemporalPlaybackToCesiumOptions,
  CesiumClockLike,
  CesiumClockOwnership,
  CesiumClockPlan,
  CesiumClockRuntimeLoader,
  CesiumClockRuntimeModule,
  CesiumClockSnapshot,
  CesiumClockTarget,
  CesiumSceneTimeApplication,
  CesiumTemporalPlayback,
  CesiumTemporalPlaybackBinding,
  CesiumTemporalPlaybackInstant,
  CesiumTemporalPlaybackRefusal,
  CesiumTemporalPlaybackTransport,
  CesiumTemporalPlaybackWindow,
  SceneRebuildBoundary,
  SceneRebuildBoundaryReport,
  SceneTimeDiagnosticCode,
} from "./cesium-time.js";
export {
  DEFAULT_SCENE_MOUNT_LAYER_LIMIT,
  HonuaCesiumSceneMountError,
  mountScenePrimitivesToCesium,
} from "./cesium-mount.js";
export type {
  ApplyMountedScenePrimitivesOptions,
  CesiumSceneMountErrorCode,
  CesiumSceneMountState,
  MountedCesiumScenePrimitives,
  MountedScenePrimitiveApplyResult,
  MountScenePrimitivesToCesiumOptions,
} from "./cesium-mount.js";
export type {
  AddCesium3DTilesetOptions,
  CesiumCameraLike,
  CesiumCameraView,
  CesiumHeadingPitchRollRadians,
  CesiumImageryLayerCollectionLike,
  CesiumImageryLayerLike,
  CesiumImageryProviderLike,
  CesiumLayerHandle,
  CesiumModelLike,
  CesiumModelPlacement,
  CesiumPrimitiveCollectionLike,
  CesiumSceneLike,
  CesiumSceneMaterializationOptions,
  CesiumSceneRuntimeTarget,
  CesiumTilesetLike,
  Honua3DStyleConditions,
  Honua3DStyleDescriptor,
  Honua3DStyleSpec,
} from "./cesium-adapter.js";
export {
  CESIUM_ENTITY_REBUILD_BOUNDARIES,
  DEFAULT_CESIUM_ENTITY_LIMIT,
  HonuaCesiumEntityAdapterError,
  mountSourceToCesium,
  projectSourceToCesium,
} from "./source-to-cesium.js";
export type {
  CesiumEntityAdapterErrorCode,
  CesiumEntityCollectionTarget,
  CesiumEntityDiagnostic,
  CesiumEntityDiagnosticCode,
  CesiumEntityGeometry,
  CesiumEntityInterval,
  CesiumEntityProjection,
  CesiumEntityProjectionItem,
  CesiumEntityPositionSample,
  CesiumEntityRebuildBoundary,
  CesiumEntityRebuildBoundaryReport,
  CesiumEntityRefreshResult,
  CesiumEntityRuntimeLoader,
  CesiumEntityRuntimeModule,
  CesiumEntityTimeOptions,
  CesiumEntityWorkflowState,
  MountedCesiumEntitySource,
  MountSourceToCesiumOptions,
  ProjectSourceToCesiumOptions,
} from "./source-to-cesium.js";
export {
  DEFAULT_CESIUM_SCENE_SOURCE_LIMIT,
  HonuaCesiumSceneOwnerError,
  mountCesiumScene,
} from "./cesium-scene-owner.js";
export type {
  CesiumSceneOwnerErrorCode,
  CesiumSceneOwnerState,
  CesiumSceneOwnerTarget,
  MountCesiumSceneOptions,
  MountedCesiumScene,
} from "./cesium-scene-owner.js";
export {
  buildElevationProfilePath,
  buildLineOfSightBody,
  buildViewshedBody,
  formatMeasurementLabel,
  haversineMeters,
  measureScenePositions,
  pathLengthMeters,
  positionsToWktLineString,
  renderElevationProfilePolyline,
  renderLineOfSight,
  renderMeasurement,
  renderViewshed,
  requestElevationProfile,
  requestLineOfSight,
  requestViewshed,
  slantDistanceMeters,
  sphericalPolygonAreaSquareMeters,
} from "./analysis-widgets.js";
export type {
  CesiumEntityCollectionLike,
  ElevationProfileRequest,
  ElevationProfileResult,
  ElevationProfileSample,
  LineOfSightRequest,
  LineOfSightResult,
  SceneAnalysisCesiumModule,
  SceneAnalysisOverlay,
  SceneAnalysisPosition,
  SceneAnalysisRequestExecutor,
  SceneMeasurement,
  ViewshedRequest,
  ViewshedResult,
  ViewshedSample,
} from "./analysis-widgets.js";
export {
  getScene,
  listScenes,
  normalizeScene,
  resolveSceneTilesetUrl,
  sceneCameraPrimitive,
  sceneLayerStates,
  sceneTerrainPrimitive,
  sceneTilesetPrimitive,
  sceneToRuntimePrimitives,
  sceneViewpointBookmarks,
} from "./scene-discovery.js";
export type {
  HonuaScene,
  SceneDiscoveryRequestExecutor,
  SceneExtent3D,
  SceneViewpoint,
} from "./scene-discovery.js";
export { SceneView } from "./scene-view.js";
export type {
  SceneViewEvent,
  SceneViewEventListener,
  SceneViewOptions,
  SceneViewRequestExecutor,
} from "./scene-view.js";
export { SCENE_WORKSPACE_SLICES } from "./types.js";
export type {
  MapLibreExtrusionLayerSpecification,
  MapLibreFilterCompilation,
  MapLibreFilterOmission,
  MapLibreSceneRuntimeTarget,
  MapLibreTerrainOptions,
  MapLibreTerrainPatch,
  MapLibreTerrainSourceSpecification,
  SceneCacheMetadata,
  SceneCameraPrimitive,
  SceneElevationSourcePrimitive,
  SceneElevationSourceProtocol,
  SceneExtrusionPrimitive,
  SceneExtrusionValue,
  SceneGroundPrimitive,
  SceneImageryLayerPrimitive,
  SceneImagerySourceProtocol,
  SceneLayerMetadataPrimitive,
  SceneModelFormat,
  SceneModelLayerPrimitive,
  ScenePointCloudShading,
  ScenePrimitiveApplyResult,
  ScenePrimitiveDiagnostic,
  ScenePrimitiveDiagnosticSeverity,
  ScenePrimitiveStatus,
  SceneRendererKind,
  SceneRuntimeAdapter,
  SceneRuntimeCapabilities,
  SceneRuntimePrimitive,
  SceneRuntimePrimitiveKind,
  SceneSpatialCapabilities,
  SceneSpatialFidelity,
  SceneSpatialPrecision,
  SceneSpatialPrecisionFloor,
  SceneSpatialReference,
} from "./primitives.js";
export type {
  SceneBookmark,
  SceneCameraState,
  SceneDetailState,
  SceneEvidenceReference,
  SceneLayerState,
  SceneRealtimeState,
  SceneTimelineState,
  SceneWorkspace,
  SceneWorkspaceAdapterEvent,
  SceneWorkspaceChangeEvent,
  SceneWorkspaceHistoryEntry,
  SceneWorkspaceIntent,
  SceneWorkspaceListener,
  SceneWorkspaceSlice,
  SceneWorkspaceSnapshot,
  SceneWorkspaceState,
  SceneWorkspaceUnsubscribe,
} from "./types.js";
