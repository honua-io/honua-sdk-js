import { Deck, type Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";

import { createDeckGlAdapter } from "../../src/deckgl/index.js";

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

function buildBinaryFixture(rows: number) {
  const positions = new Float32Array(rows * 2);
  const radii = new Float32Array(rows);
  const colors = new Uint8Array(rows * 4);
  const featureIds = new Uint32Array(rows);
  for (let index = 0; index < rows; index += 1) {
    const column = index % 100;
    const row = Math.floor(index / 100);
    const isInteractionTarget = index === 4_949;
    // Keep one unambiguous point at viewport center. The rest remain visible in
    // a nearby grid but outside the center picking radius.
    positions[index * 2] = isInteractionTarget ? CENTER_LONGITUDE : CENTER_LONGITUDE + 0.05 + (column - 49.5) * 0.0005;
    positions[index * 2 + 1] = isInteractionTarget ? CENTER_LATITUDE : CENTER_LATITUDE + (row - 49.5) * 0.0005;
    radii[index] = index === 4_949 ? 220 : 70;
    colors.set(index === 4_949 ? [255, 218, 92, 255] : [52, 195, 181, 210], index * 4);
    featureIds[index] = 100_000 + index;
  }
  return { positions, radii, colors, featureIds };
}

function webGlRenderer(canvas: HTMLCanvasElement): string {
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl) return "unavailable";
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  if (!extension) return String(gl.getParameter(gl.RENDERER));
  return String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL));
}

// The runner injects this before document/module loading so the metric includes
// bundle fetch, parsing, and SDK/renderer initialization just like MapLibre.
const startedAt = window.__HONUA_BROWSER_BENCH_STARTED__ ?? performance.now();
const canvas = document.querySelector<HTMLCanvasElement>("#deck-canvas");
const status = document.querySelector<HTMLOutputElement>("#status");
if (!canvas || !status) throw new Error("Browser benchmark DOM is incomplete");

const fixture = buildBinaryFixture(ROWS);
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
    webglRenderer: webGlRenderer(canvas),
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
