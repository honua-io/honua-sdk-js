import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { type HonuaAppLifecycleEvent, createHonuaApp, normalizeHonuaAppOptions } from "../src/app/index.js";
import { PROTOCOL_DEFAULT_CAPABILITIES, type Protocol, type SourceDescriptor } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage, type MaplibreMap } from "../src/runtime/index.js";
import type { HonuaWebComponentController, HonuaWebComponentState } from "../src/web-components/types.js";

interface MockMap extends MaplibreMap {
  readonly calls: readonly { method: string; args: unknown[] }[];
}

function makeMockMap(): MockMap {
  const calls: { method: string; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };
  return {
    calls,
    setStyle(style) {
      record("setStyle", [style]);
    },
    getStyle() {
      return {};
    },
    addSource(id, source) {
      record("addSource", [id, source]);
    },
    removeSource(id) {
      record("removeSource", [id]);
    },
    addLayer(layer, beforeId) {
      record("addLayer", [layer, beforeId]);
    },
    removeLayer(id) {
      record("removeLayer", [id]);
    },
    getLayer(id) {
      record("getLayer", [id]);
      return undefined;
    },
    setLayoutProperty(layerId, name, value) {
      record("setLayoutProperty", [layerId, name, value]);
    },
    setPaintProperty(layerId, name, value) {
      record("setPaintProperty", [layerId, name, value]);
    },
    setFilter(layerId, filter) {
      record("setFilter", [layerId, filter]);
    },
    getSource(id) {
      record("getSource", [id]);
      return undefined;
    },
    fitBounds(bounds, options) {
      record("fitBounds", [bounds, options]);
    },
    jumpTo(options) {
      record("jumpTo", [options]);
    },
    easeTo(options) {
      record("easeTo", [options]);
    },
    flyTo(options) {
      record("flyTo", [options]);
    },
    setFeatureState(target, state) {
      record("setFeatureState", [target, state]);
    },
    getFeatureState() {
      return {};
    },
    removeFeatureState(target, key) {
      record("removeFeatureState", [target, key]);
    },
    on(event, layerOrHandler, handler) {
      const listener = typeof layerOrHandler === "function" ? layerOrHandler : handler;
      if (!listener) return;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
    },
    off(event, layerOrHandler, handler) {
      const listener = typeof layerOrHandler === "function" ? layerOrHandler : handler;
      if (!listener) return;
      listeners.get(event)?.delete(listener);
    },
  };
}

function makeClient(fetchFn: typeof fetch = async () => new Response("not used", { status: 200 })): HonuaClient {
  return new HonuaClient({ baseUrl: "https://mock.honua.test", fetchFn });
}

