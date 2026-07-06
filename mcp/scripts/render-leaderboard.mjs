#!/usr/bin/env node
// Render the Honua MCP evals leaderboard (Markdown + static HTML) from the
// committed run artifacts under mcp/evals/runs/. Pure Node, no dependencies — so
// it runs identically on a dev box and in the leaderboard-commit CI job.
//
// Each artifact is a certification report (schemaVersion 2, has `contracts`) or a
// cross-model eval report (schemaVersion 4, has `models` + `results`). The
// generator classifies them, then emits:
//   - a model × corpus × pass-rate leaderboard,
//   - a per-scenario breakdown matrix per corpus,
//   - a certification-runs table,
// into mcp/evals/LEADERBOARD.md and mcp/evals/leaderboard.html.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so tests can render from a fixture corpus into a temp dir without
// touching the committed leaderboard. Defaults to the committed evals/ tree.
const EVALS_DIR = process.env.HONUA_LEADERBOARD_OUT_DIR
  ? resolve(process.env.HONUA_LEADERBOARD_OUT_DIR)
  : resolve(HERE, "..", "evals");
const RUNS_DIR = process.env.HONUA_LEADERBOARD_RUNS_DIR
  ? resolve(process.env.HONUA_LEADERBOARD_RUNS_DIR)
  : join(EVALS_DIR, "runs");

function walkJson(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkJson(full));
    } else if (entry.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

function classify(report) {
  if (Array.isArray(report?.models) && Array.isArray(report?.results)) return "eval";
  if (Array.isArray(report?.contracts) && Array.isArray(report?.tools)) return "cert";
  return "unknown";
}

/** Infer a human corpus name from the scenario id prefixes. */
function inferCorpus(ids) {
  if (ids.length === 0) return "unknown";
  if (ids.every((id) => id.startsWith("operator-"))) return "operator";
  if (ids.every((id) => id.startsWith("northstar-"))) return "northstar";
  if (ids.some((id) => id.startsWith("operator-")) || ids.some((id) => id.startsWith("northstar-"))) return "mixed";
  return "analyst";
}

function dateOf(report) {
  const ts = report?.provenance?.generatedAt ?? report?.generatedAt;
  return typeof ts === "string" ? ts.slice(0, 10) : "unknown";
}

function suiteSha(report) {
  const sha = report?.provenance?.suiteGitSha;
  return typeof sha === "string" && sha !== "unknown" ? sha.slice(0, 10) : "—";
}

function pct(n) {
  return `${Math.round((n ?? 0) * 100)}%`;
}

function outcomeIcon(outcome) {
  switch (outcome) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "clarified":
      return "❓";
    case "error":
      return "⚠️";
    default:
      return "·";
  }
}

// ── Load + partition ─────────────────────────────────────────────────────────

const files = walkJson(RUNS_DIR).sort();
const evals = [];
const certs = [];
for (const file of files) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  const kind = classify(report);
  if (kind === "eval") evals.push({ file, report });
  else if (kind === "cert") certs.push({ file, report });
}

// ── Leaderboard rows: one per (corpus, model), dedup control ─────────────────

