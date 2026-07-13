import { describe, expect, it, vi } from "vitest";

import type { Capabilities, Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { type DataToMapLibreMap, HonuaDataToMapBridgeError, mountSource } from "../src/map/index.js";
import { classBreaksRenderer, clusterRenderer, heatmapRenderer, uniqueValueRenderer } from "../src/style/index.js";

// ── Test doubles ─────────────────────────────────────────────────

class FakeGeoJsonSourceHandle {
  readonly setDataCalls: unknown[] = [];
  constructor(spec: Record<string, unknown>) {
    Object.assign(this, spec);
  }
  setData(data: unknown): void {
    this.setDataCalls.push(data);
  }
}

class FakeMap implements DataToMapLibreMap {
  readonly sources = new Map<string, FakeGeoJsonSourceHandle>();
  readonly layers = new Map<string, Record<string, unknown>>();
  readonly layerOrder: string[] = [];
  readonly calls: string[] = [];
  readonly paintCalls: Array<[string, string, unknown]> = [];
  readonly layoutCalls: Array<[string, string, unknown]> = [];
  readonly filterCalls: Array<[string, unknown]> = [];
  supportsPropertySetters = true;

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
  addSource(id: string, spec: unknown): void {
    this.calls.push(`addSource:${id}`);
    this.sources.set(id, new FakeGeoJsonSourceHandle(spec as Record<string, unknown>));
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
    // Copy like real MapLibre does — the bridge hands over frozen specs.
    this.layers.set(id, { ...record, paint: { ...((record.paint as Record<string, unknown>) ?? {}) } });
    this.layerOrder.push(id);
  }
  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    this.layers.delete(id);
    const index = this.layerOrder.indexOf(id);
    if (index >= 0) this.layerOrder.splice(index, 1);
  }
  setPaintProperty(layerId: string, name: string, value: unknown): void {
    if (!this.supportsPropertySetters) throw new Error("unsupported");
    this.paintCalls.push([layerId, name, value]);
    const layer = this.layers.get(layerId);
    if (layer) layer.paint = { ...(layer.paint as Record<string, unknown>), [name]: value };
  }
  setLayoutProperty(layerId: string, name: string, value: unknown): void {
    this.layoutCalls.push([layerId, name, value]);
  }
  setFilter(layerId: string, filter: unknown): void {
    this.filterCalls.push([layerId, filter]);
  }
}

interface Attrs {
  OBJECTID: number;
  priority: string;
  magnitude: number;
}

function pointFeature(id: number, priority: string, magnitude: number): { attributes: Attrs; geometry: unknown } {
  return {
    attributes: { OBJECTID: id, priority, magnitude },
    geometry: { type: "Point", coordinates: [-157.8 - id * 0.01, 21.3] },
  };
}

function descriptor(): SourceDescriptor {
  return {
    id: "incidents",
    protocol: "geoservices-feature-service",
    locator: { url: "https://demo.test/rest/services/Incidents/FeatureServer/0" },
    capabilities: capabilities(["query", "queryExtent"]),
    schema: { primaryKey: "OBJECTID" },
  };
}

