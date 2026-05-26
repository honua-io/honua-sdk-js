/**
 * Cesium 3D `SceneRuntimeAdapter` for the renderer-neutral scene workspace.
 *
 * This module deliberately keeps the camera-state mapping pure and free of any
 * static Cesium import so that 2D-only consumers never pay the CesiumJS bundle
 * cost. The CesiumJS runtime is only pulled in lazily (`await import("cesium")`)
 * when a live {@link CesiumSceneRuntimeTarget} is actually driven.
 *
 * As of honua-server#1197 the adapter renders Honua 3D content end-to-end:
 * 3D-Tiles tilesets (add/remove/visibility), terrain providers (quantized-mesh
 * via `CesiumTerrainProvider`, with vertical exaggeration), and glTF/GLB model
 * layers placed with heading/pitch/roll + scale. It also resolves a picked
 * 3D-Tiles feature's attributes (batch properties / `EXT_structural_metadata`).
 *
 * The provider wiring is still kept Cesium-mockable: every CesiumJS symbol the
 * adapter touches is read off the lazily-imported module, so the wiring is
 * exercised against a `vi.mock("cesium")` stub without a live WebGL `Viewer`.
 *
 * @experimental Part of the experimental `scene-workspace` surface; not yet
 *   covered by the SDK's semver contract prior to `1.0.0`.
 * @module
 */

