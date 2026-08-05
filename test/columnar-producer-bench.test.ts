import { describe, expect, it } from "vitest";

import { buildColumnarProducerFixture, runColumnarProducerBenchmark } from "../bench/columnar-producer-bench.js";

/**
 * The absolute budgets declared for `columnar.producer.million-row` in
 * `bench/budgets.json`. Duplicated here so a silent edit to either side fails.
 * The retention ceiling is the number issue #1042's NFR-001 names by reference
 * to `columnar.data-plane.million-feature`; the throughput floor is the
 * secondary gate, and the reasoning for setting it loosely is in the budgets
 * file.
 */
const BUDGETS = {
  peakRetainedBytesPerFeature: 160,
  backingBytesPerFeature: 24,
  featuresPerSecond: 300_000,
} as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("columnar GeoParquet producer benchmark", () => {
  it("requires a collector so the memory ceiling measures retention, not allocation rate", async () => {
    expect(typeof (globalThis as { gc?: () => void }).gc).toBe("function");

    const result = await runColumnarProducerBenchmark({ rowCount: 4_096, warmupRuns: 0, measurementRuns: 1 });
    expect(result.invariants.checks.collectedBaseline).toBe(true);
  });

  it("rejects impossible options before doing any work", async () => {
    const base = { rowCount: 1_024, warmupRuns: 0, measurementRuns: 1 };
    for (const override of [{ rowCount: 0 }, { warmupRuns: -1 }, { measurementRuns: 0 }]) {
      await expect(runColumnarProducerBenchmark({ ...base, ...override })).rejects.toThrow("positive integers");
    }
  });

  it("plans columnar execution and mints the batch identity from that plan", () => {
    const fixture = buildColumnarProducerFixture(1_000);

    // The scenario is on the shipped path: a plan that genuinely selected
    // columnar execution, not a producer call no planner would have made.
    expect(fixture.plan.representation.selected).toBe("columnar");
    expect(fixture.plan.validity.representation).toBe("columnar");
    expect(fixture.identity.planId).toBe(fixture.plan.validity.fingerprint);
    expect(fixture.identity.sourceId).toBe("columnar-producer-bench");
    // No ordering key is claimed, because the projected batch carries no column
    // an ordering contract could be honoured against.
    expect(fixture.identity.ordering).toEqual({ stable: false, keys: [] });
    // The driver hands over structs, nulls included; that is the producer input.
    expect(fixture.values[0]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(fixture.values[96]).toBeNull();
  });

  it("holds every producer invariant on a small deterministic run", async () => {
    const result = await runColumnarProducerBenchmark({ rowCount: 50_000, warmupRuns: 1, measurementRuns: 3 });

    expect(result.samples).toHaveLength(3);
    expect(result.invariants).toEqual({
      passed: true,
      checks: {
        collectedBaseline: true,
        planSelectedColumnar: true,
        identityPlanDerived: true,
        rowCountExact: true,
        geometryExact: true,
        nullsPreserved: true,
        featureIdsExact: true,
        repeatable: true,
      },
    });
    for (const sample of result.samples) {
      expect(sample.totalDurationMs).toBeGreaterThan(0);
      expect(sample.backingBytesPerFeature).toBeLessThanOrEqual(BUDGETS.backingBytesPerFeature);
    }
  });

  it("produces a million-row batch inside its declared absolute budgets", async () => {
    const result = await runColumnarProducerBenchmark({ rowCount: 1_000_000, warmupRuns: 1, measurementRuns: 5 });

    expect(result.invariants.passed).toBe(true);

    // NFR-001: the producer materializes no per-row object, so what it retains
    // is the batch's own packed columns. The materialized input column is live
    // when the baseline is taken, so this is the producer's own cost.
    expect(median(result.samples.map((sample) => sample.peakRetainedBytesPerFeature))).toBeLessThanOrEqual(
      BUDGETS.peakRetainedBytesPerFeature,
    );
    expect(median(result.samples.map((sample) => sample.backingBytesPerFeature))).toBeLessThanOrEqual(
      BUDGETS.backingBytesPerFeature,
    );
    expect(median(result.samples.map((sample) => sample.featuresPerSecond))).toBeGreaterThanOrEqual(
      BUDGETS.featuresPerSecond,
    );
  }, 180_000);
});
