/**
 * Convert Esri-JSON geometry (as returned by `queryFeatures` and contract
 * {@link HonuaFeature} results) into standard GeoJSON geometry.
 *
 * Esri encodes geometry as `{ x, y }` points, `{ paths }` polylines,
 * `{ rings }` polygons, `{ points }` multipoints, and `{ xmin, ymin, xmax,
 * ymax }` envelopes. GeoJSON consumers (MapLibre, Leaflet, turf, etc.) expect
 * `Point` / `LineString` / `Polygon` and their `Multi*` variants. This module
 * provides that translation as a first-class, dependency-free utility.
 *
 * Polygon rings are grouped following the Esri convention where clockwise
 * (positive signed area) rings are exterior and counter-clockwise rings are
 * holes, producing `Polygon` for a single exterior ring and `MultiPolygon`
 * when several exterior rings are present.
 *
 * @module
 */

import type {
  GeoJsonGeometry,
  GeoJsonMultiLineString,
  GeoJsonMultiPolygon,
  GeoJsonPolygon,
} from "../expr/expression.js";
import type { EsriGeometry, GeoJsonFeature, HonuaFeature } from "./types.js";

type Position = [number, number, ...number[]];

function isFinitePosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function collectFinitePositions(value: unknown): Position[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isFinitePosition);
}

function collectPositionSets(value: unknown): Position[][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => collectFinitePositions(entry)).filter((entry) => entry.length > 0);
}

function computeRingSignedArea(ring: readonly Position[]): number {
  if (ring.length < 3) {
    return 0;
  }

  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    if (!current || !next) {
      continue;
    }
    area += current[0] * next[1] - next[0] * current[1];
  }

  return area / 2;
}

/**
 * Esri uses clockwise (negative signed area in screen/standard math
 * orientation) rings for exterior boundaries and counter-clockwise rings for
 * holes.
 */
function isExteriorRing(ring: readonly Position[]): boolean {
  return computeRingSignedArea(ring) < 0;
}

function isPointOnSegment(point: Position, segmentStart: Position, segmentEnd: Position): boolean {
  const epsilon = 1e-9;
  const crossProduct =
    (point[0] - segmentStart[0]) * (segmentEnd[1] - segmentStart[1]) -
    (point[1] - segmentStart[1]) * (segmentEnd[0] - segmentStart[0]);

  if (Math.abs(crossProduct) > epsilon) {
    return false;
  }

  const dotProduct =
    (point[0] - segmentStart[0]) * (segmentEnd[0] - segmentStart[0]) +
    (point[1] - segmentStart[1]) * (segmentEnd[1] - segmentStart[1]);
  if (dotProduct < -epsilon) {
    return false;
  }

  const segmentLengthSquared =
    (segmentEnd[0] - segmentStart[0]) * (segmentEnd[0] - segmentStart[0]) +
    (segmentEnd[1] - segmentStart[1]) * (segmentEnd[1] - segmentStart[1]);

  return dotProduct - segmentLengthSquared <= epsilon;
}

