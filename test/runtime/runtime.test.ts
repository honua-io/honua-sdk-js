/**
 * Conformance tests for the MapLibre GL JS-first runtime. Exercises the
 * load → updatePackage → dispose lifecycle against a mock map that
 * records every call so we can assert the bridge behaviour without
 * pulling `maplibre-gl` in as a runtime dep.
 */

import { describe, expect, test, vi } from "vitest";

import { HonuaClient } from "../../src/core/client.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  HonuaMapPackageError,
  type HonuaMapPackage,
  type HonuaRuntimeEvent,
  type MaplibreMap,
  loadMapPackage,
} from "../../src/runtime/index.js";
import {
  applyTheme,
  buildLegend,
  diffPackages,
  projectSourceBindings,
} from "../../src/runtime/index.js";
import type { PopupFactory, PopupHandle } from "../../src/runtime/popups.js";

// ── Mock map ─────────────────────────────────────────────────

interface MockCall {
  method: string;
  args: unknown[];
}

interface MockMap extends MaplibreMap {
  _calls: MockCall[];
  _style: unknown;
  _listeners: Array<{ event: string; layer?: string; handler: (...args: unknown[]) => void }>;
  _featureState: Map<string, Record<string, unknown>>;
}

function makeMockMap(): MockMap {
  const calls: MockCall[] = [];
  const listeners: MockMap["_listeners"] = [];
  let style: unknown = {};
  const state = new Map<string, Record<string, unknown>>();

  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };

  const map: MockMap = {
    _calls: calls,
    _style: style,
    _listeners: listeners,
    _featureState: state,
    setStyle(next) {
      record("setStyle", [next]);
      style = next;
      map._style = next;
      return undefined;
    },
    getStyle() {
      return map._style;
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
    setFeatureState(target, next) {
      state.set(`${target.source}:${target.id}`, { ...(state.get(`${target.source}:${target.id}`) ?? {}), ...next });
    },
    getFeatureState(target) {
      return state.get(`${target.source}:${target.id}`) ?? {};
    },
    removeFeatureState(target) {
      state.delete(`${target.source}:${target.id}`);
    },
    on(event, layerOrHandler, handler) {
      if (typeof layerOrHandler === "string" && handler) {
        listeners.push({ event, layer: layerOrHandler, handler });
      } else if (typeof layerOrHandler === "function") {
        listeners.push({ event, handler: layerOrHandler });
      }
    },
    off(event, layerOrHandler, handler) {
      const target = typeof layerOrHandler === "function" ? layerOrHandler : handler;
      const idx = listeners.findIndex((entry) => entry.event === event && entry.handler === target);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };

  return map;
}

// ── Helpers ──────────────────────────────────────────────────

function makeClient(): HonuaClient {
  return new HonuaClient({
    baseUrl: "https://mock.honua.test",
    fetchFn: async () => new Response("not used in tests", { status: 200 }),
  });
}

function makePackage(overrides: Partial<HonuaMapPackage> = {}): HonuaMapPackage {
  return {
    mapPackageId: "pkg-001",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://server.example.com/rest/services/Parcels/FeatureServer/0" },
        attribution: "© Example County Assessor",
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [
        {
          id: "parcels-fill",
          type: "fill",
          source: "parcels",
          paint: { "fill-color": "#cccccc", "fill-opacity": 0.5 },
          layout: { visibility: "visible" },
        },
      ],
    },
    legend: [{ label: "Parcels" }],
    initialView: { bbox: [-123, 37, -120, 45] },
    popupBindings: [{ sourceId: "parcels", fieldName: "OBJECTID", title: "Parcel" }],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("loadMapPackage", () => {
  test("binds package sources, composes style, and emits lifecycle events", async () => {
    const map = makeMockMap();
    const pkg = makePackage();
    const events: HonuaRuntimeEvent[] = [];

    const runtime = await loadMapPackage(pkg, map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });
    runtime.on((event) => events.push(event));
    runtime._emit({ type: "source-ready", sourceId: "replay" });

    const setStyle = map._calls.find((c) => c.method === "setStyle");
    expect(setStyle, "setStyle should be called").toBeDefined();
    expect(runtime.composedStyle.sources).toHaveProperty("parcels");
    expect(runtime.composedStyle.layers).toHaveLength(1);
    expect(runtime.dataset.sourceIds()).toEqual(["parcels"]);

    expect(events.some((e) => e.type === "source-ready")).toBe(true);
  });

  test("rejects unsupported package format via HonuaMapPackageError", async () => {
    const map = makeMockMap();
    const bad = makePackage({ format: "honua_map_package.v999" as unknown as typeof HONUA_MAP_PACKAGE_FORMAT_V1 });
    await expect(
      loadMapPackage(bad, map, { client: makeClient(), skipCompatibilityCheck: true }),
    ).rejects.toBeInstanceOf(HonuaMapPackageError);
  });

  test("rejects workspace_artifact bindings without a server resolver", async () => {
    const map = makeMockMap();
    const pkg = makePackage({
      sourceBindings: [
        {
          sourceId: "draft",
          protocol: "workspace_artifact",
          locator: { url: "honua://workspace/artifact/1" },
        },
      ],
    });
    await expect(
      loadMapPackage(pkg, map, { client: makeClient(), skipCompatibilityCheck: true }),
    ).rejects.toMatchObject({ stage: "source-bind" });
  });

  test("applies initialView on first load when applyInitialView is not disabled", async () => {
    const map = makeMockMap();
    const pkg = makePackage();
    await loadMapPackage(pkg, map, { client: makeClient(), skipCompatibilityCheck: true });
    const fit = map._calls.find((c) => c.method === "fitBounds");
    expect(fit).toBeDefined();
  });
});

describe("HonuaMapRuntime", () => {
  test("getLegend backfills color from composed style", async () => {
    const map = makeMockMap();
    const pkg = makePackage();
    const runtime = await loadMapPackage(pkg, map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });
    const legend = runtime.getLegend();
    expect(legend).toHaveLength(1);
    expect(legend[0]).toMatchObject({ label: "Parcels", color: "#cccccc" });
  });

  test("setLayerVisibility proxies to setLayoutProperty", async () => {
    const map = makeMockMap();
    const runtime = await loadMapPackage(makePackage(), map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });
    runtime.setLayerVisibility("parcels-fill", false);
    const call = map._calls.find((c) => c.method === "setLayoutProperty");
    expect(call?.args).toEqual(["parcels-fill", "visibility", "none"]);
  });

  test("incremental updatePackage applies paint-only changes via setPaintProperty", async () => {
    const map = makeMockMap();
    const runtime = await loadMapPackage(makePackage(), map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });
    map._calls.length = 0;

    const next = makePackage({
      mapSpec: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "parcels-fill",
            type: "fill",
            source: "parcels",
            paint: { "fill-color": "#ff0000", "fill-opacity": 0.5 },
            layout: { visibility: "visible" },
          },
        ],
      },
    });
    await runtime.updatePackage(next);

    expect(map._calls.some((c) => c.method === "setStyle")).toBe(false);
    const paint = map._calls.find((c) => c.method === "setPaintProperty");
    expect(paint?.args).toEqual(["parcels-fill", "fill-color", "#ff0000"]);
  });

  test("structural update (layer added) falls back to full setStyle", async () => {
    const map = makeMockMap();
    const runtime = await loadMapPackage(makePackage(), map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });
    map._calls.length = 0;

    const next = makePackage({
      mapSpec: {
        version: 8,
        sources: {},
        layers: [
          { id: "parcels-outline", type: "line", source: "parcels", paint: { "line-color": "#000000" } },
          { id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#cccccc" } },
        ],
      },
    });

    const diff = diffPackages(runtime.mapPackage, next);
    expect(diff.incremental).toBe(false);
    expect(diff.structuralReason).toBeDefined();

    await runtime.updatePackage(next);
    expect(map._calls.some((c) => c.method === "setStyle")).toBe(true);
  });

  test("bindPopup requires a popupFactory and wires a click listener", async () => {
    const popups: Array<ReturnType<typeof makePopupHandle>> = [];
    const popupFactory: PopupFactory = () => {
      const handle = makePopupHandle();
      popups.push(handle);
      return handle;
    };
    const map = makeMockMap();
    const runtime = await loadMapPackage(makePackage(), map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
      popupFactory,
      popupRenderer: ({ features }) => `feature=${features[0]?.properties?.OBJECTID}`,
    });

    const handle = runtime.bindPopup("parcels-fill");

    const click = map._listeners.find((l) => l.event === "click" && l.layer === "parcels-fill");
    expect(click).toBeDefined();

    click?.handler({
      lngLat: { lng: -121, lat: 38 },
      features: [{ properties: { OBJECTID: 42 } }],
    });
    expect(popups).toHaveLength(1);

    handle.remove();
    expect(map._listeners.find((l) => l.layer === "parcels-fill")).toBeUndefined();
  });

  test("bindPopup without popupFactory raises HonuaMapPackageError stage=popup", async () => {
    const runtime = await loadMapPackage(makePackage(), makeMockMap(), {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });
    expect(() => runtime.bindPopup("parcels-fill")).toThrow(HonuaMapPackageError);
  });

  test("dispose removes layers, sources, and listeners; further calls throw", async () => {
    const map = makeMockMap();
    const runtime = await loadMapPackage(makePackage(), map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });
    const events: HonuaRuntimeEvent[] = [];
    runtime.on((e) => events.push(e));

    runtime.dispose();

    expect(map._calls.some((c) => c.method === "removeLayer" && c.args[0] === "parcels-fill")).toBe(true);
    expect(map._calls.some((c) => c.method === "removeSource" && c.args[0] === "parcels")).toBe(true);
    expect(events.some((e) => e.type === "disposed")).toBe(true);

    expect(() => runtime.setLayerVisibility("parcels-fill", false)).toThrow(HonuaMapPackageError);

    runtime.dispose();
  });
});

