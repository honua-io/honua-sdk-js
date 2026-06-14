/**
 * Unit coverage for the MapLibre vector-source helpers on the OGC API Tiles
 * surface. Asserts the produced source object shape, that the `{z}/{y}/{x}`
 * placeholders survive intact, correct OGC tile-route templating, and
 * source-layer resolution (including folder-prefixed identifiers).
 */

import { describe, expect, it } from "vitest";

import { HonuaClient } from "../../src/core/client.js";
import { DEFAULT_OGC_TILE_MATRIX_SET, HonuaOgcTiles } from "../../src/core/ogc-tiles.js";

function makeTiles(baseUrl = "https://mock.honua.test"): HonuaOgcTiles {
  const client = new HonuaClient({ baseUrl, fetchFn: async () => new Response(null, { status: 404 }) });
  return new HonuaOgcTiles({ client });
}

describe("ogc-tiles / maplibre vector source helpers", () => {
  it("builds a maplibre vector source with the canonical OGC tile template", () => {
    const source = makeTiles().getMapLibreVectorSource("parcels");
    expect(source.type).toBe("vector");
    expect(source.scheme).toBe("xyz");
    expect(source.tiles).toEqual([
      "https://mock.honua.test/ogc/tiles/collections/parcels/tiles/WebMercatorQuad/{z}/{y}/{x}",
    ]);
  });

  it("keeps the {z}/{y}/{x} placeholders literal (braces not encoded)", () => {
    const [template] = makeTiles().getMapLibreVectorSource("parcels").tiles;
    expect(template).toContain("/{z}/{y}/{x}");
    expect(template).not.toContain("%7B");
    expect(template).not.toContain("%7D");
  });

  it("uses WebMercatorQuad as the default tile-matrix-set", () => {
    expect(DEFAULT_OGC_TILE_MATRIX_SET).toBe("WebMercatorQuad");
    const [template] = makeTiles().getMapLibreVectorSource("parcels").tiles;
    expect(template).toContain("/tiles/WebMercatorQuad/");
  });

  it("honors an explicit tile-matrix-set and zoom overrides", () => {
    const source = makeTiles().getMapLibreVectorSource("parcels", {
      tileMatrixSetId: "WorldCRS84Quad",
      minzoom: 2,
      maxzoom: 14,
    });
    expect(source.tiles[0]).toContain("/tiles/WorldCRS84Quad/{z}/{y}/{x}");
    expect(source.minzoom).toBe(2);
    expect(source.maxzoom).toBe(14);
  });

  it("omits zoom bounds when not supplied", () => {
    const source = makeTiles().getMapLibreVectorSource("parcels");
    expect(source.minzoom).toBeUndefined();
    expect(source.maxzoom).toBeUndefined();
  });

  it("respects the client base URL including a path prefix", () => {
    const [template] = makeTiles("https://host.example/honua/").getMapLibreVectorSource("parcels").tiles;
    expect(template).toBe("https://host.example/honua/ogc/tiles/collections/parcels/tiles/WebMercatorQuad/{z}/{y}/{x}");
  });

  it("encodes folder-prefixed identifiers per segment, keeping separators", () => {
    const [template] = makeTiles().getMapLibreVectorSource("my Folder/parcels v2").tiles;
    expect(template).toBe(
      "https://mock.honua.test/ogc/tiles/collections/my%20Folder/parcels%20v2/tiles/WebMercatorQuad/{z}/{y}/{x}",
    );
  });

  it("resolves the source-layer name from the identifier", () => {
    const tiles = makeTiles();
    expect(tiles.getDefaultSourceLayer("parcels")).toBe("parcels");
    expect(tiles.getDefaultSourceLayer("myFolder/parcels")).toBe("parcels");
  });

  it("returns a combined source + source-layer config", () => {
    const config = makeTiles().getMapLibreConfig("myFolder/parcels", { maxzoom: 16 });
    expect(config.sourceLayer).toBe("parcels");
    expect(config.source.type).toBe("vector");
    expect(config.source.maxzoom).toBe(16);
    expect(config.source.tiles[0]).toBe(
      "https://mock.honua.test/ogc/tiles/collections/myFolder/parcels/tiles/WebMercatorQuad/{z}/{y}/{x}",
    );
  });
});
