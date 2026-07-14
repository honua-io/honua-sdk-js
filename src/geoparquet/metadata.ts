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
  /** DuckDB DESCRIBE emits `YES` / `NO` when nullability is known. */
  readonly null?: string;
}

export interface SourceProfileField {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
}

export interface SourceProfileGeometry extends GeometryColumnPlan {
  /** False when DuckDB exposed a raw GeoArrow nested value that this SQL compiler cannot execute safely. */
  readonly runtimeSupported?: boolean;
  /**
   * Whether the containing GeoParquet document passed the bounded 1.0/1.1
   * projection checks required by this normalizer. This is deliberately not a
   * GeoParquet conformance result: in particular, the focused source-schema
   * runtime validates PROJJSON separately before exposing a portable CRS.
   * `valid` only means it is safe to apply the metadata semantics projected by
   * this module (including the absent-CRS default).
   */
  readonly metadataState?: "valid" | "invalid" | "missing";
  /** GeoParquet `geometry_types`; an empty array explicitly means unknown. */
  readonly geometryTypes?: readonly string[];
  readonly geometryTypesState?: "valid" | "missing" | "invalid" | "conflicting";
  /** Distinguishes a valid GeoParquet CRS84 default from absent/invalid `geo` metadata. */
  readonly crsState?: "absent" | "null" | "value" | "missing-metadata" | "invalid-metadata";
  /** Raw parsed PROJJSON/string value, retained only for v2 normalization. */
  readonly crsValue?: unknown;
  /** Valid coordinate epoch from the column metadata. */
  readonly coordinateEpoch?: number;
  readonly epochState?: "absent" | "valid" | "invalid";
  /** Invalid raw epoch retained as bounded native evidence by schema v2. */
  readonly epochValue?: unknown;
}

export interface SourceProfile {
  /** Every non-geometry column, in file order. */
  readonly columns: readonly string[];
  /** Typed DESCRIBE projection used by vendor-neutral schema discovery. */
  readonly fields?: readonly SourceProfileField[];
  /** Geometry column plan, or `undefined` for a non-spatial (tabular) file. */
  readonly geometry?: SourceProfileGeometry;
  /** Every geometry column declared by GeoParquet metadata; `geometry` remains the primary runtime plan. */
  readonly geometries?: readonly SourceProfileGeometry[];
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
      geometry_types?: unknown;
      edges?: unknown;
      orientation?: unknown;
      bbox?: unknown;
      epoch?: unknown;
      covering?: unknown;
    }
  >;
}

type GeoColumnMeta = NonNullable<GeoMeta["columns"]>[string];

const GEOPARQUET_SUPPORTED_VERSION = /^(1\.0\.0|1\.1\.0)$/;
const GEOPARQUET_1_0_ENCODINGS = new Set(["WKB"]);
const GEOPARQUET_1_1_ENCODINGS = new Set([
  "WKB",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
]);
const GEOPARQUET_GEOMETRY_TYPE = /^(?:GeometryCollection|(?:Multi)?(?:Point|LineString|Polygon))(?: Z)?$/;
const GEOPARQUET_1_0_COLUMN_MEMBERS = new Set([
  "encoding",
  "geometry_types",
  "crs",
  "edges",
  "orientation",
  "bbox",
  "epoch",
]);
const GEOPARQUET_1_1_COLUMN_MEMBERS = new Set([...GEOPARQUET_1_0_COLUMN_MEMBERS, "covering"]);
const MAX_GEOPARQUET_METADATA_BYTES = 1024 * 1024;

/**
 * Encoding is derived from the DuckDB DESCRIBE column type, not the GeoParquet
 * `geo.encoding` field. DuckDB's `read_parquet` rehydrates a GeoParquet WKB
 * column back into a native `GEOMETRY`, so the SQL expression must key off what
 * DuckDB actually hands back (`GEOMETRY` ⇒ use directly; `BLOB` ⇒
 * `ST_GeomFromWKB`; `JSON`/`VARCHAR` ⇒ `ST_GeomFromGeoJSON`).
 */
