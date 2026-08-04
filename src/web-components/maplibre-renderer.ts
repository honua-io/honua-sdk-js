import type { FeatureId } from "../contract/index.js";
import type { HonuaClient } from "../core/client.js";
import type { HonuaMapPackage, HonuaMapRuntime, MaplibreMap } from "../runtime/index.js";
import type {
  HonuaFeatureRecord,
  HonuaFeatureStateEntry,
  HonuaMapClickDetail,
  HonuaMapErrorDetail,
  HonuaMapHoverDetail,
  HonuaMapReadyDetail,
  HonuaSelectionChangeDetail,
  HonuaViewportChangeDetail,
  HonuaWebComponentController,
  HonuaWebComponentRuntimeLike,
  HonuaWebComponentState,
} from "./types.js";

type MapLibreLayer = HonuaMapRuntime["composedStyle"]["layers"][number];

type MapLibreMapInstance = MaplibreMap & {
  loaded?(): boolean;
  isStyleLoaded?(): boolean;
  once?(event: string, handler: (...args: unknown[]) => void): void;
  remove?(): void;
  resize?(): void;
  getCanvas?(): HTMLCanvasElement;
  getCenter?(): { lng: number; lat: number };
  getZoom?(): number;
  getPitch?(): number;
  getBearing?(): number;
  getBounds?(): {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  };
  getLayoutProperty?(layerId: string, name: string): unknown;
};

type MapLibreMapConstructor = new (options: Record<string, unknown>) => MapLibreMapInstance;

interface MapLibreNamespace {
  default?: {
    Map?: MapLibreMapConstructor;
  };
  Map?: MapLibreMapConstructor;
}

interface InteractionHandle {
  remove(): void;
}

export interface HonuaMapLibreRendererOptions<T = Record<string, unknown>> {
  container: HTMLElement;
  getClient(): HonuaClient | undefined;
  getController(): HonuaWebComponentController<T> | undefined;
  onReady(detail: HonuaMapReadyDetail<T>): void;
  onError(detail: HonuaMapErrorDetail): void;
  onViewport(detail: HonuaViewportChangeDetail): void;
  onClick(detail: HonuaMapClickDetail<T>): void;
  onHover(detail: HonuaMapHoverDetail<T>): void;
  onSelection(detail: HonuaSelectionChangeDetail<T>): void;
}

export class HonuaMapLibreRenderer<T = Record<string, unknown>> {
  readonly #options: HonuaMapLibreRendererOptions<T>;
  readonly #interactionHandles: InteractionHandle[] = [];
  #map: MapLibreMapInstance | undefined;
  #runtime: HonuaMapRuntime | undefined;
  #loadedPackageKey: string | undefined;
  #loadToken = 0;
  #lastViewportKey: string | undefined;
  #syncingViewport = false;
  #layerVisibility = new Map<string, boolean>();
  #layerOpacity = new Map<string, number>();
  #layerOrderKey: string | undefined;
  #selectionTarget: HonuaFeatureStateEntry | undefined;
  #featureStates = new Map<string, HonuaFeatureStateEntry>();
  #state: HonuaWebComponentState<T> | undefined;

  public constructor(options: HonuaMapLibreRendererOptions<T>) {
    this.#options = options;
  }

  public get map(): unknown | undefined {
    return this.#map;
  }

  public get runtime(): HonuaWebComponentRuntimeLike<T> | undefined {
    return this.#runtime as HonuaWebComponentRuntimeLike<T> | undefined;
  }

