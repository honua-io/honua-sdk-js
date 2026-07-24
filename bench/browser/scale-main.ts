/**
 * Staged deck.gl scale harness (issue #562, REQ-002/REQ-003). Row count is a
 * URL query parameter (`?rows=100000`) so one page serves every scale tier
 * `bench/browser/run.mjs` drives. Unlike `main.ts` (which reports a single
 * `firstVisibleMs`), this harness times SDK conversion, mount/transfer, GPU
 * upload + first frame, steady-state frame rate, picking, and disposal as
 * separate stages so a regression in one does not hide inside another.
 */
import { Deck, type Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";

import { createDeckGlAdapter } from "../../src/deckgl/index.js";
import { buildBinaryPointFixture, webGlRendererString } from "./fixture.js";

interface ScaleReadyEvidence {
  readonly conversionMs: number;
  readonly transferMs: number;
  readonly gpuUploadMs: number;
  /** Matches `main.ts`'s `firstVisibleMs`: page-bootstrap start to first painted frame. */
  readonly firstFrameMs: number;
  readonly rows: number;
  readonly copiedBytes: number;
  readonly pickableAtCenter: boolean;
  readonly webglRenderer: string;
  readonly memoryApiAvailable: boolean;
  readonly heapBytesAfterFirstFrame: number | null;
}

interface SteadyFrameRateEvidence {
  readonly steadyFrameRateFps: number;
  readonly frames: number;
  readonly elapsedMs: number;
  readonly heapBytesAfterSteadyFrames: number | null;
}

interface PickingEvidence {
  readonly pickingMs: number;
  readonly selectedFeatureId: number;
}

interface DisposalEvidence {
  readonly disposalMs: number;
  readonly heapBytesAfterDisposal: number | null;
}

interface ScaleBenchmarkHarness {
  readonly renderer: "deck.gl";
  readonly rows: number;
  readonly ready: Promise<ScaleReadyEvidence>;
  runSteadyFrameRate(frames: number): Promise<SteadyFrameRateEvidence>;
  runPicking(): Promise<PickingEvidence>;
  dispose(): DisposalEvidence;
}

declare global {
  interface Window {
    __HONUA_DECKGL_SCALE_BENCHMARK__?: ScaleBenchmarkHarness;
    __HONUA_BROWSER_BENCH_STARTED__?: number;
  }
}

const INTERACTION_TARGET_INDEX = 4_949;

function currentHeapBytes(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

const searchParams = new URLSearchParams(location.search);
const ROWS = Number(searchParams.get("rows") ?? "10000");
if (!Number.isSafeInteger(ROWS) || ROWS <= INTERACTION_TARGET_INDEX) {
  throw new Error(`Scale benchmark requires rows > ${INTERACTION_TARGET_INDEX}, got "${searchParams.get("rows")}"`);
}

// Injected before document/module loading so firstFrameMs includes bundle
// fetch, parsing, and SDK/renderer initialization, matching main.ts.
const startedAt = window.__HONUA_BROWSER_BENCH_STARTED__ ?? performance.now();
const canvas = document.querySelector<HTMLCanvasElement>("#deck-canvas");
const status = document.querySelector<HTMLOutputElement>("#status");
if (!canvas || !status) throw new Error("Scale benchmark DOM is incomplete");

const conversionStart = performance.now();
const fixture = buildBinaryPointFixture(ROWS, { interactionTargetIndex: INTERACTION_TARGET_INDEX });
const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer } });
const projection = adapter.project({
  layer: "scatterplot",
  layerId: "honua-deck-scale-points",
  data: {
    length: ROWS,
    attributes: {
      getPosition: { value: fixture.positions, size: 2 },
      getRadius: { value: fixture.radii, size: 1 },
      getFillColor: { value: fixture.colors, size: 4, normalized: true },
    },
  },
  identity: {
    sourceId: "benchmark-fixture-scale",
    planId: "plan:benchmark-browser-scale-v1",
    sourceVersion: "fixture-v1",
    featureIds: fixture.featureIds,
  },
  props: {
    radiusUnits: "meters",
    radiusMinPixels: 2,
    stroked: false,
  },
});
const conversionMs = performance.now() - conversionStart;

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
    longitude: -157.8583,
    latitude: 21.3069,
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
const transferStart = performance.now();
const mounted = projection.mount({
  addLayer(layer) {
    mountedLayer = layer;
    deck.setProps({ layers: [layer as Layer] });
  },
  removeLayer(layer) {
    if (mountedLayer === layer) {
      mountedLayer = undefined;
      deck.setProps({ layers: [] });
    }
  },
});
const transferMs = performance.now() - transferStart;

const ready = (async (): Promise<ScaleReadyEvidence> => {
  const gpuUploadStart = performance.now();
  await firstFrame;
  await nextAnimationFrame();
  const gpuUploadMs = performance.now() - gpuUploadStart;
  const picked = deck.pickObject({
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2,
    radius: 12,
    layerIds: ["honua-deck-scale-points"],
  });
  const pickableAtCenter = picked?.index === INTERACTION_TARGET_INDEX;
  status.value = pickableAtCenter
    ? `${ROWS.toLocaleString()} binary points ready`
    : "Scale render failed picking proof";
  return {
    conversionMs,
    transferMs,
    gpuUploadMs,
    firstFrameMs: performance.now() - startedAt,
    rows: projection.metrics.rows,
    copiedBytes: projection.metrics.copiedBytes,
    pickableAtCenter,
    webglRenderer: webGlRendererString(canvas),
    memoryApiAvailable: currentHeapBytes() !== null,
    heapBytesAfterFirstFrame: currentHeapBytes(),
  };
})();

window.__HONUA_DECKGL_SCALE_BENCHMARK__ = {
  renderer: "deck.gl",
  rows: ROWS,
  ready,
  async runSteadyFrameRate(frames: number): Promise<SteadyFrameRateEvidence> {
    await ready;
    let rendered = 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      function step(): void {
        deck.redraw("honua-bench-steady-frame");
        rendered += 1;
        if (rendered >= frames) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
    const elapsedMs = performance.now() - start;
    return {
      steadyFrameRateFps: elapsedMs > 0 ? (rendered / elapsedMs) * 1000 : 0,
      frames: rendered,
      elapsedMs,
      heapBytesAfterSteadyFrames: currentHeapBytes(),
    };
  },
  async runPicking(): Promise<PickingEvidence> {
    await ready;
    const start = performance.now();
    const picked = deck.pickObject({
      x: canvas.clientWidth / 2,
      y: canvas.clientHeight / 2,
      radius: 12,
      layerIds: ["honua-deck-scale-points"],
    });
    if (picked?.index !== INTERACTION_TARGET_INDEX)
      throw new Error("Scale benchmark picking did not resolve the center fixture row");
    const selection = projection.selectionForPick(picked.index);
    status.value = `Selected feature ${String(selection.featureId)}`;
    await nextAnimationFrame();
    return {
      pickingMs: performance.now() - start,
      selectedFeatureId: Number(selection.featureId),
    };
  },
  dispose(): DisposalEvidence {
    const start = performance.now();
    mounted.dispose();
    adapter.dispose();
    deck.finalize();
    return {
      disposalMs: performance.now() - start,
      heapBytesAfterDisposal: currentHeapBytes(),
    };
  },
};
