/**
 * `@honua/sdk-js/scene-workspace` — framework-neutral 3D scene workspace state.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
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
  MAPLIBRE_SCENE_CAPABILITIES,
  applyMapLibreScenePrimitives,
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
  addCesiumModel,
  applyCameraStateToCesiumCamera,
  applyCesiumScenePrimitives,
  applyCesiumTerrain,
  cameraStateToCesiumView,
  cesiumCameraToSceneState,
  createCesiumSceneAdapter,
  modelLayerToCesiumPlacement,
  pickCesiumFeatureAttributes,
  resolveCesiumModelScale,
  resolvePickedFeatureAttributes,
} from "./cesium-adapter.js";
export type {
  CesiumCameraLike,
  CesiumCameraView,
  CesiumHeadingPitchRollRadians,
  CesiumLayerHandle,
  CesiumModelLike,
  CesiumModelPlacement,
  CesiumPrimitiveCollectionLike,
  CesiumSceneLike,
  CesiumSceneRuntimeTarget,
  CesiumTilesetLike,
} from "./cesium-adapter.js";
export { SCENE_WORKSPACE_SLICES } from "./types.js";
export type {
  MapLibreExtrusionLayerSpecification,
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
  SceneLayerMetadataPrimitive,
  SceneModelFormat,
  SceneModelLayerPrimitive,
  ScenePrimitiveApplyResult,
  ScenePrimitiveDiagnostic,
  ScenePrimitiveDiagnosticSeverity,
  ScenePrimitiveStatus,
  SceneRendererKind,
  SceneRuntimeAdapter,
  SceneRuntimeCapabilities,
  SceneRuntimePrimitive,
  SceneRuntimePrimitiveKind,
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
