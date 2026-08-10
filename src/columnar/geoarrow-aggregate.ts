/**
 * Bounded, deterministic reduction of a normative Honua GeoArrow batch.
 *
 * Every other columnar operation is row-preserving or row-dropping. This one
 * reduces: it scans only the packed buffer views returned by
 * {@link inspectGeoArrowBatch}, accumulates into group-indexed scalars, and
 * emits a result batch whose row count is the group count. No input row is ever
 * materialized as an object, `decodeGeoArrowBatch` is never called, and peak
 * retained memory is bounded by the group ceiling rather than the row count.
 *
 * The result is a dependency-free Honua columnar batch carrying the
 * `honua.aggregate` layout (see {@link readGeoArrowAggregateBatch}) rather than
 * a GeoArrow batch, because the normative GeoArrow layout admits exactly one
 * geometry column plus optional temporal, dictionary, and feature-id columns
 * and therefore has nowhere to carry metric columns.
 *
 * ## Determinism
 *
 * A reduction that is not deterministic is not cacheable, and this one is the
 * first columnar operation whose output is small enough to be worth caching.
 * Three things could otherwise make the same input produce different output.
 *
 * 1. **Worker scheduling.** The scan yields to the host task queue so a cancel
 *    can land, but the arithmetic never observes the scheduler: accumulation is
 *    one sequential pass over the packed buffers, and a yield only suspends it.
 *    The yield cadence is therefore a pure performance knob — varying
 *    `yieldIntervalRows` cannot change a single output byte.
 * 2. **Group ordering.** Groups are emitted ascending by key with the declared
 *    null group last, never in first-seen or hash-iteration order, so two
 *    batches holding the same rows in a different layout produce the same
 *    output row order. Duplicate dictionary entries encoding the same string
 *    are canonicalized to one group rather than to whichever index appeared
 *    first.
 * 3. **Floating-point associativity.** `count`, `min`, and `max` are
 *    order-independent by construction. `sum` and `mean` are not, and a naive
 *    running total makes the reported value depend on the order the rows were
 *    visited in: `[1e16, 1, 1, -1e16]` accumulates left to right to `0` when
 *    the exact answer is `2`. Both use Kahan–Babuška–Neumaier compensation
 *    instead, carrying every addition's discarded low-order bits in a second
 *    group-indexed accumulator and folding them in once at the end. That is a
 *    bound on the error rather than a proof of bit-identity under every
 *    conceivable permutation, but it removes the cancellation family that makes
 *    naive accumulation order-dependent in practice.
 *
 * @experimental
 */
import {
  type ColumnarBatchIdentityV1,
  type GeoArrowBatchInspection,
  type GeoArrowConversionLimits,
  type GeoArrowDimensions,
  type GeoArrowGeometryBuffers,
  HonuaGeoArrowError,
  type HonuaGeoArrowErrorCode,
} from "./geoarrow-types.js";
import { inspectGeoArrowBatch } from "./geoarrow.js";
import { createColumnarBatch } from "./transfer.js";
import type { ColumnarBatchV1, ColumnarBufferV1, ColumnarFieldV1 } from "./types.js";
import type { ColumnarWorkerOperation, ColumnarWorkerOperationContext } from "./worker.js";

/** Honua's dependency-free aggregate-result layout, recorded in schema metadata. */
export const HONUA_GEOARROW_AGGREGATE_LAYOUT_VERSION = "1.0" as const;

/** Default ceiling on distinct groups, including the declared null group. */
export const DEFAULT_GEOARROW_AGGREGATE_MAX_GROUPS = 65_536;

/**
 * Rows scanned between cooperative abort checks. Well inside the 65,536-row
 * ceiling the columnar data-plane contract requires.
 */
export const GEOARROW_AGGREGATE_ABORT_CHECK_ROWS = 8_192;

/** Rows scanned between cooperative event-loop yields, so a cancel can land. */
export const DEFAULT_GEOARROW_AGGREGATE_YIELD_ROWS = 16_384;

/**
 * Inclusive magnitude ceiling for a spatial-grid cell index on either axis,
 * chosen so a packed `(x, y)` cell key stays an exact safe integer.
 */
export const GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX = 33_554_432;

const GRID_KEY_STRIDE = GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX * 2;

/** Reducers supported over a declared numeric column. */
export type GeoArrowAggregateMetricKind = "count" | "sum" | "min" | "max" | "mean";

/** Numeric columns readable straight from a GeoArrow batch's packed buffers. */
export type GeoArrowAggregateNumericColumn = "featureId" | "temporal" | "x" | "y" | "z" | "m";

/** One declared output metric. */
export interface GeoArrowAggregateMetricSpec {
  /** Output field name. Must be unique and must not collide with a group field. */
  readonly name: string;
  readonly kind: GeoArrowAggregateMetricKind;
  /**
   * Source column. Required for `sum`, `min`, `max`, and `mean`. Optional for
   * `count`: omitted counts rows in the group, supplied counts non-null values.
   */
  readonly column?: GeoArrowAggregateNumericColumn;
}

/** Calendar-independent truncation units applied to the temporal column. */
export type GeoArrowAggregateTruncationUnit = "second" | "minute" | "hour" | "day";

/** Group by the batch's dictionary column, keyed by its decoded value. */
export interface GeoArrowAggregateDictionaryGroupSpec {
  readonly kind: "dictionary";
}

/** Group by the batch's temporal column truncated to a fixed-width unit. */
export interface GeoArrowAggregateTemporalGroupSpec {
  readonly kind: "temporal";
  readonly unit: GeoArrowAggregateTruncationUnit;
}

/** Group by a regular grid cell derived from the geometry column. */
export interface GeoArrowAggregateGridGroupSpec {
  readonly kind: "grid";
  /** Cell size in source CRS units: one positive number, or `[x, y]`. */
  readonly cellSize: number | readonly [number, number];
  /** Grid origin in source CRS units. Defaults to `[0, 0]`. */
  readonly origin?: readonly [number, number];
}

export type GeoArrowAggregateGroupSpec =
  | GeoArrowAggregateDictionaryGroupSpec
  | GeoArrowAggregateTemporalGroupSpec
  | GeoArrowAggregateGridGroupSpec;

