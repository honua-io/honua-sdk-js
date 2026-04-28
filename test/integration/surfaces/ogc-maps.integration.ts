/**
 * OGC API Maps integration coverage. Walks landing → conformance → a
 * single map render against the configured collection.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

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

  it("renders a map image for the configured collection", async () => {
    const collection = maps.collection(config.collectionId);
    await runWithDiagnostics(context, "client.ogcMaps().collection().map", async () => {
      const map = await collection.map({
        width: 256,
        height: 256,
        bbox: [-180, -85, 180, 85],
        crs: "EPSG:4326",
        format: "png",
      });
      expect(map.contentType.length).toBeGreaterThan(0);
      expect(map.bytes).toBeInstanceOf(Uint8Array);
    });
  });
});
