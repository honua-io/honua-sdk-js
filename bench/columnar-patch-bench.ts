/**
 * Deterministic million-row realtime patch benchmark (issue #941).
 *
 * `columnar-data-plane-bench.ts` builds a batch and walks it to the renderer,
 * and `columnar-batch-persistence-bench.ts` writes one out and reads it back.
 * This harness measures what a *live* columnar layer does between those two:
 * `applyColumnarPatch` takes a 1,000-event realtime patch — appends, updates,
 * and deletes keyed by feature id — and either writes it into the batch's
 * existing backings or compacts the batch into fresh ones.
 *
 * Both #941 budgets live here, and they gate opposite paths:
 *
 * - **NFR-002** ceilings *in-place* patch latency against 1,000,000 rows. That
 *   is what makes a columnar layer usable for realtime at all: the alternative
 *   to patching is re-encoding and re-transferring the whole batch per event.
 * - **NFR-003** ceilings what a *rebuild* costs, in both the bytes the compacted
 *   batch occupies per feature and the bytes the pass holds live relative to the
 *   batch it compacted.
 *
 * ## The workload is a steady-state live layer
 *
 * One repetition applies `patchesPerSample` in-place patches and then exactly
 * one rebuilding patch, and the rebuild is reached by **consuming the declared
 * reserve** rather than by overriding a threshold: every threshold in this
 * harness is the shipped default. Each patch appends and deletes the same number
 * of rows, so the batch holds exactly `rowCount` live rows from the first patch
 * to the last, and each rebuild returns it to a canonical state — `rowCount`
 * rows, no tombstones, a full reserve. That is what lets every repetition run
 * against one evolving batch: the fixture is built once, outside every measured
 * region, and each repetition measures the same thing.
 *
 * `assertOptions` refuses a corpus whose reserve does not produce that split, so
 * an edit cannot quietly turn the rebuilding patch into an in-place one and
 * leave both NFR-003 budgets measuring nothing.
 *
 * ## Two measured regions per repetition
 *
 * 1. **in place** — each patch timed on its own, with no memory instrumentation
 *    inside any of them. `patchLatencyMs` is the *median* of those timings,
 *    which is the quantity NFR-002 bounds, and `totalDurationMs` covers the
 *    whole run so the lab's repeated-run variability check sees a region long
 *    enough not to fire on noise. The median is also what keeps the reading
 *    honest about a cost a patch stream pays once rather than per patch: the
 *    first patch after a rebuild builds the feature-id index over a fresh
 *    backing, and every later patch extends the cached one.
 * 2. **rebuild** — one compacting patch, collected immediately before the
 *    baseline and again once it returns, with the pre-rebuild batch held live
 *    across both readings. The difference is therefore what the rebuilt batch
 *    retains *beyond* the batch it was built from, which is what NFR-003's
 *    memory ceiling bounds. Collections happen after the timer stops, so they
 *    never inflate `rebuildDurationMs`.
 *
 * Retention is read after a forced collection rather than as a `heapUsed` delta,
 * for the reason `columnar-aggregate-bench.ts` documents at length: an
 * uncollected delta measures allocation rate, which on a buffer-level pass is
 * dominated by transient scratch the rebuild never keeps. The scenario fails
 * closed when no collector is available instead of publishing a reading a
 * mid-run collection may have deflated. The rebuild's own exact accounting is
 * gated separately by `rebuildAllocationBounded`, which holds the reported
 * `backingBytesAllocated` — bytes the pass *allocated*, not bytes it retained —
 * under twice the input batch's backing bytes.
 *
 * The fixture carries point geometry plus a feature-id column and no nulls, so
 * every write is exactly accountable: `appendBytesExact` requires the reported
 * `payloadBytesCopied` to equal the bytes the operations must write, to the
 * byte. A nullable column would add a partial byte per row to that figure and
 * turn an exact check into an approximate one.
 *
 * An unexpected outcome throws rather than being folded into a check: every
 * later step of a repetition depends on which path the previous patch took, so
 * continuing past a surprise would report numbers for a workload the scenario
 * did not run.
 */
import { performance } from "node:perf_hooks";

