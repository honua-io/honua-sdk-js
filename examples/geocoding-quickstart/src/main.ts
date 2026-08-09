import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

import type { GeocodeResult } from "@honua/sdk-js/geocoding";
import * as maplibregl from "maplibre-gl";

import { resolveGeocodingQuickstartConfig } from "./config.js";
import { GEOCODING_FIXTURE_CENTER, GEOCODING_FIXTURE_ZOOM, OAHU_URBAN_CORE_OUTLINE } from "./fixtures.js";
import {
  createGeocodingAuditRows,
  createGeocodingClient,
  emptyGeocodingFeatureCollection,
  formatCoordinate,
  geocodeResultsToFeatures,
} from "./model.js";
import type { GeocodingPointFeatureCollection } from "./types.js";

import "./styles.css";

interface GeocodingDemoRuntime {
  readonly ready: boolean;
  readonly mode: "fixture-only";
  readonly locatorName: string;
  readonly endpoint: string;
  readonly resultCount: number;
  readonly markerCount: number;
  readonly selectedAddress: string | null;
  readonly selectedScore: number | null;
  readonly selectedCoordinates: readonly [number, number] | null;
  readonly lastError: string | null;
  selectResult(index: number): void;
}

declare global {
  interface Window {
    __HONUA_GEOCODING_DEMO__?: GeocodingDemoRuntime;
  }
}

const CANDIDATE_SOURCE_ID = "geocoding-candidates";
const CANDIDATE_LAYER_ID = "geocoding-candidates-layer";
const OUTLINE_SOURCE_ID = "geocoding-fixture-outline";
const config = resolveGeocodingQuickstartConfig();
const client = createGeocodingClient(config);
const [auditRow] = createGeocodingAuditRows(config);
const endpointPath = `/rest/services/${encodeURIComponent(config.locatorName)}/GeocodeServer/findAddressCandidates`;

let ready = false;
let results: GeocodeResult[] = [];
let selectedIndex = -1;
let selectedMarker: maplibregl.Marker | null = null;
let lastError: string | null = null;

window.__HONUA_GEOCODING_DEMO__ = {
  get ready() {
    return ready;
  },
  get mode() {
    return config.mode;
  },
  get locatorName() {
    return config.locatorName;
  },
  get endpoint() {
    return endpointPath;
  },
  get resultCount() {
    return results.length;
  },
  get markerCount() {
    return selectedMarker ? 1 : 0;
  },
  get selectedAddress() {
    return results[selectedIndex]?.address ?? null;
  },
  get selectedScore() {
    return results[selectedIndex]?.score ?? null;
  },
  get selectedCoordinates() {
    const result = results[selectedIndex];
    return result ? ([result.longitude, result.latitude] as const) : null;
  },
  get lastError() {
    return lastError;
  },
  selectResult,
};

const map = new maplibregl.Map({
  container: "map",
  center: GEOCODING_FIXTURE_CENTER,
  zoom: GEOCODING_FIXTURE_ZOOM,
  attributionControl: false,
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#bedbd9" },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

function candidateLabel(result: GeocodeResult): string {
  const placeName = result.attributes.PlaceName;
  return placeName ? `${placeName} - ${result.address}` : result.address;
}

function updateGeoJsonSource(collection: GeocodingPointFeatureCollection): void {
  const source = map.getSource(CANDIDATE_SOURCE_ID);
  if (source && "setData" in source) {
    (source as { setData(data: GeocodingPointFeatureCollection): void }).setData(collection);
  }
}

function renderOptions(): void {
  const select = getElement<HTMLSelectElement>("#address-select");
  select.replaceChildren();
  results.forEach((result, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = candidateLabel(result);
    select.append(option);
  });
  select.disabled = results.length === 0;
}

function markerElement(): HTMLElement {
  const element = document.createElement("div");
  element.className = "selected-marker";
  element.setAttribute("aria-hidden", "true");
  const pin = document.createElement("span");
  pin.className = "selected-marker__pin";
  element.append(pin);
  return element;
}

function renderSelectedResult(animate: boolean): void {
  const result = results[selectedIndex];
  if (!result) return;

  const select = getElement<HTMLSelectElement>("#address-select");
  select.value = String(selectedIndex);
  setText("#selected-address", result.address);
  setText(
    "#selected-detail",
    `${result.attributes.Addr_type ?? "Candidate"} / score ${Math.round(result.score)} / ${config.locatorName} locator`,
  );
  setText("#selected-coordinates", `${formatCoordinate(result.longitude)}, ${formatCoordinate(result.latitude)}`);
  setText("#candidate-count", String(results.length));

  const coordinates: [number, number] = [result.longitude, result.latitude];
  if (!selectedMarker) {
    selectedMarker = new maplibregl.Marker({ element: markerElement(), anchor: "bottom" })
      .setLngLat(coordinates)
      .addTo(map);
  } else {
    selectedMarker.setLngLat(coordinates);
  }

  if (animate) {
    map.easeTo({ center: coordinates, zoom: Math.max(map.getZoom(), 13.8), duration: 450 });
  }
}

function selectResult(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= results.length) return;
  selectedIndex = index;
  renderSelectedResult(true);
}

function fitResults(collection: GeocodingPointFeatureCollection): void {
  const bounds = new maplibregl.LngLatBounds();
  for (const feature of collection.features) bounds.extend(feature.geometry.coordinates);
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 72, maxZoom: 13, duration: 0 });
  }
}

function addMapLayers(): void {
  map.addSource(OUTLINE_SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [OAHU_URBAN_CORE_OUTLINE] },
  });
  map.addLayer({
    id: "geocoding-fixture-outline-fill",
    type: "fill",
    source: OUTLINE_SOURCE_ID,
    paint: { "fill-color": "#f4eddb", "fill-opacity": 0.96 },
  });
  map.addLayer({
    id: "geocoding-fixture-outline-line",
    type: "line",
    source: OUTLINE_SOURCE_ID,
    paint: { "line-color": "#52736f", "line-width": 2 },
  });
  map.addSource(CANDIDATE_SOURCE_ID, { type: "geojson", data: emptyGeocodingFeatureCollection() });
  map.addLayer({
    id: CANDIDATE_LAYER_ID,
    type: "circle",
    source: CANDIDATE_SOURCE_ID,
    paint: {
      "circle-color": "#0c6f68",
      "circle-radius": 7,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
}

async function start(): Promise<void> {
  setText("#endpoint-state", auditRow.endpoint);
  getElement<HTMLSelectElement>("#address-select").addEventListener("change", (event) => {
    selectResult(Number((event.currentTarget as HTMLSelectElement).value));
  });

  await new Promise<void>((resolve) => {
    map.once("load", () => {
      addMapLayers();
      map.getCanvas().setAttribute("aria-label", "Interactive map of reviewed Honolulu geocoding candidates");
      resolve();
    });
  });

  try {
    results = await client.forwardGeocode(config.initialQuery, {
      maxResults: config.maxResults,
      spatialReferenceWkid: 4326,
    });
    if (results.length === 0) throw new Error("The fixture returned no address candidates.");

    const collection = geocodeResultsToFeatures(results);
    updateGeoJsonSource(collection);
    renderOptions();
    selectedIndex = 0;
    renderSelectedResult(false);
    fitResults(collection);
    setText("#status-message", `${results.length} reviewed addresses ready to select.`);
  } catch (error) {
    lastError = error instanceof Error ? error.message : "The geocoding fixture could not be loaded.";
    setText("#status-message", `Fixture unavailable: ${lastError}`);
  } finally {
    ready = true;
  }
}

void start();
