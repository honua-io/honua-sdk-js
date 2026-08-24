/**
 * Cesium 3D `SceneRuntimeAdapter` for the renderer-neutral scene workspace.
 *
 * This module deliberately keeps the camera-state mapping pure and free of any
 * static Cesium import so that 2D-only consumers never pay the CesiumJS bundle
 * cost. The CesiumJS runtime is only pulled in lazily (`await import("cesium")`)
 * when a live {@link CesiumSceneRuntimeTarget} is actually driven.
 *
 * As of honua-server#1197 the adapter renders Honua 3D content end-to-end:
 * 3D-Tiles tilesets (add/remove/visibility, including point clouds with bounded
 * shading), terrain providers (quantized-mesh via `CesiumTerrainProvider`, with
 * vertical exaggeration), imagery providers, and glTF/GLB model layers placed
 * with heading/pitch/roll + scale. It also resolves a picked 3D-Tiles feature's
 * attributes (batch properties / `EXT_structural_metadata`).
 *
 * Every model/imagery binding is validated before the peer loads, so an
 * unrenderable primitive fails closed with a stable diagnostic instead of
 * reaching a Cesium factory or silently rendering nothing.
 *
 * The provider wiring is still kept Cesium-mockable: every CesiumJS symbol the
 * adapter touches is read off the lazily-imported module, so the wiring is
 * exercised against a `vi.mock("cesium")` stub without a live WebGL `Viewer`.
 *
 * @beta Part of the beta `@honua/app-platform/scene-workspace` surface: the
 *   adapter's exports are not renamed or removed through 0.1.x, and diagnostic
 *   codes and renderer capability flags grow additively. The `cesium` peer floor
 *   may rise within 0.1.x, and the server-authored 3D style types track the
 *   Honua Server styling contract. See the surface tiers table in
 *   `docs/standalone-capability-matrix.md`.
 * @module
 */

