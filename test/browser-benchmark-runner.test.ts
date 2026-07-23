import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BROWSER_CORPUS_SOURCE_FILES,
  browserCorpusFingerprint,
  evaluateOperationalScenarios,
  evaluateScenarios,
  runRepeatedScenario,
  summarize,
} from "../bench/browser/run.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const budgets = {
  schemaVersion: 2 as const,
  variability: {
    warningCoefficientOfVariation: 0.35,
    failureCoefficientOfVariation: 0.75,
  },
  scenarios: {
    renderer: {
      firstVisibleMs: { warning: 5_000, failure: 15_000 },
      interactionLatencyMs: { warning: 100, failure: 500 },
    },
  },
};

function scenario(firstVisibleMs: readonly number[], interactionLatencyMs: readonly number[], passed = true) {
  return {
    id: "renderer",
    summary: {
      firstVisibleMs: summarize(firstVisibleMs),
      interactionLatencyMs: summarize(interactionLatencyMs),
    },
    invariants: { passed },
  };
}

describe("browser benchmark budget evaluator", () => {
  it("fingerprints the versioned fixture pack actually served by the browser scenario", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-browser-corpus-"));
    const fixtureRoot = path.join(temporaryRoot, "first-map", "v1");
    fs.cpSync(path.join(repoRoot, "samples/fixtures/first-map/v1"), fixtureRoot, { recursive: true });
    try {
      const before = await browserCorpusFingerprint({ repoRoot, fixtureRoot });
      const featuresPath = path.join(fixtureRoot, "features.json");
      fs.appendFileSync(featuresPath, "\n");
      const after = await browserCorpusFingerprint({ repoRoot, fixtureRoot });

      expect(before.files).toContain("samples/fixtures/first-map/v1/manifest.json");
      expect(before.files).toContain("samples/fixtures/first-map/v1/features.json");
      expect(before.files).toContain("samples/fixtures/first-map/v1/layer.json");
      expect(before.files.some((file) => file.startsWith("test/fixtures/"))).toBe(false);
      expect(after.sha256).not.toBe(before.sha256);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fingerprints the reviewed browser scenario producer inventory", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-browser-producers-"));
    const sourceRoot = path.join(temporaryRoot, "repo");
    try {
      for (const relativePath of BROWSER_CORPUS_SOURCE_FILES) {
        const destination = path.join(sourceRoot, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, relativePath), destination);
      }

      const fixtureRoot = path.join(repoRoot, "samples/fixtures/first-map/v1");
      const before = await browserCorpusFingerprint({ repoRoot: sourceRoot, fixtureRoot });
      const producer = "samples/scenarios/handlers/first-map.mjs";
      fs.appendFileSync(path.join(sourceRoot, producer), "\n");
      const after = await browserCorpusFingerprint({ repoRoot: sourceRoot, fixtureRoot });

      expect(before.files).toContain("examples/maplibre-quickstart/mock-server.mjs");
      expect(before.files).toContain("samples/scenarios/server.mjs");
      expect(before.files).toContain(producer);
      expect(before.files).toContain("samples/scenarios/http.mjs");
      expect(before.files).toContain("samples/scenarios/run-registry.mjs");
      expect(before.files).toContain("samples/scenarios/determinism.mjs");
      expect(before.files).toContain("samples/scenarios/fixture-validation.mjs");
      expect(after.sha256).not.toBe(before.sha256);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("passes stable renderer samples below the reviewed bounds", () => {
    const evaluation = evaluateScenarios([scenario([900, 1_000, 1_100], [8, 9, 10])], budgets);
    expect(evaluation.level).toBe("pass");
    expect(evaluation.items).toHaveLength(5);
  });

  it("proves a deliberate rendering regression fails the gate", () => {
    const evaluation = evaluateScenarios([scenario([16_000, 16_100, 16_200], [8, 9, 10])], budgets);
    expect(evaluation.level).toBe("failure");
    expect(evaluation.items).toContainEqual(
      expect.objectContaining({ scenarioId: "renderer", metric: "firstVisibleMs.median", level: "failure" }),
    );
  });

  it("fails visual or interaction invariants independently of timing", () => {
    const evaluation = evaluateScenarios([scenario([900, 1_000, 1_100], [8, 9, 10], false)], budgets);
    expect(evaluation.level).toBe("failure");
    expect(evaluation.items[0]).toMatchObject({ metric: "journey-invariants", level: "failure" });
  });

  it("turns bounded runner errors into machine-readable failed samples", async () => {
    const result = await runRepeatedScenario(
      "renderer",
      async () => {
        throw new Error("render deadline exceeded");
      },
      "unused",
    );

    expect(result.warmupFailures).toEqual(["render deadline exceeded"]);
    expect(result.samples).toHaveLength(3);
    expect(result.samples.every((sample) => sample.errors?.runner?.[0] === "render deadline exceeded")).toBe(true);
    expect(result.invariants.passed).toBe(false);
    expect(evaluateScenarios([result], budgets).level).toBe("failure");
  });

  it("computes a per-stage summary and evaluates it only when the scenario budget declares stages", async () => {
    const stageBudgets = {
      ...budgets,
      scenarios: {
        ...budgets.scenarios,
        "scale-tier": {
          firstVisibleMs: { warning: 20_000, failure: 60_000 },
          interactionLatencyMs: { warning: 2_000, failure: 6_000 },
          stages: {
            conversionMs: { warning: 500, failure: 2_000 },
            steadyFrameRateFps: { direction: "at-least" as const, warning: 20, failure: 5 },
          },
        },
      },
    };
    const result = await runRepeatedScenario(
      "scale-tier",
      async () => ({
        firstVisibleMs: 5_000,
        interactionLatencyMs: 200,
        stages: { conversionMs: 100, steadyFrameRateFps: 30 },
        passed: true,
      }),
      "unused",
    );

    expect(result.stagesSummary?.conversionMs.median).toBe(100);
    expect(result.stagesSummary?.steadyFrameRateFps.median).toBe(30);

    const passingEvaluation = evaluateScenarios([result], stageBudgets);
    expect(passingEvaluation.level).toBe("pass");
    expect(passingEvaluation.items).toContainEqual(
      expect.objectContaining({ scenarioId: "scale-tier", metric: "stages.conversionMs.median", level: "pass" }),
    );

    // Old (pre-#562) scenarios/budgets never populate stagesSummary/stages —
    // this must not add items or otherwise change their evaluation shape.
    const unstagedEvaluation = evaluateScenarios([scenario([900, 1_000, 1_100], [8, 9, 10])], budgets);
    expect(unstagedEvaluation.items).toHaveLength(5);
    expect(unstagedEvaluation.items.some((item) => item.metric.startsWith("stages."))).toBe(false);
  });

  it("proves a steady frame rate regression (a lower-is-worse metric) fails the lower-bound stage budget", async () => {
    const stageBudgets = {
      ...budgets,
      scenarios: {
        "scale-tier": {
          firstVisibleMs: { warning: 20_000, failure: 60_000 },
          interactionLatencyMs: { warning: 2_000, failure: 6_000 },
          stages: {
            steadyFrameRateFps: { direction: "at-least" as const, warning: 20, failure: 5 },
          },
        },
      },
    };
    const result = await runRepeatedScenario(
      "scale-tier",
      async () => ({
        firstVisibleMs: 5_000,
        interactionLatencyMs: 200,
        stages: { steadyFrameRateFps: 2 },
        passed: true,
      }),
      "unused",
    );
    const evaluation = evaluateScenarios([result], stageBudgets);
    expect(evaluation.level).toBe("failure");
    expect(evaluation.items).toContainEqual(
      expect.objectContaining({
        scenarioId: "scale-tier",
        metric: "stages.steadyFrameRateFps.median",
        level: "failure",
      }),
    );
  });
});

