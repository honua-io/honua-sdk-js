import "maplibre-gl/dist/maplibre-gl.css";

import {
  type HonuaChartModel,
  type HonuaFeatureRecord,
  createHonuaWebComponentController,
} from "@honua/sdk-js/web-components";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_WEB_COMPONENTS_DEMO__?: {
      ready: boolean;
      events: string[];
      selectedFeatureId?: string | number;
      layerVisible(layerId: string): boolean;
      mapLayerVisible(layerId: string): boolean;
      mapNonBlank(): boolean;
    };
  }
}

const INCIDENT_SOURCE_ID = "incidents";

const features: HonuaFeatureRecord[] = [
  {
    id: 101,
    sourceId: INCIDENT_SOURCE_ID,
    title: "Harbor response district",
    attributes: { name: "Harbor response district", status: "Open", priority: "High" },
    geometry: { x: -157.87, y: 21.31 },
  },
  {
    id: 102,
    sourceId: INCIDENT_SOURCE_ID,
    title: "Kakaako utility corridor",
    attributes: { name: "Kakaako utility corridor", status: "Monitoring", priority: "Medium" },
    geometry: { x: -157.86, y: 21.29 },
  },
  {
    id: 103,
    sourceId: INCIDENT_SOURCE_ID,
    title: "Ala Moana shelter route",
    attributes: { name: "Ala Moana shelter route", status: "Closed", priority: "Low" },
    geometry: { x: -157.84, y: 21.3 },
  },
];

const incidentGeoJson = {
  type: "FeatureCollection",
  features: features.map((feature) => {
    const point = feature.geometry && "x" in feature.geometry ? feature.geometry : undefined;
    return {
      type: "Feature",
      id: feature.id,
      properties: feature.attributes,
      geometry: {
        type: "Point",
        coordinates: [point?.x ?? -157.86, point?.y ?? 21.3],
      },
    };
  }),
};

const chart: HonuaChartModel = {
  id: "priority-summary",
  title: "Priority summary",
  kind: "bar",
  status: "ready",
  sourceId: INCIDENT_SOURCE_ID,
  data: [
    { label: "High", value: 1, color: "#dc2626" },
    { label: "Medium", value: 1, color: "#d97706" },
    { label: "Low", value: 1, color: "#16a34a" },
  ],
};

const controller = createHonuaWebComponentController({
  mapPackage: {
    mapPackageId: "web-components-demo",
    format: "honua_map_package.v1",
    status: "Ready",
    sourceBindings: [],
    initialView: { center: [-157.86, 21.3], zoom: 11 },
    legend: [
      { label: "High priority", color: "#dc2626" },
      { label: "Medium priority", color: "#d97706" },
      { label: "Low priority", color: "#16a34a" },
    ],
    mapSpec: {
      version: 8,
      sources: {
        [INCIDENT_SOURCE_ID]: {
          type: "geojson",
          data: incidentGeoJson,
        },
      },
      layers: [
        {
          id: "basemap-background",
          type: "background",
          metadata: { title: "Map background" },
          paint: { "background-color": "#e8eef7" },
        },
        {
          id: "incident-halos",
          source: INCIDENT_SOURCE_ID,
          type: "circle",
          metadata: { title: "Incident response halos" },
          paint: {
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 22, 16],
            "circle-color": "#2563eb",
            "circle-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.34, 0.18],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1,
          },
        },
        {
          id: "incident-points",
          source: INCIDENT_SOURCE_ID,
          type: "circle",
          metadata: { title: "Public safety incidents" },
          paint: {
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 9, 6],
            "circle-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              "#f97316",
              ["boolean", ["feature-state", "hover"], false],
              "#1d4ed8",
              "#dc2626",
            ],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
        },
      ],
    },
  },
  featuresBySource: {
    [INCIDENT_SOURCE_ID]: features,
  },
  fieldsBySource: {
    [INCIDENT_SOURCE_ID]: ["name", "status", "priority"],
  },
  editor: {
    sourceId: INCIDENT_SOURCE_ID,
    status: "idle",
    capabilities: {
      canCreate: false,
      canUpdate: false,
      canDelete: false,
      readOnly: true,
      reason: "Source metadata marks incidents read-only.",
    },
  },
  chart,
  searchFields: ["name", "status", "priority"],
});

