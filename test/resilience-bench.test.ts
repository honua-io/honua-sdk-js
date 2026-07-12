import { describe, expect, it } from "vitest";

import { applyBenchmarkArtifactSafety, createBenchmarkReport } from "../bench/lab.js";
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

  it("derives secrecy from the complete generated v2 report and fails a leaked cursor value", async () => {
    const report = await createBenchmarkReport({ corpus: "bench/corpus.json", budgets: "bench/budgets.json" });
    const resilience = report.scenarios.filter((scenario) => scenario.invariants.semantics);

    expect(report.schemaVersion).toBe(2);
    expect(resilience.map((scenario) => scenario.kind)).toEqual(["offline-reload", "realtime-reconnect"]);
    expect(
      resilience.every(
        (scenario) => scenario.invariants.passed && scenario.invariants.semantics?.credentialMaterialPresent === false,
      ),
    ).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("internal-cursor");
    expect(serialized).not.toMatch(/Bearer\s|token=|secret/i);

    const leaked = structuredClone(report);
    const reconnect = leaked.scenarios.find((scenario) => scenario.kind === "realtime-reconnect");
    const offline = leaked.scenarios.find((scenario) => scenario.kind === "offline-reload");
    if (!reconnect?.invariants.checks) throw new Error("Missing realtime reconnect report projection");
    if (!offline?.invariants.checks) throw new Error("Missing offline reload report projection");
    reconnect.invariants.checks = { ...reconnect.invariants.checks, cursorValue: "opaque-replay-position" };
    offline.invariants.checks = { ...offline.invariants.checks, authorization: "Bearer leaked-fixture-value" };
    applyBenchmarkArtifactSafety(leaked);

    expect(reconnect.invariants.passed).toBe(false);
    expect(reconnect.invariants.semantics?.credentialMaterialPresent).toBe(true);
    expect(offline.invariants.passed).toBe(false);
    expect(offline.invariants.semantics?.credentialMaterialPresent).toBe(true);
  }, 15_000);
});