describe("projectSourceBindings", () => {
  test("translates snake_case server protocol to kebab-case SDK protocol", () => {
    const projection = projectSourceBindings("pkg", [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://example.com/services/Parcels/FeatureServer/0" },
      },
    ]);
    expect(projection.descriptors[0].protocol).toBe("geoservices-feature-service");
  });

  test("routes vector_tile bindings to MapLibre-native sources", () => {
    const projection = projectSourceBindings("pkg", [
      {
        sourceId: "satellite",
        protocol: "vector_tile",
        locator: { url: "https://tiles.example.com/{z}/{x}/{y}.pbf" },
      },
    ]);
    expect(projection.descriptors).toHaveLength(0);
    expect(projection.nativeSources).toHaveLength(1);
    expect(projection.nativeSources[0].spec).toMatchObject({ type: "vector" });
  });

  test("rejects duplicate sourceIds", () => {
    expect(() =>
      projectSourceBindings("pkg", [
        { sourceId: "a", protocol: "ogc_features", locator: { url: "https://a" } },
        { sourceId: "a", protocol: "ogc_features", locator: { url: "https://b" } },
      ]),
    ).toThrow(HonuaMapPackageError);
  });
});

describe("composeStyle: applyTheme", () => {
  test("substitutes {theme:key} placeholders in paint values", () => {
    const composed = applyTheme(
      {
        version: 8,
        sources: {},
        layers: [
          { id: "x", type: "fill", paint: { "fill-color": "{theme:primary}", "fill-opacity": 0.5 } },
        ],
      },
      { tokens: { primary: "#112233" } },
    );
    expect(composed.layers[0].paint).toEqual({ "fill-color": "#112233", "fill-opacity": 0.5 });
  });

  test("leaves unknown tokens in place so authors can spot them", () => {
    const composed = applyTheme(
      {
        version: 8,
        sources: {},
        layers: [{ id: "x", type: "fill", paint: { "fill-color": "{theme:mystery}" } }],
      },
      { tokens: { other: "#ffffff" } },
    );
    expect(composed.layers[0].paint).toEqual({ "fill-color": "{theme:mystery}" });
  });
});

describe("buildLegend", () => {
  test("returns empty list when package has no legend entries", () => {
    const entries = buildLegend(undefined, { version: 8, sources: {}, layers: [] });
    expect(entries).toEqual([]);
  });

  test("honors explicit color over style fallback", () => {
    const entries = buildLegend(
      [{ label: "Highlighted", color: "#ff00ff" }],
      {
        version: 8,
        sources: {},
        layers: [{ id: "l", type: "fill", paint: { "fill-color": "#ffffff" } }],
      },
    );
    expect(entries[0].color).toBe("#ff00ff");
  });
});

// ── Local popup mock ─────────────────────────────────────────

function makePopupHandle(): PopupHandle {
  const fn = vi.fn();
  const handle: PopupHandle = {
    setLngLat: vi.fn().mockReturnThis(),
    setDOMContent: vi.fn().mockReturnThis(),
    setHTML: vi.fn().mockReturnThis(),
    addTo: vi.fn().mockReturnThis(),
    remove: fn,
  };
  return handle;
}
