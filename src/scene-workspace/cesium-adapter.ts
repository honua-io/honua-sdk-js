/**
 * Cesium 3D `SceneRuntimeAdapter` for the renderer-neutral scene workspace.
 *
 * This module deliberately keeps the camera-state mapping pure and free of any
 * static Cesium import so that 2D-only consumers never pay the CesiumJS bundle
 * cost. The CesiumJS runtime is only pulled in lazily (`await import("cesium")`)
 * when a live {@link CesiumSceneRuntimeTarget} is actually driven.
 *
 * Rich layer rendering (3D Tiles / glTF / point clouds / terrain providers) is
 * intentionally minimal here — the capability is *declared* so the workspace
 * routes 3D primitives to this adapter, but the rendering specifics are tracked
 * separately in honua-server#1197. See the `// TODO(#1197)` markers below.
 *
 * @experimental Part of the experimental `scene-workspace` surface; not yet
 *   covered by the SDK's semver contract prior to `1.0.0`.
 * @module
 */

import {
  type ScenePrimitiveApplyResult,
  type SceneRuntimeAdapter,
  type SceneRuntimeCapabilities,
  type SceneRuntimePrimitive,
  createSceneRuntimeAdapter,
  diagnoseScenePrimitives,
  summarizeDiagnosticStatus,
} from "./primitives.js";
import type { SceneCameraState, SceneWorkspaceState } from "./types.js";

/**
 * Capabilities advertised by the Cesium adapter. Unlike the MapLibre 2.5D
 * adapter, Cesium is a true globe renderer: full 3D camera with
 * heading/pitch/roll/height, terrain across the common elevation protocols, and
 * model layers for 3D Tiles / glTF / I3S / point clouds.
 */
export const CESIUM_SCENE_CAPABILITIES: SceneRuntimeCapabilities = {
  renderer: "cesium",
  camera: true,
  ground: true,
  terrain: {
    protocols: ["quantized-mesh", "terrain-rgb", "raster-dem", "image-service", "custom"],
    supportsExaggeration: true,
  },
  extrusion: true,
  modelLayer: {
    // glTF/glb single models, 3D Tiles tilesets (incl. point clouds), and I3S
    // scene layers are all natively renderable by Cesium.
    formats: ["gltf", "glb", "3d-tiles", "i3s"],
  },
  sceneLayerMetadata: true,
};

/**
 * Cesium camera orientation, expressed in radians (Cesium's native unit).
 */
export interface CesiumHeadingPitchRollRadians {
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
}

/**
 * A renderer-neutral description of a Cesium `Camera.setView` call. Longitude /
 * latitude / height are kept in degrees + metres (the workspace contract) and
 * the orientation is pre-converted to radians so a live adapter can hand it
 * straight to Cesium without re-deriving units.
 */
export interface CesiumCameraView {
  readonly destination: {
    readonly longitude: number;
    readonly latitude: number;
    readonly height: number;
  };
  readonly orientation: CesiumHeadingPitchRollRadians;
}

/**
 * The minimal slice of Cesium's `Camera` that the adapter reads from. Cesium
 * exposes `positionCartographic` (lon/lat/height in radians + metres) and
 * heading/pitch/roll getters in radians. Modelling only this surface keeps the
 * state mapping unit-testable without a live WebGL `Viewer`.
 */
export interface CesiumCameraLike {
  readonly positionCartographic: {
    readonly longitude: number;
    readonly latitude: number;
    readonly height: number;
  };
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
  setView(options: {
    destination?: unknown;
    orientation?: { heading?: number; pitch?: number; roll?: number };
  }): void;
}

/**
 * The subset of a live Cesium `Viewer`/`Scene` the adapter drives. Supplying
 * this is optional: an adapter created without a target still diagnoses
 * primitives and performs pure camera math, it just cannot mutate a live globe.
 */
