import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

import { type HonuaAppLifecycleEvent, createHonuaApp } from "@honua/sdk-js/app";
import type { HonuaMapPackage } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_APP_BOOTSTRAP_DEMO__?: {
      ready: boolean;
      status: string;
      eventTypes: string[];
      mapNonBlank(): boolean;
    };
  }
}

const features = [
  { id: 1, name: "Harbor response district", status: "Open", priority: "High", coordinates: [-157.87, 21.31] },
  { id: 2, name: "Kakaako utility corridor", status: "Monitoring", priority: "Medium", coordinates: [-157.86, 21.29] },
  { id: 3, name: "Ala Moana shelter route", status: "Closed", priority: "Low", coordinates: [-157.84, 21.3] },
] as const;

const mapPackage: HonuaMapPackage = {
  mapPackageId: "app-bootstrap-demo",
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
      incidents: {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: features.map((feature) => ({
            type: "Feature",
            id: feature.id,
            properties: {
              name: feature.name,
              status: feature.status,
              priority: feature.priority,
            },
            geometry: {
              type: "Point",
              coordinates: feature.coordinates,
            },
          })),
        },
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
        source: "incidents",
        type: "circle",
        metadata: { title: "Incident halos" },
        paint: {
          "circle-radius": 17,
          "circle-color": "#2563eb",
          "circle-opacity": 0.18,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      },
      {
        id: "incident-points",
        source: "incidents",
        type: "circle",
        metadata: { title: "Incident points" },
        paint: {
          "circle-radius": 7,
          "circle-color": [
            "match",
            ["get", "priority"],
            "High",
            "#dc2626",
            "Medium",
            "#d97706",
            "Low",
            "#16a34a",
            "#64748b",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      },
    ],
  },
};

const mapContainer = document.querySelector<HTMLElement>("#map");
const status = document.querySelector<HTMLElement>("#status");
const summary = document.querySelector<HTMLElement>("#summary");
const eventLog = document.querySelector<HTMLUListElement>("#events");
if (!mapContainer || !status || !summary || !eventLog) {
  throw new Error("App bootstrap example markup is incomplete.");
}
const mapTarget = mapContainer;
const statusTarget = status;
const summaryTarget = summary;
const eventLogTarget = eventLog;

const eventTypes: string[] = [];
const mode = new URLSearchParams(window.location.search).get("mode") ?? "inline";
const setStatus = (value: string): void => {
  statusTarget.textContent = value;
  window.__HONUA_APP_BOOTSTRAP_DEMO__ = {
    ready: value === "ready",
    status: value,
    eventTypes,
    mapNonBlank,
  };
};

function onLifecycle(event: HonuaAppLifecycleEvent): void {
  eventTypes.push(event.type);
  if (event.type === "status") setStatus(event.status);
  if (event.type === "package-ready")
    summaryTarget.textContent = `${event.mapPackage.mapSpec.layers.length} layers ready`;
  if (event.type === "degraded") summaryTarget.textContent = event.reason;
  const item = document.createElement("li");
  item.textContent = event.type;
  eventLogTarget.prepend(item);
}

void createHonuaApp({
  ...(mode === "url"
    ? { baseUrl: window.location.origin, packageId: "app-bootstrap-demo" }
    : mode === "error"
      ? { baseUrl: window.location.origin, packageId: "secure-map" }
      : { baseUrl: "https://mock.honua.test", mapPackage }),
  mapContainer,
  mapFactory: ({ container, mapPackage: pkg }) =>
    new maplibregl.Map({
      container: container ?? mapTarget,
      style: { version: 8, sources: {}, layers: [] },
      center: pkg.initialView?.center ? [...pkg.initialView.center] : [-157.86, 21.3],
      zoom: pkg.initialView?.zoom ?? 10,
      attributionControl: false,
      // MapLibre 5 and 6 take WebGL context attributes here; a top-level
      // `preserveDrawingBuffer` is silently ignored, which would make the
      // web-component snapshot export read a blank canvas.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    }),
  load: { skipCompatibilityCheck: true },
  webComponents: {
    featuresBySource: {
      incidents: features.map((feature) => ({
        id: feature.id,
        sourceId: "incidents",
        title: feature.name,
        attributes: {
          name: feature.name,
          status: feature.status,
          priority: feature.priority,
        },
        geometry: { x: feature.coordinates[0], y: feature.coordinates[1] },
      })),
    },
  },
  onEvent: onLifecycle,
}).catch((error: unknown) => {
  setStatus("error");
  summaryTarget.textContent = error instanceof Error ? error.message : String(error);
});

function mapNonBlank(): boolean {
  const canvas = mapTarget.querySelector("canvas");
  if (!canvas) return false;
  return canvas.width > 0 && canvas.height > 0;
}