import {
  type ApplyColumnarPatchOutcomeV1,
  type ColumnarBatchIdentityV1,
  type ColumnarBatchV1,
  type ColumnarPatchOperationV1,
  type ColumnarPatchV1,
  type GeoArrowConversionLimits,
  applyColumnarPatch,
  createColumnarPatch,
  createPatchableGeoArrowBatch,
} from "../src/columnar/index.js";
import { collectGarbage, retainedBytes } from "./retained-memory.js";

/** Reciprocal of the fixture's coordinate lattice step; a power of two. */
const COORDINATE_STEPS_PER_UNIT = 8;

/** Half-width of the fixture's longitude lattice, in lattice steps. */
const LONGITUDE_STEPS = 180 * COORDINATE_STEPS_PER_UNIT;

/** Half-width of the fixture's latitude lattice, in lattice steps. */
const LATITUDE_STEPS = 90 * COORDINATE_STEPS_PER_UNIT;

/** Payload bytes one appended row occupies: two float64 coordinates and a uint32 id. */
const BYTES_PER_ROW = 8 + 8 + 4;

/** Payload bytes a geometry-only update rewrites. */
const GEOMETRY_BYTES_PER_ROW = 8 + 8;

/** UTF-8 ceiling #941 NFR-001 sets on a patch's rewritten state metadata. */
const MAX_METADATA_BYTES = 4_096;

/**
 * The shipped `maxCapacityUtilization` default. Written as a number rather than
 * imported so that changing the default fails the reserve bounds in
 * `assertOptions` instead of silently re-tuning what this scenario measures.
 */
const DEFAULT_CAPACITY_UTILIZATION = 0.9;

/**
 * Operation mix of one patch, as fractions of its declared operation count.
 * Appends and deletes are equal so the live row count never moves, which is
 * what keeps every repetition a million-row measurement.
 */
const APPEND_SHARE = 0.25;
const DELETE_SHARE = 0.25;

const SCHEMA_ID = "patch-bench-points-v1";
const SOURCE_ID = "columnar-patch-bench-source";

/**
 * A live patchable batch declares no ordering keys, and that is a contract
 * rather than a convenience: an append into reserved capacity lands at the end
 * of the batch, so a batch claiming a stable order would have to refuse every
 * append to keep the claim true.
 */
const IDENTITY: ColumnarBatchIdentityV1 = Object.freeze({
  sourceId: "columnar-patch-bench",
  sourceVersion: "v1",
  schemaVersion: SCHEMA_ID,
  planId: "plan:columnar-patch-bench",
  authorizationScope: "public",
  ordering: Object.freeze({ stable: false, keys: Object.freeze([]) }),
  freshness: Object.freeze({ observedAt: "2026-01-01T00:00:00Z" }),
});

export interface ColumnarPatchBenchmarkOptions {
  /** Live rows the batch holds, invariant across every patch. */
  rowCount: number;
  /** Caller-declared spare rows, sized to be consumed by one repetition. */
  reserveRows: number;
  /** Operations carried by one patch. NFR-002 names 1,000. */
  patchOperations: number;
  /** In-place patches timed per repetition, before the rebuilding one. */
  patchesPerSample: number;
  warmupRuns: number;
  measurementRuns: number;
}

export interface ColumnarPatchSample {
  /** Wall time of every in-place patch in one repetition, summed. */
  totalDurationMs: number;
  /**
   * Median wall time of one in-place patch. NFR-002's 10 ms ceiling applies
   * here; the lab evaluates the median across repetitions, so the gated number
   * is a median of medians.
   */
  patchLatencyMs: number;
  /** Patch operations applied in place per second. */
  operationsPerSecond: number;
  /** Wall time of this repetition's one compacting rebuild. */
  rebuildDurationMs: number;
  /**
   * Backing bytes of the compacted batch per live row. Deterministic for this
   * fixture, and the direct statement of NFR-003's 24 bytes/feature ceiling: a
   * rebuild that materialized rows, or that failed to drop tombstoned ones,
   * moves it immediately.
   */
  rebuildBackingBytesPerRow: number;
  /**
   * Live bytes the rebuild adds over a collected baseline that already holds the
   * pre-rebuild batch, divided by that batch's backing bytes. NFR-003's "no more
   * than 2x the batch's backing bytes" applies here.
   */
  rebuildRetainedBytesPerBackingByte: number;
}

