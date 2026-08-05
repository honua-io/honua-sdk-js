/**
 * Deterministic million-row GeoParquet columnar producer benchmark (issue
 * #1042).
 *
 * Every other columnar scenario in this corpus starts from a batch someone
 * already built. This one measures the step that *produces* it:
 * `createGeoParquetNativeGeometryBatch` takes the geometry column exactly as a
 * DuckDB driver materializes it — one `{x, y}` struct per result row — runs the
 * reviewed `src/columnar/geoarrow.ts` validation over it, and hands back a
 * `ColumnarBatchV1` instead of feeding `decodeGeoArrowBatch` and dropping it.
 *
 * NFR-001 is the claim under test: the producer must not materialize a per-row
 * object, so for a 1,000,000-row `geoarrow-*` fixture the retained bytes per row
 * must stay under the same 160 bytes/row ceiling
 * `columnar.data-plane.million-feature` already declares. The regression that
 * ceiling exists to catch is the path this issue replaced — decoding the batch
 * into GeoJSON rows and handing those back costs hundreds of bytes per row and
 * holds every one of them live in the result.
 *
 * ## The identity is minted by a real plan
 *
 * The batch identity comes from `columnarBatchIdentityFromPlan` over a plan
 * produced by `explainQuery`, not from a literal written here. Planning is
 * metadata-only and costs microseconds, so it stays outside the measured region
 * and changes no number; what it buys is that the scenario exercises the shipped
 * path — a plan that *selected* columnar execution, and a batch whose `planId`
 * is that plan's validity fingerprint — rather than a producer call no planner
 * would have made. `planSelectedColumnar` and `identityPlanDerived` gate both.
 *
 * ## Two regions per repetition
 *
 * 1. **timed** — one production, with no memory instrumentation inside it.
 *    Reading process memory during the run would price the meter into the
 *    measurement.
 * 2. **retention** — a second production, untimed, with a forced collection
 *    before the baseline and again with the produced batch still held live. The
 *    driver's materialized column is already live at the baseline — it is the
 *    producer's *input*, and it exists whether or not a batch is built from it —
 *    so the difference is what the produced batch retains beyond it, which is
 *    the quantity NFR-001 bounds. An uncollected `heapUsed` delta would instead
 *    be dominated by the transient position arrays the conversion drops.
 *
 * Both productions are digested and required to be byte-identical, which is the
 * determinism gate: the producer reads no clock and no ambient state, so the
 * same column must always encode to the same buffers.
 *
 * The fixture is built once outside every measured region. The throughput floor
 * is on producing a batch from a materialized column, not on materializing the
 * column, and the input's own cost belongs to the driver rather than to this
 * path.
 */
import { performance } from "node:perf_hooks";

