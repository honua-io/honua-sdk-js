import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OUTPUT_PATH,
  RUNS_DIR,
  buildScorecardModel,
  generateScorecardMarkdown,
  loadMcpEvalRuns,
  loadScenarioIndex,
  renderScorecardMarkdown,
} from "../../scripts/lib/mcp-eval-scorecard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function committedArtifacts() {
  const runs = path.join(root, RUNS_DIR);
  const out = [];
  for (const day of fs.readdirSync(runs).sort()) {
    const dir = path.join(runs, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (file.endsWith(".json")) out.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
    }
  }
  return out;
}

function withTempRuns(artifacts) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-scorecard-"));
  const runs = path.join(projectRoot, RUNS_DIR, "2026-01-01");
  fs.mkdirSync(runs, { recursive: true });
  artifacts.forEach((artifact, index) => {
    fs.writeFileSync(path.join(runs, `artifact-${index}.json`), JSON.stringify(artifact), "utf8");
  });
  return projectRoot;
}

/** A minimal but valid cross-model eval artifact (schemaVersion 4). */
function evalArtifact(overrides = {}) {
  return {
    schemaVersion: 4,
    generatedAt: "2026-01-01T00:00:00.000Z",
    provenance: {
      suiteGitSha: "0123456789abcdef0123456789abcdef01234567",
      targetUrl: "https://example.invalid/mcp",
      protocolVersion: "2025-06-18",
      toolCount: 2,
      authMode: "api-key",
    },
    surface: { backend: "live", mcpTransport: "streamable-http", remoteUrl: "https://example.invalid/mcp", auth: "api-key" },
    corpus: { scenarios: 2, ids: ["operator-list-layers", "operator-dry-run"] },
    catalog: { advertisedToolCount: 2, requiredTools: ["honua_list_layers"], unresolvedRequiredTools: [] },
    models: [
      {
        id: "deterministic",
        vendor: "deterministic",
        available: true,
        scenarios: 2,
        pass: 2,
        fail: 0,
        clarified: 0,
        error: 0,
        successRate: 1,
        clarificationRate: 0,
        editRate: 0,
        totalToolErrors: 0,
      },
    ],
    results: [
      { scenarioId: "operator-list-layers", modelId: "deterministic", outcome: "pass", violations: [], toolsCalled: ["honua_list_layers"], errorCount: 0, missingTools: [] },
      { scenarioId: "operator-dry-run", modelId: "deterministic", outcome: "pass", violations: [], toolsCalled: ["honua_dry_run"], errorCount: 0, missingTools: [] },
    ],
    summary: { pass: true, modelsEvaluated: 1, liveModelsEvaluated: 0, scenarios: 2 },
    ...overrides,
  };
}