  public async applyState(state: HonuaWebComponentState<T>): Promise<void> {
    this.#state = state;
    if (!state.mapPackage) return;

    const packageKey = mapPackageKey(state.mapPackage);
    if (!this.#runtime || this.#loadedPackageKey !== packageKey) {
      await this.#load(state.mapPackage);
      if (!this.#runtime) return;
    }

    this.#applyLayerVisibility(state);
    this.#applyLayerOpacity(state);
    this.#applyLayerOrder(state);
    this.#applyViewport(state);
    this.#applyFeatureStates(state.featureStates);
    this.#applySelection(state);
  }

  public disconnect(): void {
    this.#loadToken += 1;
    this.#removeInteractions();
    this.#runtime?.dispose();
    this.#runtime = undefined;
    this.#map?.remove?.();
    this.#map = undefined;
    this.#loadedPackageKey = undefined;
    this.#layerVisibility.clear();
    this.#layerOpacity.clear();
    this.#layerOrderKey = undefined;
    this.#featureStates.clear();
    this.#selectionTarget = undefined;
    this.#options.container.replaceChildren();
  }

  async #load(mapPackage: HonuaMapPackage): Promise<void> {
    const token = ++this.#loadToken;
    this.#removeOwnedMap();

    try {
      const [{ loadMapPackage }, maplibregl] = await Promise.all([
        import("../runtime/index.js"),
        import("maplibre-gl") as unknown as Promise<MapLibreNamespace>,
      ]);
      if (token !== this.#loadToken) return;

      // MapLibre 6 is ESM-only and publishes named exports; MapLibre 5 is
      // reachable through either shape depending on how the host bundles it.
      // Accept both so one renderer covers the whole `^5 || ^6` peer range.
      const MapCtor = maplibregl.Map ?? maplibregl.default?.Map;
      if (!MapCtor) {
        throw new Error(
          "maplibre-gl did not export a Map constructor; install maplibre-gl 5.x or 6.x (the SDK peer range is ^5.0.0 || ^6.0.0).",
        );
      }

      const map = new MapCtor({
        container: this.#options.container,
        style: emptyStyle(),
        center: mapPackage.initialView?.center ?? [0, 0],
        zoom: mapPackage.initialView?.zoom ?? 0,
        bearing: mapPackage.initialView?.bearing ?? 0,
        pitch: mapPackage.initialView?.pitch ?? 0,
        attributionControl: false,
        // WebGL context attributes moved under `canvasContextAttributes` in
        // MapLibre 5.0 and stayed there in 6.x. A top-level
        // `preserveDrawingBuffer` is silently ignored by both majors, which
        // would leave `<honua-map>` snapshot export (src/web-components/export.ts)
        // reading an unreadable canvas.
        canvasContextAttributes: { preserveDrawingBuffer: true },
      });
      this.#map = map;

      const runtime = await loadMapPackage(mapPackage, map, {
        client: this.#options.getClient() ?? (await createDefaultClient()),
        skipCompatibilityCheck: true,
        onEvent: (event) => {
          if (event.type === "source-error") {
            this.#emitError(event.error, event.sourceId);
          }
        },
      });
      if (token !== this.#loadToken) {
        runtime.dispose();
        map.remove?.();
        return;
      }

      this.#runtime = runtime;
      this.#loadedPackageKey = mapPackageKey(mapPackage);
      // Seed the order tracker with the order the map actually renders (the
      // composed style), so a controller order that already diverged — e.g. a
      // layer-list reorder issued while the package was still loading — is
      // replayed by the next #applyLayerOrder pass instead of being absorbed.
      this.#layerOrderKey = layerOrderKey(runtime.composedStyle.layers.map((layer) => layer.id));
      this.#bindViewport(map);
      this.#bindLayerInteractions(runtime);
      map.resize?.();
      await waitForMapReady(map);
      if (token !== this.#loadToken) return;
      this.#options.onReady({
        map,
        runtime: runtime as HonuaWebComponentRuntimeLike<T>,
        controller: this.#options.getController(),
        mapPackage,
      });
    } catch (error) {
      if (token !== this.#loadToken) return;
      this.#emitError(error);
      this.#removeOwnedMap();
    }
  }

  #removeOwnedMap(): void {
    this.#removeInteractions();
    this.#runtime?.dispose();
    this.#runtime = undefined;
    this.#map?.remove?.();
    this.#map = undefined;
    this.#layerVisibility.clear();
    this.#layerOpacity.clear();
    this.#layerOrderKey = undefined;
    this.#featureStates.clear();
    this.#selectionTarget = undefined;
    this.#options.container.replaceChildren();
  }

