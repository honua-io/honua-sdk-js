/**
 * Reprojection helpers backed by `proj4`.
 *
 * Only EPSG:4326 (WGS84) and EPSG:3857 (Web Mercator) are needed by default —
 * both are built into proj4, so this module registers **nothing** at import
 * time and stays side-effect-free for tree-shaking. Additional coordinate
 * systems are registered on demand via {@link defineProjection}.
 *
 * @module
 */

import proj4 from "proj4";

import type { GeoJsonGeometry } from "../expr/expression.js";
import { inputToGeometry } from "./internal.js";
import type { GeometryInput } from "./types.js";

/** EPSG codes that are aliases for Web Mercator across Esri/OGC usage. */
const WEB_MERCATOR_ALIASES = new Set([3857, 3785, 900913, 102100, 102113]);

/**
 * Normalize a CRS identifier into a proj4-resolvable string. Accepts:
 * - a numeric EPSG code (`4326`, `102100`),
 * - an `"EPSG:xxxx"` string,
 * - a raw proj4/WKT definition string (passed through untouched).
 */
export function normalizeCrs(code: number | string): string {
  if (typeof code === "number") {
    return WEB_MERCATOR_ALIASES.has(code) ? "EPSG:3857" : `EPSG:${code}`;
  }
  const trimmed = code.trim();
  // A definition string (proj4 or WKT), not a code — hand it to proj4 as-is.
  if (trimmed.includes("+proj") || trimmed.includes("PROJCS") || trimmed.includes("GEOGCS")) {
    return trimmed;
  }
  const epsgMatch = /^epsg:(\d+)$/i.exec(trimmed);
  if (epsgMatch) {
    return normalizeCrs(Number(epsgMatch[1]));
  }
  return trimmed;
}

/**
 * Register a coordinate system so {@link project} (and the `toWgs84` /
 * `toWebMercator` fast paths) can resolve it. Idempotent; safe to call at app
 * startup or lazily before the first `project` call.
 *
 * @param code EPSG code or name to register the definition under.
 * @param proj4def A proj4 or WKT definition string.
 */
export function defineProjection(code: number | string, proj4def: string): void {
  proj4.defs(normalizeCrs(code), proj4def);
}

type Position = number[];

function projectPosition(position: Position, converter: proj4.Converter): Position {
  const [x, y, ...rest] = position;
  const projected = converter.forward([x, y]);
  return [projected[0], projected[1], ...rest];
}

function projectCoordinates(coordinates: unknown, converter: proj4.Converter): unknown {
  if (!Array.isArray(coordinates)) {
    return coordinates;
  }
  // A bare position is an array of finite numbers.
  if (typeof coordinates[0] === "number") {
    return projectPosition(coordinates as Position, converter);
  }
  return coordinates.map((entry) => projectCoordinates(entry, converter));
}

/**
 * Reproject a geometry from `fromCrs` to `toCrs`. CRS arguments accept EPSG
 * codes, `"EPSG:xxxx"` strings, or raw proj4 definitions. Returns a new
 * geometry; the input is never mutated. A no-op (deep clone) when the two CRS
 * resolve to the same definition.
 */
export function project(input: GeometryInput, fromCrs: number | string, toCrs: number | string): GeoJsonGeometry {
  const geometry = inputToGeometry(input);
  const from = normalizeCrs(fromCrs);
  const to = normalizeCrs(toCrs);
  if (from === to) {
    return structuredClone(geometry);
  }
  const converter = proj4(from, to);
  return {
    ...geometry,
    coordinates: projectCoordinates(geometry.coordinates, converter),
  } as GeoJsonGeometry;
}

/** Fast path: reproject a geometry from `fromCrs` into WGS84 (EPSG:4326). */
export function toWgs84(input: GeometryInput, fromCrs: number | string): GeoJsonGeometry {
  return project(input, fromCrs, "EPSG:4326");
}

/** Fast path: reproject a geometry from `fromCrs` into Web Mercator (EPSG:3857). */
export function toWebMercator(input: GeometryInput, fromCrs: number | string): GeoJsonGeometry {
  return project(input, fromCrs, "EPSG:3857");
}
