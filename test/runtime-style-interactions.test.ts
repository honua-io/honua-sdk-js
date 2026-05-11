import { describe, expect, test } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import { createExplorationContext, sourceFeatureSelectionTarget } from "../src/exploration/index.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  type HonuaRuntimeDiagnostic,
  HonuaRuntimeDiagnosticError,
  type LoadMapPackageOptions,
  type MaplibreMap,
  loadMapPackage,
  validateRuntimeFilterExpression,
  validateRuntimeStyleSpec,
} from "../src/runtime/index.js";

interface MockCall {
  method: string;
  args: unknown[];
}

interface MockMap extends MaplibreMap {
  _calls: MockCall[];
  _style: unknown;
  _listeners: Array<{ event: string; layer?: string; handler: (...args: unknown[]) => void }>;
  _featureState: Map<string, Record<string, unknown>>;
  _fire(event: string, layer: string, payload: unknown): void;
}

function makeMockMap(): MockMap {
  const calls: MockCall[] = [];
  const listeners: MockMap["_listeners"] = [];
  const featureState = new Map<string, Record<string, unknown>>();
  let style: unknown = {};

  function record(method: string, args: unknown[]): void {
    calls.push({ method, args });
  }

  function stateKey(target: { source: string; id: string | number; sourceLayer?: string }): string {
    return `${target.source}:${target.sourceLayer ?? ""}:${String(target.id)}`;
  }

  const map: MockMap = {
    _calls: calls,
    _style: style,
    _listeners: listeners,
    _featureState: featureState,
    setStyle(next, options) {
      record("setStyle", [next, options]);
      style = next;
      map._style = next;
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
    moveLayer(id, beforeId) {
      record("moveLayer", [id, beforeId]);
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
    setFeatureState(target, patch) {
      const key = stateKey(target);
      featureState.set(key, { ...(featureState.get(key) ?? {}), ...patch });
    },
    getFeatureState(target) {
      return featureState.get(stateKey(target)) ?? {};
    },
    removeFeatureState(target, key) {
      const stateTargetKey = stateKey(target);
      if (!key) {
        featureState.delete(stateTargetKey);
        return;
      }
      const existing = featureState.get(stateTargetKey);
      if (existing) delete existing[key];
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
      const index = listeners.findIndex((entry) => entry.event === event && entry.handler === target);
      if (index >= 0) listeners.splice(index, 1);
    },
    _fire(event, layer, payload) {
      for (const listener of listeners.filter((entry) => entry.event === event && entry.layer === layer)) {
        listener.handler(payload);
      }
    },
  };

  return map;
}

function makeClient(): HonuaClient {
  return new HonuaClient({
    baseUrl: "https://mock.honua.test",
    fetchFn: async () => new Response("not used", { status: 200 }),
  });
}

function makePackage(): HonuaMapPackage {
  return {
    mapPackageId: "pkg-style-interactions",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://server.example.com/rest/services/Parcels/FeatureServer/0" },
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
          paint: { "fill-color": "#cccccc" },
          layout: { visibility: "visible" },
        },
      ],
    },
  };
}

async function loadRuntime(
  map = makeMockMap(),
  options: Partial<Pick<LoadMapPackageOptions, "styleSpecValidationMode">> = {},
) {
  const runtime = await loadMapPackage(makePackage(), map, {
    client: makeClient(),
    skipCompatibilityCheck: true,
    applyInitialView: false,
    ...options,
  });
  map._calls.length = 0;
  return { runtime, map };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function captureRuntimeDiagnostics(action: () => void): readonly HonuaRuntimeDiagnostic[] {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HonuaRuntimeDiagnosticError);
    return (error as HonuaRuntimeDiagnosticError).diagnostics;
  }
  throw new Error("Expected HonuaRuntimeDiagnosticError.");
}

