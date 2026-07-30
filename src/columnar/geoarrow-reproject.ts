import type {
  CreateGeoArrowBatchInput,
  GeoArrowConversionLimits,
  GeoArrowGeometryKind,
  GeoArrowLineString,
  GeoArrowPoint,
  GeoArrowPolygon,
  GeoArrowPosition,
} from "./geoarrow-types.js";
import { createGeoArrowBatch, decodeGeoArrowBatch, inspectGeoArrowBatch } from "./geoarrow.js";
import type { ColumnarBatchIdentityV1, ColumnarBatchV1 } from "./types.js";
import type { ColumnarWorkerOperation, ColumnarWorkerOperationContext } from "./worker.js";

export interface CreateGeoArrowReprojectOperationOptions {
  /** The CRS written to the output GeoArrow geometry metadata. */
  readonly targetCrs: string | Readonly<Record<string, unknown>>;
  /** The caller supplies the complete identity for the reprojected result. */
  readonly identity: ColumnarBatchIdentityV1;
  /** The schema identity must change when the CRS contract changes. */
  readonly schemaId: string;
  /** A host-owned CRS transform; it must return the same coordinate dimensionality. */
  readonly project: (position: GeoArrowPosition) => GeoArrowPosition;
  /** Additional conversion ceilings applied to both decode and encode. */
  readonly limits?: GeoArrowConversionLimits;
}

function reprojectPosition(
  position: GeoArrowPosition,
  project: CreateGeoArrowReprojectOperationOptions["project"],
): GeoArrowPosition {
  const result = project(position);
  if (!Array.isArray(result) || result.length !== position.length) {
    throw new TypeError("GeoArrow reprojection must preserve coordinate dimensionality.");
  }
  if (result.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) {
    throw new TypeError("GeoArrow reprojection must return finite numeric coordinates.");
  }
  return result;
}

function reprojectGeometry(
  geometry: GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon | null,
  kind: GeoArrowGeometryKind,
  project: CreateGeoArrowReprojectOperationOptions["project"],
): GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon | null {
  if (geometry === null) return null;
  if (kind === "point") return reprojectPosition(geometry as GeoArrowPoint, project);
  if (kind === "linestring") {
    return (geometry as GeoArrowLineString).map((position) => reprojectPosition(position, project));
  }
  return (geometry as GeoArrowPolygon).map((ring) => ring.map((position) => reprojectPosition(position, project)));
}

/**
 * Create a bounded worker operation for CRS reprojection of a GeoArrow batch.
 * The SDK traverses and validates the normative geometry; CRS math remains
 * host-owned so this path has no projection-library or network dependency.
 */
export function createGeoArrowReprojectOperation(
  options: CreateGeoArrowReprojectOperationOptions,
): ColumnarWorkerOperation {
  if (typeof options.project !== "function") throw new TypeError("project must be a function.");
  const limits = options.limits ?? {};
  return (batch: ColumnarBatchV1, context: ColumnarWorkerOperationContext): ColumnarBatchV1 => {
    context.signal.throwIfAborted();
    context.reportProgress(0, "decode");
    const inspection = inspectGeoArrowBatch(batch, limits);
    const decoded = decodeGeoArrowBatch(batch, limits);
    context.signal.throwIfAborted();
    context.reportProgress(0.5, "reproject");
    const values = decoded.rows.map((row) =>
      reprojectGeometry(row.geometry, inspection.geometry.kind, options.project),
    );
    const geometry: CreateGeoArrowBatchInput["geometry"] =
      inspection.geometry.kind === "point"
        ? {
            kind: "point",
            field: inspection.geometry.field,
            dimensions: inspection.geometry.dimensions,
            coordinateLayout: inspection.geometry.coordinateLayout,
            crs: options.targetCrs,
            edges: inspection.geometry.edges,
            values: values as readonly (GeoArrowPoint | null)[],
          }
        : inspection.geometry.kind === "linestring"
          ? {
              kind: "linestring",
              field: inspection.geometry.field,
              dimensions: inspection.geometry.dimensions,
              coordinateLayout: inspection.geometry.coordinateLayout,
              crs: options.targetCrs,
              edges: inspection.geometry.edges,
              values: values as readonly (GeoArrowLineString | null)[],
            }
          : {
              kind: "polygon",
              field: inspection.geometry.field,
              dimensions: inspection.geometry.dimensions,
              coordinateLayout: inspection.geometry.coordinateLayout,
              crs: options.targetCrs,
              edges: inspection.geometry.edges,
              values: values as readonly (GeoArrowPolygon | null)[],
            };
    const input: CreateGeoArrowBatchInput = {
      id: batch.id,
      sequence: batch.sequence,
      ...(batch.rowOffset === undefined ? {} : { rowOffset: batch.rowOffset }),
      schemaId: options.schemaId,
      identity: options.identity,
      geometry,
      ...(inspection.temporal
        ? {
            temporal: {
              field: inspection.temporal.field,
              unit: inspection.temporal.unit,
              ...(inspection.temporal.timezone === undefined ? {} : { timezone: inspection.temporal.timezone }),
              values: decoded.rows.map((row) => row.timestamp ?? null),
            },
          }
        : {}),
      ...(inspection.dictionary
        ? {
            dictionary: {
              field: inspection.dictionary.field,
              ordered: inspection.dictionary.ordered,
              values: decoded.rows.map((row) => row.dictionaryValue ?? null),
            },
          }
        : {}),
      ...(inspection.featureIds
        ? {
            featureIds: {
              field: inspection.featureIds.field,
              values: decoded.rows.map((row) => row.featureId!),
            },
          }
        : {}),
    };
    const result = createGeoArrowBatch(input, limits);
    const output =
      inspection.dictionary?.ordered === true
        ? {
            ...result.batch,
            buffers: result.batch.buffers.map(
              (buffer) => batch.buffers.find((original) => original.id === buffer.id) ?? buffer,
            ),
          }
        : result.batch;
    context.signal.throwIfAborted();
    context.reportProgress(1, "complete");
    return output;
  };
}
