/**
 * GeoParquet **1.1** native single-geometry column decoders.
 *
 * GeoParquet 1.1 (see `geo.columns[].encoding` in the file's key-value
 * metadata) allows a geometry column to be stored as a nested Arrow-style
 * `point` / `linestring` / `polygon` / `multipoint` / `multilinestring` /
 * `multipolygon` layout instead of WKB. DuckDB's `read_parquet` surfaces
 * these as ordinary nested `STRUCT`/`LIST` columns (`STRUCT(x DOUBLE, y
 * DOUBLE)`, `STRUCT(...)[]`, `STRUCT(...)[][]`, ...) with no `GEOMETRY`
 * value and therefore no `ST_*` spatial expression — see
 * `src/core/geoparquet-sql.ts`'s `geoarrow-*` {@link GeometryEncoding}
 * variants and `geometryExpr`.
 *
 * This module decodes those materialized rows (already turned into plain JS
 * values by the DuckDB driver's Arrow `.toJSON()`) into GeoJSON geometries.
 * It deliberately does **not** re-implement bounded geometry validation:
 * every position/vertex/ring bound, ring-closure rule, finite-coordinate
 * check, and dimension-ordering rule is enforced by
 * `src/columnar/geoarrow.ts`'s `createGeoArrowBatch` / `decodeGeoArrowBatch`
 * pair, which this module calls directly. GeoParquet's `point`, `linestring`,
 * and `polygon` encodings map 1:1 onto the identically-named GeoArrow kinds;
 * `multipoint` reuses the `linestring` pipeline (a flat list of positions),
 * `multilinestring` reuses the `polygon` pipeline (a list of position
 * lists), and `multipolygon` — one nesting level deeper than GeoArrow's
 * `polygon` kind supports — is decoded by flattening every row's polygon
 * parts into one synthetic `polygon` column, running the same reviewed
 * pipeline once, and regrouping the results by row.
 *
 * @module
 */

import {
  type ColumnarBatchIdentityV1,
  type ColumnarOrderingV1,
  type CreateGeoArrowBatchInput,
  type CreatedGeoArrowBatch,
  type DecodedGeoArrowRow,
  type GeoArrowConversionLimits,
  type GeoArrowCrs,
  type GeoArrowFeatureIdColumnInput,
  type GeoArrowGeometryColumnInput,
  type GeoArrowLineString,
  type GeoArrowPoint,
  type GeoArrowPolygon,
  type GeoArrowPosition,
  HonuaGeoArrowError,
  createGeoArrowBatch,
  decodeGeoArrowBatch,
} from "../columnar/index.js";

/** The `geo.columns[].encoding` values GeoParquet 1.1 defines beyond `WKB`. */
export type GeoParquetNativeGeometryKind =
  | "point"
  | "linestring"
  | "polygon"
  | "multipoint"
  | "multilinestring"
  | "multipolygon";

/** GeoParquet 1.1 native encodings carry `x`, `y`, and an optional `z` — never `m`. */
export type GeoParquetNativeDimensions = "xy" | "xyz";

export type GeoParquetNativeGeometryErrorCode =
  | "GEOPARQUET_NATIVE_UNSUPPORTED_DIMENSIONS"
  | "GEOPARQUET_NATIVE_INVALID_VALUE"
  | "GEOPARQUET_NATIVE_ROW_LIMIT_EXCEEDED"
  | "GEOPARQUET_NATIVE_VERTEX_LIMIT_EXCEEDED"
  | "GEOPARQUET_NATIVE_RING_LIMIT_EXCEEDED"
  | "GEOPARQUET_NATIVE_PART_LIMIT_EXCEEDED"
  /** A multi-part encoding was asked to produce a batch; GeoArrow has no multi-part kind here. */
  | "GEOPARQUET_COLUMNAR_UNSUPPORTED_ENCODING"
  /** The plan's ordering contract names a field the batch does not carry. */
  | "GEOPARQUET_COLUMNAR_ORDERING_FIELD_UNAVAILABLE";

/** A redacted, fixed-code failure decoding a GeoParquet 1.1 native geometry column. */
export class GeoParquetNativeGeometryError extends Error {
  public readonly code: GeoParquetNativeGeometryErrorCode;
  public readonly path: string;
  public readonly detail?: Readonly<Record<string, unknown>>;

