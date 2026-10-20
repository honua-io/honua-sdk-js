/**
 * HTTP scene discovery for the 3D scene workspace.
 *
 * Honua Server publishes three public JSON contracts, and this module
 * normalizes those rather than the proto `sceneId` / `title` / `extent` shape:
 *
 * - `GET /api/scenes` — list items use `id`, `name`, `tilesetUrl`, `bounds`, `auth`
 * - `GET /api/scenes/{sceneId}` — metadata uses `id`, `name`, `tileset`, `center`, `bounds`, `auth`
 * - `GET /api/scenes/{sceneId}/resolve` — resolution uses `sceneId`, `endpoints`, `auth`
 *
 * `bounds` is `{west,south,east,north}` and is remapped onto {@link SceneExtent3D}.
 * `center` is `{latitude,longitude,height}` and becomes the initial camera.
 * A nested metadata `tileset` object supplies the tileset URL. The flat proto
 * names (`sceneId`, `scene_id`, `title`, `tileset_url`, `extent`) are still
 * accepted so older payloads do not throw; callers that need the server
 * contract should pass the three routes above.
 *
 * The runtime tileset URL comes from {@link resolveScene}. Nothing in this
 * module synthesizes `/scenes/{id}/tileset.json`. An empty id fails closed
 * before a request is sent, and a tileset URL whose path contains `/scenes//`
 * is rejected so a missing id cannot be requested.
 *
 * Auth requirements are retained on the normalized scene. This module does not
 * refresh protected-asset credentials; that is a separate ticket.
 *
 * Discovery calls go through a caller-supplied {@link SceneDiscoveryRequestExecutor}
 * — typically `(...args) => client.pipelineRequestJson(...args)` against a
 * `HonuaClient` — so they reuse the SDK's shared auth / retry / timeout /
 * interceptor pipeline rather than issuing ad-hoc `fetch` calls.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier: Honua Server scene discovery is server-attached, so it sits outside
 *   the open-endpoint evidence behind that promotion and may change in any
 *   minor release prior to `1.0.0`. The renderer-neutral primitives it maps onto
 *   are beta.
 * @module
 */

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

/** A 3D bounding volume (horizontal envelope + optional height range). */
export interface SceneExtent3D {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly spatialReference?: number;
}

/** A named camera position (bookmark / initial view). */
export interface SceneViewpoint {
  readonly id: string;
  readonly title: string;
  readonly camera: SceneCameraState;
}

/**
 * Auth requirements advertised by the public scene list, metadata, and resolve
 * routes. Preserved for the caller; credential refresh is not performed here.
 */
export interface HonuaSceneAuth {
  readonly requiresAuthentication: boolean;
  readonly schemes: readonly string[];
  readonly policy?: string;
}

/** One render endpoint from the resolve route (`kind` + absolute `url`). */
export interface HonuaSceneEndpoint {
  readonly kind: string;
  readonly url: string;
  readonly mediaType?: string;
  readonly format?: string;
  readonly requiresAuthentication: boolean;
}

/** A link relation on scene metadata (`self`, `resolve`, …). */
export interface HonuaSceneLink {
  readonly rel: string;
  readonly href: string;
  readonly type?: string;
  readonly title?: string;
}

/**
 * The resolve route's runtime contract. `tilesetUrl` is the absolute 3D Tiles
 * entry point chosen from the response's `tilesetUrl` or its `3d-tiles`
 * endpoint. It is never invented from the scene id.
 */
export interface HonuaSceneResolution {
  readonly sceneId: string;
  readonly tilesetUrl?: string;
  readonly endpoints: readonly HonuaSceneEndpoint[];
  readonly capabilities: readonly string[];
  readonly auth: HonuaSceneAuth;
}

/**
 * A discovered Honua 3D scene. `title` is the display name (`name` on the
 * server, `title` on older proto payloads). `extent` is the server `bounds`
 * object remapped onto xmin/ymin/xmax/ymax.
 */
