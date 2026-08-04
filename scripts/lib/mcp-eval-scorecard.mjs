// Build the published cross-model MCP eval scorecard from the committed run
// artifacts under `mcp/evals/runs/` (issue #960).
//
// Discipline (mirrors scripts/generate-comparison-page.mjs):
//   - Every number on the page comes from a committed, dated run artifact.
//     Nothing is hand-written, nothing is averaged across surfaces, and the
//     renderer has no fallback that would invent a figure.
//   - Every published rate is RECOMPUTED here from the per-scenario `results`
//     rows and cross-checked against the artifact's own model summary. A
//     disagreement throws rather than publishing.
//   - The output is a pure function of the repo: no clock, no network, no
//     environment. That is what makes `--check` a real freshness gate.
//
// Artifact kinds (see mcp/src/eval/report.ts and mcp/src/certification):
//   - cross-model eval report  — schemaVersion 4, has `models` + `results`
//   - certification report     — schemaVersion 2, has `tools` + `contracts`

import fs from "node:fs";
import path from "node:path";

// Repo-relative, POSIX-separated so the rendered page is identical on every OS.
export const RUNS_DIR = "mcp/evals/runs";
export const OUTPUT_PATH = "docs/generated/mcp-eval-scorecard.md";

/** Corpus sources scanned for scenario titles so the matrix reads as workflows, not ids. */
export const CORPUS_SOURCES = [
  "mcp/src/eval/corpus.ts",
  "mcp/src/eval/operator-corpus.ts",
  "mcp/src/eval/northstar-corpus.ts",
  "mcp/src/eval/standalone-corpus.ts",
];

const BLOB_BASE = "https://github.com/honua-io/honua-sdk-js/blob/trunk";

const OUTCOME_ICON = { pass: "✅", fail: "❌", clarified: "❓", error: "⚠️" };

// ---------------------------------------------------------------------------
// Loading + validation
// ---------------------------------------------------------------------------

function walkJson(absoluteDir, relativeDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(absoluteDir, entry.name);
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) walkJson(absolute, relative, out);
    else if (entry.name.endsWith(".json")) out.push({ absolute, relative });
  }
  return out;
}

function classify(report) {
  if (Array.isArray(report?.models) && Array.isArray(report?.results)) return "eval";
  if (Array.isArray(report?.contracts) && Array.isArray(report?.tools)) return "certification";
  return "unknown";
}

/** Observation date (UTC calendar day) of a run artifact. */
function observedAt(report, location) {
  const stamp = report?.provenance?.generatedAt ?? report?.generatedAt;
  if (typeof stamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(stamp)) {
    throw new Error(`${location}: missing or malformed generatedAt timestamp`);
  }
  return stamp.slice(0, 10);
}

function suiteSha(report) {
  const sha = report?.provenance?.suiteGitSha;
  return typeof sha === "string" && sha !== "unknown" && sha.length >= 10 ? sha.slice(0, 12) : null;
}

/** Infer the corpus name from scenario-id prefixes (ids are namespaced per corpus). */
function inferCorpus(ids, location) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`${location}: artifact records no corpus scenario ids`);
  const prefixes = new Set(ids.map((id) => (id.includes("-") ? id.slice(0, id.indexOf("-")) : id)));
  if (prefixes.size === 1) {
    const only = [...prefixes][0];
    if (only === "operator" || only === "northstar" || only === "standalone") return only;
  }
  return "analyst";
}