describe("runtime source/layer helpers", () => {
  test("adds, updates, orders, and removes sources and layers without a style reload for paint/filter patches", async () => {
    const { runtime, map } = await loadRuntime();

    runtime.addSource("assets", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    expect(runtime.composedStyle.sources.assets).toMatchObject({ type: "geojson" });
    expect(runtime.honuaMap.hasSource("assets")).toBe(true);
    expect(map._calls.find((call) => call.method === "addSource")?.args[0]).toBe("assets");

    runtime.updateSource("assets", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: null }] },
    });
    expect(runtime.composedStyle.sources.assets).toMatchObject({ type: "geojson" });
    expect(map._calls.some((call) => call.method === "setStyle")).toBe(true);

    runtime.addLayer(
      {
        id: "assets-points",
        type: "circle",
        source: "assets",
        paint: { "circle-color": "#f00", "circle-radius": 5 },
      },
      { beforeId: "parcels-fill" },
    );
    expect(runtime.composedStyle.layers.map((layer) => layer.id)).toEqual(["assets-points", "parcels-fill"]);
    expect(map._calls.find((call) => call.method === "addLayer")?.args[1]).toBe("parcels-fill");

    map._calls.length = 0;
    runtime.updateLayer("assets-points", {
      paint: { "circle-color": "#0f0", "circle-radius": 5 },
      filter: ["==", ["get", "status"], "open"],
    });

    expect(map._calls).toContainEqual({
      method: "setPaintProperty",
      args: ["assets-points", "circle-color", "#0f0"],
    });
    expect(map._calls).toContainEqual({
      method: "setFilter",
      args: ["assets-points", ["==", ["get", "status"], "open"]],
    });
    expect(map._calls.some((call) => call.method === "setStyle")).toBe(false);
    expect(runtime.honuaMap.getLayer("assets-points")?.filter).toEqual(["==", ["get", "status"], "open"]);

    runtime.moveLayer("assets-points", { afterId: "parcels-fill" });
    expect(runtime.composedStyle.layers.map((layer) => layer.id)).toEqual(["parcels-fill", "assets-points"]);

    expect(runtime.removeLayer("assets-points")).toBe(true);
    expect(runtime.removeSource("assets")).toEqual([]);
    expect(runtime.honuaMap.hasSource("assets")).toBe(false);
  });

  test("fails early with typed diagnostics for invalid expressions", async () => {
    const { runtime } = await loadRuntime();

    expect(() =>
      runtime.addLayer({
        id: "bad-fill",
        type: "fill",
        source: "parcels",
        paint: { "fill-color": ["case", ["==", ["get", "status"], "open"] as unknown] },
      }),
    ).toThrow(HonuaRuntimeDiagnosticError);

    try {
      runtime.addLayer({
        id: "bad-fill",
        type: "fill",
        source: "parcels",
        paint: { "fill-color": ["case", ["==", ["get", "status"], "open"] as unknown] },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(HonuaRuntimeDiagnosticError);
      const diagnostics = (error as HonuaRuntimeDiagnosticError).diagnostics;
      expect(diagnostics[0]).toMatchObject({
        code: "expression-case-invalid",
        layerId: "bad-fill",
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
      });
    }

    expect(validateRuntimeFilterExpression("status = 'open'")).toContainEqual(
      expect.objectContaining({ code: "filter-invalid", severity: "error" }),
    );
  });

  test("validates runtime sources and layer style values with MapLibre style-spec diagnostics", async () => {
    const { runtime, map } = await loadRuntime();

    const sourceDiagnostics = captureRuntimeDiagnostics(() => {
      runtime.addSource("bad-source", { type: "geojson" });
    });
    expect(sourceDiagnostics).toContainEqual(
      expect.objectContaining({
        code: "style-spec-invalid",
        severity: "error",
        path: "sources.bad-source",
        sourceId: "bad-source",
        context: expect.objectContaining({
          mapLibreCode: "validation-error",
          mapLibrePath: "sources.bad-source",
        }),
      }),
    );

    map._calls.length = 0;
    const paintDiagnostics = captureRuntimeDiagnostics(() => {
      runtime.setLayerPaint("parcels-fill", { "fill-opacity": "opaque" });
    });
    expect(paintDiagnostics).toContainEqual(
      expect.objectContaining({
        code: "style-spec-invalid",
        severity: "error",
        path: "layers.parcels-fill.paint.fill-opacity",
        layerId: "parcels-fill",
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        context: expect.objectContaining({
          mapLibreCode: "validation-error",
          mapLibrePath: "layers[0].paint.fill-opacity",
        }),
      }),
    );
    expect(map._calls).toEqual([]);

    const layoutDiagnostics = captureRuntimeDiagnostics(() => {
      runtime.setLayerLayout("parcels-fill", { visibility: "sometimes" });
    });
    expect(layoutDiagnostics).toContainEqual(
      expect.objectContaining({
        code: "style-spec-invalid",
        path: "layers.parcels-fill.layout.visibility",
      }),
    );

    const filterDiagnostics = runtime.validateFilterExpression(["==", ["get"]], "parcels-fill");
    expect(filterDiagnostics).toContainEqual(
      expect.objectContaining({
        code: "style-spec-invalid",
        path: "layers.parcels-fill.filter",
        layerId: "parcels-fill",
      }),
    );
  });

  test("supports warning-only and renderer-deferred style-spec validation modes", async () => {
    const warningMap = makeMockMap();
    const { runtime: warningRuntime } = await loadRuntime(warningMap, {
      styleSpecValidationMode: "warning-only",
    });
    expect(() => warningRuntime.setLayerPaint("parcels-fill", { "fill-opacity": "opaque" })).not.toThrow();
    expect(warningMap._calls).toContainEqual({
      method: "setPaintProperty",
      args: ["parcels-fill", "fill-opacity", "opaque"],
    });

    const deferredMap = makeMockMap();
    const { runtime: deferredRuntime } = await loadRuntime(deferredMap, {
      styleSpecValidationMode: "renderer-deferred",
    });
    expect(() => deferredRuntime.setLayerLayout("parcels-fill", { visibility: "sometimes" })).not.toThrow();
    expect(deferredMap._calls).toContainEqual({
      method: "setLayoutProperty",
      args: ["parcels-fill", "visibility", "sometimes"],
    });
  });

  test("validates full styles without initializing a MapLibre map", async () => {
    await expect(
      validateRuntimeStyleSpec({
        version: 8,
        sources: {
          incidents: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
        },
        layers: [
          {
            id: "incidents",
            type: "circle",
            source: "incidents",
            paint: { "circle-color": "#d33", "circle-radius": 6 },
          },
        ],
      }),
    ).resolves.toEqual([]);

    await expect(
      validateRuntimeStyleSpec({
        version: 8,
        sources: {
          incidents: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
        },
        layers: [
          {
            id: "incidents",
            type: "circle",
            source: "incidents",
            paint: { "circle-radius": "large" },
          },
        ],
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        code: "style-spec-invalid",
        severity: "error",
        path: "layers[0].paint.circle-radius",
      }),
    );
  });
});