  #bindViewport(map: MapLibreMapInstance): void {
    const emit = (): void => {
      const detail = viewportFromMap(map);
      if (!detail) return;
      this.#lastViewportKey = viewportKey(detail);
      this.#syncingViewport = true;
      try {
        this.#options.getController()?.setViewport(detail);
      } finally {
        this.#syncingViewport = false;
      }
      this.#options.onViewport(detail);
    };
    map.on("moveend", emit);
    this.#interactionHandles.push({ remove: () => map.off("moveend", emit) });
  }

  #bindLayerInteractions(runtime: HonuaMapRuntime): void {
    for (const layer of runtime.composedStyle.layers) {
      if (!layer.source) continue;
      this.#bindHover(runtime, layer);
      this.#bindClick(runtime, layer);
    }
  }

  #bindHover(runtime: HonuaMapRuntime, layer: MapLibreLayer): void {
    try {
      this.#interactionHandles.push(runtime.bindHover(layer.id));
    } catch (error) {
      this.#emitError(error);
      return;
    }

    const sourceId = layer.source;
    if (!sourceId) return;
    const sourceLayer = layer["source-layer"];
    const onMove = (event: unknown): void => {
      const mapFeature = firstEventFeature(event);
      const featureId = featureIdFromMapFeature(mapFeature);
      const feature =
        featureId !== undefined
          ? (this.#findFeature(sourceId, featureId) ?? featureRecordFromMapFeature(sourceId, featureId, mapFeature))
          : undefined;
      this.#options.onHover({
        hovering: featureId !== undefined,
        layerId: layer.id,
        sourceId,
        ...(sourceLayer !== undefined ? { sourceLayer } : {}),
        ...(featureId !== undefined ? { featureId } : {}),
        ...(feature !== undefined ? { feature } : {}),
        ...(mapFeature !== undefined ? { mapFeature } : {}),
        ...eventPosition(event),
        originalEvent: event,
      });
    };
    const onLeave = (event: unknown): void => {
      this.#options.onHover({
        hovering: false,
        layerId: layer.id,
        sourceId,
        ...(sourceLayer !== undefined ? { sourceLayer } : {}),
        ...eventPosition(event),
        originalEvent: event,
      });
    };

    runtime.map.on("mousemove", layer.id, onMove);
    runtime.map.on("mouseleave", layer.id, onLeave);
    this.#interactionHandles.push({
      remove: () => {
        runtime.map.off("mousemove", layer.id, onMove);
        runtime.map.off("mouseleave", layer.id, onLeave);
      },
    });
  }

  #bindClick(runtime: HonuaMapRuntime, layer: MapLibreLayer): void {
    try {
      this.#interactionHandles.push(
        runtime.bindClick(layer.id, (event) => {
          const sourceId = event.selectionTarget?.sourceId ?? event.sourceId;
          const sourceLayer = event.selectionTarget?.sourceLayer ?? event.sourceLayer;
          const featureId = event.selectionTarget?.id ?? event.featureId;
          const feature =
            featureId !== undefined
              ? (this.#findFeature(sourceId, featureId) ??
                featureRecordFromMapFeature(sourceId, featureId, event.feature))
              : undefined;
          const detail: HonuaMapClickDetail<T> = {
            layerId: event.layerId,
            sourceId,
            ...(sourceLayer !== undefined ? { sourceLayer } : {}),
            ...(featureId !== undefined ? { featureId } : {}),
            ...(feature ? { feature } : {}),
            ...(event.feature !== undefined ? { mapFeature: event.feature } : {}),
            ...eventPosition(event.originalEvent),
            originalEvent: event.originalEvent,
          };
          this.#options.onClick(detail);
          if (featureId === undefined) return;
          const selection: HonuaSelectionChangeDetail<T> = {
            sourceId,
            ...(sourceLayer !== undefined ? { sourceLayer } : {}),
            featureId,
            ...(feature ? { feature } : {}),
          };
          this.#options.getController()?.selectFeature(selection);
          this.#options.onSelection(selection);
        }),
      );
    } catch (error) {
      this.#emitError(error);
    }
  }

  #applyLayerVisibility(state: HonuaWebComponentState<T>): void {
    const runtime = this.#runtime;
    if (!runtime) return;
    for (const layer of state.layers) {
      const previous = this.#layerVisibility.get(layer.id);
      if (previous === layer.visible) continue;
      this.#layerVisibility.set(layer.id, layer.visible);
      try {
        runtime.setLayerVisibility(layer.id, layer.visible);
      } catch (error) {
        this.#emitError(error);
      }
    }
  }

  #applyLayerOpacity(state: HonuaWebComponentState<T>): void {
    const map = this.#map;
    if (!map?.setPaintProperty) return;
    for (const layer of state.layers) {
      if (layer.opacity === undefined) continue;
      const previous = this.#layerOpacity.get(layer.id);
      if (previous === layer.opacity) continue;
      this.#layerOpacity.set(layer.id, layer.opacity);
      if (map.getLayer && !map.getLayer(layer.id)) continue;
      for (const property of opacityPaintProperties(layer.type)) {
        try {
          map.setPaintProperty(layer.id, property, layer.opacity);
        } catch (error) {
          this.#emitError(error);
        }
      }
    }
  }

  #applyLayerOrder(state: HonuaWebComponentState<T>): void {
    const key = layerOrderKey(state.layers.map((layer) => layer.id));
    // `#layerOrderKey` is seeded from the composed style order when the map
    // package loads (see #load), so a matching key means the map already
    // renders this order and overlays are never hoisted above host-managed
    // base layers gratuitously. Any diverging key — including a reorder
    // issued while the package was still loading — is replayed onto the map.
    if (key === this.#layerOrderKey) return;
    this.#layerOrderKey = key;
    const map = this.#map;
    if (!map?.moveLayer) return;
    for (const layer of state.layers) {
      if (map.getLayer && !map.getLayer(layer.id)) continue;
      try {
        map.moveLayer(layer.id);
      } catch (error) {
        this.#emitError(error);
      }
    }
  }

  #applyViewport(state: HonuaWebComponentState<T>): void {
    if (this.#syncingViewport || !this.#runtime) return;
    const key = viewportKey(state.viewport);
    if (key === this.#lastViewportKey) return;
    this.#lastViewportKey = key;
    try {
      this.#runtime.setViewState(state.viewport);
    } catch (error) {
      this.#emitError(error);
    }
  }

  #applySelection(state: HonuaWebComponentState<T>): void {
    const runtime = this.#runtime;
    if (!runtime) return;
    const next = selectionFeatureState(state);
    const previous = this.#selectionTarget;
    if (previous && (!next || featureStateKey(previous) !== featureStateKey(next))) {
      this.#removeFeatureState(previous, "selected");
    }
    if (next) this.#setFeatureState(next, { selected: true });
    this.#selectionTarget = next;
  }

  #applyFeatureStates(entries: readonly HonuaFeatureStateEntry[]): void {
    for (const [key, previous] of this.#featureStates) {
      const next = entries.find((entry) => featureStateKey(entry) === key);
      if (!next) {
        this.#removeFeatureState(previous);
        this.#featureStates.delete(key);
        continue;
      }
      for (const previousKey of Object.keys(previous.state)) {
        if (!Object.hasOwn(next.state, previousKey)) this.#removeFeatureState(previous, previousKey);
      }
    }

    for (const entry of entries) {
      const key = featureStateKey(entry);
      const previous = this.#featureStates.get(key);
      if (!previous || stableKey(previous.state) !== stableKey(entry.state)) {
        this.#setFeatureState(entry, entry.state);
      }
      this.#featureStates.set(key, copyFeatureStateEntry(entry));
    }
  }

  #setFeatureState(target: HonuaFeatureStateEntry, state: Record<string, unknown>): void {
    try {
      this.#runtime?.setFeatureStateForTarget(
        {
          sourceId: target.sourceId,
          id: target.featureId,
          ...(target.sourceLayer !== undefined ? { sourceLayer: target.sourceLayer } : {}),
        },
        state,
      );
    } catch (error) {
      this.#emitError(error);
    }
  }

  #removeFeatureState(target: HonuaFeatureStateEntry, key?: string): void {
    try {
      this.#runtime?.removeFeatureStateForTarget(
        {
          sourceId: target.sourceId,
          id: target.featureId,
          ...(target.sourceLayer !== undefined ? { sourceLayer: target.sourceLayer } : {}),
        },
        key,
      );
    } catch (error) {
      this.#emitError(error);
    }
  }

  #findFeature(sourceId: string, featureId: FeatureId): HonuaFeatureRecord<T> | undefined {
    return this.#state?.featuresBySource[sourceId]?.find((feature) => String(feature.id) === String(featureId));
  }

  #removeInteractions(): void {
    for (const handle of this.#interactionHandles.splice(0)) {
      handle.remove();
    }
  }

  #emitError(error: unknown, sourceId?: string): void {
    this.#options.onError({
      error,
      message: error instanceof Error ? error.message : String(error),
      ...(sourceId ? { sourceId } : {}),
    });
  }
}

