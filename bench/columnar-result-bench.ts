/**
 * Deterministic bounded columnar-to-object-`Result` conversion benchmark.
 *
 * `columnar-data-plane-bench.ts` walks a batch to the renderer without ever
 * materializing a row, and `columnar-aggregate-bench.ts` reduces one without
 * materializing a row either. This harness measures the one columnar operation
 * that *does* materialize rows on purpose: `columnarBatchToResult` cuts a
 * bounded window out of a million-row batch and builds real feature objects
 * from it.
 *
 * The whole claim of #942 is that this cost is proportional to the window and
 * not to the batch, so the gates are a per-converted-feature retention ceiling
 * and a conversion throughput floor, carried as absolute budgets in
 * `bench/budgets.json`. A conversion that scanned or validated the whole batch
 * would still produce the right thousand features — it would just miss the
 * throughput floor by three orders of magnitude, which is exactly the
 * regression this scenario exists to catch.
 *
 * The fixture is built once outside every measured region: the floor is on
 * conversion throughput, not on GeoArrow encoding throughput.
 *
 * Each repetition runs the conversion twice, and the split is the same one
 * `columnar-aggregate-bench.ts` documents:
 *
 * 1. **timed** — no memory instrumentation inside the window at all. Reading
 *    process memory during the run would price the meter into the measurement.
 * 2. **retention** — untimed, forcing a collection before the baseline and
 *    again with the converted window still held live. That difference is what
 *    the window retains; an allocation-rate delta would instead be dominated by
 *    transient garbage the conversion never keeps.
 *
 * A third, untimed pass walks the same range through
 * `columnarBatchToResultPages` and requires the concatenation to equal the
 * single-window conversion exactly. That is the determinism gate: paging is the
 * only scheduling knob the conversion exposes, so if the output survives being
 * cut into pages and yielded across task boundaries, no consumer's pacing can
 * move it either.
 */
import { performance } from "node:perf_hooks";

import {
  type ColumnarBatchIdentityV1,
  type ColumnarBatchV1,
  type ColumnarResult,
  columnarBatchToResult,
  columnarBatchToResultPages,
  createGeoArrowBatch,
} from "../src/columnar/index.js";
import { collectGarbage, retainedBytes } from "./retained-memory.js";

/** Reciprocal of the fixture's coordinate lattice step; a power of two. */
const COORDINATE_STEPS_PER_UNIT = 8;

/** Half-width of the fixture's longitude lattice, in lattice steps. */
const LONGITUDE_STEPS = 180 * COORDINATE_STEPS_PER_UNIT;

/** Half-width of the fixture's latitude lattice, in lattice steps. */
const LATITUDE_STEPS = 90 * COORDINATE_STEPS_PER_UNIT;

/** Distinct dictionary values the fixture's category column cycles through. */
const CATEGORY_COUNT = 64;

/** Pages the traversal check cuts the window into. More than one, by design. */
const TRAVERSAL_PAGES = 4;

/**
 * Windows converted inside one timed region.
 *
 * A single bounded conversion is a couple of milliseconds, which is short
 * enough that one collection landing inside the window swings the reading by
 * tens of percent and the lab's repeated-run variability check fires on noise
 * rather than on a regression. Timing a run of consecutive windows fixes that
 * honestly: the windows are **distinct and consecutive**, so this is exactly the
 * paging workload an application performs rather than the same window converted
 * repeatedly out of warm cache, which would flatter the throughput number.
 */
const WINDOWS_PER_TIMED_SAMPLE = 25;

export interface ColumnarResultConversionBenchmarkOptions {
  batchRowCount: number;
  windowSize: number;
  warmupRuns: number;
  measurementRuns: number;
}

export interface ColumnarResultConversionSample {
  /** Wall time of one complete bounded conversion: inspection plus window. */
  totalDurationMs: number;
  /** Features converted per second. The NFR-002 floor applies to this. */
  featuresPerSecond: number;
  /**
   * Live bytes the converted window retains beyond the batch's own backings,
   * per converted feature. The baseline is taken after a forced collection with
   * the batch already live, and the peak with the converted window still held,
   * so this is retention rather than allocation rate. NFR-001's 1 MB per 1,000
   * features is exactly 1,024 bytes/feature, and the ceiling applies here.
   */
  retainedBytesPerFeature: number;
}

