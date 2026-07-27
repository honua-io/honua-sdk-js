/**
 * Columnar-artifact ingestion (REQ-002).
 *
 * A Honua columnar artifact already carries typed, row-ordered columns. Kepler
 * ingests row-major `rows`, so the only work required is a bounded transpose:
 * the bridge reads each column in place and never builds a `FeatureCollection`,
 * never serializes geometry, and never calls Kepler's `processGeojson`.
 * `geoJsonBytes === 0` on this path is the measured evidence.
 *
 * Unsupported column layouts (nested `list`/`struct`/`map`/`union`, binary
 * payloads, or a declared type the bridge cannot map) are dropped with an
 * explicit `unsupported-column-layout` loss instead of being coerced.
 *
 * Kepler 3.x can also consume an Arrow table directly (`processArrowTable`).
 * That zero-copy path needs the `apache-arrow` peer plus Kepler's own
 * `geoarrow` field type and is declared unsupported by this contract version
 * rather than half-implemented — see `KEPLER_BRIDGE_CAPABILITIES`.
 *
 * @experimental
 * @module
 */

import {
  inferKeplerFieldType,
  isKnownColumnarType,
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
  KeplerBridgeLimits,
  KeplerColumnInput,
  KeplerColumnarProjectionRequest,
  KeplerDatasetProjection,
  KeplerFidelityLoss,
  KeplerField,
  KeplerFieldType,
} from "./types.js";
import { HonuaKeplerBridgeError, KEPLER_BRIDGE_CONTRACT_VERSION } from "./types.js";

interface ResolvedColumn {
  readonly field: KeplerField;
  readonly values: ArrayLike<unknown>;
}

