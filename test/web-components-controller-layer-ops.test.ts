import { describe, expect, it, vi } from "vitest";

import {
  HonuaInMemoryWebComponentController,
  createHonuaWebComponentController,
  layersFromMapPackage,
} from "../src/web-components/index.js";
import type { HonuaWebComponentRuntimeLike } from "../src/web-components/index.js";

/**
 * Controller-side layer-state extensions backing the survival-tier layer list
 * (issue #493): `setLayerOpacity` and `moveLayer`.
 */

const LAYERS = [
  { id: "base", title: "Base", visible: true },
  { id: "mid", title: "Mid", visible: true },
  { id: "top", title: "Top", visible: true },
];

describe("HonuaInMemoryWebComponentController.setLayerOpacity", () => {
  it("clamps opacity into [0, 1], updates state, and notifies subscribers", () => {
    const controller = createHonuaWebComponentController({ layers: LAYERS });
    const seen: (number | undefined)[] = [];
    controller.subscribe((state) => {
      seen.push(state.layers.find((layer) => layer.id === "mid")?.opacity);
    });

    controller.setLayerOpacity?.("mid", 0.25);
    controller.setLayerOpacity?.("mid", 4);
    controller.setLayerOpacity?.("mid", -1);

    expect(seen).toEqual([undefined, 0.25, 1, 0]);
  });

  it("ignores unknown layers and non-finite values", () => {
    const controller = createHonuaWebComponentController({ layers: LAYERS });
    const listener = vi.fn();
    controller.subscribe(listener);
    listener.mockClear();

    controller.setLayerOpacity?.("missing", 0.5);
    controller.setLayerOpacity?.("mid", Number.NaN);

    expect(listener).not.toHaveBeenCalled();
  });

  it("delegates to the runtime when it supports opacity", () => {
    const setLayerOpacity = vi.fn();
    const runtime = makeRuntimeLike({ setLayerOpacity });
    const controller = new HonuaInMemoryWebComponentController({ runtime, layers: LAYERS });

    controller.setLayerOpacity("top", 0.6);

    expect(setLayerOpacity).toHaveBeenCalledWith("top", 0.6);
  });
});

describe("HonuaInMemoryWebComponentController.moveLayer", () => {
  it("moves a layer before another and to the end when beforeId is omitted", () => {
    const controller = createHonuaWebComponentController({ layers: LAYERS });

    controller.moveLayer?.("top", "base");
    expect(controller.getState().layers.map((layer) => layer.id)).toEqual(["top", "base", "mid"]);

    controller.moveLayer?.("top");
    expect(controller.getState().layers.map((layer) => layer.id)).toEqual(["base", "mid", "top"]);
  });

  it("is a no-op for unknown layers, unknown targets, and self-targets", () => {
    const controller = createHonuaWebComponentController({ layers: LAYERS });
    const listener = vi.fn();
    controller.subscribe(listener);
    listener.mockClear();

    controller.moveLayer?.("missing", "base");
    controller.moveLayer?.("base", "missing");
    controller.moveLayer?.("base", "base");

    expect(listener).not.toHaveBeenCalled();
    expect(controller.getState().layers.map((layer) => layer.id)).toEqual(["base", "mid", "top"]);
  });

  it("delegates to the runtime when it supports reordering", () => {
    const moveLayer = vi.fn();
    const runtime = makeRuntimeLike({ moveLayer });
    const controller = new HonuaInMemoryWebComponentController({ runtime, layers: LAYERS });

    controller.moveLayer("base", "top");

    expect(moveLayer).toHaveBeenCalledWith("base", "top");
  });
});

describe("layersFromMapPackage opacity extraction", () => {
  it("reads literal numeric paint opacity and ignores expressions", () => {
    const layers = layersFromMapPackage([
      { id: "fill", type: "fill", paint: { "fill-opacity": 0.35 } },
      { id: "line", type: "line", paint: { "line-opacity": ["get", "o"] } },
      { id: "plain", type: "circle" },
    ] as never);

    expect(layers[0]?.opacity).toBe(0.35);
    expect(layers[1]?.opacity).toBeUndefined();
    expect(layers[2]?.opacity).toBeUndefined();
  });
});

function makeRuntimeLike(overrides: Partial<HonuaWebComponentRuntimeLike>): HonuaWebComponentRuntimeLike {
  return {
    mapPackage: {
      mapPackageId: "test",
      format: "honua_map_package.v1",
      status: "Ready",
      sourceBindings: [],
      initialView: {},
      legend: [],
      mapSpec: { version: 8, sources: {}, layers: [] },
    } as unknown as HonuaWebComponentRuntimeLike["mapPackage"],
    composedStyle: { layers: [] },
    getLegend: () => [],
    setLayerVisibility: () => {},
    setViewState: () => {},
    ...overrides,
  };
}
