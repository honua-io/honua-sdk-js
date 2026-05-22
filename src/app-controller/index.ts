/**
 * `@honua/sdk-js/app-controller` — renderer-neutral application controller.
 *
 * HonuaController composes MapPackage runtime, generated-app runtime, and
 * ExplorationContext primitives into one typed API for viewport, selection,
 * visibility, temporary overlays, annotations, snapshots, and events.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export {
  HONUA_CONTROLLER_SNAPSHOT_VERSION,
  HonuaController,
  HonuaControllerError,
  createHonuaController,
} from "./controller.js";
export type {
  HonuaAnnotationStyle,
  HonuaBounds,
  HonuaControllerAdapter,
  HonuaControllerAdapterSubscription,
  HonuaControllerErrorCode,
  HonuaControllerEvent,
  HonuaControllerEventBase,
  HonuaControllerEventFor,
  HonuaControllerEventListener,
  HonuaControllerEventSource,
  HonuaControllerEventType,
  HonuaControllerIdleEvent,
  HonuaControllerLayerSourceChangeEvent,
  HonuaControllerOptions,
  HonuaControllerRuntime,
  HonuaControllerRuntimeLike,
  HonuaControllerSelectionChangeEvent,
  HonuaControllerSnapshot,
  HonuaControllerViewportEvent,
  HonuaControllerVisibilityChangeEvent,
  HonuaCoordinate,
  HonuaFitBoundsOptions,
  HonuaGeneratedAppRuntimeLike,
  HonuaGeoJson,
  HonuaGeoJsonFeature,
  HonuaGeoJsonFeatureCollection,
  HonuaGeoJsonGeometry,
  HonuaLayerSourceMutation,
  HonuaLayerSourceMutationAction,
  HonuaLayerSourcePersistenceHooks,
  HonuaLayerSourcePersistenceOptions,
  HonuaLayerSourcePersistenceOutcome,
  HonuaLayerSourcePersistencePayload,
  HonuaLayerSourcePersistenceResult,
  HonuaOverlayStyle,
  HonuaTemporaryAnnotation,
  HonuaTemporaryAnnotationInput,
  HonuaTemporaryOverlay,
  HonuaTemporaryOverlayInput,
  HonuaViewport,
  HonuaViewportOptions,
  HonuaVisibilityChangeSet,
  HonuaVisibilitySnapshot,
  HonuaVisibilityTarget,
  HonuaVisibilityTargetInput,
  HonuaVisibilityTargetKind,
  HonuaVisibilityUpdate,
} from "./controller.js";