function isPointInsideRing(point: Position, ring: readonly Position[]): boolean {
  if (ring.length < 3) {
    return false;
  }

  let isInside = false;
  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const current = ring[index];
    const previous = ring[previousIndex];
    if (!current || !previous) {
      continue;
    }

    if (isPointOnSegment(point, previous, current)) {
      return true;
    }

    const intersects =
      current[1] > point[1] !== previous[1] > point[1] &&
      point[0] < ((previous[0] - current[0]) * (point[1] - current[1])) / (previous[1] - current[1]) + current[0];
    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

function findContainingPolygonIndex(
  polygons: readonly Position[][][],
  outerAreas: readonly number[],
  ring: readonly Position[],
): number {
  const samplePoint = ring[0];
  if (!samplePoint) {
    return -1;
  }

  let containingPolygonIndex = -1;
  let smallestContainingArea = Number.POSITIVE_INFINITY;

  for (let index = 0; index < polygons.length; index += 1) {
    const polygon = polygons[index];
    const outerRing = polygon?.[0];
    const outerArea = outerAreas[index];
    if (!outerRing || outerArea === undefined || !isPointInsideRing(samplePoint, outerRing)) {
      continue;
    }

    if (outerArea < smallestContainingArea) {
      smallestContainingArea = outerArea;
      containingPolygonIndex = index;
    }
  }

  return containingPolygonIndex;
}

function convertPolygonRings(rings: readonly Position[][]): GeoJsonPolygon | GeoJsonMultiPolygon {
  const polygons: Position[][][] = [];
  const outerAreas: number[] = [];
  const interiorRings: Position[][] = [];

  for (const ring of rings) {
    if (isExteriorRing(ring)) {
      polygons.push([ring]);
      outerAreas.push(Math.abs(computeRingSignedArea(ring)));
      continue;
    }

    interiorRings.push(ring);
  }

  for (const ring of interiorRings) {
    const containingPolygonIndex = findContainingPolygonIndex(polygons, outerAreas, ring);

    if (containingPolygonIndex < 0) {
      polygons.push([ring]);
      outerAreas.push(Math.abs(computeRingSignedArea(ring)));
      continue;
    }

    polygons[containingPolygonIndex]?.push(ring);
  }

  return polygons.length === 1
    ? {
        type: "Polygon",
        coordinates: polygons[0] ?? [],
      }
    : {
        type: "MultiPolygon",
        coordinates: polygons,
      };
}

function hasNumber(geometry: Record<string, unknown>, key: string): boolean {
  return typeof geometry[key] === "number" && Number.isFinite(geometry[key]);
}

/**
 * Convert a single Esri-JSON geometry into a GeoJSON geometry.
 *
 * Supports Esri point (`{ x, y }`), multipoint (`{ points }`), polyline
 * (`{ paths }`), polygon (`{ rings }`), and envelope (`{ xmin, ymin, xmax,
 * ymax }`) shapes. Returns `null` for `null`/`undefined` input and for
 * geometries that contain no finite coordinates (e.g. empty `rings`/`paths`).
 *
 * @param geometry Esri geometry, the `geometry` field of a {@link HonuaFeature},
 *   or `null`/`undefined`.
 * @returns The equivalent GeoJSON geometry, or `null` when the input is empty
 *   or unrecognized.
 */
export function esriGeometryToGeoJSON(
  geometry: EsriGeometry | Record<string, unknown> | null | undefined,
): GeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") {
    return null;
  }

  const candidate = geometry as Record<string, unknown>;

  if (hasNumber(candidate, "x") && hasNumber(candidate, "y")) {
    return {
      type: "Point",
      coordinates: [candidate.x as number, candidate.y as number],
    };
  }

  if (Array.isArray(candidate.points)) {
    const coordinates = collectFinitePositions(candidate.points);
    if (coordinates.length < 1) {
      return null;
    }
    return {
      type: "MultiPoint",
      coordinates,
    };
  }

  if (Array.isArray(candidate.paths)) {
    const coordinates = collectPositionSets(candidate.paths);
    if (coordinates.length < 1) {
      return null;
    }
    return coordinates.length === 1
      ? {
          type: "LineString",
          coordinates: coordinates[0] ?? [],
        }
      : ({
          type: "MultiLineString",
          coordinates,
        } satisfies GeoJsonMultiLineString);
  }

  if (Array.isArray(candidate.rings)) {
    const coordinates = collectPositionSets(candidate.rings);
    if (coordinates.length < 1) {
      return null;
    }
    return convertPolygonRings(coordinates);
  }

  if (
    hasNumber(candidate, "xmin") &&
    hasNumber(candidate, "ymin") &&
    hasNumber(candidate, "xmax") &&
    hasNumber(candidate, "ymax")
  ) {
    const xmin = candidate.xmin as number;
    const ymin = candidate.ymin as number;
    const xmax = candidate.xmax as number;
    const ymax = candidate.ymax as number;
    return {
      type: "Polygon",
      coordinates: [
        [
          [xmin, ymin],
          [xmax, ymin],
          [xmax, ymax],
          [xmin, ymax],
          [xmin, ymin],
        ],
      ],
    };
  }

  return null;
}

function readFeatureId(feature: HonuaFeature): string | number | undefined {
  const attributes = feature.attributes ?? {};
  const candidates = [attributes.OBJECTID, attributes.objectid, attributes.id, attributes.ID, attributes.FID];

  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

/**
 * Convert a contract {@link HonuaFeature} (Esri attributes + geometry) into a
 * GeoJSON `Feature`.
 *
 * The feature `id` is derived from common Esri identifier attributes
 * (`OBJECTID`, `objectid`, `id`, `ID`, `FID`) when present, and the geometry is
 * converted with {@link esriGeometryToGeoJSON} (yielding `null` for missing or
 * empty geometry).
 *
 * @param feature A contract feature with Esri-shaped `attributes` and
 *   `geometry`.
 * @returns The equivalent GeoJSON feature.
 */
export function esriFeatureToGeoJSON(feature: HonuaFeature): GeoJsonFeature {
  const id = readFeatureId(feature);
  return {
    type: "Feature",
    ...(id === undefined ? {} : { id }),
    geometry: esriGeometryToGeoJSON(feature.geometry),
    properties: feature.attributes ?? {},
  };
}