async function createDefaultClient(): Promise<HonuaClient> {
  const { HonuaClient } = await import("../core/client.js");
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost";
  return new HonuaClient({ baseUrl: origin });
}

function emptyStyle(): Record<string, unknown> {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "honua-empty-background",
        type: "background",
        paint: { "background-color": "#e8eef7" },
      },
    ],
  };
}

function mapPackageKey(mapPackage: HonuaMapPackage): string {
  return `${mapPackage.mapPackageId}:${stableKey({
    sources: Object.keys(mapPackage.mapSpec.sources).sort(),
    layers: mapPackage.mapSpec.layers.map((layer) => [layer.id, layer.type, layer.source]),
    initialView: mapPackage.initialView,
  })}`;
}

function selectionFeatureState<T>(state: HonuaWebComponentState<T>): HonuaFeatureStateEntry | undefined {
  const sourceId = state.selection?.sourceId;
  const sourceLayer = state.selection?.sourceLayer;
  const featureId = state.selection?.featureId;
  if (sourceId === undefined || featureId === undefined) return undefined;
  return { sourceId, ...(sourceLayer !== undefined ? { sourceLayer } : {}), featureId, state: { selected: true } };
}

function copyFeatureStateEntry(entry: HonuaFeatureStateEntry): HonuaFeatureStateEntry {
  return {
    sourceId: entry.sourceId,
    featureId: entry.featureId,
    ...(entry.sourceLayer !== undefined ? { sourceLayer: entry.sourceLayer } : {}),
    state: { ...entry.state },
  };
}

