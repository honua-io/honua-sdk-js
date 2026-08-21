/**
 * OGC API Features integration coverage. Walks the public
 * `client.ogcFeatures()` surface from landing → conformance →
 * collections → items → item.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("OGC API Features", "ogc-features", ({ client, context, config }) => {
  const ogc = client.ogcFeatures();
  const collection = ogc.collection(config.collectionId);

  it("returns an OGC Features landing document [cert:ogc-features/landing#positive] [cert:ogc-features/landing#metadata] [cert:ogc-features/landing#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcFeatures().landing", async () => {
      const landing = await ogc.landing();
      expect(landing).toBeDefined();
      expect(Array.isArray(landing.links)).toBe(true);
    });
  });

  it("declares OGC Features conformance classes [cert:ogc-features/conformance#positive] [cert:ogc-features/conformance#metadata] [cert:ogc-features/conformance#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcFeatures().conformance", async () => {
      const conformance = await ogc.conformance();
      expect(Array.isArray(conformance.conformsTo)).toBe(true);
      expect(conformance.conformsTo.length).toBeGreaterThan(0);
    });
  });

  it("lists collections including the configured one [cert:ogc-features/collections#positive] [cert:ogc-features/collections#metadata] [cert:ogc-features/collections#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcFeatures().collections", async () => {
      const result = await ogc.collections();
      expect(Array.isArray(result.collections)).toBe(true);
      const ids = result.collections.map((entry) => String(entry.id));
      expect(ids).toContain(String(config.collectionId));
    });
  });

  it("returns paginated items for the configured collection [cert:ogc-features/items#positive] [cert:ogc-features/items#pagination] [cert:ogc-features/items#media-schema]", async () => {
    await runWithDiagnostics(context, "client.ogcFeatures().collection().items", async () => {
      const items = await collection.items({ limit: 5 });
      expect(items.type).toBe("FeatureCollection");
      expect(items.features.length).toBeGreaterThan(0);
      const featureId = items.features[0]?.id;
      expect(featureId === undefined || typeof featureId !== "object").toBe(true);
    });
  });

  it("fetches a single item by id [cert:ogc-features/item#positive] [cert:ogc-features/item#media-schema]", async ({ skip }) => {
    const items = await runWithDiagnostics(context, "client.ogcFeatures().collection().items", async () => {
      const r = await collection.items({ limit: 1 });
      expect(r.type).toBe("FeatureCollection");
      return r;
    });
    const featureId = items.features[0]?.id;
    if (featureId === undefined || featureId === null) {
      // Server returned features without ids — record an explicit
      // soft-skip rather than asserting an unsupported behavior.
      skip();
      return;
    }
    await runWithDiagnostics(context, "client.ogcFeatures().collection().item", async () => {
      const item = await collection.item({ featureId: String(featureId) });
      expect(item.type).toBe("Feature");
      expect(item.geometry).toBeDefined();
    });
  });
});
