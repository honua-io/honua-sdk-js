/**
 * Repeated mount/unmount leak evidence and WebGL context-loss recovery
 * evidence for the deck.gl adapter (issue #562, REQ-004). Two independent,
 * self-contained harness functions share the page's single `#deck-canvas`
 * but each owns its own `Deck` instance end to end, so the runner may call
 * either — or both, in either order — from one page load.
 */
import { Deck, type Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";

import {
  type DeckGlAdapter,
  type DeckGlMountedProjection,
  bindDeckGlContextLossRecovery,
  createDeckGlAdapter,
} from "../../src/deckgl/index.js";
import { buildBinaryPointFixture } from "./fixture.js";

const ROWS = 10_000;
const INTERACTION_TARGET_INDEX = 4_949;
const LAYER_ID = "honua-deck-lifecycle-points";

interface LeakCycleSample {
  readonly cycle: number;
  readonly heapBytesAfterDispose: number | null;
  readonly layerCountAfterDispose: number;
}

interface LeakRunEvidence {
  readonly cycles: number;
  readonly warmupCycles: number;
  readonly rows: number;
  readonly samples: readonly LeakCycleSample[];
  /** Growth from the first post-warmup sample to the last; `null` when the memory API is unavailable. */
  readonly heapGrowthBytes: number | null;
  readonly memoryApiAvailable: boolean;
  readonly allLayersClearedAfterEachDispose: boolean;
  readonly addRemoveBalanced: boolean;
}

interface ContextLossEvidence {
  readonly loseContextExtensionAvailable: boolean;
  readonly contextLostFired: boolean;
  /**
   * True once the app-level recovery (dispose + swap to a fresh canvas +
   * rebuild) has completed. This is not the browser's native
   * `webglcontextrestored` event: deck.gl/luma.gl do not reliably resume
   * rendering when a *second* `Deck` is bound to the *same* canvas after a
   * synthetic restore (observed directly — a real run reproducibly throws
   * "object does not belong to this context" / "no valid shader program in
   * use" from luma.gl's internal GPU resource cache, and nothing draws).
   * Discarding the canvas is the same mitigation real deck.gl apps use.
   */
  readonly recoveryCompleted: boolean;
  readonly recoveredRenderOk: boolean;
  readonly recoveryMs: number;
  /** After recovery there must be exactly one mounted layer, never zero (dropped) or more than one (duplicate remount). */
  readonly layerCountAfterRecovery: number;
  readonly message: string;
}

interface LifecycleHarness {
  runLeakCycles(cycles: number, warmupCycles: number): Promise<LeakRunEvidence>;
  runContextLossRecovery(): Promise<ContextLossEvidence>;
}

declare global {
  interface Window {
    __HONUA_DECKGL_LIFECYCLE_HARNESS__?: LifecycleHarness;
  }
}

function currentHeapBytes(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
}

function forceGcIfAvailable(): void {
  (window as unknown as { gc?: () => void }).gc?.();
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = performance.now();
    function poll(): void {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (performance.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(poll);
    }
    poll();
  });
}