  public constructor(
    code: GeoParquetNativeGeometryErrorCode,
    path: string,
    detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`geoparquet: ${code} at ${path}`, options);
    this.name = "GeoParquetNativeGeometryError";
    this.code = code;
    this.path = path;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface GeoParquetNativeGeometryLimits {
  /** Forwarded to `createGeoArrowBatch`/`decodeGeoArrowBatch`; bounds total vertices decoded. */
  readonly maxVertices?: number;
  /** Forwarded to `createGeoArrowBatch`/`decodeGeoArrowBatch`; bounds total rings decoded. */
  readonly maxRings?: number;
  /** Bounds the flattened polygon-part count when decoding `multipolygon`. */
  readonly maxParts?: number;
}

/** Point/LineString/Polygon/MultiPoint/MultiLineString/MultiPolygon in RFC 7946 coordinate order. */
export type GeoParquetNativeGeoJsonGeometry =
  | { readonly type: "Point"; readonly coordinates: readonly number[] }
  | { readonly type: "LineString"; readonly coordinates: readonly (readonly number[])[] }
  | { readonly type: "Polygon"; readonly coordinates: readonly (readonly (readonly number[])[])[] }
  | { readonly type: "MultiPoint"; readonly coordinates: readonly (readonly number[])[] }
  | { readonly type: "MultiLineString"; readonly coordinates: readonly (readonly (readonly number[])[])[] }
  | { readonly type: "MultiPolygon"; readonly coordinates: readonly (readonly (readonly (readonly number[])[])[])[] };

const DEFAULT_MAX_PARTS = 2_000_000;

function fail(
  code: GeoParquetNativeGeometryErrorCode,
  path: string,
  detail?: Readonly<Record<string, unknown>>,
): never {
  throw new GeoParquetNativeGeometryError(code, path, detail);
}

/**
 * Read one `{x, y[, z]}` struct (DuckDB's materialization of a GeoParquet
 * native coordinate) into a GeoArrow-ordered position. Fails closed on
 * anything but a plain, finite-numbered struct with exactly the declared
 * dimensions — this is the hostile-input boundary for depth/shape mismatches
 * arriving from an untrusted parquet file.
 */
function readCoordinate(value: unknown, dimensions: GeoParquetNativeDimensions, path: string): GeoArrowPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("GEOPARQUET_NATIVE_INVALID_VALUE", path, { reason: "expected a coordinate struct" });
  }
  const record = value as Record<string, unknown>;
  const x = record.x;
  const y = record.y;
  if (typeof x !== "number" || !Number.isFinite(x)) {
    fail("GEOPARQUET_NATIVE_INVALID_VALUE", `${path}.x`, { reason: "expected a finite number" });
  }
  if (typeof y !== "number" || !Number.isFinite(y)) {
    fail("GEOPARQUET_NATIVE_INVALID_VALUE", `${path}.y`, { reason: "expected a finite number" });
  }
  if (dimensions === "xyz") {
    const z = record.z;
    if (typeof z !== "number" || !Number.isFinite(z)) {
      fail("GEOPARQUET_NATIVE_INVALID_VALUE", `${path}.z`, { reason: "expected a finite number" });
    }
    return Object.freeze([x, y, z]);
  }
  if ("z" in record) fail("GEOPARQUET_NATIVE_INVALID_VALUE", `${path}.z`, { reason: "unexpected z for xy dimensions" });
  return Object.freeze([x, y]);
}

function asRow(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail("GEOPARQUET_NATIVE_INVALID_VALUE", path, { reason: "expected an array" });
  return value;
}

function readPoint(value: unknown, dims: GeoParquetNativeDimensions, path: string): GeoArrowPoint | null {
  if (value === null || value === undefined) return null;
  return readCoordinate(value, dims, path);
}

function readPositionList(
  value: unknown,
  dims: GeoParquetNativeDimensions,
  path: string,
): readonly GeoArrowPosition[] | null {
  if (value === null || value === undefined) return null;
  return Object.freeze(asRow(value, path).map((entry, index) => readCoordinate(entry, dims, `${path}[${index}]`)));
}

