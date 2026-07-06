import { describe, expect, it } from "vitest";
import { DeterministicDriver } from "../../src/eval/drivers/deterministic.js";
import { grade } from "../../src/eval/grade.js";
import type { Scenario, WorkflowContext, WorkflowTranscript } from "../../src/eval/types.js";

/** Semantic grading extensions (issue #369, REQ-003). */

function scenario(over: Partial<Scenario>): Scenario {
  return {
    id: "s",
    title: "t",
    category: "c",
    prompt: "p",
    criteria: { requiredTools: [] },
    script: [],
    ...over,
  };
}

function transcript(over: Partial<WorkflowTranscript>): WorkflowTranscript {
  return {
    scenarioId: "s",
    modelId: "deterministic",
    steps: [],
    finalAnswer: "",
    clarificationRequested: false,
    errorCount: 0,
    ...over,
  };
}

describe("answerMustMatch (numeric/value assertions)", () => {
  it("passes when every pattern matches", () => {
    const g = grade(
      scenario({ criteria: { requiredTools: [], answerMustMatch: ['"count":\\s*52', "\\b435\\b"] } }),
      transcript({ finalAnswer: '{"count": 52, "seats": 435}' }),
    );
    expect(g.outcome).toBe("pass");
  });

  it("fails when a pattern does not match (wrong number)", () => {
    const g = grade(
      scenario({ criteria: { requiredTools: [], answerMustMatch: ['"count":\\s*52'] } }),
      transcript({ finalAnswer: '{"count": 50}' }),
    );
    expect(g.outcome).toBe("fail");
    expect(g.violations[0]).toContain("did not match");
  });
});

describe("answerMustNotInclude (anti-hallucination)", () => {
  it("fails when a forbidden fragment appears", () => {
    const g = grade(
      scenario({ criteria: { requiredTools: [], answerMustNotInclude: ["Texas"] } }),
      transcript({ finalAnswer: "The largest is California, not Texas" }),
    );
    expect(g.outcome).toBe("fail");
    expect(g.violations[0]).toContain("forbidden content");
  });

  it("passes when the forbidden fragment is absent", () => {
    const g = grade(
      scenario({ criteria: { requiredTools: [], answerMustNotInclude: ["Texas"] } }),
      transcript({ finalAnswer: "The largest is California" }),
    );
    expect(g.outcome).toBe("pass");
  });
});

describe("expectClarification (refusal / ambiguity)", () => {
  it("passes when an ambiguous scenario is clarified", () => {
    const g = grade(
      scenario({ criteria: { requiredTools: [], expectClarification: true } }),
      transcript({ clarificationRequested: true, finalAnswer: "which state?" }),
    );
    expect(g.outcome).toBe("pass");
  });

  it("fails when an ambiguous scenario is answered instead of clarified", () => {
    const g = grade(
      scenario({ criteria: { requiredTools: [], expectClarification: true } }),
      transcript({ clarificationRequested: false, finalAnswer: "California" }),
    );
    expect(g.outcome).toBe("fail");
    expect(g.violations[0]).toContain("expected a clarifying question");
  });

  it("treats an unexpected clarification as `clarified` when not expected", () => {
    const g = grade(scenario({ criteria: { requiredTools: [] } }), transcript({ clarificationRequested: true }));
    expect(g.outcome).toBe("clarified");
  });
});

describe("deterministic driver honors clarify scenarios", () => {
  it("asks the scripted clarifying question instead of running tools", async () => {
    const driver = new DeterministicDriver();
    const ctx: WorkflowContext = {
      tools: [],
      async callTool() {
        throw new Error("should not be called for a clarify scenario");
      },
    };
    const result = await driver.runWorkflow(scenario({ clarify: { question: "Which state?" }, script: [] }), ctx);
    expect(result.clarificationRequested).toBe(true);
    expect(result.finalAnswer).toBe("Which state?");
    expect(result.steps).toEqual([]);
  });
});
