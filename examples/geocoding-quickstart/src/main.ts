import "maplibre-gl/dist/maplibre-gl.css";

import type { GeocodeResult, GeocodeSuggestion, ReverseGeocodeResult } from "@honua/sdk-js/geocoding";
import maplibregl from "maplibre-gl";

import { resolveGeocodingQuickstartConfig } from "./config.js";
import { GEOCODING_FIXTURE_CENTER, GEOCODING_FIXTURE_ZOOM, OAHU_URBAN_CORE_OUTLINE } from "./fixtures.js";
import {
  createGeocodingAuditRows,
  createGeocodingClient,
  emptyGeocodingFeatureCollection,
  formatCoordinate,
  geocodeResultsToFeatures,
  reverseResultToFeature,
} from "./model.js";
import type { GeocodingAuditRow, GeocodingPointFeature, GeocodingPointFeatureCollection } from "./types.js";

import "./styles.css";

interface GeocodingDemoRuntime {
  readonly ready: boolean;
  readonly mode: string;
  readonly locatorName: string;
  readonly endpointBase: string;
  readonly forwardCount: number;
  readonly suggestions: readonly string[];
  readonly reverseAddress: string | null;
  readonly auditRows: readonly GeocodingAuditRow[];
  readonly lastError: string | null;
  runForward(query: string): Promise<GeocodeResult[]>;
  runReverse(latitude: number, longitude: number): Promise<ReverseGeocodeResult | null>;
  typeahead(query: string): Promise<GeocodeSuggestion[]>;
}

declare global {
  interface Window {
    __HONUA_GEOCODING_DEMO__?: GeocodingDemoRuntime;
  }
}

const FORWARD_SOURCE_ID = "geocoding-forward-results";
const FORWARD_LAYER_ID = "geocoding-forward-results-layer";
const REVERSE_SOURCE_ID = "geocoding-reverse-result";
const REVERSE_LAYER_ID = "geocoding-reverse-result-layer";
const OUTLINE_SOURCE_ID = "geocoding-fixture-outline";

const config = resolveGeocodingQuickstartConfig(import.meta.env);
const client = createGeocodingClient(config);
const auditRows = createGeocodingAuditRows(config.locatorName);
const endpointBase = `/rest/services/${encodeURIComponent(config.locatorName)}/GeocodeServer`;

let ready = false;
let mapReady = false;
let forwardResults: GeocodeResult[] = [];
let suggestions: GeocodeSuggestion[] = [];
let reverseResult: ReverseGeocodeResult | null = null;
let lastError: string | null = null;
let lastOperation = "Initializing";
let suggestTimer: ReturnType<typeof setTimeout> | undefined;

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
  get endpointBase() {
    return endpointBase;
  },
  get forwardCount() {
    return forwardResults.length;
  },
  get suggestions() {
    return suggestions.map((suggestion) => suggestion.text);
  },
  get reverseAddress() {
    return reverseResult?.address ?? null;
  },
  get auditRows() {
    return auditRows;
  },
  get lastError() {
    return lastError;
  },
  runForward,
  runReverse,
  typeahead,
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
        paint: {
          "background-color": "#e8eef2",
        },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function featureSummary(feature: GeocodingPointFeature): string {
  return `${formatCoordinate(feature.properties.latitude)}, ${formatCoordinate(feature.properties.longitude)}`;
}

function setBusy(isBusy: boolean): void {
  getElement<HTMLButtonElement>("#forward-submit").disabled = isBusy;
  getElement<HTMLInputElement>("#address-input").disabled = isBusy;
}

function renderStatus(): void {
  setText("#mode-state", config.mode === "live" ? "Live Honua" : "Fixture safe mode");
  setText("#locator-state", config.locatorName);
  setText("#endpoint-state", endpointBase);
  setText("#map-endpoint-state", endpointBase);
  setText("#operation-state", lastError ? "Error" : lastOperation);
  setText(
    "#map-coordinate",
    reverseResult ? `${reverseResult.longitude.toFixed(5)}, ${reverseResult.latitude.toFixed(5)}` : "-",
  );
  setText("#error-state", lastError ?? "None");
}

function renderAuditRows(): void {
  const table = getElement<HTMLElement>("#audit-table");
  table.innerHTML = auditRows
    .map(
      (row) => `
        <article>
          <strong>${escapeHtml(row.capability)}</strong>
          <span>${escapeHtml(row.interaction)}</span>
          <code>${escapeHtml(row.sdkSurface)}</code>
          <small>${escapeHtml(row.endpoint)}</small>
          <em>${escapeHtml(row.cachePolicy)}</em>
        </article>
      `,
    )
    .join("");
}

