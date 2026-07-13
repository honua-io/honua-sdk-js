import { describe, expect, it, vi } from "vitest";

import type { QueryTileSourceDescriptor } from "../src/contract/tiles.js";
import type { Capabilities, Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import {
  type DataToMapLibreMap,
  HonuaDataToMapBridgeError,
  type MountSourceOptions,
  explainDataToMapStrategy,
  mountSource,
} from "../src/map/index.js";
import type { PopupHandle } from "../src/runtime/popups.js";

// ── Test doubles ─────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

class FakeGeoJsonSourceHandle {
  data: unknown;
  readonly setDataCalls: unknown[] = [];
  constructor(spec: Record<string, unknown>) {
    Object.assign(this, spec);
    this.data = spec.data;
  }
  setData(data: unknown): void {
    this.data = data;
    this.setDataCalls.push(data);
  }
}

class FakeVectorSourceHandle {
  tiles: string[] | undefined;
  readonly setTilesCalls: string[][] = [];
  constructor(
    spec: Record<string, unknown>,
    private readonly supportsSetTiles: boolean,
  ) {
    Object.assign(this, spec);
    this.tiles = Array.isArray(spec.tiles) ? [...(spec.tiles as string[])] : undefined;
    if (!supportsSetTiles) {
      (this as Record<string, unknown>).setTiles = undefined;
    }
  }
  setTiles(tiles: string[]): void {
    this.tiles = tiles;
    this.setTilesCalls.push(tiles);
  }
}

class FakeMap implements DataToMapLibreMap {
  readonly sources = new Map<string, FakeGeoJsonSourceHandle | FakeVectorSourceHandle>();
  readonly layers = new Map<string, Record<string, unknown>>();
  readonly layerOrder: string[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly featureStates = new Map<string, Record<string, unknown>>();
  readonly calls: string[] = [];
  readonly fitBoundsCalls: unknown[] = [];
  supportsSetTiles = true;
  failAddLayerId: string | undefined;

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
  addSource(id: string, spec: unknown): void {
    this.calls.push(`addSource:${id}`);
    const record = spec as Record<string, unknown>;
    this.sources.set(
      id,
      record.type === "geojson"
        ? new FakeGeoJsonSourceHandle(record)
        : new FakeVectorSourceHandle(record, this.supportsSetTiles),
    );
  }
  removeSource(id: string): void {
    this.calls.push(`removeSource:${id}`);
    this.sources.delete(id);
  }
  getLayer(id: string): unknown {
    return this.layers.get(id);
  }
  addLayer(layer: unknown, _beforeId?: string): void {
    const record = layer as Record<string, unknown>;
    const id = String(record.id);
    this.calls.push(`addLayer:${id}`);
    if (this.failAddLayerId === id) throw new Error(`host rejected layer ${id}`);
    this.layers.set(id, record);
    this.layerOrder.push(id);
  }
  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    this.layers.delete(id);
  }
  on(event: string, layerOrHandler: string | Listener, handler?: Listener): void {
    const key = typeof layerOrHandler === "string" ? `${event}:${layerOrHandler}` : event;
    const fn = (typeof layerOrHandler === "function" ? layerOrHandler : handler) as Listener;
    const set = this.listeners.get(key) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(key, set);
  }
  off(event: string, layerOrHandler: string | Listener, handler?: Listener): void {
    const key = typeof layerOrHandler === "string" ? `${event}:${layerOrHandler}` : event;
    const fn = (typeof layerOrHandler === "function" ? layerOrHandler : handler) as Listener;
    this.listeners.get(key)?.delete(fn);
  }
  emit(event: string, layerId: string, payload: unknown): void {
    for (const listener of this.listeners.get(`${event}:${layerId}`) ?? []) listener(payload);
  }
  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
  setFeatureState(target: { source: string; id: string | number }, state: Record<string, unknown>): void {
    const key = `${target.source}:${target.id}`;
    this.featureStates.set(key, { ...(this.featureStates.get(key) ?? {}), ...state });
  }
  getFeatureState(target: { source: string; id: string | number }): Record<string, unknown> {
    return this.featureStates.get(`${target.source}:${target.id}`) ?? {};
  }
  removeFeatureState(target: { source: string; id: string | number }, key?: string): void {
    if (key === undefined) {
      this.featureStates.delete(`${target.source}:${target.id}`);
      return;
    }
    const state = this.featureStates.get(`${target.source}:${target.id}`);
    if (state) delete state[key];
  }
  fitBounds(bounds: [number, number, number, number], options?: Record<string, unknown>): void {
    this.fitBoundsCalls.push({ bounds, options });
  }
}

interface Attrs {
  OBJECTID: number;
  NAME: string;
}

function pointFeature(id: number, x: number, y: number): { attributes: Attrs; geometry: unknown } {
  return { attributes: { OBJECTID: id, NAME: `f-${id}` }, geometry: { type: "Point", coordinates: [x, y] } };
}

function polygonFeature(id: number): { attributes: Attrs; geometry: unknown } {
  return {
    attributes: { OBJECTID: id, NAME: `f-${id}` },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-158, 21],
          [-158, 22],
          [-157, 22],
          [-157, 21],
          [-158, 21],
        ],
      ],
    },
  };
}