export interface ColumnarResultConversionBenchmarkResult {
  samples: ColumnarResultConversionSample[];
  invariants: {
    checks: {
      /** A collector was available, so the retention reading is sound. */
      collectedBaseline: boolean;
      /** Every converted feature matched the exactly computed reference. */
      windowExact: boolean;
      /** Features came back in ascending batch row order, with no gaps. */
      orderingExact: boolean;
      /** The conversion did not touch one byte of its input batch. */
      inputBatchUnmutated: boolean;
      /** Converting the same window twice produced identical features. */
      repeatable: boolean;
      /** Paging the same range produced exactly the single-window output. */
      pagingMatchesWindow: boolean;
      /** An abort mid-traversal stopped it before the last page. */
      cancellable: boolean;
    };
    passed: boolean;
  };
}

type Checks = ColumnarResultConversionBenchmarkResult["invariants"]["checks"];

interface ConversionRun {
  sample: ColumnarResultConversionSample;
  checks: Checks;
}

const IDENTITY: ColumnarBatchIdentityV1 = Object.freeze({
  sourceId: "columnar-result-bench",
  sourceVersion: "v1",
  schemaVersion: "result-bench-points-v1",
  planId: "plan:columnar-result-bench",
  authorizationScope: "public",
  ordering: Object.freeze({
    stable: true,
    keys: Object.freeze([Object.freeze({ field: "fid", direction: "ascending" as const, nulls: "last" as const })]),
  }),
  freshness: Object.freeze({ observedAt: "2026-01-01T00:00:00Z" }),
});

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

/** Category label for a row. Every fourth row is null, so nulls are exercised. */
function categoryAt(row: number): string | null {
  if (row % 4 === 3) return null;
  return `category-${String(mix(row, 0xc2b2ae35) % CATEGORY_COUNT).padStart(4, "0")}`;
}

/** Longitude/latitude for a row, in lattice steps. */
function coordinateStepsAt(row: number): readonly [number, number] {
  return [
    (mix(row, 0x9e3779b9) % (LONGITUDE_STEPS * 2)) - LONGITUDE_STEPS,
    (mix(row, 0x85ebca6b) % (LATITUDE_STEPS * 2)) - LATITUDE_STEPS,
  ];
}

export interface ColumnarResultConversionFixture {
  readonly batch: ColumnarBatchV1;
  /** Zero-based first row of the window every measured conversion cuts. */
  readonly windowOffset: number;
  readonly windowSize: number;
}

/**
 * Build the deterministic GeoArrow batch under test.
 *
 * The batch carries all four columns a normative GeoArrow batch can hold —
 * point geometry, a timestamp, a dictionary-encoded category, and feature ids —
 * so the throughput floor covers a whole realistic row rather than only the
 * geometry NFR-002 names. Every coordinate sits on a lattice of eighths so the
 * reference the conversion is checked against is exact rather than approximate.
 *
 * The window is cut from the middle of the batch, not from row zero: a
 * conversion that quietly started reading at the beginning of a buffer would
 * pass a window anchored at zero and fail this one.
 */
export function buildColumnarResultConversionFixture(
  batchRowCount: number,
  windowSize: number,
): ColumnarResultConversionFixture {
  if (!Number.isInteger(batchRowCount) || batchRowCount < 1) {
    throw new Error("batchRowCount must be a positive integer");
  }
  if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > batchRowCount) {
    throw new Error("windowSize must be a positive integer no larger than batchRowCount");
  }

  const geometry = new Array<readonly [number, number]>(batchRowCount);
  const categories = new Array<string | null>(batchRowCount);
  const timestamps = new Array<bigint | null>(batchRowCount);
  const featureIds = new Uint32Array(batchRowCount);
  for (let row = 0; row < batchRowCount; row += 1) {
    const [longitudeSteps, latitudeSteps] = coordinateStepsAt(row);
    geometry[row] = [longitudeSteps / COORDINATE_STEPS_PER_UNIT, latitudeSteps / COORDINATE_STEPS_PER_UNIT];
    categories[row] = categoryAt(row);
    // Every third row is null so explicit-null attributes are on the hot path.
    timestamps[row] = row % 3 === 2 ? null : BigInt(row) * 1_000n;
    featureIds[row] = row;
  }

  // The encoder is the SDK's own, so the fixture cannot drift from the
  // normative GeoArrow layout the conversion is required to read.
  const { batch } = createGeoArrowBatch({
    id: "columnar-result-bench-source",
    sequence: 0,
    schemaId: "result-bench-points-v1",
    identity: IDENTITY,
    geometry: { kind: "point", field: "geometry", coordinateLayout: "separated", values: geometry },
    temporal: { field: "observedAt", unit: "millisecond", values: timestamps },
    dictionary: { field: "category", values: categories },
    featureIds: { field: "fid", values: featureIds },
  });
  return { batch, windowOffset: Math.floor((batchRowCount - windowSize) / 2), windowSize };
}

