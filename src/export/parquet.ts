import type { Compressors, FileMetaData, ParquetRow } from "hyparquet";
import type { Result } from "../contract/types.js";
import {
  type GeoParquetNativeDimensions,
  type GeoParquetNativeGeometryKind,
  decodeGeoParquetNativeGeometryColumn,
} from "../geoparquet/native-geometry.js";
import { sharedTask } from "./abort.js";
import { bboxOverlaps, pruneRowGroupsByBbox, rowMatchesBbox } from "./bbox-pruning.js";
import type { PublicationBounds } from "./descriptor.js";
import { HonuaPublicationError } from "./errors.js";
import type { PublicationBboxPlan, PublicationLookupPlan } from "./lookup.js";
import { type Publication, assertArtifactStamp } from "./open.js";
import { type ArtifactRangeReader, type ByteMeter, artifactRangeReader } from "./range-reader.js";
import { PUBLICATION_STAMP_KEY, readArtifactStamp } from "./stamp.js";

/** The first read of a cold lookup: the Parquet footer of a county-sized file fits in one request. */
const FOOTER_READ_BYTES = 64 * 1024;

interface ParquetModules {
  readonly parquetMetadataAsync: typeof import("hyparquet").parquetMetadataAsync;
  readonly parquetReadObjects: typeof import("hyparquet").parquetReadObjects;
  readonly prepareParquetRead: typeof import("hyparquet/src/scan.js").prepareParquetRead;
  readonly compressors: Compressors;
}

let modules: Promise<ParquetModules> | undefined;

/** The small Parquet reader loads on the first read of a publication, never with the entrypoint. */
function parquetModules(): Promise<ParquetModules> {
  modules ??= Promise.all([import("hyparquet"), import("hyparquet/src/scan.js"), import("fzstd")]).then(
    ([hyparquet, scan, zstd]) => ({
      parquetMetadataAsync: hyparquet.parquetMetadataAsync,
      parquetReadObjects: hyparquet.parquetReadObjects,
      prepareParquetRead: scan.prepareParquetRead,
      compressors: { ZSTD: (input, outputLength) => zstd.decompress(input, new Uint8Array(outputLength)) },
    }),
    (cause) => {
      modules = undefined;
      throw cause;
    },
  );
  return modules;
}

/** An identity lookup planned from the footer, ready to read the row groups it names. */
export interface PreparedLookup<T> {
  readonly plan: PublicationLookupPlan;
  read(): Promise<Result<T>>;
}

/** A spatial bounding-box query planned from per-row-group bbox statistics. */
export interface PreparedBboxQuery<T> {
  readonly plan: PublicationBboxPlan;
  read(): Promise<Result<T>>;
}

/** Statistics-pruning reads of a publication's GeoParquet artifact, without the SQL engine. */
export interface PublicationParquet {
  /** Reads the footer once per source and checks the artifact's publication stamp. */
  verify(signal?: AbortSignal): Promise<void>;
  prepareLookup<T>(value: string, signal?: AbortSignal): Promise<PreparedLookup<T>>;
  prepareBboxQuery<T>(bbox: PublicationBounds, signal?: AbortSignal): Promise<PreparedBboxQuery<T>>;
}

function publicationStamp(metadata: FileMetaData): unknown {
  const entries = metadata.key_value_metadata ?? [];
  return readArtifactStamp((key) => {
    const value = entries.find((entry) => entry.key === key)?.value;
    if (key !== PUBLICATION_STAMP_KEY) return value;
    try {
      return typeof value === "string" ? JSON.parse(value) : undefined;
    } catch {
      return undefined;
    }
  });
}

/** Public columns to return and the coordinate dimensions of a native geometry column. */
interface RecordShape {
  readonly columns: readonly string[];
  readonly dimensions: GeoParquetNativeDimensions;
}

function geometryDimensions(metadata: FileMetaData, column: string): GeoParquetNativeDimensions {
  const leaves = metadata.row_groups[0]?.columns ?? [];
  const hasZ = leaves.some(
    ({ meta_data }) => meta_data?.path_in_schema[0] === column && meta_data.path_in_schema.at(-1) === "z",
  );
  return hasZ ? "xyz" : "xy";
}

function decodeGeometries(
  publication: Publication,
  shape: RecordShape,
  rows: readonly ParquetRow[],
): readonly unknown[] {
  const { column, encoding } = publication.geometry;
  const values = rows.map((row) => row[column] ?? null);
  if (encoding === "wkb") return values;
  const kind = encoding.slice("geoarrow-".length) as GeoParquetNativeGeometryKind;
  return decodeGeoParquetNativeGeometryColumn(kind, shape.dimensions, values);
}

function resultFrom<T>(publication: Publication, shape: RecordShape, rows: readonly ParquetRow[]): Result<T> {
  const { columns } = shape;
  const geometries = decodeGeometries(publication, shape, rows);
  return {
    features: rows.map((row, index) => ({
      attributes: Object.fromEntries(
        columns.map((name) => [name, typeof row[name] === "bigint" ? Number(row[name]) : row[name]]),
      ) as T,
      geometry: geometries[index] as Result<T>["features"][number]["geometry"],
    })),
    exceededTransferLimit: false,
  };
}

function expandGeometryBounds(value: unknown, bounds: [number, number, number, number]): void {
  if (!Array.isArray(value)) return;
  const [x, y] = value;
  if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
    return;
  }
  for (const part of value) expandGeometryBounds(part, bounds);
}

