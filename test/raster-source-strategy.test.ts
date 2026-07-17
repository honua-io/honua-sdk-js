import { describe, expect, it } from "vitest";
import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor } from "../src/contract/index.js";
import {
  HonuaMapLibreRasterStrategyError,
  type RasterSourceToMapLibreMap,
  mountRasterSourceToMapLibre,
  projectRasterSourceToMapLibre,
} from "../src/map/index.js";

class FakeMap implements RasterSourceToMapLibreMap {
  readonly sources = new Map<string, unknown>();
  readonly layers = new Map<string, unknown>();
  readonly calls: string[] = [];
  addSourceFailure?: "before" | "after";
  addLayerFailure?: "before" | "after";
  removeLayerFailure = false;

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
  addSource(id: string, source: unknown): void {
    this.calls.push(`addSource:${id}`);
    if (this.addSourceFailure === "before") throw new Error("addSource before mutation");
    this.sources.set(id, source);
    if (this.addSourceFailure === "after") throw new Error("addSource after mutation");
  }
  removeSource(id: string): void {
    this.calls.push(`removeSource:${id}`);
    this.sources.delete(id);
  }
  getLayer(id: string): unknown {
    return this.layers.get(id);
  }
  addLayer(layer: unknown, beforeId?: string): void {
    const id = (layer as { id: string }).id;
    this.calls.push(`addLayer:${id}:${beforeId ?? ""}`);
    if (this.addLayerFailure === "before") throw new Error("addLayer before mutation");
    this.layers.set(id, layer);
    if (this.addLayerFailure === "after") throw new Error("addLayer after mutation");
  }
  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    if (this.removeLayerFailure) throw new Error("removeLayer failed");
    this.layers.delete(id);
  }
}

function descriptor(protocol: SourceDescriptor["protocol"], locator: SourceDescriptor["locator"]): SourceDescriptor {
  return {
    id: "imagery source",
    protocol,
    locator,
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES[protocol],
    attribution: "© Honua",
  };
}

