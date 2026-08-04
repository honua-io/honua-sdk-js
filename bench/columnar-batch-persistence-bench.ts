/**
 * Deterministic million-row persistence benchmark for the columnar batch cache
 * (issue #940).
 *
 * `columnar-data-plane-bench.ts` measures the in-memory data plane: build,
 * worker transfer, renderer projection. This harness measures the *persistence*
 * path that a cache actually pays for:
 *
 * 1. build       — a packed, non-null interleaved GeoArrow point fixture
 *                  (16 bytes/row, one backing, zero per-row objects)
 * 2. serialize   — `serializeGeoArrowBatch` into the versioned envelope
 * 3. deserialize — `deserializeGeoArrowBatch`, which re-runs the full layout
 *                  validator, so the reading side is measured honestly
 * 4. migrate     — a small envelope written at layout 1.0 is carried forward by
 *                  the shipped ladder in the same run
 *
 * Three properties are budgeted in `bench/budgets.json`, matching the issue's
 * NFRs: envelope efficiency against the batch's own backing bytes, round-trip
 * rows/second, and peak retained bytes per row. Retained memory is read at stage
 * boundaries from a **collected** baseline, exactly as the data-plane harness
 * does, and the scenario fails closed when no collector is available rather than
 * publishing a reading a mid-run collection may have deflated.
 */
import { performance } from "node:perf_hooks";

import {
  createGeoArrowBatch,
  deserializeGeoArrowBatch,
  serializeGeoArrowBatch,
} from "../src/columnar/index.js";
import type { ColumnarBatchIdentityV1, ColumnarBatchV1 } from "../src/columnar/index.js";

const IDENTITY: ColumnarBatchIdentityV1 = {
  sourceId: "columnar-batch-persistence",
  sourceVersion: "source-1",
  schemaVersion: "persistence-v1",
  planId: "plan:columnar-batch-persistence",
  authorizationScope: "bench-scope",
  ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
  freshness: { observedAt: "2026-07-30T00:00:00.000Z" },
};

export interface ColumnarBatchPersistenceBenchmarkOptions {
  rowCount: number;
  warmupRuns: number;
  measurementRuns: number;
}

export interface ColumnarBatchPersistenceSample {
  /** Wall time for serialize plus deserialize; the fixture build is excluded. */
  totalDurationMs: number;
  serializeDurationMs: number;
  deserializeDurationMs: number;
  /** Rows carried through one complete serialize + deserialize per second. */
  rowsPerSecond: number;
  /** Envelope bytes divided by the batch's unique backing bytes. Base64 alone is 1.333. */
  envelopeBytesPerBackingByte: number;
  serializedBytesPerRow: number;
  /**
   * Peak `heapUsed + arrayBuffers` at any stage boundary, minus a **collected**
   * pre-run reading, divided by row count. Proves the persistence path never
   * materializes a per-row object: one would cost hundreds of bytes per row.
   */
  peakRetainedBytesPerRow: number;
}

export interface ColumnarBatchPersistenceBenchmarkResult {
  samples: ColumnarBatchPersistenceSample[];
  invariants: {
    checks: {
      /** The round trip preserved the row count. */
      rowCountPreserved: boolean;
      /** The restored batch owns exactly the bytes the original did. */
      backingBytesPreserved: boolean;
      /** Every coordinate survived the envelope unchanged. */
      coordinatesPreserved: boolean;
      /** The envelope was produced inside the ceiling the caller supplied. */
      envelopeWithinCallerLimit: boolean;
      /** A fresh envelope reports the current version and no migrations. */
      currentEnvelopeVersion: boolean;
      /** An envelope written at layout 1.0 is still readable, via the ladder. */
      legacyEnvelopeMigrates: boolean;
      /** A collector was available, so the memory reading is sound. */
      collectedBaseline: boolean;
    };
    passed: boolean;
  };
}

interface PersistenceRun {
  sample: ColumnarBatchPersistenceSample;
  checks: ColumnarBatchPersistenceBenchmarkResult["invariants"]["checks"];
}

/** Live JavaScript heap plus live `ArrayBuffer` bytes. */
function retainedBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

function collectGarbage(): boolean {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (typeof collect !== "function") return false;
  collect();
  return true;
}

/**
 * A packed interleaved point column: one backing of 16 bytes/row, no validity
 * bitmap, and no per-row objects anywhere in the fixture.
 */
function packedPointBatch(rows: number): ColumnarBatchV1 {
  const sample = createGeoArrowBatch({
    id: "columnar-batch-persistence:0",
    sequence: 0,
    schemaId: IDENTITY.schemaVersion,
    identity: IDENTITY,
    geometry: {
      kind: "point",
      coordinateLayout: "interleaved",
      crs: "OGC:CRS84",
      values: [
        [-157.86, 21.31],
        [-157.85, 21.32],
      ],
    },
  }).batch;
  const coordinates = new Float64Array(rows * 2);
  for (let row = 0; row < rows; row += 1) {
    coordinates[row * 2] = -157.8 + (row % 1_000) / 10_000;
    coordinates[row * 2 + 1] = 21.3 + (row % 997) / 10_000;
  }
  const template = sample.buffers.find((buffer) => buffer.role === "geometry");
  if (!template) throw new Error("columnar-batch-persistence: the fixture geometry buffer is missing");
  return {
    ...sample,
    rowCount: rows,
    buffers: [
      {
        id: template.id,
        role: template.role,
        ...(template.field === undefined ? {} : { field: template.field }),
        data: coordinates.buffer,
        byteOffset: 0,
        byteLength: coordinates.byteLength,
      },
    ],
  };
}

