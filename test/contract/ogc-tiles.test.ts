/**
 * OGC API Tiles wire + Source-adapter conformance. Exercises tileset
 * discovery, single-tile fetch, the styled-tile path, and the canonical
 * `Source.adapter("ogc-tiles")` escape hatch for render-only adapters.
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  capabilities,
  createDataset,
  type SourceDescriptor,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { HonuaOgcTiles, HonuaOgcTileset } from "../../src/core/ogc-tiles.js";

import { jsonResponse, makeMockClient } from "./shared.js";

function tileMatrixSetsResponse() {
  return {
    tileMatrixSets: [
      { id: "WebMercatorQuad", uri: "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad" },
    ],
  };
}

function tilesetsResponse() {
  return {
    tilesets: [
      {
        tileMatrixSetId: "WebMercatorQuad",
        dataType: "vector",
        crs: "http://www.opengis.net/def/crs/EPSG/0/3857",
      },
    ],
  };
}

function tilesetMetadataResponse() {
  return {
    tileMatrixSetId: "WebMercatorQuad",
    dataType: "vector",
    crs: "http://www.opengis.net/def/crs/EPSG/0/3857",
  };
}

function bytesResponse(payload: number[], contentType: string): Response {
  return new Response(new Uint8Array(payload), {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

describe("ogc-tiles / wire", () => {
  it("lists tilesets and fetches a vector tile by coordinate", async () => {
    const observedTilePaths: string[] = [];
    const client = makeMockClient({
      routes: [
        // Order matters: most-specific (regex) routes precede broader prefix
        // matchers so the tile-coordinate path doesn't get swallowed by the
        // tileset-metadata prefix.
        [
          /\/ogc\/tiles\/collections\/parcels\/tiles\/WebMercatorQuad\/\d+\/\d+\/\d+/,
          (url) => {
            observedTilePaths.push(url.pathname);
            return bytesResponse([0x1f, 0x8b, 0x08], "application/vnd.mapbox-vector-tile");
          },
        ],
        ["/ogc/tiles/tileMatrixSets", () => jsonResponse(tileMatrixSetsResponse())],
        ["/ogc/tiles/collections/parcels/tiles/WebMercatorQuad", () => jsonResponse(tilesetMetadataResponse())],
        ["/ogc/tiles/collections/parcels/tiles", () => jsonResponse(tilesetsResponse())],
      ],
    });
    const tiles = client.ogcTiles();
    const sets = await tiles.tileMatrixSets();
    expect(sets.tileMatrixSets).toHaveLength(1);

    const tilesets = await tiles.tilesets({ collectionId: "parcels" });
    expect(tilesets.tilesets[0].tileMatrixSetId).toBe("WebMercatorQuad");

    const tileset = tiles.tileset("parcels", "WebMercatorQuad");
    const meta = await tileset.metadata();
    expect(meta.tileMatrixSetId).toBe("WebMercatorQuad");

    const tile = await tileset.tile({ tileMatrix: 5, tileRow: 9, tileCol: 12 });
    expect(tile.contentType).toBe("application/vnd.mapbox-vector-tile");
    expect(tile.bytes).toBeInstanceOf(Uint8Array);
    expect(tile.bytes.byteLength).toBe(3);
    expect(observedTilePaths[0]).toContain("/parcels/tiles/WebMercatorQuad/5/9/12");
  });

  it("routes raster tile requests through the canonical collection tile path", async () => {
    let observedPath = "";
    const client = makeMockClient({
      routes: [
        [
          /\/ogc\/tiles\/collections\/parcels\/tiles\/WebMercatorQuad\/4\/2\/3/,
          (url) => {
            observedPath = url.pathname;
            return bytesResponse([0x89, 0x50, 0x4e, 0x47], "image/png");
          },
        ],
      ],
    });
    const tile = await client.ogcTiles().tile({
      collectionId: "parcels",
      tileMatrixSetId: "WebMercatorQuad",
      tileMatrix: 4,
      tileRow: 2,
      tileCol: 3,
      accept: "image/png",
    });
    expect(tile.contentType).toBe("image/png");
    // The route is `/collections/{id}/tiles/{tms}/...`; the server does
    // not currently expose a styled-tile route, so the SDK keeps the path
    // canonical and does not synthesize `/styles/{styleId}/tiles/...`.
    expect(observedPath).toBe("/ogc/tiles/collections/parcels/tiles/WebMercatorQuad/4/2/3");
    expect(observedPath).not.toContain("/styles/");
  });
});

describe("ogc-tiles / Source adapter", () => {
  it("registers under the canonical Source surface and exposes the tileset adapter", () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-tiles",
          protocol: "ogc-tiles",
          locator: { url: "https://mock/", collectionId: "parcels", tileMatrixSetId: "WebMercatorQuad" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("parcels-tiles");
    expect(source).toBeDefined();
    expect(source!.capabilities.has("tiles")).toBe(true);
    expect(source!.descriptor.protocol).toBe("ogc-tiles");

    const tileset = source!.adapter("ogc-tiles");
    expect(tileset).toBeInstanceOf(HonuaOgcTileset);
    expect((tileset as HonuaOgcTileset).tileMatrixSetId).toBe("WebMercatorQuad");
  });

  it("query() throws because tiles do not expose a feature-query path", async () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-tiles",
          protocol: "ogc-tiles",
          locator: { url: "https://mock/", collectionId: "parcels", tileMatrixSetId: "WebMercatorQuad" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("parcels-tiles")!;
    await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryAll()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryExtent()).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("rejects descriptors missing collectionId", () => {
    const client = makeMockClient({ routes: [] });
    expect(() =>
      createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels-tiles",
            protocol: "ogc-tiles",
            locator: { url: "https://mock/" },
            capabilities: capabilities(["tiles"]),
          } satisfies SourceDescriptor,
        ],
      }).source("parcels-tiles"),
    ).toThrow(/locator\.collectionId/);
  });

  it("falls back to the root HonuaOgcTiles adapter when tileMatrixSetId is omitted", () => {
    // A descriptor without `tileMatrixSetId` cannot address any tile
    // route (every tile URL requires one). Instead of constructing a
    // broken `HonuaOgcTileset` whose requests would hit `/tiles//…`, the
    // Source exposes the root `HonuaOgcTiles` so callers can discover
    // the tilesets the server advertises and rebind with a concrete
    // matrix set.
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-tiles-discovery",
          protocol: "ogc-tiles",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"],
        } satisfies SourceDescriptor,
      ],
    });
    const adapter = dataset.source("parcels-tiles-discovery")!.adapter("ogc-tiles");
    expect(adapter).toBeInstanceOf(HonuaOgcTiles);
    expect(adapter).not.toBeInstanceOf(HonuaOgcTileset);
  });
});
