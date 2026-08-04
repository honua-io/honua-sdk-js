/**
 * Deterministic million-row GeoArrow reduction benchmark.
 *
 * `columnar-data-plane-bench.ts` walks a batch across the worker boundary and
 * into the renderer without reducing it. This harness measures the one columnar
 * operation that *shrinks* a batch: `createGeoArrowAggregateOperation` scans a
 * million packed rows and emits a group-keyed result whose row count is the
 * group count. The whole point of #939 is that this can be done without ever
 * materializing an input row, so the gates are a per-input-row memory ceiling
 * and a reduction throughput floor, carried as absolute budgets in
 * `bench/budgets.json`.
 *
 * There is no worker, no server, and no renderer here: the operation is invoked
 * directly with a stub context, exactly like the other deterministic bench
 * harnesses, so the run measures reduction cost only. The fixture is built once
 * outside every measured region, because NFR-002 is a floor on reduction
 * throughput and not on GeoArrow encoding throughput.
 *
 * Each repetition runs the same reduction three times, and the split is
 * deliberate:
 *
 * 1. **timed** — no memory sampling at all. Reading process memory inside the
 *    window would price the meter into the measurement.
 * 2. **retention** — untimed, and it forces a collection at each checkpoint. A
 *    raw `heapUsed` peak measures the *allocation rate* of everything the
 *    operation touches, including the input validation pass, and on this
 *    scenario that transient young-generation garbage runs to 12-16 bytes per
 *    input row while the reduction's own live footprint is under half a byte.
 *    Collecting at each checkpoint is what turns the reading into a retention
 *    measurement, and it is also what makes the clock meaningless — hence the
 *    separate run. The ceiling still bites: an implementation that decoded rows
 *    into objects would hold them live at these checkpoints.
 * 3. **cadence twin** — the same reduction with a different `yieldIntervalRows`,
 *    whose output must be byte-identical to the timed run's. This is the
 *    determinism gate: the yield cadence is the only scheduling knob the
 *    operation exposes, so if the output survives changing it, no worker
 *    scheduling decision can move it either.
 *
 * The correctness invariants are exact rather than approximate. Every fixture
 * longitude is a multiple of 1/8 and every per-group total stays below 2^28, so
 * each group's exact sum is representable in a double and is computed here by
 * integer accumulation. The reduction must reproduce it bit for bit.
 */
import { performance } from "node:perf_hooks";

import {
  type ColumnarBatchV1,
  type ColumnarWorkerOperation,
  type ColumnarWorkerOperationContext,
  createGeoArrowAggregateOperation,
  createGeoArrowBatch,
  inspectColumnarBatch,
  readGeoArrowAggregateBatch,
} from "../src/columnar/index.js";
import { collectGarbage, retainedBytes } from "./retained-memory.js";

/** Fraction of the scan between forced-collection retention checkpoints. */
const RETENTION_CHECKPOINT_STRIDE = 0.25;

/** Yield cadence of the twin reduction, chosen to differ from the default. */
const TWIN_YIELD_INTERVAL_ROWS = 4_096;

/** Reciprocal of the fixture's coordinate lattice step; a power of two. */
const COORDINATE_STEPS_PER_UNIT = 8;

/** Half-width of the fixture's longitude lattice, in lattice steps. */
const LONGITUDE_STEPS = 180 * COORDINATE_STEPS_PER_UNIT;

/** Half-width of the fixture's latitude lattice, in lattice steps. */
const LATITUDE_STEPS = 90 * COORDINATE_STEPS_PER_UNIT;

export interface ColumnarAggregateBenchmarkOptions {
  inputRowCount: number;
  groupCount: number;
  warmupRuns: number;
  measurementRuns: number;
}

