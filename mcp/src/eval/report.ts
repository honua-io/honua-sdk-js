import type { ModelDriver, Scenario, ScenarioGrade, WorkflowTranscript } from "./types.js";

/** One graded (model, scenario) result plus a compact transcript view. */
export interface EvalResult {
  scenarioId: string;
  modelId: string;
  outcome: ScenarioGrade["outcome"];
  violations: string[];
  toolsCalled: string[];
  errorCount: number;
  driverError?: string | undefined;
}

/** Per-model aggregate metrics — the measurable form of the north star. */
export interface ModelScorecard {
  id: string;
  vendor: ModelDriver["vendor"];
  available: boolean;
  scenarios: number;
  pass: number;
  fail: number;
  clarified: number;
  error: number;
  /** pass / scenarios. */
  successRate: number;
  /** clarified / scenarios. */
  clarificationRate: number;
  /** scenarios with >=1 erroring tool call / scenarios. */
  editRate: number;
  totalToolErrors: number;
}

export interface EvalReport {
  schemaVersion: 2;
  generatedAt: string;
  surface: {
    backend: "fixture" | "live";
    mcpTransport: string;
    remoteUrl?: string;
  };
  corpus: { scenarios: number; ids: string[] };
  models: ModelScorecard[];
  results: EvalResult[];
  summary: {
    /** True iff the deterministic control passed every scenario (the CI gate). */
    pass: boolean;
    modelsEvaluated: number;
    liveModelsEvaluated: number;
    scenarios: number;
  };
}

export interface AssembleInput {
  backend: "fixture" | "live";
  mcpTransport: string;
  remoteUrl?: string | undefined;
  corpus: Scenario[];
  drivers: ModelDriver[];
  graded: { grade: ScenarioGrade; transcript: WorkflowTranscript }[];
}

export function assembleReport(input: AssembleInput): EvalReport {
  const results: EvalResult[] = input.graded.map(({ grade, transcript }) => ({
    scenarioId: grade.scenarioId,
    modelId: grade.modelId,
    outcome: grade.outcome,
    violations: grade.violations,
    toolsCalled: transcript.steps.map((s) => s.tool),
    errorCount: grade.errorCount,
    driverError: transcript.driverError,
  }));

  const models: ModelScorecard[] = input.drivers.map((driver) => {
    const own = results.filter((r) => r.modelId === driver.id);
    const scenarios = own.length;
    const pass = own.filter((r) => r.outcome === "pass").length;
    const fail = own.filter((r) => r.outcome === "fail").length;
    const clarified = own.filter((r) => r.outcome === "clarified").length;
    const error = own.filter((r) => r.outcome === "error").length;
    const withToolErrors = own.filter((r) => r.errorCount > 0).length;
    const totalToolErrors = own.reduce((acc, r) => acc + r.errorCount, 0);
    const rate = (n: number) => (scenarios === 0 ? 0 : Number((n / scenarios).toFixed(4)));
    return {
      id: driver.id,
      vendor: driver.vendor,
      available: driver.isAvailable(),
      scenarios,
      pass,
      fail,
      clarified,
      error,
      successRate: rate(pass),
      clarificationRate: rate(clarified),
      editRate: rate(withToolErrors),
      totalToolErrors,
    };
  });

  const control = models.find((m) => m.vendor === "deterministic");
  const controlPass = control ? control.fail === 0 && control.error === 0 && control.scenarios > 0 : false;
  const liveModelsEvaluated = models.filter((m) => m.vendor !== "deterministic" && m.scenarios > 0).length;

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    surface: { backend: input.backend, mcpTransport: input.mcpTransport, remoteUrl: input.remoteUrl },
    corpus: { scenarios: input.corpus.length, ids: input.corpus.map((s) => s.id) },
    models,
    results,
    summary: {
      pass: controlPass,
      modelsEvaluated: models.filter((m) => m.scenarios > 0).length,
      liveModelsEvaluated,
      scenarios: input.corpus.length,
    },
  };
}

/** Render a human-readable Markdown summary of the eval report. */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  const status = report.summary.pass ? "✅ PASS" : "❌ FAIL";

  lines.push("# MCP Cross-Model Workflow Eval");
  lines.push("");
  lines.push(`**Result (deterministic control):** ${status}`);
  lines.push("");
  lines.push(`- Generated: \`${report.generatedAt}\``);
  lines.push(
    `- MCP surface: \`${report.surface.backend}\` (transport: \`${report.surface.mcpTransport}\`${
      report.surface.remoteUrl ? `, remote: \`${report.surface.remoteUrl}\`` : ""
    })`,
  );
  lines.push(`- Corpus: ${report.corpus.scenarios} GIS workflows`);
  lines.push(`- Live models evaluated: ${report.summary.liveModelsEvaluated}`);
  lines.push("");

  lines.push("## Per-model scorecard");
  lines.push("");
  lines.push("| Model | Vendor | Avail | Pass | Fail | Clarified | Error | Success | Clarify | Edit |");
  lines.push("| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const m of report.models) {
    lines.push(
      `| \`${m.id}\` | ${m.vendor} | ${m.available ? "yes" : "no"} | ${m.pass} | ${m.fail} | ${m.clarified} | ${m.error} | ${pct(m.successRate)} | ${pct(m.clarificationRate)} | ${pct(m.editRate)} |`,
    );
  }
  lines.push("");

  const failures = report.results.filter((r) => r.outcome === "fail" || r.outcome === "error");
  if (failures.length > 0) {
    lines.push("## Non-passing results");
    lines.push("");
    for (const r of failures) {
      lines.push(`- \`${r.modelId}\` × \`${r.scenarioId}\` — **${r.outcome}**`);
      for (const v of r.violations) {
        lines.push(`  - ${v}`);
      }
    }
    lines.push("");
  }

  lines.push("> Live cross-model runs (Claude + GPT) are tracked under honua-io/honua-server#1956.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}
