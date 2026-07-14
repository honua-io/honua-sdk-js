import maplibregl from "maplibre-gl";

import { SampleCleanupRegistry } from "../../_kit/cleanup.js";
import { mountSamplePresentation } from "../../_kit/presentation.js";
import { resolveStandaloneConfig } from "./config.js";
import type { StandaloneDataset } from "./data.js";
import { renderStandaloneFeatureList } from "./presentation.js";
import { patchRuntimeState } from "./telemetry.js";
import { runStandaloneWorkflow } from "./workflow.js";
import "../../_kit/presentation.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function geometryKinds(dataset: StandaloneDataset): Set<string> {
  const kinds = new Set<string>();
  for (const feature of dataset.geojson.features) {
    const type = feature.geometry?.type;
    if (type === "Polygon" || type === "MultiPolygon") {
      kinds.add("polygon");
    } else if (type === "LineString" || type === "MultiLineString") {
      kinds.add("line");
    } else if (type === "Point" || type === "MultiPoint") {
      kinds.add("point");
    }
  }
  return kinds;
}

function addFeatureLayers(map: maplibregl.Map, dataset: StandaloneDataset, sourceId: string): string[] {
  const kinds = geometryKinds(dataset);
  const layerIds: string[] = [];

  map.addSource(sourceId, { type: "geojson", data: dataset.geojson as never });

  if (kinds.has("polygon")) {
    map.addLayer({
      id: "standalone-fill",
      source: sourceId,
      type: "fill",
      filter: ["==", "$type", "Polygon"],
      paint: { "fill-color": "#0f766e", "fill-opacity": 0.45 },
    });
    map.addLayer({
      id: "standalone-outline",
      source: sourceId,
      type: "line",
      filter: ["==", "$type", "Polygon"],
      paint: { "line-color": "#134e4a", "line-width": 1.5 },
    });
    layerIds.push("standalone-fill", "standalone-outline");
  }
  if (kinds.has("line")) {
    map.addLayer({
      id: "standalone-line",
      source: sourceId,
      type: "line",
      filter: ["==", "$type", "LineString"],
      paint: { "line-color": "#2563eb", "line-width": 3 },
    });
    layerIds.push("standalone-line");
  }
  if (kinds.has("point")) {
    map.addLayer({
      id: "standalone-circle",
      source: sourceId,
      type: "circle",
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-radius": 6,
        "circle-color": "#2563eb",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
    layerIds.push("standalone-circle");
  }

  return layerIds;
}

async function bootstrap(): Promise<void> {
  const cleanup = new SampleCleanupRegistry();
  const bootstrapController = new AbortController();
  cleanup.add(() => bootstrapController.abort());
  let presentation: ReturnType<typeof mountSamplePresentation>;
  const teardown = async () => {
    bootstrapController.abort();
    await cleanup.dispose();
    patchRuntimeState({ mapReady: false, disposed: true });
  };
  const dispose = async () => {
    await teardown();
    presentation.root.remove();
  };
  presentation = mountSamplePresentation({
    sampleId: "standalone-quickstart",
    evidence: {
      mode: "resolved at startup",
      endpoint: "configured GeoServices layer",
      authentication: "none",
    },
    onDispose: dispose,
  });
  window.__HONUA_STANDALONE_DISPOSE__ = dispose;
  cleanup.add(() => {
    delete window.__HONUA_STANDALONE_DISPOSE__;
  });
  cleanup.listen(window, "beforeunload", () => void dispose(), { once: true });
  setText("status-endpoint", "Querying…");

  try {
    const config = resolveStandaloneConfig({
      VITE_STANDALONE_BASEMAP_STYLE: import.meta.env.VITE_STANDALONE_BASEMAP_STYLE,
      VITE_STANDALONE_FEATURE_LAYER_URL: import.meta.env.VITE_STANDALONE_FEATURE_LAYER_URL,
      VITE_STANDALONE_MAX_PAGES: import.meta.env.VITE_STANDALONE_MAX_PAGES,
      VITE_STANDALONE_OUT_FIELDS: import.meta.env.VITE_STANDALONE_OUT_FIELDS,
      VITE_STANDALONE_WHERE: import.meta.env.VITE_STANDALONE_WHERE,
    });
    const dataset: StandaloneDataset = await runStandaloneWorkflow(config, { signal: bootstrapController.signal });
    bootstrapController.signal.throwIfAborted();
    presentation.updateEvidence({
      mode: config.featureLayerUrl.startsWith("http") ? "anonymous live" : "fixture replay",
      endpoint: dataset.endpointHost,
      attribution: "GeoServices source metadata retained",
      cache: config.featureLayerUrl.startsWith("http") ? "live request" : "committed fixture replay",
    });
    setText("status-endpoint", dataset.endpointHost);
    setText("status-layer", dataset.layerName);
    setText("status-geometry", dataset.geometryType ?? "unknown");
    setText("status-feature-count", String(dataset.featureCount));
    setText("status-compat-count", String(dataset.compatFeatureCount));
    setText("status-error", "None");
    const featureList = document.getElementById("feature-list");
    if (featureList) renderStandaloneFeatureList(featureList, dataset);
    presentation.showDegradation(dataset.degradationReasons);
    patchRuntimeState({
      ready: true,
      featureCount: dataset.featureCount,
      compatFeatureCount: dataset.compatFeatureCount,
      layerName: dataset.layerName,
      geometryType: dataset.geometryType,
      usedServer: false,
    });

    const map = new maplibregl.Map({
      container: "map",
      style: config.basemapStyle,
      center: [-98, 39],
      zoom: 3,
    });
    try {
      cleanup.resource(map);
    } catch (error) {
      map.remove();
      throw error;
    }
    bootstrapController.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        try {
          const layerIds = addFeatureLayers(map, dataset, config.sourceId);
          if (dataset.bounds) map.fitBounds(dataset.bounds, { padding: 40, duration: 0 });
          document.getElementById("map-overlay")?.setAttribute("data-state", "ready");
          patchRuntimeState({ mapReady: true, layerIds });
          removeInitialListeners();
          resolve();
        } catch (error) {
          removeInitialListeners();
          reject(error);
        }
      };
      const onError = (event: { error?: Error }) => {
        removeInitialListeners();
        reject(event.error ?? new Error("MapLibre failed to load the standalone map"));
      };
      const onAbort = () => {
        removeInitialListeners();
        reject(bootstrapController.signal.reason);
      };
      const removeInitialListeners = () => {
        map.off("load", onLoad);
        map.off("error", onError);
        bootstrapController.signal.removeEventListener("abort", onAbort);
      };
      map.on("load", onLoad);
      map.on("error", onError);
      bootstrapController.signal.addEventListener("abort", onAbort, { once: true });
      cleanup.add(removeInitialListeners);
    });
    const onRuntimeError = (event: { error?: Error }) => {
      const error = event.error ?? new Error("MapLibre runtime error");
      const message = error.message;
      setText("status-error", message);
      presentation.showError(error);
      patchRuntimeState({ error: message });
      void teardown().catch((cleanupError) => presentation.showError(cleanupError));
    };
    map.on("error", onRuntimeError);
    cleanup.add(() => {
      map.off("error", onRuntimeError);
    });
  } catch (error) {
    if (bootstrapController.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    setText("status-endpoint", "Failed");
    setText("status-error", message);
    presentation.showError(error);
    patchRuntimeState({ ready: true, error: message });
    await teardown().catch((cleanupError) => presentation.showError(cleanupError));
  }
}

void bootstrap();
