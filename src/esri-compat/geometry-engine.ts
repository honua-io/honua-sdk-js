/**
 * `geometryEngine` compatibility shim, backed by `@honua/geometry` (curated
 * `@turf/*` + `proj4`).
 *
 * This provides drop-in replacements for the subset of
 * `@arcgis/core/geometry/geometryEngine` operations that map onto turf:
 * `buffer`, `intersect`, `union`, `difference`, `geodesicArea` / `planarArea`,
 * `geodesicLength` / `planarLength`, `simplify`, `convexHull`, `contains`, and
 * `intersects`. Inputs may be plain Esri-JSON geometries or Honua compat
 * geometry instances (`PointCompat`, `PolygonCompat`, …) that expose `toJSON()`.
 *
 * Semantic caveats (see `docs/geometry.md` for the full matrix):
 * - turf area/length/buffer are **geodesic** (great-circle). The `planar*`
 *   variants here are computed directly in the geometry's native coordinate
 *   plane, matching Esri's planar contract only when that CRS is projected
 *   (e.g. Web Mercator).
 * - `geodesic*` operations reproject the geometry to WGS84 before measuring.
 * - `simplify` performs topological normalization (ring rewinding via the
 *   Esri↔GeoJSON round-trip), not vertex reduction; use
 *   `@honua/geometry`'s `simplify(geometry, tolerance)` for RDP thinning.
 * - Uncovered `geometryEngine` operations (geodesic densify, offset, cut,
 *   generalize, …) are intentionally not shimmed; the migration codemod keeps
 *   its manual-intervention warning for those call sites.
 *
 * @module
 */

import { esriGeometryToGeoJSON, geoJsonToEsriGeometry } from "../core/esri-geojson.js";
import type { EsriGeometry, HonuaSpatialReference } from "../core/types.js";
import type { GeoJsonGeometry } from "../expr/expression.js";
import {
  booleanContains,
  booleanIntersects,
  buffer as bufferOp,
  convex,
  difference as differenceOp,
  area as geodesicAreaOp,
  length as geodesicLengthOp,
  intersect as intersectOp,
  project,
  union as unionOp,
} from "../geometry/index.js";
import type { LinearUnit } from "../geometry/index.js";

/** Anything geometry-shaped the shim accepts: Esri JSON or a compat instance. */
export type GeometryEngineInput = EsriGeometry | { toJSON(): unknown } | Record<string, unknown> | null | undefined;

/** Esri linear unit strings accepted by the length/buffer operations. */
export type EsriLinearUnit = "meters" | "feet" | "kilometers" | "miles" | "nautical-miles" | "yards" | "us-feet";

/** Esri areal unit strings accepted by the area operations. */
export type EsriAreaUnit =
  | "square-meters"
  | "square-kilometers"
  | "square-feet"
  | "square-miles"
  | "square-yards"
  | "acres"
  | "hectares";

const LINEAR_UNIT_METERS: Readonly<Record<EsriLinearUnit, number>> = {
  meters: 1,
  feet: 0.3048,
  "us-feet": 1200 / 3937,
  kilometers: 1000,
  miles: 1609.344,
  "nautical-miles": 1852,
  yards: 0.9144,
};

const AREA_UNIT_SQUARE_METERS: Readonly<Record<EsriAreaUnit, number>> = {
  "square-meters": 1,
  "square-kilometers": 1_000_000,
  "square-feet": 0.09290304,
  "square-miles": 2_589_988.110336,
  "square-yards": 0.83612736,
  acres: 4046.8564224,
  hectares: 10_000,
};

const ESRI_TO_TURF_LINEAR: Readonly<Partial<Record<EsriLinearUnit, LinearUnit>>> = {
  meters: "meters",
  kilometers: "kilometers",
  miles: "miles",
  yards: "yards",
  feet: "feet",
  "nautical-miles": "nauticalmiles",
};

function resolveEsriGeometry(input: GeometryEngineInput): EsriGeometry | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof (input as { toJSON?: unknown }).toJSON === "function") {
    return (input as { toJSON(): EsriGeometry }).toJSON();
  }
  return input as EsriGeometry;
}

function readSpatialReference(geometry: EsriGeometry | null): HonuaSpatialReference | undefined {
  const sr = (geometry as { spatialReference?: HonuaSpatialReference } | null)?.spatialReference;
  return sr && typeof sr === "object" ? sr : undefined;
}

/** Esri Web Mercator well-known ids (3857 and its ArcGIS aliases). */
function isWebMercator(sr: HonuaSpatialReference | undefined): boolean {
  const wkid = sr?.latestWkid ?? sr?.wkid;
  return wkid === 3857 || wkid === 102100 || wkid === 102113 || wkid === 900913 || wkid === 3785;
}

