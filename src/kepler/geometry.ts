/**
 * Dependency-free geometry classification for the Kepler bridge.
 *
 * The MapLibre adapters' converter (`src/map/geojson-projection.ts`) sits on
 * the `HonuaClient`/`HonuaFeatureLayer` graph, which the `/kepler` bundle
 * budget forbids. This module therefore keeps a minimal, self-contained
 * classifier whose only job is to answer two questions the ingestion mapping
 * needs: "is this geometry a single point?" (direct lon/lat columns, no GeoJSON)
 * and "what GeoJSON geometry does it become?" (the measured fallback).
 *
 * @experimental
 * @module
 */

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

function coordinateArray(value: unknown): Array<readonly [number, number]> {
  if (!Array.isArray(value)) return [];
  const output: Array<readonly [number, number]> = [];
  for (const entry of value) {
    const pair = coordinatePair(entry);
    if (pair) output.push(pair);
  }
  return output;
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
 */
export function toKeplerGeoJsonGeometry(geometry: unknown): KeplerGeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  const record = geometry as Record<string, unknown>;
  const declaredType = record["type"];
  if (typeof declaredType === "string" && GEOJSON_GEOMETRY_TYPES.has(declaredType) && "coordinates" in record) {
    return { type: declaredType, coordinates: record["coordinates"] };
  }
  const point = pointCoordinates(record);
  if (point) return { type: "Point", coordinates: [point[0], point[1]] };
  if (Array.isArray(record["points"])) {
    return { type: "MultiPoint", coordinates: coordinateArray(record["points"]) };
  }
  if (Array.isArray(record["paths"])) {
    const paths = (record["paths"] as unknown[]).map(coordinateArray).filter((path) => path.length > 0);
    if (paths.length === 0) return null;
    return paths.length === 1
      ? { type: "LineString", coordinates: paths[0] }
      : { type: "MultiLineString", coordinates: paths };
  }
  if (Array.isArray(record["rings"])) {
    const rings = (record["rings"] as unknown[]).map(coordinateArray).filter((ring) => ring.length > 0);
    return rings.length === 0 ? null : { type: "Polygon", coordinates: rings };
  }
  const xmin = finite(record["xmin"]);
  const ymin = finite(record["ymin"]);
  const xmax = finite(record["xmax"]);
  const ymax = finite(record["ymax"]);
  if (xmin !== undefined && ymin !== undefined && xmax !== undefined && ymax !== undefined) {
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