function fakeSource(): Source<Attrs> & { queryAllMock: ReturnType<typeof vi.fn> } {
  const result: Result<Attrs> = {
    features: [pointFeature(1, "high", 6.1), pointFeature(2, "low", 2.4)] as never,
    exceededTransferLimit: false,
  };
  const queryAllMock = vi.fn(async (_request?: Query<Attrs>) => result);
  const notSupported = () => {
    throw new HonuaCapabilityNotSupportedError("query", "geoservices-feature-service", "incidents");
  };
  const desc = descriptor();
  return {
    descriptor: desc,
    capabilities: desc.capabilities as Capabilities,
    query: queryAllMock as never,
    queryAll: queryAllMock as never,
    queryAllMock,
    queryExtent: vi.fn(async () => ({ extent: null, count: 2 })) as never,
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

const PRIORITY_RENDERER = uniqueValueRenderer({
  field: "priority",
  values: [
    { value: "high", color: "#b91c1c" },
    { value: "low", color: "#0f766e" },
  ],
  defaultColor: "#334155",
});

const MAGNITUDE_RENDERER = classBreaksRenderer({
  field: "magnitude",
  breaks: [
    { min: 0, max: 3, color: "#fed976" },
    { min: 3, color: "#b10026" },
  ],
  defaultColor: "#cccccc",
});

// ── Mount with a renderer ────────────────────────────────────────

describe("mountSource with renderer objects", () => {
  it("derives layer paint from a unique-value renderer across the geometry matrix", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(), { renderer: PRIORITY_RENDERER });
    expect(mounted.layerIds).toEqual([
      "honua-incidents-point",
      "honua-incidents-line",
      "honua-incidents-polygon",
      "honua-incidents-polygon-outline",
    ]);
    const point = map.layers.get("honua-incidents-point") as { paint: Record<string, unknown> };
    expect(point.paint["circle-color"]).toEqual([
      "match",
      ["get", "priority"],
      "high",
      "#b91c1c",
      "low",
      "#0f766e",
      "#334155",
    ]);
    // Geometry defaults the renderer does not cover survive.
    expect(point.paint["circle-radius"]).toBe(6);
    const polygon = map.layers.get("honua-incidents-polygon") as { paint: Record<string, unknown> };
    expect((polygon.paint["fill-color"] as unknown[])[0]).toBe("match");
    mounted.dispose();
  });

  it("explicit paint overrides win over renderer paint", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(), {
      renderer: PRIORITY_RENDERER,
      paint: { point: { "circle-color": "#000000" } },
    });
    const point = map.layers.get("honua-incidents-point") as { paint: Record<string, unknown> };
    expect(point.paint["circle-color"]).toBe("#000000");
    mounted.dispose();
  });

  it("mounts a heatmap renderer as a single heatmap layer", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(), {
      renderer: heatmapRenderer({ weightField: "magnitude", radius: 40 }),
    });
    expect(mounted.layerIds).toEqual(["honua-incidents-heatmap"]);
    const layer = map.layers.get("honua-incidents-heatmap") as { type: string; paint: Record<string, unknown> };
    expect(layer.type).toBe("heatmap");
    expect(layer.paint["heatmap-radius"]).toBe(40);
    mounted.dispose();
  });

  it("mounts a cluster renderer with GeoJSON cluster source options and three layers", async () => {
    const map = new FakeMap();
    const renderer = clusterRenderer({
      radius: 60,
      maxZoom: 12,
      steps: [
        { threshold: 0, color: "#51bbd6" },
        { threshold: 10, color: "#f28cb1" },
      ],
    });
    const mounted = await mountSource(map, fakeSource(), { renderer });
    expect(mounted.layerIds).toEqual([
      "honua-incidents-clusters",
      "honua-incidents-cluster-count",
      "honua-incidents-unclustered",
    ]);
    const sourceSpec = map.sources.get("honua-incidents") as unknown as Record<string, unknown>;
    expect(sourceSpec.cluster).toBe(true);
    expect(sourceSpec.clusterRadius).toBe(60);
    expect(sourceSpec.clusterMaxZoom).toBe(12);
    const clusters = map.layers.get("honua-incidents-clusters") as { filter: unknown };
    expect(clusters.filter).toEqual(["has", "point_count"]);
    mounted.dispose();
    expect(map.layers.size).toBe(0);
    expect(map.sources.size).toBe(0);
  });

  it("rejects renderer together with layers, and non-renderer values", async () => {
    const map = new FakeMap();
    await expect(
      mountSource(map, fakeSource(), {
        renderer: PRIORITY_RENDERER,
        layers: [{ id: "custom", type: "circle" }],
      }),
    ).rejects.toThrow(HonuaDataToMapBridgeError);
    await expect(mountSource(map, fakeSource(), { renderer: {} as never })).rejects.toThrow(/renderer object/);
  });

  it("rejects a cluster renderer on the query-tiles strategy", async () => {
    const map = new FakeMap();
    const renderer = clusterRenderer({ steps: [{ threshold: 0, color: "#000" }] });
    await expect(
      mountSource(map, fakeSource(), {
        renderer,
        strategy: "query-tiles",
        queryTiles: {
          kind: "query-vector-tile",
          id: "t",
          sourceId: "t",
          protocol: "geoservices-feature-service",
          endpoint: { baseUrl: "https://demo.test/tiles" },
          minzoom: 0,
          maxzoom: 14,
          cache: { maxEntries: 8, key: { sourceVersion: "v1", authorizationScope: "public" } },
        } as never,
      }),
    ).rejects.toThrow(/cluster renderer/i);
  });
});

// ── Renderer swap (diff-update path) ─────────────────────────────

