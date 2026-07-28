/**
 * Explicit ingestion mappings from a bounded Honua result into Kepler's
 * `{ fields, rows }` model (REQ-002 / REQ-003).
 *
 * Mapping table:
 *
 * | Input | Strategy | GeoJSON round trip |
 * | --- | --- | --- |
 * | attribute rows / aggregate rows, no geometry | `row-object-direct` | no |
 * | point geometry (Esri `{x,y}` or GeoJSON `Point`) | `point-columns-direct` | no |
 * | line / polygon / multi-part geometry | `geojson-column` | yes (measured) |
 *
 * The direct paths never build a `FeatureCollection` and never call Kepler's
 * `processGeojson`; `KeplerIngestionDiagnostic.geoJsonBytes` is `0` and is the
 * measured evidence. The fallback records the exact serialized byte count so a
 * caller can see what the unsupported path costs.
 *
 * @experimental
 * @module
 */

import {
  inferKeplerFieldType,
  isNestedValue,
  keplerField,
  keplerTypeForEsriFieldType,
  normalizeKeplerValue,
  resolveKeplerCrs,
  unsupportedFieldLoss,
} from "./fields.js";
import { jsonByteLength, pointCoordinates, toKeplerGeoJsonGeometry } from "./geometry.js";
import { assertCredentialFreeScalar } from "./redaction.js";
import type {
  KeplerBridgeLimits,
  KeplerDatasetMetadata,
  KeplerDatasetProjection,
  KeplerFidelityLoss,
  KeplerField,
  KeplerFieldType,
  KeplerIngestionDiagnostic,
  KeplerIngestionStrategy,
  KeplerResultInput,
  KeplerResultProjectionRequest,
  KeplerSourceProvenance,
} from "./types.js";
import { HonuaKeplerBridgeError, KEPLER_BRIDGE_CONTRACT_VERSION } from "./types.js";

/** Conservative default budgets for one Kepler workspace (NFR-001). */
export const DEFAULT_KEPLER_BRIDGE_LIMITS: KeplerBridgeLimits = Object.freeze({
  maxDatasets: 16,
  maxRowsPerDataset: 250_000,
  maxFieldsPerDataset: 256,
  maxRetainedRowBytes: 128 * 1024 * 1024,
  maxDeltaRows: 10_000,
});

/** Kepler column name carrying a serialized GeoJSON feature on the fallback path. */
export const KEPLER_GEOJSON_COLUMN = "_geojson" as const;
/** Kepler column names carrying point geometry on the direct path. */
export const KEPLER_LONGITUDE_COLUMN = "longitude" as const;
export const KEPLER_LATITUDE_COLUMN = "latitude" as const;

export function normalizeKeplerLimits(limits?: Partial<KeplerBridgeLimits>): KeplerBridgeLimits {
  const merged = { ...DEFAULT_KEPLER_BRIDGE_LIMITS, ...limits };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new HonuaKeplerBridgeError("invalid-request", `Kepler bridge limit "${key}" must be a positive integer.`, {
        limit: key,
        value,
      });
    }
  }
  return Object.freeze(merged);
}

/** Validate the caller-declared provenance record and reject credential-shaped values. */
export function normalizeKeplerProvenance(provenance: KeplerSourceProvenance): KeplerSourceProvenance {
  if (
    typeof provenance !== "object" ||
    provenance === null ||
    typeof provenance.sourceId !== "string" ||
    provenance.sourceId.length === 0
  ) {
    throw new HonuaKeplerBridgeError("invalid-request", "A Kepler projection requires provenance with a sourceId.");
  }
  if (provenance.authorizationScope !== undefined) {
    assertCredentialFreeScalar(provenance.authorizationScope, "provenance.authorizationScope");
  }
  if (provenance.attribution !== undefined) {
    assertCredentialFreeScalar(provenance.attribution, "provenance.attribution");
  }
  return Object.freeze({
    ...provenance,
    ...(provenance.degraded ? { degraded: Object.freeze([...provenance.degraded]) } : {}),
  });
}

function requireDatasetId(datasetId: unknown): string {
  if (typeof datasetId !== "string" || datasetId.trim().length === 0) {
    throw new HonuaKeplerBridgeError("invalid-request", "A Kepler projection requires a non-empty datasetId.");
  }
  return datasetId;
}

interface ColumnPlan {
  readonly attribute: string;
  readonly field: KeplerField;
}

interface RowAccumulator {
  readonly rows: unknown[][];
  bytes: number;
}

function accumulateValueBytes(accumulator: RowAccumulator, value: unknown): void {
  if (typeof value === "string") accumulator.bytes += 2 * value.length;
  else if (value !== null && typeof value === "object") accumulator.bytes += jsonByteLength(value);
  else accumulator.bytes += 8;
}

