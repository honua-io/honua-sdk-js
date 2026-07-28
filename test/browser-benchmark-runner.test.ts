import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BROWSER_CORPUS_SOURCE_FILES,
  browserCorpusFingerprint,
  evaluateScenarios,
  runRepeatedScenario,
  summarize,
} from "../bench/browser/run.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const budgets = {
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
});
