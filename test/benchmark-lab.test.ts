import { describe, expect, it } from "vitest";

import { evaluateRelativeBudget, summarizeSamples } from "../bench/lab.js";

describe("benchmark lab statistics", () => {
  it("reports stable repeated-sample summaries", () => {
    const summary = summarizeSamples([10, 20, 30, 40, 50]);

    expect(summary).toMatchObject({ min: 10, max: 50, mean: 30, median: 30, p95: 50 });
    expect(summary.coefficientOfVariation).toBeCloseTo(Math.sqrt(200) / 30);
  });

  it("rejects empty sample sets", () => {
    expect(() => summarizeSamples([])).toThrow("empty sample set");
  });

  it("detects deliberate duration and throughput regressions", () => {
    const thresholds = { warningPercent: 15, failurePercent: 30 };

    expect(evaluateRelativeBudget(131, 100, { ...thresholds, direction: "lower-is-better" })).toMatchObject({
      level: "failure",
      regressionPercent: 31,
    });
    expect(evaluateRelativeBudget(69, 100, { ...thresholds, direction: "higher-is-better" })).toMatchObject({
      level: "failure",
      regressionPercent: 31,
    });
    expect(evaluateRelativeBudget(116, 100, { ...thresholds, direction: "lower-is-better" })).toMatchObject({
      level: "warning",
      regressionPercent: 16,
    });
  });
});
