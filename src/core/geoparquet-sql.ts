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
 * rejected). {@link Query.where} is the one raw-text lane: it is caller-authored
 * DuckDB filter SQL, so it cannot be escaped like a value. It is instead
 * **contained** by {@link validateWhereExpression} before it is embedded — see
 * that function for the exact trust model.
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

// ── Query.where containment ───────────────────────────────────

/**
 * Fixed rejection codes emitted by {@link validateWhereExpression}. Codes are
 * stable and the thrown message never echoes the rejected text, so a hostile
 * `where` cannot smuggle content into logs or a UI error toast.
 */
export type GeoParquetWhereRejectionCode =
  | "GEOPARQUET_WHERE_NOT_TEXT"
  | "GEOPARQUET_WHERE_EMPTY"
  | "GEOPARQUET_WHERE_CONTROL_CHARACTER"
  | "GEOPARQUET_WHERE_UNTERMINATED_QUOTE"
  | "GEOPARQUET_WHERE_STATEMENT_SEPARATOR"
  | "GEOPARQUET_WHERE_COMMENT"
  | "GEOPARQUET_WHERE_UNBALANCED_PARENTHESES"
  | "GEOPARQUET_WHERE_PARAMETER_MARKER"
  | "GEOPARQUET_WHERE_ESCAPE_STRING"
  | "GEOPARQUET_WHERE_FORBIDDEN_KEYWORD";

/**
 * A `Query.where` expression was rejected before it could be embedded in
 * DuckDB SQL. Carries a fixed {@link GeoParquetWhereRejectionCode} rather than
 * the offending text.
 */
export class GeoParquetWhereClauseError extends Error {
  public readonly code: GeoParquetWhereRejectionCode;
  /** The denylisted keyword for `GEOPARQUET_WHERE_FORBIDDEN_KEYWORD`; never caller text otherwise. */
  public readonly keyword: string | undefined;

  public constructor(code: GeoParquetWhereRejectionCode, detail: string, keyword?: string) {
    super(`geoparquet: ${code}: ${detail}`);
    this.name = "GeoParquetWhereClauseError";
    this.code = code;
    this.keyword = keyword;
  }
}

/**
 * Keywords that would turn a filter expression into a statement, a set
 * operation, or a second table scan. They are rejected as bare words only:
 * a column genuinely named `union` or `select` stays addressable by quoting it
 * (`"union" = 1`), because quoted identifiers are skipped by the scanner.
 *
 * `FROM` is contextual: it is denied as a table context but allowed inside the
 * SQL-standard expression forms listed in {@link WHERE_EXPRESSION_FROM_HEADS}.
 */
const WHERE_FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set([
  "ABORT",
  "ALTER",
  "ANALYZE",
  "ATTACH",
  "BEGIN",
  "CALL",
  "CHECKPOINT",
  "COMMIT",
  "COPY",
  "CREATE",
  "DEALLOCATE",
  "DELETE",
  "DESCRIBE",
  "DETACH",
  "DROP",
  "EXCEPT",
  "EXECUTE",
  "EXPLAIN",
  "EXPORT",
  "FROM",
  "GRANT",
  "IMPORT",
  "INSERT",
  "INSTALL",
  "INTERSECT",
  "JOIN",
  "LATERAL",
  "LOAD",
  "MERGE",
  "PIVOT",
  "PRAGMA",
  "PREPARE",
  "REINDEX",
  "RESET",
  "REVOKE",
  "ROLLBACK",
  "SELECT",
  "SET",
  "START",
  "SUMMARIZE",
  "TRUNCATE",
  "UNION",
  "UNPIVOT",
  "UPDATE",
  "USE",
  "VACUUM",
  "VALUES",
  "WITH",
]);

/**
 * Function heads whose SQL-standard grammar uses `FROM` inside an expression:
 * `EXTRACT(YEAR FROM ts)`, `TRIM(BOTH ' ' FROM name)`,
 * `SUBSTRING(name FROM 2 FOR 3)`, `OVERLAY(a PLACING b FROM 2)`. A `FROM`
 * whose innermost enclosing parenthesis was opened by one of these is an
 * expression operand, not a table context. (`POSITION(a IN b)` spells its
 * separator `IN`, which is never denied.)
 */
const WHERE_EXPRESSION_FROM_HEADS: ReadonlySet<string> = new Set(["EXTRACT", "TRIM", "SUBSTRING", "OVERLAY"]);