function columnSample(values: ArrayLike<unknown>, rowCount: number): unknown {
  for (let index = 0; index < rowCount; index += 1) {
    const value = values[index];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function resolveColumnType(
  column: KeplerColumnInput,
  rowCount: number,
  losses: KeplerFidelityLoss[],
): KeplerFieldType | undefined {
  if (isKnownColumnarType(column.type)) {
    const mapped = keplerTypeForColumnarType(column.type);
    if (mapped === undefined) {
      losses.push({
        kind: "unsupported-column-layout",
        field: column.name,
        detail: `Columnar type "${column.type}" has no Kepler equivalent; the column was dropped rather than flattened.`,
      });
      return undefined;
    }
    return mapped;
  }
  const sample = columnSample(column.values, rowCount);
  if (isNestedValue(sample)) {
    losses.push({
      kind: "unsupported-column-layout",
      field: column.name,
      detail: `Column "${column.name}" declares unknown type "${column.type}" and holds nested values; the column was dropped.`,
    });
    return undefined;
  }
  const inferred = inferKeplerFieldType(sample);
  if (inferred === undefined) {
    losses.push({
      kind: "unsupported-column-layout",
      field: column.name,
      detail: `Column "${column.name}" declares unknown type "${column.type}" and carries no inferable values; the column was dropped.`,
    });
    return undefined;
  }
  return inferred;
}

/**
 * Project a bounded columnar artifact into a Kepler proto dataset with no
 * GeoJSON round trip. Point geometry is expressed as an existing
 * longitude/latitude column pair, which Kepler's point layer binds directly.
 */
export function projectColumnarBatchToKeplerDataset(
  request: KeplerColumnarProjectionRequest,
  limits: KeplerBridgeLimits = DEFAULT_KEPLER_BRIDGE_LIMITS,
): KeplerDatasetProjection {
  if (typeof request.datasetId !== "string" || request.datasetId.trim().length === 0) {
    throw new HonuaKeplerBridgeError("invalid-request", "A Kepler columnar projection requires a non-empty datasetId.");
  }
  if (!Number.isInteger(request.rowCount) || request.rowCount < 0) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "A Kepler columnar projection requires an integer rowCount >= 0.",
      {
        rowCount: request.rowCount,
      },
    );
  }
  if (!Array.isArray(request.columns) || request.columns.length === 0) {
    throw new HonuaKeplerBridgeError("invalid-request", "A Kepler columnar projection requires at least one column.");
  }
  const provenance = normalizeKeplerProvenance(request.provenance);
  const rowCount = request.rowCount;
  const losses: KeplerFidelityLoss[] = [];
  const temporalFields = new Set(request.temporalFields ?? []);
  const seen = new Set<string>();
  const resolved: ResolvedColumn[] = [];

  for (const column of request.columns) {
    if (typeof column?.name !== "string" || column.name.length === 0) {
      throw new HonuaKeplerBridgeError("invalid-request", "Every columnar column requires a non-empty name.");
    }
    if (seen.has(column.name)) {
      throw new HonuaKeplerBridgeError("invalid-request", `Duplicate columnar column name "${column.name}".`, {
        column: column.name,
      });
    }
    seen.add(column.name);
    const length = column.values?.length;
    if (typeof length !== "number" || length < rowCount) {
      throw new HonuaKeplerBridgeError(
        "invalid-request",
        `Column "${column.name}" carries ${length ?? 0} values but rowCount is ${rowCount}.`,
        { column: column.name, length, rowCount },
      );
    }
    const type = temporalFields.has(column.name) ? "timestamp" : resolveColumnType(column, rowCount, losses);
    if (type === undefined) continue;
    resolved.push({ field: keplerField(column.name, type), values: column.values });
  }

  if (resolved.length === 0) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "No columnar column could be mapped into Kepler's ingestion model.",
      { losses: losses.length },
    );
  }

  const pointColumns = request.pointColumns;
  if (pointColumns !== undefined) {
    for (const [role, name] of [
      ["longitude", pointColumns.longitude],
      ["latitude", pointColumns.latitude],
    ] as const) {
      const column = resolved.find((entry) => entry.field.name === name);
      if (column === undefined) {
        throw new HonuaKeplerBridgeError("invalid-request", `pointColumns.${role} "${name}" is not a mapped column.`, {
          role,
          column: name,
        });
      }
      if (column.field.type !== "real" && column.field.type !== "integer") {
        throw new HonuaKeplerBridgeError(
          "unsupported-geometry",
          `pointColumns.${role} "${name}" must be a numeric column; it mapped to Kepler type "${column.field.type}".`,
          { role, column: name, type: column.field.type },
        );
      }
    }
  }
  const crs = resolveKeplerCrs(request.crs, pointColumns !== undefined);

  if (
    request.rowIdentityField !== undefined &&
    !resolved.some((entry) => entry.field.name === request.rowIdentityField)
  ) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      `rowIdentityField "${request.rowIdentityField}" is not a mapped column.`,
      { rowIdentityField: request.rowIdentityField },
    );
  }

  const fields = resolved.map((entry) => entry.field);
  const rows: unknown[][] = [];
  let bytes = 0;
  let narrowed = 0;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: unknown[] = [];
    for (const entry of resolved) {
      const raw = entry.values[rowIndex];
      if (typeof raw === "bigint" && (raw > 9_007_199_254_740_991n || raw < -9_007_199_254_740_991n)) narrowed += 1;
      const value = normalizeKeplerValue(raw, entry.field.type);
      if (typeof value === "string") bytes += 2 * value.length;
      else if (value !== null && typeof value === "object") bytes += jsonByteLength(value);
      else bytes += 8;
      row.push(value);
    }
    rows.push(row);
  }
  if (narrowed > 0) {
    losses.push({
      kind: "numeric-precision-narrowed",
      detail: `${narrowed} 64-bit integer value(s) exceeded the IEEE-754 safe integer range and were narrowed for Kepler.`,
    });
  }

  enforceKeplerDatasetLimits(rows.length, fields.length, bytes, limits);
  const diagnostic = keplerIngestionDiagnostic({
    strategy: "columnar-columns-direct",
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
  });

  return Object.freeze({
    contractVersion: KEPLER_BRIDGE_CONTRACT_VERSION,
    dataset: Object.freeze({
      info: Object.freeze({ id: request.datasetId, label: request.label ?? request.datasetId }),
      data: Object.freeze({ fields: Object.freeze(fields), rows: Object.freeze(rows) }),
      metadata:
        pointColumns === undefined
          ? metadata
          : Object.freeze({ ...metadata, pointColumns: Object.freeze({ ...pointColumns }) }),
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
