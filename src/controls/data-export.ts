/** Credential-free downloads of an application's already-filtered feature rows. */
import type { CanonicalFeature } from "../contract/types.js";
import { assertCredentialFreeExportText, isSensitiveExportKey } from "../core/credential-redaction.js";
import { toGeoJsonGeometry } from "../map/geojson-projection.js";

export type HonuaDataExportFormat = "csv" | "geojson";
export interface HonuaDataExportOptions {
  /** Already-filtered rows. Export never fetches additional data. */
  readonly rows: readonly CanonicalFeature[];
  /** Explicit public-property allowlist, in CSV column order. */
  readonly fields: readonly string[];
  readonly format: HonuaDataExportFormat;
  /** Defaults to 10,000; overflow fails rather than truncating. */
  readonly maxRows?: number;
}
export interface HonuaDataExportArtifact {
  readonly text: string;
  readonly mimeType: string;
  readonly filename: string;
  readonly rowCount: number;
}

/**
 * Creates a bounded artifact without credentials or unselected fields.
 * GeoJSON requires WGS84 input (GeoJSON or GeoServices geometry); this helper
 * does not reproject. Null geometry is retained, unsupported geometry fails.
 * CSV prefixes spreadsheet formula triggers with an apostrophe.
 */
export function serializeHonuaDataExport(options: HonuaDataExportOptions): HonuaDataExportArtifact {
  validateExportOptions(options);
  const { rows, fields, format } = options;
  const properties = rows.map((row) =>
    Object.fromEntries(
      fields.map((field) => [field, Object.hasOwn(row.attributes, field) ? row.attributes[field] : null]),
    ),
  );
  // Inspect structured values before CSV flattening can hide sensitive keys.
  assertCredentialFreeExportText(safeJson(properties), "Selected export data");
  const text = format === "csv" ? serializeCsv(fields, properties) : serializeGeoJson(rows, properties);
  assertCredentialFreeExportText(text, "Data export");
  return {
    text,
    mimeType: format === "csv" ? "text/csv;charset=utf-8" : "application/geo+json",
    filename: `data.${format}`,
    rowCount: rows.length,
  };
}

function validateExportOptions(options: HonuaDataExportOptions): void {
  const { rows, fields, format } = options;
  const maxRows = options.maxRows ?? 10_000;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100_000) {
    throw new Error("Export row limit must be an integer between 1 and 100,000.");
  }
  if (rows.length > maxRows) throw new Error("Export row limit exceeded. Narrow the filter and retry.");
  if (format !== "csv" && format !== "geojson") throw new Error("Unsupported export format.");
  if (new Set(fields).size !== fields.length) throw new Error("Export fields must be unique.");
  for (const field of fields) {
    if (isSensitiveExportKey(field)) throw new Error("Sensitive fields cannot be exported.");
    assertCredentialFreeExportText(field, "Export field");
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (key && isSensitiveExportKey(key)) throw new Error("Sensitive fields cannot be exported.");
    return item;
  });
}

function csvCell(value: unknown): string {
  let raw = value == null ? "" : typeof value === "object" ? safeJson(value) : String(value);
  if (typeof value === "string" && /^[\s]*[=+@-]|^[\t\r\n]/.test(raw)) raw = `'${raw}`;
  return `"${raw.replaceAll('"', '""')}"`;
}

function serializeCsv(fields: readonly string[], properties: readonly Record<string, unknown>[]): string {
  const lines = properties.map((row) => fields.map((field) => csvCell(row[field])).join(","));
  return `${[fields.map(csvCell).join(","), ...lines].join("\r\n")}\r\n`;
}

function serializeGeoJson(rows: readonly CanonicalFeature[], properties: readonly Record<string, unknown>[]): string {
  const features = rows.map((row, index) => ({
    type: "Feature",
    ...(row.id === undefined ? {} : { id: row.id }),
    geometry: exportGeometry(row.geometry),
    properties: properties[index],
  }));
  return safeJson({ type: "FeatureCollection", features });
}

function exportGeometry(source: CanonicalFeature["geometry"]) {
  if (source == null) return null;
  const sr = source.spatialReference as { wkid?: number; latestWkid?: number } | undefined;
  if ("crs" in source || (sr && (sr.latestWkid ?? sr.wkid) !== 4326)) {
    throw new Error("GeoJSON export requires WGS84 geometry.");
  }
  const geometry = toGeoJsonGeometry(source);
  if (!geometry || !validWgs84Geometry(geometry))
    throw new Error("GeoJSON export requires valid finite WGS84 geometry.");
  return geometry;
}

function validWgs84Geometry(geometry: { type: string; coordinates: unknown }): boolean {
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case "Point":
      return isWgs84Position(coordinates);
    case "MultiPoint":
      return everyCoordinate(coordinates, isWgs84Position);
    case "LineString":
      return isLine(coordinates);
    case "MultiLineString":
      return everyCoordinate(coordinates, isLine);
    case "Polygon":
      return everyCoordinate(coordinates, isRing);
    case "MultiPolygon":
      return everyCoordinate(coordinates, (polygon) => everyCoordinate(polygon, isRing));
    default:
      return false;
  }
}

function everyCoordinate(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(predicate);
}
function isWgs84Position(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((ordinate) => typeof ordinate === "number" && Number.isFinite(ordinate)) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}
function isLine(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 2 && value.every(isWgs84Position);
}
function isRing(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4 || !value.every(isWgs84Position)) return false;
  const first = value[0] as number[];
  const last = value[value.length - 1] as number[];
  return first.length === last.length && first.every((ordinate, index) => ordinate === last[index]);
}
