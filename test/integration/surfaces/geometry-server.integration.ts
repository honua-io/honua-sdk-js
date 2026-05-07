/**
 * GeoServices GeometryServer integration coverage. Exercises the public
 * `client.geometryService()` entry point against the shared Utilities
 * GeometryServer route.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

const POINTS = {
  geometryType: "esriGeometryPoint",
  geometries: [{ x: -157.8583, y: 21.3069 }],
};

integrationSuite("GeometryServer", "geometry-server", ({ client, context }) => {
  const geometry = client.geometryService();

  it("projects point geometries through GeometryServer", async () => {
    await runWithDiagnostics(context, "client.geometryService().project", async () => {
      const result = await geometry.project({
        geometries: POINTS,
        inSr: 4326,
        outSr: 3857,
      });
      expect(Array.isArray(result.geometries)).toBe(true);
      expect(result.geometries?.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("buffers point geometries through GeometryServer", async () => {
    await runWithDiagnostics(context, "client.geometryService().buffer", async () => {
      const result = await geometry.buffer({
        geometries: POINTS,
        distances: [100],
        unit: 9001,
        inSr: 4326,
        outSr: 4326,
      });
      expect(Array.isArray(result.geometries)).toBe(true);
    });
  });
});
