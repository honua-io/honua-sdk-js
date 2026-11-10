import { expect, it } from "vitest";
import { createDeckGlAdapter, loadDeckGlPeers, projectDeckGlHexbins } from "../../../src/deckgl/index.js";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("deck.gl hexbin", "deckgl-hexbin", ({ client, context, config }) => {
  it("conserves live point identities and counts through real peer construction", async () => {
    await runWithDiagnostics(context, "hexbin live FeatureServer input", async () => {
      const result = await client.featureLayer(config.serviceId, config.layerId).queryFeatures({
        where: "1=1",
        outFields: ["*"],
        returnGeometry: true,
        outSr: 4326,
        resultRecordCount: 100,
      });
      expect(result.geometryType).toBe("esriGeometryPoint");
      const field = result.objectIdFieldName;
      expect(field).toBeTruthy();
      if (!field) throw new Error("Live point query must declare its object ID field.");
      const features = (result.features ?? []).filter(({ geometry }) => geometry != null);
      expect(features.length).toBeLessThan(result.features?.length ?? 0);
      const rows = features.map(({ attributes, geometry }) => {
        const id = attributes[field];
        const x = geometry && "x" in geometry ? geometry.x : undefined;
        const y = geometry && "y" in geometry ? geometry.y : undefined;
        if ((typeof id !== "number" && typeof id !== "string") || typeof x !== "number" || typeof y !== "number") {
          throw new Error("Live point fixture must expose scalar IDs and WGS84 coordinates.");
        }
        return { id, x, y };
      });
      expect(rows.length).toBeGreaterThan(1);
      const adapter = createDeckGlAdapter({ peers: await loadDeckGlPeers() });
      try {
        for (const selected of [rows, rows.filter((_, index) => index % 2 === 0), []]) {
          const aggregated = projectDeckGlHexbins(adapter, {
            layerId: "live-counts",
            radiusMeters: 1_000,
            positions: new Float64Array(selected.flatMap(({ x, y }) => [x, y])),
            identity: {
              sourceId: config.serviceId,
              planId: "bounded-live-page",
              featureIds: selected.map(({ id }) => id),
            },
          });
          expect(aggregated.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(selected.length);
          const picked = aggregated.bins.flatMap((_, index) => aggregated.selectionsForBin(index));
          expect(picked.map(({ featureId }) => featureId).sort()).toEqual(selected.map(({ id }) => id).sort());
          expect(aggregated.projection.gpuContract.peer).toBe("SolidPolygonLayer");
        }
      } finally {
        adapter.dispose();
      }
    });
  });
});
