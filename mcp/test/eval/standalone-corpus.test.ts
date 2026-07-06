import { describe, expect, it } from "vitest";
import { runEval } from "../../src/eval/runner.js";
import { STANDALONE_CORPUS } from "../../src/eval/standalone-corpus.js";

/**
 * Platform-free eval corpus gate (issue #369, REQ-003).
 *
 * The standalone corpus has 50+ scenarios WITH semantic assertions (correct
 * counts, correct geographic facts, correct tool choice, refusal/clarification).
 * The deterministic offline control must pass every one of them against the
 * recorded census FeatureServer fixture — a wrong number or a hallucinated place
 * name would fail. No network, no model calls.
 */
describe("platform-free standalone corpus", () => {
  it("has at least 50 scenarios", () => {
    expect(STANDALONE_CORPUS.length).toBeGreaterThanOrEqual(50);
  });

  it("every scenario carries a semantic assertion or a clarification expectation", () => {
    for (const scenario of STANDALONE_CORPUS) {
      const c = scenario.criteria;
      const hasSemantic =
        (c.answerMustInclude?.length ?? 0) > 0 ||
        (c.answerMustMatch?.length ?? 0) > 0 ||
        (c.answerMustNotInclude?.length ?? 0) > 0 ||
        (c.forbiddenTools?.length ?? 0) > 0 ||
        c.expectClarification === true;
      expect(hasSemantic, `scenario ${scenario.id} has no semantic assertion`).toBe(true);
    }
  });

  it("covers a range of grading taxonomies", () => {
    const categories = new Set(STANDALONE_CORPUS.map((s) => s.category));
    for (const expected of ["count", "analysis", "reasoning", "degradation", "tool-selection", "clarification"]) {
      expect(categories.has(expected), `missing category ${expected}`).toBe(true);
    }
    // Semantic depth: numeric/value regex checks, anti-hallucination guards, refusals.
    expect(STANDALONE_CORPUS.some((s) => (s.criteria.answerMustMatch?.length ?? 0) > 0)).toBe(true);
    expect(STANDALONE_CORPUS.some((s) => (s.criteria.answerMustNotInclude?.length ?? 0) > 0)).toBe(true);
    expect(STANDALONE_CORPUS.some((s) => s.criteria.expectClarification === true)).toBe(true);
  });

  it("the deterministic control passes every scenario against the census fixture", async () => {
    const report = await runEval({
      forceStandaloneSurface: true,
      corpus: STANDALONE_CORPUS,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(report.summary.pass).toBe(true);
    const control = report.models.find((m) => m.id === "deterministic");
    expect(control).toBeDefined();
    expect(control?.scenarios).toBe(STANDALONE_CORPUS.length);
    expect(control?.pass).toBe(STANDALONE_CORPUS.length);

    // Surface any failing scenario with its violations for a fast diagnosis.
    const failures = report.results.filter((r) => r.modelId === "deterministic" && r.outcome !== "pass");
    expect(failures.map((f) => `${f.scenarioId}: ${f.violations.join("; ")}`)).toEqual([]);
  }, 30_000);
});
