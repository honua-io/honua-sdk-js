import type {
  DecodedGeoArrowRow,
  GeoArrowConversionLimits,
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