function featureStateKey(target: HonuaFeatureStateEntry): string {
  return `${target.sourceId}\u0000${target.sourceLayer ?? ""}\u0000${typeof target.featureId}:${String(
    target.featureId,
  )}`;
}

function stableKey(value: unknown): string {
  return JSON.stringify(value);
}

/** Order-tracking key over layer ids (NUL-delimited so ids with spaces stay distinct). */
function layerOrderKey(ids: readonly string[]): string {
  return ids.join("\u0000");
}

/** Paint properties that carry a layer's overall opacity, by layer type. */
function opacityPaintProperties(type: string | undefined): readonly string[] {
  switch (type) {
    case "fill":
      return ["fill-opacity"];
    case "line":
      return ["line-opacity"];
    case "circle":
      return ["circle-opacity", "circle-stroke-opacity"];
    case "symbol":
      return ["icon-opacity", "text-opacity"];
    case "raster":
      return ["raster-opacity"];
    case "background":
      return ["background-opacity"];
    case "fill-extrusion":
      return ["fill-extrusion-opacity"];
    case "heatmap":
      return ["heatmap-opacity"];
    default:
      return [];
  }
}

function viewportKey(viewport: HonuaViewportChangeDetail): string {
  return JSON.stringify({
    bbox: viewport.bbox,
    center: viewport.center,
    zoom: viewport.zoom,
    pitch: viewport.pitch,
    bearing: viewport.bearing,
  });
}