function requireInteger(value, location, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${location}: ${field} must be a non-negative integer`);
  return value;
}

/**
 * Recompute a model's counters from its per-scenario rows and assert the
 * artifact's own summary agrees. This is the integrity gate that lets the page
 * claim every figure traces to graded per-scenario evidence.
 */
function recomputeModel(model, rows, location) {
  const id = typeof model?.id === "string" && model.id.length > 0 ? model.id : null;
  if (!id) throw new Error(`${location}: model entry has no id`);
  const own = rows.filter((row) => row.modelId === id);
  const counted = { pass: 0, fail: 0, clarified: 0, error: 0 };
  let toolErrorScenarios = 0;
  for (const row of own) {
    if (!(row.outcome in counted)) throw new Error(`${location}: unknown outcome "${row.outcome}" for model ${id}`);
    counted[row.outcome] += 1;
    if (requireInteger(row.errorCount ?? 0, location, `results[].errorCount for ${id}`) > 0) toolErrorScenarios += 1;
  }
  const scenarios = own.length;
  if (scenarios === 0) throw new Error(`${location}: model ${id} has no graded scenario rows`);

  for (const field of ["scenarios", "pass", "fail", "clarified", "error"]) {
    requireInteger(model[field], location, `models[${id}].${field}`);
  }
  const declared = {
    scenarios: model.scenarios,
    pass: model.pass,
    fail: model.fail,
    clarified: model.clarified,
    error: model.error,
  };
  const derived = { scenarios, ...counted };
  for (const [field, value] of Object.entries(derived)) {
    if (declared[field] !== value) {
      throw new Error(
        `${location}: model ${id} summary disagrees with its graded rows — ` +
          `${field} declared ${declared[field]}, recomputed ${value}`,
      );
    }
  }
  const rate = (n) => Number((n / scenarios).toFixed(4));
  for (const [field, value] of [
    ["successRate", rate(counted.pass)],
    ["clarificationRate", rate(counted.clarified)],
    ["editRate", rate(toolErrorScenarios)],
  ]) {
    if (typeof model[field] === "number" && Math.abs(model[field] - value) > 0.0001) {
      throw new Error(`${location}: model ${id} ${field} declared ${model[field]}, recomputed ${value}`);
    }
  }

  return {
    id,
    // The control has no underlying model; a live driver's id IS the resolved model.
    vendor: typeof model.vendor === "string" ? model.vendor : "unknown",
    control: model.vendor === "deterministic",
    scenarios,
    pass: counted.pass,
    fail: counted.fail,
    clarified: counted.clarified,
    error: counted.error,
    toolErrorScenarios,
    totalToolErrors: own.reduce((sum, row) => sum + (row.errorCount ?? 0), 0),
  };
}

function loadEvalArtifact(report, location) {
  if (report.schemaVersion !== 4) {
    throw new Error(`${location}: unsupported eval schemaVersion ${report.schemaVersion} (expected 4)`);
  }
  const ids = report.corpus?.ids ?? [];
  const rows = report.results.map((row) => {
    if (typeof row?.scenarioId !== "string" || typeof row?.modelId !== "string") {
      throw new Error(`${location}: results[] row is missing scenarioId/modelId`);
    }
    return row;
  });
  for (const row of rows) {
    if (!ids.includes(row.scenarioId)) {
      throw new Error(`${location}: graded scenario ${row.scenarioId} is absent from corpus.ids`);
    }
  }
  const models = report.models.map((model) => recomputeModel(model, rows, location));
  const surface = report.surface?.remoteUrl ?? report.surface?.backend ?? null;
  if (!surface) throw new Error(`${location}: artifact records no evaluated surface`);

  return {
    kind: "eval",
    location,
    date: observedAt(report, location),
    corpus: inferCorpus(ids, location),
    scenarioIds: [...ids].sort(),
    surface,
    backend: report.surface?.backend ?? "unknown",
    transport: report.surface?.mcpTransport ?? "unknown",
    auth: report.surface?.auth ?? "unknown",
    protocolVersion: report.provenance?.protocolVersion ?? null,
    advertisedToolCount: report.catalog?.advertisedToolCount ?? null,
    unresolvedRequiredTools: report.catalog?.unresolvedRequiredTools ?? [],
    suiteSha: suiteSha(report),
    models,
    rows,
  };
}

function loadCertificationArtifact(report, location) {
  if (report.schemaVersion !== 2) {
    throw new Error(`${location}: unsupported certification schemaVersion ${report.schemaVersion} (expected 2)`);
  }
  const summary = report.summary ?? {};
  for (const field of ["toolsDiscovered", "contractsChecked", "contractsPassed", "contractsFailed"]) {
    requireInteger(summary[field], location, `summary.${field}`);
  }
  return {
    kind: "certification",
    location,
    date: observedAt(report, location),
    surface: report.protocol?.surface ?? "unknown",
    targetMode: report.protocol?.targetMode ?? "unknown",
    protocolVersion: report.provenance?.protocolVersion ?? null,
    auth: report.provenance?.authMode ?? "unknown",
    standard: report.standard?.source ?? null,
    suiteSha: suiteSha(report),
    summary,
    contracts: report.contracts.map((entry) => ({
      contract: entry.contract ?? "unknown",
      target: entry.target ?? "unknown",
      status: entry.status ?? "unknown",
      detail: typeof entry.detail === "string" ? entry.detail : "",
    })),
    knownGaps: Array.isArray(report.knownGaps) ? report.knownGaps : [],
  };
}

/** Read + validate every committed run artifact. Throws on anything unpublishable. */
export function loadMcpEvalRuns(projectRoot, runsDir = RUNS_DIR) {
  const absoluteRuns = path.join(projectRoot, runsDir);
  const files = walkJson(absoluteRuns, runsDir, []);
  if (files.length === 0) throw new Error(`no committed run artifacts under ${runsDir}`);

  const evals = [];
  const certifications = [];
  for (const file of files) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(file.absolute, "utf8"));
    } catch (error) {
      throw new Error(`${file.relative}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
    }
    const kind = classify(report);
    if (kind === "eval") evals.push(loadEvalArtifact(report, file.relative));
    else if (kind === "certification") certifications.push(loadCertificationArtifact(report, file.relative));
    else throw new Error(`${file.relative}: not a recognised eval or certification report`);
  }
  if (evals.length === 0) throw new Error(`no cross-model eval artifacts under ${runsDir}`);
  return { evals, certifications };
}