import {
  type SceneElevationSourcePrimitive,
  type SceneModelLayerPrimitive,
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
    // glTF/glb single models and 3D Tiles tilesets (incl. point clouds) are
    // rendered live by this adapter as of #1197. I3S scene layers remain
    // declared-capable (Cesium can consume them) but Honua's server does not yet
    // emit i3s model-layer primitives, so they fall through to diagnostics only.
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
 * A 3D-Tiles tileset handle (the bits the adapter mutates). Real Cesium
 * `Cesium3DTileset` instances satisfy this; tests pass a plain object.
 */
export interface CesiumTilesetLike {
  show: boolean;
  modelMatrix?: unknown;
  destroy?(): void;
  isDestroyed?(): boolean;
}

/**
 * A glTF/GLB model handle (the bits the adapter mutates). Real Cesium `Model`
 * instances satisfy this.
 */
export interface CesiumModelLike {
  show: boolean;
  modelMatrix?: unknown;
  destroy?(): void;
  isDestroyed?(): boolean;
}

/**
 * The Cesium `PrimitiveCollection` surface (off `scene.primitives`) the adapter
 * uses to add/remove tilesets and models.
 */
export interface CesiumPrimitiveCollectionLike {
  add(primitive: unknown, index?: number): unknown;
  remove(primitive?: unknown): boolean;
  contains(primitive?: unknown): boolean;
}

/**
 * The Cesium `Scene` surface the adapter mutates: a primitive collection for
 * tilesets/models, a settable `terrainProvider`, vertical exaggeration, and a
 * `pick` entry point used by {@link pickCesiumFeatureAttributes}.
 */
export interface CesiumSceneLike {
  readonly primitives: CesiumPrimitiveCollectionLike;
  terrainProvider?: unknown;
  verticalExaggeration?: number;
  pick?(windowPosition: unknown, width?: number, height?: number): unknown;
}

/**
 * The subset of a live Cesium `Viewer`/`Scene` the adapter drives. Supplying
 * this is optional: an adapter created without a target still diagnoses
 * primitives and performs pure camera math, it just cannot mutate a live globe.
 *
 * `scene` is optional so a camera-only target (as shipped in #1196) keeps
 * working unchanged; layer rendering simply no-ops without it.
 */
export interface CesiumSceneRuntimeTarget {
  readonly camera: CesiumCameraLike;
  readonly scene?: CesiumSceneLike;
}

/**
 * A renderer-neutral plan for placing one model/tileset/terrain provider on a
 * live scene. Pure (no Cesium import) so the mapping is unit-testable; the live
 * adapter materializes each plan via the lazily-loaded Cesium module.
 */
export interface CesiumModelPlacement {
  readonly position: { readonly longitude: number; readonly latitude: number; readonly height: number };
  readonly orientation: CesiumHeadingPitchRollRadians;
  readonly scale: number;
}

/**
 * The handle returned by {@link applyCesiumScenePrimitives} so callers can
 * later toggle visibility or tear a layer down. Keyed by the primitive id.
 */
export interface CesiumLayerHandle {
  readonly id: string;
  readonly kind: "model-layer" | "elevation-source";
  readonly format?: SceneModelLayerPrimitive["format"];
  setVisible(visible: boolean): void;
  remove(): void;
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
 * Resolve the scale factor for a model layer. The primitive allows a uniform
 * number or a per-axis triple; Cesium `Model.fromGltfAsync` takes a single
 * uniform `scale`, so a triple collapses to its first finite component (with a
 * sane `1` fallback). Non-finite / non-positive values fall back to `1`.
 */
export function resolveCesiumModelScale(scale: SceneModelLayerPrimitive["scale"]): number {
  const candidate = Array.isArray(scale) ? scale[0] : scale;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : 1;
}

/**
 * Map a {@link SceneModelLayerPrimitive} onto a renderer-neutral
 * {@link CesiumModelPlacement} (degrees + metres position, radian orientation,
 * uniform scale). Pure so the placement math is unit-testable without Cesium.
 *
 * `position` defaults to lon/lat 0 at height 0; `rotation` (degrees, in the
 * workspace contract) defaults to heading/pitch/roll 0.
 */
export function modelLayerToCesiumPlacement(primitive: SceneModelLayerPrimitive): CesiumModelPlacement {
  const [longitude = 0, latitude = 0, height = 0] = primitive.position ?? [];
  const [heading = 0, pitch = 0, roll = 0] = primitive.rotation ?? [];
  return {
    position: { longitude, latitude, height: height ?? 0 },
    orientation: { heading: toRadians(heading), pitch: toRadians(pitch), roll: toRadians(roll) },
    scale: resolveCesiumModelScale(primitive.scale),
  };
}

/**
 * The Cesium symbols the live wiring needs. Modelled as the minimal slice of
 * `typeof import("cesium")` so a `vi.mock("cesium")` stub can satisfy it.
 */
type CesiumModule = {
  readonly Cartesian3: {
    fromDegrees(longitude: number, latitude: number, height?: number): unknown;
  };
  readonly HeadingPitchRoll: new (heading?: number, pitch?: number, roll?: number) => unknown;
  readonly Transforms: {
    headingPitchRollToFixedFrame(origin: unknown, headingPitchRoll: unknown): unknown;
  };
  readonly Matrix4: {
    multiplyByUniformScale(matrix: unknown, scale: number, result: unknown): unknown;
    clone(matrix: unknown, result?: unknown): unknown;
  };
  readonly Cesium3DTileset: {
    fromUrl(url: string, options?: Record<string, unknown>): Promise<CesiumTilesetLike>;
  };
  readonly Model: {
    fromGltfAsync(options: Record<string, unknown>): Promise<CesiumModelLike>;
  };
  readonly CesiumTerrainProvider: {
    fromUrl(url: string, options?: Record<string, unknown>): Promise<unknown>;
  };
};

/**
 * Lazily import the CesiumJS runtime. Kept in its own function so the dynamic
 * `import("cesium")` is the *only* reference to the package in `src/`, which is
 * what keeps Cesium out of the 2D bundle.
 */
async function loadCesium(): Promise<CesiumModule> {
  return (await import("cesium")) as unknown as CesiumModule;
}

/**
 * Build a Cesium `Matrix4` model matrix from a {@link CesiumModelPlacement}
 * using the supplied (lazily-loaded) Cesium module. Position becomes an
 * east-north-up fixed frame at the placement origin, then a uniform scale is
 * folded in. Isolated so the live adapter and tests share one path.
 */
function placementToModelMatrix(cesium: CesiumModule, placement: CesiumModelPlacement): unknown {
  const origin = cesium.Cartesian3.fromDegrees(
    placement.position.longitude,
    placement.position.latitude,
    placement.position.height,
  );
  const hpr = new cesium.HeadingPitchRoll(
    placement.orientation.heading,
    placement.orientation.pitch,
    placement.orientation.roll,
  );
  const frame = cesium.Transforms.headingPitchRollToFixedFrame(origin, hpr);
  return placement.scale === 1 ? frame : cesium.Matrix4.multiplyByUniformScale(frame, placement.scale, frame);
}

/**
 * Materialize a 3D-Tiles tileset from a model-layer primitive and add it to the
 * scene's primitive collection, returning a handle for later visibility /
 * teardown. Exported so consumers (and tests) can drive a single tileset.
 */
export async function addCesium3DTileset(
  scene: CesiumSceneLike,
  primitive: SceneModelLayerPrimitive,
  cesium?: CesiumModule,
): Promise<CesiumLayerHandle> {
  const mod = cesium ?? (await loadCesium());
  const tileset = await mod.Cesium3DTileset.fromUrl(primitive.uri);
  if (primitive.position) {
    tileset.modelMatrix = placementToModelMatrix(mod, modelLayerToCesiumPlacement(primitive));
  }
  scene.primitives.add(tileset);
  return makeLayerHandle(scene, primitive.id, tileset, "model-layer", primitive.format);
}

/**
 * Materialize a glTF/GLB model from a model-layer primitive, placing it at the
 * primitive's position/rotation/scale, and add it to the scene. Returns a
 * handle for visibility / teardown.
 */
export async function addCesiumModel(
  scene: CesiumSceneLike,
  primitive: SceneModelLayerPrimitive,
  cesium?: CesiumModule,
): Promise<CesiumLayerHandle> {
  const mod = cesium ?? (await loadCesium());
  const placement = modelLayerToCesiumPlacement(primitive);
  // `placementToModelMatrix` already folds the uniform scale into the model
  // matrix (alongside translation + rotation). Cesium applies `Model.scale` on
  // top of `modelMatrix`, so passing it here too would square the scale
  // (requested 3 → rendered 9). Apply it exactly once, via the matrix.
  const model = await mod.Model.fromGltfAsync({
    url: primitive.uri,
    modelMatrix: placementToModelMatrix(mod, placement),
  });
  scene.primitives.add(model);
  return makeLayerHandle(scene, primitive.id, model, "model-layer", primitive.format);
}

/**
 * Wire a terrain provider from an elevation-source primitive onto the scene.
 *
 * `quantized-mesh` maps to `CesiumTerrainProvider.fromUrl` natively. `terrain-rgb`
 * / `raster-dem` (Mapbox/Terrarium-encoded raster DEM tiles) are treated the
 * same way: Cesium consumes a quantized-mesh-style endpoint at `url`, so we wire
 * the provider when a `url` is present and otherwise leave the globe on its
 * default ellipsoid (the diagnostic already flags a missing url). Exaggeration
 * is applied via the scene's `verticalExaggeration`.
 */
export async function applyCesiumTerrain(
  scene: CesiumSceneLike,
  primitive: SceneElevationSourcePrimitive,
  cesium?: CesiumModule,
): Promise<CesiumLayerHandle | undefined> {
  const url = typeof primitive.url === "string" && primitive.url.trim() !== "" ? primitive.url : undefined;
  if (primitive.exaggeration !== undefined && Number.isFinite(primitive.exaggeration)) {
    scene.verticalExaggeration = primitive.exaggeration;
  }
  if (!url) return undefined;
  const mod = cesium ?? (await loadCesium());
  const provider = await mod.CesiumTerrainProvider.fromUrl(url);
  scene.terrainProvider = provider;
  return {
    id: primitive.id,
    kind: "elevation-source",
    setVisible() {
      /* terrain is always on once set; visibility is a no-op for the provider. */
    },
    remove() {
      // Only tear down if *this* handle's provider is still the active one. If a
      // newer elevation source has since replaced `scene.terrainProvider`,
      // removing this (now-stale) handle must be a no-op so we don't clobber the
      // active terrain/exaggeration.
      if (scene.terrainProvider !== provider) return;
      scene.terrainProvider = undefined;
      scene.verticalExaggeration = 1;
    },
  };
}

function makeLayerHandle(
  scene: CesiumSceneLike,
  id: string,
  primitive: CesiumTilesetLike | CesiumModelLike,
  kind: "model-layer",
  format: SceneModelLayerPrimitive["format"],
): CesiumLayerHandle {
  return {
    id,
    kind,
    format,
    setVisible(visible: boolean) {
      primitive.show = visible;
    },
    remove() {
      if (scene.primitives.contains(primitive)) scene.primitives.remove(primitive);
    },
  };
}

/**
 * Resolve the attributes of a picked 3D-Tiles feature.
 *
 * Cesium returns a `Cesium3DTileFeature` from `scene.pick(...)` for tileset
 * hits; its batch-table / `EXT_structural_metadata` properties are read via
 * `getPropertyIds()` + `getProperty(id)`. Anything else (terrain, a glTF model
 * primitive, empty space) yields `undefined`. Pure given a picked object, so it
 * is unit-testable with a plain stub.
 */
export function resolvePickedFeatureAttributes(picked: unknown): Record<string, unknown> | undefined {
  if (picked === null || typeof picked !== "object") return undefined;
  const feature = picked as {
    getPropertyIds?: (results?: string[]) => string[];
    getProperty?: (name: string) => unknown;
  };
  if (typeof feature.getPropertyIds !== "function" || typeof feature.getProperty !== "function") return undefined;
  const attributes: Record<string, unknown> = {};
  for (const propertyId of feature.getPropertyIds()) {
    attributes[propertyId] = feature.getProperty(propertyId);
  }
  return attributes;
}

/**
 * Pick a 3D-Tiles feature at the given window position and return its
 * attributes (or `undefined` for a miss / non-feature hit). Convenience wrapper
 * over `scene.pick` + {@link resolvePickedFeatureAttributes} for identify flows.
 */
export function pickCesiumFeatureAttributes(
  scene: CesiumSceneLike,
  windowPosition: unknown,
): Record<string, unknown> | undefined {
  if (typeof scene.pick !== "function") return undefined;
  return resolvePickedFeatureAttributes(scene.pick(windowPosition));
}

/**
 * Apply scene primitives to a live Cesium target.
 *
 * As of #1197 this lands the full 3D stack against `target.scene`:
 *  - `camera` → `Camera.setView` (via the lazily-loaded `Cartesian3`).
 *  - `elevation-source` → `scene.terrainProvider` + `verticalExaggeration`.
 *  - `model-layer` (`3d-tiles`) → `Cesium3DTileset.fromUrl` added to
 *    `scene.primitives`; (`gltf`/`glb`) → `Model.fromGltfAsync` placed by
 *    position/rotation/scale.
 *
 * Returns the diagnostics plus the live layer handles keyed by primitive id so
 * callers can toggle visibility / tear layers down. Layer rendering is skipped
 * (gracefully) when no `scene` is attached or when a primitive diagnoses as
 * unsupported. I3S model layers and extrusions are declared-capable but not yet
 * materialized here (no Honua server primitives emit them); point clouds ride
 * the 3D-Tiles path and are gated on server ingest (honua-server#1201).
 */
export async function applyCesiumScenePrimitives(
  target: CesiumSceneRuntimeTarget,
  primitives: readonly SceneRuntimePrimitive[],
  _state?: SceneWorkspaceState,
): Promise<ScenePrimitiveApplyResult & { readonly layers: ReadonlyMap<string, CesiumLayerHandle> }> {
  const diagnostics = diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES);
  const cesium = await loadCesium();
  const toCartesian = (longitude: number, latitude: number, height: number): unknown =>
    cesium.Cartesian3.fromDegrees(longitude, latitude, height);
  const unsupportedIds = new Set(
    diagnostics.filter((diagnostic) => diagnostic.status === "unsupported").map((diagnostic) => diagnostic.primitiveId),
  );
  const layers = new Map<string, CesiumLayerHandle>();
  const scene = target.scene;

  for (const primitive of primitives) {
    if (primitive.kind === "camera") {
      applyCameraStateToCesiumCamera(target.camera, primitive.camera, toCartesian);
      continue;
    }
    if (!scene || unsupportedIds.has(primitive.id)) continue;

    if (primitive.kind === "elevation-source") {
      const handle = await applyCesiumTerrain(scene, primitive, cesium);
      if (handle) layers.set(handle.id, handle);
      continue;
    }
    if (primitive.kind === "model-layer") {
      if (primitive.format === "3d-tiles") {
        layers.set(primitive.id, await addCesium3DTileset(scene, primitive, cesium));
      } else if (primitive.format === "gltf" || primitive.format === "glb") {
        layers.set(primitive.id, await addCesiumModel(scene, primitive, cesium));
      }
      // i3s / obj / custom: declared-capable but not materialized here.
    }
  }

  return {
    status: summarizeDiagnosticStatus(diagnostics),
    diagnostics,
    layers,
  };
}

/**
 * Create a {@link SceneRuntimeAdapter} backed by CesiumJS.
 *
 * When `options.target` (a live Cesium `Viewer`/`Scene` surface — a `camera`
 * plus an optional `scene`) is supplied, `apply` drives the live globe: camera
 * sync plus, when a `scene` is attached, terrain providers, 3D-Tiles tilesets,
 * and glTF/GLB model layers (#1197). Without a target the adapter still
 * diagnoses primitives against Cesium's true-3D capabilities — useful for
 * migration analysis before a viewer exists. CesiumJS itself is only imported
 * lazily when `apply` runs.
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
