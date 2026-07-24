/**
 * Browser/device capability + fallback matrix harness (issue #562, REQ-001).
 * Collects WebGL facts with throwaway probe canvases (never the page's own
 * `#deck-canvas`, so a probe never pre-binds a context type Deck itself
 * needs), classifies them with the reviewed pure policy in
 * `capability-policy.mjs`, and only attempts a deck.gl mount when the
 * decision is "supported". A "fallback-maplibre" or "unsupported" decision
 * is reported explicitly instead — this harness proves the adapter's slice
 * chooses a bounded outcome rather than silently rendering a blank canvas.
 */
import { Deck, type Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";

import { createDeckGlAdapter } from "../../src/deckgl/index.js";
import {
  type DeckGlCapabilityDecision,
  type DeckGlCapabilityFacts,
  classifyDeckGlCapability,
} from "./capability-policy.mjs";
import { buildBinaryPointFixture } from "./fixture.js";

interface CapabilityHarnessEvidence {
  readonly facts: DeckGlCapabilityFacts;
  readonly decision: DeckGlCapabilityDecision;
  readonly rendered: boolean;
  readonly pickableAtCenter: boolean | null;
  readonly message: string;
}

interface CapabilityHarness {
  readonly ready: Promise<CapabilityHarnessEvidence>;
  dispose(): void;
}

declare global {
  interface Window {
    __HONUA_DECKGL_CAPABILITY_HARNESS__?: CapabilityHarness;
  }
}

const PROBE_ROWS = 10_000;
const INTERACTION_TARGET_INDEX = 4_949;

function rendererStringFromContext(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  if (!extension) return String(gl.getParameter(gl.RENDERER));
  return String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL));
}

function collectFacts(): DeckGlCapabilityFacts {
  const webgl2Canvas = document.createElement("canvas");
  const webgl2Context = webgl2Canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  const webgl1Canvas = document.createElement("canvas");
  const webgl1Context = webgl1Canvas.getContext("webgl") as WebGLRenderingContext | null;
  const bestContext = webgl2Context ?? webgl1Context;

  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  return {
    webgl2: webgl2Context !== null,
    webgl1: webgl1Context !== null,
    loseContextExtension: bestContext !== null && bestContext.getExtension("WEBGL_lose_context") !== null,
    maxTextureSize: bestContext !== null ? (bestContext.getParameter(bestContext.MAX_TEXTURE_SIZE) as number) : 0,
    rendererString: bestContext !== null ? rendererStringFromContext(bestContext) : "unavailable",
    deviceMemoryGiB: typeof navigatorWithMemory.deviceMemory === "number" ? navigatorWithMemory.deviceMemory : null,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
  };
}

const status = document.querySelector<HTMLOutputElement>("#status");
const canvas = document.querySelector<HTMLCanvasElement>("#deck-canvas");
if (!status || !canvas) throw new Error("Capability benchmark DOM is incomplete");

let deck: Deck | undefined;
let disposeAdapter: (() => void) | undefined;

const ready = (async (): Promise<CapabilityHarnessEvidence> => {
  const facts = collectFacts();
  const decision = classifyDeckGlCapability(facts);

  if (decision.tier !== "supported") {
    const message = `Bounded fallback decision: ${decision.tier} (${decision.reasons.join("; ")})`;
    status.value = message;
    return { facts, decision, rendered: false, pickableAtCenter: null, message };
  }

  const fixture = buildBinaryPointFixture(PROBE_ROWS, { interactionTargetIndex: INTERACTION_TARGET_INDEX });
  const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer } });
  disposeAdapter = () => adapter.dispose();
  const projection = adapter.project({
    layer: "scatterplot",
    layerId: "honua-deck-capability-points",
    data: {
      length: PROBE_ROWS,
      attributes: {
        getPosition: { value: fixture.positions, size: 2 },
        getRadius: { value: fixture.radii, size: 1 },
        getFillColor: { value: fixture.colors, size: 4, normalized: true },
      },
    },
    identity: {
      sourceId: "benchmark-fixture-capability",
      planId: "plan:benchmark-browser-capability-v1",
      sourceVersion: "fixture-v1",
      featureIds: fixture.featureIds,
    },
    props: { radiusUnits: "meters", radiusMinPixels: 2, stroked: false },
  });

  let firstFrameResolve: (() => void) | undefined;
  const firstFrame = new Promise<void>((resolve) => {
    firstFrameResolve = resolve;
  });
  deck = new Deck({
    canvas,
    width: "100%",
    height: "100%",
    controller: false,
    initialViewState: { longitude: -157.8583, latitude: 21.3069, zoom: 11, pitch: 0, bearing: 0 },
    layers: [],
    onAfterRender: () => {
      firstFrameResolve?.();
      firstFrameResolve = undefined;
    },
  });

  let mountedLayer: unknown;
  projection.mount({
    addLayer(layer) {
      mountedLayer = layer;
      deck?.setProps({ layers: [layer as Layer] });
    },
    removeLayer(layer) {
      if (mountedLayer === layer) {
        mountedLayer = undefined;
        deck?.setProps({ layers: [] });
      }
    },
  });

  await firstFrame;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const picked = deck.pickObject({
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2,
    radius: 12,
    layerIds: ["honua-deck-capability-points"],
  });
  const pickableAtCenter = picked?.index === INTERACTION_TARGET_INDEX;
  const message = `Supported: rendered ${PROBE_ROWS.toLocaleString()} probe points`;
  status.value = message;
  return { facts, decision, rendered: true, pickableAtCenter, message };
})();

window.__HONUA_DECKGL_CAPABILITY_HARNESS__ = {
  ready,
  dispose(): void {
    disposeAdapter?.();
    deck?.finalize();
  },
};
