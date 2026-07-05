import { describe, expect, it } from "vitest";

import {
  buffer,
  contains,
  convexHull,
  difference,
  geodesicArea,
  geodesicLength,
  geometryEngineAsyncCompat,
  geometryEngineCompat,
  intersect,
  intersects,
  planarArea,
  planarLength,
  union,
} from "../src/esri-compat/geometry-engine.js";

// Parity fixtures. Esri geometries are tagged Web Mercator (wkid 3857) so that
// the planar* ops operate in a projected meter plane and can be checked against
// exact analytic values; geodesic* ops reproject to WGS84 first.
//
// Documented tolerances:
//  - planar area/length: exact to < 1e-6 relative (pure arithmetic on coords).
//  - geodesic area/length: within 0.5% of the great-circle analytic value
//    (turf's spherical model vs. a spherical hand-calc).
//  - buffer: geodesic (turf) — differs from Esri's planar buffer; asserted only
//    on monotonic area growth and output shape, not exact vertices.
const WEB_MERCATOR = { wkid: 3857 };

/** A square in Web Mercator meters: [x0,y0] origin, `size` metres on a side. */
function mercatorSquare(x0: number, y0: number, size: number) {
  return {
    rings: [
      [
        [x0, y0],
        [x0 + size, y0],
        [x0 + size, y0 + size],
        [x0, y0 + size],
        [x0, y0],
      ],
    ],
    spatialReference: WEB_MERCATOR,
  };
}

describe("geometryEngineCompat parity", () => {
  it("planarArea of a 100m Web-Mercator square is exactly 10,000 m²", () => {
    const square = mercatorSquare(0, 0, 100);
    expect(planarArea(square)).toBeCloseTo(10_000, 6);
    expect(planarArea(square, "square-kilometers")).toBeCloseTo(0.01, 9);
  });

  it("planarLength of a 100m square perimeter is exactly 400 m", () => {
    const square = mercatorSquare(0, 0, 100);
    expect(planarLength(square)).toBeCloseTo(400, 6);
    expect(planarLength(square, "feet")).toBeCloseTo(400 / 0.3048, 3);
  });

  it("geodesicArea of a ~1° box near the equator matches turf within 0.5%", () => {
    // Box in WGS84 degrees (tag as 4326 so no reprojection distortion).
    const box = {
      rings: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
      spatialReference: { wkid: 4326 },
    };
    const km2 = geodesicArea(box, "square-kilometers");
    expect(km2).toBeGreaterThan(12_300 * 0.995);
    expect(km2).toBeLessThan(12_400 * 1.005);
  });

  it("geodesicLength of a 1° meridian segment is ~111 km", () => {
    const line = {
      paths: [
        [
          [0, 0],
          [0, 1],
        ],
      ],
      spatialReference: { wkid: 4326 },
    };
    expect(geodesicLength(line, "kilometers")).toBeGreaterThan(110);
    expect(geodesicLength(line, "kilometers")).toBeLessThan(112);
  });

  it("buffer returns an Esri polygon whose area exceeds the source", () => {
    const square = mercatorSquare(0, 0, 100);
    const buffered = buffer(square, 50, "meters") as { rings: number[][][] };
    expect(Array.isArray(buffered.rings)).toBe(true);
    expect(planarArea(buffered)).toBeGreaterThan(10_000);
  });

  it("union / intersect / difference respect planar areas", () => {
    const a = mercatorSquare(0, 0, 100);
    const b = mercatorSquare(50, 50, 100);

    const merged = union([a, b]);
    expect(merged).not.toBeNull();
    // Two 100m squares overlapping in a 50×50 corner → 2*10000 − 2500.
    expect(planarArea(merged)).toBeCloseTo(17_500, 4);

    const overlap = intersect(a, b);
    expect(planarArea(overlap)).toBeCloseTo(2_500, 4);

    const remainder = difference(a, b);
    expect(planarArea(remainder)).toBeCloseTo(7_500, 4);
  });

  it("contains / intersects predicates", () => {
    const outer = mercatorSquare(0, 0, 100);
    const inner = mercatorSquare(25, 25, 25);
    const straddling = mercatorSquare(50, 50, 100);
    const away = mercatorSquare(1000, 1000, 10);

    expect(contains(outer, inner)).toBe(true);
    expect(intersects(outer, straddling)).toBe(true);
    expect(intersects(outer, away)).toBe(false);
  });

  it("convexHull wraps a multipoint cloud", () => {
    const cloud = {
      points: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
        [50, 50],
      ],
      spatialReference: WEB_MERCATOR,
    };
    const hull = convexHull(cloud) as { rings: number[][][] };
    expect(Array.isArray(hull.rings)).toBe(true);
    expect(hull.rings[0].length).toBeLessThanOrEqual(5);
  });

  it("simplify returns a topologically valid Esri geometry (round-trip)", () => {
    const square = mercatorSquare(0, 0, 100);
    const simplified = geometryEngineCompat.simplify(square) as { rings: number[][][] };
    expect(Array.isArray(simplified.rings)).toBe(true);
    expect(planarArea(simplified)).toBeCloseTo(10_000, 4);
  });

  it("accepts Honua compat geometry instances via toJSON()", () => {
    const instance = {
      toJSON: () => mercatorSquare(0, 0, 100),
    };
    expect(planarArea(instance)).toBeCloseTo(10_000, 6);
  });

  it("stamps the source spatial reference onto results", () => {
    const square = mercatorSquare(0, 0, 100);
    const buffered = buffer(square, 10, "meters") as { spatialReference?: { wkid?: number } };
    expect(buffered.spatialReference?.wkid).toBe(3857);
  });

  it("exposes the full geometryEngine-shaped namespace", () => {
    for (const op of [
      "buffer",
      "intersect",
      "union",
      "difference",
      "geodesicArea",
      "planarArea",
      "geodesicLength",
      "planarLength",
      "simplify",
      "convexHull",
      "contains",
      "intersects",
    ] as const) {
      expect(typeof geometryEngineCompat[op]).toBe("function");
    }
  });

  it("async variant mirrors the sync ops with promises", async () => {
    const square = mercatorSquare(0, 0, 100);
    await expect(geometryEngineAsyncCompat.planarArea(square)).resolves.toBeCloseTo(10_000, 6);
    const buffered = await geometryEngineAsyncCompat.buffer(square, 10, "meters");
    expect(buffered).not.toBeNull();
  });
});
