// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/index.js";
import type { HonuaMapPackage } from "../src/runtime/index.js";
import type {
  HonuaMapClickDetail,
  HonuaSelectionChangeDetail,
  HonuaWebComponentController,
} from "../src/web-components/index.js";
import { createHonuaWebComponentController, defineHonuaWebComponents } from "../src/web-components/index.js";
import { HonuaMapLibreRenderer } from "../src/web-components/maplibre-renderer.js";

/**
 * Shared selection while measuring (issue #1419): `<honua-map>`'s renderer
 * turns a click on a feature into `controller.selectFeature` plus
 * `honua-selection-change`. While `<honua-measurement>` is placing vertices on
 * the same map, those clicks are measurement input and must leave the shared
 * selection alone; once measuring stops, feature clicks select again.
 */

const maps: Array<{ emitLayerClick(layerId: string, event: unknown): void }> = [];

vi.mock("maplibre-gl", () => {
  class FakeMap {
    style: unknown;
    handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    layerHandlers = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor() {
      maps.push(this);
    }

    emitLayerClick(layerId: string, event: unknown): void {
      for (const handler of [...(this.layerHandlers.get(`click:${layerId}`) ?? [])]) handler(event);
    }

    emit(type: string, event?: unknown): void {
      for (const handler of [...(this.handlers.get(type) ?? [])]) handler(event);
    }

    setStyle(style: unknown): void {
      this.style = style;
    }
    getStyle(): unknown {
      return this.style;
    }
    getLayer(): unknown {
      return undefined;
    }
    getSource(): unknown {
      return undefined;
    }
    moveLayer(): void {}
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
      const key = rest.length > 1 ? `${type}:${String(rest[0])}` : type;
      const bucket = rest.length > 1 ? this.layerHandlers : this.handlers;
      const set = bucket.get(key) ?? new Set();
      set.add(handler);
      bucket.set(key, set);
    }

    off(type: string, ...rest: unknown[]): void {
      const handler = rest.at(-1) as (...args: unknown[]) => void;
      const key = rest.length > 1 ? `${type}:${String(rest[0])}` : type;
      const bucket = rest.length > 1 ? this.layerHandlers : this.handlers;
      bucket.get(key)?.delete(handler);
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
  return { Map: FakeMap, default: undefined };
});

function makeMapPackage(): HonuaMapPackage {
  return {
    mapPackageId: "shared-selection",
    format: "honua_map_package.v1",
    status: "Ready",
    sourceBindings: [],
    initialView: { center: [0, 0], zoom: 2 },
    legend: [],
    mapSpec: {
      version: 8,
      sources: {
        parcels: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: [{ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#888" } }],
    },
  } as unknown as HonuaMapPackage;
}

async function loadRenderer(controller: HonuaWebComponentController) {
  const clicks: HonuaMapClickDetail[] = [];
  const selections: HonuaSelectionChangeDetail[] = [];
  let readyMap: unknown;
  const renderer = new HonuaMapLibreRenderer({
    container: document.createElement("div"),
    getClient: () => new HonuaClient({ baseUrl: "http://localhost" }),
    getController: () => controller,
    onReady: (detail) => {
      readyMap = detail.map;
    },
    onError: (detail) => {
      throw detail.error instanceof Error ? detail.error : new Error(detail.message);
    },
    onViewport: () => {},
    onClick: (detail) => clicks.push(detail),
    onHover: () => {},
    onSelection: (detail) => selections.push(detail),
  });
  await renderer.applyState(controller.getState());
  return { renderer, clicks, selections, map: readyMap };
}

function featureClick(lng: number, lat: number, id: number): unknown {
  return {
    lngLat: { lng, lat },
    point: { x: 10, y: 10 },
    features: [{ id, layer: { id: "parcels-fill" }, source: "parcels", properties: { id } }],
  };
}

describe("shared selection while <honua-measurement> is active", () => {
  it("does not rewrite the shared selection with measurement vertex clicks, and selects again afterwards", async () => {
    const controller = createHonuaWebComponentController({ mapPackage: makeMapPackage() });
    const selectFeature = vi.spyOn(controller, "selectFeature");
    const { renderer, clicks, selections, map } = await loadRenderer(controller);
    const fakeMap = maps.at(-1);
    expect(map).toBe(fakeMap);

    // Baseline: without measurement, a feature click selects.
    fakeMap?.emitLayerClick("parcels-fill", featureClick(1, 1, 7));
    expect(selections.map((selection) => selection.featureId)).toEqual([7]);
    expect(selectFeature).toHaveBeenCalledTimes(1);

    defineHonuaWebComponents();
    const measurement = document.createElement("honua-measurement");
    document.body.append(measurement);
    measurement.map = map as never;
    measurement.setMode("distance");

    fakeMap?.emitLayerClick("parcels-fill", featureClick(2, 2, 8));
    fakeMap?.emitLayerClick("parcels-fill", featureClick(3, 3, 9));
    // The clicks still reach honua-map-click listeners...
    expect(clicks.map((click) => click.featureId)).toEqual([7, 8, 9]);
    // ...but the shared selection is untouched.
    expect(selections.map((selection) => selection.featureId)).toEqual([7]);
    expect(selectFeature).toHaveBeenCalledTimes(1);
    expect(controller.getState().selection?.featureId).toBe(7);

    measurement.setMode("off");
    fakeMap?.emitLayerClick("parcels-fill", featureClick(4, 4, 10));
    expect(selections.map((selection) => selection.featureId)).toEqual([7, 10]);

    measurement.remove();
    renderer.disconnect();
    // The first map-package load imports the style-spec validator cold.
  }, 60_000);
});
