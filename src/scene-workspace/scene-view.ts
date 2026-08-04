/**
 * `SceneView` — first-class 3D scene container backed by a Cesium runtime.
 *
 * `SceneView` is the 3D counterpart of {@link module:map.HonuaMap}: a cohesive,
 * typed handle that loads a Honua scene and drives a live Cesium globe through
 * the renderer-neutral {@link module:scene-workspace/cesium-adapter} (#1196). It
 * renders the scene's 3D Tiles + terrain + glTF models (#1197) and exposes the
 * 3D analysis + measurement widgets — line-of-sight, viewshed, measure, and
 * elevation profile (#1205) — wired to the SDK's request pipeline.
 *
 * Like the rest of the scene workspace, this module never imports CesiumJS
 * statically — the live `Viewer`/`Scene` is supplied by the caller as a
 * {@link CesiumSceneRuntimeTarget}, and the adapter pulls the runtime in lazily
 * only when it drives the globe. A `SceneView` constructed without a `target`
 * still loads + diagnoses scenes (useful headless / in tests) but renders
 * nothing.
 *
 * @example
 * ```ts
 * import { SceneView } from "@honua/sdk-js/scene-workspace";
 *
 * const view = new SceneView({ client, target: { camera: viewer.camera, scene: viewer.scene } });
 * await view.loadScene("downtown");
 * view.on((event) => { if (event.type === "scene-loaded") console.log(event.scene.title); });
 *
 * const los = await view.lineOfSight({
 *   datasetId: "dem",
 *   observer: { longitude: -157.8, latitude: 21.3, height: 30 },
 *   target: { longitude: -157.81, latitude: 21.31 },
 *   entities: viewer.entities,
 * });
 * ```
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier: `SceneView` composes Honua Server scene discovery with the analysis
 *   widgets, both server-attached, so it sits outside the open-endpoint evidence
 *   behind that promotion and may change in any minor release prior to `1.0.0`.
 *   The Cesium adapter it drives is beta.
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import type { QueryMethod } from "../core/types.js";
import {
  type CesiumEntityCollectionLike,
  type ElevationProfileRequest,
  type ElevationProfileResult,
  type LineOfSightRequest,
  type LineOfSightResult,
  type SceneAnalysisCesiumModule,
  type SceneAnalysisOverlay,
  type SceneAnalysisPosition,
  type SceneAnalysisRequestExecutor,
  type SceneMeasurement,
  type ViewshedRequest,
  type ViewshedResult,
  measureScenePositions,
  renderElevationProfilePolyline,
  renderLineOfSight,
  renderMeasurement,
  renderViewshed,
  requestElevationProfile,
  requestLineOfSight,
  requestViewshed,
} from "./analysis-widgets.js";
import {
  type CesiumLayerHandle,
  type CesiumSceneRuntimeTarget,
  applyCesiumScenePrimitives,
  cesiumCameraToSceneState,
} from "./cesium-adapter.js";
import type { ScenePrimitiveDiagnostic } from "./primitives.js";
import {
  type HonuaScene,
  type SceneDiscoveryRequestExecutor,
  getScene,
  listScenes,
  sceneLayerStates,
  sceneToRuntimePrimitives,
  sceneViewpointBookmarks,
} from "./scene-discovery.js";
import type { SceneBookmark, SceneCameraState, SceneLayerState } from "./types.js";

/**
 * The request transport a {@link SceneView} uses for scene discovery and
 * analysis endpoints. Exactly `HonuaClient.pipelineRequestJson`, so it reuses
 * the SDK's shared auth / retry / timeout / interceptor pipeline.
 */
export type SceneViewRequestExecutor = <T = unknown>(
  method: QueryMethod,
  path: string,
  init?: { headers?: Record<string, string>; body?: string | null },
  signal?: AbortSignal,
) => Promise<T>;

