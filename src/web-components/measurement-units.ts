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

import type { HonuaMeasureAreaUnit, HonuaMeasureDistanceUnit } from "./types.js";

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

/** Meters per degree of latitude (WGS84, constant to within centimeters at any latitude). */
const METERS_PER_DEGREE_LATITUDE = 111_132.92;

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

/** Projects lng/lat degrees to local flat-earth meters, centered on the sketch's mean latitude. */
function toLocalMeters(position: LngLat, metersPerDegLon: number): readonly [number, number] {
  return [position[0] * metersPerDegLon, position[1] * METERS_PER_DEGREE_LATITUDE];
}

/**
 * Euclidean length of a line, in meters, over a local flat-earth
 * approximation centered on the vertices' mean latitude. Unlike the geodesic
 * `length` op in `@honua/geometry`, this never follows the great-circle —
 * it is what `fidelity: "planar"` asks for, and matches `MeasurementCompat`'s
 * approximation.
 */
export function planarLength(positions: readonly LngLat[]): number {
  if (positions.length < 2) return 0;
  const metersPerDegLon = metersPerDegreeLongitude(meanLatitude(positions));
  let total = 0;
  for (let index = 1; index < positions.length; index += 1) {
    const [x0, y0] = toLocalMeters(positions[index - 1] as LngLat, metersPerDegLon);
    const [x1, y1] = toLocalMeters(positions[index] as LngLat, metersPerDegLon);
    total += Math.hypot(x1 - x0, y1 - y0);
  }
  return total;
}

/**
 * Euclidean (shoelace) area of a ring, in square meters, over the same local
 * flat-earth approximation as {@link planarLength}. `positions` need not be
 * closed; the first vertex is implicitly repeated to close the ring.
 */
export function planarArea(positions: readonly LngLat[]): number {
  if (positions.length < 3) return 0;
  const closed = [...positions, positions[0] as LngLat];
  const metersPerDegLon = metersPerDegreeLongitude(meanLatitude(positions));
  let sum = 0;
  for (let index = 1; index < closed.length; index += 1) {
    const [x0, y0] = toLocalMeters(closed[index - 1] as LngLat, metersPerDegLon);
    const [x1, y1] = toLocalMeters(closed[index] as LngLat, metersPerDegLon);
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}