/** Extract `id` → `{ title, category }` from the committed corpus definitions. */
export function loadScenarioIndex(projectRoot, sources = CORPUS_SOURCES) {
  const index = new Map();
  for (const source of sources) {
    const absolute = path.join(projectRoot, source);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, "utf8");
    const pattern = /\bid:\s*"([^"]+)",\s*\n\s*title:\s*"([^"]+)",\s*\n\s*category:\s*"([^"]+)"/g;
    for (const match of text.matchAll(pattern)) {
      if (!index.has(match[1])) index.set(match[1], { title: match[2], category: match[3], source });
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function percent(numerator, denominator) {
  if (denominator === 0) return "—";
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/**
 * Collapse (corpus, model) observations that produced an identical result into a
 * single row, listing every date it was observed. Differing results stay separate
 * rows so a regression can never be averaged away.
 */
function leaderboardRows(evals) {
  const grouped = new Map();
  for (const artifact of evals) {
    for (const model of artifact.models) {
      const signature = [
        artifact.corpus,
        model.id,
        artifact.surface,
        model.scenarios,
        model.pass,
        model.fail,
        model.clarified,
        model.error,
        model.toolErrorScenarios,
      ].join("::");
      const existing = grouped.get(signature);
      if (existing) {
        existing.dates.push(artifact.date);
        existing.observations += 1;
        if (artifact.suiteSha) existing.suiteShas.push(artifact.suiteSha);
        else existing.missingSha += 1;
        existing.artifacts.push(artifact.location);
        continue;
      }
      grouped.set(signature, {
        ...model,
        corpus: artifact.corpus,
        surface: artifact.surface,
        auth: artifact.auth,
        protocolVersion: artifact.protocolVersion,
        dates: [artifact.date],
        observations: 1,
        suiteShas: artifact.suiteSha ? [artifact.suiteSha] : [],
        missingSha: artifact.suiteSha ? 0 : 1,
        artifacts: [artifact.location],
      });
    }
  }
  const rows = [...grouped.values()].map((row) => ({
    ...row,
    dates: uniqueSorted(row.dates),
    suiteShas: uniqueSorted(row.suiteShas),
    artifacts: uniqueSorted(row.artifacts),
  }));
  rows.sort((a, b) => {
    if (a.corpus !== b.corpus) return a.corpus.localeCompare(b.corpus);
    if (a.control !== b.control) return a.control ? -1 : 1;
    if (a.pass !== b.pass) return b.pass - a.pass;
    return a.id.localeCompare(b.id);
  });
  return rows;
}

/** Per-corpus scenario × model outcome matrix, merged across artifacts. */
function scenarioMatrices(evals, scenarioIndex) {
  const byCorpus = new Map();
  for (const artifact of evals) {
    if (!byCorpus.has(artifact.corpus)) {
      byCorpus.set(artifact.corpus, {
        corpus: artifact.corpus,
        surfaces: new Set(),
        dates: new Set(),
        scenarios: new Set(),
        models: new Set(),
        cells: new Map(),
      });
    }
    const group = byCorpus.get(artifact.corpus);
    group.surfaces.add(artifact.surface);
    group.dates.add(artifact.date);
    for (const id of artifact.scenarioIds) group.scenarios.add(id);
    for (const row of artifact.rows) {
      group.models.add(row.modelId);
      if (!group.cells.has(row.scenarioId)) group.cells.set(row.scenarioId, new Map());
      group.cells.get(row.scenarioId).set(row.modelId, row.outcome);
    }
  }
  return [...byCorpus.values()]
    .sort((a, b) => a.corpus.localeCompare(b.corpus))
    .map((group) => ({
      corpus: group.corpus,
      surfaces: uniqueSorted([...group.surfaces]),
      dates: uniqueSorted([...group.dates]),
      models: orderModels([...group.models]),
      scenarios: [...group.scenarios].sort().map((id) => ({
        id,
        title: scenarioIndex.get(id)?.title ?? null,
        category: scenarioIndex.get(id)?.category ?? null,
        outcomes: group.cells.get(id) ?? new Map(),
      })),
    }));
}

function orderModels(models) {
  return [...models].sort((a, b) => {
    if (a === "deterministic") return -1;
    if (b === "deterministic") return 1;
    return a.localeCompare(b);
  });
}

/** Every graded row that did not pass — the candor section. */
function nonPassResults(evals, scenarioIndex) {
  const out = [];
  for (const artifact of evals) {
    for (const row of artifact.rows) {
      if (row.outcome === "pass") continue;
      out.push({
        date: artifact.date,
        corpus: artifact.corpus,
        artifact: artifact.location,
        scenarioId: row.scenarioId,
        scenarioTitle: scenarioIndex.get(row.scenarioId)?.title ?? null,
        modelId: row.modelId,
        outcome: row.outcome,
        violations: Array.isArray(row.violations) ? row.violations : [],
        toolsCalled: Array.isArray(row.toolsCalled) ? row.toolsCalled : [],
        errorCount: row.errorCount ?? 0,
        driverError: typeof row.driverError === "string" ? row.driverError : null,
        missingTools: Array.isArray(row.missingTools) ? row.missingTools : [],
      });
    }
  }
  out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.modelId.localeCompare(b.modelId) || a.scenarioId.localeCompare(b.scenarioId),
  );
  return out;
}

export function buildScorecardModel({ evals, certifications, scenarioIndex }) {
  const rows = leaderboardRows(evals);
  const observedDates = uniqueSorted([...evals, ...certifications].map((artifact) => artifact.date));
  const latestCertification = [...certifications].sort((a, b) => a.date.localeCompare(b.date)).at(-1) ?? null;
  const matrices = scenarioMatrices(evals, scenarioIndex);
  return {
    leaderboard: rows,
    controls: rows.filter((row) => row.control),
    matrices,
    failures: nonPassResults(evals, scenarioIndex),
    evals: [...evals].sort((a, b) => a.date.localeCompare(b.date) || a.location.localeCompare(b.location)),
    certifications: [...certifications].sort(
      (a, b) => a.date.localeCompare(b.date) || a.location.localeCompare(b.location),
    ),
    latestCertification,
    observedDates,
    firstObserved: observedDates[0],
    lastObserved: observedDates.at(-1),
    liveModels: uniqueSorted(rows.filter((row) => !row.control).map((row) => row.id)),
    surfaces: uniqueSorted(evals.map((artifact) => artifact.surface)),
    publishedCorpora: matrices.map((matrix) => ({ corpus: matrix.corpus, scenarios: matrix.scenarios.length })),
    // Derived, never asserted: the live catalog changed size across the window.
    advertisedToolCounts: uniqueSorted(
      evals.map((artifact) => artifact.advertisedToolCount).filter((count) => Number.isInteger(count)),
    ),
    unresolvedRequiredTools: evals
      .filter((artifact) => artifact.unresolvedRequiredTools.length > 0)
      .map((artifact) => ({ location: artifact.location, tools: [...artifact.unresolvedRequiredTools].sort() })),
    artifactsWithoutProvenance: [...evals, ...certifications].filter((artifact) => !artifact.suiteSha).length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function code(value) {
  return `\`${cell(value)}\``;
}

function link(text, repoPath) {
  return `[${text}](${BLOB_BASE}/${repoPath})`;
}

function treeLink(text, repoPath) {
  return `[${text}](${BLOB_BASE.replace("/blob/", "/tree/")}/${repoPath})`;
}

function joinDates(dates) {
  return dates.join(", ");
}

/**
 * Render suite SHAs for a row that may aggregate several artifacts. A run whose
 * artifact carries no provenance block is named as such rather than silently
 * inheriting a sibling run's SHA.
 */
function shaCell(shas, missing = 0) {
  const recorded = shas.map((sha) => code(sha));
  if (recorded.length === 0) return "not recorded";
  return missing > 0 ? `${recorded.join(", ")} · ${missing} not recorded` : recorded.join(", ");
}

export function renderScorecardMarkdown(model) {
  const lines = [];
  const push = (...values) => lines.push(...values);

  push(
    "<!-- GENERATED FILE — do not edit by hand. -->",
    "<!-- Regenerate with: npm run docs:mcp-scorecard -->",
    `<!-- Inputs: ${RUNS_DIR}/**/*.json (committed run artifacts), ${CORPUS_SOURCES.join(", ")}. -->`,
    "<!-- Freshness is enforced by npm run docs:mcp-scorecard:check. -->",
    "",
    "# Cross-model MCP eval scorecard",
    "",
  );

  push(
    "How well do different client models actually drive Honua's MCP surface? This page is the",
    "answer, published rather than asserted. Every figure below is rendered from a committed run",
    `artifact under ${treeLink(`\`${RUNS_DIR}/\``, RUNS_DIR)} — the same JSON the eval harness wrote,`,
    "carrying the surface it ran against, how it authenticated, and (where the artifact is new",
    "enough to record it) the negotiated MCP protocol version and the git SHA of the suite that",
    "produced it. Nothing here is hand-typed, and the generator recomputes every rate from the",
    "per-scenario rows before publishing it, so a summary that disagreed with its own graded",
    "evidence would fail the build instead of reaching this page.",
    "",
    `**Observation window:** ${model.firstObserved} → ${model.lastObserved}`,
    `(${model.observedDates.length} distinct observation ${model.observedDates.length === 1 ? "date" : "dates"},`,
    `${model.evals.length} cross-model eval ${model.evals.length === 1 ? "artifact" : "artifacts"},`,
    `${model.certifications.length} certification ${model.certifications.length === 1 ? "artifact" : "artifacts"}).`,
    "",
    "> This is a small, honest corpus, not a benchmark leaderboard. Read",
    "> [What this does and does not measure](#what-this-does-and-does-not-measure) before citing a",
    "> number from it.",
    "",
  );

  // -- Leaderboard ----------------------------------------------------------
  push(
    "## Cross-model leaderboard",
    "",
    "One row per model per distinct observed result. The deterministic control is listed first: it",
    "makes **no model calls**, runs the identical corpus through the identical catalog, and is the",
    "CI gate — it is the ceiling the models are measured against, not a competitor.",
    "",
    "| Model | Runtime | Corpus | Surface | Scenarios | Passed | Clarified | Errored | Pass rate | Tool-error scenarios | Observed | Runs | Suite SHA |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |",
  );
  for (const row of model.leaderboard) {
    const label = row.control ? `${code(row.id)} _(control)_` : code(row.id);
    push(
      `| ${label} | ${cell(row.vendor)} | ${cell(row.corpus)} | ${cell(row.surface)} | ${row.scenarios} | ` +
        `${row.pass} | ${row.clarified} | ${row.error} | ${percent(row.pass, row.scenarios)} | ` +
        `${row.toolErrorScenarios}/${row.scenarios} | ${joinDates(row.dates)} | ${row.observations} | ` +
        `${shaCell(row.suiteShas, row.missingSha)} |`,
    );
  }
  push(
    "",
    "Column definitions, because these words are used loosely elsewhere:",
    "",
    "- **Runtime** — how the model was invoked. `bedrock` means the run went through AWS Bedrock;",
    "  `deterministic` is the scripted zero-LLM control.",
    "- **Passed** — the graded workflow met every criterion: required tools called, expected tool",
    "  order respected, forbidden (mutating) tools avoided, and any asserted answer content present.",
    "- **Clarified** — the driver ended the run by asking a clarifying question instead of",
    "  completing the graded workflow (the grader records the violation `driver requested",
    "  clarification`). Tracked separately from a failure, and not counted as a pass. The corpus",
    "  deliberately contains a scenario that *requires* a clarification round-trip and passes when",
    "  the model completes it, so asking is a non-pass only where the workflow was meant to continue.",
    "- **Errored** — the run did not finish; for example, a driver that exceeded its tool-use",
    "  iteration budget. Also not a pass.",
    "- **Tool-error scenarios** — scenarios in which at least one `tools/call` returned an error,",
    "  whether or not the workflow ultimately passed. In the raw artifacts this ratio is stored",
    "  under the historical field name `editRate`; it counts erroring tool calls, not edits.",
    "- **Runs** — how many committed artifacts recorded this identical result. A model whose result",
    "  changed between runs appears as more than one row.",
    "- **Suite SHA** — the commit of the eval suite that produced the artifact, so a row can be",
    "  re-run. `not recorded` means the artifact predates the provenance block (see",
    "  [Provenance](#provenance-and-reproducibility)).",
    "",
  );

  // -- Scenario matrix ------------------------------------------------------
  push(
    "## Per-scenario matrix",
    "",
    "Legend: ✅ pass · ❌ fail · ❓ clarified · ⚠️ error · · not run",
    "",
  );
  for (const matrix of model.matrices) {
    push(
      `### ${matrix.corpus} corpus`,
      "",
      `Surface: ${matrix.surfaces.map((surface) => code(surface)).join(", ")} · observed ${joinDates(matrix.dates)}`,
      "",
      `| Scenario | Category | ${matrix.models.map((id) => cell(id)).join(" | ")} |`,
      `| --- | --- | ${matrix.models.map(() => ":--:").join(" | ")} |`,
    );
    for (const scenario of matrix.scenarios) {
      const label = scenario.title ? `${code(scenario.id)}<br />${cell(scenario.title)}` : code(scenario.id);
      const outcomes = matrix.models.map((id) => OUTCOME_ICON[scenario.outcomes.get(id)] ?? "·");
      push(`| ${label} | ${cell(scenario.category ?? "—")} | ${outcomes.join(" | ")} |`);
    }
    push("");
  }

  // -- Failures -------------------------------------------------------------
  push("## Every non-passing run", "");
  if (model.failures.length === 0) {
    push(
      "No graded scenario in any committed artifact ended in a fail, clarification, or error. That",
      "is a statement about this corpus on this surface on these dates — see the limits below.",
      "",
    );
  } else {
    push(
      "A wins-only scoreboard is marketing. Every non-passing graded run in the committed corpus is",
      "listed here, with the grader's own violation text.",
      "",
      "| Observed | Model | Scenario | Outcome | Why it did not pass | Tool calls | Erroring calls |",
      "| --- | --- | --- | --- | --- | ---: | ---: |",
    );
    for (const failure of model.failures) {
      const reason = failure.violations.length > 0 ? failure.violations.join("; ") : (failure.driverError ?? "—");
      const scenario = failure.scenarioTitle
        ? `${code(failure.scenarioId)}<br />${cell(failure.scenarioTitle)}`
        : code(failure.scenarioId);
      push(
        `| ${failure.date} | ${code(failure.modelId)} | ${scenario} | ${OUTCOME_ICON[failure.outcome] ?? ""} ${cell(failure.outcome)} | ` +
          `${cell(reason)} | ${failure.toolsCalled.length} | ${failure.errorCount} |`,
      );
    }
    push(
      "",
      "Read these as capability signals, not bugs in the surface: the eval grades whether a client",
      "*composed the right workflow*, so a smaller model that asked for clarification it did not need,",
      "or looped past its iteration budget, is exactly what the corpus is designed to expose.",
      "",
    );
  }

  // -- Certification --------------------------------------------------------
  if (model.certifications.length > 0) {
    push(
      "## Protocol certification (zero-LLM control)",
      "",
      "Separate from the model eval, a deterministic certifier checks the same live surface against",
      "the vendor-neutral geospatial-MCP standard: tool schemas, structured output, error shape,",
      "pagination, and the standard tool families. It makes no model calls, so it is free to run on a",
      "schedule and it fails loudly.",
      "",
      "| Observed | Surface | Mode | Tools | Schema-conformant | Contracts passed | Failed | Skipped | Known gaps | Result | Suite SHA |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | --- |",
    );
    for (const run of model.certifications) {
      const summary = run.summary;
      push(
        `| ${run.date} | ${cell(run.surface)} | ${code(run.targetMode)} | ${summary.toolsDiscovered} | ` +
          `${summary.toolsConformant ?? "—"}/${summary.toolsConformanceChecked ?? "—"} | ` +
          `${summary.contractsPassed}/${summary.contractsChecked} | ${summary.contractsFailed} | ` +
          `${summary.contractsSkipped ?? 0} | ${summary.knownGaps ?? 0} | ${summary.pass ? "✅ pass" : "❌ fail"} | ` +
          `${shaCell(run.suiteSha ? [run.suiteSha] : [])} |`,
      );
    }
    push("");

    const latest = model.latestCertification;
    const notable = latest.contracts.filter((entry) => entry.status !== "passed");
    if (notable.length > 0) {
      push(
        `### Certification failures and skips — ${latest.date}`,
        "",
        `From ${link(`\`${latest.location}\``, latest.location)}. Failures are real conformance defects in the`,
        "certified surface, published unedited; skips name the reason they could not be checked.",
        "",
        "| Contract | Target | Status | Detail |",
        "| --- | --- | --- | --- |",
      );
      for (const entry of notable) {
        push(
          `| ${code(entry.contract)} | ${code(entry.target)} | ${cell(entry.status)} | ${cell(entry.detail || "—")} |`,
        );
      }
      push("");
    }

    if (latest.knownGaps.length > 0) {
      const families = uniqueSorted(latest.knownGaps.map((gap) => gap.family ?? "unclassified"));
      push(
        `The same run recorded **${latest.knownGaps.length} known standard gaps** — tool families in the`,
        `geospatial-MCP standard the certified surface does not yet advertise (${families.map((f) => cell(f)).join(", ")}).`,
        `They are enumerated in ${link(`\`${latest.location}\``, latest.location)} under \`knownGaps\`.`,
        "",
      );
    }
  }

  // -- Methodology ----------------------------------------------------------
  const catalogDrift =
    model.advertisedToolCounts.length > 1
      ? `a live surface that changed underneath them (the advertised tool count across these artifacts ranges from ${model.advertisedToolCounts[0]} to ${model.advertisedToolCounts.at(-1)})`
      : "a live surface that can change between runs";
  const corpusSizes = model.publishedCorpora
    .map((entry) => `${entry.scenarios} ${entry.corpus} ${entry.scenarios === 1 ? "scenario" : "scenarios"}`)
    .join(" and ");
  push(
    "## What this does and does not measure",
    "",
    "**It measures** whether a client model, given a plain-language GIS goal and nothing but the",
    "MCP catalog the surface advertises, composes the right workflow: discovers layers before",
    "querying them, grounds an ambiguous goal before planning it, validates a plan before a dry run,",
    "and — critically — stays read-only when the task is read-only. Mutating lifecycle tools are",
    '*forbidden* by the grader on the read-only scenarios, so "did the agent stay inside its',
    'authority?" is a scored criterion rather than a hope.',
    "",
    "**It does not measure** general model quality, latency, cost, or output prose. It is not a",
    `head-to-head model benchmark: the rows above were observed on different dates against ${catalogDrift}.`,
    "Treat a one-scenario difference as noise; the deterministic control is the only row whose",
    "meaning is stable across dates.",
    "",
    "Other honest limits:",
    "",
    `- **Corpus size.** The published corpus is ${corpusSizes}. That is enough to surface gross`,
    "  workflow failures and nowhere near enough for a confidence interval. No statistical claim is",
    "  made or implied.",
    "- **Single run per (model, date).** Rates are not averaged over repeated sampling, so a rate",
    "  describes the recorded runs and is not an expectation.",
    `- **Surfaces covered.** Every published row targets ${model.surfaces.map((surface) => code(surface)).join(", ")}.`,
    "  The platform-free standalone corpus (a plain public FeatureServer, semantically graded) has no",
    "  committed cross-model artifact yet, so it is absent from this page rather than summarised from",
    "  memory.",
    "- **Paid lane.** Live cross-model runs bill real model usage, so they are dispatched manually",
    "  rather than on every commit. That is why observation dates are sparse.",
    "",
  );

  // -- Provenance -----------------------------------------------------------
  push(
    "## Provenance and reproducibility",
    "",
    "Every artifact behind this page, with the surface it targeted and the suite that produced it.",
    "",
    "| Artifact | Observed | Kind | Surface | Transport | Protocol | Tools advertised | Auth | Suite SHA |",
    "| --- | --- | --- | --- | --- | --- | ---: | --- | --- |",
  );
  for (const artifact of model.evals) {
    push(
      `| ${link(`\`${path.posix.basename(artifact.location)}\``, artifact.location)} | ${artifact.date} | cross-model eval | ` +
        `${cell(artifact.surface)} | ${code(artifact.transport)} | ${artifact.protocolVersion ? code(artifact.protocolVersion) : "not recorded"} | ` +
        `${artifact.advertisedToolCount ?? "—"} | ${code(artifact.auth)} | ${shaCell(artifact.suiteSha ? [artifact.suiteSha] : [])} |`,
    );
  }
  for (const artifact of model.certifications) {
    push(
      `| ${link(`\`${path.posix.basename(artifact.location)}\``, artifact.location)} | ${artifact.date} | certification | ` +
        `${cell(artifact.surface)} | — | ${artifact.protocolVersion ? code(artifact.protocolVersion) : "not recorded"} | ` +
        `${artifact.summary.toolsDiscovered} | ${code(artifact.auth)} | ${shaCell(artifact.suiteSha ? [artifact.suiteSha] : [])} |`,
    );
  }
  push("");
  if (model.artifactsWithoutProvenance > 0) {
    push(
      `${model.artifactsWithoutProvenance} of the artifacts above predate the self-proving provenance`,
      "block and therefore carry no suite SHA or negotiated protocol version. They are published",
      "as-is, labelled `not recorded`, rather than back-filled — a provenance field that was never",
      "observed is not a field this repo will invent.",
      "",
    );
  }
  push(
    "An unresolved required tool would mean a scenario failed because the surface never advertised",
    "the tool, not because the model chose wrongly. The eval records that separately, per artifact,",
    "as `catalog.unresolvedRequiredTools`.",
    "",
  );
  if (model.unresolvedRequiredTools.length === 0) {
    push(
      "Across every published artifact that list is empty, so every non-pass above is a genuine",
      "workflow-composition result rather than a missing tool.",
      "",
    );
  } else {
    push("It is **not** empty here, so the affected scenarios are confounded by catalog gaps:", "");
    for (const entry of model.unresolvedRequiredTools) {
      push(`- ${link(`\`${entry.location}\``, entry.location)} — ${entry.tools.map((tool) => code(tool)).join(", ")}`);
    }
    push("");
  }

  // -- Regeneration ---------------------------------------------------------
  push(
    "## How to reproduce, and how this page stays honest",
    "",
    "Re-run the deterministic control — free, offline, no credentials:",
    "",
    "```bash",
    "npm ci && npm run build            # build the SDK the MCP package consumes",
    "npm ci --prefix mcp",
    "npm run --prefix mcp eval:offline  # deterministic control over the fixture surface",
    "```",
    "",
    "Re-run a live cross-model row (billable; needs credentials and a reachable `/mcp`):",
    "",
    "```bash",
    "HONUA_MCP_REMOTE_URL=\"https://demo.honua.io/mcp\" \\",
    "HONUA_API_KEY=\"$HONUA_DEMO_API_KEY\" \\",
    "HONUA_EVAL_REQUIRE_AUTH=1 \\",
    "HONUA_EVAL_BEDROCK=1 AWS_REGION=us-west-2 \\",
    "HONUA_EVAL_BEDROCK_MODEL=\"us.anthropic.claude-sonnet-4-5-20250929-v1:0\" \\",
    "  npm run --prefix mcp eval:live -- --driver bedrock",
    "```",
    "",
    "Then commit the artifact under `mcp/evals/runs/<YYYY-MM-DD>/` and regenerate:",
    "",
    "```bash",
    "npm run docs:mcp-scorecard         # rewrite this page from the committed artifacts",
    "npm run docs:mcp-scorecard:check   # the CI gate: fails if the page drifts from them",
    "```",
    "",
    "The `check` mode runs in the docs-site pipeline next to `npm run verify:llms` and",
    "`npm run docs:comparison:check`. Because the renderer reads no clock and no network, the check",
    "has exactly one failure mode worth having: the committed artifacts and the published page",
    "disagree. Adding a run without republishing, or editing a figure on this page by hand, both",
    "fail the build.",
    "",
    "## Related evidence",
    "",
    `- ${link("`mcp/evals/README.md`", "mcp/evals/README.md")} — the evidence corpus, grading taxonomy, and how runs land in the repo.`,
    `- ${link("`mcp/README.md`", "mcp/README.md")} — the MCP server itself, the eval CLI, and the live-lane environment contract.`,
    `- ${link("`mcp/src/eval/operator-corpus.ts`", "mcp/src/eval/operator-corpus.ts")} — every scenario prompt and grading criterion in the operator corpus.`,
    "- [Coding-agent evaluation scorecard](./coding-agent-scorecard.md) — the sibling measurement: can a coding agent write correct SDK code on the first try?",
    "- [How Honua compares](../comparison.md) — the same generated-evidence discipline applied to bundle size, protocol coverage, and time-to-first-map.",
  );

  return `${lines.join("\n")}\n`;
}

/** Full pipeline: committed artifacts in, published markdown out. */
export function generateScorecardMarkdown(projectRoot) {
  const { evals, certifications } = loadMcpEvalRuns(projectRoot);
  const scenarioIndex = loadScenarioIndex(projectRoot);
  return renderScorecardMarkdown(buildScorecardModel({ evals, certifications, scenarioIndex }));
}