function readRingList(
  value: unknown,
  dims: GeoParquetNativeDimensions,
  path: string,
): readonly (readonly GeoArrowPosition[])[] | null {
  if (value === null || value === undefined) return null;
  return Object.freeze(
    asRow(value, path).map((ring, index) => {
      const ringPath = `${path}[${index}]`;
      return Object.freeze(
        asRow(ring, ringPath).map((entry, vertexIndex) => readCoordinate(entry, dims, `${ringPath}[${vertexIndex}]`)),
      );
    }),
  );
}

function readPartList(
  value: unknown,
  dims: GeoParquetNativeDimensions,
  path: string,
): readonly (readonly (readonly GeoArrowPosition[])[])[] | null {
  if (value === null || value === undefined) return null;
  return Object.freeze(
    asRow(value, path).map((part, index) => {
      const partPath = `${path}[${index}]`;
      return Object.freeze(
        asRow(part, partPath).map((ring, ringIndex) => {
          const ringPath = `${partPath}[${ringIndex}]`;
          return Object.freeze(
            asRow(ring, ringPath).map((entry, vertexIndex) =>
              readCoordinate(entry, dims, `${ringPath}[${vertexIndex}]`),
            ),
          );
        }),
      );
    }),
  );
}

let syntheticSequence = 0;

const SYNTHETIC_SCHEMA_ID = "geoparquet-native-geometry-v1";

/**
 * `createGeoArrowBatch` is built for cross-thread, cache-worthy transfer and
 * therefore requires a full `ColumnarBatchIdentityV1` (see #394). This
 * decode-only usage never caches or transfers the resulting batch — it is
 * discarded after `decodeGeoArrowBatch` runs and cannot escape
 * {@link runGeoArrow} — so every field is a fixed, internal placeholder.
 * `schemaVersion` must equal the `schemaId` passed alongside it
 * (`createColumnarBatch`'s identity/schema binding check).
 *
 * No batch this module *hands back* uses it:
 * {@link createGeoParquetNativeGeometryBatch} requires a plan-derived identity
 * from its caller (`columnarBatchIdentityFromPlan`) and has no placeholder path.
 */
function syntheticIdentity(): ColumnarBatchIdentityV1 {
  return Object.freeze({
    sourceId: "geoparquet-native-geometry",
    sourceVersion: "1",
    schemaVersion: SYNTHETIC_SCHEMA_ID,
    planId: "geoparquet-native-geometry-decode",
    authorizationScope: "internal",
    ordering: Object.freeze({ stable: false, keys: Object.freeze([]) }),
    freshness: Object.freeze({ observedAt: new Date().toISOString() }),
  });
}

function remapGeoArrowError(cause: unknown, rowLimitCode: GeoParquetNativeGeometryErrorCode): never {
  if (cause instanceof HonuaGeoArrowError) {
    const code: GeoParquetNativeGeometryErrorCode =
      cause.code === "row-limit-exceeded"
        ? rowLimitCode
        : cause.code === "vertex-limit-exceeded"
          ? "GEOPARQUET_NATIVE_VERTEX_LIMIT_EXCEEDED"
          : cause.code === "ring-limit-exceeded"
            ? "GEOPARQUET_NATIVE_RING_LIMIT_EXCEEDED"
            : "GEOPARQUET_NATIVE_INVALID_VALUE";
    throw new GeoParquetNativeGeometryError(code, "$", cause.detail, { cause });
  }
  throw cause;
}

/** Run the reviewed `src/columnar/geoarrow.ts` encode+decode pipeline for one kind. */
function runGeoArrow(
  geometry: GeoArrowGeometryColumnInput,
  limits: GeoParquetNativeGeometryLimits,
  rowLimitCode: GeoParquetNativeGeometryErrorCode,
  maxRows?: number,
): readonly DecodedGeoArrowRow[] {
  const conversionLimits: GeoArrowConversionLimits = {
    ...(limits.maxVertices !== undefined ? { maxVertices: limits.maxVertices } : {}),
    ...(limits.maxRings !== undefined ? { maxRings: limits.maxRings } : {}),
    ...(maxRows !== undefined ? { maxRows } : {}),
  };
  syntheticSequence += 1;
  const input: CreateGeoArrowBatchInput = {
    id: "geoparquet-native-geometry",
    sequence: syntheticSequence,
    schemaId: SYNTHETIC_SCHEMA_ID,
    identity: syntheticIdentity(),
    geometry,
  };
  try {
    const created = createGeoArrowBatch(input, conversionLimits);
    return decodeGeoArrowBatch(created.batch, conversionLimits).rows;
  } catch (cause) {
    remapGeoArrowError(cause, rowLimitCode);
  }
}

