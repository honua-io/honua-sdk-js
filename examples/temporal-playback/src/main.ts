import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

import { createTemporalPlayback } from "@honua/sdk-js/map";
import type { TemporalPlayback, TemporalPlaybackTick } from "@honua/sdk-js/map";
import { classBreaksRenderer } from "@honua/sdk-js/style";
// Side-effect import registers <honua-time-slider> (issue #959) along with the
// rest of the component kit.
import "@honua/sdk-js/web-components";
import type { HonuaTimeSliderElement } from "@honua/sdk-js/web-components";
import * as maplibregl from "maplibre-gl";

import "./styles.css";

// ── Deterministic time-enabled fixture (mock lane, no network) ──────────────
// A month of synthetic seismic events around the Hawaiian islands. The seeded
// PRNG keeps the fixture byte-stable across builds so smoke checks can assert
// against it.

const DAY = 24 * 60 * 60 * 1000;
const EXTENT_START = Date.parse("2026-06-01T00:00:00Z");
const EXTENT_END = EXTENT_START + 30 * DAY;
const SOURCE_ID = "quakes";
const LAYER_ID = "quakes-points";

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface QuakeProperties {
  id: number;
  time: number;
  magnitude: number;
}

interface QuakeFeature {
  type: "Feature";
  id: number;
  properties: QuakeProperties;
  geometry: { type: "Point"; coordinates: [number, number] };
}

interface QuakeCollection {
  type: "FeatureCollection";
  features: QuakeFeature[];
}

function buildFixture(): QuakeCollection {
  const random = mulberry32(497);
  const features: QuakeFeature[] = [];
  for (let id = 0; id < 240; id++) {
    const time = EXTENT_START + Math.floor(random() * 30 * DAY);
    const magnitude = Math.round((1 + random() * 5.5) * 10) / 10;
    features.push({
      type: "Feature",
      id,
      properties: { id, time, magnitude },
      geometry: {
        type: "Point",
        coordinates: [
          Math.round((-157.9 + (random() - 0.5) * 3.4) * 1e4) / 1e4,
          Math.round((20.7 + (random() - 0.5) * 2.2) * 1e4) / 1e4,
        ],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

// ── Renderer object: graduated magnitude classes (issue #497) ───────────────

const magnitudeRenderer = classBreaksRenderer({
  field: "magnitude",
  breaks: [
    { min: 0, max: 3, label: "Minor (< 3)" },
    { min: 3, max: 4.5, label: "Light (3 – 4.5)" },
    { min: 4.5, max: 6, label: "Moderate (4.5 – 6)" },
    { min: 6, label: "Strong (6+)" },
  ],
  colors: ["#fed976", "#fd8d3c", "#e31a1c", "#800026"],
  defaultColor: "#94a3b8",
  defaultLabel: "Unclassified",
});

// ── Demo shell state (read by smoke checks) ──────────────────────────────────

interface TemporalPlaybackDemoState {
  ready?: boolean;
  playing?: boolean;
  windowStart?: number;
  windowEnd?: number;
  visibleCount?: number;
  ticks?: number;
  error?: string;
}

declare global {
  interface Window {
    __temporalPlaybackState?: TemporalPlaybackDemoState;
  }
}

function patchState(patch: TemporalPlaybackDemoState): void {
  window.__temporalPlaybackState = { ...(window.__temporalPlaybackState ?? {}), ...patch };
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function renderLegend(): void {
  const list = document.getElementById("legend");
  if (!list) return;
  list.innerHTML = "";
  for (const item of magnitudeRenderer.legendItems()) {
    const entry = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = item.color;
    const label = document.createElement("span");
    label.textContent = item.label;
    entry.append(swatch, label);
    list.appendChild(entry);
  }
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function wireControls(playback: TemporalPlayback, map: maplibregl.Map): void {
  // Transport (play/pause, scrub, step, speed) is the element's job; it is a
  // view over this same controller and keeps no window state of its own.
  const timeSlider = document.getElementById("time-slider") as HonuaTimeSliderElement | null;
  if (timeSlider) timeSlider.playback = playback;

  const windowSelect = document.getElementById("window-select") as HTMLSelectElement | null;
  const windowReadout = document.getElementById("window-readout");
  const countReadout = document.getElementById("count-readout");
  let ticks = 0;

  windowSelect?.addEventListener("change", () => {
    playback.setWindow(Number(windowSelect.value) * DAY);
  });

  playback.on("play", () => {
    patchState({ playing: true });
  });
  playback.on("pause", () => {
    patchState({ playing: false });
  });
  playback.on("tick", (tick: TemporalPlaybackTick) => {
    ticks += 1;
    if (windowReadout) {
      windowReadout.textContent = `${formatDay(tick.window.start)} → ${formatDay(tick.window.end)}`;
    }
    // querySourceFeatures returns per-tile duplicates; dedupe by feature id.
    const visibleIds = new Set<number>();
    for (const feature of map.querySourceFeatures(SOURCE_ID)) {
      const time = Number(feature.properties?.time);
      if (time >= tick.window.start && time < tick.window.end) visibleIds.add(Number(feature.properties?.id));
    }
    const visible = visibleIds.size;
    if (countReadout) countReadout.textContent = String(visible);
    patchState({
      windowStart: tick.window.start,
      windowEnd: tick.window.end,
      visibleCount: visible,
      ticks,
    });
  });
}

async function main(): Promise<void> {
  const fixture = buildFixture();
  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#0b1120" } }],
    },
    center: [-157.9, 20.7],
    zoom: 6.2,
  });
  await map.once("load");

  map.addSource(SOURCE_ID, { type: "geojson", data: fixture as never });
  const [fragment] = magnitudeRenderer.toMapLibre("point");
  map.addLayer({
    id: LAYER_ID,
    type: "circle",
    source: SOURCE_ID,
    paint: {
      ...fragment.paint,
      "circle-radius": ["interpolate", ["linear"], ["get", "magnitude"], 1, 3, 6.5, 12],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 0.75,
      "circle-opacity": 0.85,
    } as never,
  });

  renderLegend();

  const playback = createTemporalPlayback({
    layer: { map, layerIds: [LAYER_ID] },
    timeField: "time",
    extent: [EXTENT_START, EXTENT_END],
    windowMs: 3 * DAY,
    stepMs: DAY,
    frameIntervalMs: 400,
    loop: true,
  });
  wireControls(playback, map);
  playback.scrub(EXTENT_START);
  patchState({ ready: true, playing: false });
}

void main().catch((error: unknown) => {
  patchState({ ready: true, error: error instanceof Error ? error.message : String(error) });
});