/** Resolve the native EPSG code of a geometry (defaults to WGS84). */
function nativeCrs(sr: HonuaSpatialReference | undefined): number {
  if (isWebMercator(sr)) {
    return 3857;
  }
  return sr?.latestWkid ?? sr?.wkid ?? 4326;
}

function toGeoJson(input: GeometryEngineInput): { geometry: GeoJsonGeometry; sr: HonuaSpatialReference | undefined } {
  const esri = resolveEsriGeometry(input);
  const geometry = esriGeometryToGeoJSON(esri);
  if (!geometry) {
    throw new TypeError("geometryEngineCompat: input is not a valid geometry");
  }
  return { geometry, sr: readSpatialReference(esri) };
}

function toEsri(geometry: GeoJsonGeometry | null, sr: HonuaSpatialReference | undefined): EsriGeometry | null {
  return geometry ? geoJsonToEsriGeometry(geometry, sr) : null;
}

// ── Measurement ──────────────────────────────────────────────────

/** Geodesic (great-circle) area, reprojecting to WGS84 first. */
export function geodesicArea(input: GeometryEngineInput, unit: EsriAreaUnit = "square-meters"): number {
  const { geometry, sr } = toGeoJson(input);
  const wgs84 = project(geometry, nativeCrs(sr), 4326);
  const squareMeters = geodesicAreaOp(wgs84);
  return squareMeters / AREA_UNIT_SQUARE_METERS[unit];
}

/** Planar area in the geometry's native coordinate plane (shoelace). */
export function planarArea(input: GeometryEngineInput, unit: EsriAreaUnit = "square-meters"): number {
  const { geometry } = toGeoJson(input);
  const squareMeters = planarAreaSquareMeters(geometry);
  return squareMeters / AREA_UNIT_SQUARE_METERS[unit];
}

/** Geodesic (great-circle) length, reprojecting to WGS84 first. */
export function geodesicLength(input: GeometryEngineInput, unit: EsriLinearUnit = "meters"): number {
  const { geometry, sr } = toGeoJson(input);
  const wgs84 = project(geometry, nativeCrs(sr), 4326);
  const meters = geodesicLengthOp(wgs84, "meters");
  return meters / LINEAR_UNIT_METERS[unit];
}

/** Planar length/perimeter in the geometry's native coordinate plane. */
export function planarLength(input: GeometryEngineInput, unit: EsriLinearUnit = "meters"): number {
  const { geometry } = toGeoJson(input);
  const meters = planarLengthMeters(geometry);
  return meters / LINEAR_UNIT_METERS[unit];
}

function planarLengthMeters(geometry: GeoJsonGeometry): number {
  const lineDistance = (line: number[][]): number => {
    let total = 0;
    for (let i = 1; i < line.length; i += 1) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      total += Math.hypot(x1 - x0, y1 - y0);
    }
    return total;
  };
  switch (geometry.type) {
    case "LineString":
      return lineDistance(geometry.coordinates);
    case "MultiLineString":
      return geometry.coordinates.reduce((sum, line) => sum + lineDistance(line), 0);
    case "Polygon":
      return geometry.coordinates.reduce((sum, ring) => sum + lineDistance(ring), 0);
    case "MultiPolygon":
      return geometry.coordinates.reduce(
        (sum, polygon) => sum + polygon.reduce((s, ring) => s + lineDistance(ring), 0),
        0,
      );
    default:
      return 0;
  }
}

function ringArea(ring: number[][]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}

function polygonArea(rings: number[][][]): number {
  return rings.reduce((sum, ring, index) => (index === 0 ? sum + ringArea(ring) : sum - ringArea(ring)), 0);
}

function planarAreaSquareMeters(geometry: GeoJsonGeometry): number {
  switch (geometry.type) {
    case "Polygon":
      return polygonArea(geometry.coordinates);
    case "MultiPolygon":
      return geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
    default:
      return 0;
  }
}

// ── Constructive geometry ────────────────────────────────────────

/**
 * Buffer a geometry by `distance` in `unit`. Backed by geodesic `@turf/buffer`
 * (reprojected through WGS84), which differs from Esri's planar `buffer`; use
 * this where a `geometryEngine.geodesicBuffer`-equivalent result is acceptable.
 */
export function buffer(
  input: GeometryEngineInput,
  distance: number,
  unit: EsriLinearUnit = "meters",
): EsriGeometry | null {
  const { geometry, sr } = toGeoJson(input);
  const turfUnit = ESRI_TO_TURF_LINEAR[unit];
  // Fall back to meters via manual scaling for units turf does not name.
  const crs = nativeCrs(sr);
  const wgs84 = project(geometry, crs, 4326);
  const buffered = turfUnit
    ? bufferOp(wgs84, distance, turfUnit)
    : bufferOp(wgs84, distance * LINEAR_UNIT_METERS[unit], "meters");
  if (!buffered) {
    return null;
  }
  return toEsri(project(buffered, 4326, crs), sr);
}