// Tab / newline / carriage return are legitimate formatting in a multi-line
// filter; every other C0 control character and DEL is a smuggling vector.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars in caller SQL is the point
const WHERE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WHERE_WORD_START = /[\p{L}_]/u;
const WHERE_WORD_CHARACTER = /[\p{L}\p{N}_]/u;
// Sticky (not anchored-on-a-slice) so scanning stays linear in the input size.
const WHERE_DOLLAR_QUOTE = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** The `$tag$` dollar-quote delimiter starting exactly at `index`, if any. */
function dollarQuoteDelimiterAt(text: string, index: number): string | undefined {
  WHERE_DOLLAR_QUOTE.lastIndex = index;
  return WHERE_DOLLAR_QUOTE.exec(text)?.[0];
}

/**
 * Contain a caller-authored {@link Query.where} expression before it is
 * embedded in generated DuckDB SQL, returning the trimmed text on success.
 *
 * ## Trust model
 *
 * `where` is raw filter SQL — the GeoParquet/DuckDB lane has no value-escaping
 * equivalent for it, and the semantic (typed, parameterized) compiler in
 * `query-planner/duckdb.ts` is the path that removes the raw text entirely.
 * Until a caller migrates to that path, this validator draws the boundary:
 *
 * **Guaranteed by this function.** The accepted text is a *single* expression
 * that cannot leave the `WHERE ( … )` slot it is spliced into. It rejects, with
 * a typed {@link GeoParquetWhereClauseError}:
 *
 * - statement separators (`;`) and therefore chained/multi-statement input;
 * - SQL comments — both line (`--`) and block comment markers — including the
 *   trailing-comment trick that would otherwise swallow the compiler's own
 *   `AND (<spatial predicate>)`;
 * - unterminated string / quoted-identifier literals, which is how `x' OR 1=1`
 *   style probes escape a literal;
 * - `E'…'` escape strings, where a backslash escapes a quote: that second
 *   escaping grammar would let a literal end for this scanner but not for
 *   DuckDB, so every boundary after it is mis-parsed. Plain literals with
 *   doubled quotes carry the same data;
 * - unbalanced parentheses, so the wrapping `( … )` cannot be closed early to
 *   re-associate or append clauses;
 * - `SELECT` / `UNION` and other statement or set-operation keywords, plus a
 *   table-context `FROM`, so a filter cannot become a subquery or UNION probe
 *   that reads other tables or files registered in the same DuckDB session.
 *   `FROM` stays available in its expression forms — `EXTRACT(YEAR FROM ts)`,
 *   `TRIM(BOTH ' ' FROM name)`, `SUBSTRING(name FROM 2 FOR 3)`, `OVERLAY(…)`;
 * - parameter markers (`?`, `$1`, `$name`) — this lane binds no values;
 * - control characters other than tab / newline / carriage return.
 *
 * **Still the caller's responsibility.** This is containment, not a semantic
 * parser: accepted text is still executed by DuckDB. It can reference any
 * column in the scanned files, call any scalar function the session exposes,
 * and cost arbitrary CPU. Fabricating a syntactically invalid expression still
 * fails at DuckDB, not here. Applications that forward end-user input (a filter
 * box, a URL parameter) should build the expression from typed inputs rather
 * than concatenating strings, and treat this validator as a backstop.
 *
 * The `Source.protocol("geoparquet").sql(...)` handle remains an explicit,
 * opt-in raw-SQL escape hatch and is deliberately not covered here.
 */
