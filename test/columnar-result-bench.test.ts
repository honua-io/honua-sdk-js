import { describe, expect, it } from "vitest";

import {
  buildColumnarResultConversionFixture,
  runColumnarResultConversionBenchmark,
} from "../bench/columnar-result-bench.js";
import { columnarBatchToResult } from "../src/columnar/index.js";

/**
 * The absolute budgets declared for `columnar.result.bounded-window` in
 * `bench/budgets.json`. Duplicated here so a silent edit to either side fails.
 * Both failure thresholds are the numbers issue #942 itself names: NFR-001's
 * 1 MB per 1,000 converted features is exactly 1,024 bytes/feature, and NFR-002
 * sets the throughput floor.
 */
const BUDGETS = {
  retainedBytesPerFeature: 1_024,
  featuresPerSecond: 200_000,
} as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("columnar bounded conversion benchmark", () => {
  it("requires a collector so the memory ceiling measures retention, not allocation rate", async () => {
    // `vitest.config.ts` passes `--expose-gc`, and `npm run bench:lab` does the
    // same. Without it the harness cannot take a collected baseline, and the
    // reading would be an allocation-rate number that no per-feature ceiling
    // could bound.
    expect(typeof (globalThis as { gc?: () => void }).gc).toBe("function");

    const result = await runColumnarResultConversionBenchmark({
      batchRowCount: 4_096,
      windowSize: 256,
      warmupRuns: 0,
      measurementRuns: 1,
    });
    expect(result.invariants.checks.collectedBaseline).toBe(true);
  });

  it("rejects impossible options before doing any work", async () => {
    const base = { batchRowCount: 1_024, windowSize: 64, warmupRuns: 0, measurementRuns: 1 };
    for (const override of [
      { batchRowCount: 0 },
      { windowSize: 0 },
      { warmupRuns: -1 },
      { measurementRuns: 0 },
      // A window larger than the batch is not a bounded window of a batch.
      { windowSize: 2_048 },
    ]) {
      await expect(runColumnarResultConversionBenchmark({ ...base, ...override })).rejects.toThrow("positive integers");
    }
  });

  it("cuts its window from the middle of the batch, not from row zero", () => {
    const fixture = buildColumnarResultConversionFixture(10_000, 1_000);
    expect(fixture.windowOffset).toBe(4_500);
    expect(fixture.batch.rowCount).toBe(10_000);
    // A conversion that quietly read from the start of the buffers would return
    // row 0 here; the fixture is built so that is observably wrong.
    const converted = columnarBatchToResult(fixture.batch, {
      offset: fixture.windowOffset,
      limit: fixture.windowSize,
      maxFeatures: fixture.windowSize,
    });
    expect(converted.features[0]!.attributes.fid).toBe(4_500);
    expect(converted.features.at(-1)!.attributes.fid).toBe(5_499);
    // Nulls are on the hot path in both nullable columns.
    expect(converted.features.some((feature) => feature.attributes.category === null)).toBe(true);
    expect(converted.features.some((feature) => feature.attributes.observedAt === null)).toBe(true);
  });

  it("holds every conversion invariant on a small deterministic run", async () => {
    const result = await runColumnarResultConversionBenchmark({
      batchRowCount: 50_000,
      windowSize: 1_000,
      warmupRuns: 1,
      measurementRuns: 3,
    });

    expect(result.samples).toHaveLength(3);
    expect(result.invariants).toEqual({
      passed: true,
      checks: {
        collectedBaseline: true,
        windowExact: true,
        orderingExact: true,
        inputBatchUnmutated: true,
        repeatable: true,
        pagingMatchesWindow: true,
        cancellable: true,
      },
    });
    for (const sample of result.samples) {
      expect(sample.totalDurationMs).toBeGreaterThan(0);
      expect(sample.retainedBytesPerFeature).toBeGreaterThan(0);
    }
  });

  it("converts a bounded window of a million-row batch inside its declared absolute budgets", async () => {
    const result = await runColumnarResultConversionBenchmark({
      batchRowCount: 1_000_000,
      windowSize: 1_000,
      warmupRuns: 1,
      measurementRuns: 5,
    });

    expect(result.invariants.passed).toBe(true);

    // NFR-001: retention is bounded by the window, not the batch. The batch's
    // own backings are already live when the baseline is taken, so this is what
    // the converted window costs on top of them.
    expect(median(result.samples.map((sample) => sample.retainedBytesPerFeature))).toBeLessThanOrEqual(
      BUDGETS.retainedBytesPerFeature,
    );
    // NFR-002: conversion throughput floor. The window is one thousandth of the
    // batch, so an implementation that scanned the whole batch per conversion
    // would miss this by orders of magnitude while still being correct.
    expect(median(result.samples.map((sample) => sample.featuresPerSecond))).toBeGreaterThanOrEqual(
      BUDGETS.featuresPerSecond,
    );
  }, 180_000);
});