export interface ColumnarPatchBenchmarkResult {
  samples: ColumnarPatchSample[];
  invariants: {
    checks: {
      /** A collector was available, so the retention reading is sound. */
      collectedBaseline: boolean;
      /** Every in-place patch left every backing the same `ArrayBuffer` object. */
      bufferIdentityPreserved: boolean;
      /** No in-place patch allocated one backing byte. */
      zeroBackingBytesAllocated: boolean;
      /** Payload bytes written matched the operations exactly; metadata stayed under 4 KB. */
      appendBytesExact: boolean;
      /** The batch held exactly `rowCount` live rows after every patch. */
      liveRowCountStable: boolean;
      /** The rebuild compacted every tombstone away and issued a new batch identity. */
      rebuiltCompacted: boolean;
      /** The rebuild allocated under twice the input batch's backing bytes. */
      rebuildAllocationBounded: boolean;
      /** A replayed sequence was refused and handed back the same batch. */
      rejectionLeavesBatchUntouched: boolean;
    };
    passed: boolean;
  };
}

type Checks = ColumnarPatchBenchmarkResult["invariants"]["checks"];

interface PatchRun {
  sample: ColumnarPatchSample;
  checks: Checks;
}

/**
 * Deterministic 32-bit mixer. Every intermediate is masked to 32 bits, so one
 * feature id always yields one value and two runs on two machines agree.
 */
function mix(index: number, salt: number): number {
  let hash = (index ^ salt) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Longitude/latitude for one feature id, on a lattice of eighths. */
function pointAt(featureId: number): readonly [number, number] {
  return [
    ((mix(featureId, 0x9e3779b9) % (LONGITUDE_STEPS * 2)) - LONGITUDE_STEPS) / COORDINATE_STEPS_PER_UNIT,
    ((mix(featureId, 0x85ebca6b) % (LATITUDE_STEPS * 2)) - LATITUDE_STEPS) / COORDINATE_STEPS_PER_UNIT,
  ];
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

/** The `ArrayBuffer` identities a renderer would have bound, in buffer order. */
function backingIdentities(batch: ColumnarBatchV1): readonly ArrayBuffer[] {
  return batch.buffers.map((buffer) => buffer.data);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * The row bound this scenario declares.
 *
 * The shipped default is 1,000,000 rows, and a patched million-row batch is
 * larger than that by exactly the appended rows it has not yet compacted away.
 * The bound is therefore raised to the largest batch the declared reserve can
 * ever produce — base rows plus the reserve — rather than to an arbitrary
 * number, so the batch is still bounded and an append past the reserve is still
 * a rebuild rather than a limit breach.
 */
function conversionLimits(rowCount: number, reserveRows: number): GeoArrowConversionLimits {
  return { maxRows: rowCount + reserveRows };
}

export interface ColumnarPatchFixture {
  readonly batch: ColumnarBatchV1;
  readonly rowCount: number;
  /** Backing bytes including the declared reserve. */
  readonly backingBytes: number;
}

/**
 * Build the deterministic patchable batch under test.
 *
 * The reserve is explicit: `createPatchableGeoArrowBatch` allocates exactly the
 * declared spare rows behind the batch's own descriptors, and a batch built
 * through `createGeoArrowBatch` instead would carry none and rebuild on its
 * first append.
 */
export function buildColumnarPatchFixture(rowCount: number, reserveRows: number): ColumnarPatchFixture {
  if (!Number.isInteger(rowCount) || rowCount < 1) throw new Error("rowCount must be a positive integer");
  if (!Number.isInteger(reserveRows) || reserveRows < 1) throw new Error("reserveRows must be a positive integer");

  const geometry = new Array<readonly [number, number]>(rowCount);
  const featureIds = new Uint32Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    geometry[row] = pointAt(row);
    featureIds[row] = row;
  }

  // The encoder is the SDK's own, so the fixture cannot drift from the
  // normative GeoArrow layout the patch path is required to read.
  const created = createPatchableGeoArrowBatch(
    {
      id: SOURCE_ID,
      sequence: 0,
      schemaId: SCHEMA_ID,
      identity: IDENTITY,
      geometry: { kind: "point", field: "geometry", coordinateLayout: "separated", values: geometry },
      featureIds: { field: "fid", values: featureIds },
    },
    { reserve: { rows: reserveRows }, ...conversionLimits(rowCount, reserveRows) },
  );
  return { batch: created.batch, rowCount, backingBytes: backingBytes(created.batch) };
}

/** Cursors into the feature-id space, advanced across the whole benchmark. */
interface PatchStream {
  /** Next appended id. Starts past the fixture so no id is ever reused. */
  nextAppendId: number;
  /** Next base id to tombstone, advancing from the bottom of the range. */
  nextDeleteId: number;
  /** Next base id to update, advancing down from the top of the range. */
  nextUpdateId: number;
  /** Strictly increasing patch sequence. */
  sequence: number;
}

interface PatchShape {
  readonly appends: number;
  readonly updates: number;
  readonly deletes: number;
}

function patchShape(patchOperations: number): PatchShape {
  const appends = Math.round(patchOperations * APPEND_SHARE);
  const deletes = Math.round(patchOperations * DELETE_SHARE);
  return { appends, deletes, updates: patchOperations - appends - deletes };
}

/** Deterministic freshness for one sequence; no clock is read. */
function observedAtFor(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1) + sequence * 1_000).toISOString();
}

