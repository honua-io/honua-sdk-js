import { describe, expect, it } from "vitest";
// The report script is plain ESM; import its pure comparison helper directly.
import { evaluateBudgets, evaluateErrorNfrReductions } from "../scripts/report-bundle-sizes.mjs";

describe("evaluateBudgets", () => {
  const budgets = {
    ".": { min: 1000, gzip: 400 },
    "/expr": { min: 100, gzip: 40 },
  };

  it("passes when every entry is at or under both ceilings", () => {
    const measurements = {
      ".": { min: 900, gzip: 350 },
      "/expr": { min: 100, gzip: 40 },
    };
    const { failures, missingBudget } = evaluateBudgets(measurements, budgets);
    expect(failures).toHaveLength(0);
    expect(missingBudget).toHaveLength(0);
  });

  it("flags an entry that exceeds the min ceiling", () => {
    const measurements = {
      ".": { min: 1200, gzip: 350 },
      "/expr": { min: 100, gzip: 40 },
    };
    const { failures } = evaluateBudgets(measurements, budgets);
    expect(failures).toHaveLength(1);
    expect(failures[0].key).toBe(".");
    expect(failures[0].minDelta).toBe(200);
    expect(failures[0].gzipDelta).toBeLessThanOrEqual(0);
  });

  it("flags an entry that exceeds only the gzip ceiling", () => {
    const measurements = {
      ".": { min: 900, gzip: 350 },
      "/expr": { min: 90, gzip: 55 },
    };
    const { failures } = evaluateBudgets(measurements, budgets);
    expect(failures).toHaveLength(1);
    expect(failures[0].key).toBe("/expr");
    expect(failures[0].gzipDelta).toBe(15);
  });

  it("reports entries that have no declared budget instead of silently passing", () => {
    const measurements = {
      ".": { min: 900, gzip: 350 },
      "/expr": { min: 90, gzip: 30 },
      "/mystery": { min: 10, gzip: 5 },
    };
    const { failures, missingBudget } = evaluateBudgets(measurements, budgets);
    expect(failures).toHaveLength(0);
    expect(missingBudget).toEqual(["/mystery"]);
  });
});

describe("evaluateErrorNfrReductions", () => {
  it("uses the integer 25% ceiling without rounding it upward", () => {
    const baselines = { "/routing": 7_109 };
    expect(evaluateErrorNfrReductions({ "/routing": { gzip: 5_331 } }, baselines).failures).toHaveLength(0);
    expect(evaluateErrorNfrReductions({ "/routing": { gzip: 5_332 } }, baselines).failures).toHaveLength(1);
  });

  it("fails closed when a contractual target is absent", () => {
    expect(evaluateErrorNfrReductions({}, { "/offline": 12_301 }).failures).toEqual([
      { key: "/offline", reason: "missing measurement" },
    ]);
  });
});