/** Options for constructing a {@link SceneView}. */
export interface SceneViewOptions {
  /**
   * The Honua client whose request pipeline backs scene discovery and the
   * analysis endpoints. Either `client` or an explicit `execute` is required.
   */
  readonly client?: HonuaClient;
  /**
   * Explicit request executor (overrides `client.pipelineRequestJson`). Lets a
   * caller wire a custom transport, or a test inject a mock without a client.
   */
  readonly execute?: SceneViewRequestExecutor;
  /**
   * The live Cesium target (a `camera`, plus an optional `scene` for layer
   * rendering). Omit to load + diagnose scenes headlessly without rendering.
   */
  readonly target?: CesiumSceneRuntimeTarget;
  /**
   * Base URL used to resolve a scene's static `tileset.json` entry point when
   * the scene omits an explicit `tilesetUrl`. Defaults to `client.serverBaseUrl`.
   */
  readonly baseUrl?: string;
}

/** Events emitted by a {@link SceneView}. */
export type SceneViewEvent =
  | { readonly type: "scene-loaded"; readonly scene: HonuaScene }
  | { readonly type: "layers-changed"; readonly layers: readonly SceneLayerState[] }
  | { readonly type: "layer-visibility"; readonly layerId: string; readonly visible: boolean }
  | { readonly type: "camera-change"; readonly camera: SceneCameraState }
  | { readonly type: "diagnostics"; readonly diagnostics: readonly ScenePrimitiveDiagnostic[] };

/** A listener registered via {@link SceneView.on}. */
export type SceneViewEventListener = (event: SceneViewEvent) => void;

/** The detached request shape shared by the analysis widget convenience methods. */
type AnalysisOverlayTarget = {
  /** Entity collection (typically `viewer.entities`) the result is drawn into. */
  readonly entities?: CesiumEntityCollectionLike;
  /** Optional Cesium-module override (test seam). */
  readonly cesium?: SceneAnalysisCesiumModule;
};

/**
 * First-class 3D scene container. Loads a Honua scene, renders it through the
 * Cesium adapter, and exposes the analysis/measurement widgets.
 */
export class SceneView {
  readonly #execute: SceneViewRequestExecutor;
  readonly #target: CesiumSceneRuntimeTarget | undefined;
  readonly #baseUrl: string | undefined;
  readonly #listeners = new Set<SceneViewEventListener>();
  readonly #layerHandles = new Map<string, CesiumLayerHandle>();

  #scene: HonuaScene | undefined;
  #layers: SceneLayerState[] = [];
  #bookmarks: SceneBookmark[] = [];
  #diagnostics: readonly ScenePrimitiveDiagnostic[] = [];

  constructor(options: SceneViewOptions) {
    const execute = options.execute ?? bindClientExecutor(options.client);
    if (!execute) {
      throw new Error("SceneView requires either a `client` or an explicit `execute` transport.");
    }
    this.#execute = execute;
    this.#target = options.target;
    this.#baseUrl = options.baseUrl ?? options.client?.serverBaseUrl;
  }

  // ── Discovery ───────────────────────────────────────────────

