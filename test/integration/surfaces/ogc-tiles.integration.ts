/**
 * OGC API Tiles integration coverage. Walks landing → conformance →
 * tile-matrix-sets → collection tilesets → single tile fetch. The tile
 * fetch deliberately targets `(0, 0, 0)` so a sparse seed still returns
 * an empty (but successful) tile rather than 404.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("OGC API Tiles", "ogc-tiles", ({ client, context, config }) => {
  const tiles = client.ogcTiles();

  it("returns the OGC Tiles landing document [cert:ogc-tiles/landing#positive] [cert:ogc-tiles/landing#metadata] [cert:ogc-tiles/landing#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcTiles().landing", async () => {
      const landing = await tiles.landing();
      expect(landing).toBeDefined();
      expect(Array.isArray(landing.links)).toBe(true);
    });
  });

  it("declares OGC Tiles conformance classes [cert:ogc-tiles/conformance#positive] [cert:ogc-tiles/conformance#metadata] [cert:ogc-tiles/conformance#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcTiles().conformance", async () => {
      const conformance = await tiles.conformance();
      expect(Array.isArray(conformance.conformsTo)).toBe(true);
    });
  });

  it("lists tile-matrix-sets with at least one entry [cert:ogc-tiles/tile-matrix-sets#positive] [cert:ogc-tiles/tile-matrix-sets#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcTiles().tileMatrixSets", async () => {
      const tms = await tiles.tileMatrixSets();
      expect(Array.isArray(tms.tileMatrixSets)).toBe(true);
      expect(tms.tileMatrixSets.length).toBeGreaterThan(0);
    });
  });

  it("returns metadata for the configured tile-matrix-set", async () => {
    await runWithDiagnostics(context, "client.ogcTiles().tileMatrixSet", async () => {
      const tms = await tiles.tileMatrixSet(config.tileMatrixSetId);
      expect(String(tms.id ?? config.tileMatrixSetId)).toBe(config.tileMatrixSetId);
    });
  });

  it("lists tilesets for the configured collection [cert:ogc-tiles/tilesets#positive] [cert:ogc-tiles/tilesets#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcTiles().tilesets", async () => {
      const tilesets = await tiles.tilesets({ collectionId: config.collectionId });
      expect(Array.isArray(tilesets.tilesets)).toBe(true);
    });
  });

  it("fetches a single tile at zoom 0,0,0 [cert:ogc-tiles/tile#positive] [cert:ogc-tiles/tile#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcTiles().tile", async () => {
      const tile = await tiles.tile({
        collectionId: config.collectionId,
        tileMatrixSetId: config.tileMatrixSetId,
        tileMatrix: 0,
        tileRow: 0,
        tileCol: 0,
      });
      expect(tile.contentType.length).toBeGreaterThan(0);
      expect(tile.bytes).toBeInstanceOf(Uint8Array);
    });
  });
});