function descriptor(overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: "Census Parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://demo.test/rest/services/Parcels/FeatureServer/0" },
    capabilities: capabilities(["query", "queryExtent"]),
    schema: { primaryKey: "OBJECTID" },
    attribution: "Test data",
    ...overrides,
  };
}

interface FakeSourceOptions {
  result?: Partial<Result<Attrs>>;
  extentCount?: number;
  queryExtentError?: Error;
}

function fakeSource(
  desc: SourceDescriptor,
  options: FakeSourceOptions = {},
): Source<Attrs> & {
  queryAllMock: ReturnType<typeof vi.fn>;
  queryExtentMock: ReturnType<typeof vi.fn>;
} {
  const baseResult: Result<Attrs> = {
    features: [pointFeature(1, -158, 21.4), pointFeature(2, -157.5, 21.6)] as never,
    exceededTransferLimit: false,
    ...options.result,
  };
  const queryAllMock = vi.fn(async (_request?: Query<Attrs>) => baseResult);
  const queryExtentMock = vi.fn(async (_request?: Query<Attrs>) => {
    if (options.queryExtentError) throw options.queryExtentError;
    return { extent: null, count: options.extentCount };
  });
  const notSupported = () => {
    throw new HonuaCapabilityNotSupportedError("query", desc.protocol, desc.id);
  };
  return {
    descriptor: desc,
    capabilities: desc.capabilities as Capabilities,
    query: queryAllMock as never,
    queryAll: queryAllMock as never,
    queryAllMock,
    queryExtent: queryExtentMock as never,
    queryExtentMock,
    queryAggregate: notSupported as never,
    queryObjectIds: notSupported as never,
    stream: notSupported as never,
    applyEdits: notSupported as never,
    queryRelated: notSupported as never,
    attachments: {} as never,
    protocol: () => undefined,
    adapter: () => undefined,
  };
}

function tileDescriptor(overrides: Partial<QueryTileSourceDescriptor<Attrs>> = {}): QueryTileSourceDescriptor<Attrs> {
  return {
    kind: "query-vector-tile",
    id: "parcels-tiles",
    sourceId: "parcels",
    protocol: "geoservices-feature-service",
    endpoint: { baseUrl: "https://demo.test/query-tiles" },
    minzoom: 0,
    maxzoom: 14,
    bounds: [-158, 21, -157, 22],
    cache: { maxEntries: 256, key: { sourceVersion: "v1", authorizationScope: "public" } },
    ...overrides,
  };
}