test("every committed run artifact loads, validates, and is classified", () => {
  const { evals, certifications } = loadMcpEvalRuns(root);
  assert.ok(evals.length > 0, "expected at least one cross-model eval artifact");
  assert.equal(evals.length + certifications.length, committedArtifacts().length);
  for (const artifact of [...evals, ...certifications]) {
    assert.match(artifact.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(artifact.location.startsWith(`${RUNS_DIR}/`));
  }
});

test("published leaderboard figures are recomputed from the graded per-scenario rows", () => {
  const { evals, certifications } = loadMcpEvalRuns(root);
  const model = buildScorecardModel({ evals, certifications, scenarioIndex: loadScenarioIndex(root) });

  // Independently recount from the raw artifacts and require the model to agree.
  const expected = new Map();
  for (const report of committedArtifacts()) {
    if (!Array.isArray(report.results)) continue;
    for (const row of report.results) {
      const key = row.modelId;
      const counts = expected.get(key) ?? { pass: 0, total: 0 };
      counts.total += 1;
      if (row.outcome === "pass") counts.pass += 1;
      expected.set(key, counts);
    }
  }
  for (const [modelId, counts] of expected) {
    const rows = model.leaderboard.filter((row) => row.id === modelId);
    assert.ok(rows.length > 0, `leaderboard is missing ${modelId}`);
    const pass = rows.reduce((sum, row) => sum + row.pass * row.observations, 0);
    const total = rows.reduce((sum, row) => sum + row.scenarios * row.observations, 0);
    assert.equal(pass, counts.pass, `pass count drifted for ${modelId}`);
    assert.equal(total, counts.total, `scenario count drifted for ${modelId}`);
  }
});

test("a model summary that disagrees with its graded rows is refused, not published", () => {
  const artifact = evalArtifact();
  artifact.models[0].pass = 1; // claim one fewer pass than the rows record
  const projectRoot = withTempRuns([artifact]);
  assert.throws(() => loadMcpEvalRuns(projectRoot), /summary disagrees with its graded rows/);
});

test("a declared rate that disagrees with the recomputed rate is refused", () => {
  const artifact = evalArtifact();
  artifact.models[0].successRate = 0.5;
  const projectRoot = withTempRuns([artifact]);
  assert.throws(() => loadMcpEvalRuns(projectRoot), /successRate declared 0\.5, recomputed 1/);
});

test("a graded scenario missing from corpus.ids is refused", () => {
  const artifact = evalArtifact();
  artifact.corpus.ids = ["operator-list-layers"];
  artifact.corpus.scenarios = 1;
  const projectRoot = withTempRuns([artifact]);
  assert.throws(() => loadMcpEvalRuns(projectRoot), /absent from corpus\.ids/);
});

test("an unrecognised artifact is refused rather than silently skipped", () => {
  const projectRoot = withTempRuns([{ schemaVersion: 4, generatedAt: "2026-01-01T00:00:00.000Z", note: "not a report" }]);
  assert.throws(() => loadMcpEvalRuns(projectRoot), /not a recognised eval or certification report/);
});

test("an unsupported schema version is refused", () => {
  const projectRoot = withTempRuns([evalArtifact({ schemaVersion: 3 })]);
  assert.throws(() => loadMcpEvalRuns(projectRoot), /unsupported eval schemaVersion 3/);
});

test("rendering is deterministic and clock-free", () => {
  const first = generateScorecardMarkdown(root);
  const second = generateScorecardMarkdown(root);
  assert.equal(first, second);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(!first.includes(today) || committedArtifacts().some((a) => String(a.generatedAt).startsWith(today)));
});

test("every non-passing graded run is published, not just the wins", () => {
  const { evals, certifications } = loadMcpEvalRuns(root);
  const model = buildScorecardModel({ evals, certifications, scenarioIndex: loadScenarioIndex(root) });
  const markdown = renderScorecardMarkdown(model);

  const nonPass = [];
  for (const report of committedArtifacts()) {
    for (const row of report.results ?? []) {
      if (row.outcome !== "pass") nonPass.push(row);
    }
  }
  assert.equal(model.failures.length, nonPass.length);
  for (const row of nonPass) {
    const section = markdown.slice(markdown.indexOf("## Every non-passing run"));
    assert.ok(section.includes(row.scenarioId), `non-passing scenario ${row.scenarioId} is not published`);
    assert.ok(section.includes(row.modelId), `non-passing model ${row.modelId} is not published`);
  }
});

test("the deterministic control is published and listed first in its corpus", () => {
  const { evals, certifications } = loadMcpEvalRuns(root);
  const model = buildScorecardModel({ evals, certifications, scenarioIndex: loadScenarioIndex(root) });
  assert.ok(model.controls.length > 0, "the zero-LLM control row must be published");
  const perCorpus = new Map();
  for (const row of model.leaderboard) {
    if (!perCorpus.has(row.corpus)) perCorpus.set(row.corpus, row);
  }
  for (const [corpus, first] of perCorpus) {
    assert.ok(first.control, `${corpus} leaderboard must lead with the deterministic control`);
  }
});

test("scenario titles resolve from the committed corpus definitions", () => {
  const index = loadScenarioIndex(root);
  assert.deepEqual(index.get("operator-list-layers"), {
    title: "Discover the published layers on the operator surface",
    category: "discovery",
    source: "mcp/src/eval/operator-corpus.ts",
  });
});

test("the committed page matches the generator output", () => {
  const published = fs.readFileSync(path.join(root, OUTPUT_PATH), "utf8").replace(/\r\n/g, "\n");
  assert.equal(published, generateScorecardMarkdown(root), `${OUTPUT_PATH} is stale — run npm run docs:mcp-scorecard`);
});
