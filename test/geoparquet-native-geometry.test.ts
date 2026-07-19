import { describe, expect, it } from "vitest";

import {
  GeoParquetNativeGeometryError,
  decodeGeoParquetNativeGeometryColumn,
} from "../src/geoparquet/native-geometry.js";

const pt = (x: number, y: number) => ({ x, y });
const ptz = (x: number, y: number, z: number) => ({ x, y, z });

describe("decodeGeoParquetNativeGeometryColumn — point", () => {
  it("decodes finite xy points, preserving null and coordinate order", () => {
    const values = [pt(-157.86, 21.31), null, pt(-157.77, 21.44)];
    expect(decodeGeoParquetNativeGeometryColumn("point", "xy", values)).toEqual([
      { type: "Point", coordinates: [-157.86, 21.31] },
      null,
      { type: "Point", coordinates: [-157.77, 21.44] },
    ]);
  });

  it("decodes xyz points (Z)", () => {
    const values = [ptz(1, 2, 3)];
    expect(decodeGeoParquetNativeGeometryColumn("point", "xyz", values)).toEqual([
      { type: "Point", coordinates: [1, 2, 3] },
    ]);
  });

  it("rejects a z field when dimensions are declared xy (hostile physical/declared mismatch)", () => {
    expect(() => decodeGeoParquetNativeGeometryColumn("point", "xy", [ptz(1, 2, 3)])).toThrow(
      GeoParquetNativeGeometryError,
    );
  });

  it("rejects a missing z when dimensions are declared xyz", () => {
    expect(() => decodeGeoParquetNativeGeometryColumn("point", "xyz", [pt(1, 2)])).toThrow(
      GeoParquetNativeGeometryError,
    );
  });

  it("rejects non-finite coordinates", () => {
    expect(() => decodeGeoParquetNativeGeometryColumn("point", "xy", [{ x: Number.NaN, y: 1 }])).toThrow(
      /GEOPARQUET_NATIVE_INVALID_VALUE/,
    );
    expect(() => decodeGeoParquetNativeGeometryColumn("point", "xy", [{ x: Number.POSITIVE_INFINITY, y: 1 }])).toThrow(
      GeoParquetNativeGeometryError,
    );
  });

  it("rejects a row that is not a coordinate struct (hostile depth: scalar instead of struct)", () => {
    expect(() => decodeGeoParquetNativeGeometryColumn("point", "xy", [42])).toThrow(GeoParquetNativeGeometryError);
    expect(() => decodeGeoParquetNativeGeometryColumn("point", "xy", [[1, 2]])).toThrow(GeoParquetNativeGeometryError);
  });

  it("rejects unsupported dimensions", () => {
    // @ts-expect-error — exercising the runtime fail-closed guard for a caller
    // that bypasses the type system (e.g. a stale/foreign resolved query plan).
    expect(() => decodeGeoParquetNativeGeometryColumn("point", "xym", [pt(1, 2)])).toThrow(
      /GEOPARQUET_NATIVE_UNSUPPORTED_DIMENSIONS/,
    );
  });
});

describe("decodeGeoParquetNativeGeometryColumn — linestring / multipoint", () => {
  it("decodes a LineString, including an empty (zero-vertex) line and null", () => {
    const values = [[pt(0, 0), pt(1, 1), pt(2, 0)], [], null];
    expect(decodeGeoParquetNativeGeometryColumn("linestring", "xy", values)).toEqual([
      {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      },
      { type: "LineString", coordinates: [] },
      null,
    ]);
  });

  it("decodes the physically-identical MultiPoint reuse path with MultiPoint GeoJSON typing", () => {
    const values = [[pt(0, 0), pt(5, 5)]];
    expect(decodeGeoParquetNativeGeometryColumn("multipoint", "xy", values)).toEqual([
      {
        type: "MultiPoint",
        coordinates: [
          [0, 0],
          [5, 5],
        ],
      },
    ]);
  });

  it("decodes xyz linestrings", () => {
    const values = [[ptz(0, 0, 1), ptz(1, 1, 2)]];
    expect(decodeGeoParquetNativeGeometryColumn("linestring", "xyz", values)).toEqual([
      {
        type: "LineString",
        coordinates: [
          [0, 0, 1],
          [1, 1, 2],
        ],
      },
    ]);
  });

  it("rejects a row that is not an array (hostile depth: struct instead of list)", () => {
    expect(() => decodeGeoParquetNativeGeometryColumn("linestring", "xy", [pt(1, 2)])).toThrow(
      GeoParquetNativeGeometryError,
    );
  });

  it("fails closed once the vertex bound is exceeded", () => {
    const line = Array.from({ length: 5 }, (_, i) => pt(i, i));
    expect(() => decodeGeoParquetNativeGeometryColumn("linestring", "xy", [line], { maxVertices: 4 })).toThrow(
      /GEOPARQUET_NATIVE_VERTEX_LIMIT_EXCEEDED/,
    );
  });
});