function popupFactory(): { factory: () => PopupHandle; opened: Array<Record<string, unknown>>; removed: number[] } {
  const opened: Array<Record<string, unknown>> = [];
  const removed: number[] = [];
  const factory = (): PopupHandle => {
    const record: Record<string, unknown> = {};
    opened.push(record);
    const handle: PopupHandle = {
      setLngLat(coord) {
        record.lngLat = coord;
        return handle;
      },
      setDOMContent(node) {
        record.dom = node;
        return handle;
      },
      setHTML(html) {
        record.html = html;
        return handle;
      },
      addTo(map) {
        record.map = map;
        return handle;
      },
      remove() {
        removed.push(1);
      },
    };
    return handle;
  };
  return { factory, opened, removed };
}

// ── Strategy selection ───────────────────────────────────────────

describe("explainDataToMapStrategy", () => {
  it("selects geojson for a query-only source and reports the tiles gap", async () => {
    const source = fakeSource(descriptor({ capabilities: capabilities(["query", "tiles"]) }));
    const explanation = await explainDataToMapStrategy(source);
    expect(explanation.strategy).toBe("geojson");
    expect(explanation.reasons.map((reason) => reason.code)).toEqual(["query-capability", "tile-endpoint-missing"]);
  });

  it("selects query-tiles when the source cannot query", async () => {
    const source = fakeSource(descriptor({ capabilities: capabilities(["tiles"]) }));
    const explanation = await explainDataToMapStrategy(source, { queryTiles: tileDescriptor() });
    expect(explanation.strategy).toBe("query-tiles");
    expect(explanation.reasons[0]?.code).toBe("tiles-capability");
  });

  it("uses the result-size probe to prefer geojson for small results", async () => {
    const source = fakeSource(descriptor(), { extentCount: 250 });
    const explanation = await explainDataToMapStrategy(source, { queryTiles: tileDescriptor() });
    expect(explanation.strategy).toBe("geojson");
    expect(explanation.probedCount).toBe(250);
    expect(explanation.reasons.at(-1)).toMatchObject({ code: "result-size-within-limit", severity: "info" });
  });

  it("uses the result-size probe to prefer query-tiles for large results", async () => {
    const source = fakeSource(descriptor(), { extentCount: 250_000 });
    const explanation = await explainDataToMapStrategy(source, { queryTiles: tileDescriptor() });
    expect(explanation.strategy).toBe("query-tiles");
    expect(explanation.reasons.at(-1)).toMatchObject({ code: "result-size-exceeds-limit" });
  });

  it("honors a custom maxGeoJsonFeatures threshold", async () => {
    const source = fakeSource(descriptor(), { extentCount: 250 });
    const explanation = await explainDataToMapStrategy(source, {
      queryTiles: tileDescriptor(),
      maxGeoJsonFeatures: 100,
    });
    expect(explanation.strategy).toBe("query-tiles");
  });

  it("probes the result size with the descriptor-level query when no explicit query is given", async () => {
    const source = fakeSource(descriptor(), { extentCount: 40 });
    const explanation = await explainDataToMapStrategy(source, {
      queryTiles: tileDescriptor({ query: { where: "Seats_2020 >= 10" } }),
    });
    expect(source.queryExtentMock).toHaveBeenCalledWith(expect.objectContaining({ where: "Seats_2020 >= 10" }));
    expect(explanation.strategy).toBe("geojson");
    expect(explanation.probedCount).toBe(40);
  });

  it("lets an explicit options.query override the descriptor query in the probe", async () => {
    const source = fakeSource(descriptor(), { extentCount: 40 });
    await explainDataToMapStrategy(source, {
      query: { where: "STATE = 'CA'" },
      queryTiles: tileDescriptor({ query: { where: "Seats_2020 >= 10" } }),
    });
    expect(source.queryExtentMock).toHaveBeenCalledWith(expect.objectContaining({ where: "STATE = 'CA'" }));
  });

  it("prefers query-tiles when the size probe is unavailable", async () => {
    const source = fakeSource(descriptor({ capabilities: capabilities(["query"]) }));
    const explanation = await explainDataToMapStrategy(source, { queryTiles: tileDescriptor() });
    expect(explanation.strategy).toBe("query-tiles");
    expect(explanation.reasons.map((reason) => reason.code)).toEqual([
      "count-probe-unavailable",
      "result-size-unknown",
    ]);
  });

  it("records a warning and prefers query-tiles when the probe fails", async () => {
    const source = fakeSource(descriptor(), { queryExtentError: new Error("boom") });
    const explanation = await explainDataToMapStrategy(source, { queryTiles: tileDescriptor() });
    expect(explanation.strategy).toBe("query-tiles");
    expect(explanation.reasons[0]).toMatchObject({ code: "count-probe-failed", severity: "warning" });
  });

  it("honors an explicit strategy override without probing", async () => {
    const source = fakeSource(descriptor(), { extentCount: 250_000 });
    const explanation = await explainDataToMapStrategy(source, { strategy: "geojson" });
    expect(explanation.strategy).toBe("geojson");
    expect(explanation.reasons[0]?.code).toBe("strategy-override");
    expect(source.queryExtentMock).not.toHaveBeenCalled();
  });

  it("rejects a query-tiles override without a tile descriptor", async () => {
    const source = fakeSource(descriptor());
    await expect(explainDataToMapStrategy(source, { strategy: "query-tiles" })).rejects.toMatchObject({
      name: "HonuaDataToMapBridgeError",
      code: "invalid-option",
    });
  });

  it("throws the typed capability error when neither strategy is possible", async () => {
    const source = fakeSource(descriptor({ capabilities: capabilities(["render"]) }));
    await expect(explainDataToMapStrategy(source)).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(explainDataToMapStrategy(source, { strategy: "geojson" })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
  });
});

// ── GeoJSON mounting ─────────────────────────────────────────────

describe("mountSource — geojson strategy", () => {
  it("materializes a GeoJSON source with the stable default layer matrix", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor());
    const mounted = await mountSource(map, source);

    expect(mounted.strategy).toBe("geojson");
    expect(mounted.sourceId).toBe("honua-census-parcels");
    const handle = map.sources.get("honua-census-parcels") as FakeGeoJsonSourceHandle;
    expect(handle).toBeDefined();
    expect((handle as unknown as Record<string, unknown>).promoteId).toBe("OBJECTID");
    expect((handle as unknown as Record<string, unknown>).attribution).toBe("Test data");
    const data = handle.data as { type: string; features: Array<Record<string, unknown>> };
    expect(data.type).toBe("FeatureCollection");
    expect(data.features).toHaveLength(2);
    expect(data.features[0]).toMatchObject({ id: 1, geometry: { type: "Point" } });

    expect(mounted.layerIds).toEqual([
      "honua-census-parcels-point",
      "honua-census-parcels-line",
      "honua-census-parcels-polygon",
      "honua-census-parcels-polygon-outline",
    ]);
    expect(map.layers.get("honua-census-parcels-point")).toMatchObject({
      type: "circle",
      source: "honua-census-parcels",
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-color": "#16735b", "circle-radius": 6 },
    });
    expect(map.layers.get("honua-census-parcels-line")).toMatchObject({ type: "line" });
    expect(map.layers.get("honua-census-parcels-polygon")).toMatchObject({
      type: "fill",
      paint: { "fill-color": "#37a887" },
    });
    expect(map.layers.get("honua-census-parcels-polygon-outline")).toMatchObject({
      type: "line",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "line-color": "#0e5643" },
    });
    expect(mounted.diagnostics.geometryKinds).toEqual(["point"]);
    expect(mounted.diagnostics.featureCount).toBe(2);
    expect(mounted.diagnostics.overflow).toBeUndefined();
  });

  it("restricts default styling to one geometry kind and merges paint overrides", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor(), { result: { features: [polygonFeature(1)] as never } });
    const mounted = await mountSource(map, source, {
      geometry: "polygon",
      paint: { polygon: { "fill-color": "#123456" }, polygonOutline: { "line-width": 4 } },
    });
    expect(mounted.layerIds).toEqual(["honua-census-parcels-polygon", "honua-census-parcels-polygon-outline"]);
    expect(map.layers.get("honua-census-parcels-polygon")?.paint).toMatchObject({
      "fill-color": "#123456",
      "fill-opacity": 0.55,
    });
    expect(map.layers.get("honua-census-parcels-polygon-outline")?.paint).toMatchObject({ "line-width": 4 });
  });

  it("accepts a full caller-provided layer override", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor());
    const mounted = await mountSource(map, source, {
      layers: [{ id: "custom-heat", type: "heatmap", paint: { "heatmap-radius": 12 } }],
    });
    expect(mounted.layerIds).toEqual(["custom-heat"]);
    expect(map.layers.get("custom-heat")).toMatchObject({ type: "heatmap", source: "honua-census-parcels" });
  });

  it("reports overflow diagnostics when pagination truncates the result", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor(), {
      result: { exceededTransferLimit: true, totalCount: 5000 },
    });
    const mounted = await mountSource(map, source, { maxGeoJsonFeatures: 2 });
    expect(mounted.diagnostics.overflow).toEqual({
      truncated: true,
      renderedFeatureCount: 2,
      limit: 2,
      totalCount: 5000,
    });
    expect(mounted.diagnostics.reasons).toContainEqual(
      expect.objectContaining({ code: "overflow-truncated", severity: "warning" }),
    );
  });

  it("caps queryAll pagination at maxGeoJsonFeatures", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor());
    await mountSource(map, source, { maxGeoJsonFeatures: 77, query: { where: "STATUS = 'OPEN'" } });
    expect(source.queryAllMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: "STATUS = 'OPEN'", pagination: { limit: 77 }, returnGeometry: true }),
    );
  });

  it("fits the map to the materialized data when requested", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor());
    await mountSource(map, source, { fitBounds: { padding: 12 } });
    expect(map.fitBoundsCalls).toEqual([{ bounds: [-158, 21.4, -157.5, 21.6], options: { padding: 12 } }]);
  });

  it("throws source-conflict / layer-conflict before mutating the map", async () => {
    const map = new FakeMap();
    map.addSource("honua-census-parcels", { type: "geojson" });
    const source = fakeSource(descriptor());
    await expect(mountSource(map, source)).rejects.toMatchObject({ code: "source-conflict" });

    const map2 = new FakeMap();
    map2.addLayer({ id: "honua-census-parcels-line", type: "line" });
    await expect(mountSource(map2, fakeSource(descriptor()))).rejects.toMatchObject({ code: "layer-conflict" });
    expect(map2.sources.size).toBe(0);
  });

  it("rolls back partial mutation when the host rejects a layer", async () => {
    const map = new FakeMap();
    map.failAddLayerId = "honua-census-parcels-polygon";
    const source = fakeSource(descriptor());
    await expect(mountSource(map, source)).rejects.toMatchObject({ code: "map-mutation-failed" });
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });
});

