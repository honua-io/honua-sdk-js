/**
 * STAC integration coverage. Walks the public `client.stac()` surface
 * through catalog discovery and a bounded search probe.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("STAC", "stac", ({ client, context, config }) => {
  const stac = client.stac();

  it("returns the STAC landing document [cert:stac/landing#positive] [cert:stac/landing#metadata] [cert:stac/landing#media-schema]", async () => {
    await runWithDiagnostics(context, "client.stac().landing", async () => {
      const landing = await stac.landing();
      expect(landing).toBeDefined();
      expect(Array.isArray(landing.links)).toBe(true);
    });
  });

  it("lists STAC collections [cert:stac/collections#positive] [cert:stac/collections#metadata] [cert:stac/collections#media-schema]", async () => {
    await runWithDiagnostics(context, "client.stac().collections", async () => {
      const result = await stac.collections();
      expect(Array.isArray(result.collections)).toBe(true);
    });
  });

  it("fetches the configured STAC collection when it is advertised [cert:stac/collection#positive] [cert:stac/collection#media-schema]", async ({ skip }) => {
    const collections = await runWithDiagnostics(context, "client.stac().collections", async () => stac.collections());
    const ids = collections.collections.map((entry) => String(entry.id));
    if (!ids.includes(String(config.stacCollectionId))) {
      skip();
      return;
    }
    await runWithDiagnostics(context, "client.stac().collection", async () => {
      const collection = await stac.collection({ collectionId: config.stacCollectionId });
      expect(String(collection.id)).toBe(String(config.stacCollectionId));
    });
  });

  it("searches STAC items with a small page size [cert:stac/search#positive] [cert:stac/search#media-schema]", async () => {
    await runWithDiagnostics(context, "client.stac().search", async () => {
      const result = await stac.search({ limit: 1 });
      expect(result.type).toBe("FeatureCollection");
      expect(Array.isArray(result.features)).toBe(true);
    });
  });
});