export function validateWhereExpression(where: string): string {
  if (typeof where !== "string") {
    throw new GeoParquetWhereClauseError("GEOPARQUET_WHERE_NOT_TEXT", "where must be a string expression");
  }
  const text = where.trim();
  if (text.length === 0) {
    throw new GeoParquetWhereClauseError("GEOPARQUET_WHERE_EMPTY", "where must not be blank");
  }
  if (WHERE_CONTROL_CHARACTERS.test(text)) {
    throw new GeoParquetWhereClauseError(
      "GEOPARQUET_WHERE_CONTROL_CHARACTER",
      "where contains a control character outside tab/newline/carriage return",
    );
  }

  // One entry per open parenthesis, holding the function head that opened it
  // (`EXTRACT` for `EXTRACT(`), so a contextual `FROM` can be told apart from a
  // table context. Its length is the current nesting depth.
  const parenHeads: (string | undefined)[] = [];
  // The most recent bare word, still eligible to be the head of a `(` that
  // follows it across whitespace only.
  let pendingHead: string | undefined;
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    if (character === "'" || character === '"') {
      index = skipWhereQuotedToken(text, index, character);
      pendingHead = undefined;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiterAt(text, index);
      if (!delimiter) {
        throw new GeoParquetWhereClauseError(
          "GEOPARQUET_WHERE_PARAMETER_MARKER",
          "where must not contain a parameter marker; this lane binds no values",
        );
      }
      const end = text.indexOf(delimiter, index + delimiter.length);
      if (end === -1) {
        throw new GeoParquetWhereClauseError(
          "GEOPARQUET_WHERE_UNTERMINATED_QUOTE",
          "where contains an unterminated dollar-quoted literal",
        );
      }
      index = end + delimiter.length;
      pendingHead = undefined;
      continue;
    }
    if (character === "?") {
      throw new GeoParquetWhereClauseError(
        "GEOPARQUET_WHERE_PARAMETER_MARKER",
        "where must not contain a parameter marker; this lane binds no values",
      );
    }
    if (character === ";") {
      throw new GeoParquetWhereClauseError(
        "GEOPARQUET_WHERE_STATEMENT_SEPARATOR",
        "where must be one expression, not a statement sequence",
      );
    }
    if (
      (character === "-" && text[index + 1] === "-") ||
      (character === "/" && text[index + 1] === "*") ||
      (character === "*" && text[index + 1] === "/")
    ) {
      throw new GeoParquetWhereClauseError("GEOPARQUET_WHERE_COMMENT", "where must not contain a SQL comment");
    }
    if (character === "(") {
      parenHeads.push(pendingHead);
      pendingHead = undefined;
      index += 1;
      continue;
    }
    if (character === ")") {
      if (parenHeads.length === 0) {
        throw new GeoParquetWhereClauseError(
          "GEOPARQUET_WHERE_UNBALANCED_PARENTHESES",
          "where closes more parentheses than it opens",
        );
      }
      parenHeads.pop();
      pendingHead = undefined;
      index += 1;
      continue;
    }
    if (WHERE_WORD_START.test(character)) {
      let end = index + 1;
      while (end < text.length && WHERE_WORD_CHARACTER.test(text[end] as string)) end += 1;
      const word = text.slice(index, end).toUpperCase();
      // `E'…'` / `e'…'` escape strings give backslash its escaping power, so
      // `\'` would end the literal for this scanner but not for DuckDB. Refuse
      // the prefix rather than model a second escaping grammar.
      if (word === "E" && text[end] === "'") {
        throw new GeoParquetWhereClauseError(
          "GEOPARQUET_WHERE_ESCAPE_STRING",
          "where must not use an E-prefixed escape string; use a plain literal with doubled quotes",
        );
      }
      if (word === "FROM" && !WHERE_EXPRESSION_FROM_HEADS.has(parenHeads[parenHeads.length - 1] ?? "")) {
        throw new GeoParquetWhereClauseError(
          "GEOPARQUET_WHERE_FORBIDDEN_KEYWORD",
          "where must be a single boolean expression; a table-context FROM keyword is not addressable from a filter (FROM is allowed only inside EXTRACT/TRIM/SUBSTRING/OVERLAY)",
          word,
        );
      }
      if (word !== "FROM" && WHERE_FORBIDDEN_KEYWORDS.has(word)) {
        throw new GeoParquetWhereClauseError(
          "GEOPARQUET_WHERE_FORBIDDEN_KEYWORD",
          `where must be a single boolean expression; the ${word} keyword is not addressable from a filter (quote it to reference a column of that name)`,
          word,
        );
      }
      pendingHead = word;
      index = end;
      continue;
    }
    // Whitespace keeps a pending function head alive across `EXTRACT (…`.
    if (!(character === " " || character === "\t" || character === "\n" || character === "\r")) {
      pendingHead = undefined;
    }
    index += 1;
  }
  if (parenHeads.length !== 0) {
    throw new GeoParquetWhereClauseError("GEOPARQUET_WHERE_UNBALANCED_PARENTHESES", "where leaves a parenthesis open");
  }
  return text;
}

/**
 * Advance past a `'…'` string literal or a `"…"` quoted identifier, honouring
 * the SQL doubled-quote escape. Throws when the literal never closes.
 */