describe("evaluateOperationalScenarios (capability + lifecycle invariants)", () => {
  const lifecycleBudgets = {
    ...budgets,
    lifecycle: {
      repeatedMountUnmount: {
        cycles: 25,
        warmupCycles: 5,
        maxHeapGrowthBytes: { warning: 5_000_000, failure: 20_000_000 },
      },
      contextLossRecovery: { maxRecoveryMs: { warning: 3_000, failure: 8_000 } },
    },
  };

  it("passes when every operational scenario's invariants hold and heap growth/recovery time are in budget", () => {
    const results = [
      { id: "deckgl.capability-supported", passed: true, evidence: { message: "ok" } },
      { id: "deckgl.capability-fallback", passed: true, evidence: { message: "ok" } },
      {
        id: "deckgl.lifecycle-repeated-mount-unmount",
        passed: true,
        evidence: { cycles: 25, warmupCycles: 5, heapGrowthBytes: 100_000, message: "ok" },
      },
      {
        id: "deckgl.context-loss-recovery",
        passed: true,
        evidence: { loseContextExtensionAvailable: true, recoveryMs: 500, message: "ok" },
      },
    ];
    const evaluation = evaluateOperationalScenarios(results, lifecycleBudgets);
    expect(evaluation.level).toBe("pass");
    expect(evaluation.items.filter((item) => item.metric === "invariants")).toHaveLength(4);
  });

  it("fails when a capability or lifecycle scenario reports a failed invariant", () => {
    const results = [
      { id: "deckgl.capability-supported", passed: false, evidence: { message: "picking proof failed" } },
    ];
    const evaluation = evaluateOperationalScenarios(results, lifecycleBudgets);
    expect(evaluation.level).toBe("failure");
    expect(evaluation.items[0]).toMatchObject({ scenarioId: "deckgl.capability-supported", level: "failure" });
  });

  it("fails a repeated mount/unmount leak that exceeds the heap-growth budget", () => {
    const results = [
      {
        id: "deckgl.lifecycle-repeated-mount-unmount",
        passed: true,
        evidence: { cycles: 25, warmupCycles: 5, heapGrowthBytes: 50_000_000, message: "ok" },
      },
    ];
    const evaluation = evaluateOperationalScenarios(results, lifecycleBudgets);
    expect(evaluation.level).toBe("failure");
    expect(evaluation.items).toContainEqual(
      expect.objectContaining({
        scenarioId: "deckgl.lifecycle-repeated-mount-unmount",
        metric: "heapGrowthBytes",
        level: "failure",
      }),
    );
  });

  it("reports not-measured (never a silent pass) when the memory API is unavailable", () => {
    const results = [
      {
        id: "deckgl.lifecycle-repeated-mount-unmount",
        passed: true,
        evidence: { cycles: 25, warmupCycles: 5, heapGrowthBytes: null, message: "ok" },
      },
    ];
    const evaluation = evaluateOperationalScenarios(results, lifecycleBudgets);
    expect(evaluation.level).toBe("pass");
    expect(evaluation.items).toContainEqual(
      expect.objectContaining({
        scenarioId: "deckgl.lifecycle-repeated-mount-unmount",
        metric: "heapGrowthBytes",
        level: "not-measured",
      }),
    );
  });

  it("skips the context-loss recovery time budget when WEBGL_lose_context is unavailable on this device", () => {
    const results = [
      {
        id: "deckgl.context-loss-recovery",
        passed: true,
        evidence: { loseContextExtensionAvailable: false, message: "cannot exercise on this device" },
      },
    ];
    const evaluation = evaluateOperationalScenarios(results, lifecycleBudgets);
    expect(evaluation.items.some((item) => item.metric === "recoveryMs")).toBe(false);
    expect(evaluation.level).toBe("pass");
  });
});