function positionToCoordinates(position: GeoArrowPosition): readonly number[] {
  return position;
}

function lineToCoordinates(line: GeoArrowLineString): readonly (readonly number[])[] {
  return line.map(positionToCoordinates);
}

function polygonToCoordinates(polygon: GeoArrowPolygon): readonly (readonly (readonly number[])[])[] {
  return polygon.map(lineToCoordinates);
}

function decodePointColumn(
  values: readonly unknown[],
  dims: GeoParquetNativeDimensions,
  limits: GeoParquetNativeGeometryLimits,
): readonly (GeoParquetNativeGeoJsonGeometry | null)[] {
  const rows = runGeoArrow(
    {
      kind: "point",
      dimensions: dims,
      coordinateLayout: "separated",
      values: values.map((value, index) => readPoint(value, dims, `$[${index}]`)),
    },
    limits,
    "GEOPARQUET_NATIVE_ROW_LIMIT_EXCEEDED",
  );
  return Object.freeze(
    rows.map((row) =>
      row.geometry === null ? null : Object.freeze({ type: "Point", coordinates: row.geometry as GeoArrowPosition }),
    ),
  );
}

function decodeLineStringColumn(
  values: readonly unknown[],
  dims: GeoParquetNativeDimensions,
  limits: GeoParquetNativeGeometryLimits,
  geoJsonType: "LineString" | "MultiPoint",
): readonly (GeoParquetNativeGeoJsonGeometry | null)[] {
  const rows = runGeoArrow(
    {
      kind: "linestring",
      dimensions: dims,
      coordinateLayout: "separated",
      values: values.map((value, index) => readPositionList(value, dims, `$[${index}]`)),
    },
    limits,
    "GEOPARQUET_NATIVE_ROW_LIMIT_EXCEEDED",
  );
  return Object.freeze(
    rows.map((row) =>
      row.geometry === null
        ? null
        : Object.freeze({ type: geoJsonType, coordinates: lineToCoordinates(row.geometry as GeoArrowLineString) }),
    ),
  );
}

function decodePolygonColumn(
  values: readonly unknown[],
  dims: GeoParquetNativeDimensions,
  limits: GeoParquetNativeGeometryLimits,
): readonly (GeoParquetNativeGeoJsonGeometry | null)[] {
  const rows = runGeoArrow(
    {
      kind: "polygon",
      dimensions: dims,
      coordinateLayout: "separated",
      values: values.map((value, index) => readRingList(value, dims, `$[${index}]`)),
    },
    limits,
    "GEOPARQUET_NATIVE_ROW_LIMIT_EXCEEDED",
  );
  return Object.freeze(
    rows.map((row) =>
      row.geometry === null
        ? null
        : Object.freeze({ type: "Polygon", coordinates: polygonToCoordinates(row.geometry as GeoArrowPolygon) }),
    ),
  );
}

/**
 * Flatten every row's parts into one list (bounded by `maxParts`, checked as
 * each row is read so the failure happens before any part is decoded) and
 * remember how many parts each row contributed, so the single decoded
 * `flatParts` list can be regrouped back into rows afterward.
 */
function flattenParts<TPart>(
  values: readonly unknown[],
  readParts: (value: unknown, path: string) => readonly TPart[] | null,
  maxParts: number,
): { readonly partsPerRow: readonly (number | null)[]; readonly flatParts: readonly TPart[] } {
  const partsPerRow: (number | null)[] = [];
  const flatParts: TPart[] = [];
  values.forEach((value, index) => {
    const parts = readParts(value, `$[${index}]`);
    if (parts === null) {
      partsPerRow.push(null);
      return;
    }
    partsPerRow.push(parts.length);
    if (flatParts.length > maxParts - parts.length) {
      fail("GEOPARQUET_NATIVE_PART_LIMIT_EXCEEDED", "$", {
        limit: maxParts,
        actual: flatParts.length + parts.length,
      });
    }
    for (const part of parts) flatParts.push(part);
  });
  return { partsPerRow: Object.freeze(partsPerRow), flatParts: Object.freeze(flatParts) };
}

