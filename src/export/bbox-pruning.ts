import type { PublicationBounds } from "./descriptor.js";

/** Structural subset of Parquet column statistics used for GeoParquet bbox pruning. */
export interface BboxParquetColumnStatistics {
  readonly min?: unknown;
  readonly max?: unknown;
  readonly min_value?: unknown;
  readonly max_value?: unknown;
}

/** Structural subset of Parquet column chunk metadata used for GeoParquet bbox pruning. */
export interface BboxParquetColumnChunk {
  readonly meta_data?: {
    readonly path_in_schema: readonly string[];
    readonly total_compressed_size?: number | bigint;
    readonly statistics?: BboxParquetColumnStatistics;
  };
}

/** Structural subset of a Parquet row group descriptor used for GeoParquet bbox pruning. */
export interface BboxParquetRowGroup {
  readonly num_rows: number | bigint;
  readonly columns: readonly BboxParquetColumnChunk[];
}

/** Structural subset of Parquet file metadata used for GeoParquet bbox pruning. */
export interface BboxParquetMetadata {
  readonly row_groups: readonly BboxParquetRowGroup[];
}

/** One Parquet row group selected for a spatial bounding-box query. */
export interface PrunedRowGroupRange {
  readonly index: number;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly compressedBytes: number;
}

/** Result of pruning Parquet row groups against a query bounding box using GeoParquet bbox statistics. */
export interface BboxRowGroupPruning {
  readonly rowGroups: readonly number[];
  readonly ranges: readonly PrunedRowGroupRange[];
  readonly totalRowGroups: number;
  readonly prunedRowGroups: number;
  readonly estimatedBytes: number;
  readonly usedBboxStats: boolean;
}

interface RowGroupBbox {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export function bboxOverlaps(a: PublicationBounds, b: PublicationBounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function assertValidBbox(bbox: PublicationBounds): void {
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    bbox.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate)) ||
    bbox[0] > bbox[2] ||
    bbox[1] > bbox[3]
  ) {
    throw new TypeError(
      "Spatial bbox query requires four finite numbers [west, south, east, north] with west <= east and south <= north.",
    );
  }
}

function numericStat(value: unknown): number | undefined {
  if (typeof value === "bigint") value = Number(value);
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    if (value.byteLength === 4) value = view.getFloat32(0, true);
    else if (value.byteLength === 8) value = view.getFloat64(0, true);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rowGroupBbox(rowGroup: BboxParquetRowGroup, bboxColumn: string): RowGroupBbox | undefined {
  let xmin: number | undefined;
  let ymin: number | undefined;
  let xmax: number | undefined;
  let ymax: number | undefined;

  for (const column of rowGroup.columns) {
    const meta = column.meta_data;
    if (!meta || meta.path_in_schema[0] !== bboxColumn) continue;
    const leaf = meta.path_in_schema.at(-1);
    const stats = meta.statistics;
    if (!stats) continue;
    if (leaf === "xmin") xmin = numericStat(stats.min_value ?? stats.min);
    if (leaf === "ymin") ymin = numericStat(stats.min_value ?? stats.min);
    if (leaf === "xmax") xmax = numericStat(stats.max_value ?? stats.max);
    if (leaf === "ymax") ymax = numericStat(stats.max_value ?? stats.max);
  }

  if (
    xmin === undefined ||
    ymin === undefined ||
    xmax === undefined ||
    ymax === undefined ||
    xmin > xmax ||
    ymin > ymax
  )
    return undefined;
  return { xmin, ymin, xmax, ymax };
}

function rowGroupColumnBytes(rowGroup: BboxParquetRowGroup, columns: ReadonlySet<string>): number {
  let total = 0;
  for (const column of rowGroup.columns) {
    const root = column.meta_data?.path_in_schema[0];
    if (!root || !columns.has(root)) continue;
    total += Number(column.meta_data?.total_compressed_size ?? 0);
  }
  return total;
}

/**
 * Prune Parquet row groups against `queryBbox` using per-row-group GeoParquet 1.1
 * bbox covering column min/max statistics (`<bboxColumn>.{xmin,ymin,xmax,ymax}`).
 * Row groups lacking complete statistics are conservatively retained.
 */
export function pruneRowGroupsByBbox(
  metadata: BboxParquetMetadata,
  bboxColumn: string | undefined,
  queryBbox: PublicationBounds,
  readColumns: readonly string[],
): BboxRowGroupPruning {
  assertValidBbox(queryBbox);
  const columnSet = new Set(readColumns);
  const ranges: PrunedRowGroupRange[] = [];
  let rowOffset = 0;
  let usedBboxStats = false;
  let estimatedBytes = 0;

  for (let index = 0; index < metadata.row_groups.length; index += 1) {
    const rowGroup = metadata.row_groups[index]!;
    const count = Number(rowGroup.num_rows);
    const rowStart = rowOffset;
    const rowEnd = rowOffset + count;
    rowOffset = rowEnd;

    const bounds = bboxColumn ? rowGroupBbox(rowGroup, bboxColumn) : undefined;
    if (bounds) {
      usedBboxStats = true;
      if (!bboxOverlaps([bounds.xmin, bounds.ymin, bounds.xmax, bounds.ymax], queryBbox)) {
        continue;
      }
    }
    const compressedBytes = rowGroupColumnBytes(rowGroup, columnSet);
    estimatedBytes += compressedBytes;
    ranges.push(Object.freeze({ index, rowStart, rowEnd, compressedBytes }));
  }

  return Object.freeze({
    rowGroups: Object.freeze(ranges.map((range) => range.index)),
    ranges: Object.freeze(ranges),
    totalRowGroups: metadata.row_groups.length,
    prunedRowGroups: metadata.row_groups.length - ranges.length,
    estimatedBytes,
    usedBboxStats,
  });
}

/** Extract a row's bounding box from its GeoParquet bbox struct column when available. */
export function rowMatchesBbox(
  row: Readonly<Record<string, unknown>>,
  bboxColumn: string | undefined,
  queryBbox: PublicationBounds,
): boolean {
  if (!bboxColumn) return true;
  const raw = row[bboxColumn];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
  const box = raw as Record<string, unknown>;
  const xmin = numericStat(box.xmin);
  const ymin = numericStat(box.ymin);
  const xmax = numericStat(box.xmax);
  const ymax = numericStat(box.ymax);
  if (
    xmin === undefined ||
    ymin === undefined ||
    xmax === undefined ||
    ymax === undefined ||
    xmin > xmax ||
    ymin > ymax
  )
    return true;
  return bboxOverlaps([xmin, ymin, xmax, ymax], queryBbox);
}
