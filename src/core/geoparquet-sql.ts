/**
 * Pure SQL compiler for the GeoParquet / DuckDB-WASM `Source`
 * (`@honua/sdk-js/geoparquet`). Translates the protocol-neutral
 * {@link Query} envelope into DuckDB SQL over `read_parquet(...)` with spatial
 * predicate pushdown.
 *
 * This module has **no runtime dependencies** (not even `@duckdb/duckdb-wasm`)
 * so it can be unit- and snapshot-tested in isolation and so the SQL text is a
 * pure function of its inputs. The heavy DuckDB orchestration lives in
 * `src/geoparquet/`.
 *
 * ## SQL-injection safety
 *
 * Every value this compiler interpolates is either (a) a numeric literal that
 * is validated to be a finite JS number and rendered with {@link numberLiteral},
 * (b) a string literal escaped by {@link stringLiteral} (single quotes doubled,
 * embedded NULs rejected), or (c) a SQL identifier escaped by
 * {@link quoteIdentifier} (double quotes doubled, embedded NULs / control chars
 * rejected). The one exception is {@link Query.where}: like the GeoServices and
 * OGC adapters, `where` is caller-authored filter SQL and is passed through
 * verbatim (wrapped in parentheses). Callers are responsible for the trust
 * boundary on `where`, exactly as they are for a GeoServices `where` clause.
 *
 * @module
 */

import type { AggregationFn, AggregationSpec, Query, SortSpec } from "../contract/types.js";
import type { SpatialFilter } from "./spatial-filter.js";

// ── Identifier / literal escaping ─────────────────────────────

/**
 * Quote a SQL identifier for DuckDB: wrap in double quotes and double any
 * embedded double quote. Rejects NUL and other control characters, which
 * cannot appear in a legitimate column name and are a classic smuggling
 * vector. Overture column names (`id`, `names`, `geometry`, dotted struct
 * paths accessed as whole columns) are all safe under this rule.
 */
