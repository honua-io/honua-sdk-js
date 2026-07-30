/**
 * Bounded Apache Arrow ingestion through Kepler's optional processor seam.
 *
 * The SDK receives an opaque Arrow table and asks the host-supplied Kepler
 * processor to interpret it. No Apache Arrow or Kepler package is imported by
 * this module, and no GeoJSON serialization occurs. The processor result is
 * validated and copied into the bridge's credential-free, provenance-carrying
 * dataset shape so workspace budgets and reconciliation remain authoritative.
 *
 * @experimental
 * @module
 */

import {
  inferKeplerFieldType,
  isNestedValue,
  keplerField,
  keplerTypeForColumnarType,
  normalizeKeplerValue,
  resolveKeplerCrs,
} from "./fields.js";
import { jsonByteLength } from "./geometry.js";
import {
  DEFAULT_KEPLER_BRIDGE_LIMITS,
  enforceKeplerDatasetLimits,
  keplerDatasetMetadata,
  keplerIngestionDiagnostic,
  normalizeKeplerProvenance,
} from "./ingest.js";
import type {
  KeplerArrowProcessorResult,
  KeplerArrowTableProjectionRequest,
  KeplerBridgeLimits,
  KeplerDatasetProjection,
  KeplerFidelityLoss,
  KeplerField,
  KeplerFieldType,
  KeplerProcessors,
} from "./types.js";
import { HonuaKeplerBridgeError, KEPLER_BRIDGE_CONTRACT_VERSION } from "./types.js";

function mappedFieldType(type: string, sample: unknown): KeplerFieldType | undefined {
  const normalized = type.trim().toLowerCase();
  if (normalized === "geoarrow") return "geojson";
  if (["boolean", "date", "geojson", "integer", "point", "real", "string", "timestamp"].includes(normalized)) {
    return normalized as KeplerFieldType;
  }
  return keplerTypeForColumnarType(normalized) ?? inferKeplerFieldType(sample);
}

function assertResult(value: KeplerArrowProcessorResult | null): KeplerArrowProcessorResult {
  if (value === null || typeof value !== "object" || !Array.isArray(value.fields) || !Array.isArray(value.rows)) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "Kepler's processArrowTable returned no bounded fields/rows dataset.",
    );
  }
  return value;
}

/** Project one bounded Arrow table using the host's Kepler processor. */
export function projectArrowTableToKeplerDataset(
  request: KeplerArrowTableProjectionRequest,
  processors: KeplerProcessors,
  limits: KeplerBridgeLimits = DEFAULT_KEPLER_BRIDGE_LIMITS,
): KeplerDatasetProjection {
  if (typeof request.datasetId !== "string" || request.datasetId.trim().length === 0) {
    throw new HonuaKeplerBridgeError("invalid-request", "A Kepler Arrow projection requires a non-empty datasetId.");
  }
  if (typeof processors?.processArrowTable !== "function") {
    throw new HonuaKeplerBridgeError("missing-peer", "A Kepler Arrow projection requires processArrowTable.");
  }
  const provenance = normalizeKeplerProvenance(request.provenance);
  const processed = assertResult(processors.processArrowTable(request.arrowTable));
  if (processed.fields.length === 0) {
    throw new HonuaKeplerBridgeError("invalid-request", "Kepler's Arrow processor returned no fields.");
  }
  const losses: KeplerFidelityLoss[] = [];
  const fields: KeplerField[] = [];
  const indexes: number[] = [];
  const seen = new Set<string>();

  for (const [index, source] of processed.fields.entries()) {
    if (typeof source?.name !== "string" || source.name.length === 0 || seen.has(source.name)) {
      throw new HonuaKeplerBridgeError(
        "invalid-request",
        "Kepler's Arrow processor returned invalid or duplicate field names.",
      );
    }
    seen.add(source.name);
    const sample = processed.rows.find((row) => row[index] !== null && row[index] !== undefined)?.[index];
    const type = request.temporalFields?.includes(source.name) ? "timestamp" : mappedFieldType(source.type, sample);
    if (type === undefined || (type === "geojson" && source.name !== request.geometryField)) {
      losses.push({
        kind: "unsupported-field-type",
        field: source.name,
        detail: `Kepler's Arrow processor returned unsupported field type "${source.type}"; the column was dropped.`,
      });
      continue;
    }
    fields.push(keplerField(source.name, type, source.displayName));
    indexes.push(index);
  }
  if (fields.length === 0) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "No Arrow field could be mapped into Kepler's ingestion model.",
    );
  }
  if (request.rowIdentityField !== undefined && !fields.some((field) => field.name === request.rowIdentityField)) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      `rowIdentityField "${request.rowIdentityField}" is not present in the Arrow table.`,
    );
  }
  if (request.geometryField !== undefined && !fields.some((field) => field.name === request.geometryField)) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      `geometryField "${request.geometryField}" is not a mapped Arrow field.`,
    );
  }
  const crs = resolveKeplerCrs(request.crs, request.geometryField !== undefined);
  const rows: unknown[][] = [];
  let bytes = 0;
  for (const sourceRow of processed.rows) {
    if (!Array.isArray(sourceRow) || sourceRow.length < processed.fields.length) {
      throw new HonuaKeplerBridgeError("invalid-request", "Kepler's Arrow processor returned a malformed row.");
    }
    const row: unknown[] = [];
    for (const [fieldIndex, sourceIndex] of indexes.entries()) {
      const type = fields[fieldIndex]?.type as KeplerFieldType;
      const raw = sourceRow[sourceIndex];
      if (
        typeof raw === "bigint" &&
        (type === "integer" || type === "real") &&
        (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER))
      ) {
        losses.push({
          kind: "numeric-precision-narrowed",
          field: fields[fieldIndex]?.name,
          detail: "An unsafe Arrow bigint was narrowed to a JavaScript number for Kepler ingestion.",
        });
      }
      if (isNestedValue(raw) && type === "string") {
        losses.push({
          kind: "nested-value-stringified",
          field: fields[fieldIndex]?.name,
          detail: "Nested Arrow values were JSON-stringified into a Kepler string column.",
        });
      }
      const value = normalizeKeplerValue(raw, type);
      bytes +=
        typeof value === "string"
          ? 2 * value.length
          : value !== null && typeof value === "object"
            ? jsonByteLength(value)
            : 8;
      row.push(value);
    }
    rows.push(row);
  }
  enforceKeplerDatasetLimits(rows.length, fields.length, bytes, limits);
  const diagnostic = keplerIngestionDiagnostic({
    strategy: "arrow-table-processor",
    rows: rows.length,
    fields: fields.length,
    geoJsonBytes: 0,
    losses,
  });
  const metadata = keplerDatasetMetadata({
    provenance,
    crs,
    ingestion: diagnostic,
    fields,
    ...(request.rowIdentityField === undefined ? {} : { rowIdentityField: request.rowIdentityField }),
    ...(request.temporalFields === undefined ? {} : { temporalFields: request.temporalFields }),
  });
  return Object.freeze({
    contractVersion: KEPLER_BRIDGE_CONTRACT_VERSION,
    dataset: Object.freeze({
      info: Object.freeze({ id: request.datasetId, label: request.label ?? request.datasetId }),
      data: Object.freeze({ fields: Object.freeze(fields), rows: Object.freeze(rows) }),
      metadata,
    }),
    diagnostic,
    metrics: Object.freeze({
      rows: rows.length,
      fields: fields.length,
      cells: rows.length * fields.length,
      geoJsonBytes: 0,
      estimatedRowBytes: bytes,
    }),
  });
}
