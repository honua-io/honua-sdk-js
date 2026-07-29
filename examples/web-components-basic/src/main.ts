import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

// Side-effect import registers <honua-basemap-switcher> and
// <honua-swipe-control>. <honua-legend> also has a controller-driven
// implementation in the web-components kit below, and that implementation is
// the tag's canonical/default registrant (@honua/sdk-js/controls' `catalog.ts`,
// issue #679) — so claiming this demo's map-driven, derive-mode legend
// instead is the explicit, ordered `./register-controls-legend.js` import
// just below, not an import-order accident.
import "@honua/sdk-js/controls";
import "./register-controls-legend.js";
import type {
  HonuaBasemapDefinition,
  HonuaBasemapSwitcherChangeDetail,
  HonuaBasemapSwitcherElement,
} from "@honua/sdk-js/controls";
import { HonuaLayerListElement, HonuaLegendElement } from "@honua/sdk-js/controls";
import {
  type HonuaChartModel,
  type HonuaFeatureRecord,
  type HonuaSearchElement,
  type HonuaSearchGeocodeCandidate,
  type HonuaSearchGeocodeSuggestion,
  type HonuaSearchGeocoderLike,
  createHonuaWebComponentController,
} from "@honua/sdk-js/web-components";

import "./styles.css";

// The browser qualification lane needs to exercise the native controls-kit
// layer list alongside this demo's canonical web-components registrant. Keep
// the alternate tag opt-in so the normal sample still demonstrates the public
// `<honua-layer-list>` tag without changing its ownership.
if (new URLSearchParams(window.location.search).has("controls-layer-list")) {
  customElements.define("honua-controls-layer-list", HonuaLayerListElement);
  customElements.define("honua-controls-legend", HonuaLegendElement);
}

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
const ZONING_SOURCE_ID = "zoning";