export interface ColumnarAggregateSample {
  /** Wall time of one complete reduction: inspection, scan, and encode. */
  totalDurationMs: number;
  /** Input rows reduced per second. The NFR-002 floor applies to this. */
  inputRowsPerSecond: number;
  /**
   * Peak **live** bytes the reduction adds over a collected baseline, per input
   * row. Every checkpoint reading is taken immediately after a forced
   * collection, so this is retention and not allocation rate. The NFR-001
   * ceiling applies to this.
   */
  retainedBytesPerInputRow: number;
  /**
   * Backing bytes of the result batch per emitted group. This is the direct
   * statement that the output is sized by the group count: it is a constant of
   * the declared field set and does not move with the input row count.
   */
  outputBackingBytesPerGroup: number;
}

export interface ColumnarAggregateBenchmarkResult {
  samples: ColumnarAggregateSample[];
  invariants: {
    checks: {
      /** A collector was available, so the retention reading is sound. */
      collectedBaseline: boolean;
      /** Progress was non-decreasing and terminated at exactly 1. */
      monotonicProgress: boolean;
      /** The result carried exactly the fixture's groups, in ascending key order. */
      groupsExact: boolean;
      /** Every count and every sum matched the exactly computed reference. */
      metricsExact: boolean;
      /** The reduction did not touch one byte of its input batch. */
      inputBatchUnmutated: boolean;
      /** Reducing the same batch twice produced a byte-identical result. */
      repeatable: boolean;
      /** Changing the yield cadence did not change one output byte. */
      yieldCadenceIndependent: boolean;
    };
    passed: boolean;
  };
}

type Checks = ColumnarAggregateBenchmarkResult["invariants"]["checks"];

interface AggregateRun {
  sample: ColumnarAggregateSample;
  checks: Checks;
}