/** Regroup one flattened, decoded part list back into each row's multi-geometry. */
function regroupParts(
  partsPerRow: readonly (number | null)[],
  decodedParts: readonly DecodedGeoArrowRow[],
  build: (parts: readonly DecodedGeoArrowRow["geometry"][]) => GeoParquetNativeGeoJsonGeometry,
): readonly (GeoParquetNativeGeoJsonGeometry | null)[] {
  const result: (GeoParquetNativeGeoJsonGeometry | null)[] = [];
  let cursor = 0;
  for (const count of partsPerRow) {
    if (count === null) {
      result.push(null);
      continue;
    }
    const parts: DecodedGeoArrowRow["geometry"][] = Array.from({ length: count }, () => {
      const decoded = decodedParts[cursor];
      cursor += 1;
      return decoded?.geometry ?? null;
    });
    result.push(build(parts));
  }
  return Object.freeze(result);
}

/**
 * `multilinestring` (a row is a list of independent, unclosed lines) must
 * **not** reuse GeoArrow's `polygon` kind — that kind bakes in ring-closure
 * and the four-position minimum, which are polygon-only rules a line part
 * must not inherit. Every row's line parts are instead flattened into one
 * synthetic `linestring` column (no closure requirement, matching an
 * individual `MultiLineString` part) and regrouped back into each row.
 */
function decodeMultiLineStringColumn(
  values: readonly unknown[],
  dims: GeoParquetNativeDimensions,
  limits: GeoParquetNativeGeometryLimits,
): readonly (GeoParquetNativeGeoJsonGeometry | null)[] {
  const maxParts = limits.maxParts ?? DEFAULT_MAX_PARTS;
  const { partsPerRow, flatParts } = flattenParts(values, (value, path) => readRingList(value, dims, path), maxParts);
  const decodedParts = runGeoArrow(
    { kind: "linestring", dimensions: dims, coordinateLayout: "separated", values: flatParts },
    limits,
    "GEOPARQUET_NATIVE_PART_LIMIT_EXCEEDED",
    maxParts,
  );
  return regroupParts(partsPerRow, decodedParts, (parts) =>
    Object.freeze({
      type: "MultiLineString",
      coordinates: Object.freeze(parts.map((part) => lineToCoordinates((part as GeoArrowLineString | null) ?? []))),
    }),
  );
}

/**
 * `multipolygon` nests one level deeper than GeoArrow's `polygon` kind
 * (parts → rings → positions vs. rings → positions), and — unlike
 * `multilinestring` — each part genuinely is a closed-ring `Polygon`, so
 * reusing the `polygon` kind's ring-closure validation is exactly correct.
 * Every row's parts are flattened into one synthetic `polygon` column and
 * regrouped back into each row's `MultiPolygon`.
 */
function decodeMultiPolygonColumn(
  values: readonly unknown[],
  dims: GeoParquetNativeDimensions,
  limits: GeoParquetNativeGeometryLimits,
): readonly (GeoParquetNativeGeoJsonGeometry | null)[] {
  const maxParts = limits.maxParts ?? DEFAULT_MAX_PARTS;
  const { partsPerRow, flatParts } = flattenParts(values, (value, path) => readPartList(value, dims, path), maxParts);
  const decodedParts = runGeoArrow(
    { kind: "polygon", dimensions: dims, coordinateLayout: "separated", values: flatParts },
    limits,
    "GEOPARQUET_NATIVE_PART_LIMIT_EXCEEDED",
    maxParts,
  );
  return regroupParts(partsPerRow, decodedParts, (parts) =>
    Object.freeze({
      type: "MultiPolygon",
      coordinates: Object.freeze(parts.map((part) => polygonToCoordinates((part as GeoArrowPolygon | null) ?? []))),
    }),
  );
}

/** The `geoarrow-*` encodings that map 1:1 onto a Honua GeoArrow geometry kind. */
export type GeoParquetColumnarGeometryKind = Extract<GeoParquetNativeGeometryKind, "point" | "linestring" | "polygon">;

/**
 * A columnar production request: the raw geometry column plus the plan-derived
 * identity the batch will carry.
 */