// ── Diff updates ─────────────────────────────────────────────────

describe("mountSource — diff updates", () => {
  it("setFilter re-queries and updates through setData without teardown", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor());
    const mounted = await mountSource(map, source);
    const handle = map.sources.get(mounted.sourceId) as FakeGeoJsonSourceHandle;
    const callsBefore = map.calls.length;

    const diagnostics = await mounted.setFilter({ where: "NAME = 'f-1'" });
    expect(handle.setDataCalls).toHaveLength(1);
    expect(map.calls.slice(callsBefore)).toEqual([]); // no add/remove churn
    expect(map.sources.get(mounted.sourceId)).toBe(handle);
    expect(diagnostics.updates).toContainEqual(expect.objectContaining({ code: "filter-applied" }));
    expect(source.queryAllMock).toHaveBeenLastCalledWith(expect.objectContaining({ where: "NAME = 'f-1'" }));

    await mounted.refresh();
    expect(handle.setDataCalls).toHaveLength(2);
    expect(source.queryAllMock).toHaveBeenLastCalledWith(expect.objectContaining({ where: "NAME = 'f-1'" }));
  });

  it("updates overflow diagnostics on filter changes", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor());
    const mounted = await mountSource(map, source);
    expect(mounted.diagnostics.overflow).toBeUndefined();

    source.queryAllMock.mockResolvedValueOnce({
      features: [pointFeature(1, -158, 21.4)] as never,
      exceededTransferLimit: true,
      totalCount: 90_000,
    });
    const diagnostics = await mounted.setFilter(undefined);
    expect(diagnostics.overflow).toMatchObject({ truncated: true, renderedFeatureCount: 1, totalCount: 90_000 });
  });

  it("serializes concurrent updates", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor());
    const mounted = await mountSource(map, source);
    const order: string[] = [];
    source.queryAllMock.mockImplementation(async (request?: Query<Attrs>) => {
      order.push(`start:${request?.where ?? "none"}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${request?.where ?? "none"}`);
      return { features: [], exceededTransferLimit: false };
    });
    await Promise.all([mounted.setFilter({ where: "A = 1" }), mounted.setFilter({ where: "B = 2" })]);
    expect(order).toEqual(["start:A = 1", "end:A = 1", "start:B = 2", "end:B = 2"]);
  });

  it("rejects updates after disposal", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(descriptor()));
    mounted.dispose();
    await expect(mounted.refresh()).rejects.toMatchObject({ code: "disposed" });
    await expect(mounted.setFilter({ where: "1=1" })).rejects.toMatchObject({ code: "disposed" });
  });
});

