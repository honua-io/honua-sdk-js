import { describe, expect, it } from "vitest";

import { runColumnarDataPlaneBenchmark } from "../bench/columnar-data-plane-bench.js";
import { COLUMNAR_FIXTURE_BYTES_PER_FEATURE } from "../bench/columnar-fixture.js";

/**
 * The absolute budgets declared for `columnar.data-plane.million-feature` in
 * `bench/budgets.json`. Duplicated here so a silent edit to either side fails.
 */
const BUDGETS = {
  backingBytesPerFeature: 24,
  peakRetainedBytesPerFeature: 160,
  featuresPerSecond: 500_000,
} as const;

describe("columnar data-plane benchmark", () => {
  it("rejects non-positive options before doing any work", async () => {
    await expect(runColumnarDataPlaneBenchmark({ featureCount: 0, warmupRuns: 0, measurementRuns: 1 })).rejects.toThrow(
      "positive integers",
    );
    await expect(
      runColumnarDataPlaneBenchmark({ featureCount: 10, warmupRuns: -1, measurementRuns: 1 }),
    ).rejects.toThrow("positive integers");
    await expect(
      runColumnarDataPlaneBenchmark({ featureCount: 10, warmupRuns: 0, measurementRuns: 0 }),
    ).rejects.toThrow("positive integers");
  });

  it("holds every data-plane invariant on a small deterministic run", async () => {
    const result = await runColumnarDataPlaneBenchmark({
      featureCount: 4_096,
      warmupRuns: 1,
      measurementRuns: 3,
    });

    expect(result.samples).toHaveLength(3);
    expect(result.invariants).toEqual({
      passed: true,
      checks: {
        zeroPayloadCopies: true,
        senderBuffersDetached: true,
        rendererAliasesBatchBuffers: true,
        monotonicProgress: true,
        rowCountPreserved: true,
        operationScannedEveryRow: true,
      },
    });
    for (const sample of result.samples) {
      expect(sample.copiedBytes).toBe(0);
      // Every packed column is transferred; nothing is left behind or cloned.
      expect(sample.transferBytes).toBe(4_096 * COLUMNAR_FIXTURE_BYTES_PER_FEATURE);
      expect(sample.backingBytesPerFeature).toBe(COLUMNAR_FIXTURE_BYTES_PER_FEATURE);
      expect(sample.totalDurationMs).toBeGreaterThan(0);
      expect(sample.totalDurationMs).toBeCloseTo(
        sample.buildDurationMs + sample.workerDurationMs + sample.renderDurationMs,
        6,
      );
    }
  });

  it("carries the million-feature run through the whole plane inside its declared budgets", async () => {
    const result = await runColumnarDataPlaneBenchmark({
      featureCount: 1_000_000,
      warmupRuns: 1,
      measurementRuns: 3,
    });

    expect(result.invariants.passed).toBe(true);

    // Memory is deterministic: the packed columns are the entire cost.
    for (const sample of result.samples) {
      expect(sample.copiedBytes).toBe(0);
      expect(sample.backingBytesPerFeature).toBe(COLUMNAR_FIXTURE_BYTES_PER_FEATURE);
      expect(sample.backingBytesPerFeature).toBeLessThanOrEqual(BUDGETS.backingBytesPerFeature);
    }

    const median = (values: readonly number[]): number => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)]!;
    };

    // Peak retained memory proves no per-feature object materialization: a
    // JavaScript feature object result for the same fixture costs 300+
    // bytes/feature. The peak is never below the live packed columns, so this
    // also proves the measurement itself is not being erased by a collection.
    for (const sample of result.samples) {
      expect(sample.peakRetainedBytesPerFeature).toBeGreaterThan(0);
    }
    expect(median(result.samples.map((sample) => sample.peakRetainedBytesPerFeature))).toBeLessThanOrEqual(
      BUDGETS.peakRetainedBytesPerFeature,
    );
    // The floor sits 4.3x below the worst median observed under heavy host
    // contention, so a loaded shared runner cannot flake it.
    expect(median(result.samples.map((sample) => sample.featuresPerSecond))).toBeGreaterThanOrEqual(
      BUDGETS.featuresPerSecond,
    );
  }, 120_000);
});