function firstEventFeature(event: unknown): unknown {
  if (typeof event !== "object" || event === null || !("features" in event)) return undefined;
  const features = (event as { features?: unknown }).features;
  return Array.isArray(features) ? features[0] : undefined;
}

function featureIdFromMapFeature(feature: unknown): FeatureId | undefined {
  if (typeof feature !== "object" || feature === null || !("id" in feature)) return undefined;
  const id = (feature as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function featureRecordFromMapFeature<T>(
  sourceId: string,
  featureId: FeatureId,
  feature: unknown,
): HonuaFeatureRecord<T> | undefined {
  if (typeof feature !== "object" || feature === null) return undefined;
  const candidate = feature as { properties?: unknown; geometry?: unknown };
  const attributes =
    candidate.properties && typeof candidate.properties === "object"
      ? ({ ...(candidate.properties as Record<string, unknown>) } as T)
      : ({} as T);
  return {
    id: featureId,
    sourceId,
    attributes,
    ...(candidate.geometry !== undefined ? { geometry: candidate.geometry as HonuaFeatureRecord<T>["geometry"] } : {}),
    title: featureTitle(attributes, featureId),
  };
}

function featureTitle<T>(attributes: T, id: FeatureId): string {
  const values = attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
  for (const key of ["name", "Name", "NAME", "title", "Title", "TITLE", "label", "Label", "LABEL"]) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const firstString = Object.values(values).find((value) => typeof value === "string" && value.trim());
  return typeof firstString === "string" ? firstString : String(id);
}

function eventPosition(event: unknown): Pick<HonuaMapClickDetail, "point" | "lngLat"> {
  if (typeof event !== "object" || event === null) return {};
  const values = event as {
    point?: { x?: unknown; y?: unknown };
    lngLat?: { lng?: unknown; lat?: unknown };
  };
  return {
    ...(typeof values.point?.x === "number" && typeof values.point.y === "number"
      ? { point: { x: values.point.x, y: values.point.y } }
      : {}),
    ...(typeof values.lngLat?.lng === "number" && typeof values.lngLat.lat === "number"
      ? { lngLat: [values.lngLat.lng, values.lngLat.lat] as const }
      : {}),
  };
}

function viewportFromMap(map: MapLibreMapInstance): HonuaViewportChangeDetail | undefined {
  const center = map.getCenter?.();
  const bounds = map.getBounds?.();
  return {
    ...(bounds ? { bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] as const } : {}),
    ...(center ? { center: [center.lng, center.lat] as const } : {}),
    ...(map.getZoom ? { zoom: map.getZoom() } : {}),
    ...(map.getPitch ? { pitch: map.getPitch() } : {}),
    ...(map.getBearing ? { bearing: map.getBearing() } : {}),
  };
}

async function waitForMapReady(map: MapLibreMapInstance): Promise<void> {
  if (map.loaded?.() || map.isStyleLoaded?.()) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(done, 2500);
    if (map.once) {
      map.once("idle", done);
      map.once("load", done);
    } else {
      done();
    }
  });
}
