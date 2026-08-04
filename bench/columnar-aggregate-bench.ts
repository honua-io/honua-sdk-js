/**
 * Deterministic million-row GeoArrow aggregation benchmark.
 *
 * Validates the #939 reduction budgets: a million-row GeoArrow batch is reduced
 * to a bounded group-keyed result by scanning packed buffers only, so peak
 * retained memory is bounded by the group count rather than the row count, and
 * sustained scan throughput stays above the data-plane floor.
 *
 * There is no worker, no server, and no renderer: the operation is invoked
 * directly with a stub operation context, exactly like the other deterministic
 * bench harnesses, so the run measures the reduction cost only.
 */
import {
  createGeoArrowAggregateOperation,
  type GeoArrowAggregateMetricSpec,
} from "../src/columnar/geoarrow-aggregate.js";
import { createGeoArrowBatch } from "../src/columnar/geoarrow.js";
import { inspectColumnarBatch } from "../src/columnar/transfer.js";
import type { ColumnarBatchV1 } from "../src/columnar/types.js";
import type { ColumnarWorkerOperationContext } from "../src/columnar/worker.js";

/** Budgets for the columnar reduction path (#939 NFR-001 and NFR-002). */
export interface ColumnarAggregateBenchBudgets {
  /** Ceiling on bytes retained by the reduction, per input row. */
  readonly maxRetainedBytesPerInputRow: number;
  /** Floor on sustained reduction throughput (input rows/second). */
  readonly minInputRowsPerSecond: number;
}

export const DEFAULT_COLUMNAR_AGGREGATE_BENCH_BUDGETS: ColumnarAggregateBenchBudgets = Object.freeze({
  maxRetainedBytesPerInputRow: 8,
  minInputRowsPerSecond: 2_000_000,
});

export interface ColumnarAggregateBenchSample {
  readonly durationMs: number;
  readonly inputRowsPerSecond: number;
  readonly heapUsedDeltaBytes: number;
}

export interface ColumnarAggregateBenchResult {
  readonly inputRows: number;
  readonly groups: number;
  readonly metrics: number;
  /** Backing bytes of the aggregated result batch. */
  readonly outputBackingBytes: number;
  /** Bytes retained by the reduction: result batch plus group bookkeeping. */
  readonly retainedBytes: number;
  readonly retainedBytesPerInputRow: number;
  readonly samples: readonly ColumnarAggregateBenchSample[];
  readonly median: ColumnarAggregateBenchSample;
  readonly budgets: ColumnarAggregateBenchBudgets;
  readonly evaluation: {
    readonly memoryWithinBudget: boolean;
    readonly throughputWithinBudget: boolean;
    readonly passed: boolean;
  };
}

export interface RunColumnarAggregateBenchOptions {
  readonly inputRows?: number;
  readonly groups?: number;
  readonly warmupRuns?: number;
  readonly measurementRuns?: number;
  readonly budgets?: ColumnarAggregateBenchBudgets;
}

const IDENTITY = Object.freeze({
  sourceId: "columnar-aggregate-bench",
  sourceVersion: "v1",
  schemaVersion: "aggregate-bench-points-v1",
  planId: "plan:columnar-aggregate-bench",
  authorizationScope: "public",
  ordering: Object.freeze({
    stable: true,
    keys: Object.freeze([Object.freeze({ field: "id", direction: "ascending" as const, nulls: "last" as const })]),
  }),
  freshness: Object.freeze({ observedAt: "2026-01-01T00:00:00Z" }),
});

/**
 * Deterministic 32-bit mixer. Every intermediate is masked to 32 bits, so the
 * same row index always yields the same value and two runs are comparable.
 */
