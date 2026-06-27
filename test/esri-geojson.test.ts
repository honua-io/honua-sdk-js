import { describe, expect, it } from "vitest";

import { esriFeatureToGeoJSON, esriGeometryToGeoJSON } from "../src/index.js";
import type { HonuaFeature } from "../src/index.js";

describe("esriGeometryToGeoJSON", () => {
  it("returns null for null/undefined geometry", () => {
    expect(esriGeometryToGeoJSON(null)).toBeNull();
    expect(esriGeometryToGeoJSON(undefined)).toBeNull();
  });

  it("returns null for unrecognized geometry shapes", () => {
    expect(esriGeometryToGeoJSON({} as Record<string, unknown>)).toBeNull();
    expect(esriGeometryToGeoJSON({ foo: "bar" } as Record<string, unknown>)).toBeNull();
  });

  it("converts an Esri point", () => {
    expect(esriGeometryToGeoJSON({ x: -122.5, y: 37.7 })).toEqual({
      type: "Point",
      coordinates: [-122.5, 37.7],
    });
  });

  it("converts an Esri multipoint", () => {
    expect(
      esriGeometryToGeoJSON({
        points: [
          [-122.5, 37.7],
          [-122.4, 37.8],
        ],
      }),
    ).toEqual({
      type: "MultiPoint",
      coordinates: [
        [-122.5, 37.7],
        [-122.4, 37.8],
      ],
    });
  });

  it("returns null for an empty multipoint", () => {
    expect(esriGeometryToGeoJSON({ points: [] })).toBeNull();
  });

  it("converts a single-path polyline to a LineString", () => {
    expect(
      esriGeometryToGeoJSON({
        paths: [
          [
            [0, 0],
            [1, 1],
            [2, 0],
          ],
        ],
      }),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    });
  });

  it("converts a multi-path polyline to a MultiLineString", () => {
    expect(
      esriGeometryToGeoJSON({
        paths: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
          ],
        ],
      }),
    ).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    });
  });

  it("returns null for empty paths", () => {
    expect(esriGeometryToGeoJSON({ paths: [] })).toBeNull();
  });

  it("converts a single-ring polygon and rewinds the exterior to RFC 7946 (CCW)", () => {
    // Esri exterior rings are clockwise (negative signed area). RFC 7946
    // requires counter-clockwise exterior rings, so the emitted ring is the
    // reverse of the clockwise Esri input.
    const result = esriGeometryToGeoJSON({
      rings: [
        [
          [0, 0],
          [0, 4],
          [4, 4],
          [4, 0],
          [0, 0],
        ],
      ],
    });
    expect(result).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
      ],
    });
  });

  it("converts a polygon with a hole, rewinding exterior CCW and hole CW", () => {
    // Clockwise exterior ring + counter-clockwise interior ring (hole) on the
    // wire. RFC 7946 wants CCW exterior and CW holes, so both rings flip.
    const result = esriGeometryToGeoJSON({
      rings: [
        [
          [0, 0],
          [0, 10],
          [10, 10],
          [10, 0],
          [0, 0],
        ],
        [
          [2, 2],
          [4, 2],
          [4, 4],
          [2, 4],
          [2, 2],
        ],
      ],
    });
    expect(result).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [2, 2],
          [2, 4],
          [4, 4],
          [4, 2],
          [2, 2],
        ],
      ],
    });
  });

  it("converts multiple exterior rings to a MultiPolygon with CCW exteriors", () => {
    const result = esriGeometryToGeoJSON({
      rings: [
        [
          [0, 0],
          [0, 2],
          [2, 2],
          [2, 0],
          [0, 0],
        ],
        [
          [10, 10],
          [10, 12],
          [12, 12],
          [12, 10],
          [10, 10],
        ],
      ],
    });
    expect(result).toEqual({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
            [0, 0],
          ],
        ],
        [
          [
            [10, 10],
            [12, 10],
            [12, 12],
            [10, 12],
            [10, 10],
          ],
        ],
      ],
    });
  });

  it("emits exterior rings already CCW unchanged (idempotent rewinding)", () => {
    // A counter-clockwise (RFC 7946-conformant) exterior ring must pass through
    // untouched rather than being flipped to clockwise.
    const ccwExterior = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ];
    const result = esriGeometryToGeoJSON({ rings: [ccwExterior] });
    expect(result).toEqual({ type: "Polygon", coordinates: [ccwExterior] });
  });

  it("returns null for empty rings", () => {
    expect(esriGeometryToGeoJSON({ rings: [] })).toBeNull();
  });

  it("converts an Esri envelope to a closed polygon", () => {
    expect(
      esriGeometryToGeoJSON({
        xmin: 0,
        ymin: 0,
        xmax: 10,
        ymax: 5,
      }),
    ).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 5],
          [0, 5],
          [0, 0],
        ],
      ],
    });
  });

  it("ignores non-finite coordinates inside paths", () => {
    expect(
      esriGeometryToGeoJSON({
        paths: [
          [
            [0, 0],
            [Number.NaN, 1],
            [2, 2],
          ],
        ],
      }),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [2, 2],
      ],
    });
  });
});

describe("esriFeatureToGeoJSON", () => {
  it("converts attributes and geometry to a GeoJSON Feature", () => {
    const feature: HonuaFeature = {
      attributes: { OBJECTID: 42, name: "Station" },
      geometry: { x: -122.5, y: 37.7 },
    };
    expect(esriFeatureToGeoJSON(feature)).toEqual({
      type: "Feature",
      id: 42,
      geometry: { type: "Point", coordinates: [-122.5, 37.7] },
      properties: { OBJECTID: 42, name: "Station" },
    });
  });

  it("derives the id from common Esri identifier attributes", () => {
    expect(
      esriFeatureToGeoJSON({
        attributes: { id: "abc" },
        geometry: { x: 1, y: 2 },
      }).id,
    ).toBe("abc");
  });

  it("omits the id when no identifier attribute is present", () => {
    const result = esriFeatureToGeoJSON({
      attributes: { name: "no id" },
      geometry: { x: 1, y: 2 },
    });
    expect(result.id).toBeUndefined();
    expect(result.properties).toEqual({ name: "no id" });
  });

  it("emits null geometry for features without geometry", () => {
    const result = esriFeatureToGeoJSON({
      attributes: { OBJECTID: 1 },
      geometry: null,
    });
    expect(result.geometry).toBeNull();
  });

  it("emits null geometry for empty rings", () => {
    const result = esriFeatureToGeoJSON({
      attributes: { OBJECTID: 1 },
      geometry: { rings: [] },
    });
    expect(result.geometry).toBeNull();
  });
});
