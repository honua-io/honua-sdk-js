import { describe, expect, it, vi } from "vitest";

import { createStoryMap } from "../examples/storytelling-25d-map/src/map.js";

interface MockMapHandle {
  emit(event: string, payload?: unknown): void;
}

declare global {
  var __HONUA_25D_TEST_LAST_MAP__: MockMapHandle | undefined;
}

vi.mock("@honua/sdk-js/honua", () => ({
  createHoverHandler: vi.fn(() => ({
    remove: vi.fn(),
  })),
  createSelectionHandler: vi.fn(() => ({
    clearSelection: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  })),
}));

vi.mock("maplibre-gl", () => {
  type Handler = (event?: unknown) => void;

  class MockNavigationControl {}

  class MockMap {
    styleLoaded = false;
    readonly handlers = new Map<string, Set<Handler>>();

    constructor(_options: unknown) {
      globalThis.__HONUA_25D_TEST_LAST_MAP__ = this;
    }

    isStyleLoaded(): boolean {
      return this.styleLoaded;
    }

    addControl(): void {}

    on(event: string, handler: Handler): void {
      let handlers = this.handlers.get(event);
      if (!handlers) {
        handlers = new Set();
        this.handlers.set(event, handlers);
      }
      handlers.add(handler);
    }

    off(event: string, handler: Handler): void {
      this.handlers.get(event)?.delete(handler);
    }

    emit(event: string, payload?: unknown): void {
      const handlers = [...(this.handlers.get(event) ?? [])];
      handlers.forEach((handler) => handler(payload));
    }
  }

  return {
    default: {
      Map: MockMap,
      NavigationControl: MockNavigationControl,
      setWorkerUrl: vi.fn(),
    },
    Map: MockMap,
    NavigationControl: MockNavigationControl,
    setWorkerUrl: vi.fn(),
  };
});

describe("storytelling 2.5D map startup", () => {
  it("rejects with a wrapped basemap style error instead of hanging", async () => {
    const mapPromise = createStoryMap({
      container: {} as HTMLElement,
      dataset: {
        bounds: {
          center: [-157.8781, 21.3026],
        },
      } as never,
      config: {
        basemapStyle: "https://example.test/style.json",
        initialPitch: 60,
        initialBearing: -18,
        sourceIds: {
          assets: "assets",
          route: "route",
          routeProgress: "route-progress",
          routeMarker: "route-marker",
          stops: "stops",
        },
      } as never,
      telemetry: {
        events: [],
        runtime: {},
        emit: vi.fn(),
        setSummary: vi.fn(),
      },
    });

    globalThis.__HONUA_25D_TEST_LAST_MAP__?.emit("error", { error: { message: "Style JSON 404" } });

    await expect(mapPromise).rejects.toThrow(
      'Failed to load the basemap style "https://example.test/style.json": Style JSON 404',
    );
  });
});