function makePackage(overrides: Partial<HonuaMapPackage> = {}): HonuaMapPackage {
  return {
    mapPackageId: "app-test",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [],
    initialView: { center: [-157.86, 21.3], zoom: 11 },
    legend: [{ label: "Incidents", color: "#dc2626" }],
    mapSpec: {
      version: 8,
      sources: {
        incidents: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers: [
        {
          id: "incident-points",
          source: "incidents",
          type: "circle",
          metadata: { title: "Incident points" },
          paint: { "circle-color": "#dc2626" },
        },
      ],
    },
    ...overrides,
  };
}

function makeDescriptor(protocol: Protocol, overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  const id = overrides.id ?? `${protocol}-source`;
  return {
    id,
    protocol,
    locator: {
      url: `https://mock.honua.test/${id}`,
      ...overrides.locator,
    },
    capabilities: overrides.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES[protocol],
    ...(overrides.schema ? { schema: overrides.schema } : {}),
    ...(overrides.analytics ? { analytics: overrides.analytics } : {}),
    ...(overrides.attribution ? { attribution: overrides.attribution } : {}),
  };
}

function makeWebComponentController<T = Record<string, unknown>>(): {
  controller: HonuaWebComponentController<T>;
  destroyed(): boolean;
} {
  let isDestroyed = false;
  const state: HonuaWebComponentState<T> = {
    status: "ready",
    layers: [],
    legend: [],
    viewport: {},
    featuresBySource: {},
    featureStates: [],
    filters: {},
  };
  return {
    controller: {
      getState: () => state,
      subscribe(listener) {
        listener(state);
        return { remove() {} };
      },
      setLayerVisibility() {},
      setViewport() {},
      setFilter() {},
      selectFeature() {},
      clearSelection() {},
      setFeatureState() {},
      removeFeatureState() {},
      async queryFeatures(sourceId) {
        return { sourceId, status: "ready", fields: [], rows: [], totalCount: 0 };
      },
      async search() {
        return [];
      },
      canMeasure() {
        return false;
      },
      canSketch() {
        return false;
      },
      async setMeasureMode(mode) {
        return { mode, status: "unsupported" };
      },
      async setSketchMode(mode) {
        return { mode, status: "unsupported" };
      },
      destroy() {
        isDestroyed = true;
      },
    },
    destroyed: () => isDestroyed,
  };
}

describe("createHonuaApp", () => {
  it("normalizes package locators without requiring a renderer", () => {
    const normalized = normalizeHonuaAppOptions({
      baseUrl: "https://mock.honua.test/",
      packageUrl: "/packages/app-test",
      watch: true,
    });

    expect(normalized.client.serverBaseUrl).toBe("https://mock.honua.test");
    expect(normalized.packageSource).toEqual({ kind: "locator", locator: "/packages/app-test" });
    expect(normalized.watch).toEqual({});
  });

  it("bootstraps an inline MapPackage into runtime, controllers, lifecycle events, and disposal", async () => {
    const events: HonuaAppLifecycleEvent[] = [];
    const map = makeMockMap();

    const app = await createHonuaApp({
      client: makeClient(),
      mapPackage: makePackage(),
      map,
      load: { skipCompatibilityCheck: true, applyInitialView: false },
      onEvent: (event) => events.push(event),
    });

    expect(app.status).toBe("ready");
    expect(app.runtime?.mapPackage.mapPackageId).toBe("app-test");
    expect(app.controller.snapshot().visibility.layers["incident-points"]).toBe(true);
    expect(app.webComponentController.getState().layers[0]).toMatchObject({
      id: "incident-points",
      visible: true,
    });
    expect(map.calls.some((call) => call.method === "setStyle")).toBe(true);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["client-ready", "package-ready", "runtime-ready", "controller-ready"]),
    );

    app.dispose();
    expect(app.status).toBe("disposed");
  });

  it("reports hosted package auth failures as typed lifecycle errors", async () => {
    const events: HonuaAppLifecycleEvent[] = [];
    const client = makeClient(async () => new Response("nope", { status: 401, statusText: "Unauthorized" }));

    await expect(
      createHonuaApp({
        client,
        packageId: "secure-map",
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow();

    expect(events).toContainEqual(expect.objectContaining({ type: "error", stage: "auth" }));
  });

  it("synthesizes raster layers for render-only source descriptor protocols", async () => {
    const cases: Array<{ protocol: Protocol; packageProtocol: string }> = [
      { protocol: "geoservices-map-service", packageProtocol: "geoservices_map_service" },
      { protocol: "ogc-maps", packageProtocol: "ogc_maps" },
      { protocol: "wms", packageProtocol: "wms" },
      { protocol: "wmts", packageProtocol: "wmts" },
      { protocol: "maplibre-raster", packageProtocol: "raster_tile" },
    ];

    for (const item of cases) {
      const webComponents = makeWebComponentController();
      const app = await createHonuaApp({
        client: makeClient(),
        source: {
          id: `preview-${item.protocol}`,
          title: "Preview imagery",
          descriptor: makeDescriptor(item.protocol, { id: `source-${item.protocol}` }),
        },
        webComponentControllerFactory: () => webComponents.controller,
      });

      expect(app.mapPackage?.sourceBindings[0]).toMatchObject({
        sourceId: `source-${item.protocol}`,
        protocol: item.packageProtocol,
      });
      expect(app.mapPackage?.mapSpec.layers[0]).toMatchObject({
        id: `preview-${item.protocol}-layer`,
        source: `source-${item.protocol}`,
        type: "raster",
        metadata: { title: "Preview imagery" },
      });

      app.dispose();
      expect(webComponents.destroyed()).toBe(true);
    }
  });

  it("requires explicit layer metadata for ambiguous source descriptor protocols", async () => {
    await expect(
      createHonuaApp({
        client: makeClient(),
        source: {
          id: "preview-features",
          descriptor: makeDescriptor("ogc-features", { id: "features" }),
        },
      }),
    ).rejects.toThrow('createHonuaApp source "preview-features" (ogc-features) requires source.layer.type');
  });

  it("preserves caller vector-tile source-layer metadata in descriptor projection", async () => {
    const webComponents = makeWebComponentController();

    const app = await createHonuaApp({
      client: makeClient(),
      source: {
        id: "preview-roads",
        descriptor: makeDescriptor("maplibre-vector", { id: "roads" }),
        layer: { type: "line", sourceLayer: "transportation", paint: { "line-color": "#2563eb" } },
      },
      webComponentControllerFactory: () => webComponents.controller,
    });

    expect(app.mapPackage?.sourceBindings[0]).toMatchObject({
      sourceId: "roads",
      protocol: "vector_tile",
    });
    expect(app.mapPackage?.mapSpec.layers[0]).toMatchObject({
      source: "roads",
      type: "line",
      "source-layer": "transportation",
      paint: { "line-color": "#2563eb" },
    });

    app.dispose();
  });

  it("rejects vector-tile source descriptors without source-layer metadata", async () => {
    await expect(
      createHonuaApp({
        client: makeClient(),
        source: {
          id: "preview-tiles",
          descriptor: makeDescriptor("ogc-tiles", { id: "tiles" }),
          layer: { type: "fill" },
        },
      }),
    ).rejects.toThrow('createHonuaApp source "preview-tiles" (ogc-tiles) requires source.layer.sourceLayer');
  });

  it("uses an injected web-component controller factory", async () => {
    const webComponents = makeWebComponentController();
    let receivedPackageId: string | undefined;

    const app = await createHonuaApp({
      client: makeClient(),
      mapPackage: makePackage(),
      webComponentControllerFactory: (context) => {
        receivedPackageId = context.mapPackage.mapPackageId;
        return webComponents.controller;
      },
    });

    expect(receivedPackageId).toBe("app-test");
    expect(app.webComponentController).toBe(webComponents.controller);

    app.dispose();
    expect(webComponents.destroyed()).toBe(true);
  });

  it("disposes owned runtime resources when bootstrap fails after rendering", async () => {
    const map = makeMockMap();

    await expect(
      createHonuaApp({
        client: makeClient(),
        mapPackage: makePackage(),
        map,
        load: { skipCompatibilityCheck: true, applyInitialView: false },
        controllerOptions: { initialViewport: { center: [Number.NaN, 21.3] } },
      }),
    ).rejects.toThrow("center must contain finite longitude and latitude values");

    expect(map.calls.some((call) => call.method === "removeLayer" && call.args[0] === "incident-points")).toBe(true);
    expect(map.calls.some((call) => call.method === "removeSource" && call.args[0] === "incidents")).toBe(true);
  });

  it("exports the app package subpath via the one-minor deprecation shim", () => {
    // Moved to `@honua/app-platform/app` in the 1.0 scope split; the old
    // `@honua/sdk-js/app` subpath resolves through a `@deprecated` re-export
    // shim for one minor (docs/decisions/scope-split-and-1.0.md).
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };

    expect(packageJson.exports?.["./app"]).toEqual({
      types: "./dist/src/_deprecated/app.d.ts",
      default: "./dist/src/_deprecated/app.js",
    });
  });
});