// Categorical zoning districts. The fill layer styles them with a MapLibre
// match expression on the "district" attribute, and <honua-legend> derives
// its swatch rows from that same expression — one source of truth, so map
// and legend cannot drift.
function zoningPolygon(district: string, ring: [number, number][]) {
  return {
    type: "Feature",
    properties: { district },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

const zoningGeoJson = {
  type: "FeatureCollection",
  features: [
    zoningPolygon("Residential", [
      [-157.88, 21.305],
      [-157.862, 21.305],
      [-157.862, 21.32],
      [-157.88, 21.32],
      [-157.88, 21.305],
    ]),
    zoningPolygon("Business", [
      [-157.862, 21.29],
      [-157.845, 21.29],
      [-157.845, 21.305],
      [-157.862, 21.305],
      [-157.862, 21.29],
    ]),
    zoningPolygon("Open-Park", [
      [-157.845, 21.285],
      [-157.83, 21.285],
      [-157.83, 21.3],
      [-157.845, 21.3],
      [-157.845, 21.285],
    ]),
  ],
};

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
        [ZONING_SOURCE_ID]: {
          type: "geojson",
          data: zoningGeoJson,
        },
      },
      layers: [
        {
          id: "zoning-districts",
          source: ZONING_SOURCE_ID,
          type: "fill",
          metadata: { title: "Zoning districts" },
          paint: {
            "fill-color": [
              "match",
              ["get", "district"],
              "Residential",
              "#facc15",
              "Agricultural",
              "#84cc16",
              "Business",
              "#ef4444",
              "Industrial",
              "#a855f7",
              "Hotel",
              "#fb923c",
              "Open-Park",
              "#22c55e",
              "#cbd5e1",
            ],
            "fill-opacity": 0.35,
            "fill-outline-color": "#475569",
          },
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

document.addEventListener("honua-geocode-select", (event) => {
  const detail = (event as CustomEvent<{ candidate: { address: string } }>).detail;
  eventLog.push(`geocode:${detail.candidate.address}`);
  writeEventLog();
});

document.addEventListener("honua-layer-opacity-change", (event) => {
  const detail = (event as CustomEvent<{ layerId: string; opacity: number }>).detail;
  eventLog.push(`opacity:${detail.layerId}:${String(Math.round(detail.opacity * 100))}`);
  writeEventLog();
});

document.addEventListener("honua-layer-order-change", (event) => {
  const detail = (event as CustomEvent<{ layerId: string; order: readonly string[] }>).detail;
  eventLog.push(`reorder:${detail.layerId}:${detail.order.join(",")}`);
  writeEventLog();
});

document.addEventListener("honua-filter-change", (event) => {
  const detail = (event as CustomEvent<{ sourceId?: string; text?: string }>).detail;
  eventLog.push(`filter:${detail.sourceId ?? ""}:${detail.text ?? ""}`);
  writeEventLog();
});

// Exclusive basemap definitions for <honua-basemap-switcher>. The mock lane
// stays offline, so the composite "Terrain" base pairs a background with an
// inline GeoJSON contour layer; against a live Honua deployment the same
// definition shape carries a pmtiles:// vector base plus a raster-dem
// hillshade (see @honua/sdk-js/controls docs).
const demoBasemaps: HonuaBasemapDefinition[] = [
  {
    id: "light",
    label: "Light",
    kind: "vector",
    sources: {},
    layers: [{ id: "base-light", type: "background", paint: { "background-color": "#e8eef7" } }],
  },
  {
    id: "dark",
    label: "Dark",
    kind: "vector",
    sources: {},
    layers: [{ id: "base-dark", type: "background", paint: { "background-color": "#203040" } }],
  },
  {
    id: "terrain",
    label: "Terrain",
    kind: "raster-dem-composite",
    sources: {
      "demo-contours": {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [-157.92, -157.88, -157.84, -157.8].map((lng) => ({
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [lng, 21.25],
                [lng + 0.02, 21.35],
              ],
            },
          })),
        },
      },
    },
    layers: [
      { id: "base-terrain", type: "background", paint: { "background-color": "#e2ead9" } },
      {
        id: "base-terrain-contours",
        type: "line",
        source: "demo-contours",
        paint: { "line-color": "#9db89a", "line-width": 1 },
      },
    ],
  },
];

const basemapSwitcher = document.querySelector("honua-basemap-switcher") as HonuaBasemapSwitcherElement | null;
if (!basemapSwitcher) throw new Error("Missing honua-basemap-switcher");

basemapSwitcher.addEventListener("change", (event) => {
  const detail = (event as CustomEvent<HonuaBasemapSwitcherChangeDetail>).detail;
  eventLog.push(`basemap:${detail.value}`);
  writeEventLog();
});

// The element also self-wires from for="ops-map" + the honua-map-ready event;
// assigning the bases is the only imperative step the host performs.
basemapSwitcher.bases = demoBasemaps;

// <honua-legend> combines explicit entries (the incident symbology below)
// with a section derived from the zoning layer's match expression (layer=
// "zoning-districts" in the markup). follow-layer-visibility hides the
// zoning section while the layer is toggled off in the layer list, and
// auto-refresh re-derives on the map's styledata events.
const legend = document.querySelector("honua-legend") as HonuaLegendElement | null;
if (!legend) throw new Error("Missing honua-legend");
legend.entries = [
  {
    title: "Incident priority",
    layer: "incident-points",
    entries: [
      { label: "High priority", color: "#dc2626", shape: "circle" },
      { label: "Medium priority", color: "#d97706", shape: "circle" },
      { label: "Low priority", color: "#16a34a", shape: "circle" },
    ],
  },
];

document.addEventListener("honua-bookmark-change", (event) => {
  const detail = (event as CustomEvent<{ id: string }>).detail;
  eventLog.push(`bookmark:${detail.id}`);
  writeEventLog();
});

document.addEventListener("honua-locate-change", (event) => {
  const detail = (event as CustomEvent<{ status: string }>).detail;
  eventLog.push(`locate:${detail.status}`);
  writeEventLog();
});