function encodingFromColumnType(type: string): GeometryEncoding | undefined {
  const t = type.toUpperCase();
  if (t.includes("GEOMETRY") || t.includes("GEOGRAPHY")) return "native";
  if (t.includes("BLOB") || t.includes("BYTEA") || t.includes("BINARY")) return "wkb";
  if (t.includes("JSON") || t.includes("VARCHAR") || t.includes("TEXT")) return "geojson";
  return undefined;
}

/** Common geometry column names used to infer a column when there is no
 * GeoParquet metadata and no native GEOMETRY-typed column. */
const GEOMETRY_COLUMN_NAMES = new Set(["geometry", "geom", "the_geom", "wkb_geometry", "wkb", "geog"]);

/**
 * Extract a human-readable CRS id from a GeoParquet `crs` value, which may be a
 * PROJJSON object, a string, or absent (absent ⇒ the GeoParquet default
 * `OGC:CRS84`). The default applies only when a valid GeoParquet `geo`
 * document identifies the geometry column and omits its `crs` member.
 */
function crsFromGeoMeta(crs: unknown): string | undefined {
  if (crs === null) return undefined;
  if (crs === undefined) return "OGC:CRS84";
  if (typeof crs === "object") {
    const obj = crs as Record<string, unknown>;
    const id = obj.id as { authority?: unknown; code?: unknown } | undefined;
    if (id && id.authority !== undefined && id.code !== undefined) {
      return `${String(id.authority)}:${String(id.code)}`;
    }
    if (typeof obj.name === "string") return obj.name;
  }
  return undefined;
}

function findBboxColumn(
  describe: readonly DescribeRow[],
  geometryRow: DescribeRow,
  preferred?: string,
): string | undefined {
  const matches = (row: DescribeRow) =>
    isGeoParquetBboxStruct(row.column_type) && geoParquetRepetitionMatches(geometryRow, row);
  if (preferred !== undefined) {
    return describe.find((row) => row.column_name === preferred && matches(row))?.column_name;
  }
  const named = describe.find((row) => row.column_name.toLowerCase() === "bbox" && matches(row));
  return named?.column_name;
}

function geoParquetRepetitionMatches(geometry: DescribeRow, bbox: DescribeRow): boolean {
  const geometryRepetition = geometry.null === "YES" ? "optional" : geometry.null === "NO" ? "required" : undefined;
  const bboxRepetition = bbox.null === "YES" ? "optional" : bbox.null === "NO" ? "required" : undefined;
  return geometryRepetition !== undefined && bboxRepetition === geometryRepetition;
}

