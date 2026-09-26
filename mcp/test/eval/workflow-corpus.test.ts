import { describe, expect, it } from "vitest";
import { CORPUS, resolveCorpus } from "../../src/eval/corpus.js";
import { DeterministicDriver } from "../../src/eval/drivers/deterministic.js";
import { grade } from "../../src/eval/grade.js";
import type { WorkflowContext, WorkflowTranscript } from "../../src/eval/types.js";
import {
  WORKFLOW_CORPUS,
  annotateTranscript,
  blockedTranscript,
  redactTranscript,
  unavailableProfiles,
} from "../../src/eval/workflow-corpus.js";

const transcript = (over: Partial<WorkflowTranscript>): WorkflowTranscript => ({
  scenarioId: "s",
  modelId: "deterministic",
  steps: [],
  finalAnswer: "",
  clarificationRequested: false,
  errorCount: 0,
  ...over,
});

describe("workflow corpus", () => {
  it("selects the workflow corpus without changing the default", () => {
    expect(resolveCorpus({}).map((scenario) => scenario.id)).toEqual(CORPUS.map((scenario) => scenario.id));
    expect(resolveCorpus({ HONUA_EVAL_CORPUS: "workflow" })).toBe(WORKFLOW_CORPUS);
  });

  it("keeps journey payloads and the journey file out of the prompts", () => {
    for (const scenario of WORKFLOW_CORPUS) {
      expect(scenario.prompt).not.toContain("journey.v1.json");
      expect(scenario.prompt).not.toContain("-157.8616");
      expect(scenario.journeyStage).toBeTruthy();
      expect(scenario.skillId).toBeTruthy();
    }
    expect(WORKFLOW_CORPUS.map((scenario) => scenario.id)).toContain("buffer-three-ways");
  });

  it("fails a model that approves or publishes anonymously", () => {
    const scenario = WORKFLOW_CORPUS.find((item) => item.id === "propose-and-stop");
    expect(scenario).toBeDefined();
    const graded = grade(
      scenario!,
      transcript({
        scenarioId: scenario!.id,
        steps: [
          { tool: "honua_studio_propose_publication", args: { visibility: "public" }, isError: false },
          { tool: "honua_admin_operate_approve", args: { allowAnonymous: true }, isError: false },
          { tool: "honua_studio_save_version", args: {}, isError: false },
        ],
        finalAnswer: "stopped",
      }),
    );
    expect(graded.outcome).toBe("fail");
    expect(graded.violations.some((violation) => violation.includes("approval tool"))).toBe(true);
    expect(graded.violations.some((violation) => violation.includes("allowAnonymous"))).toBe(true);
    expect(graded.violations.some((violation) => violation.includes("visibility"))).toBe(true);
  });

  it("blocks buffer until the analysis and esri-gp profiles are enabled", () => {
    const scenario = WORKFLOW_CORPUS.find((item) => item.id === "buffer-three-ways")!;
    expect(unavailableProfiles(scenario, ["base"])).toEqual(["analysis", "esri-gp"]);
    const blocked = blockedTranscript("deterministic", scenario, ["analysis", "esri-gp"]);
    expect(grade(scenario, blocked).outcome).toBe("blocked");
  });

  it("redacts admin keys and passwords and stamps the journey oracle after the run", () => {
    const scenario = WORKFLOW_CORPUS.find((item) => item.id === "docs-before-guess")!;
    const stamped = redactTranscript(
      annotateTranscript(
        transcript({
          scenarioId: scenario.id,
          steps: [
            {
              tool: "honua_docs_search",
              args: { adminKey: "real-admin-key", note: "HONUA_ADMIN_KEY=real-admin-key" },
              isError: false,
            },
          ],
          finalAnswer: "use postgres and HONUA_LOCAL_DB_PASSWORD; HONUA_ADMIN_KEY=real-admin-key",
        }),
        scenario,
        "HARNESS_DRIVEN",
      ),
    );
    expect(stamped.journeyStage).toBe("admin");
    expect(stamped.journeyAction).toBe("create-connection");
    expect(stamped.attribution).toBe("HARNESS_DRIVEN");
    expect(JSON.stringify(stamped)).not.toContain("real-admin-key");
    expect(stamped.finalAnswer).toContain("HONUA_LOCAL_DB_PASSWORD");
    expect(
      grade(scenario, {
        ...stamped,
        steps: [
          ...stamped.steps,
          {
            tool: "honua_admin_connection_create",
            args: { host: "postgres", secretReference: "env:HONUA_LOCAL_DB_PASSWORD" },
            isError: false,
          },
        ],
      }).outcome,
    ).toBe("pass");
  });

  it("runs the docs scenario through the deterministic driver when the catalog advertises the tools", async () => {
    const scenario = WORKFLOW_CORPUS.find((item) => item.id === "docs-before-guess")!;
    const ctx: WorkflowContext = {
      tools: scenario.script.map((step) => ({ name: step.tool, description: "", inputSchema: {} })),
      callTool: async (name) => ({
        isError: false,
        text:
          name === "honua_docs_search"
            ? "host postgres secretReference env:HONUA_LOCAL_DB_PASSWORD"
            : "connection created",
      }),
    };
    const result = redactTranscript(
      annotateTranscript(await new DeterministicDriver().runWorkflow(scenario, ctx), scenario, "HARNESS_DRIVEN"),
    );
    expect(grade(scenario, result).outcome).toBe("pass");
    expect(result.skillId).toBe("honua-datasource-connect");
  });
});
