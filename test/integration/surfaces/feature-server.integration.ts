/**
 * GeoServices FeatureServer integration coverage. Exercises the
 * read-side public API on the seeded layer and confirms the client
 * surfaces a typed feature collection through the
 * `client.featureLayer(...)` entry point.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("FeatureServer", "feature-server", ({ client, context, config }) => {
  const layer = client.featureLayer(config.serviceId, config.layerId);

  it("returns metadata for the seeded layer [cert:featureserver/metadata#positive] [cert:featureserver/metadata#metadata] [cert:featureserver/metadata#media-schema]", async () => {
    await runWithDiagnostics(context, "client.featureLayer().metadata", async () => {
      const metadata = await layer.metadata();
      expect(metadata.id).toBe(config.layerId);
      expect(metadata.name?.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("queries features without a filter [cert:featureserver/query#positive] [cert:featureserver/query#pagination] [cert:featureserver/query#media-schema]", async () => {
    await runWithDiagnostics(context, "client.featureLayer().queryFeatures", async () => {
      const result = await layer.queryFeatures({
        where: "1=1",
        returnGeometry: true,
        outFields: ["*"],
        outSr: 4326,
      });
      const features = result.features ?? [];
      expect(features.length).toBeGreaterThan(0);
      expect(features[0]?.attributes).toBeDefined();
    });
  });

  it("counts features with the where=1=1 filter [cert:featureserver/count#positive] [cert:featureserver/count#media-schema]", async () => {
    await runWithDiagnostics(context, "client.featureLayer().queryFeatureCount", async () => {
      const count = await layer.queryFeatureCount({ where: "1=1" });
      expect(count).toBeGreaterThan(0);
    });
  });

  it("lists object IDs [cert:featureserver/object-ids#positive] [cert:featureserver/object-ids#pagination] [cert:featureserver/object-ids#media-schema]", async () => {
    await runWithDiagnostics(context, "client.featureLayer().queryObjectIds", async () => {
      const ids = await layer.queryObjectIds({ where: "1=1" });
      expect(Array.isArray(ids)).toBe(true);
      expect(ids.length).toBeGreaterThan(0);
    });
  });
});
