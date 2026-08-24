#!/usr/bin/env node

// `gh`-shaped shell for scripts/lib/ci-shadow-parity.mjs
// (honua-io/honua-sdk-js#1286 AC-7, AC-8, NFR-004).
//
//   collect --limit 60 --output docs/evidence/ci-shadow-parity.v1.json
//   report  --input docs/evidence/ci-shadow-parity.v1.json [--require-promotion-ready]
//
// `collect` needs an authenticated `gh` with `actions: read`; `report` is
// offline, so the committed observation set can be re-rendered and re-checked
// by anyone without credentials -- which is the point of committing it rather
// than quoting a number from a run log.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CI_SHADOW_PARITY_FORMAT,
  compareRuns,
  formatParityReport,
  PROMOTION_SAMPLE_THRESHOLD,
  summarizeParity,
} from "./lib/ci-shadow-parity.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORY = "honua-io/honua-sdk-js";
const DEFAULT_OUTPUT = "docs/evidence/ci-shadow-parity.v1.json";
const GRAPH_WORKFLOW = "sdk-verification.yml";
const AUTHORITATIVE_WORKFLOW = "ci.yml";
const MAX_LIMIT = 100;

function optionValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
}

function fetchRuns({ repository, workflow, event, limit }) {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      workflow,
      "--event",
      event,
      "--limit",
      String(limit),
      "--json",
      "databaseId,conclusion,createdAt,headSha",
    ]),
  );

  return runs.map((run) => {
    const jobs = JSON.parse(
      gh(["api", `repos/${repository}/actions/runs/${run.databaseId}/jobs?per_page=100`, "--jq", ".jobs"]),
    );
    return {
      runId: run.databaseId,
      conclusion: run.conclusion,
      createdAt: run.createdAt,
      headSha: run.headSha,
      jobs: jobs.map((job) => ({
        name: job.name,
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
      })),
    };
  });
}

/**
 * When the graph became a deployed workflow rather than a change under review:
 * the earliest run it ever had on the default branch. Resolved rather than
 * hard-coded, so a rollback-and-redeploy moves the window instead of silently
 * admitting runs from the previous incarnation.
 *
 * Fail closed: with no default-branch run there is no deployment instant, and a
 * document with an unknown observation window is worse than no document.
 */
function resolveDeploymentInstant({ repository, branch }) {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      GRAPH_WORKFLOW,
      "--event",
      "push",
      "--branch",
      branch,
      "--limit",
      String(MAX_LIMIT),
      "--json",
      "createdAt",
    ]),
  );
  const instants = runs.map((run) => Date.parse(run.createdAt)).filter(Number.isFinite);
  if (instants.length === 0) {
    throw new Error(
      `${GRAPH_WORKFLOW} has never run on ${branch}, so its deployment instant is unknown. ` +
        "Pass --since <ISO instant> to state the observation window explicitly.",
    );
  }
  return new Date(Math.min(...instants)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function collect(argv) {
  const repository = optionValue(argv, "--repo", DEFAULT_REPOSITORY);
  const event = optionValue(argv, "--event", "pull_request");
  const limit = Number.parseInt(optionValue(argv, "--limit", "60"), 10);
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const output = optionValue(argv, "--output", DEFAULT_OUTPUT);
  const branch = optionValue(argv, "--branch", "trunk");
  const observationWindowStart = optionValue(argv, "--since", undefined) ?? resolveDeploymentInstant({ repository, branch });

  const graphRuns = fetchRuns({ repository, workflow: GRAPH_WORKFLOW, event, limit });
  // The graph is newer than ci.yml, so the authoritative listing is windowed to
  // the graph's own history. Without this, every ci.yml run predating the graph
  // would join to nothing and be reported as `missing-graph-run` -- true, but
  // it is the absence of a workflow rather than a parity finding.
  const earliestGraphRun = graphRuns
    .map((run) => Date.parse(run.createdAt))
    .filter(Number.isFinite)
    .reduce((earliest, value) => Math.min(earliest, value), Number.POSITIVE_INFINITY);
  const authoritativeRuns = fetchRuns({
    repository,
    workflow: AUTHORITATIVE_WORKFLOW,
    event,
    limit,
  }).filter((run) => !Number.isFinite(earliestGraphRun) || Date.parse(run.createdAt) >= earliestGraphRun);

  const observations = compareRuns({ graphRuns, authoritativeRuns, observationWindowStart });
  const summary = summarizeParity(observations);
  const document = {
    format: CI_SHADOW_PARITY_FORMAT,
    repository,
    event,
    graphWorkflow: GRAPH_WORKFLOW,
    authoritativeWorkflow: AUTHORITATIVE_WORKFLOW,
    collectedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    observationWindowStart,
    threshold: PROMOTION_SAMPLE_THRESHOLD,
    summary,
    observations,
  };
  const absolute = path.resolve(PROJECT_ROOT, output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `observed ${observations.length} heads (${summary.comparable} comparable, ${summary.agreed} agreed, ` +
      `${summary.disagreed} disagreed) into ${output}; ` +
      `promotion ${summary.promotionReady ? "READY" : `not ready (${summary.agreed}/${summary.threshold})`}\n`,
  );
}

function report(argv) {
  const input = optionValue(argv, "--input", DEFAULT_OUTPUT);
  const document = JSON.parse(fs.readFileSync(path.resolve(PROJECT_ROOT, input), "utf8"));
  if (document.format !== CI_SHADOW_PARITY_FORMAT) {
    throw new Error(`Input is not a ${CI_SHADOW_PARITY_FORMAT} document`);
  }
  const summary = summarizeParity(document.observations, { threshold: document.threshold });
  process.stdout.write(
    formatParityReport(summary, {
      title: `${document.graphWorkflow} vs ${document.authoritativeWorkflow} (${document.event}, collected ${document.collectedAt})`,
    }),
  );
  // Opt-in gate. The default is a readout, because a shadow lane that is not
  // yet promotable is the expected state and must not fail anybody's build.
  if (argv.includes("--require-promotion-ready") && !summary.promotionReady) {
    process.stderr.write(
      `Promotion is not ready: ${summary.agreed}/${summary.threshold} agreeing heads, ` +
        `${summary.disagreed} disagreement(s).\n`,
    );
    process.exitCode = 1;
  }
}

function main(argv) {
  const command = argv[0] ?? "report";
  if (command === "collect") return collect(argv);
  if (command === "report") return report(argv);
  throw new Error("Usage: node scripts/ci-shadow-parity.mjs [collect|report] [options]");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