import {
  type CesiumClockTarget,
  type CesiumSceneTimeApplication,
  applyCesiumSceneTime,
  restoreCesiumClock,
} from "./cesium-time.js";
import {
  RENDERER_WGS84_SPATIAL_CAPABILITIES,
  type SceneElevationSourcePrimitive,
  type SceneImageryLayerPrimitive,
  type SceneModelLayerPrimitive,
  type ScenePrimitiveApplyResult,
  type ScenePrimitiveDiagnostic,
  type ScenePrimitiveStatus,
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
 * heading/pitch/roll/height, quantized-mesh terrain, and model layers for 3D
 * Tiles / glTF / I3S / point clouds. Other terrain protocols remain valid
 * renderer-neutral primitive vocabulary but are not materialized by this
 * adapter.
 */
export const CESIUM_SCENE_CAPABILITIES: SceneRuntimeCapabilities = {
  renderer: "cesium",
  camera: true,
  ground: true,
  terrain: {
    protocols: ["quantized-mesh"],
    supportsExaggeration: true,
  },
  imagery: {
    protocols: ["url-template", "wms", "wmts", "single-tile", "arcgis-imagery"],
  },
  extrusion: true,
  modelLayer: {
    // CesiumJS itself can consume all four formats. `materializedFormats` is the
    // narrower set this adapter actually attaches to a live scene: glTF/GLB
    // single models and 3D-Tiles tilesets (point clouds ride the tileset path).
    // I3S stays declared-capable but unmaterialized, so an i3s primitive fails
    // closed with `scene-primitive-model-format-not-materialized` instead of
    // reporting `supported` and then rendering nothing.
    formats: ["gltf", "glb", "3d-tiles", "i3s"],
    materializedFormats: ["gltf", "glb", "3d-tiles"],
  },
  sceneLayerMetadata: true,
  // The globe is the WGS84 ellipsoid. Web Mercator bindings are accepted
  // because Cesium reprojects them onto that globe itself; nothing else is,
  // because this adapter never reinterprets coordinates or heights.
  spatial: RENDERER_WGS84_SPATIAL_CAPABILITIES,
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
  /**
   * `orientation` is `unknown` rather than a heading/pitch/roll record because
   * the real `Camera.setView` also accepts a direction/up pair. Narrowing it
   * here made a live `Camera` fail to satisfy this interface, which is the one
   * thing it exists to describe (#1049); callers still build the orientation
   * through the typed {@link CesiumHeadingPitchRollRadians}.
   */
  setView(options: { destination?: unknown; orientation?: unknown }): void;
}

/**
 * A 3D-Tiles tileset handle (the bits the adapter mutates). Real Cesium
 * `Cesium3DTileset` instances satisfy this; tests pass a plain object.
 *
 * `extras` mirrors Cesium's `Cesium3DTileset.extras` — the parsed `extras`
 * object from the tileset.json root, available once the tileset is ready. The
 * server advertises its attribute-driven styling there under `honua_style`
 * (honua-server#1206). `style` is the settable `Cesium3DTileStyle` slot.
 */
export interface CesiumTilesetLike {
  show: boolean;
  modelMatrix?: unknown;
  extras?: unknown;
  style?: unknown;
  destroy?(): void;
  isDestroyed?(): boolean;
}

/**
 * A glTF/GLB model handle (the bits the adapter mutates). Real Cesium `Model`
 * instances satisfy this.
 *
 * `color` is Cesium's per-model blend color; its alpha channel is how a `Model`
 * expresses opacity, which is what backs {@link CesiumLayerHandle.setOpacity}
 * on the glTF/GLB path.
 */
export interface CesiumModelLike {
  show: boolean;
  modelMatrix?: unknown;
  color?: unknown;
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

export interface CesiumImageryProviderLike {
  destroy?(): void;
  isDestroyed?(): boolean;
}

export interface CesiumImageryLayerLike {
  show: boolean;
  alpha: number;
  destroy?(): void;
  isDestroyed?(): boolean;
}

export interface CesiumImageryLayerCollectionLike {
  addImageryProvider(provider: CesiumImageryProviderLike, index?: number): CesiumImageryLayerLike;
  remove(layer: CesiumImageryLayerLike, destroy?: boolean): boolean;
  contains(layer: CesiumImageryLayerLike): boolean;
}

/**
 * The Cesium `Scene` surface the adapter mutates: primitive and imagery
 * collections, a settable `terrainProvider`, vertical exaggeration, and a
 * `pick` entry point used by {@link pickCesiumFeatureAttributes}.
 */
export interface CesiumSceneLike {
  readonly primitives: CesiumPrimitiveCollectionLike;
  readonly imageryLayers?: CesiumImageryLayerCollectionLike;
  terrainProvider?: unknown;
  verticalExaggeration?: number;
  pick?(windowPosition: unknown, width?: number, height?: number): unknown;
}

interface CesiumTerrainProviderLike {
  destroy?(): void;
}

/**
 * The subset of a live Cesium `Viewer`/`Scene` the adapter drives. Supplying
 * this is optional: an adapter created without a target still diagnoses
 * primitives and performs pure camera math, it just cannot mutate a live globe.
 *
 * `scene` is optional so a camera-only target (as shipped in #1196) keeps
 * working unchanged; layer rendering simply no-ops without it.
 *
 * `clock` (from {@link CesiumClockTarget}) is the opt-in for application-time
 * binding: supply `viewer.clock` and the adapter drives it from the workspace
 * `timeline` slice; omit it and no clock is ever touched. See
 * `docs/scene-workspace.md` for the ownership contract.
 */
export interface CesiumSceneRuntimeTarget extends CesiumClockTarget {
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
 *
 * `setOpacity` is present only where the underlying Cesium object exposes an
 * alpha channel the adapter owns: imagery layers (`ImageryLayer.alpha`) and
 * glTF/GLB models (`Model.color` alpha). A `Cesium3DTileset` has no tileset-wide
 * alpha — tileset translucency is a `Cesium3DTileStyle` concern owned by the
 * server styling contract — so tileset handles deliberately omit it rather than
 * clobbering an applied style. Callers must feature-detect.
 */
export interface CesiumLayerHandle {
  readonly id: string;
  readonly kind: "model-layer" | "elevation-source" | "imagery-layer";
  readonly format?: SceneModelLayerPrimitive["format"];
  readonly protocol?: SceneImageryLayerPrimitive["protocol"];
  setVisible(visible: boolean): void;
  setOpacity?(opacity: number): void;
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
  readonly Cesium3DTileStyle: new (style?: Record<string, unknown>) => unknown;
  readonly Color: {
    readonly WHITE: { withAlpha(alpha: number): unknown };
  };
  readonly Model: {
    fromGltfAsync(options: Record<string, unknown>): Promise<CesiumModelLike>;
  };
  readonly CesiumTerrainProvider: {
    fromUrl(url: string, options?: Record<string, unknown>): Promise<CesiumTerrainProviderLike>;
  };
  /**
   * Optional on purpose: only the clock binding reads it, and a peer without it
   * degrades to `scene-time-runtime-unavailable` instead of throwing, so a
   * plan-only application never depends on it.
   */
  readonly JulianDate?: {
    fromIso8601(value: string): unknown;
  };
  readonly UrlTemplateImageryProvider: new (options: Record<string, unknown>) => CesiumImageryProviderLike;
  readonly WebMapServiceImageryProvider: new (options: Record<string, unknown>) => CesiumImageryProviderLike;
  readonly WebMapTileServiceImageryProvider: new (options: Record<string, unknown>) => CesiumImageryProviderLike;
  readonly SingleTileImageryProvider: {
    fromUrl(url: string, options?: Record<string, unknown>): Promise<CesiumImageryProviderLike>;
  };
  readonly ArcGisMapServerImageryProvider: {
    fromUrl(url: string, options?: Record<string, unknown>): Promise<CesiumImageryProviderLike>;
  };
};

const ownedCesiumTerrainProviders = new WeakSet<object>();

function disposeOwnedCesiumTerrainProvider(resource: unknown): void {
  if (resource && typeof resource === "object" && ownedCesiumTerrainProviders.has(resource)) {
    const destroy = (resource as { destroy?: unknown }).destroy;
    if (typeof destroy === "function") {
      destroy.call(resource);
      ownedCesiumTerrainProviders.delete(resource);
    }
  }
}

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
 * A condition block of a 3D-Tiles styling expression. Each entry is an
 * `[expression, result]` pair evaluated in priority order, where `expression`
 * is a Cesium styling-language string (`${attr}` references feature attributes)
 * and `result` is the value applied when the expression is the first to match.
 * A trailing `["true", <default>]` entry supplies the fallback.
 *
 * This is shaped EXACTLY as a CesiumJS `Cesium3DTileStyle` `color`/`show`
 * block, so a spec can be handed straight to `new Cesium3DTileStyle({ ... })`.
 */
export interface Honua3DStyleConditions {
  readonly conditions: ReadonlyArray<readonly [string, string]>;
}

/**
 * The attribute-driven 3D-Tiles styling contract the Honua server emits as a
 * `style.json` sidecar next to `tileset.json` (honua-server#1206). The server
 * advertises it in the tileset's root `extras.honua_style`; the `style.color`
 * / `style.show` blocks are pre-shaped for `Cesium3DTileStyle`.
 *
 * `style.color` and `style.show` are each optional — when a block is omitted
 * the corresponding aspect of the Cesium style is left untouched.
 */
export interface Honua3DStyleSpec {
  readonly encoding: "3d-tiles-styling";
  readonly version: string;
  readonly defaultMaterial?: {
    readonly color?: string;
    readonly opacity?: number;
  };
  readonly style: {
    readonly color?: Honua3DStyleConditions;
    readonly show?: Honua3DStyleConditions;
  };
}

/**
 * The descriptor the server places at `extras.honua_style` on the tileset.json
 * root to advertise its styling sidecar. `uri` is RELATIVE to the tileset.json
 * URL and is resolved against the tileset's base URL before fetching.
 */
export interface Honua3DStyleDescriptor {
  readonly encoding: "3d-tiles-styling";
  readonly version: string;
  readonly uri: string;
}

/**
 * Read the `honua_style` descriptor off a tileset's (or tileset.json's)
 * `extras`, if present and well-formed. Returns `undefined` when the tileset
 * carries no Honua styling metadata (the common case for plain tilesets), so
 * the auto-apply path can no-op silently.
 */
export function readHonua3DStyleDescriptor(extras: unknown): Honua3DStyleDescriptor | undefined {
  if (extras === null || typeof extras !== "object") return undefined;
  const candidate = (extras as { honua_style?: unknown }).honua_style;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const descriptor = candidate as { encoding?: unknown; version?: unknown; uri?: unknown };
  if (descriptor.encoding !== "3d-tiles-styling") return undefined;
  if (typeof descriptor.uri !== "string" || descriptor.uri.trim() === "") return undefined;
  return {
    encoding: "3d-tiles-styling",
    version: typeof descriptor.version === "string" ? descriptor.version : "1.0",
    uri: descriptor.uri,
  };
}

/**
 * Resolve a sidecar `uri` (relative, per the contract) against the
 * `tileset.json` URL it was advertised in. Falls back to returning the raw
 * `uri` unchanged when `tilesetUrl` is not a parseable absolute/base URL (e.g.
 * a bare relative path in a test), which keeps a plain `fetch` workable.
 */
export function resolveHonua3DStyleUri(uri: string, tilesetUrl: string): string {
  try {
    return new URL(uri, tilesetUrl).toString();
  } catch {
    return uri;
  }
}

/**
 * Fetch + parse the `style.json` sidecar at `styleUrl`.
 *
 * The sidecar is a STATIC asset served next to `tileset.json` (not a Honua API
 * call), so it is fetched with a plain global `fetch` rather than routed
 * through the SDK's authenticated request path — this keeps the styling module
 * free of a client dependency and mirrors how Cesium itself loads tileset
 * assets. A custom `fetchImpl` can be injected (tests pass a mock).
 */
export async function fetchHonua3DStyleSpec(
  styleUrl: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<Honua3DStyleSpec> {
  const response = await fetchImpl(styleUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Honua 3D style "${styleUrl}": ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Honua3DStyleSpec;
}

/**
 * Discover and load the Honua 3D styling spec advertised by a tileset.
 *
 * Reads `extras.honua_style` (off either a loaded `Cesium3DTileset` or a parsed
 * tileset.json `extras` object), resolves the sidecar `uri` against
 * `tilesetUrl`, and fetches the `style.json`. Returns `undefined` when the
 * tileset advertises no Honua styling, so callers can treat "no style" as a
 * silent no-op rather than an error.
 */
export async function loadHonua3DStyle(
  extras: unknown,
  tilesetUrl: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<Honua3DStyleSpec | undefined> {
  const descriptor = readHonua3DStyleDescriptor(extras);
  if (!descriptor) return undefined;
  const styleUrl = resolveHonua3DStyleUri(descriptor.uri, tilesetUrl);
  return fetchHonua3DStyleSpec(styleUrl, fetchImpl);
}

/**
 * Build a Cesium `Cesium3DTileStyle` options object from a spec, including only
 * the blocks (`color` / `show`) that are present. The spec's blocks are already
 * `Cesium3DTileStyle`-shaped, so they are passed through verbatim. Pure (no
 * Cesium import) so the block-selection logic is unit-testable.
 */
export function honua3DStyleToCesiumStyleOptions(spec: Honua3DStyleSpec): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (spec.style.color) options.color = spec.style.color;
  if (spec.style.show) options.show = spec.style.show;
  return options;
}

/**
 * Apply a Honua 3D styling spec to a tileset by constructing a
 * `Cesium3DTileStyle` (only from the present `color` / `show` blocks) and
 * assigning it to `tileset.style`. Lazily loads Cesium the same way the rest of
 * the adapter does, so no static `import("cesium")` leaks into the 2D bundle.
 *
 * When the spec carries neither a `color` nor a `show` block, the tileset's
 * `style` is left untouched (nothing to apply).
 */
export async function applyHonua3DStyle(
  tileset: CesiumTilesetLike,
  spec: Honua3DStyleSpec,
  cesium?: CesiumModule,
): Promise<void> {
  const options = honua3DStyleToCesiumStyleOptions(spec);
  if (Object.keys(options).length === 0) return;
  const mod = cesium ?? (await loadCesium());
  tileset.style = new mod.Cesium3DTileStyle(options);
}

/**
 * Programmatic override for a tileset's styling: apply a (typically
 * server-discovered, but possibly hand-authored) {@link Honua3DStyleSpec} to a
 * live tileset. Thin alias over {@link applyHonua3DStyle} that reads as an
 * intentional manual set at the call site.
 */
export function setTilesetStyle(
  tileset: CesiumTilesetLike,
  spec: Honua3DStyleSpec,
  cesium?: CesiumModule,
): Promise<void> {
  return applyHonua3DStyle(tileset, spec, cesium);
}

/**
 * Discover and apply the server's attribute-driven styling to an already-loaded
 * tileset, if it advertises any (`extras.honua_style`). Returns the applied
 * spec (or `undefined` when the tileset carries no Honua styling). Used by
 * {@link addCesium3DTileset}'s auto-apply path and exposed for callers that
 * load a tileset themselves.
 */
export async function applyTilesetServerStyle(
  tileset: CesiumTilesetLike,
  tilesetUrl: string,
  cesium?: CesiumModule,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<Honua3DStyleSpec | undefined> {
  const spec = await loadHonua3DStyle(tileset.extras, tilesetUrl, fetchImpl);
  if (!spec) return undefined;
  await applyHonua3DStyle(tileset, spec, cesium);
  return spec;
}

/**
 * Cancellation shared by every adapter entry point that materializes a live
 * renderer resource.
 *
 * The Cesium asset factories (`Cesium3DTileset.fromUrl`, `Model.fromGltfAsync`,
 * `SingleTileImageryProvider.fromUrl`, …) take no `AbortSignal`, so a load that
 * is already in flight cannot be stopped at the peer. What the signal *does*
 * guarantee is the half that matters for teardown: an aborted load is never
 * attached to the scene, and the resource it resolved to is destroyed before the
 * rejection propagates. Nothing is stranded in a scene the host has abandoned.
 */
export interface CesiumSceneMaterializationOptions {
  /** Abort the materialization. Checked before the load starts and again before the resource is attached. */
  readonly signal?: AbortSignal;
}

/**
 * Options controlling {@link addCesium3DTileset}.
 */
export interface AddCesium3DTilesetOptions extends CesiumSceneMaterializationOptions {
  /**
   * When `true` (the default), a tileset that advertises Honua styling metadata
   * (`extras.honua_style`) has its `style.json` sidecar fetched and applied
   * automatically after the tileset loads. Set to `false` to add the tileset
   * unstyled (e.g. to apply a custom style via {@link setTilesetStyle}).
   */
  readonly applyServerStyle?: boolean;
  /**
   * Override the `fetch` used to load the styling sidecar. Defaults to the
   * global `fetch`. Primarily a test seam.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Materialize a 3D-Tiles tileset from a model-layer primitive and add it to the
 * scene's primitive collection, returning a handle for later visibility /
 * teardown. Exported so consumers (and tests) can drive a single tileset.
 *
 * If the loaded tileset advertises the server's attribute-driven styling
 * contract (`extras.honua_style`, honua-server#1206) the sidecar style is
 * fetched and applied automatically (honua-server#1206). Pass
 * `{ applyServerStyle: false }` to skip that and style the tileset manually via
 * {@link setTilesetStyle}. A tileset without `honua_style` is added unchanged
 * (no fetch), so existing callers are unaffected.
 */
export async function addCesium3DTileset(
  scene: CesiumSceneLike,
  primitive: SceneModelLayerPrimitive,
  cesium?: CesiumModule,
  options: AddCesium3DTilesetOptions = {},
): Promise<CesiumLayerHandle> {
  assertRenderableModelLayer(primitive);
  options.signal?.throwIfAborted();
  const mod = cesium ?? (await loadCesium());
  const pointCloudShading = normalizePointCloudShading(primitive.pointCloudShading);
  // Attribution reaches every materialized asset, not just imagery (#1049
  // REQ-005): a tileset drawn without its credit is an attribution gap the user
  // cannot see, and Cesium's `CreditDisplay` is the only place it can land.
  const tilesetOptions = {
    ...(pointCloudShading ? { pointCloudShading } : {}),
    ...(primitive.attribution ? { credit: primitive.attribution } : {}),
  };
  const tileset = await (Object.keys(tilesetOptions).length > 0
    ? mod.Cesium3DTileset.fromUrl(primitive.uri, tilesetOptions)
    : mod.Cesium3DTileset.fromUrl(primitive.uri));
  // From here on the tileset is adapter-owned. A placement, style-sidecar, or
  // collection failure must not strand it: nothing else holds a reference, so
  // it would otherwise retain its GPU/worker resources for the process lifetime.
  // An abort settled while the load was in flight lands here too, which is what
  // keeps a cancelled tileset out of the scene entirely rather than attached and
  // then detached.
  try {
    options.signal?.throwIfAborted();
    if (primitive.position) {
      tileset.modelMatrix = placementToModelMatrix(mod, modelLayerToCesiumPlacement(primitive));
    }
    if (options.applyServerStyle !== false) {
      await applyTilesetServerStyle(tileset, primitive.uri, mod, options.fetchImpl ?? fetch.bind(globalThis));
      options.signal?.throwIfAborted();
    }
    scene.primitives.add(tileset);
  } catch (error) {
    if (scene.primitives.contains(tileset)) scene.primitives.remove(tileset);
    destroyOwnedCesiumPrimitive(tileset);
    throw error;
  }
  return makeLayerHandle(scene, primitive.id, tileset, primitive.format);
}

/**
 * Materialize a glTF/GLB model from a model-layer primitive, placing it at the
 * primitive's position/rotation/scale, and add it to the scene. Returns a
 * handle for visibility / opacity / teardown.
 */
export async function addCesiumModel(
  scene: CesiumSceneLike,
  primitive: SceneModelLayerPrimitive,
  cesium?: CesiumModule,
  options: CesiumSceneMaterializationOptions = {},
): Promise<CesiumLayerHandle> {
  assertRenderableModelLayer(primitive);
  options.signal?.throwIfAborted();
  const mod = cesium ?? (await loadCesium());
  const placement = modelLayerToCesiumPlacement(primitive);
  // `placementToModelMatrix` already folds the uniform scale into the model
  // matrix (alongside translation + rotation). Cesium applies `Model.scale` on
  // top of `modelMatrix`, so passing it here too would square the scale
  // (requested 3 → rendered 9). Apply it exactly once, via the matrix.
  const model = await mod.Model.fromGltfAsync({
    url: primitive.uri,
    modelMatrix: placementToModelMatrix(mod, placement),
    ...(primitive.attribution ? { credit: primitive.attribution } : {}),
  });
  try {
    options.signal?.throwIfAborted();
    scene.primitives.add(model);
  } catch (error) {
    destroyOwnedCesiumPrimitive(model);
    throw error;
  }
  return makeLayerHandle(scene, primitive.id, model, primitive.format, mod);
}

/**
 * Destroy an adapter-owned tileset/model exactly once. Cesium's
 * `PrimitiveCollection.remove` normally destroys what it removes, but a
 * collection configured with `destroyPrimitives = false` — and any failure
 * before the primitive reaches a collection at all — would otherwise leak it.
 */
function destroyOwnedCesiumPrimitive(primitive: CesiumTilesetLike | CesiumModelLike): void {
  if (typeof primitive.destroy === "function" && primitive.isDestroyed?.() !== true) primitive.destroy();
}

/**
 * Fail closed on an unrenderable model layer *before* the optional Cesium peer
 * is loaded, mirroring {@link addCesiumImageryLayer}. A missing/invalid/signed
 * asset URI, an impossible placement, or out-of-range point-cloud shading must
 * never reach a Cesium factory: `Cesium3DTileset.fromUrl("")` throws opaquely
 * and `Cartesian3.fromDegrees(NaN, …)` produces a silently broken model matrix.
 */
function assertRenderableModelLayer(primitive: SceneModelLayerPrimitive): void {
  const validation = diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES).find(
    (diagnostic) => diagnostic.status === "unsupported",
  );
  if (validation) throw new Error(`${validation.code}: ${validation.message}`);
}

/**
 * Fail closed on an unrenderable elevation source *before* the scene's terrain
 * provider or vertical exaggeration is touched, mirroring
 * {@link assertRenderableModelLayer}.
 *
 * Only quantized mesh reaches Cesium through `CesiumTerrainProvider.fromUrl`.
 * Other protocols fail against the adapter capability contract here, before
 * the optional peer is loaded. A malformed endpoint or an elevation source in
 * an unhonorable CRS/vertical datum likewise must not reach a live scene.
 */
function assertRenderableTerrain(primitive: SceneElevationSourcePrimitive): void {
  const validation = diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES).find(
    (diagnostic) => diagnostic.status === "unsupported",
  );
  if (validation) throw new Error(`${validation.code}: ${validation.message}`);
}

/**
 * Project validated point-cloud shading onto Cesium's `PointCloudShading`
 * option bag, dropping absent fields so Cesium keeps its own defaults instead
 * of receiving explicit `undefined`s. Returns `undefined` when nothing is set.
 */
function normalizePointCloudShading(
  shading: SceneModelLayerPrimitive["pointCloudShading"],
): Record<string, boolean | number> | undefined {
  if (!shading) return undefined;
  const options: Record<string, boolean | number> = {};
  if (shading.attenuation !== undefined) options.attenuation = shading.attenuation;
  if (shading.maximumAttenuation !== undefined) options.maximumAttenuation = shading.maximumAttenuation;
  if (shading.geometricErrorScale !== undefined) options.geometricErrorScale = shading.geometricErrorScale;
  if (shading.eyeDomeLighting !== undefined) options.eyeDomeLighting = shading.eyeDomeLighting;
  if (shading.eyeDomeLightingStrength !== undefined) {
    options.eyeDomeLightingStrength = shading.eyeDomeLightingStrength;
  }
  if (shading.eyeDomeLightingRadius !== undefined) options.eyeDomeLightingRadius = shading.eyeDomeLightingRadius;
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Materialize one renderer-neutral imagery primitive through Cesium's matching
 * provider and add it to the scene's imagery collection.
 *
 * The returned handle owns the provider and layer it creates. Removal is
 * idempotent, releases the layer's GPU resources through Cesium, and calls an
 * optional provider `destroy()` exactly once.
 */
export async function addCesiumImageryLayer(
  scene: CesiumSceneLike,
  primitive: SceneImageryLayerPrimitive,
  cesium?: CesiumModule,
  options: CesiumSceneMaterializationOptions = {},
): Promise<CesiumLayerHandle> {
  const validation = diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES).find(
    (diagnostic) => diagnostic.status === "unsupported",
  );
  if (validation) throw new Error(`${validation.code}: ${validation.message}`);
  if (!scene.imageryLayers) {
    throw new Error("scene-primitive-imagery-target-missing: Cesium imageryLayers unavailable.");
  }
  options.signal?.throwIfAborted();

  const mod = cesium ?? (await loadCesium());
  const provider = await createCesiumImageryProvider(primitive, mod);
  let layer: CesiumImageryLayerLike | undefined;
  try {
    options.signal?.throwIfAborted();
    layer = scene.imageryLayers.addImageryProvider(provider);
    layer.alpha = primitive.opacity ?? 1;
  } catch (error) {
    if (layer && scene.imageryLayers.contains(layer)) scene.imageryLayers.remove(layer, true);
    disposeCesiumImageryProvider(provider);
    throw error;
  }
  let removed = false;
  return {
    id: primitive.id,
    kind: "imagery-layer",
    protocol: primitive.protocol,
    setVisible(visible: boolean) {
      if (!removed) layer.show = visible;
    },
    setOpacity(opacity: number) {
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        throw new RangeError("Imagery opacity must be a finite number between 0 and 1.");
      }
      if (!removed) layer.alpha = opacity;
    },
    remove() {
      if (removed) return;
      removed = true;
      try {
        if (scene.imageryLayers?.contains(layer)) scene.imageryLayers.remove(layer, true);
      } finally {
        disposeCesiumImageryProvider(provider);
      }
    },
  };
}

function disposeCesiumImageryProvider(provider: CesiumImageryProviderLike): void {
  if (typeof provider.destroy === "function" && provider.isDestroyed?.() !== true) provider.destroy();
}

async function createCesiumImageryProvider(
  primitive: SceneImageryLayerPrimitive,
  cesium: CesiumModule,
): Promise<CesiumImageryProviderLike> {
  const commonOptions = {
    ...(primitive.attribution ? { credit: primitive.attribution } : {}),
    ...(primitive.minimumLevel !== undefined ? { minimumLevel: primitive.minimumLevel } : {}),
    ...(primitive.maximumLevel !== undefined ? { maximumLevel: primitive.maximumLevel } : {}),
  };
  switch (primitive.protocol) {
    case "url-template":
      return new cesium.UrlTemplateImageryProvider({
        url: urlWithServiceParameters(primitive.url, primitive.parameters),
        ...commonOptions,
        ...(primitive.subdomains ? { subdomains: primitive.subdomains } : {}),
      });
    case "wms":
      return new cesium.WebMapServiceImageryProvider({
        url: normalizedWmsUrl(primitive.url, primitive.parameters),
        layers: primitive.layer,
        ...commonOptions,
        ...(primitive.subdomains ? { subdomains: primitive.subdomains } : {}),
        ...(primitive.parameters || primitive.format || primitive.style
          ? {
              parameters: normalizedWmsParameters(primitive.parameters, primitive.format, primitive.style),
            }
          : {}),
      });
    case "wmts":
      return new cesium.WebMapTileServiceImageryProvider({
        url: normalizedWmtsUrl(primitive.url, primitive.parameters),
        layer: primitive.layer,
        style: primitive.style,
        tileMatrixSetID: primitive.tileMatrixSetId,
        format: primitive.format ?? "image/png",
        ...commonOptions,
        ...(primitive.subdomains ? { subdomains: primitive.subdomains } : {}),
        ...(primitive.parameters ? { dimensions: primitive.parameters } : {}),
      });
    case "single-tile":
      return cesium.SingleTileImageryProvider.fromUrl(
        urlWithServiceParameters(resolveConfiguredSubdomainUrl(primitive), primitive.parameters),
        {
          ...(primitive.attribution ? { credit: primitive.attribution } : {}),
        },
      );
    case "arcgis-imagery":
      if (isArcGisImageServerUrl(primitive.url)) {
        return new cesium.UrlTemplateImageryProvider({
          url: arcGisImageServerExportUrl(primitive.url, primitive.parameters),
          ...commonOptions,
          ...(primitive.subdomains ? { subdomains: primitive.subdomains } : {}),
        });
      }
      return cesium.ArcGisMapServerImageryProvider.fromUrl(
        urlWithoutQueryKeys(
          resolveConfiguredSubdomainUrl(primitive),
          [...ARCGIS_IMAGE_SERVER_RESERVED_PARAMETERS, "layers", ...Object.keys(primitive.parameters ?? {})],
          true,
        ),
        {
          ...commonOptions,
          ...arcGisMapServerOptions(primitive.parameters),
        },
      );
  }
}

function resolveConfiguredSubdomainUrl(primitive: SceneImageryLayerPrimitive): string {
  const subdomain = primitive.subdomains?.[0];
  return subdomain === undefined ? primitive.url : primitive.url.replaceAll("{s}", subdomain);
}

function normalizedWmsUrl(url: string, parameters: SceneImageryLayerPrimitive["parameters"]): string {
  return urlWithoutQueryKeys(url, [...WMS_PROVIDER_QUERY_KEYS, ...Object.keys(parameters ?? {})]);
}

function normalizedWmtsUrl(url: string, parameters: SceneImageryLayerPrimitive["parameters"]): string {
  return urlWithoutQueryKeys(url, [...WMTS_PROVIDER_QUERY_KEYS, ...Object.keys(parameters ?? {})]);
}

function urlWithServiceParameters(url: string, parameters: SceneImageryLayerPrimitive["parameters"]): string {
  const entries = Object.entries(parameters ?? {});
  if (entries.length === 0) return url;
  const normalizedUrl = urlWithoutQueryKeys(
    url,
    entries.map(([key]) => key),
  );
  const hashIndex = normalizedUrl.indexOf("#");
  const withoutFragment = hashIndex === -1 ? normalizedUrl : normalizedUrl.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : normalizedUrl.slice(hashIndex);
  const encodedParameters = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${withoutFragment}${withoutFragment.includes("?") ? "&" : "?"}${encodedParameters}${fragment}`;
}

function urlWithoutQueryKeys(url: string, keys: readonly string[], canonical = false): string {
  const overriddenKeys = new Set(
    keys.map((key) => (canonical ? key.toLowerCase().replaceAll(/[^a-z0-9]/g, "") : key.toLowerCase())),
  );
  const hashIndex = url.indexOf("#");
  const withoutFragment = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : url.slice(hashIndex);
  const queryIndex = withoutFragment.indexOf("?");
  if (queryIndex === -1) return url;
  const endpoint = withoutFragment.slice(0, queryIndex);
  const query = withoutFragment.slice(queryIndex + 1);
  const preserved = query.split("&").filter((entry) => {
    if (entry === "") return false;
    const separatorIndex = entry.indexOf("=");
    const rawKey = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
    try {
      const decodedKey = decodeURIComponent(rawKey.replaceAll("+", " ")).toLowerCase();
      return !overriddenKeys.has(canonical ? decodedKey.replaceAll(/[^a-z0-9]/g, "") : decodedKey);
    } catch {
      return true;
    }
  });
  return `${endpoint}${preserved.length > 0 ? `?${preserved.join("&")}` : ""}${fragment}`;
}

function arcGisMapServerOptions(
  parameters: SceneImageryLayerPrimitive["parameters"],
): Readonly<Record<string, string | number | boolean>> {
  const options: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parameters ?? {})) {
    switch (key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")) {
      case "layers":
        options.layers = normalizeArcGisMapServerLayers(value);
        break;
      case "enablepickfeatures":
        options.enablePickFeatures = value;
        break;
      case "useprecachedtilesifavailable":
        options.usePreCachedTilesIfAvailable = value;
        break;
      case "tilewidth":
        options.tileWidth = value;
        break;
      case "tileheight":
        options.tileHeight = value;
        break;
    }
  }
  return options;
}

function normalizeArcGisMapServerLayers(value: string | number | boolean): string {
  const trimmed = String(value).trim();
  const layerList = trimmed.toLowerCase().startsWith("show:") ? trimmed.slice(5) : trimmed;
  return layerList
    .split(",")
    .map((layerId) => layerId.trim())
    .join(",");
}

function normalizedWmsParameters(
  parameters: SceneImageryLayerPrimitive["parameters"],
  format: SceneImageryLayerPrimitive["format"],
  style: SceneImageryLayerPrimitive["style"],
): Readonly<Record<string, string | number | boolean>> {
  const entries = Object.entries(parameters ?? {}).filter(
    ([key]) =>
      key.toLowerCase() !== "layers" &&
      (format === undefined || key.toLowerCase() !== "format") &&
      (style === undefined || key.toLowerCase() !== "styles"),
  );
  return {
    ...Object.fromEntries(entries),
    ...(format !== undefined ? { format } : {}),
    ...(style !== undefined ? { styles: style } : {}),
  };
}

function isArcGisImageServerUrl(url: string): boolean {
  const endpoint = url.split(/[?#]/, 1)[0] ?? "";
  return trimTrailingSlashes(endpoint).toLowerCase().endsWith("/imageserver");
}

function arcGisImageServerExportUrl(url: string, parameters: SceneImageryLayerPrimitive["parameters"]): string {
  const [withoutFragment] = url.split("#", 1);
  const queryIndex = withoutFragment.indexOf("?");
  const endpoint = trimTrailingSlashes(queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex));
  const existingQuery = queryIndex === -1 ? "" : withoutFragment.slice(queryIndex + 1);
  const primitiveParameters = new Map<string, readonly [string, string]>();
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (!ARCGIS_IMAGE_SERVER_RESERVED_PARAMETERS.has(key.toLowerCase())) {
      primitiveParameters.set(key.toLowerCase(), [key, String(value)]);
    }
  }
  const preservedParameters = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(existingQuery)) {
    const normalizedKey = key.toLowerCase();
    if (!ARCGIS_IMAGE_SERVER_RESERVED_PARAMETERS.has(normalizedKey) && !primitiveParameters.has(normalizedKey)) {
      preservedParameters.append(key, value);
    }
  }
  for (const [key, value] of primitiveParameters.values()) preservedParameters.set(key, value);
  const requestParameters = [
    "f=image",
    "bbox={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}",
    "bboxSR=3857",
    "imageSR=3857",
    "size={width}%2C{height}",
    "format=png32",
    "transparent=true",
  ];
  const preservedQuery = preservedParameters.toString();
  return `${endpoint}/exportImage?${preservedQuery ? `${preservedQuery}&` : ""}${requestParameters.join("&")}`;
}

const ARCGIS_IMAGE_SERVER_RESERVED_PARAMETERS = new Set([
  "f",
  "bbox",
  "bboxsr",
  "imagesr",
  "size",
  "format",
  "transparent",
]);
const WMS_PROVIDER_QUERY_KEYS = [
  "bbox",
  "crs",
  "format",
  "height",
  "layers",
  "request",
  "service",
  "srs",
  "styles",
  "transparent",
  "version",
  "width",
] as const;
const WMTS_PROVIDER_QUERY_KEYS = [
  "format",
  "layer",
  "request",
  "service",
  "style",
  "tilecol",
  "tilematrix",
  "tilematrixset",
  "tilematrixsetid",
  "tilerow",
  "version",
] as const;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/**
 * Wire a terrain provider from an elevation-source primitive onto the scene.
 *
 * `quantized-mesh` maps to `CesiumTerrainProvider.fromUrl` natively. Raster DEM,
 * Terrain-RGB, ImageServer, and custom primitives fail closed in
 * {@link assertRenderableTerrain}; they are never reinterpreted as quantized
 * mesh. Exaggeration is applied via the scene's `verticalExaggeration`.
 */
export async function applyCesiumTerrain(
  scene: CesiumSceneLike,
  primitive: SceneElevationSourcePrimitive,
  cesium?: CesiumModule,
): Promise<CesiumLayerHandle | undefined> {
  return applyCesiumTerrainInternal(scene, primitive, cesium, true);
}

async function applyCesiumTerrainInternal(
  scene: CesiumSceneLike,
  primitive: SceneElevationSourcePrimitive,
  cesium: CesiumModule | undefined,
  disposePreviousProvider: boolean,
  signal?: AbortSignal,
): Promise<CesiumLayerHandle | undefined> {
  signal?.throwIfAborted();
  assertRenderableTerrain(primitive);
  const url = typeof primitive.url === "string" && primitive.url.trim() !== "" ? primitive.url : undefined;
  if (primitive.exaggeration !== undefined && Number.isFinite(primitive.exaggeration)) {
    scene.verticalExaggeration = primitive.exaggeration;
  }
  if (!url) return undefined;
  const mod = cesium ?? (await loadCesium());
  const provider = await mod.CesiumTerrainProvider.fromUrl(
    url,
    primitive.attribution ? { credit: primitive.attribution } : {},
  );
  if (provider && typeof provider === "object") ownedCesiumTerrainProviders.add(provider);
  if (signal?.aborted) {
    // The provider resolved into a scene the host has already abandoned. Release
    // it here rather than installing it and relying on a rollback to notice.
    disposeOwnedCesiumTerrainProvider(provider);
    signal.throwIfAborted();
  }
  const previousProvider = scene.terrainProvider;
  scene.terrainProvider = provider;
  if (disposePreviousProvider && previousProvider && previousProvider !== provider) {
    disposeOwnedCesiumTerrainProvider(previousProvider);
  }
  let removed = false;
  return {
    id: primitive.id,
    kind: "elevation-source",
    setVisible() {
      /* terrain is always on once set; visibility is a no-op for the provider. */
    },
    remove() {
      if (removed) return;
      // Only tear down if *this* handle's provider is still the active one. If a
      // newer elevation source has since replaced `scene.terrainProvider`,
      // removing this (now-stale) handle must be a no-op so we don't clobber the
      // active terrain/exaggeration.
      if (scene.terrainProvider !== provider) {
        disposeOwnedCesiumTerrainProvider(provider);
        removed = true;
        return;
      }
      scene.terrainProvider = undefined;
      scene.verticalExaggeration = 1;
      disposeOwnedCesiumTerrainProvider(provider);
      removed = true;
    },
  };
}

/**
 * Wrap an adapter-owned tileset/model in a bounded handle.
 *
 * Ownership rules mirror {@link addCesiumImageryLayer}: `remove()` is idempotent
 * and destroys the object exactly once (see
 * {@link destroyOwnedCesiumPrimitive}), and post-removal control calls are
 * no-ops rather than mutations of a destroyed object.
 *
 * `setOpacity` is only wired for glTF/GLB models, where `Model.color`'s alpha is
 * the adapter-owned opacity channel. Tilesets omit it — see
 * {@link CesiumLayerHandle}.
 */
function makeLayerHandle(
  scene: CesiumSceneLike,
  id: string,
  primitive: CesiumTilesetLike | CesiumModelLike,
  format: SceneModelLayerPrimitive["format"],
  cesium?: CesiumModule,
): CesiumLayerHandle {
  let removed = false;
  const model = cesium && (format === "gltf" || format === "glb") ? (primitive as CesiumModelLike) : undefined;
  return {
    id,
    kind: "model-layer",
    format,
    setVisible(visible: boolean) {
      if (!removed) primitive.show = visible;
    },
    ...(model && cesium
      ? {
          setOpacity(opacity: number) {
            if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
              throw new RangeError("Model opacity must be a finite number between 0 and 1.");
            }
            if (!removed) model.color = cesium.Color.WHITE.withAlpha(opacity);
          },
        }
      : {}),
    remove() {
      if (removed) return;
      removed = true;
      try {
        if (scene.primitives.contains(primitive)) scene.primitives.remove(primitive);
      } finally {
        destroyOwnedCesiumPrimitive(primitive);
      }
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
 *  - `imagery-layer` → a protocol-specific provider added to `scene.imageryLayers`.
 *  - `model-layer` (`3d-tiles`) → `Cesium3DTileset.fromUrl` added to
 *    `scene.primitives`; (`gltf`/`glb`) → `Model.fromGltfAsync` placed by
 *    position/rotation/scale.
 *
 * Returns the diagnostics plus the live layer handles keyed by primitive id so
 * callers can toggle visibility / tear layers down. Layer rendering is skipped
 * when no `scene` is attached or when a primitive diagnoses as unsupported —
 * and every skip is accounted for by a diagnostic, so nothing is silently
 * dropped. Point clouds ride the 3D-Tiles path with optional
 * `pointCloudShading`. I3S is declared-capable but unmaterialized, so it
 * diagnoses `scene-primitive-model-format-not-materialized`; extrusions remain
 * a MapLibre-path concern.
 *
 * As of #1048 `state` is load-bearing: its `timeline` slice is bound to the
 * target's clock when the host opted into one (see
 * {@link CesiumSceneRuntimeTarget}), and every arm — applied, host-owned,
 * unbound, uninterpretable — reports itself as a `scene-time-*` diagnostic.
 * Binding time constructs no renderer resource, so it never displaces a
 * primitive: the mount's reuse diff is untouched by a moving clock.
 */
export async function applyCesiumScenePrimitives(
  target: CesiumSceneRuntimeTarget,
  primitives: readonly SceneRuntimePrimitive[],
  state?: SceneWorkspaceState,
): Promise<ScenePrimitiveApplyResult & { readonly layers: ReadonlyMap<string, CesiumLayerHandle> }> {
  const application = await applyCesiumScenePrimitivesInternal(target, primitives, {
    ...(state ? { state } : {}),
  });
  return {
    status: application.status,
    diagnostics: application.diagnostics,
    layers: application.layers,
  };
}

/**
 * Stable identity of a scene primitive within one mount: its kind and id.
 *
 * Identity is deliberately kind-qualified. Two primitives of different kinds may
 * legitimately share an id (a terrain source and the imagery draped over it, for
 * instance), and they own different renderer resources, so they must never be
 * treated as revisions of one another.
 *
 * @internal
 */
export function scenePrimitiveMountKey(primitive: SceneRuntimePrimitive): string {
  return `${primitive.kind} ${primitive.id}`;
}

/**
 * A stable, order-independent fingerprint of a primitive's configuration, used
 * to decide whether a revised plan's primitive is the *same* binding as the one
 * already mounted.
 *
 * Returns `undefined` when the primitive cannot be fingerprinted deterministically
 * (a cycle, or a non-serializable value smuggled through `metadata`). An absent
 * fingerprint means "assume changed": the binding is rebuilt rather than reused,
 * which costs a rebuild but can never leave a stale renderer resource claiming to
 * satisfy a plan it no longer matches.
 *
 * @internal
 */
export function scenePrimitiveFingerprint(primitive: SceneRuntimePrimitive): string | undefined {
  try {
    return stableStringify(primitive, new Set<object>());
  } catch {
    return undefined;
  }
}

function stableStringify(value: unknown, seen: Set<object>): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Scene primitives must be serializable to be fingerprinted.");
  }
  if (typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  const container = value as object;
  if (seen.has(container)) throw new TypeError("Scene primitives must be acyclic to be fingerprinted.");
  seen.add(container);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry, seen)).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue, seen)}`).join(",")}}`;
  } finally {
    seen.delete(container);
  }
}

/**
 * Options for the internal apply engine that both {@link applyCesiumScenePrimitives}
 * and the mount lifecycle share.
 *
 * @internal
 */
export interface ApplyCesiumScenePrimitivesInternalOptions {
  /**
   * Cancels the application. Checked before the Cesium peer loads, between
   * primitives, and inside each materialization before its resource is attached.
   * An abort unwinds through the same rollback path as any other failure, so the
   * scene is left exactly as it was before the application started.
   */
  readonly signal?: AbortSignal;
  /**
   * Keys (see {@link scenePrimitiveMountKey}) whose primitive is unchanged since
   * the previous application. A present key is skipped entirely — no renderer
   * resource is constructed for it — and its value, when defined, is the live
   * handle carried forward into this application's result.
   */
  readonly reuse?: ReadonlyMap<string, CesiumLayerHandle | undefined>;
  /**
   * Workspace state applied alongside the plan. Only the `timeline` slice is
   * consumed here — it drives the target's clock when the host bound one. Time
   * is deliberately outside the plan, so it can never displace a mounted
   * binding.
   */
  readonly state?: SceneWorkspaceState;
}

/**
 * The outcome of one application: the diagnostics and layer handles that
 * {@link applyCesiumScenePrimitives} exposes, plus the per-key ownership record
 * and reuse accounting the mount lifecycle needs to diff the next revision.
 *
 * @internal
 */
export interface CesiumScenePrimitiveApplication {
  readonly status: ScenePrimitiveStatus;
  readonly diagnostics: readonly ScenePrimitiveDiagnostic[];
  readonly layers: ReadonlyMap<string, CesiumLayerHandle>;
  /** Every plan key mapped to the handle it owns (`undefined` for handle-less kinds). */
  readonly mounted: ReadonlyMap<string, CesiumLayerHandle | undefined>;
  /** Ids of primitives whose renderer resource was constructed by this application. */
  readonly created: readonly string[];
  /** Ids of primitives whose renderer resource was carried forward untouched. */
  readonly reused: readonly string[];
  /** What the workspace `timeline` slice did to the bound clock, if anything. */
  readonly time: CesiumSceneTimeApplication;
}

/**
 * The application engine behind both the one-shot
 * {@link applyCesiumScenePrimitives} and the {@link CesiumLayerHandle}-owning
 * mount lifecycle.
 *
 * Two properties hold regardless of how it is driven:
 *
 * - **Transactional.** Any failure — including an abort — removes every handle
 *   this application created, in reverse construction order, and restores the
 *   terrain provider, vertical exaggeration, and clock the scene had on entry.
 *   Handles carried in through `reuse` are never touched, so a failed revision
 *   leaves the previously applied plan intact.
 * - **Ownership-complete.** Every renderer resource it constructs is either
 *   returned in `mounted` or destroyed before the call returns. Nothing is
 *   reachable only from a discarded local.
 *
 * @internal
 */
export async function applyCesiumScenePrimitivesInternal(
  target: CesiumSceneRuntimeTarget,
  primitives: readonly SceneRuntimePrimitive[],
  options: ApplyCesiumScenePrimitivesInternalOptions = {},
): Promise<CesiumScenePrimitiveApplication> {
  const { signal, reuse, state } = options;
  signal?.throwIfAborted();
  const diagnostics = [...diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES)];
  const cesium = await loadCesium();
  signal?.throwIfAborted();
  // Time first: entity availability, time-dynamic tileset content, and clock-
  // driven properties are all evaluated against the clock, so a resource that
  // attaches below should attach under the application's own time rather than
  // under whatever instant the viewer happened to be showing.
  const time = applyCesiumSceneTime(target, state?.timeline, cesium);
  diagnostics.push(...time.diagnostics);
  const toCartesian = (longitude: number, latitude: number, height: number): unknown =>
    cesium.Cartesian3.fromDegrees(longitude, latitude, height);
  const unsupportedPrimitives = new Set(
    primitives.filter((primitive) =>
      diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES).some(
        (diagnostic) => diagnostic.status === "unsupported",
      ),
    ),
  );
  const layers = new Map<string, CesiumLayerHandle>();
  const mounted = new Map<string, CesiumLayerHandle | undefined>();
  const created: string[] = [];
  const reused: string[] = [];
  const appliedHandles: CesiumLayerHandle[] = [];
  const deferredTerrainProviders: unknown[] = [];
  const scene = target.scene;
  const originalTerrainProvider = scene?.terrainProvider;
  const originalVerticalExaggeration = scene?.verticalExaggeration;
  let terrainWasApplied = false;
  const registerHandle = (key: string, handle: CesiumLayerHandle): void => {
    appliedHandles.push(handle);
    layers.get(handle.id)?.remove();
    layers.set(handle.id, handle);
    mounted.set(key, handle);
    created.push(handle.id);
  };

  try {
    for (const primitive of primitives) {
      signal?.throwIfAborted();
      const key = scenePrimitiveMountKey(primitive);
      if (reuse?.has(key)) {
        // Unchanged since the last application: skip materialization entirely so
        // the live resource — and any visibility/opacity the host set on it —
        // survives the revision.
        const carried = reuse.get(key);
        mounted.set(key, carried);
        if (carried) {
          layers.set(carried.id, carried);
          reused.push(carried.id);
        }
        continue;
      }
      if (primitive.kind === "camera") {
        applyCameraStateToCesiumCamera(target.camera, primitive.camera, toCartesian);
        mounted.set(key, undefined);
        continue;
      }
      if (!scene || unsupportedPrimitives.has(primitive)) {
        mounted.set(key, undefined);
        continue;
      }

      if (primitive.kind === "elevation-source") {
        const previousProvider = scene.terrainProvider;
        terrainWasApplied = true;
        const handle = await applyCesiumTerrainInternal(scene, primitive, cesium, false, signal);
        if (handle) {
          if (previousProvider && previousProvider !== scene.terrainProvider) {
            deferredTerrainProviders.push(previousProvider);
          }
          registerHandle(key, handle);
        } else {
          mounted.set(key, undefined);
        }
        continue;
      }
      if (primitive.kind === "imagery-layer") {
        if (!scene.imageryLayers) {
          diagnostics.push({
            code: "scene-primitive-imagery-target-missing",
            severity: "error",
            status: "unsupported",
            primitiveId: primitive.id,
            primitiveKind: primitive.kind,
            renderer: "cesium",
            message: "Cesium imageryLayers unavailable.",
            fallback: "Attach a complete Cesium scene target before applying imagery.",
          });
          mounted.set(key, undefined);
          continue;
        }
        registerHandle(key, await addCesiumImageryLayer(scene, primitive, cesium, { ...(signal ? { signal } : {}) }));
        continue;
      }
      if (primitive.kind === "model-layer") {
        // Only materialized formats reach here: anything else already diagnosed
        // as unsupported above and was filtered into `unsupportedPrimitives`.
        const materializationOptions = { ...(signal ? { signal } : {}) };
        if (primitive.format === "3d-tiles") {
          registerHandle(key, await addCesium3DTileset(scene, primitive, cesium, materializationOptions));
        } else {
          registerHandle(key, await addCesiumModel(scene, primitive, cesium, materializationOptions));
        }
        continue;
      }
      mounted.set(key, undefined);
    }
    signal?.throwIfAborted();
    for (const provider of [...deferredTerrainProviders].reverse()) disposeOwnedCesiumTerrainProvider(provider);
  } catch (cause) {
    const rollbackErrors: unknown[] = [];
    for (const handle of appliedHandles.reverse()) {
      try {
        handle.remove();
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (scene && terrainWasApplied) {
      try {
        scene.terrainProvider = originalTerrainProvider;
        scene.verticalExaggeration = originalVerticalExaggeration;
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (target.clock && time.previous) {
      try {
        restoreCesiumClock(target.clock, time.previous);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [cause, ...rollbackErrors],
        "Cesium scene primitive application failed and layer rollback was incomplete.",
        { cause },
      );
    }
    throw cause;
  }

  return {
    status: summarizeDiagnosticStatus(diagnostics),
    diagnostics,
    layers,
    mounted,
    created,
    reused,
    time,
  };
}

/**
 * Create a {@link SceneRuntimeAdapter} backed by CesiumJS.
 *
 * When `options.target` (a live Cesium `Viewer`/`Scene` surface — a `camera`
 * plus an optional `scene` and an optional `clock`) is supplied, `apply` drives
 * the live globe: camera sync plus, when a `scene` is attached, terrain and
 * imagery providers, 3D-Tiles tilesets, and glTF/GLB model layers, and, when a
 * `clock` is attached, the workspace `timeline` slice. Without a target the adapter still
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