function requiredElement<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Lifecycle benchmark DOM is incomplete: missing ${label}`);
  return value;
}

// Bound to a non-null type here (not narrowed-and-hoped) so every function
// below — including hoisted declarations that close over these — sees a
// definite `HTMLCanvasElement`/`HTMLOutputElement`, not `T | null`.
const canvas = requiredElement(document.querySelector<HTMLCanvasElement>("#deck-canvas"), "#deck-canvas");
const status = requiredElement(document.querySelector<HTMLOutputElement>("#status"), "#status");

function createDeckInstance(targetCanvas: HTMLCanvasElement): { deck: Deck; firstFrame: Promise<void> } {
  let resolveFirstFrame: (() => void) | undefined;
  const firstFrame = new Promise<void>((resolve) => {
    resolveFirstFrame = resolve;
  });
  const deck = new Deck({
    canvas: targetCanvas,
    width: "100%",
    height: "100%",
    controller: false,
    initialViewState: { longitude: -157.8583, latitude: 21.3069, zoom: 11, pitch: 0, bearing: 0 },
    layers: [],
    onAfterRender: () => {
      resolveFirstFrame?.();
      resolveFirstFrame = undefined;
    },
  });
  return { deck, firstFrame };
}

function mountBinaryScatterplot(
  deck: Deck,
  counts: { adds: number; removes: number },
): { adapter: DeckGlAdapter; mounted: DeckGlMountedProjection } {
  const fixture = buildBinaryPointFixture(ROWS, { interactionTargetIndex: INTERACTION_TARGET_INDEX });
  const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer } });
  const projection = adapter.project({
    layer: "scatterplot",
    layerId: LAYER_ID,
    data: {
      length: ROWS,
      attributes: {
        getPosition: { value: fixture.positions, size: 2 },
        getRadius: { value: fixture.radii, size: 1 },
        getFillColor: { value: fixture.colors, size: 4, normalized: true },
      },
    },
    identity: {
      sourceId: "benchmark-fixture-lifecycle",
      planId: "plan:benchmark-browser-lifecycle-v1",
      sourceVersion: "fixture-v1",
      featureIds: fixture.featureIds,
    },
    props: { radiusUnits: "meters", radiusMinPixels: 2, stroked: false },
  });
  let mountedLayer: unknown;
  const mounted = projection.mount({
    addLayer(layer) {
      mountedLayer = layer;
      counts.adds += 1;
      deck.setProps({ layers: [layer as Layer] });
    },
    removeLayer(layer) {
      if (mountedLayer === layer) {
        mountedLayer = undefined;
        counts.removes += 1;
        deck.setProps({ layers: [] });
      }
    },
  });
  return { adapter, mounted };
}

function currentLayerCount(deck: Deck): number {
  return (deck as unknown as { props: { layers: unknown[] } }).props.layers.length;
}

async function runLeakCycles(cycles: number, warmupCycles: number): Promise<LeakRunEvidence> {
  const { deck } = createDeckInstance(canvas);
  const counts = { adds: 0, removes: 0 };
  const samples: LeakCycleSample[] = [];
  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const { adapter, mounted } = mountBinaryScatterplot(deck, counts);
      await nextAnimationFrame();
      mounted.dispose();
      adapter.dispose();
      await nextAnimationFrame();
      forceGcIfAvailable();
      samples.push({
        cycle,
        heapBytesAfterDispose: currentHeapBytes(),
        layerCountAfterDispose: currentLayerCount(deck),
      });
      status.value = `Lifecycle cycle ${cycle + 1}/${cycles}`;
    }
  } finally {
    deck.finalize();
  }

  const measured = samples.slice(warmupCycles);
  const first = measured[0]?.heapBytesAfterDispose ?? null;
  const last = measured.at(-1)?.heapBytesAfterDispose ?? null;
  const heapGrowthBytes = first !== null && last !== null ? last - first : null;

  return {
    cycles,
    warmupCycles,
    rows: ROWS,
    samples,
    heapGrowthBytes,
    memoryApiAvailable: samples.some((sample) => sample.heapBytesAfterDispose !== null),
    allLayersClearedAfterEachDispose: samples.every((sample) => sample.layerCountAfterDispose === 0),
    addRemoveBalanced: counts.adds === counts.removes && counts.adds === cycles,
  };
}

/** Detached clone: same id/class/aria-label, no bound WebGL context — the fresh canvas the "lost" one is swapped for. */
function cloneCanvasWithoutContext(source: HTMLCanvasElement): HTMLCanvasElement {
  const clone = source.cloneNode(false) as HTMLCanvasElement;
  source.replaceWith(clone);
  return clone;
}

async function runContextLossRecovery(): Promise<ContextLossEvidence> {
  const counts = { adds: 0, removes: 0 };
  let activeCanvas = canvas;
  let { deck, firstFrame } = createDeckInstance(activeCanvas);
  let { adapter, mounted } = mountBinaryScatterplot(deck, counts);
  await firstFrame;
  await nextAnimationFrame();

  const gl = activeCanvas.getContext("webgl2") as WebGL2RenderingContext | null;
  const loseContextExtension = gl?.getExtension("WEBGL_lose_context") ?? null;
  if (!gl || !loseContextExtension) {
    mounted.dispose();
    adapter.dispose();
    deck.finalize();
    return {
      loseContextExtensionAvailable: false,
      contextLostFired: false,
      recoveryCompleted: false,
      recoveredRenderOk: false,
      recoveryMs: 0,
      layerCountAfterRecovery: 0,
      message: "WEBGL_lose_context is unavailable; context-loss recovery cannot be exercised on this device.",
    };
  }

  let lostFired = false;
  let recoveryCompleted = false;
  const recoveryStart = performance.now();
  const binding = bindDeckGlContextLossRecovery(activeCanvas, {
    onLost: () => {
      lostFired = true;
      status.value = "WebGL context lost; swapping to a fresh canvas";
      // Best-effort: GPU calls made against a lost context are no-ops/errors
      // in most drivers, but disposal must still release JS-side references.
      try {
        mounted.dispose();
      } catch {
        // Expected on some drivers once the context is already lost.
      }
      try {
        adapter.dispose();
      } catch {
        // Same.
      }
      try {
        deck.finalize();
      } catch {
        // Tearing down a device bound to an already-lost context can itself
        // warn/throw on some drivers; the fresh canvas below is what matters.
      }
      activeCanvas = cloneCanvasWithoutContext(activeCanvas);
      const rebuilt = createDeckInstance(activeCanvas);
      deck = rebuilt.deck;
      firstFrame = rebuilt.firstFrame;
      const remounted = mountBinaryScatterplot(deck, counts);
      adapter = remounted.adapter;
      mounted = remounted.mounted;
      firstFrame.then(() => {
        recoveryCompleted = true;
        status.value = "Recovered on a fresh canvas; rebuilding complete";
      });
    },
    // The native `webglcontextrestored` event on the *old* canvas is
    // deliberately not used to drive recovery (see `ContextLossEvidence`'s
    // `recoveryCompleted` doc). `restoreContext()` is intentionally never
    // called: this binding still proves the loss listener attaches/detaches
    // correctly (see the unit tests in test/deckgl-lifecycle.test.ts), and
    // the old canvas is abandoned before restoration would matter.
  });

  loseContextExtension.loseContext();
  await waitFor(() => lostFired, 2_000);
  await waitFor(() => recoveryCompleted, 8_000);
  await nextAnimationFrame();
  const recoveryMs = performance.now() - recoveryStart;

  let recoveredRenderOk = false;
  if (recoveryCompleted) {
    const picked = deck.pickObject({
      x: activeCanvas.clientWidth / 2,
      y: activeCanvas.clientHeight / 2,
      radius: 12,
      layerIds: [LAYER_ID],
    });
    recoveredRenderOk = picked?.index === INTERACTION_TARGET_INDEX;
  }
  const layerCountAfterRecovery = currentLayerCount(deck);
  status.value = recoveryCompleted
    ? recoveredRenderOk
      ? "Recovered: picking proof passed"
      : "Recovered but picking proof failed"
    : "Did not recover within budget";

  binding.dispose();
  try {
    mounted.dispose();
  } catch {
    // Already disposed by onLost, or the rebuilt mount was never reached.
  }
  try {
    adapter.dispose();
  } catch {
    // Same.
  }
  try {
    deck.finalize();
  } catch {
    // Same tolerance as the onLost handler above.
  }

  return {
    loseContextExtensionAvailable: true,
    contextLostFired: lostFired,
    recoveryCompleted,
    recoveredRenderOk,
    recoveryMs,
    layerCountAfterRecovery,
    message: recoveryCompleted
      ? recoveredRenderOk
        ? "Context loss recovered (fresh-canvas rebuild) and the re-mounted layer resumed picking."
        : "Recovery rebuilt the layer but it failed the picking proof."
      : "Recovery did not complete within budget after context loss.",
  };
}

window.__HONUA_DECKGL_LIFECYCLE_HARNESS__ = { runLeakCycles, runContextLossRecovery };