function renderForwardResults(): void {
  const list = getElement<HTMLElement>("#forward-results");
  list.innerHTML = "";

  if (forwardResults.length === 0) {
    list.innerHTML = '<div class="empty-copy">No forward geocode matches.</div>';
    setText("#forward-count", "0 candidates");
    return;
  }

  setText("#forward-count", `${forwardResults.length} candidate${forwardResults.length === 1 ? "" : "s"}`);
  forwardResults.forEach((result, index) => {
    const item = document.createElement("article");
    item.className = "result-row";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(result.address)}</strong>
        <span>${escapeHtml(result.attributes.Addr_type ?? "Candidate")} / score ${Math.round(result.score)}</span>
      </div>
    `;

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.resultIndex = String(index);
    button.textContent = "Show";
    button.addEventListener("click", () => focusForwardResult(index));
    item.append(button);
    list.append(item);
  });
}

function renderSuggestions(nextSuggestions: readonly GeocodeSuggestion[]): void {
  const list = getElement<HTMLElement>("#suggestion-list");
  list.innerHTML = "";

  if (nextSuggestions.length === 0) {
    list.innerHTML = '<div class="empty-copy">No suggestions.</div>';
    return;
  }

  for (const suggestion of nextSuggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-button";
    button.textContent = suggestion.text;
    button.addEventListener("click", () => {
      getElement<HTMLInputElement>("#address-input").value = suggestion.text;
      suggestions = [];
      renderSuggestions([]);
      void runForward(suggestion.text);
    });
    list.append(button);
  }
}

function renderReverseResult(): void {
  if (!reverseResult) {
    setText("#reverse-address", "No address selected");
    setText("#reverse-detail", "-");
    return;
  }

  setText("#reverse-address", reverseResult.address);
  setText(
    "#reverse-detail",
    `${formatCoordinate(reverseResult.latitude)}, ${formatCoordinate(reverseResult.longitude)} / ${
      reverseResult.attributes.Addr_type ?? reverseResult.attributes.City ?? "nearest address"
    }`,
  );
}

function updateGeoJsonSource(sourceId: string, collection: GeocodingPointFeatureCollection): void {
  const source = map.getSource(sourceId);
  if (source && "setData" in source) {
    (source as { setData(data: GeocodingPointFeatureCollection): void }).setData(collection);
  }
}

function showPopup(feature: GeocodingPointFeature): void {
  new maplibregl.Popup({ closeButton: true, closeOnClick: true })
    .setLngLat(feature.geometry.coordinates)
    .setHTML(
      `<strong>${escapeHtml(feature.properties.address)}</strong><span>${escapeHtml(featureSummary(feature))}</span>`,
    )
    .addTo(map);
}

function focusFeature(feature: GeocodingPointFeature): void {
  map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), essential: true });
  showPopup(feature);
}

function focusForwardResult(index: number): void {
  const feature = geocodeResultsToFeatures(forwardResults).features[index];
  if (feature) focusFeature(feature);
}

function fitForwardResults(features: readonly GeocodingPointFeature[]): void {
  if (features.length === 0) return;
  if (features.length === 1) {
    map.flyTo({ center: features[0].geometry.coordinates, zoom: 14, essential: true });
    return;
  }

  const bounds = new maplibregl.LngLatBounds();
  for (const feature of features) {
    bounds.extend(feature.geometry.coordinates);
  }
  map.fitBounds(bounds, { padding: 96, maxZoom: 14, essential: true });
}

function addMapLayers(): void {
  map.addSource(OUTLINE_SOURCE_ID, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: [OAHU_URBAN_CORE_OUTLINE],
    },
  });
  map.addLayer({
    id: "geocoding-fixture-outline-fill",
    type: "fill",
    source: OUTLINE_SOURCE_ID,
    paint: {
      "fill-color": "#dbe9df",
      "fill-opacity": 0.82,
    },
  });
  map.addLayer({
    id: "geocoding-fixture-outline-line",
    type: "line",
    source: OUTLINE_SOURCE_ID,
    paint: {
      "line-color": "#56706a",
      "line-width": 2,
    },
  });

  map.addSource(FORWARD_SOURCE_ID, {
    type: "geojson",
    data: emptyGeocodingFeatureCollection(),
  });
  map.addLayer({
    id: FORWARD_LAYER_ID,
    type: "circle",
    source: FORWARD_SOURCE_ID,
    paint: {
      "circle-color": "#0f766e",
      "circle-radius": 8,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });

  map.addSource(REVERSE_SOURCE_ID, {
    type: "geojson",
    data: emptyGeocodingFeatureCollection(),
  });
  map.addLayer({
    id: REVERSE_LAYER_ID,
    type: "circle",
    source: REVERSE_SOURCE_ID,
    paint: {
      "circle-color": "#c2410c",
      "circle-radius": 9,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });

  map.on("click", FORWARD_LAYER_ID, (event) => {
    const feature = event.features?.[0] as GeocodingPointFeature | undefined;
    if (feature) focusFeature(feature);
  });
  map.on("mouseenter", FORWARD_LAYER_ID, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", FORWARD_LAYER_ID, () => {
    map.getCanvas().style.cursor = "";
  });
}

async function runForward(query: string): Promise<GeocodeResult[]> {
  const searchText = query.trim();
  if (!searchText) return forwardResults;

  setBusy(true);
  lastError = null;
  lastOperation = "Forward geocode";
  renderStatus();

  try {
    const results = await client.forwardGeocode(searchText, {
      maxResults: config.maxResults,
      spatialReferenceWkid: 4326,
      ...(config.countryCodes ? { countryCodes: config.countryCodes } : {}),
    });
    forwardResults = results;
    const collection = geocodeResultsToFeatures(results);
    renderForwardResults();
    updateGeoJsonSource(FORWARD_SOURCE_ID, collection);
    fitForwardResults(collection.features);
    lastOperation = `Forward geocode / ${results.length} result${results.length === 1 ? "" : "s"}`;
    return results;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Forward geocode failed";
    renderForwardResults();
    return [];
  } finally {
    setBusy(false);
    renderStatus();
  }
}

async function typeahead(query: string): Promise<GeocodeSuggestion[]> {
  const searchText = query.trim();
  if (searchText.length < 2) {
    suggestions = [];
    renderSuggestions(suggestions);
    return suggestions;
  }

  lastError = null;
  lastOperation = "Suggest";
  renderStatus();

  try {
    suggestions = await client.suggest(searchText, {
      maxSuggestions: config.maxSuggestions,
      ...(config.countryCodes ? { countryCodes: config.countryCodes } : {}),
    });
    renderSuggestions(suggestions);
    lastOperation = `Suggest / ${suggestions.length} hint${suggestions.length === 1 ? "" : "s"}`;
    return suggestions;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Suggest failed";
    suggestions = [];
    renderSuggestions(suggestions);
    return [];
  } finally {
    renderStatus();
  }
}

async function runReverse(latitude: number, longitude: number): Promise<ReverseGeocodeResult | null> {
  lastError = null;
  lastOperation = "Reverse geocode";
  renderStatus();

  try {
    reverseResult = await client.reverseGeocode(latitude, longitude, { spatialReferenceWkid: 4326 });
    renderReverseResult();
    const collection = reverseResultToFeature(reverseResult);
    updateGeoJsonSource(REVERSE_SOURCE_ID, collection);
    if (collection.features[0]) showPopup(collection.features[0]);
    lastOperation = reverseResult ? "Reverse geocode / address found" : "Reverse geocode / no address";
    return reverseResult;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Reverse geocode failed";
    reverseResult = null;
    renderReverseResult();
    updateGeoJsonSource(REVERSE_SOURCE_ID, emptyGeocodingFeatureCollection());
    return null;
  } finally {
    renderStatus();
  }
}

function wireControls(): void {
  const form = getElement<HTMLFormElement>("#forward-form");
  const input = getElement<HTMLInputElement>("#address-input");
  input.value = config.initialQuery;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runForward(input.value);
  });

  input.addEventListener("input", () => {
    if (suggestTimer !== undefined) clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => {
      void typeahead(input.value);
    }, 160);
  });

  map.on("click", (event) => {
    void runReverse(event.lngLat.lat, event.lngLat.lng);
  });
}

async function start(): Promise<void> {
  renderAuditRows();
  renderForwardResults();
  renderSuggestions([]);
  renderReverseResult();
  renderStatus();
  wireControls();

  await new Promise<void>((resolve) => {
    map.once("load", () => {
      addMapLayers();
      mapReady = true;
      resolve();
    });
  });

  await runForward(config.initialQuery);
  ready = mapReady;
  renderStatus();
}

start().catch((error: unknown) => {
  lastError = error instanceof Error ? error.message : "Geocoding demo failed to start";
  ready = true;
  renderStatus();
});