export function quoteIdentifier(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`geoparquet: invalid SQL identifier ${JSON.stringify(name)}`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars in identifiers is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`geoparquet: SQL identifier contains control characters: ${JSON.stringify(name)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Render a string SQL literal (single quotes doubled). Rejects embedded NUL.
 */
export function stringLiteral(value: string): string {
  if (typeof value !== "string") {
    throw new Error(`geoparquet: expected a string literal, received ${typeof value}`);
  }
  if (value.includes("\u0000")) {
    throw new Error("geoparquet: string literal contains a NUL byte");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render a numeric SQL literal, validating the input is a finite JS number.
 * Non-finite values (NaN/Infinity) throw rather than emit `'NaN'` — a spatial
 * predicate must never silently widen to an infinite envelope.
 */
export function numberLiteral(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`geoparquet: expected a finite number, received ${String(value)}`);
  }
  return String(value);
}

/**
 * Render an integer SQL literal (offset / limit). Coerces via `Math.trunc` and
 * validates non-negative finiteness.
 */
export function integerLiteral(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`geoparquet: expected a non-negative integer, received ${String(value)}`);
  }
  return String(Math.trunc(value));
}

// ── read_parquet(...) source expression ───────────────────────

/**
 * Build the `read_parquet(...)` table expression from one or more file URLs /
 * globs. A single source renders `read_parquet('url')`; multiple sources
 * render `read_parquet(['a', 'b'])`. Every URL is escaped as a string literal.
 * `union_by_name := true` and `hive_partitioning := true` are set so mixed
 * schemas across a hive-partitioned Overture theme line up by column name.
 */
export function parquetSourceExpr(urls: readonly string[]): string {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("geoparquet: at least one parquet URL is required");
  }
  const list = urls.map(stringLiteral);
  const arg = list.length === 1 ? list[0] : `[${list.join(", ")}]`;
  return `read_parquet(${arg}, union_by_name = true, hive_partitioning = true)`;
}

// ── Geometry encoding strategy ────────────────────────────────

/**
 * How the geometry column is physically stored, which decides the SQL used to
 * (a) evaluate a spatial predicate and (b) project GeoJSON output.
 *
 * - `wkb`: GeoParquet 1.0/1.1 well-known-binary BLOB — wrap with
 *   `ST_GeomFromWKB(...)`.
 * - `native`: Parquet-native `GEOMETRY` / `GEOGRAPHY` logical type (Parquet
 *   2.11, Mar 2025) — DuckDB reads it as a `GEOMETRY`, used directly.
 * - `geojson`: GeoParquet `GeoJSON` encoding (string) — wrap with
 *   `ST_GeomFromGeoJSON(...)`.
 */
export type GeometryEncoding = "wkb" | "native" | "geojson";

export interface GeometryColumnPlan {
  /** Geometry column name in the parquet file. */
  readonly column: string;
  /** Physical encoding of that column. */
  readonly encoding: GeometryEncoding;
  /**
   * Optional GeoParquet 1.1 "bbox covering" struct column (typically `bbox`
   * with `xmin`/`ymin`/`xmax`/`ymax` fields). When present, an envelope filter
   * can prune row groups without decoding any geometry.
   */
  readonly bboxColumn?: string;
}

/**
 * SQL expression that yields a DuckDB `GEOMETRY` from the stored geometry
 * column, adapting to the physical encoding.
 */
export function geometryExpr(plan: GeometryColumnPlan): string {
  const col = quoteIdentifier(plan.column);
  switch (plan.encoding) {
    case "wkb":
      return `ST_GeomFromWKB(${col})`;
    case "geojson":
      return `ST_GeomFromGeoJSON(${col})`;
    case "native":
      return col;
  }
}

// ── Bounding box extraction ───────────────────────────────────

export interface BBox {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

/**
 * Reduce any Esri-shaped {@link SpatialFilter} geometry to its axis-aligned
 * bounding box. Envelopes are exact; points, polylines (`paths`), polygons
 * (`rings`), and multipoints (`points`) are reduced to their coordinate
 * bounds. Returns `undefined` when the geometry carries no usable coordinates.
 */
export function bboxFromSpatialFilter(filter: SpatialFilter): BBox | undefined {
  const g = filter.geometry as Record<string, unknown>;
  if (
    typeof g.xmin === "number" &&
    typeof g.ymin === "number" &&
    typeof g.xmax === "number" &&
    typeof g.ymax === "number"
  ) {
    return { xmin: g.xmin, ymin: g.ymin, xmax: g.xmax, ymax: g.ymax };
  }
  if (typeof g.x === "number" && typeof g.y === "number") {
    return { xmin: g.x, ymin: g.y, xmax: g.x, ymax: g.y };
  }
  const coordSets: unknown[] = [];
  if (Array.isArray(g.rings)) coordSets.push(...(g.rings as unknown[]));
  if (Array.isArray(g.paths)) coordSets.push(...(g.paths as unknown[]));
  if (Array.isArray(g.points)) coordSets.push(g.points);
  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const set of coordSets) {
    if (!Array.isArray(set)) continue;
    for (const pt of set as unknown[]) {
      if (!Array.isArray(pt) || typeof pt[0] !== "number" || typeof pt[1] !== "number") continue;
      seen = true;
      xmin = Math.min(xmin, pt[0]);
      ymin = Math.min(ymin, pt[1]);
      xmax = Math.max(xmax, pt[0]);
      ymax = Math.max(ymax, pt[1]);
    }
  }
  return seen ? { xmin, ymin, xmax, ymax } : undefined;
}

/**
 * True when the spatial filter is a plain envelope (exact bbox intersection).
 * Anything else is reduced to its bbox and is therefore an approximation the
 * caller should be told about via a `degraded` reason.
 */
export function isEnvelopeFilter(filter: SpatialFilter): boolean {
  return filter.geometryType === "esriGeometryEnvelope";
}

/**
 * Compile the spatial predicate for a bbox against a geometry plan. Prefers the
 * GeoParquet 1.1 bbox-covering column (row-group-skippable) when present, then
 * falls back to `ST_Intersects(<geom>, ST_MakeEnvelope(...))`.
 */
export function spatialPredicate(bbox: BBox, plan: GeometryColumnPlan): string {
  const xmin = numberLiteral(bbox.xmin);
  const ymin = numberLiteral(bbox.ymin);
  const xmax = numberLiteral(bbox.xmax);
  const ymax = numberLiteral(bbox.ymax);
  if (plan.bboxColumn) {
    const b = quoteIdentifier(plan.bboxColumn);
    // Two envelopes intersect iff neither is strictly to one side of the other.
    return `${b}.xmin <= ${xmax} AND ${b}.xmax >= ${xmin} AND ` + `${b}.ymin <= ${ymax} AND ${b}.ymax >= ${ymin}`;
  }
  return `ST_Intersects(${geometryExpr(plan)}, ST_MakeEnvelope(${xmin}, ${ymin}, ${xmax}, ${ymax}))`;
}

// ── Compile options ───────────────────────────────────────────

export interface CompileOptions {
  /** Parquet file URL(s) / glob(s). */
  readonly sources: readonly string[];
  /** Geometry column plan (from metadata detection), if the file is spatial. */
  readonly geometry?: GeometryColumnPlan;
  /**
   * All non-geometry column names available in the file, used to expand a
   * `returnGeometry`-only projection and to validate that requested
   * `outFields` are addressable. When omitted, `*` (minus geometry) is used.
   */
  readonly columns?: readonly string[];
  /** Output alias for the projected GeoJSON geometry. Defaults to `geometry`. */
  readonly geometryAlias?: string;
}

const DEFAULT_GEOMETRY_ALIAS = "geometry";

// ── WHERE + ORDER BY + LIMIT fragments ────────────────────────

function whereClause(query: Query, spatial: string | undefined): string {
  const clauses: string[] = [];
  if (typeof query.where === "string" && query.where.trim().length > 0) {
    clauses.push(`(${query.where})`);
  }
  if (spatial) clauses.push(`(${spatial})`);
  return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function orderByClause(orderBy: readonly SortSpec[] | undefined): string {
  if (!orderBy || orderBy.length === 0) return "";
  const parts = orderBy.map((s) => {
    const dir = s.direction === "desc" ? " DESC" : " ASC";
    return `${quoteIdentifier(s.field)}${dir}`;
  });
  return ` ORDER BY ${parts.join(", ")}`;
}

function limitOffsetClause(query: Query): string {
  let out = "";
  const limit = query.pagination?.limit;
  const offset = query.pagination?.offset;
  if (typeof limit === "number") out += ` LIMIT ${integerLiteral(limit)}`;
  if (typeof offset === "number" && offset > 0) out += ` OFFSET ${integerLiteral(offset)}`;
  return out;
}

// ── Projection ────────────────────────────────────────────────

function projection(query: Query, options: CompileOptions): string {
  const geom = options.geometry;
  const geomAlias = quoteIdentifier(options.geometryAlias ?? DEFAULT_GEOMETRY_ALIAS);
  const wantGeometry = query.returnGeometry !== false && geom !== undefined;
  const geomSelect = wantGeometry ? `ST_AsGeoJSON(${geometryExpr(geom)}) AS ${geomAlias}` : undefined;

  const outFields = query.outFields;
  if (outFields && outFields.length > 0) {
    const cols = outFields.filter((f) => !geom || f !== geom.column).map((f) => quoteIdentifier(f));
    if (geomSelect) cols.push(geomSelect);
    return cols.length > 0 ? cols.join(", ") : "*";
  }

  // No explicit projection: select every non-geometry column, plus the
  // GeoJSON-projected geometry when requested. When we do not know the column
  // list, fall back to `* EXCLUDE (geom)` so raw WKB never rides along.
  const nonGeom = options.columns?.filter((c) => !geom || c !== geom.column);
  if (nonGeom && nonGeom.length > 0) {
    const cols = nonGeom.map((c) => quoteIdentifier(c));
    if (geomSelect) cols.push(geomSelect);
    return cols.join(", ");
  }
  if (geom) {
    const base = `* EXCLUDE (${quoteIdentifier(geom.column)})`;
    return geomSelect ? `${base}, ${geomSelect}` : base;
  }
  return "*";
}

// ── Public compile entry points ───────────────────────────────

export interface CompiledSql {
  readonly sql: string;
  /** True when a non-envelope spatial filter was reduced to its bbox. */
  readonly bboxApproximated: boolean;
}

/**
 * Compile a feature {@link Query} into a DuckDB `SELECT`. The geometry column,
 * when present and `returnGeometry !== false`, is projected as GeoJSON text via
 * `ST_AsGeoJSON` under the alias `geometry` (overridable).
 */
export function compileQuery(query: Query, options: CompileOptions): CompiledSql {
  const from = parquetSourceExpr(options.sources);
  let spatial: string | undefined;
  let bboxApproximated = false;
  if (query.spatialFilter) {
    if (!options.geometry) {
      throw new Error("geoparquet: spatialFilter supplied but the source has no detected geometry column");
    }
    const bbox = bboxFromSpatialFilter(query.spatialFilter);
    if (bbox) {
      spatial = spatialPredicate(bbox, options.geometry);
      bboxApproximated = !isEnvelopeFilter(query.spatialFilter);
    }
  }
  const sql = `SELECT ${projection(query, options)} FROM ${from}${whereClause(query, spatial)}${orderByClause(query.orderBy)}${limitOffsetClause(query)}`;
  return { sql, bboxApproximated };
}

function aggregateFn(fn: AggregationFn, field: string): string {
  const col = field === "*" ? "*" : quoteIdentifier(field);
  switch (fn) {
    case "count":
      return `count(${col})`;
    case "sum":
      return `sum(${col})`;
    case "avg":
      return `avg(${col})`;
    case "min":
      return `min(${col})`;
    case "max":
      return `max(${col})`;
    case "stddev":
      return `stddev_samp(${col})`;
    case "var":
      return `var_samp(${col})`;
  }
}

/**
 * Compile an {@link AggregationSpec} into a GROUP BY `SELECT`. Group-by fields
 * are echoed in the projection (so the returned rows carry the group key),
 * followed by each metric expression aliased to its `alias` (or `fn_field`).
 */
export function compileAggregate(
  query: Query & { aggregation: AggregationSpec },
  options: CompileOptions,
): CompiledSql {
  const from = parquetSourceExpr(options.sources);
  const agg = query.aggregation;
  if (!agg.metrics || agg.metrics.length === 0) {
    throw new Error("geoparquet: aggregation requires at least one metric");
  }
  const groupBy = agg.groupBy ?? [];
  const selectParts: string[] = [];
  for (const field of groupBy) selectParts.push(quoteIdentifier(field));
  for (const m of agg.metrics) {
    const alias = quoteIdentifier(m.alias ?? `${m.fn}_${m.field === "*" ? "all" : m.field}`);
    selectParts.push(`${aggregateFn(m.fn, m.field)} AS ${alias}`);
  }

  let spatial: string | undefined;
  let bboxApproximated = false;
  if (query.spatialFilter && options.geometry) {
    const bbox = bboxFromSpatialFilter(query.spatialFilter);
    if (bbox) {
      spatial = spatialPredicate(bbox, options.geometry);
      bboxApproximated = !isEnvelopeFilter(query.spatialFilter);
    }
  }

  const groupByClause = groupBy.length > 0 ? ` GROUP BY ${groupBy.map((f) => quoteIdentifier(f)).join(", ")}` : "";
  const sql = `SELECT ${selectParts.join(", ")} FROM ${from}${whereClause(query, spatial)}${groupByClause}${orderByClause(query.orderBy)}${limitOffsetClause(query)}`;
  return { sql, bboxApproximated };
}

/**
 * SQL that reads the parquet footer schema without scanning rows.
 */
export function describeSql(sources: readonly string[]): string {
  return `DESCRIBE SELECT * FROM ${parquetSourceExpr(sources)}`;
}

/**
 * Cheap row-count estimate from the parquet footer (`num_rows` per row group),
 * summed across all files. Avoids a full `count(*)` table scan on large
 * Overture extracts.
 */
export function rowEstimateSql(sources: readonly string[]): string {
  const list = sources.map(stringLiteral);
  const arg = list.length === 1 ? list[0] : `[${list.join(", ")}]`;
  return `SELECT CAST(COALESCE(sum(num_rows), 0) AS BIGINT) AS row_estimate FROM parquet_file_metadata(${arg})`;
}

/**
 * SQL that reads the GeoParquet `geo` key-value metadata (the JSON blob that
 * carries `primary_column`, per-column `encoding`, and `crs`). Returns zero
 * rows for Parquet-native geometry files, which carry no `geo` metadata.
 */
export function geoMetadataSql(sources: readonly string[]): string {
  const first = stringLiteral(sources[0] ?? "");
  return `SELECT value FROM parquet_kv_metadata(${first}) WHERE decode(key) = 'geo'`;
}