import { type ColumnarBatchIdentityV1, type ColumnarBatchV1, inspectGeoArrowBatch } from "../src/columnar/index.js";
import type { SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { createGeoParquetNativeGeometryBatch } from "../src/geoparquet/index.js";
import type { QueryExecutionPlanV1 } from "../src/query-planner/index.js";
import {
  COLUMNAR_REPRESENTATION_MIN_ROWS,
  columnarBatchIdentityFromPlan,
  explainQuery,
} from "../src/query-planner/index.js";
import { collectGarbage, retainedBytes } from "./retained-memory.js";

/** Reciprocal of the fixture's coordinate lattice step; a power of two. */
const COORDINATE_STEPS_PER_UNIT = 8;

/** Half-width of the fixture's longitude lattice, in lattice steps. */
const LONGITUDE_STEPS = 180 * COORDINATE_STEPS_PER_UNIT;

/** Half-width of the fixture's latitude lattice, in lattice steps. */
const LATITUDE_STEPS = 90 * COORDINATE_STEPS_PER_UNIT;

/** Every this-many-th row carries a null geometry, so the null path is measured. */
const NULL_ROW_STRIDE = 97;

/** Execution freshness. Supplied at execution, never at explain. */
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

export interface ColumnarProducerBenchmarkOptions {
  rowCount: number;
  warmupRuns: number;
  measurementRuns: number;
}

export interface ColumnarProducerSample {
  /** Wall time of one complete production: validation plus encoding. */
  totalDurationMs: number;
  /** Rows turned into a batch per second. */
  featuresPerSecond: number;
  /**
   * Unique backing allocation bytes divided by row count. Deterministic for
   * this fixture — two float64 coordinate columns, a uint32 feature id, and a
   * validity bitmap — and the direct statement that the result is sized by its
   * columns rather than by a per-row object.
   */
  backingBytesPerFeature: number;
  /**
   * Peak **live** `heapUsed + arrayBuffers` with the produced batch held,
   * minus a collected baseline taken with the driver's materialized column
   * already live, divided by row count. NFR-001's 160 bytes/row ceiling
   * applies here.
   */
  peakRetainedBytesPerFeature: number;
}

export interface ColumnarProducerBenchmarkResult {
  samples: ColumnarProducerSample[];
  invariants: {
    checks: {
      /** A collector was available, so the retention reading is sound. */
      collectedBaseline: boolean;
      /** The plan this batch was produced under selected columnar execution. */
      planSelectedColumnar: boolean;
      /** The identity is the plan's, not a literal: `planId` is its validity fingerprint. */
      identityPlanDerived: boolean;
      /** The batch carried one row per input value. */
      rowCountExact: boolean;
      /** Every coordinate matched the exactly computed reference. */
      geometryExact: boolean;
      /** Null input rows are null in the batch, and no others are. */
      nullsPreserved: boolean;
      /** Every feature id survived into the packed id column. */
      featureIdsExact: boolean;
      /** Producing the same column twice produced byte-identical buffers. */
      repeatable: boolean;
    };
    passed: boolean;
  };
}

type Checks = ColumnarProducerBenchmarkResult["invariants"]["checks"];

interface ProducerRun {
  sample: ColumnarProducerSample;
  checks: Checks;
}

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

/** Longitude for one row, on a lattice of eighths so equality is exact. */
function longitudeAt(row: number): number {
  return ((mix(row, 0x9e3779b9) % (LONGITUDE_STEPS * 2)) - LONGITUDE_STEPS) / COORDINATE_STEPS_PER_UNIT;
}

/** Latitude for one row, on the same lattice. */
function latitudeAt(row: number): number {
  return ((mix(row, 0x85ebca6b) % (LATITUDE_STEPS * 2)) - LATITUDE_STEPS) / COORDINATE_STEPS_PER_UNIT;
}

/** Null geometry rows arrive from a parquet file like any other row. */
function isNullRow(row: number): boolean {
  return row % NULL_ROW_STRIDE === NULL_ROW_STRIDE - 1;
}

/** The GeoParquet 1.1 `geoarrow-point` source this scenario plans against. */
function descriptor(): SourceDescriptor {
  return {
    id: "columnar-producer-bench",
    protocol: "geoparquet",
    locator: {
      url: "producer-bench.parquet",
      geoparquet: { geometryColumn: "geometry", geometryEncoding: "geoarrow-point", nativeDimensions: "xy" },
    },
    capabilities: capabilities(["query"]),
  };
}

export interface ColumnarProducerFixture {
  /** The plan whose representation decision put this scenario on the columnar path. */
  readonly plan: QueryExecutionPlanV1;
  readonly identity: ColumnarBatchIdentityV1;
  /** The geometry column exactly as a DuckDB driver materializes it. */
  readonly values: readonly ({ readonly x: number; readonly y: number } | null)[];
  readonly featureIds: Uint32Array;
  readonly rowCount: number;
}

/**
 * Build the deterministic producer input: a plan, the identity it implies, and
 * the materialized geometry column the driver would hand over.
 *
 * The estimate handed to the planner is the fixture's own row count. The corpus
 * scenario's million rows clear the planner's columnar threshold on their own,
 * so nothing about the selection is nudged there; the floor below exists only so
 * a smaller unit-test fixture still plans the path this harness measures rather
 * than being refused an identity for being small.
 */
export function buildColumnarProducerFixture(rowCount: number): ColumnarProducerFixture {
  if (!Number.isInteger(rowCount) || rowCount < 1) throw new Error("rowCount must be a positive integer");

  const plan = explainQuery({
    descriptor: descriptor(),
    authorizationScope: ["data:read"],
    schemaVersion: "producer-bench-schema-1",
    sourceVersion: "producer-bench-source-1",
    estimates: { rows: Math.max(rowCount, COLUMNAR_REPRESENTATION_MIN_ROWS) },
  });
  const identity = columnarBatchIdentityFromPlan(plan, { observedAt: OBSERVED_AT });

  const values = new Array<{ readonly x: number; readonly y: number } | null>(rowCount);
  const featureIds = new Uint32Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    values[row] = isNullRow(row) ? null : { x: longitudeAt(row), y: latitudeAt(row) };
    featureIds[row] = row;
  }
  return { plan, identity, values, featureIds, rowCount };
}

