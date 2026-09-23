/**
 * Unit conversion, display formatting, and planar (Euclidean, flat-earth)
 * math for `<honua-measurement>` (issue #1419).
 *
 * All conversion and formatting here operates on the canonical SI value
 * already stored on `HonuaMeasureResult` (meters / square meters) — never on
 * a previously rounded display string — so switching `unit`/`areaUnit`/
 * `precision` at runtime always reformats the same full-precision number.
 *
 * `planarLength` / `planarArea` intentionally do not depend on `proj4`
 * (`@honua/geometry`'s `project`): pulling that in would add proj4 as a
 * static import of every `<honua-measurement>` consumer's bundle (the
 * `/web-components` and `/controls` entrypoints), well past their gzip
 * budgets, for a fidelity mode most apps never enable. Instead this uses the
 * same equirectangular (meters-per-degree-of-latitude/longitude) flat-earth
 * approximation `MeasurementCompat` already ships in `src/esri-compat/
 * measurement.ts` — accurate for the local-extent sketches this widget draws,
 * and proven parity math rather than a new approach.
 *
 * @module
 */

import type { HonuaMeasureAreaUnit, HonuaMeasureDistanceUnit, HonuaMeasurePlanarCrs } from "./types.js";

type LngLat = readonly [number, number];

const METERS_PER_DISTANCE_UNIT: Record<Exclude<HonuaMeasureDistanceUnit, "auto">, number> = {
  meters: 1,
  kilometers: 1000,
  feet: 0.3048,
  yards: 0.9144,
  miles: 1609.344,
  nauticalmiles: 1852,
};

const SQUARE_METERS_PER_AREA_UNIT: Record<Exclude<HonuaMeasureAreaUnit, "auto">, number> = {
  "square-meters": 1,
  hectares: 10_000,
  "square-kilometers": 1_000_000,
  "square-feet": 0.09290304,
  acres: 4046.8564224,
  "square-miles": 2_589_988.110336,
};

const DISTANCE_UNIT_SUFFIX: Record<Exclude<HonuaMeasureDistanceUnit, "auto">, string> = {
  meters: "m",
  kilometers: "km",
  feet: "ft",
  yards: "yd",
  miles: "mi",
  nauticalmiles: "nmi",
};

const AREA_UNIT_SUFFIX: Record<Exclude<HonuaMeasureAreaUnit, "auto">, string> = {
  "square-meters": "m²",
  hectares: "ha",
  "square-kilometers": "km²",
  "square-feet": "ft²",
  acres: "ac",
  "square-miles": "mi²",
};

/** Converts a distance already in meters into `unit`. */
export function convertDistance(meters: number, unit: Exclude<HonuaMeasureDistanceUnit, "auto">): number {
  return meters / METERS_PER_DISTANCE_UNIT[unit];
}

/** Converts an area already in square meters into `unit`. */
export function convertArea(squareMeters: number, unit: Exclude<HonuaMeasureAreaUnit, "auto">): number {
  return squareMeters / SQUARE_METERS_PER_AREA_UNIT[unit];
}

/** Resolves `"auto"` to a concrete unit given the magnitude, matching the pre-#1419 auto-scaling. */
function resolveDistanceUnit(
  meters: number,
  unit: HonuaMeasureDistanceUnit,
): Exclude<HonuaMeasureDistanceUnit, "auto"> {
  if (unit !== "auto") return unit;
  return meters >= 1000 ? "kilometers" : "meters";
}

/** Resolves `"auto"` to a concrete unit given the magnitude, matching the pre-#1419 auto-scaling. */
function resolveAreaUnit(squareMeters: number, unit: HonuaMeasureAreaUnit): Exclude<HonuaMeasureAreaUnit, "auto"> {
  if (unit !== "auto") return unit;
  if (squareMeters >= 1_000_000) return "square-kilometers";
  if (squareMeters >= 10_000) return "hectares";
  return "square-meters";
}

/** Default decimal digits per resolved unit, matching the pre-#1419 formatting. */
function defaultDistancePrecision(unit: Exclude<HonuaMeasureDistanceUnit, "auto">): number {
  return unit === "meters" ? 1 : 2;
}

