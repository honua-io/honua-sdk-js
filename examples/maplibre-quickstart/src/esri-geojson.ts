import type { HonuaFeature } from "@honua/sdk-js/honua";

export type QuickstartRenderableGeometryType = "point" | "line" | "polygon";
export type QuickstartPosition = [number, number];

export interface QuickstartBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface QuickstartGeoJsonPoint {
  type: "Point";
  coordinates: QuickstartPosition;
}

export interface QuickstartGeoJsonMultiPoint {
  type: "MultiPoint";
  coordinates: QuickstartPosition[];
}

export interface QuickstartGeoJsonLineString {
  type: "LineString";
  coordinates: QuickstartPosition[];
}

export interface QuickstartGeoJsonMultiLineString {
  type: "MultiLineString";
  coordinates: QuickstartPosition[][];
}

export interface QuickstartGeoJsonPolygon {
  type: "Polygon";
  coordinates: QuickstartPosition[][];
}

export interface QuickstartGeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: QuickstartPosition[][][];
}

export type QuickstartGeoJsonGeometry =
  | QuickstartGeoJsonPoint
  | QuickstartGeoJsonMultiPoint
  | QuickstartGeoJsonLineString
  | QuickstartGeoJsonMultiLineString
  | QuickstartGeoJsonPolygon
  | QuickstartGeoJsonMultiPolygon;

export interface QuickstartGeoJsonFeature {
  type: "Feature";
  id: string;
  geometry: QuickstartGeoJsonGeometry | null;
  properties: Record<string, unknown>;
}

export interface QuickstartGeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: QuickstartGeoJsonFeature[];
}

function asProperties(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value ?? {};
}

function readFeatureId(feature: HonuaFeature, index: number): string {
  const candidates = [
    feature.attributes.OBJECTID,
    feature.attributes.objectid,
    feature.attributes.id,
    feature.attributes.ID,
    index + 1,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return `feature-${index + 1}`;
}

function isFinitePosition(value: unknown): value is QuickstartPosition {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function collectFinitePositions(value: unknown): QuickstartPosition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isFinitePosition);
}

function collectPositionSets(value: unknown): QuickstartPosition[][] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => collectFinitePositions(entry)).filter((entry) => entry.length > 0);
}