/**
 * Build the next patch in the stream.
 *
 * Appends, updates, and deletes address disjoint id ranges, which is required
 * rather than tidy: the contract accepts at most one operation per feature id
 * per patch, an update to a tombstoned id is refused, and re-creating a
 * tombstoned id forces a compacting rebuild. Deletes advance from the bottom of
 * the base id range and updates from the top, so the two cursors cannot meet
 * inside one benchmark run.
 */
function nextPatch(stream: PatchStream, shape: PatchShape): ColumnarPatchV1 {
  const operations: ColumnarPatchOperationV1[] = [];
  for (let index = 0; index < shape.appends; index += 1) {
    const featureId = stream.nextAppendId + index;
    operations.push({ op: "append", featureId, geometry: pointAt(featureId) });
  }
  for (let index = 0; index < shape.updates; index += 1) {
    const featureId = stream.nextUpdateId - index;
    // A different point for the same id: an update that wrote the value already
    // there would be indistinguishable from one that wrote nothing.
    operations.push({ op: "update", featureId, geometry: pointAt(featureId ^ 0x5bf03635) });
  }
  for (let index = 0; index < shape.deletes; index += 1) {
    operations.push({ op: "delete", featureId: stream.nextDeleteId + index });
  }
  stream.nextAppendId += shape.appends;
  stream.nextUpdateId -= shape.updates;
  stream.nextDeleteId += shape.deletes;
  stream.sequence += 1;
  return createColumnarPatch({
    schemaId: SCHEMA_ID,
    geometryKind: "point",
    cursor: {
      cursor: `patch-bench:${stream.sequence}`,
      sequence: stream.sequence,
      observedAt: observedAtFor(stream.sequence),
    },
    operations,
  });
}

/**
 * Replay the sequence the previous patch already carried. Nothing else about it
 * matters: the sequence is checked before one operation is planned, which is the
 * property this asserts.
 */
function replayPatch(stream: PatchStream): ColumnarPatchV1 {
  return createColumnarPatch({
    schemaId: SCHEMA_ID,
    geometryKind: "point",
    cursor: {
      cursor: `patch-bench:${stream.sequence}`,
      sequence: stream.sequence,
      observedAt: observedAtFor(stream.sequence),
    },
    operations: [{ op: "delete", featureId: stream.nextDeleteId }],
  });
}

/** Bytes an in-place application of one patch must write, exactly. */
function expectedPayloadBytes(shape: PatchShape): number {
  return shape.appends * BYTES_PER_ROW + shape.updates * GEOMETRY_BYTES_PER_ROW;
}

interface RunState {
  batch: ColumnarBatchV1;
  readonly stream: PatchStream;
}

function describeOutcome(outcome: ApplyColumnarPatchOutcomeV1): string {
  if (outcome.outcome === "rejected") return `rejected (${outcome.code}: ${outcome.message})`;
  if (outcome.outcome === "rebuilt") return `rebuilt (${outcome.reason})`;
  return outcome.outcome;
}

