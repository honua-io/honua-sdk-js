import { type SelectionHandle, createHoverHandler, createSelectionHandler } from "@honua/sdk-js/honua";
import { type SceneExtrusionPrimitive, toMapLibreExtrusionLayer } from "@honua/sdk-js/scene-workspace";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";

import {
  buildRouteMetrics,
  getCoordinateAtProgress,
  sliceRouteAtProgress,
  toLineFeature,
  toPointFeature,
} from "./geometry.js";
import type { StoryTelemetry } from "./telemetry.js";
import type { StoryDataset, StoryDemoConfig, StoryFeatureId } from "./types.js";

const ASSET_EXTRUSION_LAYER_ID = "story-assets-extrusion";
const ASSET_OUTLINE_LAYER_ID = "story-assets-outline";
const ROUTE_BASE_LAYER_ID = "story-route-base";
const ROUTE_PROGRESS_LAYER_ID = "story-route-progress-layer";
const ROUTE_MARKER_LAYER_ID = "story-route-marker-layer";
const STOP_BASE_LAYER_ID = "story-stop-base";
const STOP_ACTIVE_LAYER_ID = "story-stop-active";

function createAssetExtrusionPrimitive(sourceId: string): SceneExtrusionPrimitive {
  return {
    kind: "extrusion",
    id: ASSET_EXTRUSION_LAYER_ID,
    sourceId,
    height: ["get", "extrusion_height_m"],
    base: 0,
    opacity: ["case", ["boolean", ["feature-state", "hover"], false], 0.95, 0.84],
    color: [
      "case",
      ["boolean", ["feature-state", "selected"], false],
      "#f3d38a",
      ["boolean", ["feature-state", "priority"], false],
      "#f28d52",
      ["==", ["get", "risk_bucket"], "severe"],
      "#b44a2e",
      ["==", ["get", "risk_bucket"], "high"],
      "#d26c43",
      ["==", ["get", "risk_bucket"], "guarded"],
      "#cfb05f",
      "#4d8a87",
    ],
    metadata: {
      title: "Story asset extrusions",
      fallback: "Render as 2D fills when fill-extrusion is unavailable.",
    },
  };
}

function getErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  if (typeof error === "object" && error && "error" in error) {
    return getErrorDetail((error as { error?: unknown }).error);
  }

  return typeof error === "string" ? error : "Unknown MapLibre error.";
}

function createBasemapLoadError(styleUrl: string, error: unknown): Error {
  return new Error(`Failed to load the basemap style "${styleUrl}": ${getErrorDetail(error)}`);
}

function waitForMapStyle(map: MapLibreMap, styleUrl: string): Promise<void> {
  if (map.isStyleLoaded() === true) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onStyleLoad = () => {
      cleanup();
      resolve();
    };
    const onError = (event: unknown) => {
      cleanup();
      reject(createBasemapLoadError(styleUrl, event));
    };
    const cleanup = () => {
      map.off("style.load", onStyleLoad);
      map.off("error", onError);
    };

    map.on("style.load", onStyleLoad);
    map.on("error", onError);
  });
}

function createRouteProgressData(dataset: StoryDataset, progress: number) {
  const metrics = buildRouteMetrics(dataset.routeCoordinates);
  const coordinates = sliceRouteAtProgress(metrics, progress);

  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        id: `${dataset.routeFeature.id}-progress`,
        geometry: toLineFeature(coordinates, `${dataset.routeFeature.id}-progress`),
        properties: {
          story_id: `${dataset.routeFeature.id}-progress`,
          name: dataset.routeFeature.properties.name,
        },
      },
    ],
  };
}

function createRouteMarkerData(dataset: StoryDataset, progress: number) {
  const metrics = buildRouteMetrics(dataset.routeCoordinates);
  const coordinate = getCoordinateAtProgress(metrics, progress);

  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        id: `${dataset.routeFeature.id}-marker`,
        geometry: toPointFeature(coordinate),
        properties: {
          story_id: `${dataset.routeFeature.id}-marker`,
          name: dataset.routeFeature.properties.name,
        },
      },
    ],
  };
}

export interface StoryMapHandle {
  map: MapLibreMap;
  layerIds: readonly string[];
  sourceIds: readonly string[];
  destroy(): void;
  setPriorityAssets(ids: readonly StoryFeatureId[]): void;
  setActiveStop(id?: StoryFeatureId): void;
  setSelectedAsset(id?: StoryFeatureId): void;
  resetRoutePlayback(): void;
  playRoute(options: {
    durationMs: number;
    onProgress?: (progress: number) => void;
  }): { cancel(): void; promise: Promise<boolean> };
}

