/**
 * HTTP scene discovery for the 3D scene workspace.
 *
 * Honua publishes 3D scenes over the `geospatial.v1` `SceneService`
 * (`ListScenes` / `GetScene`) and mirrors that catalog over plain HTTP scene
 * discovery (`GET /api/scenes`, `GET /api/scenes/{id}`) alongside the static
 * 3D-Tiles entry point (`GET /scenes/{id}/tileset.json`). This module gives the
 * SDK a typed read model over that discovery surface and maps a discovered
 * {@link HonuaScene} onto the renderer-neutral {@link SceneRuntimePrimitive}s the
 * Cesium adapter renders.
 *
 * Discovery calls go through a caller-supplied {@link SceneDiscoveryRequestExecutor}
 * — typically `(...args) => client.pipelineRequestJson(...args)` against a
 * `HonuaClient` — so they reuse the SDK's shared auth / retry / timeout /
 * interceptor pipeline rather than issuing ad-hoc `fetch` calls. Modelling the
 * transport as a function keeps this module free of a hard `core/client` import
 * (and equally usable from a Node backend, a worker, or a unit test with a mock).
 *
 * The mapping helpers ({@link sceneToRuntimePrimitives},
 * {@link sceneCameraPrimitive}, {@link sceneViewpointBookmarks}) are pure (no
 * Cesium, no transport) and unit-testable on their own.
 *
 * @experimental Part of the experimental `scene-workspace` surface; not yet
 *   covered by the SDK's semver contract prior to `1.0.0`.
 * @module
 */

import { trimTrailingSlashes } from "../core/path-utils.js";
import type { QueryMethod } from "../core/types.js";
import type { SceneCameraPrimitive, SceneElevationSourcePrimitive, SceneModelLayerPrimitive } from "./primitives.js";
import type { SceneBookmark, SceneCameraState, SceneLayerState } from "./types.js";

/**
 * The minimal request executor scene discovery needs. This is exactly the shape
 * of `HonuaClient.pipelineRequestJson`, so a consumer wires the SDK's shared
 * HTTP pipeline (auth, retries, timeouts, interceptors) in with:
 *
 * ```ts
 * const executor: SceneDiscoveryRequestExecutor =
 *   (method, path, init, signal) => client.pipelineRequestJson(method, path, init, signal);
 * ```
 */
export type SceneDiscoveryRequestExecutor = <T = unknown>(
  method: QueryMethod,
  path: string,
  init?: { headers?: Record<string, string>; body?: string | null },
  signal?: AbortSignal,
) => Promise<T>;

/** A 3D bounding volume mirroring the server's `Extent3D` (horizontal envelope + height range). */
export interface SceneExtent3D {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly spatialReference?: number;
}

/** A named camera position (bookmark / initial view) mirroring the server's `Viewpoint`. */
export interface SceneViewpoint {
  readonly id: string;
  readonly title: string;
  readonly camera: SceneCameraState;
}

/**
 * A discovered Honua 3D scene, normalized from the server's `SceneMetadata`
 * (`geospatial.v1.SceneService`). Field names follow the SDK's camelCase
 * convention; both `tilesetUrl` (camelCase) and `tileset_url` (proto JSON) are
 * accepted on the wire and normalized here.
 */
export interface HonuaScene {
  readonly sceneId: string;
  readonly title?: string;
  readonly description?: string;
  /** URL of the root 3D-Tiles tileset (`tileset.json`). */
  readonly tilesetUrl?: string;
  /** URL of the terrain provider backing the scene, when present. */
  readonly terrainUrl?: string;
  /** Full 3D extent of the scene (horizontal envelope + min/max height). */
  readonly extent?: SceneExtent3D;
  /** Suggested initial camera for the first view. */
  readonly initialCamera?: SceneCameraState;
  /** Named viewpoints / bookmarks. */
  readonly viewpoints: readonly SceneViewpoint[];
  /** Scene-wide 3D-Tiles styling expression, when published with the scene. */
  readonly styleExpression?: string;
  /** Edition required to access the scene (e.g. `community`, `pro`); empty when unrestricted. */
  readonly edition?: string;
  /** Capability flags advertised for the scene (e.g. `terrain`, `point-cloud`, `styling`). */
  readonly capabilities: readonly string[];
}

const SCENES_BASE_PATH = "/api/scenes";

/** Raw camera shape accepted from the server (proto3 JSON). */
interface RawCamera {
  longitude?: number;
  latitude?: number;
  height?: number;
  heading?: number;
  pitch?: number;
  roll?: number;
}