function runOnce(state: RunState, options: ColumnarPatchBenchmarkOptions): PatchRun {
  const shape = patchShape(options.patchOperations);
  const expectedBytes = expectedPayloadBytes(shape);
  const limits = conversionLimits(options.rowCount, options.reserveRows);
  const identitiesBefore = backingIdentities(state.batch);

  // 1. In-place region: each patch timed on its own, no memory instrumentation
  //    anywhere inside it. Reading process memory here would price the meter
  //    into a millisecond-scale measurement.
  const latencies: number[] = [];
  let zeroBackingBytesAllocated = true;
  let appendBytesExact = true;
  let liveRowCountStable = true;
  for (let index = 0; index < options.patchesPerSample; index += 1) {
    const patch = nextPatch(state.stream, shape);
    const started = performance.now();
    const outcome = applyColumnarPatch(state.batch, patch, { limits });
    latencies.push(performance.now() - started);
    if (outcome.outcome !== "patched-in-place") {
      throw new Error(`columnar-patch-bench: expected an in-place patch, got ${describeOutcome(outcome)}`);
    }
    zeroBackingBytesAllocated &&= outcome.metrics.backingBytesAllocated === 0;
    appendBytesExact &&=
      outcome.metrics.payloadBytesCopied === expectedBytes && outcome.metrics.metadataBytes <= MAX_METADATA_BYTES;
    liveRowCountStable &&= outcome.state.liveRowCount === options.rowCount;
    state.batch = outcome.batch;
  }
  const totalDurationMs = latencies.reduce((total, latency) => total + latency, 0);
  const identitiesAfter = backingIdentities(state.batch);
  const bufferIdentityPreserved =
    identitiesBefore.length === identitiesAfter.length &&
    identitiesBefore.every((backing, index) => backing === identitiesAfter[index]);

  // 2. The duplicate a resumed stream replays, refused before a byte moves.
  const replayed = applyColumnarPatch(state.batch, replayPatch(state.stream), { limits });
  const rejectionLeavesBatchUntouched =
    replayed.outcome === "rejected" && replayed.code === "duplicate-sequence" && replayed.batch === state.batch;

  // 3. Rebuild region. The reserve is now consumed past its declared
  //    utilization ceiling, so this patch crosses the capacity rule on the
  //    shipped defaults; no threshold is overridden to reach it.
  const beforeRebuild = state.batch;
  const inputBackingBytes = backingBytes(beforeRebuild);
  const rebuildPatch = nextPatch(state.stream, shape);
  const collectedBaseline = collectGarbage();
  const baseline = retainedBytes();
  const rebuildStarted = performance.now();
  const rebuilt = applyColumnarPatch(beforeRebuild, rebuildPatch, {
    limits,
    // A stable id per rebuild, so a batch rebuilt six times does not carry six
    // chained suffixes. It still differs from the input's id, which is what
    // `rebuiltCompacted` checks.
    rebuild: { batchId: `${SOURCE_ID}@${rebuildPatch.cursor.sequence}` },
  });
  const rebuildDurationMs = performance.now() - rebuildStarted;
  // Collections happen after the timer stops, so they never inflate a duration.
  collectGarbage();
  const peak = retainedBytes();
  if (rebuilt.outcome !== "rebuilt") {
    throw new Error(`columnar-patch-bench: expected a rebuild, got ${describeOutcome(rebuilt)}`);
  }
  // `beforeRebuild` is read below, after the peak, so no engine can decide it
  // was dead before the collection the reading depends on: the difference has to
  // be what the rebuilt batch adds, not what the old one stopped costing.
  const rebuiltCompacted =
    rebuilt.reason === "capacity" &&
    rebuilt.state.tombstoneCount === 0 &&
    rebuilt.batch.rowCount === options.rowCount &&
    rebuilt.state.liveRowCount === options.rowCount &&
    rebuilt.batch.id !== beforeRebuild.id &&
    beforeRebuild.rowCount > options.rowCount &&
    rebuilt.batch.identity?.freshness.observedAt === rebuildPatch.cursor.observedAt;
  state.batch = rebuilt.batch;

  return {
    sample: {
      totalDurationMs,
      patchLatencyMs: median(latencies),
      operationsPerSecond:
        ((options.patchesPerSample * options.patchOperations) / Math.max(totalDurationMs, 0.001)) * 1_000,
      rebuildDurationMs,
      rebuildBackingBytesPerRow: backingBytes(rebuilt.batch) / rebuilt.batch.rowCount,
      rebuildRetainedBytesPerBackingByte: (peak - baseline) / inputBackingBytes,
    },
    checks: {
      collectedBaseline,
      bufferIdentityPreserved,
      zeroBackingBytesAllocated,
      appendBytesExact,
      liveRowCountStable,
      rebuiltCompacted,
      rebuildAllocationBounded: rebuilt.metrics.backingBytesAllocated <= 2 * inputBackingBytes,
      rejectionLeavesBatchUntouched,
    },
  };
}

