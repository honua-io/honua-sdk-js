import { describe, expect, it } from "vitest";

import {
  type BenchmarkReport,
  type MetricSummary,
  evaluateRelativeBudget,
  evaluateReport,
  summarizeSamples,
} from "../bench/lab.js";
import { runQueryResourceHandleBenchmark } from "../bench/query-resource-bench.js";

const stableMetric = (median = 100): MetricSummary => ({
  min: median,
  max: median,
  mean: median,
  median,
  p95: median,
  coefficientOfVariation: 0,
});

const budgets: Parameters<typeof evaluateReport>[1] = {
  schemaVersion: 1,
  variability: {
    warningCoefficientOfVariation: 0.2,
    failureCoefficientOfVariation: 0.5,
  },
  relativeRegression: {
    totalDurationMs: {
      direction: "lower-is-better",
      warningPercent: 15,
      failurePercent: 30,
    },
    featuresPerSecond: {
      direction: "higher-is-better",
      warningPercent: 15,
      failurePercent: 30,
    },
  },
};

function benchmarkReport(
  environment: Partial<BenchmarkReport["environment"]> = {},
  invariantsPassed = true,
): BenchmarkReport {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-10T00:00:00.000Z",
    gitCommit: "fixture",
    corpus: { id: "fixture", sha256: "same-corpus", description: "fixture" },
    methodology: {
      scope: "sdk-overhead",
      transport: "deterministic-in-process-fixture",
      crossSdkComparable: false,
      note: "fixture",
    },
    environment: {
      implementation: "honua-sdk-js",
      node: "v20.19.0",
      nodeMajor: 20,
      platform: "linux",
      release: "6.11.0-fixture",
      arch: "x64",
      cpuModel: "fixture-cpu",
      logicalCpuCount: 4,
      totalMemoryBytes: 16_000_000_000,
      ci: true,
      githubRunnerImage: "ubuntu24",
      ...environment,
    },
    scenarios: [
      {
        id: "stream.pagination.geometry",
        kind: "stream-pagination",
        parameters: {
          featureCount: 1_000,
          pageSize: 100,
          pageLatencyMs: 0,
          returnGeometry: true,
          warmupRuns: 1,
          measurementRuns: 5,
        },
        samples: [
          {
            totalDurationMs: 100,
            timeToFirstPageMs: 10,
            featuresPerSecond: 10_000,
            heapUsedDeltaBytes: 1_000,
            heapUsedPeakBytes: 10_000,
            totalFeatures: 1_000,
            pageCount: 10,
          },
        ],
        summary: {
          totalDurationMs: stableMetric(100),
          timeToFirstPageMs: stableMetric(10),
          featuresPerSecond: stableMetric(10_000),
          heapUsedDeltaBytes: stableMetric(1_000),
          heapUsedPeakBytes: stableMetric(10_000),
        },
        invariants: {
          expectedTotalFeatures: 1_000,
          expectedPageCount: 10,
          passed: invariantsPassed,
        },
      },
    ],
    artifactSafety: { passed: true, credentialMaterialPresent: false },
    evaluation: { level: "pass", baselineCompatibility: null, items: [] },
  };
}

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

describe("opaque query resource benchmark", () => {
  it("keeps repeated plan, cache, and resolver work deterministic and credential-free", async () => {
    const report = await runQueryResourceHandleBenchmark({
      operationCount: 8,
      warmupRuns: 1,
      measurementRuns: 3,
    });

    expect(report.samples).toHaveLength(3);
    expect(report.samples.every((sample) => sample.totalDurationMs >= 0 && sample.operationsPerSecond > 0)).toBe(true);
    expect(report.invariants).toEqual({
      passed: true,
      checks: {
        exactOperationCount: true,
        planSurfacesRedacted: true,
        cacheStableAcrossRotation: true,
        scopePartitioned: true,
        resolverRoundTrip: true,
      },
    });
    expect(JSON.stringify(report)).not.toContain("first-private-value");
    expect(JSON.stringify(report)).not.toContain("rotated-private-value");
  });
});

describe("benchmark baseline contract", () => {
  it("keeps a skipped supplied baseline not-compared when local checks pass", () => {
    const evaluation = evaluateReport(benchmarkReport(), budgets, benchmarkReport({ release: "6.10.0-older" }));

    expect(evaluation.level).toBe("not-compared");
    expect(evaluation.baselineCompatibility).toEqual({ comparable: false, reasons: ["release differs"] });
    expect(evaluation.items).toContainEqual(
      expect.objectContaining({ metric: "baseline-compatibility", level: "not-compared" }),
    );
  });

  it("refuses to compare a legacy report schema even when host and corpus metadata match", () => {
    const legacy = structuredClone(benchmarkReport()) as unknown as { schemaVersion: number };
    legacy.schemaVersion = 1;
    const evaluation = evaluateReport(benchmarkReport(), budgets, legacy as BenchmarkReport);

    expect(evaluation.level).toBe("not-compared");
    expect(evaluation.baselineCompatibility?.reasons).toContain("report schema version differs");
  });

  it("fails correctness even when the supplied baseline is incompatible", () => {
    const evaluation = evaluateReport(
      benchmarkReport({}, false),
      budgets,
      benchmarkReport({ release: "6.10.0-older" }),
    );

    expect(evaluation.level).toBe("failure");
  });

  it("requires exact runner images when either report identifies one", () => {
    const exactImage = evaluateReport(benchmarkReport(), budgets, benchmarkReport());
    expect(exactImage.level).toBe("pass");
    expect(exactImage.baselineCompatibility).toEqual({ comparable: true, reasons: [] });

    const differentImage = evaluateReport(
      benchmarkReport(),
      budgets,
      benchmarkReport({ githubRunnerImage: "ubuntu22" }),
    );
    expect(differentImage.level).toBe("not-compared");
    expect(differentImage.baselineCompatibility?.reasons).toContain("githubRunnerImage differs");

    const baselineWithoutRunnerImage = benchmarkReport();
    delete (baselineWithoutRunnerImage.environment as Partial<BenchmarkReport["environment"]>).githubRunnerImage;
    const missingImage = evaluateReport(benchmarkReport(), budgets, baselineWithoutRunnerImage);
    expect(missingImage.level).toBe("not-compared");
    expect(missingImage.baselineCompatibility?.reasons).toContain("githubRunnerImage availability differs");
  });

  it("allows like-mode local environments when runner-image identifiers are null or omitted", () => {
    const localEnvironment = { ci: false, githubRunnerImage: null } as const;
    const localBaseline = benchmarkReport(localEnvironment);
    delete (localBaseline.environment as Partial<BenchmarkReport["environment"]>).githubRunnerImage;
    const evaluation = evaluateReport(benchmarkReport(localEnvironment), budgets, localBaseline);

    expect(evaluation.level).toBe("pass");
    expect(evaluation.baselineCompatibility).toEqual({ comparable: true, reasons: [] });
  });
});