/**
 * FNV-1a over every buffer's declared bytes, in declared order, with the buffer
 * ids folded in. Word-wise so a large input batch can be digested in a few
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

/**
 * Sentinel standing in for an explicit null attribute inside a comparison key.
 *
 * It must be a value no real attribute can produce, or a null category would
 * compare equal to a category that happened to be spelled the same way. Written
 * as an escape rather than a literal so this file stays plain text.
 */
const NULL_KEY = "\u0000";

/** Stable structural key for one converted feature, used for equality checks. */
function featureKey(feature: ColumnarResult["features"][number]): string {
  const attributes = feature.attributes as Record<string, unknown>;
  const geometry = feature.geometry as { coordinates?: readonly number[] } | null | undefined;
  return [
    attributes.fid,
    attributes.category === null ? NULL_KEY : attributes.category,
    attributes.observedAt === null ? NULL_KEY : String(attributes.observedAt),
    geometry?.coordinates?.join(","),
  ].join("|");
}

/** Exactly what the conversion must produce for one fixture row. */
function referenceKey(row: number): string {
  const [longitudeSteps, latitudeSteps] = coordinateStepsAt(row);
  const category = categoryAt(row);
  const timestamp = row % 3 === 2 ? null : BigInt(row) * 1_000n;
  return [
    row,
    category === null ? NULL_KEY : category,
    timestamp === null ? NULL_KEY : String(timestamp),
    `${longitudeSteps / COORDINATE_STEPS_PER_UNIT},${latitudeSteps / COORDINATE_STEPS_PER_UNIT}`,
  ].join("|");
}