document.addEventListener("honua-measure-change", (event) => {
  const detail = (event as CustomEvent<{ mode: string; status: string }>).detail;
  eventLog.push(`measure:${detail.mode}:${detail.status}`);
  writeEventLog();
});

document.addEventListener("honua-sketch-change", (event) => {
  const detail = (event as CustomEvent<{ mode: string; status: string }>).detail;
  eventLog.push(`sketch:${detail.mode}:${detail.status}`);
  writeEventLog();
});

document.addEventListener("honua-export", (event) => {
  const detail = (event as CustomEvent<{ format: string; status: string }>).detail;
  eventLog.push(`export:${detail.format}:${detail.status}`);
  writeEventLog();
});

document.addEventListener("honua-fullscreen-change", (event) => {
  const detail = (event as CustomEvent<{ status: string }>).detail;
  eventLog.push(`fullscreen:${detail.status}`);
  writeEventLog();
});

document.addEventListener("honua-action", (event) => {
  const detail = (event as CustomEvent<{ id: string; status: string }>).detail;
  eventLog.push(`action:${detail.id}:${detail.status}`);
  writeEventLog();
});

// ── Survival-tier geocoding search (issue #493) ─────────────────────────────
// The `geocoder` property accepts any provider structurally compatible with
// HonuaGeocodingClient (`@honua/sdk-js/geocoding`). Against a live Honua
// deployment this is simply:
//
//   import { HonuaGeocodingClient } from "@honua/sdk-js/geocoding";
//   placeSearch.geocoder = new HonuaGeocodingClient({ baseUrl, locatorName });
//
// The offline mock lane stays network-free, so the same seam is exercised with
// a tiny in-memory gazetteer provider instead.
const gazetteer: readonly (HonuaSearchGeocodeCandidate & { keywords: string })[] = [
  {
    address: "Honolulu Harbor, Honolulu, HI",
    latitude: 21.306,
    longitude: -157.867,
    score: 100,
    keywords: "harbor honolulu port",
  },
  {
    address: "Kakaako Waterfront Park, Honolulu, HI",
    latitude: 21.29,
    longitude: -157.858,
    score: 98,
    keywords: "kakaako waterfront park",
  },
  {
    address: "Ala Moana Regional Park, Honolulu, HI",
    latitude: 21.29,
    longitude: -157.847,
    score: 97,
    keywords: "ala moana park beach",
  },
  {
    address: "Diamond Head State Monument, Honolulu, HI",
    latitude: 21.262,
    longitude: -157.806,
    score: 96,
    keywords: "diamond head crater",
  },
  {
    address: "Daniel K. Inouye International Airport, Honolulu, HI",
    latitude: 21.324,
    longitude: -157.925,
    score: 95,
    keywords: "airport hnl inouye",
  },
];

function matchGazetteer(text: string): (HonuaSearchGeocodeCandidate & { keywords: string })[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  return gazetteer.filter((entry) => entry.address.toLowerCase().includes(needle) || entry.keywords.includes(needle));
}

const demoGeocoder: HonuaSearchGeocoderLike = {
  async suggest(text, options): Promise<readonly HonuaSearchGeocodeSuggestion[]> {
    return matchGazetteer(text)
      .slice(0, options?.maxSuggestions ?? 5)
      .map((entry) => ({ text: entry.address }));
  },
  async forwardGeocode(address, options): Promise<readonly HonuaSearchGeocodeCandidate[]> {
    return matchGazetteer(address)
      .slice(0, options?.maxResults ?? 1)
      .map(({ keywords: _keywords, ...candidate }) => candidate);
  },
};

const placeSearch = document.querySelector<HonuaSearchElement>("#place-search");
if (!placeSearch) throw new Error("Missing #place-search");
placeSearch.geocoder = demoGeocoder;

map.controller = controller;

function writeEventLog(): void {
  const target = document.querySelector("#event-log");
  if (target) target.textContent = eventLog.at(-1) ?? "";
}
