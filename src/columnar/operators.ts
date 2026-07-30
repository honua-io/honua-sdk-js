import type {
  ColumnarBatchIdentityV1,
  DecodedGeoArrowRow,
  GeoArrowConversionLimits,
  GeoArrowCrs,
  GeoArrowGeometryColumnInput,
  GeoArrowTimestampUnit,
} from "./geoarrow-types.js";
import { createGeoArrowBatch, decodeGeoArrowBatch, inspectGeoArrowBatch } from "./geoarrow.js";
import type { ColumnarBatchV1 } from "./types.js";
import type { ColumnarWorkerOperation, ColumnarWorkerOperationContext } from "./worker.js";

/** A worker-safe predicate over one decoded GeoArrow row. */
export type GeoArrowRowPredicate = (row: DecodedGeoArrowRow, index: number) => boolean | Promise<boolean>;

/** Options for the bounded GeoArrow row-filter worker operation. */
export interface CreateGeoArrowFilterOperationOptions extends GeoArrowConversionLimits {
  /** Stable id assigned to the filtered output batch. */
  readonly id: string;
  readonly predicate: GeoArrowRowPredicate;
}

export type GeoArrowProjectionColumn = "geometry" | "temporal" | "dictionary" | "featureId";

/** Options for the bounded GeoArrow column-projection worker operation. */
export interface CreateGeoArrowProjectionOperationOptions extends GeoArrowConversionLimits {
  /** Stable id assigned to the projected output batch. */
  readonly id: string;
  /** Schema id for the projected field set. */
  readonly schemaId: string;
  /** Identity for the projected schema; callers must provide its schema version. */
  readonly identity: ColumnarBatchIdentityV1;
  /** Columns to retain. Geometry is always retained even when omitted. */
  readonly columns?: readonly GeoArrowProjectionColumn[];
}

/** Options for a bounded XY affine transform of a GeoArrow batch. */
export interface CreateGeoArrowTransformOperationOptions extends GeoArrowConversionLimits {
  /** Stable id assigned to the transformed output batch. */
  readonly id: string;
  /** Schema id for the transformed coordinate field set. */
  readonly schemaId: string;
  /** Identity for the transformed schema and coordinate semantics. */
  readonly identity: ColumnarBatchIdentityV1;
  /** Multipliers applied to X and Y. Defaults to `[1, 1]`. */
  readonly scale?: readonly [number, number];
  /** Offsets added to X and Y after scaling. Defaults to `[0, 0]`. */
  readonly translate?: readonly [number, number];
  /** Optional replacement CRS; omitted means preserve the source CRS metadata. */
  readonly outputCrs?: GeoArrowCrs;
}

/**
 * Create a deterministic GeoArrow row filter for registration with
 * `startColumnarWorkerHost`.
 *
 * The operation intentionally decodes only the normative GeoArrow row view and
 * re-encodes the selected rows into a new bounded batch. It preserves geometry
 * metadata, temporal values, dictionary values, feature ids, and source
 * identity while omitting `rowOffset` because a filtered batch is not a
 * contiguous source range.
 */