async function runOnce(fixture: ColumnarResultConversionFixture): Promise<ConversionRun> {
  const { batch, windowOffset, windowSize } = fixture;
  const window = { offset: windowOffset, limit: windowSize, maxFeatures: windowSize } as const;
  const inputBefore = batchDigest(batch);

  // The reference conversion. Untimed and unretained, so the two measured
  // regions below stay free of correctness bookkeeping.
  const reference = columnarBatchToResult(batch, window).features;
  const referenceKeys = reference.map(featureKey);
  const orderingExact = reference.every(
    (feature, index) => (feature.attributes as { fid?: unknown }).fid === windowOffset + index,
  );

  // 1. Timed region: consecutive distinct windows, no memory instrumentation.
  //    Deliberately not preceded by a forced collection — a bounded conversion
  //    is milliseconds of work, so a full collection immediately before it would
  //    measure the allocator warming back up rather than the steady-state
  //    conversion an application performs.
  const lastOffset = batch.rowCount - windowSize;
  let converted = 0;
  const started = performance.now();
  for (let index = 0; index < WINDOWS_PER_TIMED_SAMPLE; index += 1) {
    const offset = (windowOffset + index * windowSize) % (lastOffset + 1);
    converted += columnarBatchToResult(batch, { offset, limit: windowSize, maxFeatures: windowSize }).features.length;
  }
  const totalDurationMs = performance.now() - started;

  // 2. Retention conversion: one window, untimed, collected on both sides, with
  //    the converted window still live when the peak is read. The batch's own
  //    backings are already live at the baseline, so the difference is what the
  //    window costs beyond the batch it was cut from.
  const collectedBaseline = collectGarbage();
  const baseline = retainedBytes();
  const retainedWindow = columnarBatchToResult(batch, window);
  collectGarbage();
  const peak = retainedBytes();
  // Read the window after the peak so no engine can decide it was dead before
  // the collection the reading depends on.
  const retainedKeys = retainedWindow.features.map(featureKey);

  // 3. Paged traversal over the same range, and a cancelled one.
  const paged: string[] = [];
  const pageSize = Math.max(1, Math.ceil(windowSize / TRAVERSAL_PAGES));
  for await (const page of columnarBatchToResultPages(batch, {
    offset: windowOffset,
    limit: windowSize,
    pageSize,
    maxFeatures: pageSize,
  })) {
    for (const feature of page.features) paged.push(featureKey(feature));
  }

  // Abort after the first page. A traversal that ignored the signal would run
  // to TRAVERSAL_PAGES and never throw.
  const controller = new AbortController();
  let deliveredPages = 0;
  let cancelled = false;
  const cancelledTraversal = columnarBatchToResultPages(batch, {
    offset: windowOffset,
    limit: windowSize,
    pageSize,
    maxFeatures: pageSize,
    signal: controller.signal,
  });
  try {
    for await (const _page of cancelledTraversal) {
      deliveredPages += 1;
      controller.abort();
    }
  } catch (error) {
    cancelled = (error as { name?: string }).name === "AbortError";
  }

  const windowExact =
    referenceKeys.length === windowSize &&
    referenceKeys.every((key, index) => key === referenceKey(windowOffset + index));

  return {
    sample: {
      totalDurationMs,
      featuresPerSecond: (converted / Math.max(totalDurationMs, 0.001)) * 1_000,
      retainedBytesPerFeature: (peak - baseline) / windowSize,
    },
    checks: {
      collectedBaseline,
      windowExact,
      orderingExact,
      inputBatchUnmutated: batchDigest(batch) === inputBefore,
      repeatable: retainedKeys.join("\n") === referenceKeys.join("\n"),
      pagingMatchesWindow: paged.join("\n") === referenceKeys.join("\n"),
      cancellable: cancelled && deliveredPages < TRAVERSAL_PAGES,
    },
  };
}

/**
 * Run the deterministic bounded conversion benchmark. Every reported check is
 * the conjunction across all measurement runs, so one bad repetition fails the
 * scenario.
 */
export async function runColumnarResultConversionBenchmark(
  options: ColumnarResultConversionBenchmarkOptions,
): Promise<ColumnarResultConversionBenchmarkResult> {
  assertOptions(options);
  const fixture = buildColumnarResultConversionFixture(options.batchRowCount, options.windowSize);

  for (let run = 0; run < options.warmupRuns; run += 1) await runOnce(fixture);
  const measured: ConversionRun[] = [];
  for (let run = 0; run < options.measurementRuns; run += 1) measured.push(await runOnce(fixture));

  const checks: Checks = {
    collectedBaseline: measured.every((run) => run.checks.collectedBaseline),
    windowExact: measured.every((run) => run.checks.windowExact),
    orderingExact: measured.every((run) => run.checks.orderingExact),
    inputBatchUnmutated: measured.every((run) => run.checks.inputBatchUnmutated),
    repeatable: measured.every((run) => run.checks.repeatable),
    pagingMatchesWindow: measured.every((run) => run.checks.pagingMatchesWindow),
    cancellable: measured.every((run) => run.checks.cancellable),
  };
  return {
    samples: measured.map((run) => run.sample),
    invariants: { checks, passed: Object.values(checks).every(Boolean) },
  };
}

function assertOptions(options: ColumnarResultConversionBenchmarkOptions): void {
  if (
    !Number.isInteger(options.batchRowCount) ||
    options.batchRowCount < 1 ||
    !Number.isInteger(options.windowSize) ||
    options.windowSize < 1 ||
    options.windowSize > options.batchRowCount ||
    !Number.isInteger(options.warmupRuns) ||
    options.warmupRuns < 0 ||
    !Number.isInteger(options.measurementRuns) ||
    options.measurementRuns < 1
  ) {
    throw new Error("Columnar result conversion benchmark options must be positive integers");
  }
}