describe("MountedSource.setRenderer", () => {
  it("diff-updates paint in place when the layer structure is unchanged", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(), { renderer: PRIORITY_RENDERER });
    const addCallsBefore = map.calls.filter((call) => call.startsWith("addLayer")).length;

    const diagnostics = await mounted.setRenderer(MAGNITUDE_RENDERER);

    // No teardown: no layers were removed or re-added.
    expect(map.calls.filter((call) => call.startsWith("removeLayer"))).toHaveLength(0);
    expect(map.calls.filter((call) => call.startsWith("addLayer"))).toHaveLength(addCallsBefore);
    expect(diagnostics.updates.at(-1)?.code).toBe("renderer-applied");

    const point = map.layers.get("honua-incidents-point") as { paint: Record<string, unknown> };
    expect(point.paint["circle-color"]).toEqual(["step", ["get", "magnitude"], "#cccccc", 0, "#fed976", 3, "#b10026"]);
    // Only the changed property was set per layer (color on point/line/polygon).
    expect(map.paintCalls.map(([layerId, name]) => `${layerId}:${name}`)).toEqual([
      "honua-incidents-point:circle-color",
      "honua-incidents-line:line-color",
      "honua-incidents-polygon:fill-color",
    ]);
    mounted.dispose();
  });

  it("clears the renderer back to geometry defaults in place", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(), { renderer: PRIORITY_RENDERER });
    await mounted.setRenderer(undefined);
    const point = map.layers.get("honua-incidents-point") as { paint: Record<string, unknown> };
    expect(point.paint["circle-color"]).toBe("#16735b");
    expect(map.calls.filter((call) => call.startsWith("removeLayer"))).toHaveLength(0);
    mounted.dispose();
  });

  it("recreates only the layers when the structure changes (matrix -> heatmap)", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(), { renderer: PRIORITY_RENDERER });
    const diagnostics = await mounted.setRenderer(heatmapRenderer());
    expect(diagnostics.updates.at(-1)?.code).toBe("renderer-recreated-layers");
    expect(mounted.layerIds).toEqual(["honua-incidents-heatmap"]);
    expect(map.layers.size).toBe(1);
    // The source was untouched.
    expect(map.calls.filter((call) => call.startsWith("removeSource"))).toHaveLength(0);
    mounted.dispose();
    expect(map.layers.size).toBe(0);
  });

  it("recreates the source when swapping to a cluster renderer, and back", async () => {
    const map = new FakeMap();
    const source = fakeSource();
    const mounted = await mountSource(map, source, { renderer: PRIORITY_RENDERER });
    const materializeCalls = source.queryAllMock.mock.calls.length;

    const renderer = clusterRenderer({ steps: [{ threshold: 0, color: "#51bbd6" }] });
    const diagnostics = await mounted.setRenderer(renderer);
    expect(diagnostics.updates.at(-1)?.code).toBe("renderer-recreated-source");
    expect(source.queryAllMock.mock.calls.length).toBe(materializeCalls + 1);
    const spec = map.sources.get("honua-incidents") as unknown as Record<string, unknown>;
    expect(spec.cluster).toBe(true);
    expect(mounted.layerIds).toEqual([
      "honua-incidents-clusters",
      "honua-incidents-cluster-count",
      "honua-incidents-unclustered",
    ]);

    const back = await mounted.setRenderer(PRIORITY_RENDERER);
    expect(back.updates.at(-1)?.code).toBe("renderer-recreated-source");
    const restored = map.sources.get("honua-incidents") as unknown as Record<string, unknown>;
    expect(restored.cluster).toBeUndefined();
    expect(mounted.layerIds).toEqual([
      "honua-incidents-point",
      "honua-incidents-line",
      "honua-incidents-polygon",
      "honua-incidents-polygon-outline",
    ]);
    mounted.dispose();
    expect(map.layers.size).toBe(0);
    expect(map.sources.size).toBe(0);
  });

  it("keeps the working layers when a cluster swap fails to materialize", async () => {
    const map = new FakeMap();
    const source = fakeSource();
    const mounted = await mountSource(map, source, { renderer: PRIORITY_RENDERER });
    const before = [...mounted.layerIds];

    source.queryAllMock.mockRejectedValueOnce(new Error("network down"));
    const renderer = clusterRenderer({ steps: [{ threshold: 0, color: "#51bbd6" }] });
    await expect(mounted.setRenderer(renderer)).rejects.toThrow(/network down/);

    // The previously working map is untouched: layers, source, and tracked ids.
    expect(mounted.layerIds).toEqual(before);
    for (const id of before) expect(map.layers.has(id)).toBe(true);
    expect(map.sources.has("honua-incidents")).toBe(true);

    // A later swap still works.
    const diagnostics = await mounted.setRenderer(renderer);
    expect(diagnostics.updates.at(-1)?.code).toBe("renderer-recreated-source");
    mounted.dispose();
  });

  it("rejects setRenderer after dispose", async () => {
    const map = new FakeMap();
    const mounted = await mountSource(map, fakeSource(), {});
    mounted.dispose();
    await expect(mounted.setRenderer(PRIORITY_RENDERER)).rejects.toThrow(/disposed/);
  });
});