/** How rows whose group key is null (or whose geometry is empty) are treated. */
export type GeoArrowAggregateNullKeyPolicy = "null-group" | "skip";

/** Options for the bounded GeoArrow aggregation worker operation. */
export interface CreateGeoArrowAggregateOperationOptions {
  /** Stable id assigned to the aggregated output batch. */
  readonly id: string;
  /**
   * Schema id for the aggregated field set. It is also written as the result
   * `identity.schemaVersion`, so it must change whenever the group or metric
   * specification changes.
   */
  readonly schemaId: string;
  readonly group: GeoArrowAggregateGroupSpec;
  readonly metrics: readonly GeoArrowAggregateMetricSpec[];
  /** Output group field name. Grid grouping emits `<name>_x` and `<name>_y`. */
  readonly groupField?: string;
  /** Ceiling on distinct groups. Defaults to {@link DEFAULT_GEOARROW_AGGREGATE_MAX_GROUPS}. */
  readonly maxGroups?: number;
  /** Null-key policy. Defaults to `"null-group"`. */
  readonly nullKeys?: GeoArrowAggregateNullKeyPolicy;
  /** Rows scanned between cooperative event-loop yields. */
  readonly yieldIntervalRows?: number;
  /** Conversion ceilings applied to the input inspection and the output batch. */
  readonly limits?: GeoArrowConversionLimits;
}

/** One decoded aggregate row: the group key plus every declared metric. */
export interface GeoArrowAggregateRow {
  /**
   * Dictionary value, truncated timestamp in the source temporal unit, or
   * `[cellX, cellY]`. `null` identifies the declared null group.
   */
  readonly key: string | number | readonly [number, number] | null;
  /** Metric values by declared name; `null` when a group had no non-null input. */
  readonly metrics: Readonly<Record<string, number | null>>;
}

/** Source provenance recorded on an aggregate result batch. */
export interface GeoArrowAggregateSource {
  readonly batchId: string;
  readonly schemaId: string;
  readonly rowCount: number;
  readonly planId: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  /** Rows dropped because their group key was null under the `skip` policy. */
  readonly skippedRows: number;
}

/** A decoded aggregate result batch. */
export interface GeoArrowAggregateResult {
  readonly batch: ColumnarBatchV1;
  readonly group: GeoArrowAggregateGroupSpec;
  readonly groupField: string;
  readonly metrics: readonly GeoArrowAggregateMetricSpec[];
  readonly nullKeys: GeoArrowAggregateNullKeyPolicy;
  readonly maxGroups: number;
  readonly source: GeoArrowAggregateSource;
  readonly rows: readonly GeoArrowAggregateRow[];
}

const META = {
  version: "honua.aggregate.version",
  spec: "honua.aggregate.spec",
  source: "honua.aggregate.source",
} as const;

const KIND_COUNT = 0;
const KIND_SUM = 1;
const KIND_MIN = 2;
const KIND_MAX = 3;
const KIND_MEAN = 4;

const GROUP_DICTIONARY = 0;
const GROUP_TEMPORAL = 1;
const GROUP_GRID = 2;

const COLUMN_F64 = 0;
const COLUMN_U32 = 1;
const COLUMN_I64 = 2;

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const TRUNCATION_SECONDS: Readonly<Record<GeoArrowAggregateTruncationUnit, number>> = Object.freeze({
  second: 1,
  minute: 60,
  hour: 3_600,
  day: 86_400,
});

const TICKS_PER_SECOND: Readonly<Record<string, number>> = Object.freeze({
  second: 1,
  millisecond: 1_000,
  microsecond: 1_000_000,
  nanosecond: 1_000_000_000,
});

type GeoArrowOrdinate = Extract<GeoArrowAggregateNumericColumn, "x" | "y" | "z" | "m">;

const DIMENSION_ORDER: Readonly<Record<GeoArrowDimensions, readonly GeoArrowOrdinate[]>> = Object.freeze({
  xy: Object.freeze(["x", "y"] as const),
  xyz: Object.freeze(["x", "y", "z"] as const),
  xym: Object.freeze(["x", "y", "m"] as const),
  xyzm: Object.freeze(["x", "y", "z", "m"] as const),
});

const METRIC_KINDS: ReadonlySet<string> = new Set(["count", "sum", "min", "max", "mean"]);
const METRIC_COLUMNS: ReadonlySet<string> = new Set(["featureId", "temporal", "x", "y", "z", "m"]);

function fail(code: HonuaGeoArrowErrorCode, message: string, detail?: Readonly<Record<string, unknown>>): never {
  throw new HonuaGeoArrowError(code, message, detail);
}