function isGeoParquetBboxStruct(columnType: string): boolean {
  const struct = /^STRUCT\s*\((.*)\)$/i.exec(columnType.trim());
  if (!struct) return false;
  const members = struct[1]!.split(",").map((member) => member.trim());
  const expectedNames =
    members.length === 4
      ? ["xmin", "ymin", "xmax", "ymax"]
      : members.length === 6
        ? ["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"]
        : undefined;
  if (!expectedNames) return false;
  let memberType: "FLOAT" | "DOUBLE" | undefined;
  return members.every((member, index) => {
    const parsed = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+(FLOAT|DOUBLE)$/i.exec(member);
    if (!parsed || (parsed[1] ?? parsed[2]) !== expectedNames[index]) return false;
    const type = parsed[3]!.toUpperCase() as "FLOAT" | "DOUBLE";
    memberType ??= type;
    return memberType === type;
  });
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

  let geometry: SourceProfile["geometry"];
  let geometries: SourceProfileGeometry[] | undefined;
  let crs: string | undefined;

  let geo: GeoMeta | undefined;
  let geoDocumentState: "missing" | "parsed" | "invalid" = geoJson === undefined ? "missing" : "invalid";
  if (
    geoJson !== undefined &&
    geoJson.length <= MAX_GEOPARQUET_METADATA_BYTES &&
    new TextEncoder().encode(geoJson).byteLength <= MAX_GEOPARQUET_METADATA_BYTES
  ) {
    try {
      const parsed = JSON.parse(geoJson) as unknown;
      if (isGeoColumnMetadata(parsed)) {
        geo = parsed as GeoMeta;
        geoDocumentState = "parsed";
      }
    } catch {
      geo = undefined;
    }
  }

  const rowFor = (name: string) => describe.find((r) => r.column_name === name);
  const declaredMetadata = isGeoColumnsMetadata(geo?.columns) ? geo.columns : undefined;
  const declaredPrimary =
    typeof geo?.primary_column === "string" && geo.primary_column !== "" ? geo.primary_column : undefined;
  const declaredGeometryColumns = Object.keys(declaredMetadata ?? {}).filter((column) => rowFor(column));
  const primaryRow = declaredPrimary ? rowFor(declaredPrimary) : undefined;
  const metadataValid = geo ? validGeoMetadataProjectionSlice(geo, describe) : false;

  if (geo && (primaryRow || declaredGeometryColumns.length > 0)) {
    // GeoParquet metadata is authoritative for *which* column and the CRS; the
    // physical encoding still comes from the DuckDB column type.
    const declaredColumns = [
      ...(primaryRow && declaredPrimary ? [declaredPrimary] : []),
      ...declaredGeometryColumns.filter((column) => column !== declaredPrimary),
    ];
    geometries = declaredColumns.flatMap((column) => {
      const row = rowFor(column);
      return row
        ? [geometryPlanFromGeoMetadata(describe, row, declaredMetadata?.[column], metadataValid ? "valid" : "invalid")]
        : [];
    });
    geometry = declaredPrimary ? geometries.find((candidate) => candidate.column === declaredPrimary) : undefined;
    const primaryMetadata = declaredPrimary ? declaredMetadata?.[declaredPrimary] : undefined;
    if (metadataValid && isGeoColumnMetadata(primaryMetadata)) crs = crsFromGeoMeta(primaryMetadata.crs);
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
      const encoding = encodingFromColumnType(chosen.column_type) ?? "wkb";
      const bboxColumn = findBboxColumn(describe, chosen);
      const metadataState =
        geoDocumentState === "invalid" || (geoDocumentState === "parsed" && !metadataValid) ? "invalid" : "missing";
      geometry = {
        column: chosen.column_name,
        encoding,
        ...(encodingFromColumnType(chosen.column_type) === undefined ? { runtimeSupported: false } : {}),
        ...(bboxColumn ? { bboxColumn } : {}),
        metadataState,
        geometryTypesState: metadataState,
        crsState: metadataState === "invalid" ? "invalid-metadata" : "missing-metadata",
        epochState: "absent",
      };
      geometries = [geometry];
    }
  }

  const geometryColumns = new Set((geometries ?? []).map((candidate) => candidate.column));
  const bboxColumns = new Set((geometries ?? []).flatMap((candidate) => candidate.bboxColumn ?? []));
  const columns = allColumns.filter((column) => !geometryColumns.has(column) && !bboxColumns.has(column));

  return {
    columns,
    fields: describe
      .filter((field) => !bboxColumns.has(field.column_name))
      .map((field) => ({
        name: field.column_name,
        type: field.column_type,
        ...(field.null === "YES" ? { nullable: true } : field.null === "NO" ? { nullable: false } : {}),
      })),
    ...(geometry ? { geometry } : {}),
    ...(geometries ? { geometries } : {}),
    ...(crs ? { crs } : {}),
    ...(rowEstimate !== undefined ? { rowEstimate } : {}),
  };
}

