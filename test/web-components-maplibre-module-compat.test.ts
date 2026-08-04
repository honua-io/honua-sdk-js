// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/index.js";
import type { HonuaMapPackage } from "../src/runtime/index.js";
import { createHonuaWebComponentController } from "../src/web-components/index.js";

/**
 * `<honua-map>` renderer compatibility across the `maplibre-gl` peer majors
 * (issue #1004).
 *
 * MapLibre 6 is ESM-only and publishes named exports with **no default export**;
 * MapLibre 5's UMD build is commonly seen through a `default` namespace. The
 * renderer owns the map, so it must construct one under either packaging and
 * must pass WebGL context attributes the way both majors accept them
 * (`canvasContextAttributes`, since MapLibre 5.0) — a top-level
 * `preserveDrawingBuffer` is silently ignored and would leave the snapshot
 * export in `src/web-components/export.ts` reading a blank canvas.
 */

interface RecordedConstruction {
  options: Record<string, unknown>;
}

const constructions: RecordedConstruction[] = [];

function createFakeMapClass(): unknown {
  return class FakeMap {
    constructor(options: Record<string, unknown>) {
      constructions.push({ options });
    }
    style: unknown;
    setStyle(style: unknown): void {
      this.style = style;
    }
    getStyle(): unknown {
      return this.style;
    }
    getLayer(): unknown {
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
    on(): void {}
    off(): void {}
    once(): void {}
    loaded(): boolean {
      return true;
    }
    isStyleLoaded(): boolean {
      return true;
    }
    remove(): void {}
    resize(): void {}
  };
}

function makeMapPackage(): HonuaMapPackage {
  return {
    mapPackageId: "module-compat",
    format: "honua_map_package.v1",
    status: "Ready",
    sourceBindings: [],
    initialView: { center: [0, 0], zoom: 2 },
    legend: [],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [{ id: "base", type: "background", paint: { "background-color": "#eee" } }],
    },
  } as unknown as HonuaMapPackage;
}

/**
 * Load the renderer against a synthetic `maplibre-gl` module shape. The
 * renderer imports the peer lazily, so each case gets a fresh module registry.
 *
 * Vitest's mocked module namespace throws on reads of keys the factory never
 * declared, where a real ESM namespace yields `undefined`. Absent exports are
 * therefore declared explicitly as `undefined` below so each case models the
 * real packaging (MapLibre 6: named exports, no `default`; MapLibre 5 through a
 * bundler's UMD interop: `default` only).
 */
async function renderWithModuleShape(moduleShape: Record<string, unknown>): Promise<Record<string, unknown>> {
  vi.resetModules();
  vi.doMock("maplibre-gl", () => moduleShape);
  const { HonuaMapLibreRenderer } = await import("../src/web-components/maplibre-renderer.js");
  const controller = createHonuaWebComponentController({ mapPackage: makeMapPackage() });
  const renderer = new HonuaMapLibreRenderer({
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
  await renderer.applyState(controller.getState());
  renderer.disconnect();
  const construction = constructions.at(-1);
  expect(construction, "the renderer must construct a MapLibre map").toBeDefined();
  return (construction as RecordedConstruction).options;
}

describe("HonuaMapLibreRenderer maplibre-gl packaging", () => {
  afterEach(() => {
    constructions.length = 0;
    vi.doUnmock("maplibre-gl");
    vi.resetModules();
  });

  it("constructs a map from MapLibre 6's named exports (no default export)", async () => {
    const options = await renderWithModuleShape({ Map: createFakeMapClass(), default: undefined });
    expect(options.container).toBeInstanceOf(HTMLElement);
  });

  it("constructs a map from a default-namespace MapLibre 5 packaging", async () => {
    const options = await renderWithModuleShape({ Map: undefined, default: { Map: createFakeMapClass() } });
    expect(options.container).toBeInstanceOf(HTMLElement);
  });

  it("passes preserveDrawingBuffer through canvasContextAttributes, not a top-level option", async () => {
    const options = await renderWithModuleShape({ Map: createFakeMapClass(), default: undefined });
    expect(options.canvasContextAttributes).toEqual({ preserveDrawingBuffer: true });
    expect(options).not.toHaveProperty("preserveDrawingBuffer");
  });

  it("fails with an actionable message when the module exposes no Map constructor", async () => {
    const errors: string[] = [];
    vi.resetModules();
    vi.doMock("maplibre-gl", () => ({ Popup: class {}, Map: undefined, default: undefined }));
    const { HonuaMapLibreRenderer } = await import("../src/web-components/maplibre-renderer.js");
    const controller = createHonuaWebComponentController({ mapPackage: makeMapPackage() });
    const renderer = new HonuaMapLibreRenderer({
      container: document.createElement("div"),
      getClient: () => new HonuaClient({ baseUrl: "http://localhost" }),
      getController: () => controller,
      onReady: () => {},
      onError: (detail) => errors.push(detail.message),
      onViewport: () => {},
      onClick: () => {},
      onHover: () => {},
      onSelection: () => {},
    });
    await renderer.applyState(controller.getState());
    renderer.disconnect();
    expect(errors.join("\n")).toContain("maplibre-gl 5.x or 6.x");
  });
});
