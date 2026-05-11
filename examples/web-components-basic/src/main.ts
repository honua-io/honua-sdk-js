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
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers: [
        {
          id: "incident-points",
          source: INCIDENT_SOURCE_ID,
          type: "circle",
          metadata: { title: "Public safety incidents" },
          paint: { "circle-color": "#dc2626" },
        },
        {
          id: "incident-labels",
          source: INCIDENT_SOURCE_ID,
          type: "symbol",
          metadata: { title: "Incident labels" },
          paint: { "text-color": "#172033" },
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
};

window.__HONUA_WEB_COMPONENTS_DEMO__ = runtime;

const map = document.querySelector("honua-map");
if (!map) throw new Error("Missing honua-map");
map.controller = controller;

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

function writeEventLog(): void {
  const target = document.querySelector("#event-log");
  if (target) target.textContent = eventLog.at(-1) ?? "";
}

runtime.ready = true;
