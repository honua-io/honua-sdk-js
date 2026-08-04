import { describe, expect, it } from "vitest";
import { resolveCorpus } from "../../src/eval/corpus.js";
import { OGC_CORPUS } from "../../src/eval/ogc-corpus.js";
import { runEval } from "../../src/eval/runner.js";

/**
 * NON-GeoServices eval corpus gate (issue #1005, REQ-004).
 *
 * The corpus runs the identical tool catalog against a plain OGC API Features
 * endpoint with semantic assertions anchored to the recorded pygeoapi data. The
 * deterministic control must pass every scenario — a wrong number, a dropped
 * filter, or a silently-empty answer where the protocol should have refused all
 * fail here.
 */
describe("non-GeoServices (OGC API Features) corpus", () => {
  it("is selectable by name and by environment", () => {
    expect(resolveCorpus({ HONUA_EVAL_CORPUS: "ogc" } as NodeJS.ProcessEnv)).toBe(OGC_CORPUS);
  });

  it("addresses every source protocol-neutrally, never with serviceId/layerId", () => {
    for (const scenario of OGC_CORPUS) {
      for (const step of scenario.script) {
        expect(step.args.serviceId, `${scenario.id} uses serviceId`).toBeUndefined();
        expect(step.args.layerId, `${scenario.id} uses layerId`).toBeUndefined();
        if (typeof step.args.source === "string") {
          expect(step.args.source).not.toMatch(/^geoservices/);
        }
      }
    }
  });

  it("every scenario carries a semantic assertion or a clarification expectation", () => {
    for (const scenario of OGC_CORPUS) {
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

  it("covers discovery, typed filters, geometry, time, degradation and refusal", () => {
    const categories = new Set(OGC_CORPUS.map((s) => s.category));
    for (const expected of ["discovery", "grounding", "count", "query", "analysis", "degradation", "clarification"]) {
      expect(categories.has(expected), `missing category ${expected}`).toBe(true);
    }
    const usesTypedFilter = OGC_CORPUS.some((s) => s.script.some((step) => step.args.filter !== undefined));
    const usesBbox = OGC_CORPUS.some((s) => s.script.some((step) => step.args.bbox !== undefined));
    const usesTemporal = OGC_CORPUS.some((s) => s.script.some((step) => step.args.temporal !== undefined));
    expect(usesTypedFilter && usesBbox && usesTemporal).toBe(true);
  });

  it("the deterministic control passes every scenario against the OGC fixture", async () => {
    const report = await runEval({
      forceOgcSurface: true,
      corpus: OGC_CORPUS,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(report.summary.pass).toBe(true);
    const control = report.models.find((m) => m.id === "deterministic");
    expect(control?.scenarios).toBe(OGC_CORPUS.length);
    expect(control?.pass).toBe(OGC_CORPUS.length);

    const failures = report.results.filter((r) => r.modelId === "deterministic" && r.outcome !== "pass");
    expect(failures.map((f) => `${f.scenarioId}: ${f.violations.join("; ")}`)).toEqual([]);
  }, 30_000);
});
