/**
 * Geometry classification for the Kepler bridge.
 *
 * Esri-JSON to GeoJSON conversion is delegated to the repository's canonical
 * converter (`src/core/esri-geojson.ts`), which groups clockwise exterior rings
 * into a `MultiPolygon` and rewinds every ring to the RFC 7946 right-hand rule.
 * A local reimplementation emitted a single `Polygon`, which silently turned
 * later exterior rings into holes of the first. The canonical module is
 * dependency-free (its only imports are type-only), so reusing it costs the
 * `/kepler` bundle nothing beyond its own code — unlike the MapLibre adapters'
 * converter, which sits on the `HonuaClient`/`HonuaFeatureLayer` graph.
 *
 * What stays local is only what the ingestion mapping itself needs: "is this
 * geometry a single point?" (direct lon/lat columns, no GeoJSON) and the
 * pass-through for geometry that already arrived as GeoJSON.
 *
 * @experimental
 * @module
 */

import { esriGeometryToGeoJSON } from "../core/esri-geojson.js";

export interface KeplerGeoJsonGeometry {
  readonly type: string;
  readonly coordinates: unknown;
}

const GEOJSON_GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  "LineString",
  "MultiLineString",
  "MultiPoint",
  "MultiPolygon",
  "Point",
  "Polygon",
]);

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coordinatePair(value: unknown): readonly [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const x = finite(value[0]);
  const y = finite(value[1]);
  return x === undefined || y === undefined ? undefined : [x, y];
}

/**
 * Longitude/latitude of a single-point geometry, or `undefined` when the
 * geometry is absent, multi-vertex, or unrecognized. Accepts Esri `{x, y}` and
 * GeoJSON `Point`.
 */
export function pointCoordinates(geometry: unknown): readonly [number, number] | undefined {
  if (!geometry || typeof geometry !== "object") return undefined;
  const record = geometry as Record<string, unknown>;
  if (record["type"] === "Point") return coordinatePair(record["coordinates"]);
  const x = finite(record["x"]);
  const y = finite(record["y"]);
  return x === undefined || y === undefined ? undefined : [x, y];
}

/**
 * Convert a canonical Honua geometry (GeoJSON or Esri JSON) into GeoJSON.
 * Returns `null` for absent or unrecognized geometry so the row still projects
 * attribute-only.
 *
 * Geometry that already arrived as GeoJSON passes through untouched; Esri-JSON
 * is delegated to {@link esriGeometryToGeoJSON}, so multi-exterior-ring
 * polygons become a `MultiPolygon` (not one `Polygon` whose later exterior
 * rings are misread as holes) and every ring is rewound to the RFC 7946
 * right-hand rule Kepler's GeoJSON layer expects.
 */
export function toKeplerGeoJsonGeometry(geometry: unknown): KeplerGeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  const record = geometry as Record<string, unknown>;
  const declaredType = record["type"];
  if (typeof declaredType === "string" && GEOJSON_GEOMETRY_TYPES.has(declaredType) && "coordinates" in record) {
    return { type: declaredType, coordinates: record["coordinates"] };
  }
  return esriGeometryToGeoJSON(record);
}

/** UTF-8 byte length of a JSON value, used as the GeoJSON round-trip metric. */
export function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 0;
  let bytes = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.codePointAt(index) as number;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}