export interface CreateStoryMapOptions {
  container: HTMLElement;
  dataset: StoryDataset;
  config: StoryDemoConfig;
  telemetry: StoryTelemetry;
  onAssetSelected?: (id: StoryFeatureId | undefined) => void;
}

export async function createStoryMap(options: CreateStoryMapOptions): Promise<StoryMapHandle> {
  const map = new maplibregl.Map({
    container: options.container,
    style: options.config.basemapStyle,
    center: options.dataset.bounds.center,
    zoom: 14.1,
    pitch: options.config.initialPitch,
    bearing: options.config.initialBearing,
    attributionControl: false,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  await waitForMapStyle(map, options.config.basemapStyle);

  const routeMetrics = buildRouteMetrics(options.dataset.routeCoordinates);

  map.addSource(options.config.sourceIds.assets, {
    type: "geojson",
    data: options.dataset.assets,
  });
  map.addSource(options.config.sourceIds.route, {
    type: "geojson",
    data: options.dataset.route,
  });
  map.addSource(options.config.sourceIds.routeProgress, {
    type: "geojson",
    data: createRouteProgressData(options.dataset, 0),
  });
  map.addSource(options.config.sourceIds.routeMarker, {
    type: "geojson",
    data: createRouteMarkerData(options.dataset, 0),
  });
  map.addSource(options.config.sourceIds.stops, {
    type: "geojson",
    data: options.dataset.stops,
  });

  map.addLayer({
    id: ROUTE_BASE_LAYER_ID,
    type: "line",
    source: options.config.sourceIds.route,
    paint: {
      "line-color": "#27454d",
      "line-width": 6,
      "line-opacity": 0.35,
    },
  });

  map.addLayer({
    id: ROUTE_PROGRESS_LAYER_ID,
    type: "line",
    source: options.config.sourceIds.routeProgress,
    paint: {
      "line-color": "#f05a28",
      "line-width": 6,
      "line-opacity": 0.95,
    },
  });

  map.addLayer({
    id: STOP_BASE_LAYER_ID,
    type: "circle",
    source: options.config.sourceIds.stops,
    paint: {
      "circle-radius": 5,
      "circle-color": "#17313a",
      "circle-stroke-color": "#f7f1e3",
      "circle-stroke-width": 1.5,
    },
  });

  map.addLayer({
    id: STOP_ACTIVE_LAYER_ID,
    type: "circle",
    source: options.config.sourceIds.stops,
    paint: {
      "circle-radius": ["case", ["boolean", ["feature-state", "active"], false], 12, 8],
      "circle-color": "#f5c76d",
      "circle-opacity": ["case", ["boolean", ["feature-state", "active"], false], 0.75, 0],
      "circle-stroke-color": "#fff7dd",
      "circle-stroke-width": ["case", ["boolean", ["feature-state", "active"], false], 2, 0],
    },
  });

  map.addLayer(toMapLibreExtrusionLayer(createAssetExtrusionPrimitive(options.config.sourceIds.assets)) as never);

  map.addLayer({
    id: ASSET_OUTLINE_LAYER_ID,
    type: "line",
    source: options.config.sourceIds.assets,
    paint: {
      "line-color": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        "#fff4ce",
        ["boolean", ["feature-state", "priority"], false],
        "#ffe9b5",
        "#38271b",
      ],
      "line-width": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        3.5,
        ["boolean", ["feature-state", "priority"], false],
        2.5,
        1,
      ],
      "line-opacity": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        1,
        ["boolean", ["feature-state", "priority"], false],
        0.9,
        0.24,
      ],
    },
  });

  map.addLayer({
    id: ROUTE_MARKER_LAYER_ID,
    type: "circle",
    source: options.config.sourceIds.routeMarker,
    paint: {
      "circle-radius": 7,
      "circle-color": "#fff5d6",
      "circle-stroke-color": "#ef5a29",
      "circle-stroke-width": 3,
    },
  });

  const hover = createHoverHandler(map, {
    source: options.config.sourceIds.assets,
    layer: ASSET_EXTRUSION_LAYER_ID,
  });

  const selectionCallback: ((id: StoryFeatureId | undefined) => void) | undefined = options.onAssetSelected;
  const selection: SelectionHandle = createSelectionHandler(map, {
    source: options.config.sourceIds.assets,
    layer: ASSET_EXTRUSION_LAYER_ID,
    onChange(selectedIds) {
      const selectedId = selectedIds.values().next().value;
      selectionCallback?.(typeof selectedId === "string" ? selectedId : undefined);
    },
  });

  const onPointerEnter = () => {
    map.getCanvas().style.cursor = "pointer";
  };
  const onPointerLeave = () => {
    map.getCanvas().style.cursor = "";
  };
  map.on("mouseenter", ASSET_EXTRUSION_LAYER_ID, onPointerEnter);
  map.on("mouseleave", ASSET_EXTRUSION_LAYER_ID, onPointerLeave);

  let activePriorityIds = new Set<StoryFeatureId>();
  let activeStopId: StoryFeatureId | undefined;
  let animationFrameId: number | undefined;

  function updateGeoJsonSource(sourceId: string, data: unknown): void {
    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    source?.setData(data as never);
  }

  function writeRoutePlayback(progress: number): void {
    updateGeoJsonSource(options.config.sourceIds.routeProgress, {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: `${options.dataset.routeFeature.id}-progress`,
          geometry: toLineFeature(
            sliceRouteAtProgress(routeMetrics, progress),
            `${options.dataset.routeFeature.id}-progress`,
          ),
          properties: { story_id: `${options.dataset.routeFeature.id}-progress` },
        },
      ],
    });
    updateGeoJsonSource(options.config.sourceIds.routeMarker, {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: `${options.dataset.routeFeature.id}-marker`,
          geometry: toPointFeature(getCoordinateAtProgress(routeMetrics, progress)),
          properties: { story_id: `${options.dataset.routeFeature.id}-marker` },
        },
      ],
    });
  }

  function clearAnimationFrame(): void {
    if (animationFrameId !== undefined) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = undefined;
    }
  }

  function setPriorityAssets(ids: readonly StoryFeatureId[]): void {
    const nextIds = new Set(ids);
    for (const id of activePriorityIds) {
      if (!nextIds.has(id)) {
        map.setFeatureState({ source: options.config.sourceIds.assets, id }, { priority: false });
      }
    }
    for (const id of nextIds) {
      if (!activePriorityIds.has(id)) {
        map.setFeatureState({ source: options.config.sourceIds.assets, id }, { priority: true });
      }
    }
    activePriorityIds = nextIds;
  }

  function setActiveStop(id: StoryFeatureId | undefined): void {
    if (activeStopId && activeStopId !== id) {
      map.setFeatureState({ source: options.config.sourceIds.stops, id: activeStopId }, { active: false });
    }
    activeStopId = id;
    if (id) {
      map.setFeatureState({ source: options.config.sourceIds.stops, id }, { active: true });
    }
  }

  function setSelectedAsset(id: StoryFeatureId | undefined): void {
    if (!id) {
      selection.clearSelection();
      return;
    }
    selection.select(id);
  }

  function resetRoutePlayback(): void {
    clearAnimationFrame();
    writeRoutePlayback(0);
  }

  function playRoute(optionsArg: {
    durationMs: number;
    onProgress?: (progress: number) => void;
  }): { cancel(): void; promise: Promise<boolean> } {
    clearAnimationFrame();
    let cancelled = false;
    let resolvePromise: ((completed: boolean) => void) | undefined;

    writeRoutePlayback(0);

    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
      const startedAt = performance.now();

      const frame = (timestamp: number) => {
        if (cancelled) {
          resolve(false);
          return;
        }

        const progress = Math.min(1, (timestamp - startedAt) / optionsArg.durationMs);
        writeRoutePlayback(progress);
        optionsArg.onProgress?.(progress);
        options.telemetry.runtime.routeProgress = progress;

        if (progress >= 1) {
          animationFrameId = undefined;
          resolve(true);
          return;
        }

        animationFrameId = requestAnimationFrame(frame);
      };

      animationFrameId = requestAnimationFrame(frame);
    });

    return {
      cancel() {
        if (cancelled) {
          return;
        }
        cancelled = true;
        clearAnimationFrame();
        resolvePromise?.(false);
      },
      promise,
    };
  }

  const layerIds = Object.freeze([
    ROUTE_BASE_LAYER_ID,
    ROUTE_PROGRESS_LAYER_ID,
    STOP_BASE_LAYER_ID,
    STOP_ACTIVE_LAYER_ID,
    ASSET_EXTRUSION_LAYER_ID,
    ASSET_OUTLINE_LAYER_ID,
    ROUTE_MARKER_LAYER_ID,
  ]);

  return {
    map,
    layerIds,
    sourceIds: Object.freeze(Object.values(options.config.sourceIds)),
    destroy() {
      clearAnimationFrame();
      hover.remove();
      selection.remove();
      map.off("mouseenter", ASSET_EXTRUSION_LAYER_ID, onPointerEnter);
      map.off("mouseleave", ASSET_EXTRUSION_LAYER_ID, onPointerLeave);
      map.remove();
    },
    setPriorityAssets,
    setActiveStop,
    setSelectedAsset,
    resetRoutePlayback,
    playRoute,
  };
}