function requireTrimmed(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`GeoArrow aggregate ${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`GeoArrow aggregate ${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeGroupSpec(group: unknown): GeoArrowAggregateGroupSpec {
  if (typeof group !== "object" || group === null) throw new TypeError("GeoArrow aggregate group must be an object");
  const kind = (group as { kind?: unknown }).kind;
  if (kind === "dictionary") return Object.freeze({ kind: "dictionary" as const });
  if (kind === "temporal") {
    const unit = (group as GeoArrowAggregateTemporalGroupSpec).unit;
    if (typeof unit !== "string" || !(unit in TRUNCATION_SECONDS)) {
      throw new TypeError("GeoArrow aggregate temporal group unit must be second, minute, hour, or day");
    }
    return Object.freeze({ kind: "temporal" as const, unit });
  }
  if (kind === "grid") {
    const raw = (group as GeoArrowAggregateGridGroupSpec).cellSize;
    const size: readonly [number, number] =
      typeof raw === "number" ? [raw, raw] : [raw?.[0] as number, raw?.[1] as number];
    if (!Number.isFinite(size[0]) || !Number.isFinite(size[1]) || size[0] <= 0 || size[1] <= 0) {
      throw new TypeError("GeoArrow aggregate grid cellSize must be one or two finite positive numbers");
    }
    const rawOrigin = (group as GeoArrowAggregateGridGroupSpec).origin;
    const origin: readonly [number, number] = rawOrigin === undefined ? [0, 0] : [rawOrigin[0], rawOrigin[1]];
    if (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) {
      throw new TypeError("GeoArrow aggregate grid origin must contain exactly two finite numbers");
    }
    return Object.freeze({ kind: "grid" as const, cellSize: Object.freeze(size), origin: Object.freeze(origin) });
  }
  throw new TypeError("GeoArrow aggregate group kind must be dictionary, temporal, or grid");
}

function normalizeMetrics(metrics: unknown, reserved: ReadonlySet<string>): readonly GeoArrowAggregateMetricSpec[] {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new TypeError("GeoArrow aggregate metrics must be a non-empty array");
  }
  const seen = new Set<string>();
  const normalized: GeoArrowAggregateMetricSpec[] = [];
  for (const metric of metrics as readonly GeoArrowAggregateMetricSpec[]) {
    if (typeof metric !== "object" || metric === null) {
      throw new TypeError("GeoArrow aggregate metric must be an object");
    }
    const name = requireTrimmed(metric.name, "metric name");
    if (seen.has(name)) throw new TypeError(`GeoArrow aggregate metric name is duplicated: ${name}`);
    if (reserved.has(name)) throw new TypeError(`GeoArrow aggregate metric name collides with a group field: ${name}`);
    seen.add(name);
    if (typeof metric.kind !== "string" || !METRIC_KINDS.has(metric.kind)) {
      throw new TypeError("GeoArrow aggregate metric kind must be count, sum, min, max, or mean");
    }
    if (metric.column !== undefined && !METRIC_COLUMNS.has(metric.column)) {
      throw new TypeError("GeoArrow aggregate metric column must be featureId, temporal, x, y, z, or m");
    }
    if (metric.kind !== "count" && metric.column === undefined) {
      throw new TypeError(`GeoArrow aggregate ${metric.kind} metric requires a column`);
    }
    normalized.push(
      Object.freeze({ name, kind: metric.kind, ...(metric.column === undefined ? {} : { column: metric.column }) }),
    );
  }
  return Object.freeze(normalized);
}

function canonicalSpec(
  group: GeoArrowAggregateGroupSpec,
  metrics: readonly GeoArrowAggregateMetricSpec[],
  groupField: string,
  nullKeys: GeoArrowAggregateNullKeyPolicy,
  maxGroups: number,
): string {
  const canonicalGroup: Record<string, unknown> =
    group.kind === "dictionary"
      ? { kind: "dictionary" }
      : group.kind === "temporal"
        ? { kind: "temporal", unit: group.unit }
        : { kind: "grid", cellSize: group.cellSize, origin: group.origin ?? [0, 0] };
  return JSON.stringify({
    version: HONUA_GEOARROW_AGGREGATE_LAYOUT_VERSION,
    groupField,
    group: canonicalGroup,
    metrics: metrics.map((metric) => ({ name: metric.name, kind: metric.kind, column: metric.column ?? null })),
    nullKeys,
    maxGroups,
  });
}

function isValidBit(validity: Uint8Array | undefined, index: number): boolean {
  return validity === undefined || (validity[index >> 3]! & (1 << (index & 7))) !== 0;
}

interface ColumnReader {
  readonly type: number;
  readonly f64: Float64Array | undefined;
  readonly u32: Uint32Array | undefined;
  /** 32-bit halves of an int64 column, avoiding a per-row BigInt. */
  readonly i32: Int32Array | undefined;
  readonly stride: number;
  readonly offset: number;
  readonly validity: Uint8Array | undefined;
}

function buildColumnReader(inspection: GeoArrowBatchInspection, column: GeoArrowAggregateNumericColumn): ColumnReader {
  if (column === "featureId") {
    const featureIds = inspection.featureIds;
    if (featureIds === undefined) fail("invalid-input", "The batch has no feature-id column to aggregate.");
    return {
      type: COLUMN_U32,
      f64: undefined,
      u32: featureIds.values,
      i32: undefined,
      stride: 1,
      offset: 0,
      validity: undefined,
    };
  }
  if (column === "temporal") {
    const temporal = inspection.temporal;
    if (temporal === undefined) fail("invalid-input", "The batch has no temporal column to aggregate.");
    const halves = new Int32Array(temporal.values.buffer, temporal.values.byteOffset, temporal.values.length * 2);
    return {
      type: COLUMN_I64,
      f64: undefined,
      u32: undefined,
      i32: halves,
      stride: 2,
      offset: 0,
      validity: temporal.validity,
    };
  }
  const geometry = inspection.geometry;
  if (geometry.kind !== "point") {
    fail("unsupported-layout", `Coordinate metrics require a point geometry column; this batch is ${geometry.kind}.`, {
      column,
      kind: geometry.kind,
    });
  }
  const index = DIMENSION_ORDER[geometry.dimensions].indexOf(column);
  if (index < 0) {
    fail("invalid-input", `The geometry column has dimensions ${geometry.dimensions} and no ${column} ordinate.`);
  }
  if (geometry.coordinateLayout === "interleaved") {
    const values = geometry.coordinates.interleaved;
    if (values === undefined) fail("invalid-batch", "Interleaved geometry is missing its coordinate buffer.");
    return {
      type: COLUMN_F64,
      f64: values,
      u32: undefined,
      i32: undefined,
      stride: DIMENSION_ORDER[geometry.dimensions].length,
      offset: index,
      validity: geometry.validity,
    };
  }
  const values = geometry.coordinates[column];
  if (values === undefined) fail("invalid-batch", `Separated geometry is missing its ${column} coordinate buffer.`);
  return {
    type: COLUMN_F64,
    f64: values,
    u32: undefined,
    i32: undefined,
    stride: 1,
    offset: 0,
    validity: geometry.validity,
  };
}

function readColumn(reader: ColumnReader, row: number): number {
  if (reader.type === COLUMN_F64) return reader.f64![row * reader.stride + reader.offset]!;
  if (reader.type === COLUMN_U32) return reader.u32![row]!;
  const base = row * 2;
  const low = reader.i32![LITTLE_ENDIAN ? base : base + 1]!;
  const high = reader.i32![LITTLE_ENDIAN ? base + 1 : base]!;
  const value = high * 4_294_967_296 + (low >>> 0);
  if (!Number.isSafeInteger(value)) {
    fail("invalid-input", "A temporal value exceeds safe integer precision and cannot be aggregated.", { row });
  }
  return value;
}

/** Half-open vertex range backing one row's geometry. */
function vertexRange(geometry: GeoArrowGeometryBuffers, row: number): readonly [number, number] {
  if (geometry.kind === "point") return [row, row + 1];
  const start = geometry.offsets![row]!;
  const end = geometry.offsets![row + 1]!;
  if (geometry.kind === "linestring") return [start, end];
  if (end <= start) return [0, 0];
  return [geometry.ringOffsets![start]!, geometry.ringOffsets![end]!];
}

function isEmptyPointRow(geometry: GeoArrowGeometryBuffers, row: number): boolean {
  if (geometry.kind !== "point" || !isValidBit(geometry.validity, row)) return false;
  const dimensions = DIMENSION_ORDER[geometry.dimensions];
  if (geometry.coordinateLayout === "interleaved") {
    const values = geometry.coordinates.interleaved!;
    const base = row * dimensions.length;
    return dimensions.every((_, index) => Number.isNaN(values[base + index]!));
  }
  return dimensions.every((dimension) => Number.isNaN(geometry.coordinates[dimension]![row]!));
}

/**
 * Yield to the host task queue so a queued worker cancel message is delivered.
 * A microtask checkpoint is not enough: `postMessage` delivery is a task.
 */
function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown }).setImmediate;
    if (typeof immediate === "function") {
      immediate(resolve);
      return;
    }
    if (typeof MessageChannel === "function") {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port1.start();
      channel.port2.postMessage(undefined);
      return;
    }
    setTimeout(resolve, 0);
  });
}

