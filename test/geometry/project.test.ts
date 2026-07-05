import { describe, expect, it } from "vitest";

import { defineProjection, normalizeCrs, project, toWebMercator, toWgs84 } from "../../src/geometry/index.js";
import type { GeoJsonPoint } from "../../src/geometry/index.js";

const sf: GeoJsonPoint = { type: "Point", coordinates: [-122.4194, 37.7749] };
// Web Mercator of the point above (proj4 reference values), tolerance ~1m.
const sfMercatorX = -13_627_665.27;
const sfMercatorY = 4_547_675.35;

describe("@honua/geometry project", () => {
  it("normalizeCrs maps numeric codes and Web Mercator aliases", () => {
    expect(normalizeCrs(4326)).toBe("EPSG:4326");
    expect(normalizeCrs(3857)).toBe("EPSG:3857");
    expect(normalizeCrs(102100)).toBe("EPSG:3857");
    expect(normalizeCrs("EPSG:3857")).toBe("EPSG:3857");
    expect(normalizeCrs("epsg:4326")).toBe("EPSG:4326");
  });

  it("projects WGS84 → Web Mercator", () => {
    const projected = project(sf, 4326, 3857) as GeoJsonPoint;
    expect(projected.coordinates[0]).toBeCloseTo(sfMercatorX, -1);
    expect(projected.coordinates[1]).toBeCloseTo(sfMercatorY, -1);
  });

  it("toWebMercator / toWgs84 round-trip within tolerance", () => {
    const mercator = toWebMercator(sf, 4326) as GeoJsonPoint;
    const back = toWgs84(mercator, 3857) as GeoJsonPoint;
    expect(back.coordinates[0]).toBeCloseTo(sf.coordinates[0], 6);
    expect(back.coordinates[1]).toBeCloseTo(sf.coordinates[1], 6);
  });

  it("is a no-op (clone) when the source and target CRS match", () => {
    const cloned = project(sf, 4326, "EPSG:4326") as GeoJsonPoint;
    expect(cloned).toEqual(sf);
    expect(cloned).not.toBe(sf);
  });

  it("preserves extra ordinates (z/m) through reprojection", () => {
    const withZ: GeoJsonPoint = { type: "Point", coordinates: [-122.4194, 37.7749, 55] };
    const projected = project(withZ, 4326, 3857) as GeoJsonPoint;
    expect(projected.coordinates[2]).toBe(55);
  });

  it("defineProjection registers a custom CRS (UTM zone 10N)", () => {
    defineProjection(32610, "+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs");
    const utm = project(sf, 4326, 32610) as GeoJsonPoint;
    // SF sits in UTM zone 10N; easting ~550km, northing ~4.18M m.
    expect(utm.coordinates[0]).toBeGreaterThan(540_000);
    expect(utm.coordinates[0]).toBeLessThan(560_000);
    expect(utm.coordinates[1]).toBeGreaterThan(4_170_000);
    expect(utm.coordinates[1]).toBeLessThan(4_190_000);
  });
});