// ── Query-tiles mounting ─────────────────────────────────────────

describe("mountSource — query-tiles strategy", () => {
  it("mounts a vector tile source from the dynamic query-tile descriptor", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor({ capabilities: capabilities(["query", "tiles"]) }), {
      extentCount: 500_000,
    });
    const mounted = await mountSource(map, source, { queryTiles: tileDescriptor() });

    expect(mounted.strategy).toBe("query-tiles");
    const handle = map.sources.get(mounted.sourceId) as FakeVectorSourceHandle;
    expect((handle as unknown as Record<string, unknown>).type).toBe("vector");
    expect(handle.tiles?.[0]).toContain("https://demo.test/query-tiles/");
    expect(handle.tiles?.[0]).toContain("{z}");
    const layer = map.layers.get(`${mounted.sourceId}-point`);
    expect(layer).toMatchObject({ type: "circle", "source-layer": "parcels" });
    expect(mounted.diagnostics.reasons).toContainEqual(expect.objectContaining({ code: "tile-support" }));
    expect(source.queryAllMock).not.toHaveBeenCalled();
  });

  it("setFilter rewrites the tile URL template through setTiles", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor({ capabilities: capabilities(["tiles"]) }));
    const mounted = await mountSource(map, source, { queryTiles: tileDescriptor() });
    const handle = map.sources.get(mounted.sourceId) as FakeVectorSourceHandle;

    const diagnostics = await mounted.setFilter({ where: "ACRES > 10" });
    expect(handle.setTilesCalls).toHaveLength(1);
    expect(handle.setTilesCalls[0]?.[0]).toContain("ACRES");
    expect(map.sources.get(mounted.sourceId)).toBe(handle); // no source recreation
    expect(diagnostics.updates).toContainEqual(expect.objectContaining({ code: "filter-applied" }));
  });

  it("setFilter(undefined) clears a baked descriptor-level query from the tile URL", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor({ capabilities: capabilities(["tiles"]) }));
    const mounted = await mountSource(map, source, {
      queryTiles: tileDescriptor({ query: { where: "BASE_FILTER = 1" } }),
    });
    const handle = map.sources.get(mounted.sourceId) as FakeVectorSourceHandle;
    expect(handle.tiles?.[0]).toContain("BASE_FILTER");

    const diagnostics = await mounted.setFilter(undefined);
    expect(handle.setTilesCalls).toHaveLength(1);
    expect(handle.setTilesCalls[0]?.[0]).not.toContain("BASE_FILTER");
    expect(diagnostics.updates).toContainEqual(expect.objectContaining({ code: "filter-applied" }));

    // refresh() after clearing stays unfiltered.
    await mounted.refresh();
    expect(handle.setTilesCalls[1]?.[0]).not.toContain("BASE_FILTER");
  });

  it("recreates the source in place when the host lacks setTiles", async () => {
    const map = new FakeMap();
    map.supportsSetTiles = false;
    const source = fakeSource(descriptor({ capabilities: capabilities(["tiles"]) }));
    const mounted = await mountSource(map, source, { queryTiles: tileDescriptor() });

    const diagnostics = await mounted.setFilter({ where: "ACRES > 10" });
    expect(diagnostics.updates).toContainEqual(
      expect.objectContaining({ code: "filter-recreated-source", severity: "warning" }),
    );
    expect(map.sources.has(mounted.sourceId)).toBe(true);
    for (const layerId of mounted.layerIds) expect(map.layers.has(layerId)).toBe(true);

    mounted.dispose();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });

  it("refuses filter updates that fixed tile URLs cannot carry", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor({ capabilities: capabilities(["tiles"]) }));
    const fixed = tileDescriptor({
      endpoint: undefined,
      tilejson: {
        tilejson: "3.0.0",
        tiles: ["https://tiles.test/fixed/{z}/{x}/{y}.mvt"],
        vector_layers: [{ id: "parcels" }],
      },
    });
    const mounted = await mountSource(map, source, { queryTiles: fixed });
    await expect(mounted.setFilter({ where: "ACRES > 10" })).rejects.toMatchObject({ code: "filter-unsupported" });
  });

  it("fits the map to the tile descriptor bounds when requested", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor({ capabilities: capabilities(["tiles"]) }));
    await mountSource(map, source, { queryTiles: tileDescriptor(), fitBounds: true });
    expect(map.fitBoundsCalls).toEqual([{ bounds: [-158, 21, -157, 22], options: { padding: 32 } }]);
  });
});