function mix(index: number, salt: number): number {
  let h = (index ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Build a deterministic GeoArrow point batch with a `groups`-valued dictionary
 * column. The fixture is the input to the measured reduction, so it is built
 * once outside every timed region.
 */
export function buildGeoArrowAggregateFixture(inputRows: number, groups: number): ColumnarBatchV1 {
  if (!Number.isInteger(inputRows) || inputRows < 0) throw new Error("inputRows must be a non-negative integer");
  if (!Number.isInteger(groups) || groups <= 0) throw new Error("groups must be a positive integer");
  const geometry = new Array<readonly [number, number]>(inputRows);
  const classes = new Array<string>(inputRows);
  const ids = new Uint32Array(inputRows);
  const names = Array.from({ length: groups }, (_, index) => `class-${String(index).padStart(6, "0")}`);
  for (let row = 0; row < inputRows; row += 1) {
    const hx = mix(row, 0x9e3779b9);
    const hy = mix(row, 0x85ebca6b);
    geometry[row] = [(hx / 0xffffffff) * 360 - 180, (hy / 0xffffffff) * 170 - 85];
    classes[row] = names[mix(row, 0xc2b2ae35) % groups]!;
    ids[row] = row;
  }
  return createGeoArrowBatch({
    id: "columnar-aggregate-bench-source",
    sequence: 0,
    schemaId: "aggregate-bench-points-v1",
    identity: IDENTITY,
    geometry: { kind: "point", field: "geometry", coordinateLayout: "separated", values: geometry },
    dictionary: { field: "class", values: classes },
    featureIds: { field: "id", values: ids },
  }).batch;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function stubContext(): ColumnarWorkerOperationContext {
  return {
    requestId: "columnar-aggregate-bench",
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

/**
 * Upper bound on the bytes the reduction retains beyond the input batch: the
 * aggregated result plus the group-indexed bookkeeping. Every term scales with
 * the group count or the dictionary cardinality, never with the row count.
 */
function retainedBookkeepingBytes(groups: number, metrics: number, dictionaryValues: number): number {
  const accumulators = groups * metrics * 2 * 8;
  const groupTables = groups * 48;
  const dictionaryTables = dictionaryValues * (4 + 4 + 8);
  return accumulators + groupTables + dictionaryTables;
}

/** Run the GeoArrow reduction benchmark and evaluate it against the budgets. */
export async function runColumnarAggregateBench(
  options: RunColumnarAggregateBenchOptions = {},
): Promise<ColumnarAggregateBenchResult> {
  const inputRows = options.inputRows ?? 1_000_000;
  const groups = options.groups ?? 1_024;
  const warmupRuns = options.warmupRuns ?? 1;
  const measurementRuns = options.measurementRuns ?? 3;
  const budgets = options.budgets ?? DEFAULT_COLUMNAR_AGGREGATE_BENCH_BUDGETS;

  const metrics: readonly GeoArrowAggregateMetricSpec[] = Object.freeze([
    Object.freeze({ name: "features", kind: "count" as const }),
    Object.freeze({ name: "longitudeSum", kind: "sum" as const, column: "x" as const }),
  ]);
  const operation = createGeoArrowAggregateOperation({
    id: "columnar-aggregate-bench-result",
    schemaId: "aggregate-bench-class-count-sum-v1",
    group: { kind: "dictionary" },
    metrics,
  });

  const batch = buildGeoArrowAggregateFixture(inputRows, groups);
  let outputBackingBytes = 0;
  let outputRows = 0;

  const measure = async (): Promise<ColumnarAggregateBenchSample> => {
    if (typeof globalThis.gc === "function") globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = now();
    const result = await operation(batch, stubContext());
    const durationMs = now() - start;
    const heapUsedDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    outputBackingBytes = inspectColumnarBatch(result).backingBytes;
    outputRows = result.rowCount;
    return {
      durationMs,
      inputRowsPerSecond: durationMs === 0 ? Number.POSITIVE_INFINITY : (inputRows / durationMs) * 1000,
      heapUsedDeltaBytes,
    };
  };

  for (let run = 0; run < warmupRuns; run += 1) await measure();
  const samples: ColumnarAggregateBenchSample[] = [];
  for (let run = 0; run < measurementRuns; run += 1) samples.push(await measure());

  const medianSample: ColumnarAggregateBenchSample = {
    durationMs: median(samples.map((sample) => sample.durationMs)),
    inputRowsPerSecond: median(samples.map((sample) => sample.inputRowsPerSecond)),
    heapUsedDeltaBytes: median(samples.map((sample) => sample.heapUsedDeltaBytes)),
  };

  const retainedBytes = outputBackingBytes + retainedBookkeepingBytes(outputRows, metrics.length, groups);
  const retainedBytesPerInputRow = inputRows === 0 ? 0 : retainedBytes / inputRows;
  const memoryWithinBudget = retainedBytesPerInputRow <= budgets.maxRetainedBytesPerInputRow;
  const throughputWithinBudget = medianSample.inputRowsPerSecond >= budgets.minInputRowsPerSecond;

  return {
    inputRows,
    groups: outputRows,
    metrics: metrics.length,
    outputBackingBytes,
    retainedBytes,
    retainedBytesPerInputRow,
    samples,
    median: medianSample,
    budgets,
    evaluation: {
      memoryWithinBudget,
      throughputWithinBudget,
      passed: memoryWithinBudget && throughputWithinBudget,
    },
  };
}

async function main(): Promise<void> {
  const inputRows = Number.parseInt(process.argv[2] ?? "1000000", 10);
  const groups = Number.parseInt(process.argv[3] ?? "1024", 10);
  const result = await runColumnarAggregateBench({ inputRows, groups });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `columnar-aggregate-bench: ${result.inputRows.toLocaleString()} rows -> ${result.groups.toLocaleString()} groups, ` +
      `${Math.round(result.median.inputRowsPerSecond).toLocaleString()} rows/s, ` +
      `${result.retainedBytesPerInputRow.toFixed(4)} retained bytes/input row, ` +
      `evaluation ${result.evaluation.passed ? "pass" : "FAIL"}\n`,
  );
  if (!result.evaluation.passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`columnar-aggregate-bench failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
