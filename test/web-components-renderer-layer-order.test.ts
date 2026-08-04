// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/index.js";
import type { HonuaMapPackage } from "../src/runtime/index.js";
import type { HonuaWebComponentController } from "../src/web-components/index.js";
import { createHonuaWebComponentController } from "../src/web-components/index.js";
import { HonuaMapLibreRenderer } from "../src/web-components/maplibre-renderer.js";

/**
 * Renderer layer-order application (PR #506 review): a controller reorder
 * issued before the map package finished loading must be replayed onto the
 * map once it loads, while an unchanged order must not trigger gratuitous
 * `moveLayer` calls on the first pass.
 */

const moveLayerCalls: string[] = [];

vi.mock("maplibre-gl", () => {
  class FakeMap {
    style: unknown;
    handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    layerIds: string[] = [];

    setStyle(style: { layers?: { id: string }[] }): void {
      this.style = style;
      this.layerIds = (style.layers ?? []).map((layer) => layer.id);
    }

    getStyle(): unknown {
      return this.style;
    }

    getLayer(id: string): unknown {
      return this.layerIds.includes(id) ? { id } : undefined;
    }

    moveLayer(id: string): void {
      moveLayerCalls.push(id);
      this.layerIds = [...this.layerIds.filter((candidate) => candidate !== id), id];
    }

    setLayoutProperty(): void {}
    setPaintProperty(): void {}
    setFeatureState(): void {}
    removeFeatureState(): void {}
    addSource(): void {}
    removeSource(): void {}
    addLayer(): void {}
    removeLayer(): void {}
    setFilter(): void {}
    queryRenderedFeatures(): unknown[] {
      return [];
    }

    on(type: string, ...rest: unknown[]): void {
      const handler = rest.at(-1) as (...args: unknown[]) => void;
      const set = this.handlers.get(type) ?? new Set();
      set.add(handler);
      this.handlers.set(type, set);
    }

    off(type: string, ...rest: unknown[]): void {
      const handler = rest.at(-1) as (...args: unknown[]) => void;
      this.handlers.get(type)?.delete(handler);
    }

    once(): void {}
    loaded(): boolean {
      return true;
    }
    isStyleLoaded(): boolean {
      return true;
    }
    remove(): void {}
    resize(): void {}
  }
  // MapLibre 6's ESM-only packaging: named exports, no default. The
  // default-namespace (MapLibre 5 interop) shape is covered by
  // test/web-components-maplibre-module-compat.test.ts.
  return { Map: FakeMap, default: undefined };
});

function makeMapPackage(): HonuaMapPackage {
  return {
    mapPackageId: "order-test",
    format: "honua_map_package.v1",
    status: "Ready",
    sourceBindings: [],
    initialView: { center: [0, 0], zoom: 2 },
    legend: [],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [
        { id: "base", type: "background", paint: { "background-color": "#eee" } },
        { id: "mid", type: "background", paint: { "background-color": "#ccc" } },
        { id: "top", type: "background", paint: { "background-color": "#aaa" } },
      ],
    },
  } as unknown as HonuaMapPackage;
}

function makeRenderer(controller: HonuaWebComponentController): HonuaMapLibreRenderer {
  return new HonuaMapLibreRenderer({
    container: document.createElement("div"),
    getClient: () => new HonuaClient({ baseUrl: "http://localhost" }),
    getController: () => controller,
    onReady: () => {},
    onError: (detail) => {
      throw detail.error instanceof Error ? detail.error : new Error(detail.message);
    },
    onViewport: () => {},
    onClick: () => {},
    onHover: () => {},
    onSelection: () => {},
  });
}

describe("HonuaMapLibreRenderer layer order", () => {
  beforeEach(() => {
    moveLayerCalls.length = 0;
  });

  it("does not reorder the map when the state order matches the loaded style", async () => {
    const controller = createHonuaWebComponentController({ mapPackage: makeMapPackage() });
    const renderer = makeRenderer(controller);

    await renderer.applyState(controller.getState());

    expect(moveLayerCalls).toEqual([]);
    renderer.disconnect();
  });

  it("replays a reorder issued before the map finished loading", async () => {
    const controller = createHonuaWebComponentController({ mapPackage: makeMapPackage() });
    // Reorder while nothing is loaded yet: move "top" beneath everything.
    controller.moveLayer?.("top", "base");
    const state = controller.getState();
    expect(state.layers.map((layer) => layer.id)).toEqual(["top", "base", "mid"]);

    const renderer = makeRenderer(controller);
    await renderer.applyState(state);

    // The first application replays the diverged order onto the map.
    expect(moveLayerCalls).toEqual(["top", "base", "mid"]);

    // Re-applying the same order is a no-op.
    await renderer.applyState(controller.getState());
    expect(moveLayerCalls).toEqual(["top", "base", "mid"]);

    // A later reorder still applies incrementally.
    controller.moveLayer?.("base", undefined);
    await renderer.applyState(controller.getState());
    expect(moveLayerCalls).toEqual(["top", "base", "mid", "top", "mid", "base"]);
    renderer.disconnect();
  });
});
