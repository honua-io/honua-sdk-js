/**
 * Scorecard assembly + rendering for the coding-agent eval harness (REQ-004).
 *
 * The JSON scorecard is the machine-readable artifact (validated against
 * `eval/coding-agents/scorecard.schema.json`); the Markdown rendering is the
 * human-readable one, and `publishScorecard` maintains the committed,
 * history-friendly page under `docs/generated/coding-agent-scorecard.md`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SCORECARD_SCHEMA_VERSION = 1;
export const PUBLISHED_SCORECARD_PATH = path.join("docs", "generated", "coding-agent-scorecard.md");

const HISTORY_BEGIN = "<!-- history:begin -->";
const HISTORY_END = "<!-- history:end -->";

function resolveGitSha(repoRoot, env = process.env) {
  if (env.GITHUB_SHA) return { sha: env.GITHUB_SHA, source: "env" };
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return { sha, source: "git" };
  } catch {
    return { sha: "unknown", source: "unknown" };
  }
}

/** Assemble the machine-readable scorecard from a lane run. */
export function buildScorecard({ repoRoot, lane, laneResult, generatedAt = new Date().toISOString() }) {
  const scored = laneResult.tasks.filter((task) => !task.skipped);
  const passed = scored.filter((task) => task.pass).length;
  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    generatedAt,
    repo: resolveGitSha(repoRoot),
    lane,
    adapter: laneResult.adapter,
    summary: {
      tasks: scored.length,
      skipped: laneResult.tasks.length - scored.length,
      passed,
      failed: scored.length - passed,
      passRate: scored.length === 0 ? 0 : Number((passed / scored.length).toFixed(4)),
    },
    tasks: laneResult.tasks,
  };
}

function stageOf(task) {
  if (task.skipped) return "skipped";
  if (task.generation?.status === "error") return "generation";
  if (!task.typecheck?.pass) return "typecheck";
  if (!task.runtime?.pass) return "runtime";
  if (!task.assertions?.pass) return "assertions";
  return "pass";
}

/** Render a scorecard as Markdown. */
export function renderScorecardMarkdown(scorecard) {
  const lines = [];
  lines.push(`## ${scorecard.lane} — ${scorecard.adapter.name}${scorecard.adapter.variant ? ` (${scorecard.adapter.variant})` : ""}`);
  lines.push("");
  lines.push(`- Generated: ${scorecard.generatedAt}`);
  lines.push(`- Commit: \`${scorecard.repo.sha}\``);
  lines.push(`- Model: \`${scorecard.adapter.model}\` (version: \`${scorecard.adapter.version}\`)`);
  lines.push(
    `- Result: **${scorecard.summary.passed}/${scorecard.summary.tasks} passed** (${(scorecard.summary.passRate * 100).toFixed(1)}%)${scorecard.summary.skipped > 0 ? `, ${scorecard.summary.skipped} skipped` : ""}`,
  );
  lines.push("");
  lines.push("| Task | Category | Typecheck | Runtime | Assertions | Result |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const task of scorecard.tasks) {
    if (task.skipped) {
      lines.push(`| ${task.id} | ${task.category} | — | — | — | skipped |`);
      continue;
    }
    const mark = (stage) => (stage?.pass ? "pass" : "fail");
    const result = task.pass ? "PASS" : `FAIL (${stageOf(task)})`;
    lines.push(
      `| ${task.id} | ${task.category} | ${mark(task.typecheck)} | ${mark(task.runtime)} | ${mark(task.assertions)} | ${result} |`,
    );
  }
  const failures = scorecard.tasks.filter((task) => !task.skipped && !task.pass);
  if (failures.length > 0) {
    lines.push("");
    lines.push("### Failure detail");
    lines.push("");
    for (const task of failures) {
      const detail =
        task.generation?.status === "error"
          ? task.generation.detail
          : !task.typecheck.pass
            ? task.typecheck.errors.slice(0, 3).join("; ")
            : !task.runtime.pass
              ? (task.runtime.detail ?? `exit ${task.runtime.exitCode}`)
              : task.assertions.checks
                  .filter((check) => !check.pass)
                  .map((check) => `${check.path} ${check.op} ${JSON.stringify(check.expected)} but got ${JSON.stringify(check.actual)}`)
                  .join("; ");
      lines.push(`- **${task.id}** failed at ${stageOf(task)}: ${detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function historyRow(scorecard) {
  const adapter = `${scorecard.adapter.name}${scorecard.adapter.variant ? `/${scorecard.adapter.variant}` : ""}`;
  return `| ${scorecard.generatedAt.slice(0, 10)} | ${adapter} | \`${scorecard.adapter.model}\` | ${scorecard.summary.tasks} | ${scorecard.summary.passed} | ${(scorecard.summary.passRate * 100).toFixed(1)}% | \`${scorecard.repo.sha.slice(0, 12)}\` |`;
}

/**
 * Write/refresh the committed scorecard page: latest-run section is replaced,
 * the history table gains one row per published run (newest first).
 */
export function publishScorecard({ repoRoot, scorecards }) {
  const target = path.join(repoRoot, PUBLISHED_SCORECARD_PATH);
  let previousRows = [];
  if (existsSync(target)) {
    const current = readFileSync(target, "utf8");
    const begin = current.indexOf(HISTORY_BEGIN);
    const end = current.indexOf(HISTORY_END);
    if (begin !== -1 && end !== -1) {
      previousRows = current
        .slice(begin + HISTORY_BEGIN.length, end)
        .split(/\r?\n/)
        .filter((line) => line.startsWith("| ") && !line.startsWith("| Date") && !line.startsWith("| ---"));
    }
  }
  const newRows = scorecards.map(historyRow);
  const rows = [...newRows, ...previousRows].slice(0, 100);
  const content = [
    "# Coding-agent evaluation scorecard",
    "",
    "Generated by `node scripts/eval-coding-agents.mjs --publish`. Do not edit by hand.",
    "Methodology: [docs/coding-agent-evals.md](../coding-agent-evals.md).",
    "",
    ...scorecards.map((scorecard) => renderScorecardMarkdown(scorecard)),
    "## History",
    "",
    HISTORY_BEGIN,
    "| Date | Adapter | Model | Tasks | Passed | Pass rate | Commit |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    HISTORY_END,
    "",
  ].join("\n");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}
