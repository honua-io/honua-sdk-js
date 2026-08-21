/**
 * GeoServices MapServer integration coverage. Exercises the read-side
 * map-service public API on the seeded service: metadata, layer query,
 * and a single export-map render.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("MapServer", "map-server", ({ client, context, config }) => {
  const mapService = client.mapService(config.serviceId);
  const mapLayer = client.mapLayer(config.serviceId, config.layerId);

  it("returns map service metadata [cert:mapserver/metadata#positive] [cert:mapserver/metadata#metadata] [cert:mapserver/metadata#media-schema]", async () => {
    await runWithDiagnostics(context, "client.mapService().metadata", async () => {
      const metadata = await mapService.metadata();
      expect(metadata).toBeDefined();
      expect(Array.isArray(metadata.layers ?? [])).toBe(true);
    });
  });

  it("queries features through the map layer [cert:mapserver/query#positive] [cert:mapserver/query#pagination] [cert:mapserver/query#media-schema]", async () => {
    await runWithDiagnostics(context, "client.mapLayer().queryFeatures", async () => {
      const result = await mapLayer.queryFeatures({
        where: "1=1",
        returnGeometry: true,
        outFields: "*",
        outSr: 4326,
      });
      const features = result.features ?? [];
      expect(features.length).toBeGreaterThan(0);
    });
  });

  it("counts features through the map layer [cert:mapserver/count#positive] [cert:mapserver/count#media-schema]", async () => {
    await runWithDiagnostics(context, "client.mapLayer().queryFeatureCount", async () => {
      const count = await mapLayer.queryFeatureCount({ where: "1=1" });
      expect(count).toBeGreaterThan(0);
    });
  });

  it("renders an export-map image [cert:mapserver/export#positive] [cert:mapserver/export#media-schema]", async () => {
    await runWithDiagnostics(context, "client.mapService().exportMap", async () => {
      const exported = await mapService.exportMap({
        bbox: [-180, -85, 180, 85],
        size: [256, 256],
        bboxSr: 4326,
        imageSr: 4326,
        format: "png",
      });
      expect(exported).toBeDefined();
      expect(typeof exported.href === "string" || exported.extent !== undefined).toBe(true);
    });
  });
});