export function createGeoArrowFilterOperation(options: CreateGeoArrowFilterOperationOptions): ColumnarWorkerOperation {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("GeoArrow filter options must be an object");
  }
  if (typeof options.id !== "string" || options.id.trim() !== options.id || options.id.length === 0) {
    throw new TypeError("GeoArrow filter id must be a non-empty trimmed string");
  }
  if (typeof options.predicate !== "function") {
    throw new TypeError("GeoArrow filter predicate must be a function");
  }
  const limits = { ...options };
  delete (limits as { id?: string }).id;
  delete (limits as { predicate?: GeoArrowRowPredicate }).predicate;

  return async (batch: ColumnarBatchV1, context: ColumnarWorkerOperationContext): Promise<ColumnarBatchV1> => {
    const inspection = inspectGeoArrowBatch(batch, limits);
    if (!batch.identity) throw new TypeError("GeoArrow filter requires batch identity");
    const decoded = decodeGeoArrowBatch(batch, limits);
    const selected: DecodedGeoArrowRow[] = [];
    for (let index = 0; index < decoded.rows.length; index += 1) {
      if (context.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const keep = await options.predicate(decoded.rows[index]!, index);
      if (typeof keep !== "boolean") throw new TypeError("GeoArrow filter predicate must return a boolean");
      if (keep) selected.push(decoded.rows[index]!);
      if (index === decoded.rows.length - 1 || index % 256 === 0) {
        context.reportProgress(decoded.rows.length === 0 ? 1 : (index + 1) / decoded.rows.length, "filter");
      }
    }

    const geometry: GeoArrowGeometryColumnInput = {
      kind: inspection.geometry.kind,
      field: inspection.geometry.field,
      dimensions: inspection.geometry.dimensions,
      coordinateLayout: inspection.geometry.coordinateLayout,
      ...(inspection.geometry.crs === undefined ? {} : { crs: inspection.geometry.crs }),
      edges: inspection.geometry.edges,
      values: selected.map((row) => row.geometry),
    } as GeoArrowGeometryColumnInput;
    const temporal = inspection.temporal
      ? {
          field: inspection.temporal.field,
          unit: inspection.temporal.unit as GeoArrowTimestampUnit,
          ...(inspection.temporal.timezone === undefined ? {} : { timezone: inspection.temporal.timezone }),
          values: selected.map((row) => row.timestamp ?? null),
        }
      : undefined;
    const dictionary = inspection.dictionary
      ? {
          field: inspection.dictionary.field,
          ordered: inspection.dictionary.ordered,
          values: selected.map((row) => row.dictionaryValue ?? null),
        }
      : undefined;
    const featureIds = inspection.featureIds
      ? { field: inspection.featureIds.field, values: selected.map((row) => row.featureId ?? 0) }
      : undefined;
    return createGeoArrowBatch(
      {
        id: options.id,
        sequence: batch.sequence,
        schemaId: batch.schema.id,
        identity: batch.identity,
        geometry,
        ...(temporal === undefined ? {} : { temporal }),
        ...(dictionary === undefined ? {} : { dictionary }),
        ...(featureIds === undefined ? {} : { featureIds }),
      },
      limits,
    ).batch;
  };
}

/**
 * Create a deterministic GeoArrow column projection for registration with
 * `startColumnarWorkerHost`.
 *
 * Geometry is mandatory in the normative batch. Optional temporal, dictionary,
 * and feature-id columns are retained only when requested. A new schema id and
 * identity are required because the projected field set is a distinct cache and
 * authorization-visible result, even though row order and values are unchanged.
 */