interface MetricAccumulator {
  readonly spec: GeoArrowAggregateMetricSpec;
  readonly kind: number;
  /** Index into the scratch column arrays, or -1 for a plain row count. */
  readonly column: number;
  /** Running count, running extremum, or the high-order term of a running sum. */
  readonly values: number[];
  /**
   * Kahan–Babuška–Neumaier compensation: the low-order bits every addition to
   * {@link values} discarded. Folded in once at the end. Only `sum` and `mean`
   * use it; for the other kinds it stays exactly zero.
   */
  readonly compensation: number[];
  readonly nonNull: number[];
}

/**
 * One compensated addition. Returns the discarded low-order bits, which the
 * caller accumulates alongside the running total.
 *
 * A naive `total += value` makes a reduction order-dependent: summing
 * `[1e16, 1, 1, -1e16]` left to right yields `0` because each `1` falls off the
 * bottom of `1e16`, and permuting the same four values yields yet other
 * answers. Carrying the lost bits recovers the exact `2` from either order.
 */
function neumaierResidual(running: number, value: number, total: number): number {
  return Math.abs(running) >= Math.abs(value) ? running - total + value : value - total + running;
}

interface GroupColumns {
  readonly fields: readonly ColumnarFieldV1[];
  readonly buffers: readonly ColumnarBufferV1[];
  readonly orderingFields: readonly string[];
}

function bufferOf(id: string, role: ColumnarBufferV1["role"], field: string, view: ArrayBufferView): ColumnarBufferV1 {
  return Object.freeze({
    id,
    role,
    field,
    data: view.buffer as ArrayBuffer,
    byteOffset: view.byteOffset,
    byteLength: view.byteLength,
  });
}

function buildUtf8Group(field: string, values: readonly string[], withNull: boolean): GroupColumns {
  const count = values.length + (withNull ? 1 : 0);
  const encoder = new TextEncoder();
  const encoded = values.map((value) => encoder.encode(value));
  let total = 0;
  for (const bytes of encoded) total += bytes.length;
  const offsets = new Int32Array(count + 1);
  const payload = new Uint8Array(total);
  const validity = new Uint8Array((count + 7) >> 3);
  let cursor = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    payload.set(encoded[index]!, cursor);
    cursor += encoded[index]!.length;
    offsets[index + 1] = cursor;
    validity[index >> 3]! |= 1 << (index & 7);
  }
  for (let index = encoded.length; index < count; index += 1) offsets[index + 1] = cursor;
  return {
    fields: [Object.freeze({ name: field, type: Object.freeze({ name: "utf8" }), nullable: true })],
    buffers: [
      bufferOf(`${field}.validity`, "validity", field, validity),
      bufferOf(`${field}.offsets`, "offsets", field, offsets),
      bufferOf(`${field}.values`, "values", field, payload),
    ],
    orderingFields: [field],
  };
}

function buildTemporalGroup(
  field: string,
  keys: readonly number[],
  withNull: boolean,
  unit: string,
  timezone: string | undefined,
): GroupColumns {
  const count = keys.length + (withNull ? 1 : 0);
  const values = new BigInt64Array(count);
  const validity = new Uint8Array((count + 7) >> 3);
  for (let index = 0; index < keys.length; index += 1) {
    values[index] = BigInt(keys[index]!);
    validity[index >> 3]! |= 1 << (index & 7);
  }
  return {
    fields: [
      Object.freeze({
        name: field,
        type: Object.freeze({
          name: "timestamp",
          parameters: Object.freeze({ unit, ...(timezone === undefined ? {} : { timezone }) }),
        }),
        nullable: true,
      }),
    ],
    buffers: [
      bufferOf(`${field}.validity`, "validity", field, validity),
      bufferOf(`${field}.values`, "values", field, values),
    ],
    orderingFields: [field],
  };
}

function buildGridGroup(field: string, keys: readonly number[], withNull: boolean): GroupColumns {
  const count = keys.length + (withNull ? 1 : 0);
  const xField = `${field}_x`;
  const yField = `${field}_y`;
  const xValues = new Int32Array(count);
  const yValues = new Int32Array(count);
  const xValidity = new Uint8Array((count + 7) >> 3);
  const yValidity = new Uint8Array((count + 7) >> 3);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    xValues[index] = Math.floor(key / GRID_KEY_STRIDE) - GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX;
    yValues[index] = (key % GRID_KEY_STRIDE) - GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX;
    xValidity[index >> 3]! |= 1 << (index & 7);
    yValidity[index >> 3]! |= 1 << (index & 7);
  }
  return {
    fields: [
      Object.freeze({ name: xField, type: Object.freeze({ name: "int32" }), nullable: true }),
      Object.freeze({ name: yField, type: Object.freeze({ name: "int32" }), nullable: true }),
    ],
    buffers: [
      bufferOf(`${xField}.validity`, "validity", xField, xValidity),
      bufferOf(`${xField}.values`, "values", xField, xValues),
      bufferOf(`${yField}.validity`, "validity", yField, yValidity),
      bufferOf(`${yField}.values`, "values", yField, yValues),
    ],
    orderingFields: [xField, yField],
  };
}