describe("decodeGeoParquetNativeGeometryColumn — polygon / multilinestring", () => {
  const ring = [pt(0, 0), pt(0, 1), pt(1, 1), pt(0, 0)];

  it("decodes a Polygon with a closed ring, an empty polygon, and null", () => {
    const values = [[ring], [], null];
    expect(decodeGeoParquetNativeGeometryColumn("polygon", "xy", values)).toEqual([
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      { type: "Polygon", coordinates: [] },
      null,
    ]);
  });

  it("decodes the physically-identical MultiLineString reuse path", () => {
    const line1 = [pt(0, 0), pt(1, 1)];
    const line2 = [pt(2, 2), pt(3, 3)];
    expect(decodeGeoParquetNativeGeometryColumn("multilinestring", "xy", [[line1, line2]])).toEqual([
      {
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
      },
    ]);
  });

  it("rejects an open ring (ring-closure rule inherited from src/columnar/geoarrow.ts)", () => {
    const openRing = [pt(0, 0), pt(0, 1), pt(1, 1)];
    expect(() => decodeGeoParquetNativeGeometryColumn("polygon", "xy", [[openRing]])).toThrow();
  });

  it("rejects a ring with fewer than four positions", () => {
    const tooShort = [pt(0, 0), pt(0, 1), pt(0, 0)];
    expect(() => decodeGeoParquetNativeGeometryColumn("polygon", "xy", [[tooShort]])).toThrow();
  });

  it("rejects a row where a ring is not an array (hostile depth: one nesting level short)", () => {
    expect(() => decodeGeoParquetNativeGeometryColumn("polygon", "xy", [[pt(0, 0)]])).toThrow(
      GeoParquetNativeGeometryError,
    );
  });

  it("fails closed once the ring bound is exceeded", () => {
    const rings = Array.from({ length: 5 }, () => ring);
    expect(() => decodeGeoParquetNativeGeometryColumn("polygon", "xy", [rings], { maxRings: 4 })).toThrow(
      /GEOPARQUET_NATIVE_RING_LIMIT_EXCEEDED/,
    );
  });
});

describe("decodeGeoParquetNativeGeometryColumn — multipolygon (flatten + regroup)", () => {
  const ring = [pt(0, 0), pt(0, 1), pt(1, 1), pt(0, 0)];
  const otherRing = [pt(5, 5), pt(5, 6), pt(6, 6), pt(5, 5)];

  it("decodes multiple parts per row, an empty MultiPolygon, and null", () => {
    const values = [[[ring], [otherRing]], [], null];
    expect(decodeGeoParquetNativeGeometryColumn("multipolygon", "xy", values)).toEqual([
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [0, 0],
            ],
          ],
          [
            [
              [5, 5],
              [5, 6],
              [6, 6],
              [5, 5],
            ],
          ],
        ],
      },
      { type: "MultiPolygon", coordinates: [] },
      null,
    ]);
  });

  it("decodes xyz multipolygons", () => {
    const ringZ = [ptz(0, 0, 1), ptz(0, 1, 1), ptz(1, 1, 1), ptz(0, 0, 1)];
    expect(decodeGeoParquetNativeGeometryColumn("multipolygon", "xyz", [[[ringZ]]])).toEqual([
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [0, 0, 1],
              [0, 1, 1],
              [1, 1, 1],
              [0, 0, 1],
            ],
          ],
        ],
      },
    ]);
  });

  it("rejects a row where a part is not an array of rings (hostile depth: one level short)", () => {
    expect(() => decodeGeoParquetNativeGeometryColumn("multipolygon", "xy", [[ring]])).toThrow(
      GeoParquetNativeGeometryError,
    );
  });

  it("rejects an open ring nested inside a multipolygon part", () => {
    const openRing = [pt(0, 0), pt(0, 1), pt(1, 1)];
    expect(() => decodeGeoParquetNativeGeometryColumn("multipolygon", "xy", [[[openRing]]])).toThrow();
  });

  it("fails closed once the flattened part bound is exceeded", () => {
    const parts = Array.from({ length: 5 }, () => [ring]);
    expect(() => decodeGeoParquetNativeGeometryColumn("multipolygon", "xy", [parts], { maxParts: 4 })).toThrow(
      /GEOPARQUET_NATIVE_PART_LIMIT_EXCEEDED/,
    );
  });

  it("bounds the total part count across every row, not just one row", () => {
    const parts = Array.from({ length: 3 }, () => [ring]);
    expect(() => decodeGeoParquetNativeGeometryColumn("multipolygon", "xy", [parts, parts], { maxParts: 4 })).toThrow(
      /GEOPARQUET_NATIVE_PART_LIMIT_EXCEEDED/,
    );
  });
});

describe("decodeGeoParquetNativeGeometryColumn — general fail-closed behavior", () => {
  it("rejects a non-array column value", () => {
    // @ts-expect-error — exercising the runtime guard against a malformed caller input.
    expect(() => decodeGeoParquetNativeGeometryColumn("point", "xy", "not-an-array")).toThrow(
      /GEOPARQUET_NATIVE_INVALID_VALUE/,
    );
  });

  it("carries a stable error code/path/detail for programmatic handling", () => {
    try {
      decodeGeoParquetNativeGeometryColumn("point", "xy", [{ x: "not-a-number", y: 1 }]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GeoParquetNativeGeometryError);
      const typed = error as GeoParquetNativeGeometryError;
      expect(typed.code).toBe("GEOPARQUET_NATIVE_INVALID_VALUE");
      expect(typed.path).toBe("$[0].x");
    }
  });
});
