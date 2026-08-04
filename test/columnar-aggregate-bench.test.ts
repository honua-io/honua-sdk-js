import { describe, expect, it } from "vitest";

import { buildColumnarAggregateFixture, runColumnarAggregateBenchmark } from "../bench/columnar-aggregate-bench.js";

/**
 * The absolute budgets declared for `columnar.aggregate.million-row` in
 * `bench/budgets.json`. Duplicated here so a silent edit to either side fails.
 * The two failure thresholds are the numbers issue #939 itself names.
 */
const BUDGETS = {
  retainedBytesPerInputRow: 8,
  inputRowsPerSecond: 2_000_000,
  outputBackingBytesPerGroup: 64,
} as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("columnar aggregate benchmark", () => {
  it("requires a collector so the memory ceiling measures retention, not allocation rate", async () => {
    // `vitest.config.ts` passes `--expose-gc`, and `npm run bench:lab` does the
    // same. Without it the harness cannot force a collection at its retention
    // checkpoints, and the reading would be an allocation-rate number that no
    // per-input-row ceiling could bound.
    expect(typeof (globalThis as { gc?: () => void }).gc).toBe("function");

    const result = await runColumnarAggregateBenchmark({
      inputRowCount: 4_096,
      groupCount: 16,
      warmupRuns: 0,
      measurementRuns: 1,
    });
    expect(result.invariants.checks.collectedBaseline).toBe(true);
  });

  it("rejects non-positive options before doing any work", async () => {
    await expect(
      runColumnarAggregateBenchmark({ inputRowCount: 0, groupCount: 8, warmupRuns: 0, measurementRuns: 1 }),
    ).rejects.toThrow("positive integers");
    await expect(
      runColumnarAggregateBenchmark({ inputRowCount: 16, groupCount: 0, warmupRuns: 0, measurementRuns: 1 }),
    ).rejects.toThrow("positive integers");
    await expect(
      runColumnarAggregateBenchmark({ inputRowCount: 16, groupCount: 4, warmupRuns: -1, measurementRuns: 1 }),
    ).rejects.toThrow("positive integers");
    await expect(
      runColumnarAggregateBenchmark({ inputRowCount: 16, groupCount: 4, warmupRuns: 0, measurementRuns: 0 }),
    ).rejects.toThrow("positive integers");
  });

  it("computes an exactly representable reference reduction", () => {
    const fixture = buildColumnarAggregateFixture(10_000, 8);
    expect(fixture.groupKeys).toHaveLength(8);
    // Zero padding makes lexicographic order the group index order, which is
    // the order the reduction is required to emit.
    expect([...fixture.groupKeys].sort()).toEqual([...fixture.groupKeys]);
    expect(fixture.counts.reduce((total, count) => total + count, 0)).toBe(10_000);
    // Every coordinate sits on a lattice of eighths, so every reference sum is
    // an exact double and no summation order can perturb it.
    for (const sum of fixture.sums) expect(Number.isInteger(sum * 8)).toBe(true);
  });

  it("holds every reduction invariant on a small deterministic run", async () => {
    const result = await runColumnarAggregateBenchmark({
      inputRowCount: 20_000,
      groupCount: 64,
      warmupRuns: 1,
      measurementRuns: 3,
    });

    expect(result.samples).toHaveLength(3);
    expect(result.invariants).toEqual({
      passed: true,
      checks: {
        collectedBaseline: true,
        monotonicProgress: true,
        groupsExact: true,
        metricsExact: true,
        inputBatchUnmutated: true,
        repeatable: true,
        yieldCadenceIndependent: true,
      },
    });
    for (const sample of result.samples) {
      expect(sample.totalDurationMs).toBeGreaterThan(0);
      expect(sample.retainedBytesPerInputRow).toBeGreaterThanOrEqual(0);
      // The result carries a group key plus two metric columns; its size is a
      // constant of the field set, not of the input row count.
      expect(sample.outputBackingBytesPerGroup).toBeLessThanOrEqual(BUDGETS.outputBackingBytesPerGroup);
    }
  });

  it("reduces a million rows inside its declared absolute budgets", async () => {
    const result = await runColumnarAggregateBenchmark({
      inputRowCount: 1_000_000,
      groupCount: 1_024,
      warmupRuns: 1,
      measurementRuns: 3,
    });

    expect(result.invariants.passed).toBe(true);

    // NFR-001: retention is bounded by the group count, not the row count. A
    // decode-then-reduce implementation would hold 1,000,000 feature objects
    // live at these checkpoints and cost hundreds of bytes per input row.
    expect(median(result.samples.map((sample) => sample.retainedBytesPerInputRow))).toBeLessThanOrEqual(
      BUDGETS.retainedBytesPerInputRow,
    );
    // NFR-002: reduction throughput floor.
    expect(median(result.samples.map((sample) => sample.inputRowsPerSecond))).toBeGreaterThanOrEqual(
      BUDGETS.inputRowsPerSecond,
    );
    for (const sample of result.samples) {
      expect(sample.outputBackingBytesPerGroup).toBeLessThanOrEqual(BUDGETS.outputBackingBytesPerGroup);
    }
  }, 180_000);
});
