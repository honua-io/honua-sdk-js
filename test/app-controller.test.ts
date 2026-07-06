import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HONUA_CONTROLLER_SNAPSHOT_VERSION,
  HonuaController,
  HonuaControllerError,
  createHonuaController,
} from "../src/app-controller/index.js";
import type { HonuaControllerAdapter, HonuaControllerRuntimeLike, HonuaViewport } from "../src/app-controller/index.js";
import { createExplorationContext } from "../src/exploration/index.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  HonuaRuntimeDiagnosticError,
  type MaplibreMap,
} from "../src/runtime/index.js";

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
    moveLayer(id, beforeId) {
      calls.push({ method: "moveLayer", args: [id, beforeId] });
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
  let composedStyle = structuredClone(mapPackage.mapSpec) as HonuaMapPackage["mapSpec"];
  return {
    calls: runtimeCalls,
    map,
    mapPackage,
    get composedStyle() {
      return composedStyle;
    },
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
    addSource(sourceId, source) {
      runtimeCalls.push({ method: "addSource", args: [sourceId, source] });
      if (Object.hasOwn(composedStyle.sources, sourceId)) {
        throw new HonuaRuntimeDiagnosticError("duplicate source", [
          { code: "source-duplicate", severity: "error", message: "duplicate source", sourceId },
        ]);
      }
      composedStyle = { ...composedStyle, sources: { ...composedStyle.sources, [sourceId]: source } };
      map.addSource?.(sourceId, source);
    },
    updateSource(sourceId, source) {
      runtimeCalls.push({ method: "updateSource", args: [sourceId, source] });
      composedStyle = { ...composedStyle, sources: { ...composedStyle.sources, [sourceId]: source } };
      map.setStyle(composedStyle, { diff: true });
    },
    removeSource(sourceId) {
      runtimeCalls.push({ method: "removeSource", args: [sourceId] });
      const removedLayerIds = composedStyle.layers
        .filter((layer) => layer.source === sourceId)
        .map((layer) => layer.id);
      const sources = { ...composedStyle.sources };
      delete sources[sourceId];
      composedStyle = {
        ...composedStyle,
        sources,
        layers: composedStyle.layers.filter((layer) => layer.source !== sourceId),
      };
      for (const layerId of removedLayerIds) map.removeLayer?.(layerId);
      map.removeSource?.(sourceId);
      return removedLayerIds;
    },
    addLayer(layer, order) {
      runtimeCalls.push({ method: "addLayer", args: [layer, order] });
      const layers = [...composedStyle.layers];
      const beforeId = typeof order === "string" ? order : order?.beforeId;
      const index = beforeId ? layers.findIndex((entry) => entry.id === beforeId) : -1;
      if (index >= 0) layers.splice(index, 0, layer);
      else layers.push(layer);
      composedStyle = { ...composedStyle, layers };
      map.addLayer?.(layer, beforeId);
    },
    updateLayer(layerId, update) {
      runtimeCalls.push({ method: "updateLayer", args: [layerId, update] });
      composedStyle = {
        ...composedStyle,
        layers: composedStyle.layers.map((layer) =>
          layer.id === layerId ? { ...layer, ...update, id: layerId } : layer,
        ),
      };
      map.setStyle(composedStyle, { diff: true });
    },
    moveLayer(layerId, order) {
      runtimeCalls.push({ method: "moveLayer", args: [layerId, order] });
      const beforeId = typeof order === "string" ? order : order?.beforeId;
      const moving = composedStyle.layers.find((layer) => layer.id === layerId);
      if (!moving) return;
      const layers = composedStyle.layers.filter((layer) => layer.id !== layerId);
      const index = beforeId ? layers.findIndex((entry) => entry.id === beforeId) : -1;
      if (index >= 0) layers.splice(index, 0, moving);
      else layers.push(moving);
      composedStyle = { ...composedStyle, layers };
      map.moveLayer?.(layerId, beforeId);
    },
    removeLayer(layerId) {
      runtimeCalls.push({ method: "removeLayer", args: [layerId] });
      const exists = composedStyle.layers.some((layer) => layer.id === layerId);
      composedStyle = { ...composedStyle, layers: composedStyle.layers.filter((layer) => layer.id !== layerId) };
      if (exists) map.removeLayer?.(layerId);
      return exists;
    },
    setLayerPaint(layerId, paint) {
      runtimeCalls.push({ method: "setLayerPaint", args: [layerId, paint] });
      composedStyle = {
        ...composedStyle,
        layers: composedStyle.layers.map((layer) => (layer.id === layerId ? { ...layer, paint } : layer)),
      };
      map.setStyle(composedStyle, { diff: true });
    },
    setLayerLayout(layerId, layout) {
      runtimeCalls.push({ method: "setLayerLayout", args: [layerId, layout] });
      composedStyle = {
        ...composedStyle,
        layers: composedStyle.layers.map((layer) => (layer.id === layerId ? { ...layer, layout } : layer)),
      };
      map.setStyle(composedStyle, { diff: true });
    },
    setLayerFilter(layerId, filter) {
      runtimeCalls.push({ method: "setLayerFilter", args: [layerId, filter] });
      composedStyle = {
        ...composedStyle,
        layers: composedStyle.layers.map((layer) => (layer.id === layerId ? { ...layer, filter } : layer)),
      };
      map.setStyle(composedStyle, { diff: true });
    },
    refreshSource(sourceId) {
      runtimeCalls.push({ method: "refreshSource", args: [sourceId] });
      return Object.hasOwn(composedStyle.sources, sourceId);
    },
    validateStyleExpression(value) {
      return Array.isArray(value) && value.length === 0
        ? [{ code: "expression-empty", severity: "error", message: "expression cannot be empty" }]
        : [];
    },
    validateFilterExpression(filter) {
      return typeof filter === "string"
        ? [{ code: "filter-invalid", severity: "error", message: "filter must be an expression array" }]
        : [];
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
    // Moved to `@honua/app-platform/app-controller` in the 1.0 scope split; the
    // old subpath resolves through a one-minor `@deprecated` re-export shim.
    expect(packageJson.exports?.["./app-controller"]).toEqual({
      types: "./dist/src/_deprecated/app-controller.d.ts",
      default: "./dist/src/_deprecated/app-controller.js",
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

  it("exposes controller-level source and layer CRUD with persistence hooks", async () => {
    const runtime = makeRuntime();
    const save = vi.fn().mockResolvedValue({ version: "v2", concurrencyToken: "etag-2" });
    const discard = vi.fn().mockResolvedValue(undefined);
    const controller = createHonuaController({
      runtime,
      layerSourcePersistence: { save, discard },
    });
    const events: string[] = [];
    controller.onLayerSourceChange((event) => events.push(event.action));

    controller.addSource("dispatch", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    controller.addLayer(
      {
        id: "dispatch-points",
        type: "circle",
        source: "dispatch",
        paint: { "circle-color": "#00a884" },
      },
      { beforeId: "incident-points" },
    );
    controller.setLayerPaint("dispatch-points", { "circle-color": "#006f5f" });
    controller.moveLayer("dispatch-points", { afterId: "unit-lines" });

    expect(controller.getSource("dispatch")).toMatchObject({ type: "geojson" });
    expect(controller.listLayers().map((layer) => layer.id)).toEqual([
      "incident-points",
      "unit-lines",
      "dispatch-points",
    ]);
    expect(events).toEqual(["source-added", "layer-added", "layer-updated", "layer-moved"]);
    expect(controller.getPendingLayerSourceMutations()).toHaveLength(4);

    const saved = await controller.saveLayerSourceChanges({ baseVersion: "v1", concurrencyToken: "etag-1" });
    expect(saved).toMatchObject({ mutationCount: 4, persisted: true, conflict: false, version: "v2" });
    expect(save.mock.calls[0][0]).toMatchObject({
      baseVersion: "v1",
      concurrencyToken: "etag-1",
      mutations: expect.arrayContaining([expect.objectContaining({ action: "source-added", sourceId: "dispatch" })]),
      style: { sources: { dispatch: { type: "geojson" } } },
    });
    expect(controller.hasPendingLayerSourceMutations()).toBe(false);

    expect(controller.removeLayer("dispatch-points")).toBe(true);
    expect(controller.removeSource("dispatch")).toEqual([]);
    const discarded = await controller.discardLayerSourceChanges();
    expect(discarded).toMatchObject({ mutationCount: 2, persisted: true, conflict: false });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(controller.hasPendingLayerSourceMutations()).toBe(false);
  });

  it("runs source and layer CRUD through a renderer-neutral adapter test double", () => {
    let style: HonuaMapPackage["mapSpec"] = { version: 8, sources: {}, layers: [] };
    const calls: MockCall[] = [];
    const adapter: HonuaControllerAdapter = {
      getStyle: () => style,
      addSource(sourceId, source) {
        calls.push({ method: "addSource", args: [sourceId, source] });
        style = { ...style, sources: { ...style.sources, [sourceId]: source } };
      },
      addLayer(layer) {
        calls.push({ method: "addLayer", args: [layer] });
        style = { ...style, layers: [...style.layers, layer] };
      },
      updateLayer(layerId, update) {
        calls.push({ method: "updateLayer", args: [layerId, update] });
        style = {
          ...style,
          layers: style.layers.map((layer) => (layer.id === layerId ? { ...layer, ...update, id: layerId } : layer)),
        };
      },
      moveLayer(layerId) {
        calls.push({ method: "moveLayer", args: [layerId] });
      },
      removeLayer(layerId) {
        calls.push({ method: "removeLayer", args: [layerId] });
        const exists = style.layers.some((layer) => layer.id === layerId);
        style = { ...style, layers: style.layers.filter((layer) => layer.id !== layerId) };
        return exists;
      },
      removeSource(sourceId) {
        calls.push({ method: "removeSource", args: [sourceId] });
        const sources = { ...style.sources };
        delete sources[sourceId];
        style = { ...style, sources };
        return [];
      },
    };

    const controller = createHonuaController({ adapter });
    controller.addSource("adapter-source", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    controller.addLayer({ id: "adapter-layer", type: "circle", source: "adapter-source" });
    controller.updateLayer("adapter-layer", { metadata: { title: "Adapter layer" } });
    controller.moveLayer("adapter-layer");

    expect(controller.getLayer("adapter-layer")).toMatchObject({ metadata: { title: "Adapter layer" } });
    expect(controller.removeLayer("adapter-layer")).toBe(true);
    expect(controller.removeSource("adapter-source")).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual([
      "addSource",
      "addLayer",
      "updateLayer",
      "moveLayer",
      "removeLayer",
      "removeSource",
    ]);
  });

  it("preserves typed diagnostics and does not mark failed CRUD mutations as pending", () => {
    const runtime = makeRuntime();
    runtime.addSource = vi.fn(() => {
      throw new HonuaRuntimeDiagnosticError("invalid source", [
        { code: "source-invalid", severity: "error", message: "invalid source", sourceId: "bad" },
      ]);
    });
    const controller = createHonuaController({ runtime });

    expect(() =>
      controller.addSource("bad", { type: "geojson", data: { type: "FeatureCollection", features: [] } }),
    ).toThrow(HonuaRuntimeDiagnosticError);
    expect(controller.getPendingLayerSourceMutations()).toEqual([]);
    expect(controller.validateFilterExpression("status = 'open'")).toContainEqual(
      expect.objectContaining({ code: "filter-invalid", severity: "error" }),
    );
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
