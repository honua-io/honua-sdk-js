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
  /**
   * Required tools THIS scenario needs that the live `tools/list` did not
   * advertise — the per-workflow view of {@link EvalReport.catalog.unresolvedRequiredTools}.
   * Empty when the surface advertises every tool the scenario requires. This is
   * the P1 gate dashboard: it names, per north-star workflow, exactly which tools
   * a target surface is still missing.
   */
  missingTools: string[];
}

/**
 * Auth mode the eval used to reach the MCP surface.
 *
 *  - `bearer`    — `Authorization: Bearer <token>` (HONUA_MCP_AUTH_TOKEN).
 *  - `api-key`   — `x-api-key: <key>` (HONUA_API_KEY).
 *  - `anonymous` — a live remote surface reached with NO credential.
 *  - `none`      — the in-process offline fixture surface (no transport auth).
 *
 * Recorded in the artifact so a published live run proves it was authenticated
 * (not run through a dev-auth bypass).
 */
export type AuthMode = "bearer" | "api-key" | "anonymous" | "none";

/** Per-model aggregate metrics — the measurable form of the north star. */
export interface ModelScorecard {
  id: string;
  /** Resolved model id for live drivers (attributable); omitted for the control. */
  model?: string;
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
  schemaVersion: 4;
  generatedAt: string;
  surface: {
    backend: "fixture" | "live";
    mcpTransport: string;
    remoteUrl?: string;
    /** How the eval authenticated to the surface (proves the run was authed). */
    auth: AuthMode;
  };
  corpus: { scenarios: number; ids: string[] };
  /**
   * Catalog-coverage audit: how the corpus's required tools resolve against the
   * LIVE `tools/list` the surface advertised. `unresolvedRequiredTools` names any
   * required tool absent from the live catalog — so a scenario that fails does so
   * for a real capability gap, not a silent name-resolution bug.
   */
  catalog: {
    advertisedToolCount: number;
    requiredTools: string[];
    unresolvedRequiredTools: string[];
  };
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
  auth: AuthMode;
  /** Tool names advertised by the live `tools/list` (for the catalog audit). */
  advertisedTools: string[];
  corpus: Scenario[];
  drivers: ModelDriver[];
  graded: { grade: ScenarioGrade; transcript: WorkflowTranscript }[];
}

/** Distinct required-tool names referenced across a corpus. */
function corpusRequiredTools(corpus: Scenario[]): string[] {
  const names = new Set<string>();
  for (const scenario of corpus) {
    for (const tool of scenario.criteria.requiredTools) {
      names.add(tool);
    }
  }
  return [...names].sort();
}

export function assembleReport(input: AssembleInput): EvalReport {
  const advertised = new Set(input.advertisedTools);
  // Per-scenario required tools, so each result can name the tools THIS workflow
  // is missing from the surface (the per-workflow gate view).
  const requiredByScenario = new Map<string, string[]>(input.corpus.map((s) => [s.id, s.criteria.requiredTools]));

  const results: EvalResult[] = input.graded.map(({ grade, transcript }) => ({
    scenarioId: grade.scenarioId,
    modelId: grade.modelId,
    outcome: grade.outcome,
    violations: grade.violations,
    toolsCalled: transcript.steps.map((s) => s.tool),
    errorCount: grade.errorCount,
    driverError: transcript.driverError,
    missingTools: (requiredByScenario.get(grade.scenarioId) ?? []).filter((t) => !advertised.has(t)),
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
      // The control has no underlying model; live drivers' id IS the resolved model.
      ...(driver.vendor === "deterministic" ? {} : { model: driver.id }),
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

  const requiredTools = corpusRequiredTools(input.corpus);
  const unresolvedRequiredTools = requiredTools.filter((t) => !advertised.has(t));

  return {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    surface: {
      backend: input.backend,
      mcpTransport: input.mcpTransport,
      remoteUrl: input.remoteUrl,
      auth: input.auth,
    },
    corpus: { scenarios: input.corpus.length, ids: input.corpus.map((s) => s.id) },
    catalog: {
      advertisedToolCount: input.advertisedTools.length,
      requiredTools,
      unresolvedRequiredTools,
    },
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
  lines.push(`- Auth mode: \`${report.surface.auth}\``);
  lines.push(`- Corpus: ${report.corpus.scenarios} GIS workflows`);
  lines.push(`- Live models evaluated: ${report.summary.liveModelsEvaluated}`);
  const unresolved = report.catalog.unresolvedRequiredTools;
  lines.push(
    unresolved.length === 0
      ? `- Catalog coverage: all ${report.catalog.requiredTools.length} required tools resolve against the live catalog (${report.catalog.advertisedToolCount} advertised)`
      : `- Catalog coverage: ⚠️ ${unresolved.length} required tool(s) NOT advertised by the surface: ${unresolved.map((t) => `\`${t}\``).join(", ")}`,
  );
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
      if (r.missingTools.length > 0) {
        lines.push(`  - missing required tool(s) on this surface: ${r.missingTools.map((t) => `\`${t}\``).join(", ")}`);
      }
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
