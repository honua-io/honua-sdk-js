/**
 * Internal, dependency-free helpers shared by the MapLibre source adapters:
 * canonical feature → GeoJSON conversion, geometry-kind classification, and
 * geometry-appropriate default paint. Not exported from the `/map` entrypoint.
 *
 * @module
 */

import type { HonuaTypedFeature } from "../core/types.js";
import { esriGeometryToGeoJson } from "./feature-service-adapter.js";
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
  if (Array.isArray(record.points)) return esriGeometryToGeoJson(record, "esriGeometryMultipoint");
  if (Array.isArray(record.paths)) return esriGeometryToGeoJson(record, "esriGeometryPolyline");
  if (Array.isArray(record.rings)) return esriGeometryToGeoJson(record, "esriGeometryPolygon");
  if ("xmin" in record && "ymin" in record && "xmax" in record && "ymax" in record) {
    return esriGeometryToGeoJson(record, "esriGeometryEnvelope");
  }
  return esriGeometryToGeoJson(record, "esriGeometryPoint");
}

/** Distinct geometry kinds present in a feature array, in point→line→polygon order. */
export function geometryKinds(features: readonly AdapterGeoJsonFeature[]): MapLibreGeometryKind[] {
  const kinds = new Set<MapLibreGeometryKind>();
  for (const feature of features) {
    const kind = geometryKind(feature.geometry);
    if (kind) kinds.add(kind);
  }
  const order: readonly MapLibreGeometryKind[] = ["point", "line", "polygon"];
  return order.filter((kind) => kinds.has(kind));
}

/** Classify one GeoJSON geometry into a coarse layer kind. */
export function geometryKind(geometry: AdapterGeoJsonGeometry | null): MapLibreGeometryKind | undefined {
  const type = geometry?.type;
  if (type === "Point" || type === "MultiPoint") return "point";
  if (type === "LineString" || type === "MultiLineString") return "line";
  if (type === "Polygon" || type === "MultiPolygon") return "polygon";
  return undefined;
}

export function isGeoJsonGeometryType(value: unknown): value is AdapterGeoJsonGeometry["type"] {
  return (
    value === "Point" ||
    value === "MultiPoint" ||
    value === "LineString" ||
    value === "MultiLineString" ||
    value === "Polygon" ||
    value === "MultiPolygon"
  );
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
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "-") start += 1;
  while (end > start && normalized[end - 1] === "-") end -= 1;
  const id = normalized.slice(start, end);
  return id || "source";
}

export function removeUndefined(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
}

function asAttributes(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}