// ── Interactions ─────────────────────────────────────────────────

describe("mountSource — interactions", () => {
  it("opens a popup on click using the custom formatter", async () => {
    const map = new FakeMap();
    const popup = popupFactory();
    const mounted = await mountSource(map, fakeSource(descriptor()), {
      popup: {
        factory: popup.factory,
        render: ({ features }) => `<b>${String(features[0]?.properties?.NAME)}</b>`,
      },
    });
    map.emit("click", `${mounted.sourceId}-point`, {
      lngLat: { lng: -158, lat: 21.4 },
      features: [{ id: 1, properties: { NAME: "f-1" } }],
    });
    expect(popup.opened).toHaveLength(1);
    expect(popup.opened[0]).toMatchObject({ html: "<b>f-1</b>", lngLat: [-158, 21.4], map });
  });

  it("tracks hover feature-state and clears it on dispose", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(descriptor()), { hover: true });
    map.emit("mousemove", `${mounted.sourceId}-point`, { features: [{ id: 1 }] });
    expect(map.getFeatureState({ source: mounted.sourceId, id: 1 })).toEqual({ hover: true });

    mounted.dispose();
    expect(map.getFeatureState({ source: mounted.sourceId, id: 1 })).toEqual({ hover: false });
    expect(map.listenerCount()).toBe(0);
  });

  it("rejects popup and hover on hosts without the interaction surfaces", async () => {
    const bare = new FakeMap() as unknown as Record<string, unknown>;
    bare.on = undefined;
    const popup = popupFactory();
    await expect(
      mountSource(bare as never, fakeSource(descriptor()), { popup: { factory: popup.factory } }),
    ).rejects.toMatchObject({ code: "interaction-unsupported" });

    const noState = new FakeMap() as unknown as Record<string, unknown>;
    noState.setFeatureState = undefined;
    await expect(mountSource(noState as never, fakeSource(descriptor()), { hover: true })).rejects.toMatchObject({
      code: "interaction-unsupported",
    });
  });
});

