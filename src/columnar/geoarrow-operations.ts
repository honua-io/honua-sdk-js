import type {
  CreateGeoArrowBatchInput,
  GeoArrowConversionLimits,
  GeoArrowLineString,
  GeoArrowPoint,
  GeoArrowPolygon,
} from "./geoarrow-types.js";
import { createGeoArrowBatch, decodeGeoArrowBatch, inspectGeoArrowBatch } from "./geoarrow.js";
import type { ColumnarBatchIdentityV1, ColumnarBatchV1 } from "./types.js";
import type { ColumnarWorkerOperation, ColumnarWorkerOperationContext } from "./worker.js";

export type GeoArrowProjectionColumn = "temporal" | "dictionary" | "featureIds";

export interface CreateGeoArrowProjectionOperationOptions {
  /** The schema identity must change when the projected field set changes. */
  readonly schemaId: string;
  /** The caller supplies the complete identity for the projected result. */
  readonly identity: ColumnarBatchIdentityV1;
  /** Additional conversion ceilings applied to both decode and encode. */
  readonly limits?: GeoArrowConversionLimits;
  /** Columns to retain in addition to geometry. Defaults to all present columns. */
  readonly include?: readonly GeoArrowProjectionColumn[];
}

const PROJECTION_COLUMNS: readonly GeoArrowProjectionColumn[] = ["temporal", "dictionary", "featureIds"];

function selectedColumns(
  include: readonly GeoArrowProjectionColumn[] | undefined,
): ReadonlySet<GeoArrowProjectionColumn> {
  const values = include ?? PROJECTION_COLUMNS;
  const result = new Set<GeoArrowProjectionColumn>();
  for (const value of values) {
    if (!PROJECTION_COLUMNS.includes(value)) {
      throw new TypeError(`Unknown GeoArrow projection column "${String(value)}".`);
    }
    result.add(value);
  }
  return result;
}

/**
 * Create a bounded worker operation that removes selected optional GeoArrow
 * columns without changing row order or geometry. The output identity and
 * schema are explicit because projection changes the batch contract.
 */
export function createGeoArrowProjectionOperation(
  options: CreateGeoArrowProjectionOperationOptions,
): ColumnarWorkerOperation {
  const columns = selectedColumns(options.include);
  const limits = options.limits ?? {};
  const schemaId = options.schemaId;
  const identity = options.identity;

  return (batch: ColumnarBatchV1, context: ColumnarWorkerOperationContext): ColumnarBatchV1 => {
    context.signal.throwIfAborted();
    context.reportProgress(0, "decode");
    const inspection = inspectGeoArrowBatch(batch, limits);
    const decoded = decodeGeoArrowBatch(batch, limits);
    context.signal.throwIfAborted();
    context.reportProgress(0.5, "project");

    const values = decoded.rows.map((row) => row.geometry);
    const geometry: CreateGeoArrowBatchInput["geometry"] =
      inspection.geometry.kind === "point"
        ? {
            kind: "point",
            field: inspection.geometry.field,
            dimensions: inspection.geometry.dimensions,
            coordinateLayout: inspection.geometry.coordinateLayout,
            ...(inspection.geometry.crs === undefined ? {} : { crs: inspection.geometry.crs }),
            edges: inspection.geometry.edges,
            values: values as readonly (GeoArrowPoint | null)[],
          }
        : inspection.geometry.kind === "linestring"
          ? {
              kind: "linestring",
              field: inspection.geometry.field,
              dimensions: inspection.geometry.dimensions,
              coordinateLayout: inspection.geometry.coordinateLayout,
              ...(inspection.geometry.crs === undefined ? {} : { crs: inspection.geometry.crs }),
              edges: inspection.geometry.edges,
              values: values as readonly (GeoArrowLineString | null)[],
            }
          : {
              kind: "polygon",
              field: inspection.geometry.field,
              dimensions: inspection.geometry.dimensions,
              coordinateLayout: inspection.geometry.coordinateLayout,
              ...(inspection.geometry.crs === undefined ? {} : { crs: inspection.geometry.crs }),
              edges: inspection.geometry.edges,
              values: values as readonly (GeoArrowPolygon | null)[],
            };
    const input: CreateGeoArrowBatchInput = {
      id: batch.id,
      sequence: batch.sequence,
      ...(batch.rowOffset === undefined ? {} : { rowOffset: batch.rowOffset }),
      schemaId,
      identity,
      geometry,
      ...(columns.has("temporal") && inspection.temporal
        ? {
            temporal: {
              field: inspection.temporal.field,
              unit: inspection.temporal.unit,
              ...(inspection.temporal.timezone === undefined ? {} : { timezone: inspection.temporal.timezone }),
              values: decoded.rows.map((row) => row.timestamp ?? null),
            },
          }
        : {}),
      ...(columns.has("dictionary") && inspection.dictionary
        ? {
            dictionary: {
              field: inspection.dictionary.field,
              ordered: inspection.dictionary.ordered,
              values: decoded.rows.map((row) => row.dictionaryValue ?? null),
            },
          }
        : {}),
      ...(columns.has("featureIds") && inspection.featureIds
        ? {
            featureIds: {
              field: inspection.featureIds.field,
              values: decoded.rows.map((row) => row.featureId!),
            },
          }
        : {}),
    };
    const result = createGeoArrowBatch(input, limits);
    context.signal.throwIfAborted();
    context.reportProgress(1, "complete");
    return result.batch;
  };
}