/** Default decimal digits per resolved unit, matching the pre-#1419 formatting. */
function defaultAreaPrecision(unit: Exclude<HonuaMeasureAreaUnit, "auto">): number {
  return unit === "square-meters" ? 1 : 2;
}

/**
 * Formats a canonical meters value for display. `precision` overrides the
 * unit's default decimal digits; `unit` overrides magnitude-based auto-scaling.
 */
export function formatDistanceValue(meters: number, unit: HonuaMeasureDistanceUnit, precision?: number): string {
  const resolved = resolveDistanceUnit(meters, unit);
  const value = convertDistance(meters, resolved);
  const digits = precision ?? defaultDistancePrecision(resolved);
  return `${value.toFixed(digits)} ${DISTANCE_UNIT_SUFFIX[resolved]}`;
}

/**
 * Formats a canonical square-meters value for display. `precision` overrides
 * the unit's default decimal digits; `unit` overrides magnitude-based
 * auto-scaling.
 */
export function formatAreaValue(squareMeters: number, unit: HonuaMeasureAreaUnit, precision?: number): string {
  const resolved = resolveAreaUnit(squareMeters, unit);
  const value = convertArea(squareMeters, resolved);
  const digits = precision ?? defaultAreaPrecision(resolved);
  return `${value.toFixed(digits)} ${AREA_UNIT_SUFFIX[resolved]}`;
}

/** Distance units `<honua-measurement>` accepts, including `"auto"`. */
export const HONUA_MEASURE_DISTANCE_UNITS: readonly HonuaMeasureDistanceUnit[] = [
  "auto",
  ...(Object.keys(METERS_PER_DISTANCE_UNIT) as Exclude<HonuaMeasureDistanceUnit, "auto">[]),
];

/** Area units `<honua-measurement>` accepts, including `"auto"`. */
export const HONUA_MEASURE_AREA_UNITS: readonly HonuaMeasureAreaUnit[] = [
  "auto",
  ...(Object.keys(SQUARE_METERS_PER_AREA_UNIT) as Exclude<HonuaMeasureAreaUnit, "auto">[]),
];

/** Planar frames `<honua-measurement>` accepts for `fidelity: "planar"`. */
export const HONUA_MEASURE_PLANAR_CRS: readonly HonuaMeasurePlanarCrs[] = ["local", "EPSG:3857"];

/** Meters per degree of latitude (WGS84, constant to within centimeters at any latitude). */
const METERS_PER_DEGREE_LATITUDE = 111_132.92;

/** Semi-major axis EPSG:3857 (spherical Web Mercator) projects onto. */
const WEB_MERCATOR_RADIUS = 6_378_137;

/** Latitude beyond which EPSG:3857 is undefined (the square-world clamp). */
const WEB_MERCATOR_MAX_LATITUDE = 85.051_128_779_806_59;

/** Meters per degree of longitude at WGS84 latitude `latDeg`. */
function metersPerDegreeLongitude(latDeg: number): number {
  return 111_412.84 * Math.cos(toRadians(latDeg));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function meanLatitude(positions: readonly LngLat[]): number {
  return positions.reduce((sum, [, lat]) => sum + lat, 0) / positions.length;
}

/**
 * Whether a position is a usable WGS84 vertex: finite, with latitude inside
 * `[-90, 90]`. Longitude may exceed ±180 — MapLibre reports clicks on a world
 * copy that way — and is unwrapped before any planar math.
 */
export function isValidMeasureVertex(position: readonly number[]): boolean {
  const [lng, lat] = position;
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * Shifts each longitude by whole turns so consecutive vertices are never more
 * than 180° apart. A sketch crossing the antimeridian (179° → -179°) is then
 * measured the short way, matching what the geodesic ops already do, instead
 * of across 358° of flat map.
 */
export function unwrapLongitudes(positions: readonly LngLat[]): LngLat[] {
  const unwrapped: LngLat[] = [];
  for (const [lng, lat] of positions) {
    const previous = unwrapped[unwrapped.length - 1];
    if (!previous) {
      unwrapped.push([lng, lat]);
      continue;
    }
    const turns = Math.round((lng - previous[0]) / 360);
    unwrapped.push([lng - turns * 360, lat]);
  }
  return unwrapped;
}

/** Projects unwrapped lng/lat into the planar frame's meters. */
function projector(positions: readonly LngLat[], crs: HonuaMeasurePlanarCrs): (position: LngLat) => [number, number] {
  if (crs === "EPSG:3857") {
    return ([lng, lat]) => {
      const clamped = Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, lat));
      return [
        WEB_MERCATOR_RADIUS * toRadians(lng),
        WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + toRadians(clamped) / 2)),
      ];
    };
  }
  const metersPerDegLon = metersPerDegreeLongitude(meanLatitude(positions));
  return ([lng, lat]) => [lng * metersPerDegLon, lat * METERS_PER_DEGREE_LATITUDE];
}

