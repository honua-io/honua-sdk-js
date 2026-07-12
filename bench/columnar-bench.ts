/**
 * Deterministic million-feature columnar rendering benchmark.
 *
 * Validates the #387 large-data (columnar path) memory and throughput budgets:
 * a million-feature batch is bound directly to deck.gl GPU-binary attributes
 * with **no GeoJSON conversion and zero payload copies**. The harness proves the
 * projected attribute buffers alias the batch's backing allocations, so memory
 * stays bounded to the packed columns (no per-feature object materialization),
 * and reports sustained features/second.
 *
 * There is no live server or renderer: a stub deck.gl layer captures the
 * forwarded binary `data` so the run measures the SDK's columnar → GPU-binary
 * projection cost only, exactly like the other deterministic bench harnesses.
 */
import { createDeckGlAdapter } from "../src/deckgl/adapter.js";
import { bindColumnarBatchToDeckGl } from "../src/deckgl/columnar.js";
import type { DeckGlLayer } from "../src/deckgl/types.js";
import {
  COLUMNAR_FIXTURE_BUFFER_IDS,
  COLUMNAR_FIXTURE_BYTES_PER_FEATURE,
  buildColumnarBatchFixture,
} from "./columnar-fixture.js";

/** Captures the binary data deck.gl would receive; performs no rendering. */
class StubBinaryLayer implements DeckGlLayer {
  public readonly id: string | undefined;
  public readonly data: unknown;
  public constructor(props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
    this.data = props.data;
  }
}

export interface ColumnarBenchBudgets {
  /** Ceiling on backing bytes per feature. The packed columns are the only cost. */
  readonly maxBytesPerFeature: number;
  /** Floor on sustained projection throughput (features/second). */
  readonly minFeaturesPerSecond: number;
}

/** Conservative, machine-tolerant #387 columnar-path budgets. */
export const DEFAULT_COLUMNAR_BENCH_BUDGETS: ColumnarBenchBudgets = Object.freeze({
  // Packed columns are exactly 20 bytes/feature; allow a small envelope.
  maxBytesPerFeature: COLUMNAR_FIXTURE_BYTES_PER_FEATURE + 4,
  // Very conservative floor; typical hosts project millions of rows/second.
  minFeaturesPerSecond: 100_000,
});

export interface ColumnarBenchSample {
  readonly bindDurationMs: number;
  readonly projectDurationMs: number;
  readonly featuresPerSecond: number;
  readonly heapUsedDeltaBytes: number;
}

export interface ColumnarBenchResult {
  readonly featureCount: number;
  readonly backingBytes: number;
  readonly bytesPerFeature: number;
  readonly copiedBytes: number;
  readonly zeroCopyVerified: boolean;
  readonly samples: readonly ColumnarBenchSample[];
  readonly median: ColumnarBenchSample;
  readonly budgets: ColumnarBenchBudgets;
  readonly evaluation: {
    readonly memoryWithinBudget: boolean;
    readonly throughputWithinBudget: boolean;
    readonly passed: boolean;
  };
}