export interface CreateGeoParquetNativeGeometryBatchInput {
  /** Must be a 1:1 GeoArrow kind; the multi-part encodings are refused. */
  readonly kind: GeoParquetNativeGeometryKind;
  readonly dimensions: GeoParquetNativeDimensions;
  /** DuckDB-materialized geometry column values, one entry per result row. */
  readonly values: readonly unknown[];
  /**
   * Identity derived from the accepted query plan
   * (`columnarBatchIdentityFromPlan`). `schemaVersion` becomes the batch's
   * schema id, which is how the columnar envelope binds identity to layout.
   */
  readonly identity: ColumnarBatchIdentityV1;
  readonly batchId: string;
  readonly sequence: number;
  readonly rowOffset?: number;
  /** Geometry field name recorded in the batch schema (defaults to `geometry`). */
  readonly geometryField?: string;
  /** CRS metadata for the geometry column, preferably PROJJSON. */
  readonly crs?: GeoArrowCrs;
  /** Optional uint32 feature-id column materialized beside the geometry. */
  readonly featureIds?: GeoArrowFeatureIdColumnInput;
}

/**
 * Refuse before any buffer is allocated when the plan's ordering contract
 * names a field this batch will not carry. `createColumnarBatch` would reject
 * it too, but this failure names the missing field with a GeoParquet code, and
 * the alternative — quietly dropping the ordering key — would let a batch
 * claim an ordering the rows do not have.
 */
function assertOrderingFieldsAvailable(
  identity: ColumnarBatchIdentityV1,
  geometryField: string,
  featureIdField: string | undefined,
): void {
  const ordering: ColumnarOrderingV1 | undefined = identity.ordering;
  const keys = ordering === undefined ? undefined : ordering.keys;
  if (!Array.isArray(keys) || keys.length === 0) return;
  const available = new Set<string>([geometryField]);
  if (featureIdField !== undefined) available.add(featureIdField);
  for (const key of keys) {
    if (!available.has(key.field)) {
      fail("GEOPARQUET_COLUMNAR_ORDERING_FIELD_UNAVAILABLE", "$.identity.ordering.keys", {
        field: key.field,
        available: [...available].sort(),
      });
    }
  }
}

function columnarGeometryColumn(
  kind: GeoParquetColumnarGeometryKind,
  dimensions: GeoParquetNativeDimensions,
  values: readonly unknown[],
  field: string,
  crs: GeoArrowCrs | undefined,
): GeoArrowGeometryColumnInput {
  const base = {
    field,
    dimensions,
    coordinateLayout: "separated",
    ...(crs === undefined ? {} : { crs }),
  } as const;
  if (kind === "point") {
    return {
      ...base,
      kind: "point",
      values: values.map((value, index) => readPoint(value, dimensions, `$[${index}]`)),
    };
  }
  if (kind === "linestring") {
    return {
      ...base,
      kind: "linestring",
      values: values.map((value, index) => readPositionList(value, dimensions, `$[${index}]`)),
    };
  }
  return {
    ...base,
    kind: "polygon",
    values: values.map((value, index) => readRingList(value, dimensions, `$[${index}]`)),
  };
}

/**
 * Encode one GeoParquet 1.1 native geometry column into a `ColumnarBatchV1`
 * and **hand the batch back**.
 *
 * This is the inverse of {@link decodeGeoParquetNativeGeometryColumn}: the same
 * reviewed `src/columnar/geoarrow.ts` validation runs (every position, vertex,
 * ring, closure, finiteness, and dimension rule), but no row object is
 * materialized on the way out — the result is packed typed arrays the caller
 * can transfer, cache, or render directly.
 *
 * Only the encodings with a 1:1 GeoArrow kind are accepted. `multipoint`,
 * `multilinestring`, and `multipolygon` are refused with
 * `GEOPARQUET_COLUMNAR_UNSUPPORTED_ENCODING` rather than being re-labelled as a
 * single-part column, which would misreport the geometry type; the object
 * decoder still serves them by flattening and regrouping.
 *
 * The identity is supplied by the caller and is expected to come from
 * `columnarBatchIdentityFromPlan` in `@honua/sdk-js/query-planner`. There is no
 * placeholder identity on this path.
 */
