/**
 * Field-type, temporal, and CRS mapping between the Honua contract and
 * Kepler's ingestion model (REQ-003).
 *
 * Every mapping is explicit. A Honua field type with no Kepler equivalent is
 * reported as an `unsupported-field-type` fidelity loss and dropped rather
 * than coerced into a lossy `string` column behind the caller's back.
 *
 * @experimental
 * @module
 */

import type { KeplerCrsDecision, KeplerFidelityLoss, KeplerField, KeplerFieldType } from "./types.js";
import { HonuaKeplerBridgeError } from "./types.js";

/** Kepler's parse/display format for an epoch-millisecond timestamp column. */
export const KEPLER_TIMESTAMP_FORMAT = "x" as const;
/** Kepler's parse/display format for an ISO-8601 date column. */
export const KEPLER_DATE_FORMAT = "YYYY-M-D" as const;

/** CRS identifiers Kepler can render directly (lon/lat degrees). */
const WGS84_CRS: ReadonlySet<string> = new Set([
  "crs84",
  "epsg:4326",
  "http://www.opengis.net/def/crs/ogc/1.3/crs84",
  "ogc:crs84",
  "urn:ogc:def:crs:ogc:1.3:crs84",
  "urn:ogc:def:crs:epsg::4326",
  "wgs84",
  "4326",
]);

/**
 * Explicit Esri/Honua field-type to Kepler field-type table. `undefined` means
 * "no equivalent" — the field is dropped with a recorded loss.
 */
const ESRI_FIELD_TYPE_TO_KEPLER: Readonly<Record<string, KeplerFieldType | undefined>> = Object.freeze({
  esriFieldTypeString: "string",
  esriFieldTypeInteger: "integer",
  esriFieldTypeSmallInteger: "integer",
  esriFieldTypeBigInteger: "integer",
  esriFieldTypeOID: "integer",
  esriFieldTypeDouble: "real",
  esriFieldTypeSingle: "real",
  esriFieldTypeDate: "timestamp",
  esriFieldTypeDateOnly: "date",
  esriFieldTypeTimestampOffset: "timestamp",
  esriFieldTypeGUID: "string",
  esriFieldTypeGlobalID: "string",
  esriFieldTypeGeometry: "geojson",
  esriFieldTypeBlob: undefined,
  esriFieldTypeRaster: undefined,
  esriFieldTypeXML: undefined,
  esriFieldTypeTimeOnly: undefined,
});

/**
 * Columnar (Arrow-style) logical type names to Kepler field types. Names are
 * matched case-insensitively; unknown names fall through to value inference.
 */
const COLUMNAR_TYPE_TO_KEPLER: Readonly<Record<string, KeplerFieldType | undefined>> = Object.freeze({
  bool: "boolean",
  boolean: "boolean",
  date: "date",
  date32: "date",
  date64: "timestamp",
  decimal: "real",
  decimal128: "real",
  double: "real",
  float: "real",
  float32: "real",
  float64: "real",
  int: "integer",
  int8: "integer",
  int16: "integer",
  int32: "integer",
  int64: "integer",
  large_utf8: "string",
  string: "string",
  timestamp: "timestamp",
  uint8: "integer",
  uint16: "integer",
  uint32: "integer",
  uint64: "integer",
  utf8: "string",
  binary: undefined,
  large_binary: undefined,
  list: undefined,
  map: undefined,
  struct: undefined,
  union: undefined,
});

export type KeplerFieldMappingOrigin =
  | "declared-esri-type"
  | "declared-columnar-type"
  | "value-inference"
  | "temporal-override"
  | "geometry";

export interface KeplerFieldMapping {
  readonly field: KeplerField;
  readonly origin: KeplerFieldMappingOrigin;
}

/** One resolved column plus the source attribute name it reads. */
export interface KeplerColumnPlan {
  readonly attribute: string;
  readonly mapping: KeplerFieldMapping;
}

function formatFor(type: KeplerFieldType): string {
  if (type === "timestamp") return KEPLER_TIMESTAMP_FORMAT;
  if (type === "date") return KEPLER_DATE_FORMAT;
  return "";
}

function analyzerFor(type: KeplerFieldType): string {
  switch (type) {
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "geojson":
      return "GEOMETRY";
    case "integer":
      return "INT";
    case "point":
      return "GEOMETRY_FROM_STRING";
    case "real":
      return "FLOAT";
    case "timestamp":
      return "DATETIME";
    default:
      return "STRING";
  }
}

