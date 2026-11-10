import { describe, expect, it } from "vitest";

import { geoJsonToGeoServices, geoServicesToGeoJson } from "../../src/geometry/index.js";
import type { GeoJsonPolygon } from "../../src/geometry/index.js";

describe("@honua/geometry convert (reused core GeoServices conversion)", () => {
  it("round-trips a point through GeoJSON and back to Esri", () => {
    const esri = { x: -122.4, y: 37.7, spatialReference: { wkid: 4326 } };
    const geojson = geoServicesToGeoJson(esri);
    expect(geojson).toEqual({ type: "Point", coordinates: [-122.4, 37.7] });
    const back = geoJsonToGeoServices(geojson, { wkid: 4326 });
    expect(back).toMatchObject({ x: -122.4, y: 37.7, spatialReference: { wkid: 4326 } });
  });

  it("keeps the altitude of a 3D GeoJSON point as Esri z", () => {
    expect(geoJsonToGeoServices({ type: "Point", coordinates: [-122.4, 37.7, 12.5] })).toEqual({
      x: -122.4,
      y: 37.7,
      z: 12.5,
    });
    expect(geoJsonToGeoServices({ type: "Point", coordinates: [-122.4, 37.7] })).toEqual({ x: -122.4, y: 37.7 });
  });

  it.each([12.5, 0, -45.25])("preserves independently specified point Z=%s through both aliases", (z) => {
    const esri = { x: -80.839, y: 35.226, z };
    const geojson = { type: "Point" as const, coordinates: [-80.839, 35.226, z] };
    const before = structuredClone({ esri, geojson });
    expect(geoServicesToGeoJson(esri)).toEqual(geojson);
    expect(geoJsonToGeoServices(geojson, { wkid: 4326 })).toEqual({ ...esri, spatialReference: { wkid: 4326 } });
    expect({ esri, geojson }).toEqual(before);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite GeoJSON elevation %s",
    (z) => {
      expect(geoJsonToGeoServices({ type: "Point", coordinates: [1, 2, z] })).toBeNull();
    },
  );

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
    const esri = geoJsonToGeoServices(geojson) as { rings: number[][][] };
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
    const esri = geoJsonToGeoServices(geojson) as { rings: number[][][] };
    expect(esri.rings).toHaveLength(2);
  });

  it("returns null for a GeometryCollection (not Esri-representable)", () => {
    expect(geoJsonToGeoServices({ type: "GeometryCollection" } as never)).toBeNull();
  });
});
