/**
 * Curated, tree-shakeable wrappers over the individual `@turf/*` packages,
 * typed against the SDK's GeoJSON contract.
 *
 * Each function wraps exactly one turf package so a consumer importing a single
 * op (e.g. `import { buffer } from "@honua/geometry"`) only pulls that op's turf
 * dependency into their bundle. Nothing here is reimplemented — the algorithms
 * live in turf; this module only adapts types and defaults.
 *
 * All turf area/length/buffer math is **geodesic** (great-circle on a sphere)
 * and assumes coordinates are WGS84 longitude/latitude degrees, matching turf's
 * contract. See `docs/geometry.md` for the planar-vs-geodesic caveats that
 * matter when bridging Esri geometries.
 *
 * @module
 */

import { area as turfArea } from "@turf/area";
import { bbox as turfBbox } from "@turf/bbox";
import { booleanContains as turfBooleanContains } from "@turf/boolean-contains";
import { booleanIntersects as turfBooleanIntersects } from "@turf/boolean-intersects";
import { booleanWithin as turfBooleanWithin } from "@turf/boolean-within";
import { buffer as turfBuffer } from "@turf/buffer";
import { centroid as turfCentroid } from "@turf/centroid";
import { convex as turfConvex } from "@turf/convex";
import { difference as turfDifference } from "@turf/difference";
import type { Units as TurfUnits } from "@turf/helpers";
import { intersect as turfIntersect } from "@turf/intersect";
import { length as turfLength } from "@turf/length";
import { nearestPoint as turfNearestPoint } from "@turf/nearest-point";
import { simplify as turfSimplify } from "@turf/simplify";
import { union as turfUnion } from "@turf/union";

import type {
  Feature as TurfFeature,
  FeatureCollection as TurfFeatureCollection,
  MultiPolygon as TurfMultiPolygon,
  Point as TurfPoint,
  Polygon as TurfPolygon,
} from "geojson";

import type { GeoJsonFeature } from "../core/types.js";
import type { GeoJsonGeometry, GeoJsonPoint } from "../expr/expression.js";
import { fromTurfFeature, fromTurfGeometry, inputToGeometry, toTurfGeometry, toTurfInput } from "./internal.js";
import type { GeometryInput, LinearUnit } from "./types.js";

// `Units` is a turf-local alias (from `@turf/helpers`). Our LinearUnit is a
// subset, so a cast at the boundary is sound.
type Unit = TurfUnits;

function toPolygonFeatureCollection(
  inputs: readonly GeometryInput[],
): TurfFeatureCollection<TurfPolygon | TurfMultiPolygon> {
  return {
    type: "FeatureCollection",
    features: inputs.map((input) => ({
      type: "Feature",
      properties: {},
      geometry: toTurfGeometry(inputToGeometry(input)) as TurfPolygon | TurfMultiPolygon,
    })),
  };
}

/**
 * Buffer a geometry by `radius` (default unit: meters). Wraps `@turf/buffer`.
 * Returns `null` when turf cannot produce a buffer (e.g. an empty geometry).
 */
export function buffer(input: GeometryInput, radius: number, unit: LinearUnit = "meters"): GeoJsonGeometry | null {
  // A single Feature/Geometry input yields a single buffered Feature (never a
  // collection), so the return narrows to `Feature | undefined`.
  const feature: TurfFeature = {
    type: "Feature",
    properties: {},
    geometry: toTurfGeometry(inputToGeometry(input)),
  };
  const result = turfBuffer(feature, radius, { units: unit as Unit });
  return result?.geometry ? fromTurfGeometry(result.geometry) : null;
}

/** Geodesic area of a polygonal geometry in square meters. Wraps `@turf/area`. */
export function area(input: GeometryInput): number {
  return turfArea(toTurfInput(input));
}

/**
 * Geodesic length of a line (or polygon perimeter) in `unit` (default meters).
 * Wraps `@turf/length`.
 */
export function length(input: GeometryInput, unit: LinearUnit = "meters"): number {
  return turfLength(toTurfInput(input) as TurfFeature, { units: unit as Unit });
}