const leaderboardRows = [];
const seen = new Set();
for (const { report } of evals) {
  const corpus = inferCorpus(report.corpus?.ids ?? []);
  const surface = report.surface?.remoteUrl ?? report.surface?.backend ?? "unknown";
  for (const m of report.models ?? []) {
    const key = `${corpus}::${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leaderboardRows.push({
      model: m.id,
      vendor: m.vendor,
      corpus,
      surface,
      successRate: m.successRate ?? (m.scenarios ? m.pass / m.scenarios : 0),
      pass: m.pass,
      scenarios: m.scenarios,
      clarify: m.clarificationRate ?? 0,
      edit: m.editRate ?? 0,
      date: dateOf(report),
      sha: suiteSha(report),
      control: m.vendor === "deterministic",
    });
  }
}
leaderboardRows.sort((a, b) => {
  if (a.corpus !== b.corpus) return a.corpus.localeCompare(b.corpus);
  if (a.control !== b.control) return a.control ? -1 : 1;
  return b.successRate - a.successRate;
});

// ── Per-scenario breakdown, merged per corpus ────────────────────────────────

const perCorpus = new Map(); // corpus -> { surface, date, scenarios:Set, cells: Map<scenario, Map<model, outcome>>, models:Set }
for (const { report } of evals) {
  const corpus = inferCorpus(report.corpus?.ids ?? []);
  if (!perCorpus.has(corpus)) {
    perCorpus.set(corpus, {
      surface: report.surface?.remoteUrl ?? report.surface?.backend ?? "unknown",
      date: dateOf(report),
      scenarios: new Set(report.corpus?.ids ?? []),
      cells: new Map(),
      models: new Set(),
    });
  }
  const group = perCorpus.get(corpus);
  for (const id of report.corpus?.ids ?? []) group.scenarios.add(id);
  for (const r of report.results ?? []) {
    group.models.add(r.modelId);
    if (!group.cells.has(r.scenarioId)) group.cells.set(r.scenarioId, new Map());
    group.cells.get(r.scenarioId).set(r.modelId, r.outcome);
  }
}

function orderModels(models) {
  return [...models].sort((a, b) => {
    if (a === "deterministic") return -1;
    if (b === "deterministic") return 1;
    return a.localeCompare(b);
  });
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function renderMarkdown() {
  const lines = [];
  lines.push("# Honua MCP Evals — Leaderboard");
  lines.push("");
  lines.push(
    `_Generated ${new Date().toISOString()} from ${evals.length} eval + ${certs.length} certification run artifact(s) in [\`runs/\`](./runs)._`,
  );
  lines.push("");
  lines.push(
    "Every row is reproducible: each source artifact records its target surface, negotiated protocol version, tool count, auth mode, and the git SHA of the suite that produced it. All model calls run through AWS Bedrock; the deterministic control makes no model calls and is the CI gate.",
  );
  lines.push("");

  lines.push("## Cross-model leaderboard");
  lines.push("");
  if (leaderboardRows.length === 0) {
    lines.push("_No eval runs recorded yet._");
  } else {
    lines.push("| Model | Vendor | Corpus | Surface | Pass rate | Passed | Clarify | Edit | Date | Suite SHA |");
    lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |");
    for (const r of leaderboardRows) {
      const model = r.control ? `${r.model} _(control)_` : r.model;
      lines.push(
        `| \`${model}\` | ${r.vendor} | ${r.corpus} | ${r.surface} | ${pct(r.successRate)} | ${r.pass}/${r.scenarios} | ${pct(r.clarify)} | ${pct(r.edit)} | ${r.date} | \`${r.sha}\` |`,
      );
    }
  }
  lines.push("");

  lines.push("## Per-scenario breakdown");
  lines.push("");
  lines.push("Legend: ✅ pass · ❌ fail · ❓ clarified · ⚠️ error · · not run");
  lines.push("");
  for (const [corpus, group] of [...perCorpus.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const models = orderModels(group.models);
    lines.push(`### ${corpus} — ${group.date} (${group.surface})`);
    lines.push("");
    lines.push(`| Scenario | ${models.join(" | ")} |`);
    lines.push(`| --- | ${models.map(() => ":--:").join(" | ")} |`);
    for (const scenario of [...group.scenarios].sort()) {
      const cells = models.map((m) => outcomeIcon(group.cells.get(scenario)?.get(m)));
      lines.push(`| \`${scenario}\` | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  if (certs.length > 0) {
    lines.push("## Certification runs");
    lines.push("");
    lines.push("| Surface | Mode | Tools | Conformant | Contracts | Skipped | Result | Date | Suite SHA |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | :---: | --- | --- |");
    for (const { report } of certs) {
      const s = report.summary ?? {};
      const result = s.pass ? "✅ pass" : "❌ fail";
      lines.push(
        `| ${report.protocol?.surface ?? "unknown"} | \`${report.protocol?.targetMode ?? "?"}\` | ${s.toolsDiscovered ?? "?"} | ${s.toolsConformant ?? "?"}/${s.toolsConformanceChecked ?? "?"} | ${s.contractsPassed ?? "?"}/${s.contractsChecked ?? "?"} | ${s.contractsSkipped ?? 0} | ${result} | ${dateOf(report)} | \`${suiteSha(report)}\` |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

// ── Static HTML (self-contained, theme-aware) ────────────────────────────────

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function renderHtml() {
  const lbHead = ["Model", "Vendor", "Corpus", "Surface", "Pass rate", "Passed", "Clarify", "Edit", "Date", "Suite SHA"];
  const lbRows = leaderboardRows
    .map((r) => {
      const cls = r.control ? ' class="control"' : "";
      return `<tr${cls}><td><code>${esc(r.model)}${r.control ? " (control)" : ""}</code></td><td>${esc(r.vendor)}</td><td>${esc(r.corpus)}</td><td>${esc(r.surface)}</td><td class="num">${pct(r.successRate)}</td><td class="num">${r.pass}/${r.scenarios}</td><td class="num">${pct(r.clarify)}</td><td class="num">${pct(r.edit)}</td><td>${esc(r.date)}</td><td><code>${esc(r.sha)}</code></td></tr>`;
    })
    .join("\n");

  const breakdowns = [...perCorpus.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([corpus, group]) => {
      const models = orderModels(group.models);
      const head = `<tr><th>Scenario</th>${models.map((m) => `<th>${esc(m)}</th>`).join("")}</tr>`;
      const rows = [...group.scenarios]
        .sort()
        .map(
          (scenario) =>
            `<tr><td><code>${esc(scenario)}</code></td>${models
              .map((m) => `<td class="icon">${outcomeIcon(group.cells.get(scenario)?.get(m))}</td>`)
              .join("")}</tr>`,
        )
        .join("\n");
      return `<h3>${esc(corpus)} — ${esc(group.date)} <span class="muted">(${esc(group.surface)})</span></h3><div class="scroll"><table>${head}${rows}</table></div>`;
    })
    .join("\n");

  const certHead = ["Surface", "Mode", "Tools", "Conformant", "Contracts", "Skipped", "Result", "Date", "Suite SHA"];
  const certRows = certs
    .map(({ report }) => {
      const s = report.summary ?? {};
      return `<tr><td>${esc(report.protocol?.surface ?? "unknown")}</td><td><code>${esc(report.protocol?.targetMode ?? "?")}</code></td><td class="num">${s.toolsDiscovered ?? "?"}</td><td class="num">${s.toolsConformant ?? "?"}/${s.toolsConformanceChecked ?? "?"}</td><td class="num">${s.contractsPassed ?? "?"}/${s.contractsChecked ?? "?"}</td><td class="num">${s.contractsSkipped ?? 0}</td><td>${s.pass ? "✅ pass" : "❌ fail"}</td><td>${esc(dateOf(report))}</td><td><code>${esc(suiteSha(report))}</code></td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Honua MCP Evals — Leaderboard</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --head:#f5f5f5; --ctrl:#eef6ff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2a2d34; --head:#171a21; --ctrl:#12233a; } }
  body { background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; margin:0; padding:2rem 1.25rem; max-width:1100px; margin-inline:auto; }
  h1 { font-size:1.7rem; margin:0 0 .25rem; } h2 { margin-top:2rem; } h3 { margin-top:1.5rem; font-size:1.05rem; }
  .muted { color:var(--muted); font-weight:400; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; margin:.5rem 0 1rem; font-size:.92rem; }
  th, td { border:1px solid var(--line); padding:.4rem .6rem; text-align:left; white-space:nowrap; }
  th { background:var(--head); }
  td.num, td.icon { text-align:center; }
  tr.control td { background:var(--ctrl); }
  code { font-family:ui-monospace, monospace; font-size:.88em; }
  .gen { color:var(--muted); font-size:.85rem; }
</style>
</head>
<body>
<h1>Honua MCP Evals — Leaderboard</h1>
<p class="gen">Generated ${esc(new Date().toISOString())} from ${evals.length} eval + ${certs.length} certification run artifact(s). Every row is reproducible from its source artifact (target, protocol version, tool count, auth mode, suite git SHA). All model calls run through AWS Bedrock.</p>
<h2>Cross-model leaderboard</h2>
<div class="scroll"><table><tr>${lbHead.map((h) => `<th>${h}</th>`).join("")}</tr>
${lbRows || `<tr><td colspan="${lbHead.length}">No eval runs recorded yet.</td></tr>`}</table></div>
<h2>Per-scenario breakdown</h2>
<p class="muted">✅ pass · ❌ fail · ❓ clarified · ⚠️ error · · not run</p>
${breakdowns || "<p class=\"muted\">None.</p>"}
${certs.length > 0 ? `<h2>Certification runs</h2><div class="scroll"><table><tr>${certHead.map((h) => `<th>${h}</th>`).join("")}</tr>${certRows}</table></div>` : ""}
</body>
</html>
`;
}

const mdPath = join(EVALS_DIR, "LEADERBOARD.md");
const htmlPath = join(EVALS_DIR, "leaderboard.html");
writeFileSync(mdPath, renderMarkdown(), "utf8");
writeFileSync(htmlPath, renderHtml(), "utf8");
process.stdout.write(
  `Leaderboard rendered from ${evals.length} eval + ${certs.length} cert run(s):\n  ${mdPath}\n  ${htmlPath}\n`,
);
