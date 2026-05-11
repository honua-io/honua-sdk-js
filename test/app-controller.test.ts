import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HONUA_CONTROLLER_SNAPSHOT_VERSION,
  HonuaController,
  HonuaControllerError,
  createHonuaController,
} from "../src/app-controller/index.js";
import type { HonuaControllerRuntimeLike, HonuaViewport } from "../src/app-controller/index.js";
import { createExplorationContext } from "../src/exploration/index.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage, type MaplibreMap } from "../src/runtime/index.js";

interface MockCall {
  readonly method: string;
  readonly args: unknown[];
}

interface MockBounds {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

interface MockMap extends MaplibreMap {
  readonly calls: MockCall[];
  readonly listeners: Map<string, Set<() => void>>;
  bounds: readonly [number, number, number, number];
  center: readonly [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  trigger(event: string): void;
  getBounds(): MockBounds;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getPitch(): number;
  getBearing(): number;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeMapPackage(): HonuaMapPackage {
  return {
    mapPackageId: "controller-package",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [
      {
        sourceId: "incidents",
        protocol: "geoservices_feature_service",
        locator: { url: "https://example.test/FeatureServer/0" },
      },
      {
        sourceId: "units",
        protocol: "ogc_features",
        locator: { url: "https://example.test/ogc", collectionId: "units" },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [
        {
          id: "incident-points",
          type: "circle",
          source: "incidents",
          layout: { visibility: "visible" },
          paint: { "circle-color": "#d73027" },
        },
        {
          id: "unit-lines",
          type: "line",
          source: "units",
          layout: { visibility: "visible" },
          paint: { "line-color": "#4575b4" },
        },
      ],
    },
    legend: [{ label: "Incidents" }],
    initialView: { bbox: [-160, 18, -154, 23], center: [-157, 20.5], zoom: 7 },
  };
}

function makeMockMap(): MockMap {
  const calls: MockCall[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const featureState = new Map<string, Record<string, unknown>>();
  const map: MockMap = {
    calls,
    listeners,
    bounds: [-160, 18, -154, 23],
    center: [-157, 20.5],
    zoom: 7,
    pitch: 0,
    bearing: 0,
    trigger(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    getBounds() {
      const [west, south, east, north] = this.bounds;
      return {
        getWest: () => west,
        getSouth: () => south,
        getEast: () => east,
        getNorth: () => north,
      };
    },
    getCenter() {
      return { lng: this.center[0], lat: this.center[1] };
    },
    getZoom() {
      return this.zoom;
    },
    getPitch() {
      return this.pitch;
    },
    getBearing() {
      return this.bearing;
    },
    setStyle(style) {
      calls.push({ method: "setStyle", args: [style] });
    },
    setLayoutProperty(layerId, name, value) {
      calls.push({ method: "setLayoutProperty", args: [layerId, name, value] });
    },
    addSource(id, source) {
      calls.push({ method: "addSource", args: [id, source] });
    },
    removeSource(id) {
      calls.push({ method: "removeSource", args: [id] });
    },
    addLayer(layer, beforeId) {
      calls.push({ method: "addLayer", args: [layer, beforeId] });
    },
    removeLayer(id) {
      calls.push({ method: "removeLayer", args: [id] });
    },
    fitBounds(bounds, options) {
      calls.push({ method: "fitBounds", args: [bounds, options] });
    },
    jumpTo(options) {
      calls.push({ method: "jumpTo", args: [options] });
    },
    setFeatureState(target, patch) {
      featureState.set(`${target.source}:${target.id}`, {
        ...(featureState.get(`${target.source}:${target.id}`) ?? {}),
        ...patch,
      });
    },
    getFeatureState(target) {
      return featureState.get(`${target.source}:${target.id}`) ?? {};
    },
    removeFeatureState(target) {
      featureState.delete(`${target.source}:${target.id}`);
    },
    on(event, layerOrHandler, handler) {
      const listener = typeof layerOrHandler === "function" ? layerOrHandler : handler;
      if (!listener) return;
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener as () => void);
    },
    off(event, layerOrHandler, handler) {
      const listener = typeof layerOrHandler === "function" ? layerOrHandler : handler;
      if (!listener) return;
      listeners.get(event)?.delete(listener as () => void);
    },
  };
  return map;
}

function makeRuntime(map = makeMockMap()): HonuaControllerRuntimeLike & { readonly calls: MockCall[] } {
  const mapPackage = makeMapPackage();
  const runtimeCalls: MockCall[] = [];
  return {
    calls: runtimeCalls,
    map,
    mapPackage,
    composedStyle: mapPackage.mapSpec,
    setViewState(view) {
      runtimeCalls.push({ method: "setViewState", args: [view] });
      if (view.bbox) map.bounds = view.bbox;
      if (view.center) map.center = view.center;
      if (view.zoom !== undefined) map.zoom = view.zoom;
      if (view.pitch !== undefined) map.pitch = view.pitch;
      if (view.bearing !== undefined) map.bearing = view.bearing;
    },
    setLayerVisibility(layerId, visible) {
      runtimeCalls.push({ method: "setLayerVisibility", args: [layerId, visible] });
      map.setLayoutProperty?.(layerId, "visibility", visible ? "visible" : "none");
    },
    getLegend() {
      return [{ id: "incidents-0", label: "Incidents", color: "#d73027" }];
    },
    dispose() {
      runtimeCalls.push({ method: "dispose", args: [] });
    },
  };
}

describe("HonuaController", () => {
  it("exports the app-controller package subpath", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };
    expect(packageJson.exports?.["./app-controller"]).toEqual({
      types: "./dist/src/app-controller/index.d.ts",
      default: "./dist/src/app-controller/index.js",
    });
    expect(HonuaController).toBeTypeOf("function");
    expect(createHonuaController).toBeTypeOf("function");
  });

  it("wraps a MapPackage runtime for viewport control, move events, and idle snapshots", async () => {
    const map = makeMockMap();
    const runtime = makeRuntime(map);
    const controller = createHonuaController({ runtime });
    const moves: HonuaViewport[] = [];
    const moveEnds: HonuaViewport[] = [];
    const idles: number[] = [];

    controller.onViewportMove((event) => moves.push(event.viewport));
    controller.onViewportMoveEnd((event) => moveEnds.push(event.viewport));
    controller.onIdle((event) => idles.push(event.snapshot.version));

    controller.fitBounds([-159, 19, -155, 22], { padding: 24, animate: true });
    await flush();

    expect(runtime.calls.find((call) => call.method === "setViewState")?.args[0]).toMatchObject({
      bbox: [-159, 19, -155, 22],
      padding: 24,
      animate: true,
    });
    expect(controller.context.state.extent).toMatchObject({ xmin: -159, ymin: 19, xmax: -155, ymax: 22 });
    expect(moves.at(-1)?.bbox).toEqual([-159, 19, -155, 22]);
    expect(moveEnds.at(-1)?.bbox).toEqual([-159, 19, -155, 22]);
    expect(idles).toContain(HONUA_CONTROLLER_SNAPSHOT_VERSION);

    controller.setViewport({ center: [-156.5, 20.75], zoom: 10, pitch: 30 });
    expect(runtime.calls.at(-1)?.args[0]).toMatchObject({ center: [-156.5, 20.75], zoom: 10, pitch: 30 });

    map.bounds = [-158, 20, -157, 21];
    map.trigger("move");
    expect(controller.getViewport().bbox).toEqual([-158, 20, -157, 21]);
  });

  it("preserves source-qualified selection and supports unsubscribe", async () => {
    const controller = createHonuaController({ runtime: makeRuntime() });
    const listener = vi.fn();
    const unsubscribe = controller.onSelectionChange(listener);

    controller.selectFeature("incidents", 1001);
    await flush();

    expect(controller.getSelection()).toEqual([{ sourceId: "incidents", id: 1001 }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      type: "selection-change",
      selection: [{ sourceId: "incidents", id: 1001 }],
      previous: [],
    });

    controller.selectFeature("units", "unit-a", { replace: false });
    await flush();
    expect(controller.getSelection()).toEqual([
      { sourceId: "incidents", id: 1001 },
      { sourceId: "units", id: "unit-a" },
    ]);
    expect(controller.getSelection({ sourceId: "units" })).toEqual([{ sourceId: "units", id: "unit-a" }]);

    unsubscribe();
    controller.clearSelection();
    await flush();

    expect(controller.getSelection()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("applies bulk layer, layer-group, and legend-item visibility as one snapshot change", () => {
    const map = makeMockMap();
    const controller = createHonuaController({
      runtime: makeRuntime(map),
      layerGroups: { operations: ["incident-points", "unit-lines"] },
      legendItemLayers: { "incidents-0": ["incident-points"] },
    });
    const events: string[] = [];
    controller.onVisibilityChange((event) => {
      events.push(
        `${event.hide.map((target) => `${target.kind}:${target.id}`).join(",")} -> ${JSON.stringify(event.visibility.layers)}`,
      );
    });

    controller.setVisibility({
      hide: [
        { kind: "layer", id: "unit-lines" },
        { kind: "layer-group", id: "operations" },
        { kind: "legend-item", id: "incidents-0" },
      ],
    });

    expect(events).toHaveLength(1);
    expect(controller.getVisibility()).toMatchObject({
      layers: { "incident-points": false, "unit-lines": false },
      layerGroups: { operations: false },
      legendItems: { "incidents-0": false },
    });
    expect(map.calls.filter((call) => call.method === "setLayoutProperty").map((call) => call.args)).toEqual([
      ["unit-lines", "visibility", "none"],
      ["incident-points", "visibility", "none"],
    ]);

    controller.setLayerGroupVisibility({ show: ["operations"] });
    expect(controller.getVisibility().layers).toMatchObject({ "incident-points": true, "unit-lines": true });
  });

  it("stores temporary overlays and annotations while rendering them through the map adapter", () => {
    const map = makeMockMap();
    const controller = createHonuaController({ runtime: makeRuntime(map) });

    controller.addOverlay({ id: "dispatch", kind: "point", coordinate: [-157, 21], properties: { status: "open" } });
    controller.addOverlay({
      id: "route",
      kind: "line",
      coordinates: [
        [-157, 21],
        [-156.8, 21.1],
      ],
    });
    controller.addOverlay({
      id: "zone",
      kind: "polygon",
      rings: [
        [
          [-157, 21],
          [-156, 21],
          [-156, 22],
          [-157, 22],
          [-157, 21],
        ],
      ],
    });
    controller.addAnnotation({ id: "label", kind: "text", coordinate: [-157, 21], text: "Dispatch point" });
    controller.addAnnotation({ id: "note", kind: "note", text: "Session note" });

    expect(controller.getOverlays().map((overlay) => overlay.kind)).toEqual(["point", "line", "polygon"]);
    expect(controller.getAnnotations().map((annotation) => annotation.kind)).toEqual(["text", "note"]);
    expect(map.calls.filter((call) => call.method === "addSource").map((call) => call.args[0])).toEqual([
      "honua-controller-overlay-dispatch",
      "honua-controller-overlay-route",
      "honua-controller-overlay-zone",
      "honua-controller-annotation-label",
    ]);
    expect(map.calls.filter((call) => call.method === "addLayer").length).toBeGreaterThanOrEqual(5);

    expect(controller.removeOverlay("route")).toBe(true);
    expect(
      map.calls.some((call) => call.method === "removeSource" && call.args[0] === "honua-controller-overlay-route"),
    ).toBe(true);
  });

  it("restores snapshots and throws a typed error after disposal", async () => {
    const runtime = makeRuntime();
    const controller = createHonuaController({ runtime, disposeRuntime: true });
    controller.selectFeature("incidents", 1001);
    controller.setLayerVisibility("incident-points", false);
    controller.addOverlay({ id: "focus", kind: "point", coordinate: [-157, 21] });
    await flush();

    const snapshot = controller.snapshot();
    controller.clearSelection();
    controller.setLayerVisibility("incident-points", true);
    controller.clearOverlays();

    controller.restore(snapshot);
    await flush();

    expect(controller.getSelection()).toEqual([{ sourceId: "incidents", id: 1001 }]);
    expect(controller.getVisibility().layers["incident-points"]).toBe(false);
    expect(controller.getOverlays()).toHaveLength(1);

    controller.dispose();
    expect(runtime.calls.some((call) => call.method === "dispose")).toBe(true);
    expect(() => controller.getViewport()).toThrow(HonuaControllerError);
    try {
      controller.getViewport();
    } catch (error) {
      expect(error).toMatchObject({ code: "disposed" });
    }
  });

  it("adapts generated-app runtime context without application branching", async () => {
    const context = createExplorationContext({ datasetId: "generated-app", sourceIds: ["incidents"] });
    const generatedRuntime = { context, mapRuntime: makeRuntime(), manifest: { appId: "generated-app" } };
    const controller = createHonuaController({ runtime: generatedRuntime });

    controller.selectFeature("incidents", 99);
    await flush();

    expect(context.state.selection).toEqual([{ sourceId: "incidents", id: 99 }]);
    expect(controller.snapshot().exploration.state.selection).toEqual([{ sourceId: "incidents", id: 99 }]);
  });
});