  /** List the catalog of available 3D scenes (`GET /api/scenes`). */
  listScenes(signal?: AbortSignal): Promise<HonuaScene[]> {
    return listScenes(this.#discoveryExecutor(), signal);
  }

  /** Fetch a single scene's metadata without loading it (`GET /api/scenes/{id}`). */
  getScene(sceneId: string, signal?: AbortSignal): Promise<HonuaScene> {
    return getScene(this.#discoveryExecutor(), sceneId, signal);
  }

  // ── Loading / rendering ─────────────────────────────────────

  /**
   * Load a scene by id (or a pre-fetched {@link HonuaScene}) and render it onto
   * the live target: the initial camera, terrain provider, and 3D-Tiles
   * tileset. Replaces any previously loaded scene's layers. Returns the loaded
   * scene. When no target is attached the scene is loaded + diagnosed but not
   * rendered.
   */
  async loadScene(scene: string | HonuaScene, signal?: AbortSignal): Promise<HonuaScene> {
    const resolved = typeof scene === "string" ? await this.getScene(scene, signal) : scene;
    this.#teardownLayers();
    this.#scene = resolved;
    this.#bookmarks = sceneViewpointBookmarks(resolved);
    this.#layers = sceneLayerStates(resolved, this.#baseUrl);

    if (this.#target) {
      const primitives = sceneToRuntimePrimitives(resolved, this.#baseUrl);
      const result = await applyCesiumScenePrimitives(this.#target, primitives);
      this.#diagnostics = result.diagnostics;
      for (const [id, handle] of result.layers) this.#layerHandles.set(id, handle);
      this.#emit({ type: "diagnostics", diagnostics: this.#diagnostics });
    }

    this.#emit({ type: "scene-loaded", scene: resolved });
    this.#emit({ type: "layers-changed", layers: this.#layers });
    return resolved;
  }

  /** The currently loaded scene, or `undefined` before the first `loadScene`. */
  get scene(): HonuaScene | undefined {
    return this.#scene;
  }

  /** Snapshot of the loaded scene's layers (one per rendered primitive). */
  get layers(): readonly SceneLayerState[] {
    return this.#layers;
  }

  /** The loaded scene's named viewpoints as workspace bookmarks. */
  get bookmarks(): readonly SceneBookmark[] {
    return this.#bookmarks;
  }

  /** Diagnostics from the most recent render (capability gaps, fallbacks). */
  get diagnostics(): readonly ScenePrimitiveDiagnostic[] {
    return this.#diagnostics;
  }

  /** Whether a live Cesium target is attached (and therefore rendering). */
  get hasTarget(): boolean {
    return this.#target !== undefined;
  }

  /**
   * Toggle a rendered layer's visibility on the live globe and in the layer
   * snapshot. No-ops (still updates the snapshot) when the layer is not rendered
   * (e.g. no target attached). Returns `true` when the layer is known.
   */
  setLayerVisible(layerId: string, visible: boolean): boolean {
    const layer = this.#layers.find((entry) => entry.id === layerId);
    if (!layer) return false;
    this.#layerHandles.get(layerId)?.setVisible(visible);
    this.#layers = this.#layers.map((entry) => (entry.id === layerId ? { ...entry, visible } : entry));
    this.#emit({ type: "layer-visibility", layerId, visible });
    this.#emit({ type: "layers-changed", layers: this.#layers });
    return true;
  }

  // ── Camera ──────────────────────────────────────────────────

  /**
   * Read the live camera back as a renderer-neutral {@link SceneCameraState},
   * or `undefined` when no target is attached. Also emits a `camera-change`
   * event so subscribers can persist the current view.
   */
  readCamera(): SceneCameraState | undefined {
    if (!this.#target) return undefined;
    const camera = cesiumCameraToSceneState(this.#target.camera);
    this.#emit({ type: "camera-change", camera });
    return camera;
  }

  /**
   * Fly/jump to a named viewpoint (bookmark) on the loaded scene. Returns the
   * applied camera state, or `undefined` when the viewpoint is unknown. The
   * actual `Camera.setView` is performed through the adapter so no static Cesium
   * import is needed here.
   */
  async applyBookmark(bookmarkId: string): Promise<SceneCameraState | undefined> {
    const bookmark = this.#bookmarks.find((entry) => entry.id === bookmarkId);
    if (!bookmark) return undefined;
    return this.setCamera(bookmark.camera);
  }

  /**
   * Set the live camera to an explicit {@link SceneCameraState}. Returns the
   * applied state (or `undefined` when no target is attached). Routed through
   * the adapter's camera primitive so the lazy Cesium import stays centralized.
   */
  async setCamera(camera: SceneCameraState): Promise<SceneCameraState | undefined> {
    if (!this.#target) return undefined;
    await applyCesiumScenePrimitives(this.#target, [
      { kind: "camera", id: "scene-view:set-camera", camera, mode: "global" },
    ]);
    this.#emit({ type: "camera-change", camera });
    return camera;
  }

  // ── Analysis + measurement widgets (#1205) ──────────────────

  /**
   * Run a line-of-sight analysis between an observer and a target. When an
   * `entities` collection is supplied the sightline + obstruction marker are
   * drawn into the scene and the overlay handle is returned alongside the
   * result.
   */
  async lineOfSight(
    request: LineOfSightRequest & AnalysisOverlayTarget,
  ): Promise<{ result: LineOfSightResult; overlay?: SceneAnalysisOverlay }> {
    const result = await requestLineOfSight(this.#analysisExecutor(), request);
    if (!request.entities) return { result };
    const overlay = await renderLineOfSight(request.entities, request, result, request.cesium);
    return { result, overlay };
  }

  /**
   * Run a viewshed analysis from an observer position. When an `entities`
   * collection is supplied the radial visibility samples are drawn into the
   * scene and the overlay handle is returned alongside the result.
   */
  async viewshed(
    request: ViewshedRequest & AnalysisOverlayTarget,
  ): Promise<{ result: ViewshedResult; overlay?: SceneAnalysisOverlay }> {
    const result = await requestViewshed(this.#analysisExecutor(), request);
    if (!request.entities) return { result };
    const overlay = await renderViewshed(request.entities, result, request.cesium);
    return { result, overlay };
  }

  /**
   * Request an elevation profile along a polyline. When an `entities`
   * collection is supplied the draped profile line is drawn into the scene and
   * the overlay handle is returned alongside the result.
   */
  async elevationProfile(
    request: ElevationProfileRequest & AnalysisOverlayTarget,
  ): Promise<{ result: ElevationProfileResult; overlay?: SceneAnalysisOverlay }> {
    const result = await requestElevationProfile(this.#analysisExecutor(), request);
    if (!request.entities) return { result };
    const overlay = await renderElevationProfilePolyline(request.entities, request.polyline, request.cesium);
    return { result, overlay };
  }

  /**
   * Compute a fully client-side 3D distance or area measurement from an ordered
   * list of positions (typically picked off the scene). When an `entities`
   * collection is supplied the measured polyline/polygon + label are drawn into
   * the scene and the overlay handle is returned alongside the measurement.
   */
  async measure(
    positions: readonly SceneAnalysisPosition[],
    options: { readonly mode?: "distance" | "area" } & AnalysisOverlayTarget = {},
  ): Promise<{ measurement: SceneMeasurement; overlay?: SceneAnalysisOverlay }> {
    const measurement = measureScenePositions(positions, options.mode ?? "distance");
    if (!options.entities) return { measurement };
    const overlay = await renderMeasurement(options.entities, measurement, options.cesium);
    return { measurement, overlay };
  }

  // ── Events / lifecycle ──────────────────────────────────────

  /** Subscribe to view events. Returns a handle with `remove()` to unsubscribe. */
  on(listener: SceneViewEventListener): { remove(): void } {
    this.#listeners.add(listener);
    return {
      remove: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /**
   * Tear down all rendered layers and clear listeners. The supplied Cesium
   * target is owned by the caller and is NOT destroyed.
   */
  dispose(): void {
    this.#teardownLayers();
    this.#listeners.clear();
    this.#scene = undefined;
    this.#layers = [];
    this.#bookmarks = [];
    this.#diagnostics = [];
  }

  // ── Internals ───────────────────────────────────────────────

  #discoveryExecutor(): SceneDiscoveryRequestExecutor {
    return this.#execute;
  }

  #analysisExecutor(): SceneAnalysisRequestExecutor {
    return this.#execute;
  }

  #teardownLayers(): void {
    for (const handle of this.#layerHandles.values()) handle.remove();
    this.#layerHandles.clear();
  }

  #emit(event: SceneViewEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function bindClientExecutor(client: HonuaClient | undefined): SceneViewRequestExecutor | undefined {
  if (!client) return undefined;
  return (method, path, init, signal) => client.pipelineRequestJson(method, path, init, signal);
}