function expandGeoJsonBounds(geometry: unknown, bounds: [number, number, number, number]): void {
  if (geometry == null) return;
  if (typeof geometry !== "object") {
    throw new HonuaPublicationError("artifact-mismatch", "Cannot evaluate bbox against non-GeoJSON geometry.");
  }
  if ("coordinates" in geometry) {
    expandGeometryBounds(geometry.coordinates, bounds);
    return;
  }
  if ("geometries" in geometry && Array.isArray(geometry.geometries)) {
    for (const child of geometry.geometries) expandGeoJsonBounds(child, bounds);
    return;
  }
  throw new HonuaPublicationError("artifact-mismatch", "Cannot evaluate bbox against non-GeoJSON geometry.");
}

function geometryMatchesBbox(geometry: unknown, query: PublicationBounds): boolean {
  const bounds: [number, number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  expandGeoJsonBounds(geometry, bounds);
  return bounds[0] !== Number.POSITIVE_INFINITY && bboxOverlaps(bounds, query);
}

function rangeBytes(ranges: readonly { readonly startByte: number; readonly endByte: number }[]): number {
  return ranges.reduce((total, range) => total + range.endByte - range.startByte, 0);
}

export function publicationParquet(publication: Publication, fetchImpl: typeof fetch): PublicationParquet {
  const artifact = publication.queryArtifact;
  const reader: ArtifactRangeReader = artifactRangeReader(artifact.url, artifact.bytes, fetchImpl);
  const columns = artifact.fields;
  const readColumns = [...columns, publication.geometry.column];
  const decodesWkb = publication.geometry.encoding === "wkb";

  const verifiedMetadata = sharedTask(async (signal) => {
    const file = reader.view(signal);
    const footerStart = Math.max(0, reader.byteLength - FOOTER_READ_BYTES);
    const [parquet] = await Promise.all([parquetModules(), file.slice(footerStart, reader.byteLength)]);
    const metadata = await parquet.parquetMetadataAsync(file, {
      initialFetchSize: FOOTER_READ_BYTES,
      geoparquet: decodesWkb,
    });
    assertArtifactStamp(publication, "geoparquet", publicationStamp(metadata));
    return metadata;
  });

  async function prepareLookup<T>(value: string, signal?: AbortSignal): Promise<PreparedLookup<T>> {
    const metadata = await verifiedMetadata(signal);
    const parquet = await parquetModules();
    const meter: ByteMeter = { bytes: 0 };
    const options = {
      file: reader.view(signal, meter),
      metadata,
      columns: readColumns,
      filter: { [publication.identity.geoparquetColumn]: { $eq: value } },
      rowFormat: "object" as const,
      compressors: parquet.compressors,
      geoparquet: decodesWkb,
      useBloomFilters: true,
    };
    const prepared = await parquet.prepareParquetRead(options);
    const footerBytes = Math.max(Math.min(FOOTER_READ_BYTES, reader.byteLength), metadata.metadata_length + 8);
    return {
      plan: Object.freeze({
        rowGroups: Object.freeze([
          ...new Set(prepared.plan.groups.map((group) => metadata.row_groups.indexOf(group.rowGroup))),
        ]),
        footerBytes,
        plannedBytes: footerBytes + meter.bytes + rangeBytes(prepared.plan.fetches),
      }),
      read: async () =>
        resultFrom<T>(
          publication,
          { columns, dimensions: geometryDimensions(metadata, publication.geometry.column) },
          await parquet.parquetReadObjects({ ...prepared.options, rowFormat: "object", useBloomFilters: false }),
        ),
    };
  }

  async function prepareBboxQuery<T>(bbox: PublicationBounds, signal?: AbortSignal): Promise<PreparedBboxQuery<T>> {
    const metadata = await verifiedMetadata(signal);
    const parquet = await parquetModules();
    const bboxColumn = publication.geometry.bboxColumn;
    const bboxReadColumns =
      bboxColumn && !readColumns.includes(bboxColumn) ? [...readColumns, bboxColumn] : readColumns;
    const pruned = pruneRowGroupsByBbox(metadata, bbox, { bboxColumn, readColumns: bboxReadColumns });
    const footerBytes = Math.max(Math.min(FOOTER_READ_BYTES, reader.byteLength), metadata.metadata_length + 8);
    const plan: PublicationBboxPlan = Object.freeze({
      rowGroups: pruned.rowGroups,
      totalRowGroups: pruned.totalRowGroups,
      prunedRowGroups: pruned.prunedRowGroups,
      footerBytes,
      plannedBytes: footerBytes + pruned.estimatedBytes,
      usedBboxStats: pruned.usedBboxStats,
    });
    return {
      plan,
      read: async () => {
        const matched: ParquetRow[] = [];
        for (const range of pruned.ranges) {
          const rows = await parquet.parquetReadObjects({
            file: reader.view(signal),
            metadata,
            columns: bboxReadColumns,
            rowStart: range.rowStart,
            rowEnd: range.rowEnd,
            rowFormat: "object",
            compressors: parquet.compressors,
            geoparquet: decodesWkb,
          });
          for (const row of rows.filter((row) => rowMatchesBbox(row, bboxColumn, bbox))) matched.push(row);
        }
        const result = resultFrom<T>(
          publication,
          { columns, dimensions: geometryDimensions(metadata, publication.geometry.column) },
          matched,
        );
        return {
          ...result,
          features: result.features.filter((feature) => geometryMatchesBbox(feature.geometry, bbox)),
        };
      },
    };
  }

  return Object.freeze({
    verify: async (signal?: AbortSignal) => {
      await verifiedMetadata(signal);
    },
    prepareLookup,
    prepareBboxQuery,
  });
}