describe("metadata-driven MapLibre raster strategy", () => {
  it("projects native XYZ raster tiles with stable ids, options, and exact diagnostics", () => {
    const projection = projectRasterSourceToMapLibre(
      descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.webp" }),
      {
        tileSize: 512,
        minzoom: 2,
        maxzoom: 14,
        paint: { "raster-opacity": 0.8 },
        layout: { visibility: "visible" },
      },
    );

    expect(projection.strategy).toBe("native-raster-tiles");
    expect(projection.sourceId).toBe("honua-imagery-source");
    expect(projection.source).toEqual({
      type: "raster",
      tiles: ["https://tiles.test/{z}/{x}/{y}.webp"],
      tileSize: 512,
      minzoom: 2,
      maxzoom: 14,
      attribution: "© Honua",
    });
    expect(projection.layer).toMatchObject({
      id: "honua-imagery-source-raster",
      type: "raster",
      source: "honua-imagery-source",
      paint: { "raster-opacity": 0.8 },
      layout: { visibility: "visible" },
    });
    expect(projection.diagnostics).toEqual([
      expect.objectContaining({ code: "strategy-selected", fidelity: "exact", strategy: "native-raster-tiles" }),
    ]);
  });

  it("normalizes adversarial long hyphen boundaries in linear time with a stable fallback", () => {
    const hyphens = "-".repeat(100_000);
    const bounded = descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.webp" });
    bounded.id = `${hyphens}imagery${hyphens}`;
    expect(projectRasterSourceToMapLibre(bounded).sourceId).toBe("honua-imagery");

    const empty = descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.webp" });
    empty.id = hyphens;
    const fallback = projectRasterSourceToMapLibre(empty);
    expect(fallback.sourceId).toBe("honua-source");
    expect(fallback.layerId).toBe("honua-source-raster");
  });

  it("selects WMS and preserves exact GetMap metadata", () => {
    const projection = projectRasterSourceToMapLibre(
      descriptor("wms", {
        url: "https://maps.test/wms",
        typeName: "parcels",
        styleId: "boundaries",
      }),
      { format: "image/webp", transparent: false },
    );

    expect(projection.strategy).toBe("wms-raster");
    expect(projection.source.tiles[0]).toContain("REQUEST=GetMap");
    expect(projection.source.tiles[0]).toContain("LAYERS=parcels");
    expect(projection.source.tiles[0]).toContain("STYLES=boundaries");
    expect(projection.source.tiles[0]).toContain("FORMAT=image%2Fwebp");
    expect(projection.source.tiles[0]).toContain("TRANSPARENT=FALSE");
    expect(projection.source.tiles[0]).toContain("BBOX={bbox-epsg3857}");
  });

  it("refuses a runtime format override that was not selected by WMS discovery", () => {
    const discovered = descriptor("wms", {
      url: "https://maps.test/wms",
      typeName: "parcels",
      raster: {
        kind: "wms-kvp",
        url: "https://maps.test/render",
        format: "image/png",
      },
    });

    expect(() => projectRasterSourceToMapLibre(discovered, { format: "image/webp" })).toThrow(
      'was discovered with WMS format "image/png", not "image/webp"',
    );
  });

  it("selects WMTS and preserves exact REST tile metadata", () => {
    const projection = projectRasterSourceToMapLibre(
      descriptor("wmts", {
        url: "https://maps.test/wmts",
        typeName: "imagery layer",
        styleId: "satellite",
        tileMatrixSetId: "WebMercatorQuad",
      }),
      { format: "image/webp" },
    );

    expect(projection.strategy).toBe("wmts-raster");
    expect(projection.source.tiles).toEqual([
      "https://maps.test/wmts/imagery%20layer/satellite/WebMercatorQuad/{z}/{y}/{x}.webp",
    ]);
    expect(projection.source.scheme).toBe("xyz");
  });

  it.each(["maplibre-vector", "pmtiles", "geoservices-feature-service"] as const)(
    "refuses unsupported protocol %s before renderer mutation",
    (protocol) => {
      const map = new FakeMap();
      expect(() =>
        mountRasterSourceToMapLibre(map, descriptor(protocol, { url: "https://data.test/{z}/{x}/{y}" })),
      ).toThrowError(expect.objectContaining({ code: "unsupported-strategy" }));
      expect(map.calls).toEqual([]);
    },
  );

  it("refuses capability drift before renderer mutation", () => {
    const map = new FakeMap();
    const input = descriptor("wms", { url: "https://maps.test/wms", typeName: "parcels" });
    input.capabilities = new Set(["render"]);
    expect(() => mountRasterSourceToMapLibre(map, input)).toThrowError(
      expect.objectContaining({
        code: "capability-mismatch",
        detail: expect.objectContaining({ missingCapabilities: ["tiles"] }),
      }),
    );
    expect(map.calls).toEqual([]);
  });

  it.each([
    descriptor("maplibre-raster", { url: "https://tiles.test/tilejson.json" }),
    descriptor("wms", { url: "https://maps.test/wms" }),
    descriptor("wmts", { url: "https://maps.test/wmts", typeName: "imagery" }),
  ])("refuses missing metadata for $protocol without fallback", (input) => {
    const map = new FakeMap();
    expect(() => mountRasterSourceToMapLibre(map, input)).toThrowError(
      expect.objectContaining({ code: "missing-metadata" }),
    );
    expect(map.calls).toEqual([]);
  });

  it("rejects invalid zoom and tile-size options", () => {
    const input = descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.png" });
    expect(() => projectRasterSourceToMapLibre(input, { tileSize: 0 })).toThrowError(
      expect.objectContaining({ code: "invalid-option" }),
    );
    expect(() => projectRasterSourceToMapLibre(input, { minzoom: 10, maxzoom: 2 })).toThrowError(
      expect.objectContaining({ code: "invalid-option" }),
    );
  });

  it("fails on source and layer conflicts before mutation", () => {
    const input = descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.png" });
    const sourceConflict = new FakeMap();
    sourceConflict.sources.set("honua-imagery-source", {});
    expect(() => mountRasterSourceToMapLibre(sourceConflict, input)).toThrowError(
      expect.objectContaining({ code: "source-conflict" }),
    );
    expect(sourceConflict.calls).toEqual([]);

    const layerConflict = new FakeMap();
    layerConflict.layers.set("honua-imagery-source-raster", {});
    expect(() => mountRasterSourceToMapLibre(layerConflict, input)).toThrowError(
      expect.objectContaining({ code: "layer-conflict" }),
    );
    expect(layerConflict.calls).toEqual([]);
  });

  it.each(["addSourceFailure", "addLayerFailure"] as const)("rolls back when %s mutates then throws", (failureName) => {
    const map = new FakeMap();
    map[failureName] = "after";
    const input = descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.png" });
    expect(() => mountRasterSourceToMapLibre(map, input)).toThrowError(
      expect.objectContaining({ code: "map-mutation-failed" }),
    );
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });

  it("disposes idempotently and attempts source cleanup after a layer cleanup failure", () => {
    const map = new FakeMap();
    const mounted = mountRasterSourceToMapLibre(
      map,
      descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.png" }),
      { beforeId: "labels" },
    );
    map.removeLayerFailure = true;
    mounted.dispose();
    mounted.dispose();

    expect(mounted.state).toBe("disposed");
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(1);
    expect(map.calls.filter((call) => call.startsWith("removeSource:"))).toHaveLength(1);
    expect(mounted.diagnostics).toContainEqual(expect.objectContaining({ code: "cleanup-failed" }));
  });

  it("exposes stable typed errors", () => {
    try {
      projectRasterSourceToMapLibre(descriptor("wms", { url: "https://maps.test/wms" }));
      throw new Error("expected projection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HonuaMapLibreRasterStrategyError);
      expect(error).toMatchObject({
        name: "HonuaMapLibreRasterStrategyError",
        code: "missing-metadata",
        detail: expect.objectContaining({ missing: ["locator.typeName"] }),
      });
    }
  });
});