function firstNonNullSample(rows: ReadonlyArray<Readonly<Record<string, unknown>>>, attribute: string): unknown {
  for (const row of rows) {
    const value = row[attribute];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Resolve the deterministic column plan: declared schema order first, then any
 * attribute discovered in the rows but absent from the schema, sorted by name.
 */
function planColumns(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  declaredFields: KeplerResultInput["fields"],
  temporalFields: ReadonlySet<string>,
  losses: KeplerFidelityLoss[],
): ColumnPlan[] {
  const plans: ColumnPlan[] = [];
  const claimed = new Set<string>();

  const consider = (name: string, declaredType: string | undefined, alias: string | undefined): void => {
    if (claimed.has(name)) return;
    claimed.add(name);
    let type: KeplerFieldType | undefined;
    if (temporalFields.has(name)) {
      type = "timestamp";
    } else if (declaredType !== undefined) {
      type = keplerTypeForEsriFieldType(declaredType);
      if (type === undefined) {
        losses.push(unsupportedFieldLoss(name, declaredType));
        return;
      }
      if (type === "geojson") {
        losses.push({
          kind: "unsupported-field-type",
          field: name,
          detail: "A declared geometry attribute is projected through the geometry column, not as an attribute.",
        });
        return;
      }
    } else {
      const sample = firstNonNullSample(rows, name);
      if (isNestedValue(sample)) {
        type = "string";
        losses.push({
          kind: "nested-value-stringified",
          field: name,
          detail: "Nested attribute values are JSON-stringified into a Kepler string column.",
        });
      } else {
        type = inferKeplerFieldType(sample) ?? "string";
      }
    }
    plans.push({ attribute: name, field: keplerField(name, type, alias) });
  };

  for (const declared of declaredFields ?? []) {
    if (typeof declared?.name !== "string" || declared.name.length === 0) continue;
    consider(declared.name, declared.type, declared.alias);
  }
  const discovered = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!claimed.has(key)) discovered.add(key);
  }
  for (const name of [...discovered].sort()) consider(name, undefined, undefined);
  return plans;
}

type GeometryPlan =
  | { readonly strategy: "row-object-direct" }
  | { readonly strategy: "point-columns-direct"; readonly longitude: string; readonly latitude: string }
  | { readonly strategy: "geojson-column"; readonly column: string };

