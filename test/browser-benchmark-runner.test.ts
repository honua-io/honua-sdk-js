import { describe, expect, it } from "vitest";

import { evaluateScenarios, runRepeatedScenario, summarize } from "../bench/browser/run.mjs";

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