/** Centroid of a geometry as a GeoJSON `Point`. Wraps `@turf/centroid`. */
export function centroid(input: GeometryInput): GeoJsonPoint {
  return fromTurfGeometry(turfCentroid(toTurfInput(input)).geometry) as GeoJsonPoint;
}

/** Bounding box `[minX, minY, maxX, maxY]` of a geometry. Wraps `@turf/bbox`. */
export function bbox(input: GeometryInput): [number, number, number, number] {
  const [minX, minY, maxX, maxY] = turfBbox(toTurfInput(input));
  return [minX, minY, maxX, maxY];
}

/**
 * Ramer–Douglas–Peucker simplification. `tolerance` is in the geometry's
 * coordinate units; `highQuality` trades speed for fidelity. Wraps
 * `@turf/simplify`.
 */
export function simplify(input: GeometryInput, tolerance: number, highQuality = false): GeoJsonGeometry {
  const geometry = toTurfGeometry(inputToGeometry(input));
  const simplified = turfSimplify(geometry, { tolerance, highQuality, mutate: false });
  return fromTurfGeometry(simplified);
}

/** True if `a` and `b` share any point. Wraps `@turf/boolean-intersects`. */
export function booleanIntersects(a: GeometryInput, b: GeometryInput): boolean {
  return turfBooleanIntersects(toTurfGeometry(inputToGeometry(a)), toTurfGeometry(inputToGeometry(b)));
}

/** True if `a` completely contains `b`. Wraps `@turf/boolean-contains`. */
export function booleanContains(a: GeometryInput, b: GeometryInput): boolean {
  return turfBooleanContains(toTurfGeometry(inputToGeometry(a)), toTurfGeometry(inputToGeometry(b)));
}

/** True if `a` is completely within `b`. Wraps `@turf/boolean-within`. */
export function booleanWithin(a: GeometryInput, b: GeometryInput): boolean {
  return turfBooleanWithin(toTurfGeometry(inputToGeometry(a)), toTurfGeometry(inputToGeometry(b)));
}

/**
 * Polygon union of two or more polygonal geometries. Wraps `@turf/union`.
 * Returns `null` when the inputs do not combine into a polygon.
 */
export function union(...polygons: readonly GeometryInput[]): GeoJsonGeometry | null {
  if (polygons.length === 0) {
    return null;
  }
  const result = turfUnion(toPolygonFeatureCollection(polygons));
  return result?.geometry ? fromTurfGeometry(result.geometry) : null;
}

/**
 * Polygon intersection of two polygonal geometries. Wraps `@turf/intersect`.
 * Returns `null` when the polygons do not overlap.
 */
export function intersect(a: GeometryInput, b: GeometryInput): GeoJsonGeometry | null {
  const result = turfIntersect(toPolygonFeatureCollection([a, b]));
  return result?.geometry ? fromTurfGeometry(result.geometry) : null;
}

/**
 * Polygon difference `a − b`. Wraps `@turf/difference`. Returns `null` when the
 * subtraction removes the whole polygon.
 */
export function difference(a: GeometryInput, b: GeometryInput): GeoJsonGeometry | null {
  const result = turfDifference(toPolygonFeatureCollection([a, b]));
  return result?.geometry ? fromTurfGeometry(result.geometry) : null;
}

/** Convex hull of a geometry. Wraps `@turf/convex`. Returns `null` if undefined. */
export function convex(input: GeometryInput): GeoJsonGeometry | null {
  const result = turfConvex(toTurfInput(input) as TurfFeature);
  return result?.geometry ? fromTurfGeometry(result.geometry) : null;
}

/**
 * Nearest point in `points` to `target`, as a GeoJSON `Feature<Point>` carrying
 * turf's `featureIndex` / `distanceToPoint` properties. Wraps
 * `@turf/nearest-point`.
 */
export function nearestPoint(target: GeoJsonPoint, points: readonly GeoJsonPoint[]): GeoJsonFeature {
  const collection: TurfFeatureCollection<TurfPoint> = {
    type: "FeatureCollection",
    features: points.map((point) => ({
      type: "Feature",
      properties: {},
      geometry: toTurfGeometry(point) as TurfPoint,
    })),
  };
  const nearest = turfNearestPoint(toTurfGeometry(target) as TurfPoint, collection);
  return fromTurfFeature(nearest as unknown as TurfFeature);
}