/**
 * Euclidean length of a line, in meters of the planar frame `crs`:
 *
 * - `"local"` (default): a flat-earth approximation centered on the vertices'
 *   mean latitude, matching `MeasurementCompat`'s approximation.
 * - `"EPSG:3857"`: spherical Web Mercator, the projected CRS MapLibre renders
 *   in. Its meters are not scale-corrected, so lengths grow by `sec(latitude)`
 *   away from the equator — which is what an app mirroring ArcGIS planar
 *   measurement on a Web Mercator view expects.
 *
 * Unlike the geodesic `length` op in `@honua/geometry`, this never follows
 * the great circle. Longitudes are unwrapped first, so an antimeridian
 * crossing is measured the short way.
 */
export function planarLength(positions: readonly LngLat[], crs: HonuaMeasurePlanarCrs = "local"): number {
  if (positions.length < 2) return 0;
  const unwrapped = unwrapLongitudes(positions);
  const project = projector(unwrapped, crs);
  let total = 0;
  for (let index = 1; index < unwrapped.length; index += 1) {
    const [x0, y0] = project(unwrapped[index - 1] as LngLat);
    const [x1, y1] = project(unwrapped[index] as LngLat);
    total += Math.hypot(x1 - x0, y1 - y0);
  }
  return total;
}

/**
 * Euclidean (shoelace) area of a ring, in square meters of the planar frame
 * `crs` (see {@link planarLength}). `positions` need not be closed; the first
 * vertex is implicitly repeated to close the ring.
 */
export function planarArea(positions: readonly LngLat[], crs: HonuaMeasurePlanarCrs = "local"): number {
  if (positions.length < 3) return 0;
  const unwrapped = unwrapLongitudes(positions);
  const project = projector(unwrapped, crs);
  const closed = [...unwrapped, unwrapped[0] as LngLat].map(project);
  let sum = 0;
  for (let index = 1; index < closed.length; index += 1) {
    const [x0, y0] = closed[index - 1] as [number, number];
    const [x1, y1] = closed[index] as [number, number];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/**
 * Whether the closed ring through `positions` crosses itself (a "bow tie").
 * Such a ring has no single enclosed area: the shoelace and geodesic sums
 * cancel the lobes against each other, so reporting their result would be a
 * confident wrong number. Touching at a shared vertex of adjacent edges is
 * not a crossing; collinear overlap of non-adjacent edges is.
 */
export function ringSelfIntersects(positions: readonly LngLat[]): boolean {
  const ring = unwrapLongitudes(positions);
  const count = ring.length;
  if (count < 4) return false;
  for (let first = 0; first < count; first += 1) {
    const a = ring[first] as LngLat;
    const b = ring[(first + 1) % count] as LngLat;
    for (let second = first + 1; second < count; second += 1) {
      // Skip the edge itself and the two edges that share a vertex with it.
      if (second === first || (second + 1) % count === first || (first + 1) % count === second) continue;
      const c = ring[second] as LngLat;
      const d = ring[(second + 1) % count] as LngLat;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function orientation(p: LngLat, q: LngLat, r: LngLat): number {
  const value = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(p: LngLat, q: LngLat, r: LngLat): boolean {
  return (
    q[0] <= Math.max(p[0], r[0]) &&
    q[0] >= Math.min(p[0], r[0]) &&
    q[1] <= Math.max(p[1], r[1]) &&
    q[1] >= Math.min(p[1], r[1])
  );
}

function segmentsIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(a, c, b)) ||
    (o2 === 0 && onSegment(a, d, b)) ||
    (o3 === 0 && onSegment(c, a, d)) ||
    (o4 === 0 && onSegment(c, b, d))
  );
}
