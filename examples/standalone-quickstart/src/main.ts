import maplibregl from "maplibre-gl";

import { resolveStandaloneConfig } from "./config.js";
import { type StandaloneDataset, loadStandaloneDataset } from "./data.js";
import { patchRuntimeState } from "./telemetry.js";
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

function renderFeatureList(dataset: StandaloneDataset): void {
  const container = document.getElementById("feature-list");
  if (!container) {
    return;
  }
  const rows = dataset.geojson.features.slice(0, 12).map((feature) => {
    const props = feature.properties ?? {};
    const title =
      (typeof props.NAME === "string" && props.NAME) ||
      (typeof props.name === "string" && props.name) ||
      `Feature ${feature.id ?? ""}`;
    const detailKey = Object.keys(props).find((key) => key !== "NAME" && key !== "name");
    const detail = detailKey ? `${detailKey}: ${String(props[detailKey])}` : "";
    return `<li><strong>${title}</strong><span>${detail}</span></li>`;
  });
  container.innerHTML = rows.length > 0 ? rows.join("") : `<li class="empty-copy">No features returned.</li>`;
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
  const config = resolveStandaloneConfig();
  setText("status-endpoint", "Querying…");

  let dataset: StandaloneDataset;
  try {
    dataset = await loadStandaloneDataset(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setText("status-endpoint", "Failed");
    setText("status-error", message);
    patchRuntimeState({ ready: true, error: message });
    return;
  }

  setText("status-endpoint", dataset.endpointHost);
  setText("status-layer", dataset.layerName);
  setText("status-geometry", dataset.geometryType ?? "unknown");
  setText("status-feature-count", String(dataset.featureCount));
  setText("status-compat-count", String(dataset.compatFeatureCount));
  setText("status-error", "None");
  renderFeatureList(dataset);

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

  map.on("load", () => {
    try {
      const layerIds = addFeatureLayers(map, dataset, config.sourceId);
      if (dataset.bounds) {
        map.fitBounds(dataset.bounds, { padding: 40, duration: 0 });
      }
      const overlay = document.getElementById("map-overlay");
      if (overlay) {
        overlay.setAttribute("data-state", "ready");
      }
      patchRuntimeState({ mapReady: true, layerIds });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchRuntimeState({ error: message });
    }
  });
}

void bootstrap();