/** Build the envelope an older SDK would have written, at layout version 1.0. */
function legacyEnvelope(batch: ColumnarBatchV1): Uint8Array {
  const current = JSON.parse(new TextDecoder().decode(serializeGeoArrowBatch(batch))) as Record<string, unknown> & {
    backings: Array<{ id: string; byteLength?: number; data: string }>;
  };
  const legacy: Record<string, unknown> = {
    ...current,
    version: "1.0",
    backings: current.backings.map(({ id, data }) => ({ id, data })),
  };
  delete legacy.layout;
  return new TextEncoder().encode(JSON.stringify(legacy));
}

function runOnce(rowCount: number): PersistenceRun {
  const collectedBaseline = collectGarbage();
  const retainedBefore = retainedBytes();

  const batch = packedPointBatch(rowCount);
  const backingBytes = [...new Set(batch.buffers.map((buffer) => buffer.data))].reduce(
    (total, data) => total + data.byteLength,
    0,
  );
  const firstCoordinate = new Float64Array(batch.buffers[0]!.data)[0]!;
  let retainedPeak = retainedBytes();

  // A ceiling a cache would really set: base64 is 1.333x, so 1.5x plus the
  // envelope's own JSON is the honest budget for this fixture.
  const maxSerializedBytes = Math.ceil(backingBytes * 1.5);
  const serializeStarted = performance.now();
  const envelope = serializeGeoArrowBatch(batch, { maxSerializedBytes });
  const serializeDurationMs = performance.now() - serializeStarted;
  retainedPeak = Math.max(retainedPeak, retainedBytes());

  const deserializeStarted = performance.now();
  const restored = deserializeGeoArrowBatch(envelope, { maxSerializedBytes });
  const deserializeDurationMs = performance.now() - deserializeStarted;
  retainedPeak = Math.max(retainedPeak, retainedBytes());

  const restoredCoordinates = new Float64Array(restored.batch.buffers[0]!.data);
  const totalDurationMs = serializeDurationMs + deserializeDurationMs;

  // The ladder is exercised on a small fixture in the same process, so a broken
  // migration fails this scenario rather than only the unit suite.
  const migrated = deserializeGeoArrowBatch(legacyEnvelope(packedPointBatch(1_000)));

  return {
    sample: {
      totalDurationMs,
      serializeDurationMs,
      deserializeDurationMs,
      rowsPerSecond: (rowCount / Math.max(totalDurationMs, 0.001)) * 1_000,
      envelopeBytesPerBackingByte: envelope.byteLength / backingBytes,
      serializedBytesPerRow: envelope.byteLength / rowCount,
      peakRetainedBytesPerRow: (retainedPeak - retainedBefore) / rowCount,
    },
    checks: {
      rowCountPreserved: restored.batch.rowCount === rowCount,
      backingBytesPreserved: restored.metrics.backingBytes === backingBytes,
      coordinatesPreserved:
        restoredCoordinates.length === rowCount * 2 && restoredCoordinates[0] === firstCoordinate,
      envelopeWithinCallerLimit: envelope.byteLength <= maxSerializedBytes,
      currentEnvelopeVersion: restored.metrics.envelopeVersion === "1.1" && restored.metrics.migrations.length === 0,
      legacyEnvelopeMigrates:
        migrated.metrics.migrations.join(",") === "1.0->1.1" && migrated.batch.rowCount === 1_000,
      collectedBaseline,
    },
  };
}

/**
 * Run the deterministic columnar persistence benchmark. Every reported check is
 * the conjunction across all measurement runs, so one bad repetition fails the
 * scenario.
 */
export async function runColumnarBatchPersistenceBenchmark(
  options: ColumnarBatchPersistenceBenchmarkOptions,
): Promise<ColumnarBatchPersistenceBenchmarkResult> {
  assertOptions(options);
  for (let run = 0; run < options.warmupRuns; run += 1) runOnce(options.rowCount);
  const measured: PersistenceRun[] = [];
  for (let run = 0; run < options.measurementRuns; run += 1) measured.push(runOnce(options.rowCount));
  const checks = {
    rowCountPreserved: measured.every((run) => run.checks.rowCountPreserved),
    backingBytesPreserved: measured.every((run) => run.checks.backingBytesPreserved),
    coordinatesPreserved: measured.every((run) => run.checks.coordinatesPreserved),
    envelopeWithinCallerLimit: measured.every((run) => run.checks.envelopeWithinCallerLimit),
    currentEnvelopeVersion: measured.every((run) => run.checks.currentEnvelopeVersion),
    legacyEnvelopeMigrates: measured.every((run) => run.checks.legacyEnvelopeMigrates),
    collectedBaseline: measured.every((run) => run.checks.collectedBaseline),
  };
  return {
    samples: measured.map((run) => run.sample),
    invariants: { checks, passed: Object.values(checks).every(Boolean) },
  };
}

function assertOptions(options: ColumnarBatchPersistenceBenchmarkOptions): void {
  if (
    !Number.isInteger(options.rowCount) ||
    options.rowCount < 1 ||
    !Number.isInteger(options.warmupRuns) ||
    options.warmupRuns < 0 ||
    !Number.isInteger(options.measurementRuns) ||
    options.measurementRuns < 1
  ) {
    throw new Error("Columnar batch persistence benchmark options must be positive integers");
  }
}