export function createGeoArrowProjectionOperation(
  options: CreateGeoArrowProjectionOperationOptions,
): ColumnarWorkerOperation {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("GeoArrow projection options must be an object");
  }
  if (typeof options.id !== "string" || options.id.trim() !== options.id || options.id.length === 0) {
    throw new TypeError("GeoArrow projection id must be a non-empty trimmed string");
  }
  if (
    typeof options.schemaId !== "string" ||
    options.schemaId.trim() !== options.schemaId ||
    options.schemaId.length === 0
  ) {
    throw new TypeError("GeoArrow projection schemaId must be a non-empty trimmed string");
  }
  if (typeof options.identity !== "object" || options.identity === null) {
    throw new TypeError("GeoArrow projection identity must be an object");
  }
  const columns: GeoArrowProjectionColumn[] = options.columns === undefined ? ["geometry"] : [...options.columns];
  const allowed = new Set<GeoArrowProjectionColumn>(["geometry", "temporal", "dictionary", "featureId"]);
  if (columns.length !== new Set(columns).size || columns.some((column) => !allowed.has(column))) {
    throw new TypeError("GeoArrow projection columns must be unique supported column names");
  }
  const limits = { ...options };
  delete (limits as { id?: string }).id;
  delete (limits as { schemaId?: string }).schemaId;
  delete (limits as { identity?: ColumnarBatchIdentityV1 }).identity;
  delete (limits as { columns?: readonly GeoArrowProjectionColumn[] }).columns;
  const wants = new Set(columns);

  return async (batch: ColumnarBatchV1, context: ColumnarWorkerOperationContext): Promise<ColumnarBatchV1> => {
    const inspection = inspectGeoArrowBatch(batch, limits);
    if (wants.has("temporal") && inspection.temporal === undefined) {
      throw new TypeError("GeoArrow projection requested a missing temporal column");
    }
    if (wants.has("dictionary") && inspection.dictionary === undefined) {
      throw new TypeError("GeoArrow projection requested a missing dictionary column");
    }
    if (wants.has("featureId") && inspection.featureIds === undefined) {
      throw new TypeError("GeoArrow projection requested a missing feature-id column");
    }
    const decoded = decodeGeoArrowBatch(batch, limits);
    const geometryValues: Array<DecodedGeoArrowRow["geometry"]> = [];
    const temporalValues: Array<bigint | null> = [];
    const dictionaryValues: Array<string | null> = [];
    const featureIdValues: number[] = [];
    for (let index = 0; index < decoded.rows.length; index += 1) {
      if (context.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const row = decoded.rows[index]!;
      geometryValues.push(row.geometry);
      if (wants.has("temporal")) temporalValues.push(row.timestamp ?? null);
      if (wants.has("dictionary")) dictionaryValues.push(row.dictionaryValue ?? null);
      if (wants.has("featureId")) featureIdValues.push(row.featureId!);
      if (index === decoded.rows.length - 1 || index % 256 === 0) {
        context.reportProgress(decoded.rows.length === 0 ? 1 : (index + 1) / decoded.rows.length, "projection");
      }
    }
    const geometry: GeoArrowGeometryColumnInput = {
      kind: inspection.geometry.kind,
      field: inspection.geometry.field,
      dimensions: inspection.geometry.dimensions,
      coordinateLayout: inspection.geometry.coordinateLayout,
      ...(inspection.geometry.crs === undefined ? {} : { crs: inspection.geometry.crs }),
      edges: inspection.geometry.edges,
      values: geometryValues,
    } as GeoArrowGeometryColumnInput;
    const temporal = wants.has("temporal")
      ? (() => {
          const temporalInspection = inspection.temporal;
          if (temporalInspection === undefined) {
            throw new TypeError("GeoArrow projection requested a missing temporal column");
          }
          return {
            field: temporalInspection.field,
            unit: temporalInspection.unit,
            ...(temporalInspection.timezone === undefined ? {} : { timezone: temporalInspection.timezone }),
            values: temporalValues,
          };
        })()
      : undefined;
    const dictionary = wants.has("dictionary")
      ? { field: inspection.dictionary!.field, ordered: inspection.dictionary!.ordered, values: dictionaryValues }
      : undefined;
    const featureIds = wants.has("featureId")
      ? { field: inspection.featureIds!.field, values: featureIdValues }
      : undefined;
    return createGeoArrowBatch(
      {
        id: options.id,
        sequence: batch.sequence,
        ...(batch.rowOffset === undefined ? {} : { rowOffset: batch.rowOffset }),
        schemaId: options.schemaId,
        identity: options.identity,
        geometry,
        ...(temporal === undefined ? {} : { temporal }),
        ...(dictionary === undefined ? {} : { dictionary }),
        ...(featureIds === undefined ? {} : { featureIds }),
      },
      limits,
    ).batch;
  };
}

/**
 * Create a bounded XY affine transform for registration with
 * `startColumnarWorkerHost`.
 *
 * The operation transforms every coordinate while preserving Z/M ordinates,
 * row order, nulls, temporal values, dictionary values, feature ids, and
 * batch identity fields supplied by the caller. A new id, schema id, and
 * identity are required because coordinate semantics are part of the cache
 * and authorization-visible result contract.
 */