function skipWhereQuotedToken(text: string, start: number, quote: "'" | '"'): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] !== quote) {
      index += 1;
      continue;
    }
    if (text[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new GeoParquetWhereClauseError(
    "GEOPARQUET_WHERE_UNTERMINATED_QUOTE",
    quote === "'"
      ? "where contains an unterminated string literal"
      : "where contains an unterminated quoted identifier",
  );
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
 * - `geoarrow-point` / `geoarrow-linestring` / `geoarrow-polygon` /
 *   `geoarrow-multipoint` / `geoarrow-multilinestring` /
 *   `geoarrow-multipolygon`: GeoParquet **1.1** native single-geometry
 *   encodings (`geo.columns[].encoding`). DuckDB exposes these as nested
 *   `STRUCT`/`LIST` columns, not a `GEOMETRY` value — there is no DuckDB
 *   spatial expression for them. Geometry projection is decoded in JS by
 *   `@honua/sdk-js/geoparquet`'s native decoder (`native-geometry.ts`, built
 *   on `src/columnar/geoarrow.ts`); a spatial predicate against one of these
 *   columns requires a GeoParquet 1.1 bbox-covering column
 *   ({@link GeometryColumnPlan.bboxColumn}) and otherwise fails closed — see
 *   {@link geometryExpr}.
 */
export type GeometryEncoding =
  | "wkb"
  | "native"
  | "geojson"
  | "geoarrow-point"
  | "geoarrow-linestring"
  | "geoarrow-polygon"
  | "geoarrow-multipoint"
  | "geoarrow-multilinestring"
  | "geoarrow-multipolygon";

/** The `geoarrow-*` subset of {@link GeometryEncoding} (GeoParquet 1.1 native). */
export type GeoArrowNativeGeometryEncoding = Extract<GeometryEncoding, `geoarrow-${string}`>;

const GEOARROW_NATIVE_ENCODINGS: ReadonlySet<GeometryEncoding> = new Set<GeometryEncoding>([
  "geoarrow-point",
  "geoarrow-linestring",
  "geoarrow-polygon",
  "geoarrow-multipoint",
  "geoarrow-multilinestring",
  "geoarrow-multipolygon",
]);

/** True for a GeoParquet 1.1 native single-geometry encoding (see {@link GeometryEncoding}). */
export function isGeoArrowNativeEncoding(encoding: GeometryEncoding): encoding is GeoArrowNativeGeometryEncoding {
  return GEOARROW_NATIVE_ENCODINGS.has(encoding);
}

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
  /**
   * Coordinate dimensions physically stored by a `geoarrow-*` encoding.
   * Required (and only meaningful) when {@link encoding} is one of the
   * `geoarrow-*` values; GeoParquet 1.1 native encodings carry no `M`.
   */
  readonly nativeDimensions?: "xy" | "xyz";
}

/**
 * SQL expression that yields a DuckDB `GEOMETRY` from the stored geometry
 * column, adapting to the physical encoding.
 *
 * @throws for a `geoarrow-*` encoding — GeoParquet 1.1 native columns are
 *   nested `STRUCT`/`LIST` values with no DuckDB spatial-predicate
 *   expression. Callers must fail closed before constructing SQL rather than
 *   let a malformed `ST_Intersects(...)` reach DuckDB; use a bbox-covering
 *   column for spatial pushdown and the dedicated native decoder for
 *   geometry projection instead.
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
    case "geoarrow-point":
    case "geoarrow-linestring":
    case "geoarrow-polygon":
    case "geoarrow-multipoint":
    case "geoarrow-multilinestring":
    case "geoarrow-multipolygon":
      throw new Error(
        `geoparquet: column ${JSON.stringify(plan.column)} uses the GeoParquet 1.1 native "${plan.encoding.slice("geoarrow-".length)}" encoding, which DuckDB stores as a nested struct/list value with no spatial-predicate expression. Supply a bbox-covering column for spatialFilter pushdown; geometry projection is decoded separately from the raw column.`,
      );
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

/**
 * Assemble the `WHERE` fragment. A caller-authored `where` is contained by
 * {@link validateWhereExpression} first, so a hostile expression throws a
 * {@link GeoParquetWhereClauseError} here instead of reaching DuckDB.
 */
function whereClause(query: Query, spatial: string | undefined): string {
  const clauses: string[] = [];
  if (typeof query.where === "string" && query.where.trim().length > 0) {
    clauses.push(`(${validateWhereExpression(query.where)})`);
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
  // `geoarrow-*` columns are raw nested struct/list values, not a DuckDB
  // `GEOMETRY` — project them as-is and let the caller's native decoder
  // (built on src/columnar/geoarrow.ts) turn the materialized rows into
  // GeoJSON. Every other encoding keeps projecting `ST_AsGeoJSON(...)` text.
  const geomSelect = wantGeometry
    ? isGeoArrowNativeEncoding(geom.encoding)
      ? `${quoteIdentifier(geom.column)} AS ${geomAlias}`
      : `ST_AsGeoJSON(${geometryExpr(geom)}) AS ${geomAlias}`
    : undefined;

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
  const list = sources.map(stringLiteral);
  const arg = list.length === 1 ? list[0] : `[${list.join(", ")}]`;
  return `SELECT files.file_name, geo.value FROM parquet_file_metadata(${arg}) AS files LEFT JOIN parquet_kv_metadata(${arg}) AS geo ON geo.file_name = files.file_name AND decode(geo.key) = 'geo' ORDER BY files.file_name`;
}