function geometryPlanFromGeoMetadata(
  describe: readonly DescribeRow[],
  row: DescribeRow,
  columnMetadata: GeoColumnMeta | undefined,
  metadataState: "valid" | "invalid",
): SourceProfileGeometry {
  const metadata = isGeoColumnMetadata(columnMetadata) ? columnMetadata : undefined;
  const bboxColumn =
    metadataState === "valid"
      ? findBboxColumn(describe, row, geoParquetBboxCoveringColumn(metadata?.covering))
      : undefined;
  const inspectedGeometryTypes = inspectGeometryTypes(metadata);
  const geometryTypesState =
    metadataState === "valid"
      ? inspectedGeometryTypes.state
      : inspectedGeometryTypes.state === "conflicting"
        ? "conflicting"
        : "invalid";
  const crsState =
    metadataState === "invalid"
      ? "invalid-metadata"
      : metadata === undefined
        ? "missing-metadata"
        : Object.hasOwn(metadata, "crs")
          ? metadata.crs === null
            ? "null"
            : "value"
          : "absent";
  const epoch = inspectEpoch(metadata);
  const detectedEncoding = encodingFromColumnType(row.column_type);
  const declaredNativeEncoding = metadataState === "valid" && metadata?.encoding !== "WKB";
  const runtimeSupported = detectedEncoding !== undefined && (!declaredNativeEncoding || detectedEncoding === "native");
  return {
    column: row.column_name,
    encoding: detectedEncoding ?? (declaredNativeEncoding ? "native" : "wkb"),
    ...(runtimeSupported ? {} : { runtimeSupported: false }),
    ...(bboxColumn ? { bboxColumn } : {}),
    metadataState,
    geometryTypesState,
    ...(inspectedGeometryTypes.values ? { geometryTypes: inspectedGeometryTypes.values } : {}),
    crsState,
    ...(metadata && Object.hasOwn(metadata, "crs") && metadata.crs !== null ? { crsValue: metadata.crs } : {}),
    epochState: epoch.state,
    ...(epoch.coordinateEpoch === undefined ? {} : { coordinateEpoch: epoch.coordinateEpoch }),
    ...(epoch.state === "invalid" ? { epochValue: epoch.value } : {}),
  };
}

function isGeoColumnMetadata(value: unknown): value is GeoColumnMeta {
  return isPlainRecord(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGeoColumnsMetadata(value: unknown): value is Record<string, GeoColumnMeta> {
  return isGeoColumnMetadata(value);
}

/**
 * Validate the exact GeoParquet members this projection consumes. This is not
 * advertised as whole-document conformance because CRS objects are preserved
 * as native evidence and validated by the focused PROJJSON runtime later.
 */
function validGeoMetadataProjectionSlice(geo: GeoMeta, describe: readonly DescribeRow[]): boolean {
  if (typeof geo.version !== "string") return false;
  const version = GEOPARQUET_SUPPORTED_VERSION.exec(geo.version);
  if (!version) return false;
  const encodings = version[1] === "1.0.0" ? GEOPARQUET_1_0_ENCODINGS : GEOPARQUET_1_1_ENCODINGS;
  if (typeof geo.primary_column !== "string" || geo.primary_column === "") return false;
  if (!isGeoColumnsMetadata(geo.columns)) return false;
  const entries = Object.entries(geo.columns);
  if (entries.length === 0 || !Object.hasOwn(geo.columns, geo.primary_column)) return false;
  const physicalColumns = new Set(describe.map((row) => row.column_name));
  return entries.every(
    ([column, metadata]) =>
      column !== "" &&
      physicalColumns.has(column) &&
      validGeoColumnMetadataProjection(metadata, encodings, version[1] === "1.1.0", describe, column),
  );
}

function validGeoColumnMetadataProjection(
  value: unknown,
  encodings: ReadonlySet<string>,
  supportsCovering: boolean,
  describe: readonly DescribeRow[],
  geometryColumn: string,
): value is GeoColumnMeta {
  if (!isGeoColumnMetadata(value)) return false;
  const allowedMembers = supportsCovering ? GEOPARQUET_1_1_COLUMN_MEMBERS : GEOPARQUET_1_0_COLUMN_MEMBERS;
  if (Object.keys(value).some((key) => !allowedMembers.has(key))) return false;
  if (typeof value.encoding !== "string" || !encodings.has(value.encoding)) return false;
  const geometryTypes = inspectGeometryTypes(value);
  if (geometryTypes.state !== "valid") return false;
  const geometryRow = describe.find((row) => row.column_name === geometryColumn);
  if (!geometryRow || !geoParquetEncodingMatchesPhysicalType(value.encoding, geometryRow.column_type)) return false;
  if (!geoParquetEncodingMatchesGeometryTypes(value.encoding, geometryTypes.values ?? [])) return false;
  if (Object.hasOwn(value, "crs") && value.crs !== null && !isGeoColumnMetadata(value.crs)) return false;
  if (Object.hasOwn(value, "edges") && value.edges !== "planar" && value.edges !== "spherical") return false;
  if (Object.hasOwn(value, "orientation") && value.orientation !== "counterclockwise") return false;
  if (Object.hasOwn(value, "bbox") && !validGeoParquetBbox(value.bbox)) return false;
  if (inspectEpoch(value).state === "invalid") return false;
  if (supportsCovering && Object.hasOwn(value, "covering")) {
    if (!validGeoParquetCovering(value.covering)) return false;
    const coveringColumn = geoParquetBboxCoveringColumn(value.covering);
    if (
      coveringColumn === undefined ||
      geometryRow === undefined ||
      findBboxColumn(describe, geometryRow, coveringColumn) !== coveringColumn
    ) {
      return false;
    }
  }
  return true;
}

function geoParquetEncodingMatchesPhysicalType(encoding: string, columnType: string): boolean {
  const delivered = encodingFromColumnType(columnType);
  if (delivered === "native") return true;
  if (encoding === "WKB") return delivered === "wkb";
  const upper = columnType.toUpperCase();
  const coordinates = /STRUCT\s*[<(][^>)]*\bX\s+(?:FLOAT|DOUBLE)\b[^>)]*\bY\s+(?:FLOAT|DOUBLE)\b/.test(upper);
  if (encoding === "point") return coordinates;
  return coordinates && (upper.includes("[]") || upper.includes("LIST"));
}

function geoParquetEncodingMatchesGeometryTypes(encoding: string, geometryTypes: readonly string[]): boolean {
  if (encoding === "WKB" || geometryTypes.length === 0) return true;
  const expected =
    encoding === "point"
      ? "Point"
      : encoding === "linestring"
        ? "LineString"
        : encoding === "polygon"
          ? "Polygon"
          : encoding === "multipoint"
            ? "MultiPoint"
            : encoding === "multilinestring"
              ? "MultiLineString"
              : encoding === "multipolygon"
                ? "MultiPolygon"
                : undefined;
  return expected !== undefined && geometryTypes.every((value) => value === expected || value === `${expected} Z`);
}

function validGeoParquetBbox(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    (value.length === 4 || value.length === 6) &&
    value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  );
}

