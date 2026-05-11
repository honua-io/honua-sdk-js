import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { type HonuaAppLifecycleEvent, createHonuaApp, normalizeHonuaAppOptions } from "../src/app/index.js";
import { HonuaClient } from "../src/core/client.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage, type MaplibreMap } from "../src/runtime/index.js";

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

  it("exports the app package subpath", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };

    expect(packageJson.exports?.["./app"]).toEqual({
      types: "./dist/src/app/index.d.ts",
      default: "./dist/src/app/index.js",
    });
  });
});
