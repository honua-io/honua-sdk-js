import { describe, expect, it } from "vitest";

import { DEFAULT_COLUMNAR_BENCH_BUDGETS, runColumnarBench } from "../bench/columnar-bench.js";
import {
  COLUMNAR_FIXTURE_BUFFER_IDS,
  COLUMNAR_FIXTURE_BYTES_PER_FEATURE,
  buildColumnarBatchFixture,
  buildColumnarFixture,
} from "../bench/columnar-fixture.js";

const MILLION = 1_000_000;

describe("million-feature columnar fixture", () => {
  it("packs one million features into four contiguous typed arrays (no per-feature objects)", () => {
    const fixture = buildColumnarFixture(MILLION);
    expect(fixture.featureCount).toBe(MILLION);
    // Memory is exactly the packed columns: 20 bytes/feature, nothing per-feature.
    expect(fixture.backingBytes).toBe(MILLION * COLUMNAR_FIXTURE_BYTES_PER_FEATURE);
    expect(fixture.position.length).toBe(MILLION * 2);
    expect(fixture.fillColor.length).toBe(MILLION * 4);
  });

  it("is deterministic: identical counts produce byte-for-byte identical buffers", () => {
    const a = buildColumnarFixture(1000);
    const b = buildColumnarFixture(1000);
    expect(Buffer.from(a.position.buffer)).toEqual(Buffer.from(b.position.buffer));
    expect(Buffer.from(a.fillColor.buffer)).toEqual(Buffer.from(b.fillColor.buffer));
    expect(Buffer.from(a.id.buffer)).toEqual(Buffer.from(b.id.buffer));
  });

  it("wraps the fixture as a validated columnar batch whose buffers alias the packed arrays", () => {
    const { fixture, batch } = buildColumnarBatchFixture(10_000);
    expect(batch.rowCount).toBe(10_000);
    const positionBuffer = batch.buffers.find((b) => b.id === COLUMNAR_FIXTURE_BUFFER_IDS.position);
    expect(positionBuffer?.data).toBe(fixture.position.buffer);
  });
});

describe("million-feature columnar rendering budget (#387 large-data path)", () => {
  it("projects a million features to deck.gl within memory and throughput budgets, zero-copy", () => {
    const result = runColumnarBench({ featureCount: MILLION, warmupRuns: 1, measurementRuns: 3 });

    // Zero GeoJSON conversion and zero payload copies.
    expect(result.copiedBytes).toBe(0);
    expect(result.zeroCopyVerified).toBe(true);

    // Memory budget: bounded to the packed columns, no per-feature materialization.
    expect(result.bytesPerFeature).toBeLessThanOrEqual(DEFAULT_COLUMNAR_BENCH_BUDGETS.maxBytesPerFeature);
    expect(result.evaluation.memoryWithinBudget).toBe(true);

    // Throughput budget: comfortably above the conservative floor on any host.
    expect(result.median.featuresPerSecond).toBeGreaterThanOrEqual(DEFAULT_COLUMNAR_BENCH_BUDGETS.minFeaturesPerSecond);
    expect(result.evaluation.throughputWithinBudget).toBe(true);

    expect(result.evaluation.passed).toBe(true);
  }, 60_000);
});