export interface ColumnarAggregateFixture {
  readonly batch: ColumnarBatchV1;
  /** Group keys in the order the reduction is required to emit them. */
  readonly groupKeys: readonly string[];
  /** Exact row count per group, indexed like {@link groupKeys}. */
  readonly counts: readonly number[];
  /** Exact longitude sum per group, indexed like {@link groupKeys}. */
  readonly sums: readonly number[];
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

const METRICS = Object.freeze([
  Object.freeze({ name: "features", kind: "count" as const }),
  Object.freeze({ name: "longitudeSum", kind: "sum" as const, column: "x" as const }),
]);

/**
 * Deterministic 32-bit mixer. Every intermediate is masked to 32 bits, so one
 * row index always yields one value and two runs on two machines agree.
 */
function mix(index: number, salt: number): number {
  let hash = (index ^ salt) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Build the deterministic GeoArrow point batch under test, together with the
 * exact reduction it must produce.
 *
 * Coordinates are drawn from a lattice of multiples of `1/8`, so every value
 * and every partial sum is exactly representable: the reference totals below
 * are accumulated as integers and scaled once, and no summation order — the
 * reduction's or this function's — can perturb them. That is what lets the
 * benchmark assert bit-exact metric equality instead of a tolerance.
 */
export function buildColumnarAggregateFixture(inputRowCount: number, groupCount: number): ColumnarAggregateFixture {
  if (!Number.isInteger(inputRowCount) || inputRowCount < 1)
    throw new Error("inputRowCount must be a positive integer");
  if (!Number.isInteger(groupCount) || groupCount < 1) throw new Error("groupCount must be a positive integer");

  // Zero padding makes the lexicographic order of the keys the numeric order of
  // the group index, so the expected output order is the fixture's own order.
  const groupKeys = Array.from({ length: groupCount }, (_, index) => `class-${String(index).padStart(6, "0")}`);
  const counts = new Array<number>(groupCount).fill(0);
  const sumSteps = new Array<number>(groupCount).fill(0);

  const geometry = new Array<readonly [number, number]>(inputRowCount);
  const classes = new Array<string>(inputRowCount);
  const featureIds = new Uint32Array(inputRowCount);

  for (let row = 0; row < inputRowCount; row += 1) {
    const longitudeSteps = (mix(row, 0x9e3779b9) % (LONGITUDE_STEPS * 2)) - LONGITUDE_STEPS;
    const latitudeSteps = (mix(row, 0x85ebca6b) % (LATITUDE_STEPS * 2)) - LATITUDE_STEPS;
    const group = mix(row, 0xc2b2ae35) % groupCount;
    geometry[row] = [longitudeSteps / COORDINATE_STEPS_PER_UNIT, latitudeSteps / COORDINATE_STEPS_PER_UNIT];
    classes[row] = groupKeys[group]!;
    featureIds[row] = row;
    counts[group]! += 1;
    sumSteps[group]! += longitudeSteps;
  }

  // The encoder is the SDK's own, so the fixture cannot drift from the
  // normative GeoArrow layout the reduction is required to read.
  const { batch } = createGeoArrowBatch({
    id: "columnar-aggregate-bench-source",
    sequence: 0,
    schemaId: "aggregate-bench-points-v1",
    identity: IDENTITY,
    geometry: { kind: "point", field: "geometry", coordinateLayout: "separated", values: geometry },
    dictionary: { field: "class", values: classes },
    featureIds: { field: "id", values: featureIds },
  });
  return {
    batch,
    groupKeys,
    counts,
    sums: sumSteps.map((steps) => steps / COORDINATE_STEPS_PER_UNIT),
  };
}

/**
 * FNV-1a over every buffer's declared bytes, in declared order, with the buffer
 * ids folded in. Word-wise so a 24 MB input batch can be digested in a few
 * milliseconds outside the measured regions.
 */
function batchDigest(batch: ColumnarBatchV1): string {
  let hash = 0x811c9dc5;
  const fold = (value: number): void => {
    hash ^= value >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  fold(batch.rowCount);
  for (const buffer of batch.buffers) {
    for (let index = 0; index < buffer.id.length; index += 1) fold(buffer.id.charCodeAt(index));
    fold(buffer.byteLength);
    const words = buffer.byteLength >>> 2;
    const view = new Uint32Array(buffer.data, buffer.byteOffset, words);
    for (let index = 0; index < words; index += 1) fold(view[index]!);
    const tail = new Uint8Array(buffer.data, buffer.byteOffset + (words << 2), buffer.byteLength - (words << 2));
    for (let index = 0; index < tail.length; index += 1) fold(tail[index]!);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function silentContext(): ColumnarWorkerOperationContext {
  return {
    requestId: "columnar-aggregate-bench",
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

async function runOnce(
  fixture: ColumnarAggregateFixture,
  reduce: ColumnarWorkerOperation,
  reduceWithTwinCadence: ColumnarWorkerOperation,
): Promise<AggregateRun> {
  const inputRowCount = fixture.batch.rowCount;
  const inputBefore = batchDigest(fixture.batch);

  // 1. Timed reduction, with no memory instrumentation inside the window.
  collectGarbage();
  const started = performance.now();
  const timed = await reduce(fixture.batch, silentContext());
  const totalDurationMs = performance.now() - started;

  // 2. Retention reduction: untimed, collected at every checkpoint.
  const progress: number[] = [];
  const collectedBaseline = collectGarbage();
  const baseline = retainedBytes();
  let peak = baseline;
  let nextCheckpoint = RETENTION_CHECKPOINT_STRIDE;
  const repeated = await reduce(fixture.batch, {
    requestId: "columnar-aggregate-bench",
    signal: new AbortController().signal,
    reportProgress(fraction) {
      progress.push(fraction);
      if (fraction < nextCheckpoint) return;
      nextCheckpoint += RETENTION_CHECKPOINT_STRIDE;
      collectGarbage();
      peak = Math.max(peak, retainedBytes());
    },
  });
  collectGarbage();
  peak = Math.max(peak, retainedBytes());

  // 3. Cadence twin: the same reduction, scheduled differently.
  const twin = await reduceWithTwinCadence(fixture.batch, silentContext());

  const decoded = readGeoArrowAggregateBatch(timed);
  const groupsExact =
    decoded.rows.length === fixture.groupKeys.length &&
    decoded.rows.every((row, index) => row.key === fixture.groupKeys[index]);
  const metricsExact =
    groupsExact &&
    decoded.rows.every(
      (row, index) =>
        row.metrics.features === fixture.counts[index] && row.metrics.longitudeSum === fixture.sums[index],
    ) &&
    decoded.rows.reduce((total, row) => total + (row.metrics.features ?? 0), 0) === inputRowCount;

  const timedDigest = batchDigest(timed);
  return {
    sample: {
      totalDurationMs,
      inputRowsPerSecond: (inputRowCount / Math.max(totalDurationMs, 0.001)) * 1_000,
      retainedBytesPerInputRow: (peak - baseline) / inputRowCount,
      outputBackingBytesPerGroup: inspectColumnarBatch(timed).backingBytes / timed.rowCount,
    },
    checks: {
      collectedBaseline,
      monotonicProgress:
        progress.length > 0 &&
        progress.at(-1) === 1 &&
        progress.every((fraction, index) => index === 0 || fraction >= progress[index - 1]!),
      groupsExact,
      metricsExact,
      inputBatchUnmutated: batchDigest(fixture.batch) === inputBefore,
      repeatable: batchDigest(repeated) === timedDigest,
      yieldCadenceIndependent: batchDigest(twin) === timedDigest,
    },
  };
}

/**
 * Run the deterministic columnar reduction benchmark. Every reported check is
 * the conjunction across all measurement runs, so one bad repetition fails the
 * scenario.
 */
export async function runColumnarAggregateBenchmark(
  options: ColumnarAggregateBenchmarkOptions,
): Promise<ColumnarAggregateBenchmarkResult> {
  assertOptions(options);
  const fixture = buildColumnarAggregateFixture(options.inputRowCount, options.groupCount);
  const reduce = createGeoArrowAggregateOperation({
    id: "columnar-aggregate-bench-result",
    schemaId: "aggregate-bench-class-count-sum-v1",
    group: { kind: "dictionary" },
    metrics: METRICS,
  });
  const reduceWithTwinCadence = createGeoArrowAggregateOperation({
    id: "columnar-aggregate-bench-result",
    schemaId: "aggregate-bench-class-count-sum-v1",
    group: { kind: "dictionary" },
    metrics: METRICS,
    yieldIntervalRows: TWIN_YIELD_INTERVAL_ROWS,
  });

  for (let run = 0; run < options.warmupRuns; run += 1) await runOnce(fixture, reduce, reduceWithTwinCadence);
  const measured: AggregateRun[] = [];
  for (let run = 0; run < options.measurementRuns; run += 1) {
    measured.push(await runOnce(fixture, reduce, reduceWithTwinCadence));
  }
  const checks: Checks = {
    collectedBaseline: measured.every((run) => run.checks.collectedBaseline),
    monotonicProgress: measured.every((run) => run.checks.monotonicProgress),
    groupsExact: measured.every((run) => run.checks.groupsExact),
    metricsExact: measured.every((run) => run.checks.metricsExact),
    inputBatchUnmutated: measured.every((run) => run.checks.inputBatchUnmutated),
    repeatable: measured.every((run) => run.checks.repeatable),
    yieldCadenceIndependent: measured.every((run) => run.checks.yieldCadenceIndependent),
  };
  return {
    samples: measured.map((run) => run.sample),
    invariants: { checks, passed: Object.values(checks).every(Boolean) },
  };
}

function assertOptions(options: ColumnarAggregateBenchmarkOptions): void {
  if (
    !Number.isInteger(options.inputRowCount) ||
    options.inputRowCount < 1 ||
    !Number.isInteger(options.groupCount) ||
    options.groupCount < 1 ||
    !Number.isInteger(options.warmupRuns) ||
    options.warmupRuns < 0 ||
    !Number.isInteger(options.measurementRuns) ||
    options.measurementRuns < 1
  ) {
    throw new Error("Columnar aggregate benchmark options must be positive integers");
  }
}
