import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADMIN_FAMILY_PATH,
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

function withTempRuns(artifacts, names) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-scorecard-"));
  const runs = path.join(projectRoot, RUNS_DIR, "2026-01-01");
  fs.mkdirSync(runs, { recursive: true });
  artifacts.forEach((artifact, index) => {
    const name = names?.[index] ?? `artifact-${index}.json`;
    fs.writeFileSync(path.join(runs, name), JSON.stringify(artifact), "utf8");
  });
  return projectRoot;
}

/**
 * Split a markdown table row into cells the way a markdown parser does: a
 * backslash escapes the following character, so only an UNescaped pipe ends a
 * cell. Escaping that fails to handle backslashes shows up here as a row with
 * the wrong number of columns.
 */
function splitRow(row) {
  const cells = [];
  let current = "";
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === "\\") {
      current += row[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current);
  return cells;
}

/** Every table in the markdown, as arrays of rows already split into cells. */
function tables(markdown) {
  const found = [];
  let current = null;
  for (const line of markdown.split("\n")) {
    const isRow = line.startsWith("|") && line.endsWith("|");
    if (!isRow) {
      if (current) found.push(current);
      current = null;
      continue;
    }
    current ??= [];
    current.push(splitRow(line));
  }
  if (current) found.push(current);
  return found;
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

test("publishes the complete classified admin family without claiming an unrun candidate pass", () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, ADMIN_FAMILY_PATH), "utf8"));
  const markdown = generateScorecardMarkdown(root);
  assert.equal(artifact.restOperationCount, 396);
  assert.equal(artifact.expectedPublishedTools, 385);
  assert.equal(artifact.expectedExcludedOperations, 11);
  assert.equal(artifact.defaultStaticToolCount, 47);
  assert.equal(artifact.expectedDefaultTotalTools, 432);
  assert.equal(artifact.expectedPublishedTools + artifact.expectedExcludedOperations, artifact.restOperationCount);
  assert.equal(artifact.defaultStaticToolCount + artifact.expectedPublishedTools, artifact.expectedDefaultTotalTools);
  assert.match(markdown, /## Admin operation family/);
  assert.match(markdown, /honua_admin_\*/);
  assert.match(markdown, /432 tools/);
  assert.match(markdown, /one-time-secret\/session operations are explicitly excluded/);
  assert.match(markdown, /compatible/);
  assert.match(markdown, /not a fabricated live pass receipt/);
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

// Grader violations, certification details, and surface URLs are rendered
// verbatim into markdown tables. Escaping them has to survive backslashes —
// the character that defeats a naive "escape the pipe" pass.
const HOSTILE = "broke | the\ntable \\| badly `tick` [link](x) \\\\ end";

function hostileArtifacts() {
  const evalReport = evalArtifact();
  evalReport.surface.remoteUrl = "https://evil.example/mcp?a=1|2\\3 (paren) [bracket]";
  evalReport.models.push({
    id: "vendor\\|model`v1`",
    vendor: "bed|rock\\",
    available: true,
    scenarios: 2,
    pass: 1,
    fail: 1,
    clarified: 0,
    error: 0,
    successRate: 0.5,
    clarificationRate: 0,
    editRate: 0.5,
    totalToolErrors: 1,
  });
  evalReport.results.push(
    {
      scenarioId: "operator-list-layers",
      modelId: "vendor\\|model`v1`",
      outcome: "pass",
      violations: [],
      toolsCalled: [],
      errorCount: 0,
      missingTools: [],
    },
    {
      scenarioId: "operator-dry-run",
      modelId: "vendor\\|model`v1`",
      outcome: "fail",
      violations: [HOSTILE],
      toolsCalled: ["a\\|b"],
      errorCount: 2,
      driverError: HOSTILE,
      missingTools: [],
    },
  );

  const certReport = {
    schemaVersion: 2,
    generatedAt: "2026-01-01T00:00:00.000Z",
    provenance: { suiteGitSha: "0123456789abcdef0123456789abcdef01234567", protocolVersion: "2025-06-18", authMode: "api-key" },
    protocol: { surface: "live | \\ surface", targetMode: "re|mote\\" },
    summary: {
      pass: false,
      toolsDiscovered: 1,
      toolsConformant: 1,
      toolsConformanceChecked: 1,
      contractsChecked: 1,
      contractsPassed: 0,
      contractsFailed: 1,
      contractsSkipped: 0,
      knownGaps: 1,
    },
    tools: [{ name: "honua_query_features" }],
    contracts: [{ contract: "error\\|shape", target: "honua_query_features", status: "failed", detail: HOSTILE }],
    knownGaps: [{ kind: "standard-tool", name: "edit_features", family: "Feature | editing\\", detail: HOSTILE }],
  };

  return { evalReport, certReport };
}

test("hostile artifact text cannot break a markdown table row", () => {
  const { evalReport, certReport } = hostileArtifacts();
  const projectRoot = withTempRuns([evalReport, certReport], ["eval (hostile)|1.json", "cert (hostile).json"]);
  const { evals, certifications } = loadMcpEvalRuns(projectRoot);
  const markdown = renderScorecardMarkdown(
    buildScorecardModel({ evals, certifications, scenarioIndex: loadScenarioIndex(root) }),
  );

  const rendered = tables(markdown);
  assert.ok(rendered.length >= 4, "expected the leaderboard, matrix, failure, certification and provenance tables");
  for (const table of rendered) {
    const width = table[0].length;
    for (const row of table) {
      assert.equal(row.length, width, `table row has ${row.length} cells, expected ${width}: ${JSON.stringify(row)}`);
    }
  }

  // The hostile text is published (not silently dropped) and stays on one line.
  const failureSection = markdown.slice(markdown.indexOf("## Every non-passing run"));
  assert.ok(failureSection.includes("broke \\| the table \\\\\\| badly"), "violation text should be escaped, not dropped");
  for (const line of markdown.split("\n")) {
    if (line.startsWith("|")) assert.ok(!/[\r\t]/.test(line), "table rows must not carry raw control characters");
  }
});

test("hostile artifact text cannot escape a code span or a link destination", () => {
  const { evalReport, certReport } = hostileArtifacts();
  const projectRoot = withTempRuns([evalReport, certReport], ["eval (hostile)|1.json", "cert (hostile).json"]);
  const { evals, certifications } = loadMcpEvalRuns(projectRoot);
  const markdown = renderScorecardMarkdown(
    buildScorecardModel({ evals, certifications, scenarioIndex: loadScenarioIndex(root) }),
  );

  // A value carrying a backtick or backslash must NOT be wrapped in a code span
  // (backslash escapes do not apply inside one, and the backtick would end it).
  assert.ok(!markdown.includes("`vendor\\|model`v1``"), "a backtick-bearing value must not be emitted as a code span");
  // Every code span opens and closes on the same line (fenced blocks excluded).
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    assert.equal((line.match(/`/g) ?? []).length % 2, 0, `unbalanced code-span backticks: ${line}`);
  }
  // Parentheses in a link destination are percent-encoded so they cannot end it.
  for (const [, destination] of markdown.matchAll(/\]\(([^)\s]*)\)/g)) {
    assert.ok(!destination.includes("("), `link destination must not contain a raw parenthesis: ${destination}`);
  }
  assert.ok(markdown.includes("%28hostile%29"), "a parenthesised artifact name should be percent-encoded");
});

test("the committed page matches the generator output", () => {
  const published = fs.readFileSync(path.join(root, OUTPUT_PATH), "utf8").replace(/\r\n/g, "\n");
  assert.equal(published, generateScorecardMarkdown(root), `${OUTPUT_PATH} is stale — run npm run docs:mcp-scorecard`);
});
