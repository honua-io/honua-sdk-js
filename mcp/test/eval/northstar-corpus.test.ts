import { describe, expect, it } from "vitest";
import { DeterministicDriver } from "../../src/eval/drivers/index.js";
import { grade } from "../../src/eval/grade.js";
import { NORTHSTAR_CORPUS } from "../../src/eval/northstar-corpus.js";
import { type AssembleInput, assembleReport, renderMarkdown } from "../../src/eval/report.js";
import type { Scenario, WorkflowContext, WorkflowTranscript } from "../../src/eval/types.js";

/**
 * Reference (`honua_*`) names for the standard geospatial-mcp tools these
 * workflows compose. Two are P1 deliverables the reference implementation lists
 * as `known-gap` today (`honua_publish_result`, `honua_apply_style_preset`) —
 * they are still valid standard tool names, and are exactly what the P1 gate
 * measures the arrival of.
 */
const STANDARD_TOOLS = new Set([
  "honua_resolve_entity",
  "honua_ground_candidates",
  "honua_plan_analysis",
  "honua_validate_plan",
  "honua_dry_run_plan",
  "honua_execute_plan",
  "honua_publish_result",
  "honua_apply_style_preset",
  "honua_render_map",
  "honua_geocode_addresses",
  "honua_ingest_dataset",
  "honua_publish_service",
  "honua_propose_operation",
]);

/** P1 tools not yet advertised by servers predating the north-star surface. */
const P1_PENDING_TOOLS = ["honua_publish_result", "honua_apply_style_preset"];

const findScenario = (id: string): Scenario => {
  const scenario = NORTHSTAR_CORPUS.find((s) => s.id === id);
  if (!scenario) {
    throw new Error(`missing north-star scenario: ${id}`);
  }
  return scenario;
};

const transcriptFor = (id: string, over: Partial<WorkflowTranscript>): WorkflowTranscript => ({
  scenarioId: id,
  modelId: "deterministic",
  steps: [],
  finalAnswer: "",
  clarificationRequested: false,
  errorCount: 0,
  ...over,
});

describe("north-star corpus (#1948, P1.7)", () => {
  it("is exactly the three P1 gate workflows with unique ids", () => {
    expect(NORTHSTAR_CORPUS.map((s) => s.id)).toEqual([
      "northstar-styled-map",
      "northstar-csv-geocode-publish",
      "northstar-buffer-stats-job",
    ]);
    const ids = NORTHSTAR_CORPUS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of NORTHSTAR_CORPUS) {
      expect(s.category).toBe("north-star");
    }
  });

  it("every scenario has a non-empty prompt and criteria", () => {
    for (const s of NORTHSTAR_CORPUS) {
      expect(s.prompt.length).toBeGreaterThan(20);
      expect(s.criteria.requiredTools.length).toBeGreaterThan(0);
      expect(s.script.length).toBeGreaterThan(0);
    }
  });

  it("only references standard geospatial-mcp tool names (guards typos)", () => {
    for (const s of NORTHSTAR_CORPUS) {
      for (const tool of s.criteria.requiredTools) {
        expect(STANDARD_TOOLS.has(tool)).toBe(true);
      }
      for (const tool of s.criteria.expectedToolSequence ?? []) {
        expect(STANDARD_TOOLS.has(tool)).toBe(true);
      }
      for (const step of s.script) {
        expect(STANDARD_TOOLS.has(step.tool)).toBe(true);
      }
    }
  });

  it("each scripted ideal trajectory satisfies its own required tools, order, and forbids", () => {
    for (const s of NORTHSTAR_CORPUS) {
      const scriptTools = s.script.map((step) => step.tool);
      for (const required of s.criteria.requiredTools) {
        expect(scriptTools).toContain(required);
      }
      if (s.criteria.expectedToolSequence) {
        let i = 0;
        for (const tool of scriptTools) {
          if (i < s.criteria.expectedToolSequence.length && tool === s.criteria.expectedToolSequence[i]) {
            i++;
          }
        }
        expect(i).toBe(s.criteria.expectedToolSequence.length);
      }
      for (const forbidden of s.criteria.forbiddenTools ?? []) {
        expect(scriptTools).not.toContain(forbidden);
      }
    }
  });

  it("forbids the generic propose_operation escape-hatch on every workflow", () => {
    for (const s of NORTHSTAR_CORPUS) {
      expect(s.criteria.forbiddenTools ?? []).toContain("honua_propose_operation");
    }
  });

  it("embeds a 10-row address CSV in the geocode → publish prompt", () => {
    const csv = findScenario("northstar-csv-geocode-publish").prompt;
    const rows = csv.split("\n").filter((line) => /,CA,\d{5}/.test(line));
    expect(rows.length).toBe(10);
  });
});

