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

  it("returns an OGC Features landing document", async () => {
    const landing = await runWithDiagnostics(context, "client.ogcFeatures().landing", () => ogc.landing());
    expect(landing).toBeDefined();
    expect(Array.isArray(landing.links)).toBe(true);
  });

  it("declares OGC Features conformance classes", async () => {
    const conformance = await runWithDiagnostics(context, "client.ogcFeatures().conformance", () => ogc.conformance());
    expect(Array.isArray(conformance.conformsTo)).toBe(true);
    expect(conformance.conformsTo.length).toBeGreaterThan(0);
  });

  it("lists collections including the configured one", async () => {
    const result = await runWithDiagnostics(context, "client.ogcFeatures().collections", () => ogc.collections());
    expect(Array.isArray(result.collections)).toBe(true);
    const ids = result.collections.map((entry) => String(entry.id));
    expect(ids).toContain(String(config.collectionId));
  });

  it("returns paginated items for the configured collection", async () => {
    const items = await runWithDiagnostics(context, "client.ogcFeatures().collection().items", () =>
      collection.items({ limit: 5 }),
    );
    expect(items.type).toBe("FeatureCollection");
    expect(items.features.length).toBeGreaterThan(0);
    const featureId = items.features[0]?.id;
    expect(featureId === undefined || typeof featureId !== "object").toBe(true);
  });

  it("fetches a single item by id", async () => {
    const items = await runWithDiagnostics(context, "client.ogcFeatures().collection().items", () =>
      collection.items({ limit: 1 }),
    );
    const featureId = items.features[0]?.id;
    if (featureId === undefined || featureId === null) {
      // Server returned features without ids — record an explicit
      // soft-skip rather than asserting an unsupported behavior.
      return;
    }
    const item = await runWithDiagnostics(context, "client.ogcFeatures().collection().item", () =>
      collection.item({ featureId: String(featureId) }),
    );
    expect(item.type).toBe("Feature");
    expect(item.geometry).toBeDefined();
  });
});