describe("runtime interaction helpers", () => {
  test("infers source context for hover, click, select, and feature-state helpers", async () => {
    const { runtime, map } = await loadRuntime();

    const hover = runtime.bindHover("parcels-fill");
    map._fire("mousemove", "parcels-fill", { features: [{ id: 3 }] });
    expect(hover.hoveredId).toBe(3);
    expect(map._featureState.get("parcels::3")).toEqual({ hover: true });

    const clicks: unknown[] = [];
    runtime.bindClick("parcels-fill", (event) => clicks.push(event));
    map._fire("click", "parcels-fill", { features: [{ id: 4, properties: { name: "Parcel 4" } }] });
    expect(clicks[0]).toMatchObject({
      layerId: "parcels-fill",
      sourceId: "parcels",
      featureId: 4,
      selectionTarget: { sourceId: "parcels", id: 4 },
    });

    const selection = runtime.bindSelect("parcels-fill");
    map._fire("click", "parcels-fill", { features: [{ id: 5 }] });
    expect(selection.selectedTargets).toEqual([sourceFeatureSelectionTarget("parcels", 5)]);

    const target = runtime.layerSelectionTarget("parcels-fill", 6);
    runtime.setFeatureStateForTarget(target, { selected: true });
    expect(runtime.getFeatureStateForTarget(target)).toEqual({ selected: true });
    runtime.removeFeatureStateForTarget(target, "selected");
    expect(runtime.getFeatureStateForTarget(target)).toEqual({});
  });

  test("bridges layer selection to ExplorationContext and syncs source-qualified feature-state back", async () => {
    const { runtime, map } = await loadRuntime();
    const context = createExplorationContext({ datasetId: "d", sourceIds: ["parcels"] });
    const mapView = context.connectView({ id: "map", role: "map" });
    const tableView = context.connectView({ id: "table", role: "grid" });

    runtime.bindSelectionToExploration("parcels-fill", mapView);
    map._fire("click", "parcels-fill", { features: [{ id: 101 }] });
    await flush();
    expect(context.state.selection).toEqual([sourceFeatureSelectionTarget("parcels", 101)]);

    runtime.syncSelectionFromExploration("parcels-fill", mapView);
    tableView.select([sourceFeatureSelectionTarget("parcels", 202)], { replace: true });
    await flush();
    expect(map._featureState.get("parcels::202")).toEqual({ selected: true });

    context.dispose();
  });
});