/** Unique backing allocation bytes, counting a shared `ArrayBuffer` once. */
function backingBytes(batch: ColumnarBatchV1): number {
  const seen = new Set<ArrayBuffer>();
  let total = 0;
  for (const buffer of batch.buffers) {
    if (seen.has(buffer.data)) continue;
    seen.add(buffer.data);
    total += buffer.data.byteLength;
  }
  return total;
}

/**
 * FNV-1a over every buffer's declared bytes, in declared order, with the buffer
 * ids folded in. Word-wise so a 20 MB batch is digested in a few milliseconds
 * outside the measured regions.
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

/** Produce one batch from the fixture's materialized column. */
function produce(fixture: ColumnarProducerFixture, sequence: number): ColumnarBatchV1 {
  return createGeoParquetNativeGeometryBatch({
    kind: "point",
    dimensions: "xy",
    values: fixture.values,
    identity: fixture.identity,
    batchId: `columnar-producer-bench:${sequence}`,
    sequence,
    featureIds: { field: "fid", values: fixture.featureIds },
  }).batch;
}

/**
 * Read the packed columns back and compare them against the exact reference.
 *
 * The comparison walks typed arrays rather than decoded rows, on purpose: a
 * check that called `decodeGeoArrowBatch` would materialize a million row
 * objects inside a scenario whose entire subject is not materializing them.
 */
function verify(
  batch: ColumnarBatchV1,
  fixture: ColumnarProducerFixture,
): Pick<Checks, "rowCountExact" | "geometryExact" | "nullsPreserved" | "featureIdsExact"> {
  const inspection = inspectGeoArrowBatch(batch);
  const x = inspection.geometry.coordinates.x;
  const y = inspection.geometry.coordinates.y;
  const validity = inspection.geometry.validity;
  const ids = inspection.featureIds?.values;
  const rowCountExact = batch.rowCount === fixture.rowCount;
  if (!rowCountExact || !x || !y || !ids || !validity) {
    return { rowCountExact, geometryExact: false, nullsPreserved: false, featureIdsExact: false };
  }

  let geometryExact = true;
  let nullsPreserved = true;
  let featureIdsExact = true;
  for (let row = 0; row < fixture.rowCount; row += 1) {
    const nullRow = isNullRow(row);
    const valid = (validity[row >> 3]! & (1 << (row & 7))) !== 0;
    nullsPreserved &&= valid !== nullRow;
    if (!nullRow) geometryExact &&= x[row] === longitudeAt(row) && y[row] === latitudeAt(row);
    featureIdsExact &&= ids[row] === row;
  }
  return { rowCountExact, geometryExact, nullsPreserved, featureIdsExact };
}