export interface HonuaScene {
  readonly sceneId: string;
  /** Server catalog name, when the payload used `name`. */
  readonly name?: string;
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
  /** Auth requirements from the server payload, when present. */
  readonly auth?: HonuaSceneAuth;
  readonly attribution?: readonly string[];
  readonly updatedAt?: string;
  readonly links?: readonly HonuaSceneLink[];
}

const SCENES_BASE_PATH = "/api/scenes";
const EMPTY_TILESET_PATH = "/scenes//";

function asRecord(raw: unknown, message: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(message);
  }
  return raw as Record<string, unknown>;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requireSceneId(record: Record<string, unknown>, message: string): string {
  // `id` is the list/metadata contract. `sceneId` / `scene_id` remain only so
  // proto-shaped payloads still normalize; an empty value is never substituted.
  const sceneId = readId(record.id) ?? readId(record.sceneId) ?? readId(record.scene_id);
  if (!sceneId) throw new Error(message);
  return sceneId;
}

function readFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reject a blank URL and the empty-id `/scenes//` path. */
function isUsableSceneResourceUrl(url: string | undefined): url is string {
  if (!url) return false;
  const trimmed = url.trim();
  return trimmed !== "" && !trimmed.includes(EMPTY_TILESET_PATH);
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function readAuth(value: unknown): HonuaSceneAuth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const schemes = readStringList(record.schemes) ?? [];
  const policy = readText(record.policy);
  return {
    requiresAuthentication: record.requiresAuthentication === true,
    schemes,
    ...(policy !== undefined ? { policy } : {}),
  };
}

function readEndpoint(value: unknown): HonuaSceneEndpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const url = readText(record.url) ?? readText(record.href);
  const kind = readText(record.kind) ?? readText(record.type) ?? readText(record.format);
  if (!isUsableSceneResourceUrl(url) || !kind) return undefined;
  const mediaType = readText(record.mediaType);
  const format = readText(record.format);
  return {
    kind,
    url: url.trim(),
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(format !== undefined ? { format } : {}),
    requiresAuthentication: record.requiresAuthentication === true,
  };
}

function readEndpoints(value: unknown): HonuaSceneEndpoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const endpoint = readEndpoint(item);
    return endpoint ? [endpoint] : [];
  });
}

function readLinks(value: unknown): HonuaSceneLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: HonuaSceneLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rel = readText(record.rel);
    const href = readText(record.href);
    if (!rel || !href) continue;
    const type = readText(record.type);
    const title = readText(record.title);
    links.push({
      rel,
      href,
      ...(type !== undefined ? { type } : {}),
      ...(title !== undefined ? { title } : {}),
    });
  }
  return links;
}

function readTilesetUrl(record: Record<string, unknown>): string | undefined {
  const flat = readText(record.tilesetUrl) ?? readText(record.tileset_url);
  if (isUsableSceneResourceUrl(flat)) return flat.trim();
  const tileset = record.tileset;
  if (!tileset || typeof tileset !== "object" || Array.isArray(tileset)) return undefined;
  const nested = tileset as Record<string, unknown>;
  const url = readText(nested.url) ?? readText(nested.href);
  return isUsableSceneResourceUrl(url) ? url.trim() : undefined;
}

function normalizeCamera(raw: unknown): SceneCameraState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const camera = raw as Record<string, unknown>;
  const longitude = readFinite(camera.longitude);
  const latitude = readFinite(camera.latitude);
  if (longitude === undefined || latitude === undefined) return undefined;
  const height = readFinite(camera.height) ?? 0;
  const heading = readFinite(camera.heading);
  const pitch = readFinite(camera.pitch);
  const roll = readFinite(camera.roll);
  return {
    longitude,
    latitude,
    height,
    ...(heading !== undefined ? { heading } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(roll !== undefined ? { roll } : {}),
  };
}

