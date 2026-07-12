import { describe, expect, it } from "vitest";

import { runOfflineReloadBenchmark, runRealtimeReconnectBenchmark } from "../bench/resilience-bench.js";

const offlineOptions = {
  resourceCount: 4,
  resourceBytes: 64,
  reloadCycles: 2,
  maxFreshnessAgeMs: 300_000,
  warmupRuns: 0,
  measurementRuns: 3,
} as const;

const realtimeOptions = {
  eventCount: 8,
  replayDuplicateCount: 2,
  maxFreshnessAgeMs: 300_000,
  warmupRuns: 0,
  measurementRuns: 3,
} as const;

describe("deterministic resilience benchmark", () => {
  it("reloads verified offline resources inside the fixed freshness boundary", async () => {
    const result = await runOfflineReloadBenchmark(offlineOptions);

    expect(result.invariants).toMatchObject({
      passed: true,
      checks: { expectedResources: 8, countsMatch: true, integrityVerified: true },
      semantics: {
        freshness: { status: "fresh", ageMs: 60_000, maxAgeMs: 300_000 },
        cursor: { present: false },
        retry: { count: 0 },
        ordering: { status: "not-applicable" },
        duplication: { ignoredCount: 0, appliedCount: 0 },
        credentialMaterialPresent: false,
      },
    });
    expect(result.samples).toHaveLength(3);
    expect(result.samples.every((sample) => sample.totalDurationMs >= 0 && sample.operationsPerSecond > 0)).toBe(true);
  });

  it("resumes from a present cursor, retries once, and rejects replay duplicates in order", async () => {
    const result = await runRealtimeReconnectBenchmark(realtimeOptions);

    expect(result.invariants).toMatchObject({
      passed: true,
      checks: {
        cursorPresent: true,
        retryCount: 1,
        orderingPreserved: true,
        expectedDuplicateIgnoredCount: 2,
        duplicateIgnoredCount: 2,
        duplicateAppliedCount: 0,
      },
      semantics: {
        freshness: { status: "fresh" },
        cursor: { present: true },
        retry: { count: 1 },
        ordering: { status: "preserved" },
        duplication: { ignoredCount: 2, appliedCount: 0 },
        credentialMaterialPresent: false,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("internal-cursor");
    expect(serialized).not.toMatch(/Bearer\s|token=|secret/i);
  });

  it("fails deliberate stale and corrupt offline reload fixtures", async () => {
    const stale = await runOfflineReloadBenchmark({ ...offlineOptions, fault: "stale" });
    const corrupt = await runOfflineReloadBenchmark({ ...offlineOptions, fault: "corrupt-resource" });

    expect(stale.invariants).toMatchObject({ passed: false, semantics: { freshness: { status: "stale" } } });
    expect(corrupt.invariants).toMatchObject({ passed: false, checks: { integrityVerified: false } });
  });

  it("fails deliberate realtime ordering and duplicate-application fixtures", async () => {
    const gap = await runRealtimeReconnectBenchmark({ ...realtimeOptions, fault: "sequence-gap" });
    const duplicateApplied = await runRealtimeReconnectBenchmark({ ...realtimeOptions, fault: "duplicate-applied" });

    expect(gap.invariants).toMatchObject({
      passed: false,
      checks: { orderingPreserved: false },
      semantics: { ordering: { status: "violated" } },
    });
    expect(duplicateApplied.invariants).toMatchObject({
      passed: false,
      checks: { duplicateAppliedCount: 1 },
      semantics: { duplication: { appliedCount: 1 } },
    });
  });
});