function validGeoParquetCovering(value: unknown): boolean {
  return geoParquetBboxCoveringColumn(value) !== undefined;
}

function geoParquetBboxCoveringColumn(value: unknown): string | undefined {
  if (!isPlainRecord(value) || !isPlainRecord(value.bbox)) return undefined;
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "bbox")) return undefined;
  const bbox = value.bbox;
  const bboxMembers = ["xmin", "ymin", "xmax", "ymax"] as const;
  if (
    Object.keys(bbox).length !== bboxMembers.length ||
    Object.keys(bbox).some((key) => !(bboxMembers as readonly string[]).includes(key))
  ) {
    return undefined;
  }
  let coveringColumn: string | undefined;
  for (const member of bboxMembers) {
    const path = bbox[member];
    if (
      !Array.isArray(path) ||
      path.length !== 2 ||
      typeof path[0] !== "string" ||
      path[0].length === 0 ||
      path[1] !== member
    ) {
      return undefined;
    }
    coveringColumn ??= path[0];
    if (coveringColumn !== path[0]) return undefined;
  }
  return coveringColumn;
}

function inspectGeometryTypes(metadata: GeoColumnMeta | undefined): {
  readonly state: "valid" | "missing" | "invalid" | "conflicting";
  readonly values?: readonly string[];
} {
  if (!metadata || !Object.hasOwn(metadata, "geometry_types")) return { state: "missing" };
  if (!Array.isArray(metadata.geometry_types)) return { state: "invalid" };
  if (metadata.geometry_types.some((value) => typeof value !== "string" || !GEOPARQUET_GEOMETRY_TYPE.test(value))) {
    return { state: "invalid" };
  }
  const values = metadata.geometry_types as string[];
  if (new Set(values).size !== values.length) return { state: "conflicting", values: [...values] };
  return { state: "valid", values: [...values] };
}

function inspectEpoch(metadata: GeoColumnMeta | undefined): {
  readonly state: "absent" | "valid" | "invalid";
  readonly coordinateEpoch?: number;
  readonly value?: unknown;
} {
  if (!metadata || !Object.hasOwn(metadata, "epoch")) return { state: "absent" };
  if (typeof metadata.epoch !== "number" || !Number.isFinite(metadata.epoch)) {
    return { state: "invalid", value: metadata.epoch };
  }
  return { state: "valid", coordinateEpoch: metadata.epoch };
}