function runOnce(fixture: ColumnarProducerFixture, sequence: number): ProducerRun {
  // 1. Timed region: one production, no memory instrumentation inside it.
  //    Preceded by a forced collection, unlike the bounded-conversion harness:
  //    producing a million-row batch is hundreds of milliseconds, long enough
  //    that allocator warm-up is immaterial and short enough that a collection
  //    of the previous repetition's transient arrays landing inside the region
  //    would swing the reading. Collecting first moves that cost outside.
  collectGarbage();
  const started = performance.now();
  const timed = produce(fixture, sequence);
  const totalDurationMs = performance.now() - started;
  const timedDigest = batchDigest(timed);
  const verified = verify(timed, fixture);
  const backing = backingBytes(timed);

  // 2. Retention region: a second production, untimed, collected on both sides.
  //    The materialized input column is live at the baseline because it is the
  //    producer's input rather than its output, so the difference is what the
  //    batch itself retains.
  const collectedBaseline = collectGarbage();
  const baseline = retainedBytes();
  const retained = produce(fixture, sequence);
  collectGarbage();
  const peak = retainedBytes();
  // Digest the retained batch after the peak so no engine can decide it was
  // dead before the collection the reading depends on.
  const repeatable = batchDigest(retained) === timedDigest;

  return {
    sample: {
      totalDurationMs,
      featuresPerSecond: (fixture.rowCount / Math.max(totalDurationMs, 0.001)) * 1_000,
      backingBytesPerFeature: backing / fixture.rowCount,
      peakRetainedBytesPerFeature: (peak - baseline) / fixture.rowCount,
    },
    checks: {
      collectedBaseline,
      planSelectedColumnar:
        fixture.plan.representation.selected === "columnar" && fixture.plan.validity.representation === "columnar",
      identityPlanDerived:
        timed.identity?.planId === fixture.plan.validity.fingerprint &&
        timed.schema.id === fixture.identity.schemaVersion &&
        timed.identity?.sourceId === fixture.plan.ir.source.id,
      ...verified,
      repeatable,
    },
  };
}

/**
 * Run the deterministic columnar producer benchmark. Every reported check is the
 * conjunction across all measurement runs, so one bad repetition fails the
 * scenario.
 */
export async function runColumnarProducerBenchmark(
  options: ColumnarProducerBenchmarkOptions,
): Promise<ColumnarProducerBenchmarkResult> {
  assertOptions(options);
  const fixture = buildColumnarProducerFixture(options.rowCount);

  for (let run = 0; run < options.warmupRuns; run += 1) runOnce(fixture, run);
  const measured: ProducerRun[] = [];
  for (let run = 0; run < options.measurementRuns; run += 1) {
    measured.push(runOnce(fixture, options.warmupRuns + run));
  }
  const checks: Checks = {
    collectedBaseline: measured.every((run) => run.checks.collectedBaseline),
    planSelectedColumnar: measured.every((run) => run.checks.planSelectedColumnar),
    identityPlanDerived: measured.every((run) => run.checks.identityPlanDerived),
    rowCountExact: measured.every((run) => run.checks.rowCountExact),
    geometryExact: measured.every((run) => run.checks.geometryExact),
    nullsPreserved: measured.every((run) => run.checks.nullsPreserved),
    featureIdsExact: measured.every((run) => run.checks.featureIdsExact),
    repeatable: measured.every((run) => run.checks.repeatable),
  };
  return {
    samples: measured.map((run) => run.sample),
    invariants: { checks, passed: Object.values(checks).every(Boolean) },
  };
}

function assertOptions(options: ColumnarProducerBenchmarkOptions): void {
  if (
    !Number.isInteger(options.rowCount) ||
    options.rowCount < 1 ||
    !Number.isInteger(options.warmupRuns) ||
    options.warmupRuns < 0 ||
    !Number.isInteger(options.measurementRuns) ||
    options.measurementRuns < 1
  ) {
    throw new Error("Columnar producer benchmark options must be positive integers");
  }
}