// ── Disposal ─────────────────────────────────────────────────────

describe("mountSource — disposal", () => {
  it("removes every owned resource and is double-dispose safe", async () => {
    const map = new FakeMap();
    const popup = popupFactory();
    const mounted = await mountSource(map, fakeSource(descriptor()), {
      popup: { factory: popup.factory, render: () => "x" },
      hover: true,
    });
    expect(map.sources.size).toBe(1);
    expect(map.layers.size).toBe(4);
    expect(map.listenerCount()).toBeGreaterThan(0);

    mounted.dispose();
    expect(mounted.state).toBe("disposed");
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.listenerCount()).toBe(0);

    // StrictMode-style second dispose is a silent no-op.
    expect(() => mounted.dispose()).not.toThrow();
    expect(map.calls.filter((call) => call.startsWith("removeSource")).length).toBe(1);
  });

  it("supports Symbol.asyncDispose and awaits in-flight updates", async () => {
    const map = new FakeMap();
    const source = fakeSource(descriptor());
    const mounted = await mountSource(map, source);
    let resolveQuery: ((result: Result<Attrs>) => void) | undefined;
    source.queryAllMock.mockImplementationOnce(
      () =>
        new Promise<Result<Attrs>>((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const pending = mounted.setFilter({ where: "1=1" });
    await vi.waitFor(() => expect(resolveQuery).toBeDefined());
    resolveQuery?.({ features: [], exceededTransferLimit: false });
    await mounted[Symbol.asyncDispose]();
    await pending;
    expect(mounted.state).toBe("disposed");
    expect(map.sources.size).toBe(0);

    // Second async dispose is also a no-op.
    await expect(mounted[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it("aborts the mount when the caller signal fires first", async () => {
    const map = new FakeMap();
    const controller = new AbortController();
    controller.abort();
    await expect(mountSource(map, fakeSource(descriptor()), { signal: controller.signal })).rejects.toThrow();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });

  it("still marks the handle disposed when the host throws during teardown", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(descriptor()));
    const originalRemoveLayer = map.removeLayer.bind(map);
    let threw = false;
    map.removeLayer = (id: string) => {
      if (!threw) {
        threw = true;
        throw new Error("host teardown failure");
      }
      originalRemoveLayer(id);
    };
    expect(() => mounted.dispose()).toThrow(HonuaDataToMapBridgeError);
    expect(mounted.state).toBe("disposed");
    expect(() => mounted.dispose()).not.toThrow();
  });
});

// ── Option validation ────────────────────────────────────────────

describe("mountSource — option validation", () => {
  it.each([
    [{ maxGeoJsonFeatures: 0 }],
    [{ maxGeoJsonFeatures: 1.5 }],
    [{ geometry: "hexagon" as never }],
    [{ layers: [] }],
    [{ layers: [{ type: "circle" }] }],
    [{ layers: [{ id: "a" }, { id: "a" }] }],
  ] as Array<[MountSourceOptions<Attrs>]>)("rejects invalid options %#", async (options) => {
    const map = new FakeMap();
    await expect(mountSource(map, fakeSource(descriptor()), options)).rejects.toMatchObject({
      code: "invalid-option",
    });
  });
});
