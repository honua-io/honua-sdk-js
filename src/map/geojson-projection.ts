/**
 * Internal, dependency-free helpers shared by the MapLibre source adapters:
 * canonical feature → GeoJSON conversion, geometry-kind classification, and
 * geometry-appropriate default paint. Not exported from the `/map` entrypoint.
 *
 * @module
 */

import type { HonuaTypedFeature } from "../core/types.js";
import type {
  AdapterGeoJsonFeature,
  AdapterGeoJsonFeatureCollection,
  AdapterGeoJsonGeometry,
} from "./feature-service-adapter.js";

/** Coarse geometry classification used to pick MapLibre layer types. */
export type MapLibreGeometryKind = "point" | "line" | "polygon";

/** Convert canonical features (GeoJSON or Esri JSON geometry) to GeoJSON. */
export function canonicalFeaturesToGeoJson<T>(
  features: readonly HonuaTypedFeature<T>[],
  primaryKey?: string,
): { data: AdapterGeoJsonFeatureCollection; unsupported: number } {
  let unsupported = 0;
  const converted = features.map((feature): AdapterGeoJsonFeature => {
    const geometry = toGeoJsonGeometry(feature.geometry);
    if (!geometry) unsupported += 1;
    const attributes = asAttributes(feature.attributes);
    const id = primaryKey ? attributes[primaryKey] : undefined;
    return {
      type: "Feature",
      ...(typeof id === "string" || typeof id === "number" ? { id } : {}),
      geometry,
      properties: attributes,
    };
  });
  return { data: { type: "FeatureCollection", features: converted }, unsupported };
}

/** Best-effort conversion of a canonical geometry value to GeoJSON. */
export function toGeoJsonGeometry(geometry: unknown): AdapterGeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  const record = geometry as Record<string, unknown>;
  if (isGeoJsonGeometryType(record.type) && "coordinates" in record) {
    return { type: record.type, coordinates: record.coordinates };
  }
  if (Array.isArray(record.points)) return { type: "MultiPoint", coordinates: coordinateArray(record.points) };
  if (Array.isArray(record.paths)) {
    const paths = record.paths.map(coordinateArray).filter(nonEmpty);
    return {
      type: paths.length === 1 ? "LineString" : "MultiLineString",
      coordinates: paths.length === 1 ? paths[0] : paths,
    };
  }
  if (Array.isArray(record.rings)) {
    return { type: "Polygon", coordinates: record.rings.map(coordinateArray).filter(nonEmpty) };
  }
  if ("xmin" in record && "ymin" in record && "xmax" in record && "ymax" in record) {
    const bounds = [record.xmin, record.ymin, record.xmax, record.ymax];
    if (bounds.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
    const [xmin, ymin, xmax, ymax] = bounds as number[];
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
  const point = coordinatePair([record.x, record.y]);
  return point ? { type: "Point", coordinates: point } : null;
}

/** Distinct geometry kinds present in a feature array, in point→line→polygon order. */
export function geometryKinds(features: readonly AdapterGeoJsonFeature[]): MapLibreGeometryKind[] {
  const kinds = new Set<MapLibreGeometryKind>();
  for (const feature of features) {
    const kind = geometryKind(feature.geometry);
    kind && kinds.add(kind);
  }
  return (["point", "line", "polygon"] as const).filter((kind) => kinds.has(kind));
}

/** Classify one GeoJSON geometry into a coarse layer kind. */
export function geometryKind(geometry: AdapterGeoJsonGeometry | null): MapLibreGeometryKind | undefined {
  return geometryTypeKind(geometry?.type);
}

export function isGeoJsonGeometryType(value: unknown): value is AdapterGeoJsonGeometry["type"] {
  return geometryTypeKind(value) !== undefined;
}

const GEOJSON_GEOMETRY_KINDS = {
  Point: "point",
  MultiPoint: "point",
  LineString: "line",
  MultiLineString: "line",
  Polygon: "polygon",
  MultiPolygon: "polygon",
} as const;

function geometryTypeKind(value: unknown): MapLibreGeometryKind | undefined {
  if (typeof value !== "string") return undefined;
  const kind = GEOJSON_GEOMETRY_KINDS[value as keyof typeof GEOJSON_GEOMETRY_KINDS];
  return typeof kind === "string" ? kind : undefined;
}

/** Geometry-appropriate default paint shared by the source adapters. */
export function defaultPaint(kind: MapLibreGeometryKind): Readonly<Record<string, unknown>> {
  if (kind === "point")
    return {
      "circle-color": "#16735b",
      "circle-radius": 6,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    };
  if (kind === "line") return { "line-color": "#16735b", "line-width": 2.5 };
  return { "fill-color": "#37a887", "fill-opacity": 0.55, "fill-outline-color": "#0e5643" };
}

/** Default paint for the dedicated polygon outline layer. */
export function defaultPolygonOutlinePaint(): Readonly<Record<string, unknown>> {
  return { "line-color": "#0e5643", "line-width": 1.5 };
}

export function layerType(kind: MapLibreGeometryKind): "circle" | "line" | "fill" {
  return kind === "point" ? "circle" : kind === "line" ? "line" : "fill";
}

export function mapLibreGeometryType(kind: MapLibreGeometryKind): "Point" | "LineString" | "Polygon" {
  return kind === "point" ? "Point" : kind === "line" ? "LineString" : "Polygon";
}

/** Normalize an arbitrary descriptor id into a safe MapLibre source id fragment. */
export function safeId(value: string): string {
  const id = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "source";
}

function asAttributes(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

function coordinatePair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) return undefined;
  return [value[0] as number, value[1] as number];
}

function coordinateArray(value: unknown): [number, number][] {
  return (Array.isArray(value) ? value : [])
    .map(coordinatePair)
    .filter((pair): pair is [number, number] => pair !== undefined);
}

function nonEmpty(value: readonly unknown[]): boolean {
  return value.length > 0;
}