export interface RunColumnarBenchOptions {
  readonly featureCount?: number;
  readonly warmupRuns?: number;
  readonly measurementRuns?: number;
  readonly budgets?: ColumnarBenchBudgets;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Run the columnar → deck.gl projection benchmark and evaluate it against the
 * columnar-path budgets. `zeroCopyVerified` asserts each forwarded attribute
 * buffer is the batch's own `ArrayBuffer`.
 */
export function runColumnarBench(options: RunColumnarBenchOptions = {}): ColumnarBenchResult {
  const featureCount = options.featureCount ?? 1_000_000;
  const warmupRuns = options.warmupRuns ?? 1;
  const measurementRuns = options.measurementRuns ?? 3;
  const budgets = options.budgets ?? DEFAULT_COLUMNAR_BENCH_BUDGETS;

  const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: StubBinaryLayer } });

  let backingBytes = 0;
  let copiedBytes = Number.NaN;
  let zeroCopyVerified = false;

  const measure = (record: boolean): ColumnarBenchSample => {
    const { fixture, batch } = buildColumnarBatchFixture(featureCount);
    backingBytes = fixture.backingBytes;

    const bindStart = now();
    const request = bindColumnarBatchToDeckGl({
      batch,
      layerId: "columnar-bench",
      attributes: [
        { accessor: "getPosition", bufferId: COLUMNAR_FIXTURE_BUFFER_IDS.position, component: "float32", size: 2 },
        { accessor: "getRadius", bufferId: COLUMNAR_FIXTURE_BUFFER_IDS.radius, component: "float32", size: 1 },
        {
          accessor: "getFillColor",
          bufferId: COLUMNAR_FIXTURE_BUFFER_IDS.fillColor,
          component: "uint8",
          size: 4,
          normalized: true,
        },
      ],
      identity: {
        sourceId: "columnar-bench",
        planId: "plan:columnar-bench",
        featureIdColumn: { bufferId: COLUMNAR_FIXTURE_BUFFER_IDS.id, component: "uint32" },
      },
    });
    const bindDurationMs = now() - bindStart;

    if (typeof globalThis.gc === "function") globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const projectStart = now();
    const projection = adapter.project(request);
    const projectDurationMs = now() - projectStart;
    const heapUsedDeltaBytes = process.memoryUsage().heapUsed - heapBefore;

    if (record) {
      copiedBytes = projection.metrics.copiedBytes;
      const layer = projection.layer as StubBinaryLayer;
      const forwarded = layer.data as { attributes: Record<string, { value: ArrayBufferView }> };
      zeroCopyVerified =
        forwarded.attributes.getPosition.value.buffer === batch.buffers[0]!.data &&
        forwarded.attributes.getRadius.value.buffer === batch.buffers[1]!.data &&
        forwarded.attributes.getFillColor.value.buffer === batch.buffers[2]!.data;
    }

    const totalMs = bindDurationMs + projectDurationMs;
    return {
      bindDurationMs,
      projectDurationMs,
      featuresPerSecond: totalMs === 0 ? Number.POSITIVE_INFINITY : (featureCount / totalMs) * 1000,
      heapUsedDeltaBytes,
    };
  };

  for (let run = 0; run < warmupRuns; run += 1) measure(false);
  const samples: ColumnarBenchSample[] = [];
  for (let run = 0; run < measurementRuns; run += 1) samples.push(measure(run === 0));

  const medianSample: ColumnarBenchSample = {
    bindDurationMs: median(samples.map((s) => s.bindDurationMs)),
    projectDurationMs: median(samples.map((s) => s.projectDurationMs)),
    featuresPerSecond: median(samples.map((s) => s.featuresPerSecond)),
    heapUsedDeltaBytes: median(samples.map((s) => s.heapUsedDeltaBytes)),
  };

  const bytesPerFeature = featureCount === 0 ? 0 : backingBytes / featureCount;
  const memoryWithinBudget = bytesPerFeature <= budgets.maxBytesPerFeature;
  const throughputWithinBudget = medianSample.featuresPerSecond >= budgets.minFeaturesPerSecond;

  return {
    featureCount,
    backingBytes,
    bytesPerFeature,
    copiedBytes,
    zeroCopyVerified,
    samples,
    median: medianSample,
    budgets,
    evaluation: {
      memoryWithinBudget,
      throughputWithinBudget,
      passed: memoryWithinBudget && throughputWithinBudget && zeroCopyVerified && copiedBytes === 0,
    },
  };
}

async function main(): Promise<void> {
  const featureCount = Number.parseInt(process.argv[2] ?? "1000000", 10);
  const result = runColumnarBench({ featureCount });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `columnar-bench: ${result.featureCount.toLocaleString()} features, ` +
      `${Math.round(result.median.featuresPerSecond).toLocaleString()} features/s, ` +
      `${result.bytesPerFeature.toFixed(1)} bytes/feature, copiedBytes=${result.copiedBytes}, ` +
      `zeroCopy=${result.zeroCopyVerified}, evaluation ${result.evaluation.passed ? "pass" : "FAIL"}\n`,
  );
  if (!result.evaluation.passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`columnar-bench failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