function uniqueColumnName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 1; suffix <= 64; suffix += 1) {
    const candidate = `_${base}${suffix === 1 ? "" : suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new HonuaKeplerBridgeError("invalid-request", `Unable to allocate a free Kepler column name for "${base}".`);
}

function resolveGeometryPlan(
  features: KeplerResultInput["features"],
  taken: ReadonlySet<string>,
  forceGeoJson: boolean,
): GeometryPlan {
  let sawGeometry = false;
  let allPoints = true;
  for (const feature of features) {
    const geometry = feature.geometry;
    if (geometry === undefined || geometry === null) continue;
    sawGeometry = true;
    if (pointCoordinates(geometry) === undefined) {
      allPoints = false;
      break;
    }
  }
  if (!sawGeometry) return { strategy: "row-object-direct" };
  if (allPoints && !forceGeoJson) {
    return {
      strategy: "point-columns-direct",
      longitude: uniqueColumnName(KEPLER_LONGITUDE_COLUMN, taken),
      latitude: uniqueColumnName(KEPLER_LATITUDE_COLUMN, taken),
    };
  }
  return { strategy: "geojson-column", column: uniqueColumnName(KEPLER_GEOJSON_COLUMN, taken) };
}

function strategyReason(strategy: KeplerIngestionStrategy): string {
  switch (strategy) {
    case "row-object-direct":
      return "Attribute rows were written straight into Kepler's tabular model; no geometry and no GeoJSON conversion.";
    case "point-columns-direct":
      return "Point geometry was split into longitude/latitude real columns, so Kepler ingests rows without a GeoJSON round trip.";
    case "geojson-column":
      return "Kepler has no direct binary or tabular path for line/polygon/multi-part geometry, so geometry was serialized into a GeoJSON column.";
    case "columnar-columns-direct":
      return "Columnar artifact columns were transposed into Kepler rows in place; no GeoJSON conversion.";
    case "remote-basemap-style":
      return "The remote source was projected into a Kepler custom basemap entry; Kepler fetches its tiles itself.";
    case "remote-vector-tileset":
      return "The remote source was projected into a Kepler tileset dataset descriptor; Kepler fetches its tiles itself.";
  }
}

export function keplerIngestionDiagnostic(input: {
  readonly strategy: KeplerIngestionStrategy;
  readonly rows: number;
  readonly fields: number;
  readonly geoJsonBytes: number;
  readonly losses: readonly KeplerFidelityLoss[];
}): KeplerIngestionDiagnostic {
  return Object.freeze({
    strategy: input.strategy,
    geoJsonRoundTrip: input.geoJsonBytes > 0,
    geoJsonBytes: input.geoJsonBytes,
    fidelity: input.losses.length === 0 ? "exact" : "lossy",
    rows: input.rows,
    fields: input.fields,
    losses: Object.freeze([...input.losses]),
    reason: strategyReason(input.strategy),
  });
}

export function keplerDatasetMetadata(input: {
  readonly provenance: KeplerSourceProvenance;
  readonly crs: KeplerDatasetMetadata["crs"];
  readonly ingestion: KeplerIngestionDiagnostic;
  readonly fields: readonly KeplerField[];
  readonly rowIdentityField?: string;
}): KeplerDatasetMetadata {
  return Object.freeze({
    honuaBridgeVersion: KEPLER_BRIDGE_CONTRACT_VERSION,
    provenance: input.provenance,
    crs: input.crs,
    ingestion: input.ingestion,
    temporalFields: Object.freeze(
      input.fields.filter((field) => field.type === "timestamp").map((field) => field.name),
    ),
    ...(input.rowIdentityField === undefined ? {} : { rowIdentityField: input.rowIdentityField }),
  });
}

export function enforceKeplerDatasetLimits(
  rows: number,
  fields: number,
  bytes: number,
  limits: KeplerBridgeLimits,
): void {
  if (rows > limits.maxRowsPerDataset) {
    throw new HonuaKeplerBridgeError(
      "limit-exceeded",
      `A Kepler dataset may carry at most ${limits.maxRowsPerDataset} rows; the projection produced ${rows}. Page or aggregate the result first.`,
      { rows, maxRowsPerDataset: limits.maxRowsPerDataset },
    );
  }
  if (fields > limits.maxFieldsPerDataset) {
    throw new HonuaKeplerBridgeError(
      "limit-exceeded",
      `A Kepler dataset may carry at most ${limits.maxFieldsPerDataset} fields; the projection produced ${fields}.`,
      { fields, maxFieldsPerDataset: limits.maxFieldsPerDataset },
    );
  }
  if (bytes > limits.maxRetainedRowBytes) {
    throw new HonuaKeplerBridgeError(
      "limit-exceeded",
      `The projected rows are approximately ${bytes} bytes, over the ${limits.maxRetainedRowBytes}-byte workspace budget.`,
      { bytes, maxRetainedRowBytes: limits.maxRetainedRowBytes },
    );
  }
}

/**
 * Project a bounded Honua `Result` (or its aggregate rows) into a Kepler proto
 * dataset. Point geometry and pure tabular results take a direct path with no
 * GeoJSON conversion; other geometry falls back to a measured GeoJSON column.
 */
export function projectResultToKeplerDataset(
  request: KeplerResultProjectionRequest,
  limits: KeplerBridgeLimits = DEFAULT_KEPLER_BRIDGE_LIMITS,
): KeplerDatasetProjection {
  const datasetId = requireDatasetId(request.datasetId);
  const provenance = normalizeKeplerProvenance(request.provenance);
  const result = request.result;
  if (typeof result !== "object" || result === null || !Array.isArray(result.features)) {
    throw new HonuaKeplerBridgeError("invalid-request", "A Kepler result projection requires result.features.");
  }
  const losses: KeplerFidelityLoss[] = [];
  const useAggregates = result.features.length === 0 && (result.aggregateRows?.length ?? 0) > 0;
  const attributeRows: ReadonlyArray<Readonly<Record<string, unknown>>> = useAggregates
    ? (result.aggregateRows ?? [])
    : result.features.map((feature) => {
        if (typeof feature?.attributes !== "object" || feature.attributes === null) {
          throw new HonuaKeplerBridgeError("invalid-request", "Every projected feature requires an attributes object.");
        }
        return feature.attributes;
      });

  const temporalFields = new Set(request.temporalFields ?? []);
  const declaredFields = useAggregates ? undefined : result.fields;
  const plans = planColumns(attributeRows, declaredFields, temporalFields, losses);
  const taken = new Set(plans.map((plan) => plan.field.name));
  const geometryPlan = useAggregates
    ? ({ strategy: "row-object-direct" } as GeometryPlan)
    : resolveGeometryPlan(result.features, taken, request.forceGeoJsonColumn === true);
  const crs = resolveKeplerCrs(request.crs, geometryPlan.strategy !== "row-object-direct");

  if (request.rowIdentityField !== undefined && !plans.some((plan) => plan.attribute === request.rowIdentityField)) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      `rowIdentityField "${request.rowIdentityField}" is not a projected attribute column.`,
      { rowIdentityField: request.rowIdentityField },
    );
  }

  const fields: KeplerField[] = plans.map((plan) => plan.field);
  if (geometryPlan.strategy === "point-columns-direct") {
    fields.push(keplerField(geometryPlan.longitude, "real"), keplerField(geometryPlan.latitude, "real"));
  } else if (geometryPlan.strategy === "geojson-column") {
    fields.push(keplerField(geometryPlan.column, "geojson"));
  }

  const accumulator: RowAccumulator = { rows: [], bytes: 0 };
  const nestedReported = new Set(losses.filter((loss) => loss.field !== undefined).map((loss) => loss.field as string));
  let geoJsonBytes = 0;
  let nullGeometry = 0;

  for (let index = 0; index < attributeRows.length; index += 1) {
    const attributes = attributeRows[index];
    const row: unknown[] = [];
    for (const plan of plans) {
      const raw = attributes[plan.attribute];
      if (plan.field.type === "string" && isNestedValue(raw) && !nestedReported.has(plan.attribute)) {
        nestedReported.add(plan.attribute);
        losses.push({
          kind: "nested-value-stringified",
          field: plan.attribute,
          detail: "Nested attribute values are JSON-stringified into a Kepler string column.",
        });
      }
      const value = normalizeKeplerValue(raw, plan.field.type);
      accumulateValueBytes(accumulator, value);
      row.push(value);
    }
    if (geometryPlan.strategy !== "row-object-direct") {
      const geometry = result.features[index]?.geometry ?? null;
      if (geometryPlan.strategy === "point-columns-direct") {
        const point = pointCoordinates(geometry);
        if (point === undefined) nullGeometry += 1;
        row.push(point?.[0] ?? null, point?.[1] ?? null);
        accumulator.bytes += 16;
      } else {
        const geoJson = toKeplerGeoJsonGeometry(geometry);
        if (geoJson === null) {
          nullGeometry += 1;
          row.push(null);
          accumulator.bytes += 8;
        } else {
          const feature = { type: "Feature", geometry: geoJson, properties: {} };
          const bytes = jsonByteLength(feature);
          geoJsonBytes += bytes;
          accumulator.bytes += bytes;
          row.push(feature);
        }
      }
    }
    accumulator.rows.push(row);
  }

  if (geometryPlan.strategy === "geojson-column" && geoJsonBytes > 0) {
    losses.push({
      kind: "geometry-serialized-to-geojson",
      field: geometryPlan.column,
      detail: `Kepler has no direct path for this geometry, so ${geoJsonBytes} byte(s) of GeoJSON were serialized into the "${geometryPlan.column}" column.`,
    });
  }
  if (nullGeometry > 0) {
    losses.push({
      kind: "null-geometry-dropped",
      detail: `${nullGeometry} feature(s) carried absent or unrecognized geometry and project without coordinates.`,
    });
  }
  if (result.exceededTransferLimit === true) {
    losses.push({
      kind: "row-limit-truncated",
      detail:
        "The source reported exceededTransferLimit; the Kepler workspace holds a truncated page, not the full set.",
    });
  }
  for (const note of result.degraded ?? []) {
    losses.push({
      kind: "unsupported-field-type",
      detail: `Source degradation carried into the workspace: ${note.capability} — ${note.reason}`,
    });
  }

  enforceKeplerDatasetLimits(accumulator.rows.length, fields.length, accumulator.bytes, limits);
  const diagnostic = keplerIngestionDiagnostic({
    strategy: geometryPlan.strategy,
    rows: accumulator.rows.length,
    fields: fields.length,
    geoJsonBytes,
    losses,
  });
  const baseMetadata = keplerDatasetMetadata({
    provenance,
    crs,
    ingestion: diagnostic,
    fields,
    ...(request.rowIdentityField === undefined ? {} : { rowIdentityField: request.rowIdentityField }),
  });
  const metadata =
    geometryPlan.strategy === "point-columns-direct"
      ? Object.freeze({
          ...baseMetadata,
          pointColumns: Object.freeze({ longitude: geometryPlan.longitude, latitude: geometryPlan.latitude }),
        })
      : baseMetadata;

  return Object.freeze({
    contractVersion: KEPLER_BRIDGE_CONTRACT_VERSION,
    dataset: Object.freeze({
      info: Object.freeze({ id: datasetId, label: request.label ?? datasetId }),
      data: Object.freeze({ fields: Object.freeze(fields), rows: Object.freeze(accumulator.rows) }),
      metadata,
    }),
    diagnostic,
    metrics: Object.freeze({
      rows: accumulator.rows.length,
      fields: fields.length,
      cells: accumulator.rows.length * fields.length,
      geoJsonBytes,
      estimatedRowBytes: accumulator.bytes,
    }),
  });
}