/** Build a Kepler field descriptor with the format/analyzer Kepler expects. */
export function keplerField(name: string, type: KeplerFieldType, displayName?: string): KeplerField {
  return Object.freeze({
    name,
    type,
    format: formatFor(type),
    analyzerType: analyzerFor(type),
    ...(displayName === undefined || displayName === name ? {} : { displayName }),
  });
}

/** Map a declared Esri/Honua field type. Returns `undefined` when unsupported. */
export function keplerTypeForEsriFieldType(type: string): KeplerFieldType | undefined {
  return ESRI_FIELD_TYPE_TO_KEPLER[type];
}

/** Map a declared columnar logical type name. Returns `undefined` when unsupported. */
export function keplerTypeForColumnarType(type: string): KeplerFieldType | undefined {
  return COLUMNAR_TYPE_TO_KEPLER[type.trim().toLowerCase()];
}

/** True when the columnar type name is known to the bridge at all. */
export function isKnownColumnarType(type: string): boolean {
  return Object.hasOwn(COLUMNAR_TYPE_TO_KEPLER, type.trim().toLowerCase());
}

const ISO_DATE_TIME_MIN_LENGTH = 10;

/** Cheap linear ISO-8601 date/date-time shape check (no backtracking). */
function looksLikeIsoInstant(value: string): boolean {
  if (value.length < ISO_DATE_TIME_MIN_LENGTH) return false;
  for (let index = 0; index < 4; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return value[4] === "-" && value[7] === "-" && !Number.isNaN(Date.parse(value));
}

/** Infer a Kepler field type from the first non-null value seen in a column. */
export function inferKeplerFieldType(sample: unknown): KeplerFieldType | undefined {
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return Number.isInteger(sample) ? "integer" : "real";
  if (typeof sample === "bigint") return "integer";
  if (typeof sample === "string") return looksLikeIsoInstant(sample) ? "timestamp" : "string";
  return undefined;
}

/**
 * Normalize an attribute value for a Kepler column of `type`.
 *
 * Timestamps are normalized to epoch milliseconds (Kepler's `x` format) so
 * temporal filters and animation windows are exact in both directions.
 * Nested objects/arrays reaching a `string` column are JSON-stringified and
 * recorded as a `nested-value-stringified` loss by the caller.
 */
export function normalizeKeplerValue(value: unknown, type: KeplerFieldType): unknown {
  if (value === undefined || value === null) return null;
  switch (type) {
    case "timestamp": {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (value instanceof Date) return value.getTime();
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
      }
      return null;
    }
    case "date": {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (typeof value === "string") return value.slice(0, 10);
      if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
      return null;
    }
    case "integer": {
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
      if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? null : parsed;
      }
      return null;
    }
    case "real": {
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "string") {
        const parsed = Number.parseFloat(value);
        return Number.isNaN(parsed) ? null : parsed;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? value : Boolean(value);
    case "geojson":
    case "point":
      return value;
    default:
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
      return JSON.stringify(value) ?? null;
  }
}

/** True when a value would be JSON-stringified into a Kepler `string` column. */
export function isNestedValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && !(value instanceof Date);
}

/**
 * Resolve the CRS decision for a projection. Kepler renders WGS84 lon/lat
 * only, so a non-WGS84 input is rejected rather than silently mis-plotted.
 */
export function resolveKeplerCrs(requested: string | undefined, hasGeometry: boolean): KeplerCrsDecision {
  const declared = requested ?? "EPSG:4326";
  if (!hasGeometry) {
    return Object.freeze({
      requested: declared,
      applied: "none",
      reprojected: false,
      reason: "Tabular projection carries no geometry, so no CRS applies.",
    });
  }
  if (!WGS84_CRS.has(declared.trim().toLowerCase())) {
    throw new HonuaKeplerBridgeError(
      "unsupported-crs",
      `Kepler renders WGS84 lon/lat only; "${declared}" would need reprojection. Reproject the result before projecting it into Kepler.`,
      { requested: declared, supported: "EPSG:4326 / OGC:CRS84" },
    );
  }
  return Object.freeze({
    requested: declared,
    applied: "EPSG:4326",
    reprojected: false,
    reason: "Input coordinates are already WGS84 lon/lat; no reprojection performed.",
  });
}

/** Convenience constructor for an `unsupported-field-type` loss. */
export function unsupportedFieldLoss(field: string, declaredType: string): KeplerFidelityLoss {
  return Object.freeze({
    kind: "unsupported-field-type",
    field,
    detail: `Field type "${declaredType}" has no Kepler equivalent; the column was dropped.`,
  });
}