export interface CesiumSceneRuntimeTarget {
  readonly camera: CesiumCameraLike;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function toRadians(degrees: number): number {
  return degrees * DEG2RAD;
}

function toDegrees(radians: number): number {
  return radians * RAD2DEG;
}

/**
 * Map a renderer-neutral {@link SceneCameraState} (degrees + metres) onto a
 * Cesium `setView` description (degrees destination + radian orientation).
 *
 * Heading/pitch/roll default to Cesium's own defaults — heading 0 (north),
 * pitch -90 (looking straight down), roll 0 — when the workspace omits them.
 */
export function cameraStateToCesiumView(camera: SceneCameraState): CesiumCameraView {
  return {
    destination: {
      longitude: camera.longitude,
      latitude: camera.latitude,
      height: camera.height,
    },
    orientation: {
      heading: toRadians(camera.heading ?? 0),
      pitch: toRadians(camera.pitch ?? -90),
      roll: toRadians(camera.roll ?? 0),
    },
  };
}

/**
 * Read a live (or mocked) Cesium camera back into a renderer-neutral
 * {@link SceneCameraState}. This is the inverse of
 * {@link cameraStateToCesiumView} and is the load-bearing half of the
 * camera-state round-trip through the workspace.
 */
export function cesiumCameraToSceneState(camera: CesiumCameraLike): SceneCameraState {
  return {
    longitude: toDegrees(camera.positionCartographic.longitude),
    latitude: toDegrees(camera.positionCartographic.latitude),
    height: camera.positionCartographic.height,
    heading: normalizeAngleDegrees(toDegrees(camera.heading)),
    pitch: toDegrees(camera.pitch),
    roll: toDegrees(camera.roll),
  };
}

/**
 * Apply a {@link SceneCameraState} to a live (or mocked) Cesium camera.
 *
 * The destination is left as degrees + height on the `setView` call; a live
 * adapter (see {@link applyCesiumScenePrimitives}) converts it to a
 * `Cartesian3` via the lazily-loaded Cesium module before calling `setView`.
 * Tests can pass a mock camera and assert the orientation (in radians) directly.
 */
export function applyCameraStateToCesiumCamera(
  camera: CesiumCameraLike,
  state: SceneCameraState,
  toCartesian: (lon: number, lat: number, height: number) => unknown = (longitude, latitude, height) => ({
    longitude,
    latitude,
    height,
  }),
): void {
  const view = cameraStateToCesiumView(state);
  camera.setView({
    destination: toCartesian(view.destination.longitude, view.destination.latitude, view.destination.height),
    orientation: view.orientation,
  });
}

/**
 * Normalize a heading in degrees into the `[0, 360)` range so a round-trip
 * through Cesium (which wraps headings) compares cleanly. Pitch and roll are
 * left untouched because Cesium keeps them in their natural signed ranges.
 */
function normalizeAngleDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return degrees;
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Lazily import the CesiumJS runtime. Kept in its own function so the dynamic
 * `import("cesium")` is the *only* reference to the package in `src/`, which is
 * what keeps Cesium out of the 2D bundle.
 */
async function loadCesium(): Promise<typeof import("cesium")> {
  return import("cesium");
}

/**
 * Apply scene primitives to a live Cesium target.
 *
 * Today this lands the ENGINE + CAMERA: camera primitives synchronize the live
 * globe via the lazily-loaded Cesium `Cartesian3`. Terrain / model / extrusion
 * rendering is declared-capable (so the workspace routes those primitives here
 * rather than to a non-existent "custom" adapter) but the concrete provider
 * wiring is deferred to honua-server#1197.
 */
export async function applyCesiumScenePrimitives(
  target: CesiumSceneRuntimeTarget,
  primitives: readonly SceneRuntimePrimitive[],
  state?: SceneWorkspaceState,
): Promise<ScenePrimitiveApplyResult> {
  const diagnostics = diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES);
  const cesium = await loadCesium();
  const toCartesian = (longitude: number, latitude: number, height: number): unknown =>
    cesium.Cartesian3.fromDegrees(longitude, latitude, height);

  for (const primitive of primitives) {
    if (primitive.kind === "camera") {
      applyCameraStateToCesiumCamera(target.camera, primitive.camera, toCartesian);
    }
    // TODO(#1197): apply terrain (CesiumTerrainProvider / quantized-mesh),
    // model-layer (Cesium3DTileset / Model.fromGltfAsync), extrusion, and
    // scene-layer-metadata primitives to the live scene. Capability is declared
    // above so the workspace routes them here; rich rendering lands in #1197.
  }

  return {
    status: summarizeDiagnosticStatus(diagnostics),
    diagnostics,
  };
}

/**
 * Create a {@link SceneRuntimeAdapter} backed by CesiumJS.
 *
 * When `options.target` (a live Cesium `Viewer`/`Scene` camera surface) is
 * supplied, `apply` drives the live globe (camera today; richer layers in
 * #1197). Without a target the adapter still diagnoses primitives against
 * Cesium's true-3D capabilities — useful for migration analysis before a viewer
 * exists. CesiumJS itself is only imported lazily when `apply` runs.
 */
export function createCesiumSceneAdapter(
  options: { readonly id?: string; readonly target?: CesiumSceneRuntimeTarget } = {},
): SceneRuntimeAdapter {
  const { id = "cesium-scene", target } = options;
  return createSceneRuntimeAdapter({
    id,
    capabilities: CESIUM_SCENE_CAPABILITIES,
    ...(target
      ? {
          apply: (primitives: readonly SceneRuntimePrimitive[], state?: SceneWorkspaceState) =>
            applyCesiumScenePrimitives(target, primitives, state),
        }
      : {}),
  });
}
