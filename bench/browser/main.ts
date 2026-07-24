import { Deck, type Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";

import { createDeckGlAdapter } from "../../src/deckgl/index.js";
import { buildBinaryPointFixture, webGlRendererString } from "./fixture.js";

interface BrowserBenchmarkHarness {
  readonly renderer: "deck.gl";
  readonly ready: Promise<DeckReadyEvidence>;
  runInteraction(): Promise<DeckInteractionEvidence>;
  dispose(): void;
}

interface DeckReadyEvidence {
  readonly firstVisibleMs: number;
  readonly rows: number;
  readonly copiedBytes: number;
  readonly pickableAtCenter: boolean;
  readonly webglRenderer: string;
}

interface DeckInteractionEvidence {
  readonly interactionLatencyMs: number;
  readonly selectedFeatureId: number;
  readonly visibleOutcome: string;
}

declare global {
  interface Window {
    __HONUA_BROWSER_BENCHMARK__?: BrowserBenchmarkHarness;
    __HONUA_BROWSER_BENCH_STARTED__?: number;
  }
}

const ROWS = 10_000;
const CENTER_LONGITUDE = -157.8583;
const CENTER_LATITUDE = 21.3069;

// The runner injects this before document/module loading so the metric includes
// bundle fetch, parsing, and SDK/renderer initialization just like MapLibre.
const startedAt = window.__HONUA_BROWSER_BENCH_STARTED__ ?? performance.now();
const canvas = document.querySelector<HTMLCanvasElement>("#deck-canvas");
const status = document.querySelector<HTMLOutputElement>("#status");
if (!canvas || !status) throw new Error("Browser benchmark DOM is incomplete");

const fixture = buildBinaryPointFixture(ROWS);
const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer } });
const projection = adapter.project({
  layer: "scatterplot",
  layerId: "honua-deck-points",
  data: {
    length: ROWS,
    attributes: {
      getPosition: { value: fixture.positions, size: 2 },
      getRadius: { value: fixture.radii, size: 1 },
      getFillColor: { value: fixture.colors, size: 4, normalized: true },
    },
  },
  identity: {
    sourceId: "benchmark-fixture",
    planId: "plan:benchmark-browser-v1",
    sourceVersion: "fixture-v1",
    featureIds: fixture.featureIds,
  },
  props: {
    radiusUnits: "meters",
    radiusMinPixels: 2,
    stroked: false,
  },
});

let firstFrameResolve: (() => void) | undefined;
const firstFrame = new Promise<void>((resolve) => {
  firstFrameResolve = resolve;
});
const deck = new Deck({
  canvas,
  width: "100%",
  height: "100%",
  controller: false,
  initialViewState: {
    longitude: CENTER_LONGITUDE,
    latitude: CENTER_LATITUDE,
    zoom: 11,
    pitch: 0,
    bearing: 0,
  },
  layers: [],
  onAfterRender: () => {
    firstFrameResolve?.();
    firstFrameResolve = undefined;
  },
});

let mountedLayer: unknown;
const mounted = projection.mount({
  addLayer(layer) {
    mountedLayer = layer;
    // The SDK contract deliberately exposes only the peer-neutral layer shape;
    // this harness injected ScatterplotLayer, so the runtime value is a Layer.
    deck.setProps({ layers: [layer as Layer] });
  },
  removeLayer(layer) {
    if (mountedLayer === layer) {
      mountedLayer = undefined;
      deck.setProps({ layers: [] });
    }
  },
});

const ready = (async (): Promise<DeckReadyEvidence> => {
  await firstFrame;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const picked = deck.pickObject({
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2,
    radius: 12,
    layerIds: ["honua-deck-points"],
  });
  const pickableAtCenter = picked?.index === 4_949;
  status.value = pickableAtCenter ? `${ROWS.toLocaleString()} binary points ready` : "Render failed picking proof";
  return {
    firstVisibleMs: performance.now() - startedAt,
    rows: projection.metrics.rows,
    copiedBytes: projection.metrics.copiedBytes,
    pickableAtCenter,
    webglRenderer: webGlRendererString(canvas),
  };
})();

window.__HONUA_BROWSER_BENCHMARK__ = {
  renderer: "deck.gl",
  ready,
  async runInteraction() {
    await ready;
    const interactionStartedAt = performance.now();
    const picked = deck.pickObject({
      x: canvas.clientWidth / 2,
      y: canvas.clientHeight / 2,
      radius: 12,
      layerIds: ["honua-deck-points"],
    });
    if (picked?.index !== 4_949) throw new Error("deck.gl interaction did not pick the center fixture row");
    const selection = projection.selectionForPick(picked.index);
    status.value = `Selected feature ${String(selection.featureId)}`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      interactionLatencyMs: performance.now() - interactionStartedAt,
      selectedFeatureId: Number(selection.featureId),
      visibleOutcome: status.value,
    };
  },
  dispose() {
    mounted.dispose();
    adapter.dispose();
    deck.finalize();
  },
};