/** Raw scene shape accepted from the server. Tolerates both camelCase and proto snake_case. */
interface RawScene {
  sceneId?: string;
  scene_id?: string;
  title?: string;
  description?: string;
  tilesetUrl?: string;
  tileset_url?: string;
  terrainUrl?: string;
  terrain_url?: string;
  extent?: {
    extent?: { xmin?: number; ymin?: number; xmax?: number; ymax?: number; spatialReference?: number };
    xmin?: number;
    ymin?: number;
    xmax?: number;
    ymax?: number;
    minHeight?: number;
    min_height?: number;
    maxHeight?: number;
    max_height?: number;
    spatialReference?: number;
  };
  initialCamera?: RawCamera;
  initial_camera?: RawCamera;
  viewpoints?: Array<{ id?: string; title?: string; camera?: RawCamera }>;
  style?: { expression?: string };
  styleExpression?: string;
  edition?: string;
  capabilities?: string[];
}

interface RawListScenesResponse {
  scenes?: RawScene[];
}

interface RawGetSceneResponse {
  scene?: RawScene;
}

function normalizeCamera(raw: RawCamera | undefined): SceneCameraState | undefined {
  if (!raw || raw.longitude === undefined || raw.latitude === undefined) return undefined;
  return {
    longitude: raw.longitude,
    latitude: raw.latitude,
    height: raw.height ?? 0,
    ...(raw.heading !== undefined ? { heading: raw.heading } : {}),
    ...(raw.pitch !== undefined ? { pitch: raw.pitch } : {}),
    ...(raw.roll !== undefined ? { roll: raw.roll } : {}),
  };
}

function normalizeExtent(raw: RawScene["extent"]): SceneExtent3D | undefined {
  if (!raw) return undefined;
  const envelope = raw.extent ?? raw;
  if (
    envelope.xmin === undefined ||
    envelope.ymin === undefined ||
    envelope.xmax === undefined ||
    envelope.ymax === undefined
  ) {
    return undefined;
  }
  const minHeight = raw.minHeight ?? raw.min_height;
  const maxHeight = raw.maxHeight ?? raw.max_height;
  return {
    xmin: envelope.xmin,
    ymin: envelope.ymin,
    xmax: envelope.xmax,
    ymax: envelope.ymax,
    ...(minHeight !== undefined ? { minHeight } : {}),
    ...(maxHeight !== undefined ? { maxHeight } : {}),
    ...(envelope.spatialReference !== undefined ? { spatialReference: envelope.spatialReference } : {}),
  };
}

/**
 * Normalize a raw scene payload (camelCase or proto3-JSON snake_case) into a
 * {@link HonuaScene}. Exported so the normalization is unit-testable against
 * either wire shape without a transport.
 */
