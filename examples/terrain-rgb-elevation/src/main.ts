import "maplibre-gl/dist/maplibre-gl.css";

import { HonuaClient, type MapLibreSceneRuntimeTarget, applyMapLibreScenePrimitives } from "@honua/sdk-js/honua";
import maplibregl from "maplibre-gl";

import { clientOptionsFromTerrainConfig, resolveTerrainElevationConfig, terrainRequestHeaders } from "./config.js";
import {
  createDefaultTerrainDataset,
  createFixtureElevationProfile,
  createTerrainRenderPlan,
  createTerrainScenePrimitives,
  formatElevationMeters,
  hydrateTerrainRenderPlan,
  lookupTerrainElevation,
  profileDistanceMeters,
  queryTerrainElevationProfile,
  summarizeTerrainCache,
  summarizeTerrainCapabilities,
} from "./model.js";
import type { TerrainCoordinate, TerrainElevationProfile, TerrainElevationSample, TerrainRenderPlan } from "./types.js";

import "./styles.css";

interface TerrainElevationRuntime {
  readonly ready: boolean;
  readonly tileTemplates: readonly string[];
  readonly profileSampleCount: number;
  readonly lastElevationMeters: number | undefined;
  lookupAt(longitude: number, latitude: number): Promise<void>;
  startProfile(): void;
  addProfileVertex(longitude: number, latitude: number): void;
  finishProfile(): Promise<void>;
  useFixtureProfile(): Promise<void>;
  clearProfile(): void;
}

declare global {
  interface Window {
    __HONUA_TERRAIN_ELEVATION_DEMO__?: TerrainElevationRuntime;
  }
}

type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: {
      type: "Point" | "LineString";
      coordinates: TerrainCoordinate | TerrainCoordinate[];
    };
  }>;
};

const config = resolveTerrainElevationConfig(import.meta.env);
const client = new HonuaClient(clientOptionsFromTerrainConfig(config));
const authHeaders = terrainRequestHeaders(config);
const dataset = createDefaultTerrainDataset(config.serviceId);
let renderPlan = createTerrainRenderPlan(dataset, client);
let selectedSample: TerrainElevationSample | undefined;
let profile: TerrainElevationProfile | undefined;
let profileLine: TerrainCoordinate[] = [];
let drawingProfile = false;
let pointStatus = "Click the map to query one elevation value.";
let profileStatus = "No line profile queried.";

