/**
 * GeoServices FeatureServer integration coverage. Exercises the
 * read-side public API on a seeded layer (`places` by default) and
 * confirms the client surfaces a typed feature collection through the
 * `client.featureLayer(...)` entry point.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("FeatureServer", "feature-server", ({ client, context, config }) => {
  const layer = client.featureLayer(config.serviceId, config.layerId);

  it("returns metadata for the seeded layer", async () => {
    const metadata = await runWithDiagnostics(context, "client.featureLayer().metadata", () => layer.metadata());
    expect(metadata.id).toBe(config.layerId);
    expect(metadata.name?.length ?? 0).toBeGreaterThan(0);
  });

  it("queries features without a filter", async () => {
    const result = await runWithDiagnostics(context, "client.featureLayer().queryFeatures", () =>
      layer.queryFeatures({ where: "1=1", returnGeometry: true, outFields: ["*"], outSr: 4326 }),
    );
    const features = result.features ?? [];
    expect(features.length).toBeGreaterThan(0);
    expect(features[0]?.attributes).toBeDefined();
  });

  it("counts features with the where=1=1 filter", async () => {
    const count = await runWithDiagnostics(context, "client.featureLayer().queryFeatureCount", () =>
      layer.queryFeatureCount({ where: "1=1" }),
    );
    expect(count).toBeGreaterThan(0);
  });

  it("lists object IDs", async () => {
    const ids = await runWithDiagnostics(context, "client.featureLayer().queryObjectIds", () =>
      layer.queryObjectIds({ where: "1=1" }),
    );
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });
});