export function createGeoArrowTransformOperation(
  options: CreateGeoArrowTransformOperationOptions,
): ColumnarWorkerOperation {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("GeoArrow transform options must be an object");
  }
  if (typeof options.id !== "string" || options.id.trim() !== options.id || options.id.length === 0) {
    throw new TypeError("GeoArrow transform id must be a non-empty trimmed string");
  }
  if (
    typeof options.schemaId !== "string" ||
    options.schemaId.trim() !== options.schemaId ||
    options.schemaId.length === 0
  ) {
    throw new TypeError("GeoArrow transform schemaId must be a non-empty trimmed string");
  }
  if (typeof options.identity !== "object" || options.identity === null) {
    throw new TypeError("GeoArrow transform identity must be an object");
  }
  const scale = normalizeAffinePair(options.scale, [1, 1], "scale");
  const translate = normalizeAffinePair(options.translate, [0, 0], "translate");
  const limits = { ...options };
  delete (limits as { id?: string }).id;
  delete (limits as { schemaId?: string }).schemaId;
  delete (limits as { identity?: ColumnarBatchIdentityV1 }).identity;
  delete (limits as { scale?: readonly [number, number] }).scale;
  delete (limits as { translate?: readonly [number, number] }).translate;
  delete (limits as { outputCrs?: GeoArrowCrs }).outputCrs;

  return async (batch: ColumnarBatchV1, context: ColumnarWorkerOperationContext): Promise<ColumnarBatchV1> => {
    const inspection = inspectGeoArrowBatch(batch, limits);
    const decoded = decodeGeoArrowBatch(batch, limits);
    const geometryValues: Array<DecodedGeoArrowRow["geometry"]> = [];
    for (let index = 0; index < decoded.rows.length; index += 1) {
      if (context.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      geometryValues.push(transformGeometry(decoded.rows[index]!.geometry, scale, translate));
      if (index === decoded.rows.length - 1 || index % 256 === 0) {
        context.reportProgress(decoded.rows.length === 0 ? 1 : (index + 1) / decoded.rows.length, "transform");
      }
    }
    if (decoded.rows.length === 0) context.reportProgress(1, "transform");
    const geometry: GeoArrowGeometryColumnInput = {
      kind: inspection.geometry.kind,
      field: inspection.geometry.field,
      dimensions: inspection.geometry.dimensions,
      coordinateLayout: inspection.geometry.coordinateLayout,
      ...(options.outputCrs === undefined
        ? inspection.geometry.crs === undefined
          ? {}
          : { crs: inspection.geometry.crs }
        : { crs: options.outputCrs }),
      edges: inspection.geometry.edges,
      values: geometryValues,
    } as GeoArrowGeometryColumnInput;
    const temporal = inspection.temporal
      ? {
          field: inspection.temporal.field,
          unit: inspection.temporal.unit as GeoArrowTimestampUnit,
          ...(inspection.temporal.timezone === undefined ? {} : { timezone: inspection.temporal.timezone }),
          values: decoded.rows.map((row) => row.timestamp ?? null),
        }
      : undefined;
    const dictionary = inspection.dictionary
      ? {
          field: inspection.dictionary.field,
          ordered: inspection.dictionary.ordered,
          values: decoded.rows.map((row) => row.dictionaryValue ?? null),
        }
      : undefined;
    const featureIds = inspection.featureIds
      ? { field: inspection.featureIds.field, values: decoded.rows.map((row) => row.featureId ?? 0) }
      : undefined;
    return createGeoArrowBatch(
      {
        id: options.id,
        sequence: batch.sequence,
        ...(batch.rowOffset === undefined ? {} : { rowOffset: batch.rowOffset }),
        schemaId: options.schemaId,
        identity: options.identity,
        geometry,
        ...(temporal === undefined ? {} : { temporal }),
        ...(dictionary === undefined ? {} : { dictionary }),
        ...(featureIds === undefined ? {} : { featureIds }),
      },
      limits,
    ).batch;
  };
}

function normalizeAffinePair(
  value: readonly [number, number] | undefined,
  fallback: readonly [number, number],
  name: string,
): readonly [number, number] {
  const pair = value ?? fallback;
  if (pair.length !== 2 || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) {
    throw new TypeError(`GeoArrow transform ${name} must contain exactly two finite numbers`);
  }
  return [pair[0], pair[1]];
}

function transformGeometry(
  geometry: DecodedGeoArrowRow["geometry"],
  scale: readonly [number, number],
  translate: readonly [number, number],
): DecodedGeoArrowRow["geometry"] {
  if (geometry === null) return null;
  if (geometry.length === 0 || typeof geometry[0] === "number") {
    return transformPosition(geometry as readonly number[], scale, translate);
  }
  if (typeof geometry[0]![0] === "number") {
    return (geometry as readonly (readonly number[])[]).map((position) =>
      transformPosition(position, scale, translate),
    );
  }
  return (geometry as readonly (readonly (readonly number[])[])[]).map((part) =>
    part.map((position) => transformPosition(position, scale, translate)),
  );
}

function transformPosition(
  position: readonly number[],
  scale: readonly [number, number],
  translate: readonly [number, number],
): readonly number[] {
  return [position[0]! * scale[0] + translate[0], position[1]! * scale[1] + translate[1], ...position.slice(2)];
}
