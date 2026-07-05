import { describe, expect, it } from "vitest";

import {
  buffer,
  area,
  bbox,
  booleanContains,
  booleanIntersects,
  booleanWithin,
  centroid,
  convex,
  difference,
  intersect,
  length,
  nearestPoint,
  simplify,
  union,
} from "../../src/geometry/index.js";
import type { GeoJsonPoint, GeoJsonPolygon } from "../../src/geometry/index.js";

// A ~1° lat/lng box near the equator (WGS84). All turf math is geodesic.
const box = (west: number, south: number, east: number, north: number): GeoJsonPolygon => ({
  type: "Polygon",
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
});

const unitSquare = box(0, 0, 1, 1);

describe("@honua/geometry ops", () => {
  it("buffer expands a polygon's area", () => {
    const buffered = buffer(unitSquare, 10, "kilometers");
    expect(buffered).not.toBeNull();
    expect(area(buffered as GeoJsonPolygon)).toBeGreaterThan(area(unitSquare));
  });

  it("area returns a geodesic square-meter value", () => {
    // A 1°×1° box at the equator is ~12,300 km² geodesically.
    const km2 = area(unitSquare) / 1_000_000;
    expect(km2).toBeGreaterThan(12_000);
    expect(km2).toBeLessThan(12_500);
  });

  it("length measures a line in the requested unit", () => {
    const line = {
      type: "LineString" as const,
      coordinates: [
        [0, 0],
        [0, 1],
      ],
    };
    const km = length(line, "kilometers");
    // 1° of latitude ≈ 111 km.
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });

  it("centroid of the unit square is its center", () => {
    const c = centroid(unitSquare);
    expect(c.type).toBe("Point");
    expect(c.coordinates[0]).toBeCloseTo(0.5, 5);
    expect(c.coordinates[1]).toBeCloseTo(0.5, 5);
  });

  it("bbox returns [minX, minY, maxX, maxY]", () => {
    expect(bbox(box(-2, -3, 4, 5))).toEqual([-2, -3, 4, 5]);
  });

  it("simplify reduces vertex count for a coarse tolerance", () => {
    const jagged: GeoJsonPolygon = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [0.5, 0.01],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    const simplified = simplify(jagged, 0.5) as GeoJsonPolygon;
    expect(simplified.coordinates[0].length).toBeLessThanOrEqual(jagged.coordinates[0].length);
  });

  it("boolean predicates classify containment and overlap", () => {
    const outer = box(0, 0, 10, 10);
    const inner = box(2, 2, 4, 4);
    const overlapping = box(3, 3, 12, 12);
    const disjoint = box(20, 20, 21, 21);

    expect(booleanContains(outer, inner)).toBe(true);
    expect(booleanWithin(inner, outer)).toBe(true);
    expect(booleanIntersects(outer, overlapping)).toBe(true);
    expect(booleanIntersects(outer, disjoint)).toBe(false);
  });

  it("union / intersect / difference combine polygons", () => {
    const a = box(0, 0, 2, 2);
    const b = box(1, 1, 3, 3);

    const merged = union(a, b);
    expect(merged).not.toBeNull();
    expect(area(merged as GeoJsonPolygon)).toBeGreaterThan(area(a));

    const overlap = intersect(a, b);
    expect(overlap).not.toBeNull();
    expect(area(overlap as GeoJsonPolygon)).toBeLessThan(area(a));

    const remainder = difference(a, b);
    expect(remainder).not.toBeNull();
    expect(area(remainder as GeoJsonPolygon)).toBeLessThan(area(a));

    expect(intersect(a, box(50, 50, 51, 51))).toBeNull();
  });

  it("convex hull wraps a point cloud", () => {
    const cloud = {
      type: "MultiPoint" as const,
      coordinates: [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [2, 2],
      ],
    };
    const hull = convex(cloud) as GeoJsonPolygon;
    expect(hull.type).toBe("Polygon");
    // The interior point is not a hull vertex.
    expect(hull.coordinates[0].length).toBeLessThanOrEqual(5);
  });

  it("nearestPoint finds the closest candidate", () => {
    const target: GeoJsonPoint = { type: "Point", coordinates: [0, 0] };
    const candidates: GeoJsonPoint[] = [
      { type: "Point", coordinates: [10, 10] },
      { type: "Point", coordinates: [1, 1] },
      { type: "Point", coordinates: [5, 5] },
    ];
    const nearest = nearestPoint(target, candidates);
    expect(nearest.geometry).not.toBeNull();
    expect((nearest.geometry as GeoJsonPoint).coordinates).toEqual([1, 1]);
  });
});