/**
 * Create a bounded GeoArrow aggregation for registration with
 * `startColumnarWorkerHost`.
 *
 * The returned operation scans the input batch's packed buffers exactly once,
 * accumulates into group-indexed scalars, and emits a `honua.aggregate` result
 * batch. It fails closed — always before the output batch is allocated — when
 * the group ceiling is exceeded, when a metric value is non-finite, and when a
 * declared column does not exist in the batch. The input batch is never
 * mutated.
 */
export function createGeoArrowAggregateOperation(
  options: CreateGeoArrowAggregateOperationOptions,
): ColumnarWorkerOperation {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("GeoArrow aggregate options must be an object");
  }
  const id = requireTrimmed(options.id, "id");
  const schemaId = requireTrimmed(options.schemaId, "schemaId");
  const groupField = options.groupField === undefined ? "group" : requireTrimmed(options.groupField, "groupField");
  const group = normalizeGroupSpec(options.group);
  const groupFieldNames = group.kind === "grid" ? [`${groupField}_x`, `${groupField}_y`] : [groupField];
  const metrics = normalizeMetrics(options.metrics, new Set(groupFieldNames));
  const maxGroups = requirePositiveInteger(options.maxGroups, "maxGroups", DEFAULT_GEOARROW_AGGREGATE_MAX_GROUPS);
  const nullKeys = options.nullKeys ?? "null-group";
  if (nullKeys !== "null-group" && nullKeys !== "skip") {
    throw new TypeError('GeoArrow aggregate nullKeys must be "null-group" or "skip"');
  }
  const yieldIntervalRows = requirePositiveInteger(
    options.yieldIntervalRows,
    "yieldIntervalRows",
    DEFAULT_GEOARROW_AGGREGATE_YIELD_ROWS,
  );
  const limits = options.limits ?? {};
  const specJson = canonicalSpec(group, metrics, groupField, nullKeys, maxGroups);

  return async (batch: ColumnarBatchV1, context: ColumnarWorkerOperationContext): Promise<ColumnarBatchV1> => {
    context.signal.throwIfAborted();
    context.reportProgress(0, "inspect");
    const inspection = inspectGeoArrowBatch(batch, limits);
    const source = inspection.batch;
    const identity = source.identity;
    if (!identity) fail("invalid-batch", "A GeoArrow aggregation requires the source batch identity.");
    const rows = source.rowCount;
    const geometry = inspection.geometry;

    // Distinct scratch columns, read at most once per row and shared by metrics.
    const columnNames: GeoArrowAggregateNumericColumn[] = [];
    for (const metric of metrics) {
      if (metric.column !== undefined && !columnNames.includes(metric.column)) columnNames.push(metric.column);
    }
    const readers = columnNames.map((column) => buildColumnReader(inspection, column));
    const columnCount = readers.length;
    const columnValue = new Float64Array(columnCount);
    const columnValid = new Uint8Array(columnCount);

    const accumulators: MetricAccumulator[] = metrics.map((metric) => ({
      spec: metric,
      kind:
        metric.kind === "count"
          ? KIND_COUNT
          : metric.kind === "sum"
            ? KIND_SUM
            : metric.kind === "min"
              ? KIND_MIN
              : metric.kind === "max"
                ? KIND_MAX
                : KIND_MEAN,
      column: metric.column === undefined ? -1 : columnNames.indexOf(metric.column),
      values: [],
      compensation: [],
      nonNull: [],
    }));
    const accumulatorCount = accumulators.length;

    const groupKind =
      group.kind === "dictionary" ? GROUP_DICTIONARY : group.kind === "temporal" ? GROUP_TEMPORAL : GROUP_GRID;

    // Group-mode preparation. Every allocation here is bounded by the
    // dictionary cardinality or by a constant, never by the row count.
    let dictionaryValues: readonly string[] = [];
    let canonicalOfIndex: Int32Array = new Int32Array(0);
    let groupOfCanonical: Int32Array = new Int32Array(0);
    let dictionaryIndices: Int32Array = new Int32Array(0);
    let dictionaryValidity: Uint8Array | undefined;
    let temporalReader: ColumnReader | undefined;
    let temporalStep = 1;
    let gridSizeX = 1;
    let gridSizeY = 1;
    let gridOriginX = 0;
    let gridOriginY = 0;
    let interleaved = false;
    let coordinateStride = 2;
    let coordinateX: Float64Array = new Float64Array(0);
    let coordinateY: Float64Array = new Float64Array(0);
    const numericGroups = new Map<number, number>();
    const groupKeys: number[] = [];

    if (groupKind === GROUP_DICTIONARY) {
      const dictionary = inspection.dictionary;
      if (dictionary === undefined) fail("invalid-input", "Dictionary grouping requires a dictionary column.");
      const size = dictionary.offsets.length - 1;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const decoded = new Array<string>(size);
      canonicalOfIndex = new Int32Array(size);
      const firstByValue = new Map<string, number>();
      for (let index = 0; index < size; index += 1) {
        const value = decoder.decode(
          dictionary.values.subarray(dictionary.offsets[index], dictionary.offsets[index + 1]),
        );
        decoded[index] = value;
        const existing = firstByValue.get(value);
        if (existing === undefined) {
          firstByValue.set(value, index);
          canonicalOfIndex[index] = index;
        } else canonicalOfIndex[index] = existing;
      }
      dictionaryValues = decoded;
      groupOfCanonical = new Int32Array(size).fill(-1);
      dictionaryIndices = dictionary.indices;
      dictionaryValidity = dictionary.validity;
    } else if (groupKind === GROUP_TEMPORAL) {
      const temporal = inspection.temporal;
      if (temporal === undefined) fail("invalid-input", "Temporal grouping requires a temporal column.");
      const ticks: number | undefined = TICKS_PER_SECOND[temporal.unit];
      if (ticks === undefined) fail("unsupported-layout", `Unsupported temporal unit: ${temporal.unit}`);
      temporalStep = ticks * TRUNCATION_SECONDS[(group as GeoArrowAggregateTemporalGroupSpec).unit];
      temporalReader = buildColumnReader(inspection, "temporal");
    } else {
      const grid = group as GeoArrowAggregateGridGroupSpec;
      const cell = grid.cellSize as readonly [number, number];
      gridSizeX = cell[0];
      gridSizeY = cell[1];
      gridOriginX = grid.origin?.[0] ?? 0;
      gridOriginY = grid.origin?.[1] ?? 0;
      interleaved = geometry.coordinateLayout === "interleaved";
      coordinateStride = DIMENSION_ORDER[geometry.dimensions].length;
      if (interleaved) {
        const values = geometry.coordinates.interleaved;
        if (values === undefined) fail("invalid-batch", "Interleaved geometry is missing its coordinate buffer.");
        coordinateX = values;
        coordinateY = values;
      } else {
        const x = geometry.coordinates.x;
        const y = geometry.coordinates.y;
        if (x === undefined || y === undefined) fail("invalid-batch", "Separated geometry is missing x or y.");
        coordinateX = x;
        coordinateY = y;
      }
    }

    // Group-indexed accumulators, bounded by `maxGroups` and not by row count.
    let groupCount = 0;
    let nullGroup = -1;
    let skippedRows = 0;

    const openGroup = (): number => {
      if (groupCount >= maxGroups) {
        fail(
          "group-limit-exceeded",
          `The aggregation produced more than ${maxGroups} groups; raise maxGroups or coarsen the group key.`,
          { maxGroups },
        );
      }
      const ordinal = groupCount;
      groupCount += 1;
      for (let index = 0; index < accumulatorCount; index += 1) {
        const accumulator = accumulators[index]!;
        accumulator.values.push(
          accumulator.kind === KIND_MIN
            ? Number.POSITIVE_INFINITY
            : accumulator.kind === KIND_MAX
              ? Number.NEGATIVE_INFINITY
              : 0,
        );
        accumulator.compensation.push(0);
        accumulator.nonNull.push(0);
      }
      return ordinal;
    };

    const openNullGroup = (): number => {
      if (nullGroup < 0) nullGroup = openGroup();
      return nullGroup;
    };

    const gridCell = (x: number, y: number, row: number): number => {
      const cellX = Math.floor((x - gridOriginX) / gridSizeX);
      const cellY = Math.floor((y - gridOriginY) / gridSizeY);
      if (
        !Number.isFinite(cellX) ||
        !Number.isFinite(cellY) ||
        Math.abs(cellX) > GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX ||
        Math.abs(cellY) > GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX
      ) {
        fail("invalid-input", "A spatial-grid cell index exceeded the addressable grid; increase cellSize.", {
          row,
          cellX,
          cellY,
        });
      }
      return (
        (cellX + GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX) * GRID_KEY_STRIDE +
        (cellY + GEOARROW_AGGREGATE_MAX_GRID_CELL_INDEX)
      );
    };

    let reportedProgress = 0.01;
    let nextYield = yieldIntervalRows;
    context.reportProgress(reportedProgress, "scan");

    for (let row = 0; row < rows; row += 1) {
      if ((row & (GEOARROW_AGGREGATE_ABORT_CHECK_ROWS - 1)) === 0) context.signal.throwIfAborted();
      if (row === nextYield) {
        nextYield += yieldIntervalRows;
        const fraction = 0.01 + (row / rows) * 0.98;
        if (fraction - reportedProgress >= 0.01) {
          reportedProgress = fraction;
          context.reportProgress(fraction, "scan");
        }
        await yieldToHost();
        context.signal.throwIfAborted();
      }

      const emptyPoint = isEmptyPointRow(geometry, row);

      // Resolve the group ordinal from packed buffers only.
      let ordinal: number;
      if (groupKind === GROUP_DICTIONARY) {
        if (!isValidBit(dictionaryValidity, row)) {
          if (nullKeys === "skip") {
            skippedRows += 1;
            continue;
          }
          ordinal = openNullGroup();
        } else {
          const raw = dictionaryIndices[row]!;
          if (raw < 0 || raw >= canonicalOfIndex.length) {
            fail("invalid-batch", "A dictionary index is outside the dictionary.", { row, index: raw });
          }
          const canonical = canonicalOfIndex[raw]!;
          let assigned = groupOfCanonical[canonical]!;
          if (assigned < 0) {
            assigned = openGroup();
            groupOfCanonical[canonical] = assigned;
            groupKeys.push(canonical);
          }
          ordinal = assigned;
        }
      } else if (groupKind === GROUP_TEMPORAL) {
        const reader = temporalReader!;
        if (!isValidBit(reader.validity, row)) {
          if (nullKeys === "skip") {
            skippedRows += 1;
            continue;
          }
          ordinal = openNullGroup();
        } else {
          const value = readColumn(reader, row);
          const remainder = value % temporalStep;
          let key = value - remainder;
          if (remainder !== 0 && value < 0) key -= temporalStep;
          let assigned = numericGroups.get(key);
          if (assigned === undefined) {
            assigned = openGroup();
            numericGroups.set(key, assigned);
            groupKeys.push(key);
          }
          ordinal = assigned;
        }
      } else {
        const range = vertexRange(geometry, row);
        if (!isValidBit(geometry.validity, row) || range[1] <= range[0] || emptyPoint) {
          if (nullKeys === "skip") {
            skippedRows += 1;
            continue;
          }
          ordinal = openNullGroup();
        } else {
          let minX = Number.POSITIVE_INFINITY;
          let minY = Number.POSITIVE_INFINITY;
          let maxX = Number.NEGATIVE_INFINITY;
          let maxY = Number.NEGATIVE_INFINITY;
          for (let vertex = range[0]; vertex < range[1]; vertex += 1) {
            const x = interleaved ? coordinateX[vertex * coordinateStride]! : coordinateX[vertex]!;
            const y = interleaved ? coordinateY[vertex * coordinateStride + 1]! : coordinateY[vertex]!;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          const key = gridCell((minX + maxX) / 2, (minY + maxY) / 2, row);
          let assigned = numericGroups.get(key);
          if (assigned === undefined) {
            assigned = openGroup();
            numericGroups.set(key, assigned);
            groupKeys.push(key);
          }
          ordinal = assigned;
        }
      }

      for (let index = 0; index < columnCount; index += 1) {
        const reader = readers[index]!;
        if (!isValidBit(reader.validity, row) || (reader.type === COLUMN_F64 && emptyPoint)) {
          columnValid[index] = 0;
          continue;
        }
        const value = readColumn(reader, row);
        // Backstop. `inspectGeoArrowBatch` already refuses a batch whose
        // coordinate buffers hold a non-finite value, and the feature-id and
        // temporal columns are integral, so a metric column that reaches here
        // is finite under today's contract. Keep the guard anyway: it is the
        // one thing standing between a widened column set and a poisoned sum.
        if (!Number.isFinite(value)) {
          fail("invalid-input", "A non-finite metric value cannot be aggregated deterministically.", {
            row,
            column: columnNames[index],
            value,
          });
        }
        columnValid[index] = 1;
        columnValue[index] = value;
      }

      for (let index = 0; index < accumulatorCount; index += 1) {
        const accumulator = accumulators[index]!;
        if (accumulator.column < 0) {
          accumulator.values[ordinal]! += 1;
          continue;
        }
        if (columnValid[accumulator.column] === 0) continue;
        const value = columnValue[accumulator.column]!;
        accumulator.nonNull[ordinal]! += 1;
        if (accumulator.kind === KIND_COUNT) accumulator.values[ordinal]! += 1;
        else if (accumulator.kind === KIND_SUM || accumulator.kind === KIND_MEAN) {
          const running = accumulator.values[ordinal]!;
          const total = running + value;
          accumulator.compensation[ordinal]! += neumaierResidual(running, value, total);
          accumulator.values[ordinal] = total;
        } else if (accumulator.kind === KIND_MIN) {
          if (value < accumulator.values[ordinal]!) accumulator.values[ordinal] = value;
        } else if (value > accumulator.values[ordinal]!) accumulator.values[ordinal] = value;
      }
    }

    context.signal.throwIfAborted();
    context.reportProgress(0.99, "encode");

    // Deterministic output ordering: ascending by group key, null group last.
    const order: number[] = [];
    for (let ordinal = 0; ordinal < groupCount; ordinal += 1) if (ordinal !== nullGroup) order.push(ordinal);
    const keyOfOrdinal = new Map<number, number>();
    if (groupKind === GROUP_DICTIONARY) {
      for (const canonical of groupKeys) keyOfOrdinal.set(groupOfCanonical[canonical]!, canonical);
      order.sort((left, right) => {
        const a = dictionaryValues[keyOfOrdinal.get(left)!]!;
        const b = dictionaryValues[keyOfOrdinal.get(right)!]!;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    } else {
      for (const key of groupKeys) keyOfOrdinal.set(numericGroups.get(key)!, key);
      order.sort((left, right) => keyOfOrdinal.get(left)! - keyOfOrdinal.get(right)!);
    }
    const sortedKeys = order.map((ordinal) => keyOfOrdinal.get(ordinal)!);
    if (nullGroup >= 0) order.push(nullGroup);
    const groupColumns =
      groupKind === GROUP_DICTIONARY
        ? buildUtf8Group(
            groupField,
            sortedKeys.map((canonical) => dictionaryValues[canonical]!),
            nullGroup >= 0,
          )
        : groupKind === GROUP_TEMPORAL
          ? buildTemporalGroup(
              groupField,
              sortedKeys,
              nullGroup >= 0,
              inspection.temporal!.unit,
              inspection.temporal!.timezone,
            )
          : buildGridGroup(groupField, sortedKeys, nullGroup >= 0);

    const count = order.length;
    const fields: ColumnarFieldV1[] = [...groupColumns.fields];
    const buffers: ColumnarBufferV1[] = [...groupColumns.buffers];
    for (let index = 0; index < accumulatorCount; index += 1) {
      const accumulator = accumulators[index]!;
      const name = accumulator.spec.name;
      const nullable = accumulator.kind !== KIND_COUNT;
      const values = new Float64Array(count);
      const validity = nullable ? new Uint8Array((count + 7) >> 3) : undefined;
      for (let slot = 0; slot < count; slot += 1) {
        const ordinal = order[slot]!;
        if (!nullable) {
          values[slot] = accumulator.values[ordinal]!;
          continue;
        }
        const nonNull = accumulator.nonNull[ordinal]!;
        if (nonNull === 0) continue;
        // Fold the carried low-order bits back in exactly once, so `sum` and
        // `mean` report the compensated total rather than the drifted one.
        const total = accumulator.values[ordinal]! + accumulator.compensation[ordinal]!;
        values[slot] = accumulator.kind === KIND_MEAN ? total / nonNull : total;
        validity![slot >> 3]! |= 1 << (slot & 7);
      }
      fields.push(Object.freeze({ name, type: Object.freeze({ name: "float64" }), nullable }));
      if (validity) buffers.push(bufferOf(`${name}.validity`, "validity", name, validity));
      buffers.push(bufferOf(`${name}.values`, "values", name, values));
    }

    const sourceJson = JSON.stringify({
      batchId: source.id,
      schemaId: source.schema.id,
      rowCount: rows,
      planId: identity.planId,
      sourceId: identity.sourceId,
      sourceVersion: identity.sourceVersion,
      skippedRows,
    });
    const aggregatedIdentity: ColumnarBatchIdentityV1 = {
      sourceId: identity.sourceId,
      sourceVersion: identity.sourceVersion,
      schemaVersion: schemaId,
      planId: `honua.aggregate@${HONUA_GEOARROW_AGGREGATE_LAYOUT_VERSION}|${identity.planId}|${specJson}`,
      authorizationScope: identity.authorizationScope,
      ordering: Object.freeze({
        stable: true,
        keys: Object.freeze(
          groupColumns.orderingFields.map((field) =>
            Object.freeze({ field, direction: "ascending" as const, nulls: "last" as const }),
          ),
        ),
      }),
      freshness: identity.freshness,
    };
    const output = createColumnarBatch(
      {
        id,
        sequence: source.sequence,
        rowCount: count,
        schema: {
          id: schemaId,
          fields,
          metadata: {
            [META.version]: HONUA_GEOARROW_AGGREGATE_LAYOUT_VERSION,
            [META.spec]: specJson,
            [META.source]: sourceJson,
          },
        },
        identity: aggregatedIdentity,
        buffers,
      },
      limits,
    );
    context.reportProgress(1, "complete");
    return output;
  };
}

interface TypedArrayConstructor<T extends ArrayBufferView> {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): T;
}

function typedView<T extends ArrayBufferView>(buffer: ColumnarBufferV1, ctor: TypedArrayConstructor<T>): T {
  if (buffer.byteOffset % ctor.BYTES_PER_ELEMENT !== 0 || buffer.byteLength % ctor.BYTES_PER_ELEMENT !== 0) {
    fail("invalid-batch", `Buffer "${buffer.id}" is not component-aligned.`, { bufferId: buffer.id });
  }
  try {
    return new ctor(buffer.data, buffer.byteOffset, buffer.byteLength / ctor.BYTES_PER_ELEMENT);
  } catch (cause) {
    throw new HonuaGeoArrowError(
      "invalid-batch",
      `Buffer "${buffer.id}" cannot be viewed with its normative component type.`,
      { bufferId: buffer.id },
      { cause },
    );
  }
}

interface ParsedAggregateSpec {
  readonly groupField: string;
  readonly group: GeoArrowAggregateGroupSpec;
  readonly metrics: readonly { name: string; kind: GeoArrowAggregateMetricKind; column: string | null }[];
  readonly nullKeys: GeoArrowAggregateNullKeyPolicy;
  readonly maxGroups: number;
}

/**
 * Decode a `honua.aggregate` result batch produced by
 * {@link createGeoArrowAggregateOperation}.
 *
 * Materialization is bounded by the group count, which the producing operation
 * already capped, so this is always safe to call on a result the SDK produced.
 */
export function readGeoArrowAggregateBatch(
  batch: ColumnarBatchV1,
  limits: GeoArrowConversionLimits = {},
): GeoArrowAggregateResult {
  let normalized: ColumnarBatchV1;
  try {
    normalized = createColumnarBatch(batch, limits);
  } catch (cause) {
    throw new HonuaGeoArrowError(
      "invalid-batch",
      "The aggregate batch does not satisfy the columnar transport contract.",
      undefined,
      { cause },
    );
  }
  const metadata = normalized.schema.metadata ?? {};
  if (metadata[META.version] !== HONUA_GEOARROW_AGGREGATE_LAYOUT_VERSION) {
    fail("unsupported-layout", `Batch must use Honua aggregate ${HONUA_GEOARROW_AGGREGATE_LAYOUT_VERSION}.`);
  }
  let spec: ParsedAggregateSpec;
  let source: GeoArrowAggregateSource;
  try {
    spec = JSON.parse(metadata[META.spec]!) as ParsedAggregateSpec;
    source = JSON.parse(metadata[META.source]!) as GeoArrowAggregateSource;
  } catch (cause) {
    throw new HonuaGeoArrowError(
      "invalid-batch",
      "The aggregate batch specification metadata is not readable.",
      undefined,
      { cause },
    );
  }
  const buffers = new Map<string, ColumnarBufferV1>();
  for (const buffer of normalized.buffers) buffers.set(buffer.id, buffer);
  const required = (bufferId: string): ColumnarBufferV1 => {
    const buffer = buffers.get(bufferId);
    if (!buffer) fail("invalid-batch", `The aggregate batch is missing buffer ${bufferId}.`);
    return buffer;
  };
  const count = normalized.rowCount;
  const field = spec.groupField;
  const keys = new Array<string | number | readonly [number, number] | null>(count);

  if (spec.group.kind === "dictionary") {
    const validity = typedView(required(`${field}.validity`), Uint8Array);
    const offsets = typedView(required(`${field}.offsets`), Int32Array);
    const values = typedView(required(`${field}.values`), Uint8Array);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let index = 0; index < count; index += 1) {
      keys[index] = isValidBit(validity, index)
        ? decoder.decode(values.subarray(offsets[index], offsets[index + 1]))
        : null;
    }
  } else if (spec.group.kind === "temporal") {
    const validity = typedView(required(`${field}.validity`), Uint8Array);
    const values = typedView(required(`${field}.values`), BigInt64Array);
    for (let index = 0; index < count; index += 1) {
      keys[index] = isValidBit(validity, index) ? Number(values[index]!) : null;
    }
  } else {
    const validity = typedView(required(`${field}_x.validity`), Uint8Array);
    const xValues = typedView(required(`${field}_x.values`), Int32Array);
    const yValues = typedView(required(`${field}_y.values`), Int32Array);
    for (let index = 0; index < count; index += 1) {
      keys[index] = isValidBit(validity, index) ? Object.freeze([xValues[index]!, yValues[index]!] as const) : null;
    }
  }

  const metricViews = spec.metrics.map((metric) => ({
    name: metric.name,
    values: typedView(required(`${metric.name}.values`), Float64Array),
    validity: buffers.has(`${metric.name}.validity`)
      ? typedView(required(`${metric.name}.validity`), Uint8Array)
      : undefined,
  }));
  const rows = new Array<GeoArrowAggregateRow>(count);
  for (let index = 0; index < count; index += 1) {
    const values: Record<string, number | null> = {};
    for (const view of metricViews) values[view.name] = isValidBit(view.validity, index) ? view.values[index]! : null;
    rows[index] = Object.freeze({ key: keys[index] ?? null, metrics: Object.freeze(values) });
  }

  return Object.freeze({
    batch: normalized,
    group: Object.freeze(spec.group),
    groupField: field,
    metrics: Object.freeze(
      spec.metrics.map((metric) =>
        Object.freeze({
          name: metric.name,
          kind: metric.kind,
          ...(metric.column === null ? {} : { column: metric.column as GeoArrowAggregateNumericColumn }),
        }),
      ),
    ),
    nullKeys: spec.nullKeys,
    maxGroups: spec.maxGroups,
    source: Object.freeze(source),
    rows: Object.freeze(rows),
  });
}
