/**
 * OGC API Maps integration coverage. Walks landing → conformance → a
 * single map render against the configured collection.
 *
 * @module
 */

import { HonuaHttpError } from "@honua/sdk-js";
import { expect, it } from "vitest";
import { classifyCapabilityGap, integrationSuite, recordSurface, runWithDiagnostics } from "../harness.js";

integrationSuite("OGC API Maps", "ogc-maps", ({ client, context, config }) => {
  const maps = client.ogcMaps();

  it("returns the OGC Maps landing document", async () => {
    await runWithDiagnostics(context, "client.ogcMaps().landing", async () => {
      const landing = await maps.landing();
      expect(landing).toBeDefined();
      expect(Array.isArray(landing.links)).toBe(true);
    });
  });

  it("declares OGC Maps conformance classes", async () => {
    await runWithDiagnostics(context, "client.ogcMaps().conformance", async () => {
      const conformance = await maps.conformance();
      expect(Array.isArray(conformance.conformsTo)).toBe(true);
    });
  });

  it("renders a map image for the configured collection", async (ctx) => {
    const collection = maps.collection(config.collectionId);
    // The server's OGC Maps rendering is raster-backed (IRasterMapRenderer);
    // a vector-only seeded collection yields "No map data found" (404). That
    // is a data-capability gap of the seed, not a wire regression — detect it
    // here and skip OUTSIDE runWithDiagnostics so the vitest skip signal is
    // not rewrapped by the diagnostics error decorator.
    let gapReason: string | undefined;
    await runWithDiagnostics(context, "client.ogcMaps().collection().map", async () => {
      try {
        const map = await collection.map({
          width: 256,
          height: 256,
          bbox: [-180, -85, 180, 85],
          crs: "EPSG:4326",
          format: "png",
        });
        expect(map.contentType.length).toBeGreaterThan(0);
        expect(map.bytes).toBeInstanceOf(Uint8Array);
      } catch (error) {
        if (error instanceof HonuaHttpError && error.statusCode === 404 && /no map data found/i.test(error.message)) {
          gapReason = `ogc-maps render: collection ${config.collectionId} has no raster-renderable data on this seed (OGC Maps rendering is raster-backed)`;
          return;
        }
        const gap = classifyCapabilityGap("ogc-maps render", error);
        if (gap) {
          gapReason = gap.reason;
          return;
        }
        throw error;
      }
    });
    if (gapReason !== undefined) {
      recordSurface("ogc-maps", gapReason);
      ctx.skip(gapReason);
    }
  });
});
