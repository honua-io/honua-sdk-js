import { describe, expect, it } from "vitest";

import { esriToGeoJson, geoJsonToEsri } from "../../src/geometry/index.js";
import type { GeoJsonPolygon } from "../../src/geometry/index.js";

describe("@honua/geometry convert (reused core esri-geojson)", () => {
  it("round-trips a point through GeoJSON and back to Esri", () => {
    const esri = { x: -122.4, y: 37.7, spatialReference: { wkid: 4326 } };
    const geojson = esriToGeoJson(esri);
    expect(geojson).toEqual({ type: "Point", coordinates: [-122.4, 37.7] });
    const back = geoJsonToEsri(geojson, { wkid: 4326 });
    expect(back).toMatchObject({ x: -122.4, y: 37.7, spatialReference: { wkid: 4326 } });
  });

  it("rewinds polygon rings to the Esri convention (clockwise exterior)", () => {
    // GeoJSON exterior ring is counter-clockwise (positive signed area).
    const geojson: GeoJsonPolygon = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    const esri = geoJsonToEsri(geojson) as { rings: number[][][] };
    const ring = esri.rings[0];
    // Esri exterior rings are clockwise → negative signed area.
    let signedArea = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      signedArea += x0 * y1 - x1 * y0;
    }
    expect(signedArea).toBeLessThan(0);
  });

  it("flattens a MultiPolygon into a single Esri rings list", () => {
    const geojson = {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
        [
          [
            [5, 5],
            [6, 5],
            [6, 6],
            [5, 6],
            [5, 5],
          ],
        ],
      ],
    };
    const esri = geoJsonToEsri(geojson) as { rings: number[][][] };
    expect(esri.rings).toHaveLength(2);
  });

  it("returns null for a GeometryCollection (not Esri-representable)", () => {
    expect(geoJsonToEsri({ type: "GeometryCollection" } as never)).toBeNull();
  });
});
