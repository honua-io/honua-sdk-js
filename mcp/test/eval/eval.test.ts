import { describe, expect, it } from "vitest";
import { CORPUS } from "../../src/eval/corpus.js";
import { AnthropicDriver, DeterministicDriver, OpenAiDriver, resolveDrivers } from "../../src/eval/drivers/index.js";
import { grade, isOrderedSubsequence } from "../../src/eval/grade.js";
import { renderMarkdown } from "../../src/eval/report.js";
import { runEval } from "../../src/eval/runner.js";
import type { Scenario, WorkflowContext, WorkflowTranscript } from "../../src/eval/types.js";

describe("grading (#1956)", () => {
  it("detects ordered subsequences", () => {
    expect(isOrderedSubsequence(["a", "x", "b", "y"], ["a", "b"])).toBe(true);
    expect(isOrderedSubsequence(["b", "a"], ["a", "b"])).toBe(false);
    expect(isOrderedSubsequence(["a"], ["a", "b"])).toBe(false);
  });

  const scenario: Scenario = {
    id: "s",
    title: "t",
    category: "c",
    prompt: "p",
    criteria: {
      requiredTools: ["honua_count_features", "honua_query_features"],
      expectedToolSequence: ["honua_count_features", "honua_query_features"],
      forbiddenTools: ["honua_apply_style_preset"],
      answerMustInclude: ["done"],
    },
    script: [],
  };

  const transcript = (over: Partial<WorkflowTranscript>): WorkflowTranscript => ({
    scenarioId: "s",
    modelId: "m",
    steps: [],
    finalAnswer: "",
    clarificationRequested: false,
    errorCount: 0,
    ...over,
  });

  it("passes when all criteria are met", () => {
    const g = grade(
      scenario,
      transcript({
        steps: [
          { tool: "honua_count_features", args: {}, isError: false },
          { tool: "honua_query_features", args: {}, isError: false },
        ],
        finalAnswer: "All DONE here",
      }),
    );
    expect(g.outcome).toBe("pass");
    expect(g.violations).toEqual([]);
  });

  it("fails on missing required tool, bad order, forbidden tool, and missing content", () => {
    const g = grade(
      scenario,
      transcript({
        steps: [
          { tool: "honua_query_features", args: {}, isError: false },
          { tool: "honua_apply_style_preset", args: {}, isError: false },
        ],
        finalAnswer: "nope",
      }),
    );
    expect(g.outcome).toBe("fail");
    expect(g.violations.some((v) => v.includes("honua_count_features"))).toBe(true);
    expect(g.violations.some((v) => v.includes("forbidden"))).toBe(true);
    expect(g.violations.some((v) => v.includes("sequence"))).toBe(true);
    expect(g.violations.some((v) => v.includes("done"))).toBe(true);
  });

  it("classifies clarification and driver errors", () => {
    expect(grade(scenario, transcript({ clarificationRequested: true })).outcome).toBe("clarified");
    expect(grade(scenario, transcript({ driverError: "boom" })).outcome).toBe("error");
  });
});

describe("driver resolution (#1956)", () => {
  it("includes only the deterministic control when no API keys are set", () => {
    const drivers = resolveDrivers({ env: {} });
    expect(drivers.map((d) => d.vendor)).toEqual(["deterministic"]);
  });

  it("adds Claude and GPT drivers when their keys are present", () => {
    const drivers = resolveDrivers({ env: { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" } });
    expect(drivers.map((d) => d.vendor).sort()).toEqual(["anthropic", "deterministic", "openai"]);
  });

  it("reports availability from key presence", () => {
    expect(new AnthropicDriver({ apiKey: undefined }).isAvailable()).toBe(false);
    expect(new AnthropicDriver({ apiKey: "k" }).isAvailable()).toBe(true);
    expect(new OpenAiDriver({ apiKey: undefined }).isAvailable()).toBe(false);
    expect(new DeterministicDriver().isAvailable()).toBe(true);
  });

  it("uses the latest Opus model id by default for the Claude driver", () => {
    expect(new AnthropicDriver().id).toBe("claude-opus-4-8");
  });
});

describe("offline eval run (#1956)", () => {
  it("passes the full corpus on the deterministic control over the fixture surface", async () => {
    const report = await runEval({ forceOffline: true, drivers: [new DeterministicDriver()] });

    expect(report.surface.backend).toBe("fixture");
    expect(report.summary.pass).toBe(true);
    expect(report.corpus.scenarios).toBe(CORPUS.length);

    const control = report.models.find((m) => m.vendor === "deterministic");
    expect(control).toBeDefined();
    expect(control?.scenarios).toBe(CORPUS.length);
    expect(control?.pass).toBe(CORPUS.length);
    expect(control?.fail).toBe(0);
    expect(control?.successRate).toBe(1);

    // Every result is a pass and exercised at least one real MCP tool call.
    for (const r of report.results) {
      expect(r.outcome).toBe("pass");
      expect(r.toolsCalled.length).toBeGreaterThan(0);
    }
  });

  it("records a driver error (not a false pass) when a live driver is unavailable", async () => {
    const report = await runEval({
      forceOffline: true,
      drivers: [new AnthropicDriver({ apiKey: undefined })],
    });
    expect(report.summary.pass).toBe(false); // no deterministic control in this run
    for (const r of report.results) {
      expect(r.outcome).toBe("error");
    }
  });

  it("renders a markdown scorecard", async () => {
    const report = await runEval({ forceOffline: true, drivers: [new DeterministicDriver()] });
    const md = renderMarkdown(report);
    expect(md).toContain("MCP Cross-Model Workflow Eval");
    expect(md).toContain("Per-model scorecard");
    expect(md).toContain("deterministic");
    expect(md).toContain("honua-io/honua-server#1956");
  });
});

describe("deterministic driver fidelity (#1956)", () => {
  it("surfaces a catalog regression when a scripted tool is not advertised", async () => {
    const ctx: WorkflowContext = {
      tools: [{ name: "honua_list_services", description: "", inputSchema: { type: "object" } }],
      async callTool() {
        return { isError: false, text: "[]" };
      },
    };
    const scenario: Scenario = {
      id: "x",
      title: "x",
      category: "x",
      prompt: "x",
      criteria: { requiredTools: ["nonexistent_tool"] },
      script: [{ tool: "nonexistent_tool", args: {} }],
    };
    const transcript = await new DeterministicDriver().runWorkflow(scenario, ctx);
    expect(transcript.driverError).toMatch(/not advertised/);
    expect(grade(scenario, transcript).outcome).toBe("error");
  });
});