/** Server `bounds` (`west`/`south`/`east`/`north`) onto the SDK extent axes. */
function readBounds(raw: unknown): SceneExtent3D | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const bounds = raw as Record<string, unknown>;
  const xmin = readFinite(bounds.west);
  const ymin = readFinite(bounds.south);
  const xmax = readFinite(bounds.east);
  const ymax = readFinite(bounds.north);
  if (xmin === undefined || ymin === undefined || xmax === undefined || ymax === undefined) return undefined;
  return { xmin, ymin, xmax, ymax };
}

/** Proto `extent` tolerance: a flat or nested `{xmin,ymin,xmax,ymax}` envelope. */
function readProtoExtent(raw: unknown): SceneExtent3D | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const nested = record.extent;
  const envelope =
    nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : record;
  const xmin = readFinite(envelope.xmin);
  const ymin = readFinite(envelope.ymin);
  const xmax = readFinite(envelope.xmax);
  const ymax = readFinite(envelope.ymax);
  if (xmin === undefined || ymin === undefined || xmax === undefined || ymax === undefined) return undefined;
  const minHeight = readFinite(record.minHeight) ?? readFinite(record.min_height);
  const maxHeight = readFinite(record.maxHeight) ?? readFinite(record.max_height);
  const spatialReference = readFinite(envelope.spatialReference);
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    ...(minHeight !== undefined ? { minHeight } : {}),
    ...(maxHeight !== undefined ? { maxHeight } : {}),
    ...(spatialReference !== undefined ? { spatialReference } : {}),
  };
}

function readExtent(record: Record<string, unknown>): SceneExtent3D | undefined {
  return readBounds(record.bounds) ?? readProtoExtent(record.extent);
}

function readInitialCamera(record: Record<string, unknown>): SceneCameraState | undefined {
  const explicit = normalizeCamera(record.initialCamera) ?? normalizeCamera(record.initial_camera);
  if (explicit) return explicit;
  return normalizeCamera(record.center);
}

function readViewpoints(value: unknown): SceneViewpoint[] {
  if (!Array.isArray(value)) return [];
  const viewpoints: SceneViewpoint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = readId(record.id);
    const camera = normalizeCamera(record.camera);
    if (!id || !camera) continue;
    const title = readText(record.title) ?? id;
    viewpoints.push({ id, title, camera });
  }
  return viewpoints;
}

function readStyleExpression(record: Record<string, unknown>): string | undefined {
  const direct = readText(record.styleExpression);
  if (direct) return direct;
  const style = record.style;
  if (!style || typeof style !== "object" || Array.isArray(style)) return undefined;
  return readText((style as Record<string, unknown>).expression);
}