const eventLog: string[] = [];
const runtime = {
  ready: false,
  events: eventLog,
  selectedFeatureId: undefined as string | number | undefined,
  layerVisible(layerId: string): boolean {
    return controller.getState().layers.find((layer) => layer.id === layerId)?.visible ?? false;
  },
  mapLayerVisible(layerId: string): boolean {
    const mapElement = document.querySelector("honua-map") as
      | (HTMLElement & { map?: { getLayoutProperty?(layerId: string, name: string): unknown } })
      | null;
    return mapElement?.map?.getLayoutProperty?.(layerId, "visibility") !== "none";
  },
  mapNonBlank(): boolean {
    const mapElement = document.querySelector("honua-map") as
      | (HTMLElement & {
          map?: {
            loaded?(): boolean;
            queryRenderedFeatures?(): readonly unknown[];
          };
        })
      | null;
    const canvas = mapElement?.shadowRoot?.querySelector("canvas");
    return Boolean(
      mapElement?.map?.loaded?.() &&
        canvas &&
        canvas.width > 0 &&
        canvas.height > 0 &&
        (mapElement.map.queryRenderedFeatures?.().length ?? 0) > 0,
    );
  },
};

window.__HONUA_WEB_COMPONENTS_DEMO__ = runtime;

const map = document.querySelector("honua-map");
if (!map) throw new Error("Missing honua-map");

map.addEventListener("honua-map-ready", () => {
  runtime.ready = true;
  eventLog.push("ready");
  writeEventLog();
});

map.addEventListener("honua-map-error", (event) => {
  const detail = (event as CustomEvent<{ message: string }>).detail;
  eventLog.push(`error:${detail.message}`);
  writeEventLog();
});

map.addEventListener("honua-map-click", (event) => {
  const detail = (event as CustomEvent<{ featureId?: string | number }>).detail;
  eventLog.push(`click:${String(detail.featureId ?? "")}`);
  writeEventLog();
});

map.addEventListener("honua-map-hover", (event) => {
  const detail = (event as CustomEvent<{ hovering: boolean; featureId?: string | number }>).detail;
  if (!detail.hovering) return;
  eventLog.push(`hover:${String(detail.featureId ?? "")}`);
  writeEventLog();
});

map.addEventListener("honua-viewport-change", (event) => {
  const detail = (event as CustomEvent<{ zoom?: number }>).detail;
  eventLog.push(`viewport:${String(Math.round((detail.zoom ?? 0) * 10) / 10)}`);
  writeEventLog();
});

document.addEventListener("honua-layer-visibility-change", (event) => {
  const detail = (event as CustomEvent<{ layerId: string; visible: boolean }>).detail;
  eventLog.push(`layer:${detail.layerId}:${String(detail.visible)}`);
  writeEventLog();
});

document.addEventListener("honua-selection-change", (event) => {
  const detail = (event as CustomEvent<{ featureId?: string | number }>).detail;
  runtime.selectedFeatureId = detail.featureId;
  eventLog.push(`select:${String(detail.featureId)}`);
  writeEventLog();
});

document.addEventListener("honua-search", (event) => {
  const detail = (event as CustomEvent<{ query: string; results: readonly unknown[] }>).detail;
  eventLog.push(`search:${detail.query}:${detail.results.length}`);
  writeEventLog();
});

document.addEventListener("honua-filter-change", (event) => {
  const detail = (event as CustomEvent<{ sourceId?: string; text?: string }>).detail;
  eventLog.push(`filter:${detail.sourceId ?? ""}:${detail.text ?? ""}`);
  writeEventLog();
});

map.controller = controller;

function writeEventLog(): void {
  const target = document.querySelector("#event-log");
  if (target) target.textContent = eventLog.at(-1) ?? "";
}
