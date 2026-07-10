import { type HonuaFeature, esriGeometryToGeoJSON } from "@honua/sdk-js/honua";

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

/**
 * Convert a contract feature's Esri geometry into the quickstart GeoJSON shape.
 *
 * Conversion is delegated to the SDK's shared {@link esriGeometryToGeoJSON}
 * utility; this wrapper only narrows the SDK's `number[]` coordinates into the
 * `[number, number]` tuples the quickstart map code uses.
 */
function convertGeometry(geometry: HonuaFeature["geometry"]): QuickstartGeoJsonGeometry | null {
  const converted = esriGeometryToGeoJSON(geometry);
  if (!converted) {
    return null;
  }
  // The SDK emits GeoJSON with `number[]` positions; the quickstart map code
  // works with `[number, number]` tuples. The structures are identical at
  // runtime, so a single cast keeps the quickstart types intact.
  return converted as unknown as QuickstartGeoJsonGeometry;
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
