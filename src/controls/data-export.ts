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
  const properties = rows.map((row) =>
    Object.fromEntries(
      fields.map((field) => [field, Object.hasOwn(row.attributes, field) ? row.attributes[field] : null]),
    ),
  );
  // Inspect selected structured values before flattening them into CSV cells.
  const safeJson = (value: unknown): string =>
    JSON.stringify(value, (key, item: unknown) => {
      if (key && isSensitiveExportKey(key)) throw new Error("Sensitive fields cannot be exported.");
      return item;
    });
  assertCredentialFreeExportText(safeJson(properties), "Selected export data");
  let text: string;
  if (format === "csv") {
    const cell = (value: unknown): string => {
      let raw = value == null ? "" : typeof value === "object" ? safeJson(value) : String(value);
      if (/^[\s]*[=+@-]|^[\t\r\n]/.test(raw)) raw = `'${raw}`;
      return `"${raw.replaceAll('"', '""')}"`;
    };
    text = `${[fields.map(cell).join(","), ...properties.map((row) => fields.map((field) => cell(row[field])).join(","))].join("\r\n")}\r\n`;
  } else {
    const features = rows.map((row, index) => {
      const source = row.geometry;
      const sr = source?.spatialReference as { wkid?: number; latestWkid?: number } | undefined;
      if (source && ("crs" in source || (sr && (sr.latestWkid ?? sr.wkid) !== 4326))) {
        throw new Error("GeoJSON export requires WGS84 geometry.");
      }
      const geometry = source == null ? null : toGeoJsonGeometry(source);
      if (source != null && !geometry) throw new Error("Unsupported geometry in GeoJSON export.");
      if (geometry && !hasWgs84Coordinates(geometry.coordinates))
        throw new Error("GeoJSON export requires finite WGS84 coordinates.");
      return {
        type: "Feature",
        ...(row.id === undefined ? {} : { id: row.id }),
        geometry,
        properties: properties[index],
      };
    });
    text = safeJson({ type: "FeatureCollection", features });
  }
  assertCredentialFreeExportText(text, "Data export");
  return {
    text,
    mimeType: format === "csv" ? "text/csv;charset=utf-8" : "application/geo+json",
    filename: `data.${format}`,
    rowCount: rows.length,
  };
}

function hasWgs84Coordinates(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (typeof value[0] === "number") {
    return (
      value.length >= 2 &&
      value.every((ordinate) => typeof ordinate === "number" && Number.isFinite(ordinate)) &&
      Math.abs(value[0]) <= 180 &&
      Math.abs(value[1]) <= 90
    );
  }
  return value.every(hasWgs84Coordinates);
}