describe("north-star grading (#1948, P1.7)", () => {
  it("passes a simulated complete styled-map transcript", () => {
    const scenario = findScenario("northstar-styled-map");
    const g = grade(
      scenario,
      transcriptFor(scenario.id, {
        steps: [
          { tool: "honua_resolve_entity", args: {}, isError: false },
          { tool: "honua_resolve_entity", args: {}, isError: false },
          { tool: "honua_plan_analysis", args: {}, isError: false },
          { tool: "honua_validate_plan", args: {}, isError: false },
          { tool: "honua_execute_plan", args: {}, isError: false },
          { tool: "honua_publish_result", args: {}, isError: false },
          { tool: "honua_apply_style_preset", args: {}, isError: false },
          { tool: "honua_render_map", args: {}, isError: false },
        ],
        finalAnswer: "Published and rendered a styled map of the flood-adjacent parcels.",
      }),
    );
    expect(g.outcome).toBe("pass");
    expect(g.violations).toEqual([]);
  });

  it("fails a transcript that skips publish and reaches for propose_operation", () => {
    const scenario = findScenario("northstar-styled-map");
    const g = grade(
      scenario,
      transcriptFor(scenario.id, {
        steps: [
          { tool: "honua_resolve_entity", args: {}, isError: false },
          { tool: "honua_execute_plan", args: {}, isError: false },
          { tool: "honua_propose_operation", args: {}, isError: false },
          { tool: "honua_render_map", args: {}, isError: false },
        ],
        finalAnswer: "done",
      }),
    );
    expect(g.outcome).toBe("fail");
    expect(g.violations.some((v) => v.includes("honua_publish_result"))).toBe(true);
    expect(g.violations.some((v) => v.includes("forbidden") && v.includes("honua_propose_operation"))).toBe(true);
  });

  it("fails the buffer-stats job when the answer shows no job evidence", () => {
    const scenario = findScenario("northstar-buffer-stats-job");
    const g = grade(
      scenario,
      transcriptFor(scenario.id, {
        steps: [
          { tool: "honua_ground_candidates", args: {}, isError: false },
          { tool: "honua_plan_analysis", args: {}, isError: false },
          { tool: "honua_validate_plan", args: {}, isError: false },
          { tool: "honua_execute_plan", args: {}, isError: false },
        ],
        finalAnswer: "here are the numbers", // no job reference echoed
      }),
    );
    expect(g.outcome).toBe("fail");
    expect(g.violations.some((v) => v.includes('"job"'))).toBe(true);
  });
});

describe("north-star missing-tool reporting (#1948, P1.7)", () => {
  /** A surface that ships every north-star tool EXCEPT the P1 deliverables. */
  const preP1Surface = [...STANDARD_TOOLS].filter((t) => !P1_PENDING_TOOLS.includes(t));

  const errored = (scenario: Scenario) => ({
    grade: {
      scenarioId: scenario.id,
      modelId: "deterministic",
      outcome: "error" as const,
      violations: ["scripted tool not advertised by the MCP surface: honua_publish_result"],
      errorCount: 0,
    },
    transcript: transcriptFor(scenario.id, {
      driverError: "scripted tool not advertised by the MCP surface: honua_publish_result",
    }),
  });

  it("names the P1 tool a pre-P1 surface lacks, corpus-wide and per scenario", () => {
    const input: AssembleInput = {
      backend: "live",
      mcpTransport: "streamable-http",
      remoteUrl: "https://server.example/mcp",
      auth: "bearer",
      advertisedTools: preP1Surface,
      corpus: NORTHSTAR_CORPUS,
      drivers: [new DeterministicDriver()],
      graded: NORTHSTAR_CORPUS.map((s) => errored(s)),
    };
    const report = assembleReport(input);

    expect(report.schemaVersion).toBe(4);
    // Corpus-wide: honua_publish_result is required but unadvertised.
    expect(report.catalog.unresolvedRequiredTools).toContain("honua_publish_result");

    // Per-scenario: the styled-map workflow names exactly the required tool it lacks.
    const styled = report.results.find((r) => r.scenarioId === "northstar-styled-map");
    expect(styled?.missingTools).toEqual(["honua_publish_result"]);

    // A workflow whose required tools all resolve reports no missing tools.
    const csv = report.results.find((r) => r.scenarioId === "northstar-csv-geocode-publish");
    expect(csv?.missingTools).toEqual([]);

    const md = renderMarkdown(report);
    expect(md).toContain("honua_publish_result");
    expect(md).toContain("missing required tool(s) on this surface");
  });

  it("reports no missing tools once the surface advertises the full north-star arc", () => {
    const input: AssembleInput = {
      backend: "live",
      mcpTransport: "streamable-http",
      auth: "api-key",
      advertisedTools: [...STANDARD_TOOLS],
      corpus: NORTHSTAR_CORPUS,
      drivers: [new DeterministicDriver()],
      graded: NORTHSTAR_CORPUS.map((s) => ({
        grade: { scenarioId: s.id, modelId: "deterministic", outcome: "pass" as const, violations: [], errorCount: 0 },
        transcript: transcriptFor(s.id, { steps: [{ tool: "honua_render_map", args: {}, isError: false }] }),
      })),
    };
    const report = assembleReport(input);
    expect(report.catalog.unresolvedRequiredTools).toEqual([]);
    for (const r of report.results) {
      expect(r.missingTools).toEqual([]);
    }
  });
});

describe("north-star deterministic degradation (#1948, P1.7)", () => {
  it("degrades honestly (driverError, not a false pass) when a P1 tool is unadvertised", async () => {
    // A surface missing the P1 publish/style tools — the same shape a pre-P1
    // server advertises. The scripted ideal trajectory must stop at the first
    // unadvertised tool with a driverError, never fabricate a green result.
    const advertised = [...STANDARD_TOOLS].filter((t) => !P1_PENDING_TOOLS.includes(t));
    const ctx: WorkflowContext = {
      tools: advertised.map((name) => ({ name, description: "", inputSchema: { type: "object" } })),
      async callTool() {
        return { isError: false, text: "{}" };
      },
    };
    const scenario = findScenario("northstar-styled-map");
    const transcript = await new DeterministicDriver().runWorkflow(scenario, ctx);
    expect(transcript.driverError).toMatch(/not advertised/);
    expect(transcript.driverError).toContain("honua_publish_result");
    expect(grade(scenario, transcript).outcome).toBe("error");
  });
});