function readScene(record: Record<string, unknown>, missingIdMessage: string): HonuaScene {
  const sceneId = requireSceneId(record, missingIdMessage);
  const name = readText(record.name);
  const title = name ?? readText(record.title);
  const description = readText(record.description);
  const tilesetUrl = readTilesetUrl(record);
  const terrainUrl = readText(record.terrainUrl) ?? readText(record.terrain_url);
  const extent = readExtent(record);
  const initialCamera = readInitialCamera(record);
  const styleExpression = readStyleExpression(record);
  const edition = readText(record.edition);
  const auth = readAuth(record.auth);
  const attribution = readStringList(record.attribution);
  const updatedAt = readText(record.updatedAt);
  const links = readLinks(record.links);
  const usableTerrain = isUsableSceneResourceUrl(terrainUrl) ? terrainUrl.trim() : undefined;
  return {
    sceneId,
    ...(name !== undefined ? { name } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(tilesetUrl !== undefined ? { tilesetUrl } : {}),
    ...(usableTerrain !== undefined ? { terrainUrl: usableTerrain } : {}),
    ...(extent ? { extent } : {}),
    ...(initialCamera ? { initialCamera } : {}),
    viewpoints: readViewpoints(record.viewpoints),
    ...(styleExpression !== undefined ? { styleExpression } : {}),
    ...(edition !== undefined ? { edition } : {}),
    capabilities: readStringList(record.capabilities) ?? [],
    ...(auth ? { auth } : {}),
    ...(attribution ? { attribution } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(links ? { links } : {}),
  };
}

function unwrapSceneEnvelope(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw, "Scene response must be a JSON object.");
  const nested = record.scene;
  const hasOwnId = readId(record.id) ?? readId(record.sceneId) ?? readId(record.scene_id);
  if (!hasOwnId && nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return record;
}

/**
 * Normalize one list item from `GET /api/scenes`.
 * Reads `id`, `name`, `tilesetUrl`, `bounds`, and `auth`.
 */
export function normalizeSceneSummary(raw: unknown): HonuaScene {
  return readScene(asRecord(raw, "Scene list item must be a JSON object."), "Scene list item is missing an id.");
}

/**
 * Normalize `GET /api/scenes/{sceneId}`.
 * Reads `id`, `name`, `tileset`, `center`, `bounds`, and `auth`.
 * A `{ scene }` envelope is accepted only when the root has no id of its own
 * (proto-shaped responses). The server returns the metadata object itself.
 */
export function normalizeSceneMetadata(raw: unknown): HonuaScene {
  return readScene(unwrapSceneEnvelope(raw), "Scene metadata is missing an id.");
}

/**
 * Normalize a scene payload. Prefer {@link normalizeSceneSummary} or
 * {@link normalizeSceneMetadata} at the route boundary. This entry point
 * accepts either of those contracts and the documented proto field names.
 */
export function normalizeScene(raw: unknown): HonuaScene {
  return readScene(unwrapSceneEnvelope(raw), "Scene response is missing an id.");
}

function tilesetEndpointUrl(endpoints: readonly HonuaSceneEndpoint[]): string | undefined {
  const match = endpoints.find((endpoint) => endpoint.kind === "3d-tiles" || endpoint.format === "3d-tiles");
  return match && isUsableSceneResourceUrl(match.url) ? match.url.trim() : undefined;
}

/**
 * Normalize `GET /api/scenes/{sceneId}/resolve`.
 * Reads `sceneId`, `endpoints`, and `auth`. The runtime tileset URL is the
 * response `tilesetUrl` when usable, otherwise the `3d-tiles` endpoint.
 */
export function normalizeSceneResolution(raw: unknown): HonuaSceneResolution {
  const record = asRecord(raw, "Scene resolution must be a JSON object.");
  const sceneId = requireSceneId(record, "Scene resolution is missing a sceneId.");
  const endpoints = readEndpoints(record.endpoints);
  const flat = readText(record.tilesetUrl) ?? readText(record.tileset_url);
  const tilesetUrl = (isUsableSceneResourceUrl(flat) ? flat.trim() : undefined) ?? tilesetEndpointUrl(endpoints);
  const auth = readAuth(record.auth) ?? { requiresAuthentication: false, schemes: [] };
  return {
    sceneId,
    ...(tilesetUrl !== undefined ? { tilesetUrl } : {}),
    endpoints,
    capabilities: readStringList(record.capabilities) ?? [],
    auth,
  };
}

/**
 * List the catalog of available 3D scenes from `GET /api/scenes`.
 * Returns the normalized {@link HonuaScene}s. A list item with no id throws;
 * it is not returned with an empty id.
 */
export async function listScenes(execute: SceneDiscoveryRequestExecutor, signal?: AbortSignal): Promise<HonuaScene[]> {
  const raw = await execute<unknown>("GET", SCENES_BASE_PATH, undefined, signal);
  const record = asRecord(raw, "Scene list response must be a JSON object.");
  if (!Array.isArray(record.scenes)) {
    throw new Error("Scene list response must contain a scenes array.");
  }
  return record.scenes.map((item) => normalizeSceneSummary(item));
}

/**
 * Fetch a single scene's metadata from `GET /api/scenes/{sceneId}`.
 * Fails closed before the request when `sceneId` is empty.
 */
export async function getScene(
  execute: SceneDiscoveryRequestExecutor,
  sceneId: string,
  signal?: AbortSignal,
): Promise<HonuaScene> {
  if (typeof sceneId !== "string" || sceneId.trim() === "") {
    throw new Error("getScene requires a non-empty sceneId.");
  }
  const raw = await execute<unknown>(
    "GET",
    `${SCENES_BASE_PATH}/${encodeURIComponent(sceneId.trim())}`,
    undefined,
    signal,
  );
  return normalizeSceneMetadata(raw);
}

/**
 * Resolve a scene's runtime endpoints from `GET /api/scenes/{sceneId}/resolve`.
 * Fails closed before the request when `sceneId` is empty. The returned
 * `tilesetUrl` is taken from the server payload only.
 */
export async function resolveScene(
  execute: SceneDiscoveryRequestExecutor,
  sceneId: string,
  signal?: AbortSignal,
): Promise<HonuaSceneResolution> {
  if (typeof sceneId !== "string" || sceneId.trim() === "") {
    throw new Error("resolveScene requires a non-empty sceneId.");
  }
  const raw = await execute<unknown>(
    "GET",
    `${SCENES_BASE_PATH}/${encodeURIComponent(sceneId.trim())}/resolve`,
    undefined,
    signal,
  );
  return normalizeSceneResolution(raw);
}

/**
 * The scene's advertised 3D-Tiles entry-point URL, or `undefined` when the
 * scene has none. Does not synthesize a `/scenes/{id}/tileset.json` path.
 */
export function resolveSceneTilesetUrl(scene: HonuaScene): string | undefined {
  return isUsableSceneResourceUrl(scene.tilesetUrl) ? scene.tilesetUrl.trim() : undefined;
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
export function sceneTilesetPrimitive(scene: HonuaScene): SceneModelLayerPrimitive | undefined {
  const uri = resolveSceneTilesetUrl(scene);
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
  if (!isUsableSceneResourceUrl(scene.terrainUrl)) return undefined;
  return {
    kind: "elevation-source",
    id: `${scene.sceneId}:terrain`,
    sourceId: `${scene.sceneId}:terrain`,
    protocol: "quantized-mesh",
    url: scene.terrainUrl.trim(),
  };
}

/**
 * Map a discovered scene onto the renderer-neutral primitives the Cesium
 * adapter renders: an initial-camera primitive, the terrain elevation source
 * (when present), and the 3D-Tiles tileset (when the scene advertises a URL).
 * Pure; the result feeds straight into `applyCesiumScenePrimitives` / a `SceneView`.
 */
export function sceneToRuntimePrimitives(
  scene: HonuaScene,
): Array<SceneCameraPrimitive | SceneElevationSourcePrimitive | SceneModelLayerPrimitive> {
  const primitives: Array<SceneCameraPrimitive | SceneElevationSourcePrimitive | SceneModelLayerPrimitive> = [];
  const camera = sceneCameraPrimitive(scene);
  if (camera) primitives.push(camera);
  const terrain = sceneTerrainPrimitive(scene);
  if (terrain) primitives.push(terrain);
  const tileset = sceneTilesetPrimitive(scene);
  if (tileset) primitives.push(tileset);
  return primitives;
}

/**
 * Build the workspace layer states for a discovered scene (one per rendered
 * primitive), so a {@link module:scene-workspace/workspace.SceneWorkspace} can
 * seed its layer list from the scene. Pure.
 */
export function sceneLayerStates(scene: HonuaScene): SceneLayerState[] {
  const layers: SceneLayerState[] = [];
  if (sceneTilesetPrimitive(scene)) {
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
