import { describe, expect, it } from "vitest";
import { CORPUS, resolveCorpus } from "../../src/eval/corpus.js";
import { NORTHSTAR_CORPUS } from "../../src/eval/northstar-corpus.js";
import { OPERATOR_CORPUS } from "../../src/eval/operator-corpus.js";

const MUTATING_TOOLS = ["honua_execute_plan", "honua_propose_operation"];

describe("operator corpus (#1956)", () => {
  it("is a non-empty held-out set with unique ids", () => {
    expect(OPERATOR_CORPUS.length).toBeGreaterThanOrEqual(6);
    const ids = OPERATOR_CORPUS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only references real operator-surface tools", () => {
    // The live honua-server operator MCP catalog (serverInfo honua.operator.mcp).
    const operatorTools = new Set([
      "honua_ground_candidates",
      "honua_clarify_intent",
      "honua_plan_analysis",
      "honua_propose_operation",
      "honua_dry_run_plan",
      "honua_execute_plan",
      "honua_validate_plan",
      "honua_validate_package",
      "honua_preview_package",
      "honua_query_features",
      "honua_list_layers",
      "honua_render_map",
      "honua_geocode_address",
      "honua_solve_route",
      "honua_cancel_job",
    ]);
    for (const scenario of OPERATOR_CORPUS) {
      for (const required of scenario.criteria.requiredTools) {
        expect(operatorTools.has(required)).toBe(true);
      }
      for (const step of scenario.script) {
        expect(operatorTools.has(step.tool)).toBe(true);
      }
    }
  });

  it("each scenario has a runnable script that satisfies its own required tools and order", () => {
    for (const scenario of OPERATOR_CORPUS) {
      expect(scenario.script.length).toBeGreaterThan(0);
      const scriptTools = scenario.script.map((s) => s.tool);
      for (const required of scenario.criteria.requiredTools) {
        expect(scriptTools).toContain(required);
      }
      // The ideal-client script must honor the scenario's own ordering criterion.
      if (scenario.criteria.expectedToolSequence) {
        let i = 0;
        for (const tool of scriptTools) {
          if (i < scenario.criteria.expectedToolSequence.length && tool === scenario.criteria.expectedToolSequence[i]) {
            i++;
          }
        }
        expect(i).toBe(scenario.criteria.expectedToolSequence.length);
      }
      // The scripted ideal trajectory must never call a tool it forbids.
      for (const forbidden of scenario.criteria.forbiddenTools ?? []) {
        expect(scriptTools).not.toContain(forbidden);
      }
    }
  });

  it("forbids the mutating lifecycle tools on every read-only / planning scenario", () => {
    // Discovery and capability-gap scenarios are inherently single-tool; the
    // multi-step planning and query scenarios must explicitly stay read-only.
    const planningOrQuery = OPERATOR_CORPUS.filter((s) =>
      ["query", "multi-step", "analysis", "governance"].includes(s.category),
    );
    expect(planningOrQuery.length).toBeGreaterThan(0);
    for (const scenario of planningOrQuery) {
      for (const tool of MUTATING_TOOLS) {
        expect(scenario.criteria.forbiddenTools ?? []).toContain(tool);
      }
    }
  });
});

describe("corpus resolution (#1956)", () => {
  it("defaults to the analyst corpus when HONUA_EVAL_CORPUS is unset or unknown", () => {
    expect(resolveCorpus({})).toBe(CORPUS);
    expect(resolveCorpus({ HONUA_EVAL_CORPUS: "" })).toBe(CORPUS);
    expect(resolveCorpus({ HONUA_EVAL_CORPUS: "nonsense" })).toBe(CORPUS);
  });

  it("selects the operator corpus (case-insensitive, trimmed)", () => {
    expect(resolveCorpus({ HONUA_EVAL_CORPUS: "operator" })).toBe(OPERATOR_CORPUS);
    expect(resolveCorpus({ HONUA_EVAL_CORPUS: "  OPERATOR  " })).toBe(OPERATOR_CORPUS);
  });

  it("selects the north-star corpus (case-insensitive, trimmed)", () => {
    expect(resolveCorpus({ HONUA_EVAL_CORPUS: "northstar" })).toBe(NORTHSTAR_CORPUS);
    expect(resolveCorpus({ HONUA_EVAL_CORPUS: "  NorthStar  " })).toBe(NORTHSTAR_CORPUS);
  });

  it("concatenates every corpus for 'all'", () => {
    const all = resolveCorpus({ HONUA_EVAL_CORPUS: "all" });
    expect(all.length).toBe(CORPUS.length + OPERATOR_CORPUS.length + NORTHSTAR_CORPUS.length);
    expect(all.slice(0, CORPUS.length)).toEqual(CORPUS);
    expect(all.slice(CORPUS.length, CORPUS.length + OPERATOR_CORPUS.length)).toEqual(OPERATOR_CORPUS);
    expect(all.slice(CORPUS.length + OPERATOR_CORPUS.length)).toEqual(NORTHSTAR_CORPUS);
  });
});