const map = new maplibregl.Map({
  container: "map",
  center: [...dataset.center],
  zoom: dataset.zoom,
  pitch: 48,
  bearing: -18,
  attributionControl: false,
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#e8ece1" },
      },
    ],
  },
  transformRequest(url) {
    if (authHeaders && url.startsWith(client.serverBaseUrl)) {
      return { url, headers: authHeaders };
    }
    return { url };
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
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

function render(): void {
  renderStatus();
  renderPoint();
  renderProfile();
  renderAudit();
}

function renderStatus(): void {
  setText("#mode-state", config.mode === "live" ? "Live Honua" : "Fixture safe mode");
  setText("#capability-state", summarizeTerrainCapabilities(renderPlan));
  setText("#cache-state", summarizeTerrainCache(renderPlan.dataset));
  setText("#metadata-state", metadataLabel(renderPlan));
  setText("#endpoint-state", `${client.serverBaseUrl} / Terrain-RGB plus elevation endpoints`);
}

function renderPoint(): void {
  if (!selectedSample) {
    setText("#point-elevation", "-");
    setText("#point-location", "-");
    setText("#point-source", pointStatus);
    return;
  }

  setText("#point-elevation", formatElevationMeters(selectedSample.elevationMeters));
  setText("#point-location", `${selectedSample.longitude.toFixed(5)}, ${selectedSample.latitude.toFixed(5)}`);
  setText(
    "#point-source",
    `${selectedSample.verticalDatum} / ${selectedSample.resolutionMeters} m source resolution / ${selectedSample.endpointPath}`,
  );
}

function renderProfile(): void {
  setText(
    "#draw-state",
    drawingProfile ? `${profileLine.length} vertex line in progress` : `${profileLine.length} vertices`,
  );
  getElement<HTMLButtonElement>("#finish-profile").disabled = profileLine.length < 2;

  if (!profile) {
    setText("#profile-summary", profileStatus);
    getElement<HTMLElement>("#profile-chart").innerHTML = '<p class="empty-copy">Profile samples will appear here.</p>';
    return;
  }

  const distanceKm = profileDistanceMeters(profile) / 1000;
  setText(
    "#profile-summary",
    `${profile.samples.length} samples / ${distanceKm.toFixed(1)} km / ${formatElevationMeters(
      profile.minElevationMeters,
    )}-${formatElevationMeters(profile.maxElevationMeters)} / gain ${formatElevationMeters(profile.gainMeters)}`,
  );
  getElement<HTMLElement>("#profile-chart").innerHTML = createProfileChart(profile);
}

function renderAudit(): void {
  getElement<HTMLElement>("#audit-table").innerHTML = renderPlan.auditRows
    .map(
      (row) => `
        <article>
          <strong>${escapeHtml(row.capability)}</strong>
          <span>${escapeHtml(row.uiFeature)}</span>
          <code>${escapeHtml(row.endpoint)}</code>
          <small>${escapeHtml(row.sdkSurface)} / ${escapeHtml(row.cachePolicy)}</small>
        </article>
      `,
    )
    .join("");
}

function metadataLabel(plan: TerrainRenderPlan): string {
  if (plan.metadataError) return `metadata warning: ${plan.metadataError}`;
  if (!plan.metadata) return "metadata loading";
  const layerCount = plan.metadata.layers?.length ?? 0;
  return `${plan.metadata.serviceDescription ?? plan.dataset.tileset.title} / ${layerCount} layer(s)`;
}

function createProfileChart(elevationProfile: TerrainElevationProfile): string {
  const width = 360;
  const height = 132;
  const pad = 18;
  const distance = profileDistanceMeters(elevationProfile) || 1;
  const min = elevationProfile.minElevationMeters;
  const max = elevationProfile.maxElevationMeters;
  const span = Math.max(1, max - min);
  const points = elevationProfile.samples
    .map((sample) => {
      const x = pad + (sample.distanceMeters / distance) * (width - pad * 2);
      const y = height - pad - ((sample.elevationMeters - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const first = elevationProfile.samples[0];
  const last = elevationProfile.samples.at(-1);
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Elevation profile chart">
      <path class="profile-grid" d="M ${pad} ${height - pad} H ${width - pad} M ${pad} ${pad} V ${height - pad}"></path>
      <polyline class="profile-line" points="${escapeHtml(points)}"></polyline>
      ${
        first && last
          ? `<text x="${pad}" y="${height - 4}">${escapeHtml(formatElevationMeters(first.elevationMeters))}</text>
             <text x="${width - pad}" y="${height - 4}" text-anchor="end">${escapeHtml(
               formatElevationMeters(last.elevationMeters),
             )}</text>`
          : ""
      }
    </svg>
  `;
}

function addMapLayers(plan: TerrainRenderPlan): void {
  applyMapLibreScenePrimitives(mapLibreSceneTarget(), createTerrainScenePrimitives(plan));

  if (!map.getLayer(plan.hillshadeLayerId)) {
    map.addLayer({
      id: plan.hillshadeLayerId,
      type: "hillshade",
      source: plan.sourceId,
      paint: {
        "hillshade-shadow-color": "#40513f",
        "hillshade-highlight-color": "#f5f0d9",
        "hillshade-accent-color": "#b47937",
      },
    });
  }

  map.addSource(plan.profileSourceId, { type: "geojson", data: lineFeatureCollection(profileLine) as never });
  map.addSource(plan.profileVertexSourceId, { type: "geojson", data: pointFeatureCollection(profileLine) as never });
  map.addSource(plan.lookupSourceId, { type: "geojson", data: lookupFeatureCollection(selectedSample) as never });

  map.addLayer({
    id: "terrain-profile-stroke",
    type: "line",
    source: plan.profileSourceId,
    paint: {
      "line-color": "#d97706",
      "line-width": 4,
      "line-opacity": 0.92,
    },
  });
  map.addLayer({
    id: "terrain-profile-vertices-layer",
    type: "circle",
    source: plan.profileVertexSourceId,
    paint: {
      "circle-radius": 5,
      "circle-color": "#7c2d12",
      "circle-stroke-color": "#fff7ed",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "terrain-lookup-point-layer",
    type: "circle",
    source: plan.lookupSourceId,
    paint: {
      "circle-radius": 7,
      "circle-color": "#0f766e",
      "circle-stroke-color": "#f8fafc",
      "circle-stroke-width": 2,
    },
  });
}

function mapLibreSceneTarget(): MapLibreSceneRuntimeTarget {
  return {
    getSource(id) {
      return map.getSource(id);
    },
    addSource(id, source) {
      map.addSource(id, source as never);
    },
    getLayer(id) {
      return map.getLayer(id);
    },
    addLayer(layer) {
      map.addLayer(layer as never);
    },
    setTerrain(options) {
      map.setTerrain(options);
    },
  };
}

function fitDatasetExtent(): void {
  map.fitBounds(
    [
      [dataset.extent.xmin, dataset.extent.ymin],
      [dataset.extent.xmax, dataset.extent.ymax],
    ],
    { padding: 54, duration: 350 },
  );
}

async function lookupAt(coordinate: TerrainCoordinate): Promise<void> {
  pointStatus = "Querying elevation value endpoint.";
  renderPoint();
  try {
    selectedSample = await lookupTerrainElevation(renderPlan, client, coordinate);
    pointStatus = "Elevation endpoint response loaded.";
  } catch (error) {
    selectedSample = undefined;
    pointStatus = `Elevation lookup failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
  updateLookupSource();
  renderPoint();
}

function startProfile(): void {
  drawingProfile = true;
  profileLine = [];
  profile = undefined;
  profileStatus = "Line drawing started.";
  updateProfileSources();
  renderProfile();
}

function addProfileVertex(coordinate: TerrainCoordinate): void {
  profileLine = [...profileLine, coordinate];
  profile = undefined;
  profileStatus = profileLine.length < 2 ? "Add one more vertex before querying a profile." : "Line ready for profile.";
  updateProfileSources();
  renderProfile();
}

async function finishProfile(): Promise<void> {
  if (profileLine.length < 2) return;
  drawingProfile = false;
  profileStatus = "Querying elevation profile endpoint.";
  renderProfile();
  try {
    profile = await queryTerrainElevationProfile(renderPlan, client, profileLine);
    profileStatus = "Elevation profile endpoint response loaded.";
  } catch (error) {
    profile = createFixtureElevationProfile(profileLine, renderPlan.dataset.tileset.endpointPaths.elevationProfile);
    profileStatus = `Fixture profile fallback: ${error instanceof Error ? error.message : "profile endpoint unavailable"}`;
  }
  renderProfile();
}

async function useFixtureProfile(): Promise<void> {
  drawingProfile = false;
  profileLine = [...dataset.profileLine];
  updateProfileSources();
  await finishProfile();
}

function clearProfile(): void {
  drawingProfile = false;
  profileLine = [];
  profile = undefined;
  profileStatus = "No line profile queried.";
  updateProfileSources();
  renderProfile();
}

function updateProfileSources(): void {
  (map.getSource(renderPlan.profileSourceId) as maplibregl.GeoJSONSource | undefined)?.setData(
    lineFeatureCollection(profileLine) as never,
  );
  (map.getSource(renderPlan.profileVertexSourceId) as maplibregl.GeoJSONSource | undefined)?.setData(
    pointFeatureCollection(profileLine) as never,
  );
}

function updateLookupSource(): void {
  (map.getSource(renderPlan.lookupSourceId) as maplibregl.GeoJSONSource | undefined)?.setData(
    lookupFeatureCollection(selectedSample) as never,
  );
}

function lineFeatureCollection(line: readonly TerrainCoordinate[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features:
      line.length >= 2
        ? [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: [...line] },
            },
          ]
        : [],
  };
}

function pointFeatureCollection(line: readonly TerrainCoordinate[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: line.map((coordinate, index) => ({
      type: "Feature",
      properties: { index },
      geometry: { type: "Point", coordinates: coordinate },
    })),
  };
}

function lookupFeatureCollection(sample: TerrainElevationSample | undefined): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: sample
      ? [
          {
            type: "Feature",
            properties: { elevationMeters: sample.elevationMeters },
            geometry: { type: "Point", coordinates: [sample.longitude, sample.latitude] },
          },
        ]
      : [],
  };
}

getElement<HTMLButtonElement>("#zoom-extent").addEventListener("click", fitDatasetExtent);
getElement<HTMLButtonElement>("#start-profile").addEventListener("click", startProfile);
getElement<HTMLButtonElement>("#finish-profile").addEventListener("click", () => {
  void finishProfile();
});
getElement<HTMLButtonElement>("#clear-profile").addEventListener("click", clearProfile);
getElement<HTMLButtonElement>("#fixture-profile").addEventListener("click", () => {
  void useFixtureProfile();
});

map.on("click", (event) => {
  const coordinate: TerrainCoordinate = [event.lngLat.lng, event.lngLat.lat];
  if (drawingProfile) {
    addProfileVertex(coordinate);
    return;
  }
  void lookupAt(coordinate);
});

map.once("load", async () => {
  addMapLayers(renderPlan);
  fitDatasetExtent();
  render();
  renderPlan = await hydrateTerrainRenderPlan(renderPlan, client);
  render();
  window.__HONUA_TERRAIN_ELEVATION_DEMO__ = {
    ready: true,
    get tileTemplates() {
      return renderPlan.sourceSpec.tiles;
    },
    get profileSampleCount() {
      return profile?.samples.length ?? 0;
    },
    get lastElevationMeters() {
      return selectedSample?.elevationMeters;
    },
    async lookupAt(longitude: number, latitude: number) {
      await lookupAt([longitude, latitude]);
    },
    startProfile,
    addProfileVertex(longitude: number, latitude: number) {
      addProfileVertex([longitude, latitude]);
    },
    async finishProfile() {
      await finishProfile();
    },
    async useFixtureProfile() {
      await useFixtureProfile();
    },
    clearProfile,
  };
});