/** Union of two or more geometries. Backed by `@turf/union`. */
export function union(inputs: readonly GeometryEngineInput[]): EsriGeometry | null {
  if (inputs.length === 0) {
    return null;
  }
  const resolved = inputs.map((input) => toGeoJson(input));
  const sr = resolved[0]?.sr;
  const merged = unionOp(...resolved.map((entry) => entry.geometry));
  return toEsri(merged, sr);
}

/** Intersection of two geometries. Backed by `@turf/intersect`. */
export function intersect(input: GeometryEngineInput, intersector: GeometryEngineInput): EsriGeometry | null {
  const a = toGeoJson(input);
  const b = toGeoJson(intersector);
  return toEsri(intersectOp(a.geometry, b.geometry), a.sr);
}

/** Difference `input − subtractor`. Backed by `@turf/difference`. */
export function difference(input: GeometryEngineInput, subtractor: GeometryEngineInput): EsriGeometry | null {
  const a = toGeoJson(input);
  const b = toGeoJson(subtractor);
  return toEsri(differenceOp(a.geometry, b.geometry), a.sr);
}

/**
 * Topologically normalize a geometry (rewind rings to a valid orientation via
 * the Esri↔GeoJSON round-trip). This mirrors `geometryEngine.simplify`'s intent
 * of producing a topologically valid geometry rather than reducing vertices.
 */
export function simplify(input: GeometryEngineInput): EsriGeometry | null {
  const { geometry, sr } = toGeoJson(input);
  return toEsri(geometry, sr);
}

/** Convex hull of a geometry. Backed by `@turf/convex`. */
export function convexHull(input: GeometryEngineInput): EsriGeometry | null {
  const { geometry, sr } = toGeoJson(input);
  return toEsri(convex(geometry), sr);
}

// ── Predicates ───────────────────────────────────────────────────

/** True if `container` completely contains `inside`. Backed by `@turf/boolean-contains`. */
export function contains(container: GeometryEngineInput, inside: GeometryEngineInput): boolean {
  return booleanContains(toGeoJson(container).geometry, toGeoJson(inside).geometry);
}

/** True if `a` and `b` intersect. Backed by `@turf/boolean-intersects`. */
export function intersects(a: GeometryEngineInput, b: GeometryEngineInput): boolean {
  return booleanIntersects(toGeoJson(a).geometry, toGeoJson(b).geometry);
}

/**
 * The synchronous `geometryEngine` compat surface — a namespace object shaped
 * like `@arcgis/core/geometry/geometryEngine`. The migration codemod rewrites
 * `import geometryEngine from "@arcgis/core/geometry/geometryEngine"` to import
 * this object.
 */
export const geometryEngineCompat = {
  buffer,
  intersect,
  union,
  difference,
  geodesicArea,
  planarArea,
  geodesicLength,
  planarLength,
  simplify,
  convexHull,
  contains,
  intersects,
} as const;

/**
 * The asynchronous `geometryEngineAsync` compat surface: the same operations,
 * each returning a `Promise`. Mirrors
 * `@arcgis/core/geometry/geometryEngineAsync`.
 */
export const geometryEngineAsyncCompat = {
  buffer: (input: GeometryEngineInput, distance: number, unit?: EsriLinearUnit) =>
    Promise.resolve(buffer(input, distance, unit)),
  intersect: (input: GeometryEngineInput, intersector: GeometryEngineInput) =>
    Promise.resolve(intersect(input, intersector)),
  union: (inputs: readonly GeometryEngineInput[]) => Promise.resolve(union(inputs)),
  difference: (input: GeometryEngineInput, subtractor: GeometryEngineInput) =>
    Promise.resolve(difference(input, subtractor)),
  geodesicArea: (input: GeometryEngineInput, unit?: EsriAreaUnit) => Promise.resolve(geodesicArea(input, unit)),
  planarArea: (input: GeometryEngineInput, unit?: EsriAreaUnit) => Promise.resolve(planarArea(input, unit)),
  geodesicLength: (input: GeometryEngineInput, unit?: EsriLinearUnit) => Promise.resolve(geodesicLength(input, unit)),
  planarLength: (input: GeometryEngineInput, unit?: EsriLinearUnit) => Promise.resolve(planarLength(input, unit)),
  simplify: (input: GeometryEngineInput) => Promise.resolve(simplify(input)),
  convexHull: (input: GeometryEngineInput) => Promise.resolve(convexHull(input)),
  contains: (container: GeometryEngineInput, inside: GeometryEngineInput) =>
    Promise.resolve(contains(container, inside)),
  intersects: (a: GeometryEngineInput, b: GeometryEngineInput) => Promise.resolve(intersects(a, b)),
} as const;