export function normalizeScene(raw: RawScene): HonuaScene {
  const sceneId = raw.sceneId ?? raw.scene_id ?? "";
  const tilesetUrl = raw.tilesetUrl ?? raw.tileset_url;
  const terrainUrl = raw.terrainUrl ?? raw.terrain_url;
  const initialCamera = normalizeCamera(raw.initialCamera ?? raw.initial_camera);
  const viewpoints: SceneViewpoint[] = (raw.viewpoints ?? [])
    .map((viewpoint) => {
      const camera = normalizeCamera(viewpoint.camera);
      if (!camera || !viewpoint.id) return undefined;
      return { id: viewpoint.id, title: viewpoint.title ?? viewpoint.id, camera };
    })
    .filter((viewpoint): viewpoint is SceneViewpoint => viewpoint !== undefined);
  const styleExpression = raw.styleExpression ?? raw.style?.expression;
  return {
    sceneId,
    ...(raw.title !== undefined ? { title: raw.title } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(tilesetUrl !== undefined ? { tilesetUrl } : {}),
    ...(terrainUrl !== undefined ? { terrainUrl } : {}),
    ...(normalizeExtent(raw.extent) ? { extent: normalizeExtent(raw.extent) } : {}),
    ...(initialCamera ? { initialCamera } : {}),
    viewpoints,
    ...(styleExpression !== undefined ? { styleExpression } : {}),
    ...(raw.edition !== undefined ? { edition: raw.edition } : {}),
    capabilities: raw.capabilities ?? [],
  };
}

/**
 * List the catalog of available 3D scenes from `GET /api/scenes`
 * (`SceneService.ListScenes`). Returns the normalized {@link HonuaScene}s.
 */
export async function listScenes(execute: SceneDiscoveryRequestExecutor, signal?: AbortSignal): Promise<HonuaScene[]> {
  const raw = await execute<RawListScenesResponse>("GET", SCENES_BASE_PATH, undefined, signal);
  return (raw.scenes ?? []).map(normalizeScene);
}

/**
 * Fetch a single scene's metadata from `GET /api/scenes/{sceneId}`
 * (`SceneService.GetScene`). The response is tolerated as either the bare scene
 * object or a `{ scene }` envelope.
 */
export async function getScene(
  execute: SceneDiscoveryRequestExecutor,
  sceneId: string,
  signal?: AbortSignal,
): Promise<HonuaScene> {
  if (!sceneId) throw new Error("getScene requires a non-empty sceneId.");
  const raw = await execute<RawGetSceneResponse & RawScene>(
    "GET",
    `${SCENES_BASE_PATH}/${encodeURIComponent(sceneId)}`,
    undefined,
    signal,
  );
  return normalizeScene(raw.scene ?? raw);
}

/**
 * Resolve the static 3D-Tiles entry-point URL for a scene
 * (`/scenes/{sceneId}/tileset.json`). Prefers the scene's advertised
 * `tilesetUrl`; falls back to the conventional discovery path under `baseUrl`
 * when the scene omits one. Returns `undefined` when neither is available.
 */
export function resolveSceneTilesetUrl(scene: HonuaScene, baseUrl?: string): string | undefined {
  if (scene.tilesetUrl && scene.tilesetUrl.trim() !== "") return scene.tilesetUrl;
  if (!baseUrl) return undefined;
  const trimmed = trimTrailingSlashes(baseUrl);
  return `${trimmed}/scenes/${encodeURIComponent(scene.sceneId)}/tileset.json`;
}

/**
 * Build the camera primitive for a scene's suggested initial view, or
 * `undefined` when the scene advertises no initial camera. Pure.
 */
export function sceneCameraPrimitive(scene: HonuaScene): SceneCameraPrimitive | undefined {
  if (!scene.initialCamera) return undefined;
  return {
    kind: "camera",
    id: `${scene.sceneId}:camera`,
    camera: scene.initialCamera,
    mode: "global",
  };
}

/**
 * Build the 3D-Tiles model-layer primitive for a scene's root tileset, or
 * `undefined` when the scene has no resolvable tileset URL. Pure.
 */
export function sceneTilesetPrimitive(scene: HonuaScene, baseUrl?: string): SceneModelLayerPrimitive | undefined {
  const uri = resolveSceneTilesetUrl(scene, baseUrl);
  if (!uri) return undefined;
  return {
    kind: "model-layer",
    id: `${scene.sceneId}:tileset`,
    uri,
    format: "3d-tiles",
    ...(scene.title !== undefined ? { title: scene.title } : {}),
  };
}

/**
 * Build the terrain elevation-source primitive for a scene's terrain provider,
 * or `undefined` when the scene advertises no terrain. Pure. The provider is
 * treated as a quantized-mesh endpoint (Cesium's `CesiumTerrainProvider`).
 */
export function sceneTerrainPrimitive(scene: HonuaScene): SceneElevationSourcePrimitive | undefined {
  if (!scene.terrainUrl || scene.terrainUrl.trim() === "") return undefined;
  return {
    kind: "elevation-source",
    id: `${scene.sceneId}:terrain`,
    sourceId: `${scene.sceneId}:terrain`,
    protocol: "quantized-mesh",
    url: scene.terrainUrl,
  };
}

/**
 * Map a discovered scene onto the renderer-neutral primitives the Cesium
 * adapter renders: an initial-camera primitive, the terrain elevation source
 * (when present), and the 3D-Tiles tileset (when resolvable). Pure; the result
 * feeds straight into `applyCesiumScenePrimitives` / a `SceneView`.
 */
export function sceneToRuntimePrimitives(
  scene: HonuaScene,
  baseUrl?: string,
): Array<SceneCameraPrimitive | SceneElevationSourcePrimitive | SceneModelLayerPrimitive> {
  const primitives: Array<SceneCameraPrimitive | SceneElevationSourcePrimitive | SceneModelLayerPrimitive> = [];
  const camera = sceneCameraPrimitive(scene);
  if (camera) primitives.push(camera);
  const terrain = sceneTerrainPrimitive(scene);
  if (terrain) primitives.push(terrain);
  const tileset = sceneTilesetPrimitive(scene, baseUrl);
  if (tileset) primitives.push(tileset);
  return primitives;
}

/**
 * Build the workspace layer states for a discovered scene (one per rendered
 * primitive), so a {@link module:scene-workspace/workspace.SceneWorkspace} can
 * seed its layer list from the scene. Pure.
 */
export function sceneLayerStates(scene: HonuaScene, baseUrl?: string): SceneLayerState[] {
  const layers: SceneLayerState[] = [];
  if (sceneTilesetPrimitive(scene, baseUrl)) {
    layers.push({
      id: `${scene.sceneId}:tileset`,
      title: scene.title ?? scene.sceneId,
      visible: true,
      kind: "tiles",
    });
  }
  if (sceneTerrainPrimitive(scene)) {
    layers.push({
      id: `${scene.sceneId}:terrain`,
      title: "Terrain",
      visible: true,
      kind: "scene",
    });
  }
  return layers;
}

/**
 * Convert a scene's named viewpoints into workspace {@link SceneBookmark}s. Pure.
 */
export function sceneViewpointBookmarks(scene: HonuaScene): SceneBookmark[] {
  return scene.viewpoints.map((viewpoint) => ({
    id: viewpoint.id,
    label: viewpoint.title,
    camera: viewpoint.camera,
  }));
}