/**
 * Run the deterministic columnar patch benchmark. Every reported check is the
 * conjunction across all measurement runs, so one bad repetition fails the
 * scenario.
 */
export async function runColumnarPatchBenchmark(
  options: ColumnarPatchBenchmarkOptions,
): Promise<ColumnarPatchBenchmarkResult> {
  assertOptions(options);
  const fixture = buildColumnarPatchFixture(options.rowCount, options.reserveRows);
  const state: RunState = {
    batch: fixture.batch,
    stream: {
      nextAppendId: options.rowCount,
      nextDeleteId: 0,
      nextUpdateId: options.rowCount - 1,
      sequence: 0,
    },
  };

  for (let run = 0; run < options.warmupRuns; run += 1) runOnce(state, options);
  const measured: PatchRun[] = [];
  for (let run = 0; run < options.measurementRuns; run += 1) measured.push(runOnce(state, options));

  const checks: Checks = {
    collectedBaseline: measured.every((run) => run.checks.collectedBaseline),
    bufferIdentityPreserved: measured.every((run) => run.checks.bufferIdentityPreserved),
    zeroBackingBytesAllocated: measured.every((run) => run.checks.zeroBackingBytesAllocated),
    appendBytesExact: measured.every((run) => run.checks.appendBytesExact),
    liveRowCountStable: measured.every((run) => run.checks.liveRowCountStable),
    rebuiltCompacted: measured.every((run) => run.checks.rebuiltCompacted),
    rebuildAllocationBounded: measured.every((run) => run.checks.rebuildAllocationBounded),
    rejectionLeavesBatchUntouched: measured.every((run) => run.checks.rejectionLeavesBatchUntouched),
  };
  return {
    samples: measured.map((run) => run.sample),
    invariants: { checks, passed: Object.values(checks).every(Boolean) },
  };
}

/**
 * Reject a corpus that cannot measure what the scenario claims.
 *
 * The reserve bounds are the load-bearing part. Every in-place patch must fit
 * inside the declared capacity-utilization ceiling, and the patch after them
 * must cross it — otherwise the harness would either rebuild inside the timed
 * region, reporting a rebuild as in-place latency, or never rebuild at all,
 * leaving both NFR-003 budgets measuring an empty path.
 */
function assertOptions(options: ColumnarPatchBenchmarkOptions): void {
  if (
    !Number.isInteger(options.rowCount) ||
    options.rowCount < 1 ||
    !Number.isInteger(options.reserveRows) ||
    options.reserveRows < 1 ||
    !Number.isInteger(options.patchOperations) ||
    options.patchOperations < 4 ||
    !Number.isInteger(options.patchesPerSample) ||
    options.patchesPerSample < 1 ||
    !Number.isInteger(options.warmupRuns) ||
    options.warmupRuns < 0 ||
    !Number.isInteger(options.measurementRuns) ||
    options.measurementRuns < 1
  ) {
    throw new Error("Columnar patch benchmark options must be positive integers");
  }
  const shape = patchShape(options.patchOperations);
  const ceiling = DEFAULT_CAPACITY_UTILIZATION * options.reserveRows;
  if (shape.appends * options.patchesPerSample > ceiling) {
    throw new Error("Columnar patch benchmark reserve is too small: an in-place patch would rebuild");
  }
  if (shape.appends * (options.patchesPerSample + 1) <= ceiling) {
    throw new Error("Columnar patch benchmark reserve is too large: the rebuilding patch would not rebuild");
  }
  if (shape.appends > options.rowCount) {
    throw new Error("Columnar patch benchmark appends more rows than the batch carries");
  }
}
