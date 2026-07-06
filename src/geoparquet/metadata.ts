/**
 * GeoParquet / Parquet-native geometry metadata detection. Turns the parquet
 * footer (DuckDB `DESCRIBE` rows + the GeoParquet `geo` key-value JSON) into a
 * {@link SourceProfile}: the geometry column plan, the CRS, the column list,
 * and a footer-based row estimate. Cached per source-URL set by the `Source`.
 *
 * @module
 */

import type { GeometryColumnPlan, GeometryEncoding } from "../core/geoparquet-sql.js";

export interface DescribeRow {
  readonly column_name: string;
  readonly column_type: string;
}

export interface SourceProfile {
  /** Every non-geometry column, in file order. */
  readonly columns: readonly string[];
  /** Geometry column plan, or `undefined` for a non-spatial (tabular) file. */
  readonly geometry?: GeometryColumnPlan;
  /** CRS identifier, best-effort (`OGC:CRS84`, an `EPSG:####`, or a name). */
  readonly crs?: string;
  /** Footer-derived row estimate (`num_rows` sum), when available. */
  readonly rowEstimate?: number;
}

/** Parsed subset of the GeoParquet `geo` metadata document. */
interface GeoMeta {
  version?: string;
  primary_column?: string;
  columns?: Record<
    string,
    {
      encoding?: string;
      crs?: unknown;
      covering?: { bbox?: { xmin?: unknown } };
    }
  >;
}

/**
 * Encoding is derived from the DuckDB DESCRIBE column type, not the GeoParquet
 * `geo.encoding` field. DuckDB's `read_parquet` rehydrates a GeoParquet WKB
 * column back into a native `GEOMETRY`, so the SQL expression must key off what
 * DuckDB actually hands back (`GEOMETRY` ⇒ use directly; `BLOB` ⇒
 * `ST_GeomFromWKB`; `JSON`/`VARCHAR` ⇒ `ST_GeomFromGeoJSON`).
 */
function encodingFromColumnType(type: string): GeometryEncoding {
  const t = type.toUpperCase();
  if (t.includes("GEOMETRY") || t.includes("GEOGRAPHY")) return "native";
  if (t.includes("BLOB") || t.includes("BYTEA") || t.includes("BINARY")) return "wkb";
  if (t.includes("JSON") || t.includes("VARCHAR") || t.includes("TEXT")) return "geojson";
  return "wkb";
}

/** Common geometry column names used to infer a column when there is no
 * GeoParquet metadata and no native GEOMETRY-typed column. */
const GEOMETRY_COLUMN_NAMES = new Set(["geometry", "geom", "the_geom", "wkb_geometry", "wkb", "geog"]);

/**
 * Extract a human-readable CRS id from a GeoParquet `crs` value, which may be a
 * PROJJSON object, a string, or absent (absent ⇒ the GeoParquet default
 * `OGC:CRS84`).
 */
function crsFromGeoMeta(crs: unknown): string {
  if (crs === null || crs === undefined) return "OGC:CRS84";
  if (typeof crs === "string") return crs;
  if (typeof crs === "object") {
    const obj = crs as Record<string, unknown>;
    const id = obj.id as { authority?: unknown; code?: unknown } | undefined;
    if (id && id.authority !== undefined && id.code !== undefined) {
      return `${String(id.authority)}:${String(id.code)}`;
    }
    if (typeof obj.name === "string") return obj.name;
  }
  return "OGC:CRS84";
}

function findBboxColumn(describe: readonly DescribeRow[], preferred?: string): string | undefined {
  const isBboxStruct = (row: DescribeRow) =>
    row.column_type.toUpperCase().startsWith("STRUCT") && /xmin/i.test(row.column_type);
  if (preferred) {
    const hit = describe.find((r) => r.column_name === preferred && isBboxStruct(r));
    if (hit) return hit.column_name;
  }
  const named = describe.find((r) => r.column_name.toLowerCase() === "bbox" && isBboxStruct(r));
  return named?.column_name;
}

export interface BuildProfileInput {
  readonly describe: readonly DescribeRow[];
  /** Raw `geo` metadata JSON string, if the file carried GeoParquet metadata. */
  readonly geoJson?: string;
  /** Explicit geometry column override from the descriptor. */
  readonly geometryColumnOverride?: string;
  /** Footer row estimate. */
  readonly rowEstimate?: number;
}

/**
 * Build a {@link SourceProfile} from a file's DESCRIBE rows and optional
 * GeoParquet `geo` metadata. Prefers GeoParquet metadata (the authoritative
 * source for encoding + CRS + bbox covering), then falls back to
 * Parquet-native `GEOMETRY`/`GEOGRAPHY` column types, then to an explicit
 * override.
 */
export function buildSourceProfile(input: BuildProfileInput): SourceProfile {
  const { describe, geoJson, geometryColumnOverride, rowEstimate } = input;
  const allColumns = describe.map((r) => r.column_name);

  let geometry: GeometryColumnPlan | undefined;
  let crs: string | undefined;

  let geo: GeoMeta | undefined;
  if (geoJson) {
    try {
      geo = JSON.parse(geoJson) as GeoMeta;
    } catch {
      geo = undefined;
    }
  }

  const rowFor = (name: string) => describe.find((r) => r.column_name === name);

  if (geo?.primary_column && rowFor(geo.primary_column)) {
    // GeoParquet metadata is authoritative for *which* column and the CRS; the
    // physical encoding still comes from the DuckDB column type.
    const primary = geo.primary_column;
    const colMeta = geo.columns?.[primary];
    const encoding = encodingFromColumnType(rowFor(primary)?.column_type ?? "");
    const bboxColumn = findBboxColumn(describe, colMeta?.covering?.bbox ? "bbox" : undefined);
    geometry = { column: primary, encoding, ...(bboxColumn ? { bboxColumn } : {}) };
    crs = crsFromGeoMeta(colMeta?.crs);
  } else {
    // No GeoParquet metadata: honor an explicit override, else look for a
    // Parquet-native GEOMETRY/GEOGRAPHY column, else fall back to a WKB/JSON
    // column with a conventional geometry name.
    const nativeRow = describe.find((r) => {
      const t = r.column_type.toUpperCase();
      return t.includes("GEOMETRY") || t.includes("GEOGRAPHY");
    });
    const heuristicRow = describe.find((r) => GEOMETRY_COLUMN_NAMES.has(r.column_name.toLowerCase()));
    const chosen = geometryColumnOverride ? rowFor(geometryColumnOverride) : (nativeRow ?? heuristicRow);
    if (chosen) {
      const encoding = encodingFromColumnType(chosen.column_type);
      const bboxColumn = findBboxColumn(describe);
      geometry = { column: chosen.column_name, encoding, ...(bboxColumn ? { bboxColumn } : {}) };
      crs = "OGC:CRS84";
    }
  }

  const geomColumn = geometry?.column;
  const bboxColumn = geometry?.bboxColumn;
  const columns = allColumns.filter((c) => c !== geomColumn && c !== bboxColumn);

  return {
    columns,
    ...(geometry ? { geometry } : {}),
    ...(crs ? { crs } : {}),
    ...(rowEstimate !== undefined ? { rowEstimate } : {}),
  };
}