function computeRingSignedArea(ring: readonly QuickstartPosition[]): number {
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

function isExteriorRing(ring: readonly QuickstartPosition[]): boolean {
  return computeRingSignedArea(ring) < 0;
}

function isPointOnSegment(
  point: QuickstartPosition,
  segmentStart: QuickstartPosition,
  segmentEnd: QuickstartPosition,
): boolean {
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

function isPointInsideRing(point: QuickstartPosition, ring: readonly QuickstartPosition[]): boolean {
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

function convertPolygonRings(
  rings: readonly QuickstartPosition[][],
): QuickstartGeoJsonPolygon | QuickstartGeoJsonMultiPolygon {
  const polygons: QuickstartPosition[][][] = [];
  const outerAreas: number[] = [];

  for (const ring of rings) {
    if (polygons.length < 1 || isExteriorRing(ring)) {
      polygons.push([ring]);
      outerAreas.push(Math.abs(computeRingSignedArea(ring)));
      continue;
    }

    const samplePoint = ring[0];
    if (!samplePoint) {
      continue;
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

function includeCoordinate(bounds: QuickstartBounds | undefined, coordinate: QuickstartPosition): QuickstartBounds {
  if (!bounds) {
    return {
      minX: coordinate[0],
      minY: coordinate[1],
      maxX: coordinate[0],
      maxY: coordinate[1],
    };
  }

  return {
    minX: Math.min(bounds.minX, coordinate[0]),
    minY: Math.min(bounds.minY, coordinate[1]),
    maxX: Math.max(bounds.maxX, coordinate[0]),
    maxY: Math.max(bounds.maxY, coordinate[1]),
  };
}

function scanCoordinates(bounds: QuickstartBounds | undefined, value: unknown): QuickstartBounds | undefined {
  if (isFinitePosition(value)) {
    return includeCoordinate(bounds, value);
  }
  if (!Array.isArray(value)) {
    return bounds;
  }

  let nextBounds = bounds;
  for (const entry of value) {
    nextBounds = scanCoordinates(nextBounds, entry);
  }
  return nextBounds;
}

export function mergeBounds(boundsList: readonly (QuickstartBounds | undefined)[]): QuickstartBounds | undefined {
  let merged: QuickstartBounds | undefined;
  for (const bounds of boundsList) {
    if (!bounds) {
      continue;
    }
    merged = includeCoordinate(merged, [bounds.minX, bounds.minY]);
    merged = includeCoordinate(merged, [bounds.maxX, bounds.maxY]);
  }
  return merged;
}

function convertGeometry(geometry: HonuaFeature["geometry"]): QuickstartGeoJsonGeometry | null {
  if (!geometry) {
    return null;
  }

  if ("x" in geometry && "y" in geometry && typeof geometry.x === "number" && typeof geometry.y === "number") {
    return {
      type: "Point",
      coordinates: [geometry.x, geometry.y],
    };
  }

  if ("points" in geometry && Array.isArray(geometry.points)) {
    const coordinates = collectFinitePositions(geometry.points);
    if (coordinates.length < 1) {
      return null;
    }

    return {
      type: "MultiPoint",
      coordinates,
    };
  }

  if ("paths" in geometry && Array.isArray(geometry.paths)) {
    const coordinates = collectPositionSets(geometry.paths);
    if (coordinates.length < 1) {
      return null;
    }

    return coordinates.length === 1
      ? {
          type: "LineString",
          coordinates: coordinates[0] ?? [],
        }
      : {
          type: "MultiLineString",
          coordinates,
        };
  }

  if ("rings" in geometry && Array.isArray(geometry.rings)) {
    const coordinates = collectPositionSets(geometry.rings);
    if (coordinates.length < 1) {
      return null;
    }

    return convertPolygonRings(coordinates);
  }

  if (
    "xmin" in geometry &&
    "ymin" in geometry &&
    "xmax" in geometry &&
    "ymax" in geometry &&
    typeof geometry.xmin === "number" &&
    typeof geometry.ymin === "number" &&
    typeof geometry.xmax === "number" &&
    typeof geometry.ymax === "number"
  ) {
    return {
      type: "Polygon",
      coordinates: [
        [
          [geometry.xmin, geometry.ymin],
          [geometry.xmax, geometry.ymin],
          [geometry.xmax, geometry.ymax],
          [geometry.xmin, geometry.ymax],
          [geometry.xmin, geometry.ymin],
        ],
      ],
    };
  }

  return null;
}

export function convertEsriFeaturesToGeoJson(
  features: readonly HonuaFeature[] = [],
): QuickstartGeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: features.map((feature, index) => ({
      type: "Feature",
      id: readFeatureId(feature, index),
      geometry: convertGeometry(feature.geometry),
      properties: asProperties(feature.attributes),
    })),
  };
}

export function getGeometryKind(
  geometry: QuickstartGeoJsonGeometry | null | undefined,
): QuickstartRenderableGeometryType | undefined {
  if (!geometry) {
    return undefined;
  }

  if (geometry.type === "Point" || geometry.type === "MultiPoint") {
    return "point";
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    return "line";
  }
  return "polygon";
}

export function summarizeRenderableGeometryTypes(
  collection: QuickstartGeoJsonFeatureCollection,
): QuickstartRenderableGeometryType[] {
  const geometryTypes = new Set<QuickstartRenderableGeometryType>();

  for (const feature of collection.features) {
    const kind = getGeometryKind(feature.geometry);
    if (kind) {
      geometryTypes.add(kind);
    }
  }

  return [...geometryTypes];
}

export function getGeometryBounds(
  geometry: QuickstartGeoJsonGeometry | null | undefined,
): QuickstartBounds | undefined {
  if (!geometry) {
    return undefined;
  }

  if (geometry.type === "Point") {
    return includeCoordinate(undefined, geometry.coordinates);
  }

  return scanCoordinates(undefined, geometry.coordinates);
}

export function getCollectionBounds(collection: QuickstartGeoJsonFeatureCollection): QuickstartBounds | undefined {
  return mergeBounds(collection.features.map((feature) => getGeometryBounds(feature.geometry)));
}

export function getFeatureCenter(feature: QuickstartGeoJsonFeature): QuickstartPosition | undefined {
  if (feature.geometry?.type === "Point") {
    return feature.geometry.coordinates;
  }

  const bounds = getGeometryBounds(feature.geometry);
  if (!bounds) {
    return undefined;
  }

  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

export function toMapLibreBounds(bounds: QuickstartBounds): [QuickstartPosition, QuickstartPosition] {
  return [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.maxY],
  ];
}