export function createGeoParquetNativeGeometryBatch(
  input: CreateGeoParquetNativeGeometryBatchInput,
  limits: GeoParquetNativeGeometryLimits = {},
): CreatedGeoArrowBatch {
  if (typeof input !== "object" || input === null) {
    fail("GEOPARQUET_NATIVE_INVALID_VALUE", "$", { reason: "expected a batch input object" });
  }
  const { dimensions, identity, kind, values } = input;
  if (dimensions !== "xy" && dimensions !== "xyz") {
    fail("GEOPARQUET_NATIVE_UNSUPPORTED_DIMENSIONS", "$.dimensions", { dimensions });
  }
  if (!Array.isArray(values)) {
    fail("GEOPARQUET_NATIVE_INVALID_VALUE", "$.values", { reason: "expected an array of rows" });
  }
  if (typeof identity !== "object" || identity === null) {
    fail("GEOPARQUET_NATIVE_INVALID_VALUE", "$.identity", { reason: "expected a plan-derived batch identity" });
  }
  if (kind !== "point" && kind !== "linestring" && kind !== "polygon") {
    fail("GEOPARQUET_COLUMNAR_UNSUPPORTED_ENCODING", "$.kind", { kind });
  }
  const geometryField = input.geometryField ?? "geometry";
  assertOrderingFieldsAvailable(identity, geometryField, input.featureIds?.field);
  const conversionLimits: GeoArrowConversionLimits = {
    ...(limits.maxVertices !== undefined ? { maxVertices: limits.maxVertices } : {}),
    ...(limits.maxRings !== undefined ? { maxRings: limits.maxRings } : {}),
  };
  const batchInput: CreateGeoArrowBatchInput = {
    id: input.batchId,
    sequence: input.sequence,
    ...(input.rowOffset === undefined ? {} : { rowOffset: input.rowOffset }),
    schemaId: identity.schemaVersion,
    identity,
    geometry: columnarGeometryColumn(kind, dimensions, values, geometryField, input.crs),
    ...(input.featureIds === undefined ? {} : { featureIds: input.featureIds }),
  };
  try {
    return createGeoArrowBatch(batchInput, conversionLimits);
  } catch (cause) {
    remapGeoArrowError(cause, "GEOPARQUET_NATIVE_ROW_LIMIT_EXCEEDED");
  }
}

/**
 * Decode one GeoParquet 1.1 native geometry column (already materialized to
 * plain JS row values by the DuckDB driver) into GeoJSON geometries, one per
 * input row, preserving `null` for a null geometry row. Bounded by
 * `src/columnar/geoarrow.ts`'s vertex/ring limits (defaulted the same way)
 * plus an explicit `maxParts` ceiling for `multipolygon`. Fails closed with a
 * {@link GeoParquetNativeGeometryError} before any geometry is materialized
 * on malformed row shape, non-finite coordinates, or an exceeded bound.
 */
export function decodeGeoParquetNativeGeometryColumn(
  kind: GeoParquetNativeGeometryKind,
  dimensions: GeoParquetNativeDimensions,
  values: readonly unknown[],
  limits: GeoParquetNativeGeometryLimits = {},
): readonly (GeoParquetNativeGeoJsonGeometry | null)[] {
  if (dimensions !== "xy" && dimensions !== "xyz") {
    fail("GEOPARQUET_NATIVE_UNSUPPORTED_DIMENSIONS", "$.dimensions", { dimensions });
  }
  if (!Array.isArray(values)) fail("GEOPARQUET_NATIVE_INVALID_VALUE", "$", { reason: "expected an array of rows" });
  switch (kind) {
    case "point":
      return decodePointColumn(values, dimensions, limits);
    case "linestring":
      return decodeLineStringColumn(values, dimensions, limits, "LineString");
    case "multipoint":
      return decodeLineStringColumn(values, dimensions, limits, "MultiPoint");
    case "polygon":
      return decodePolygonColumn(values, dimensions, limits);
    case "multilinestring":
      return decodeMultiLineStringColumn(values, dimensions, limits);
    case "multipolygon":
      return decodeMultiPolygonColumn(values, dimensions, limits);
    default:
      fail("GEOPARQUET_NATIVE_INVALID_VALUE", "$.kind", { kind });
  }
}
