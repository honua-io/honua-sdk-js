#!/usr/bin/env node

// `gh`-shaped shell for scripts/lib/ci-timing-baseline.mjs
// (honua-io/honua-sdk-js#1286 AC-1 and AC-8).
//
//   collect --workflow ci.yml --limit 40 --output docs/evidence/ci-timing-baseline.v1.json
//   report  --input docs/evidence/ci-timing-baseline.v1.json
//
// `collect` needs an authenticated `gh`; `report` is offline, so the committed
// baseline can be re-rendered and re-checked by anyone without credentials.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatBaselineReport, summarizeRuns } from "./lib/ci-timing-baseline.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORY = "honua-io/honua-sdk-js";
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

function collect(argv) {
  const repository = optionValue(argv, "--repo", DEFAULT_REPOSITORY);
  const workflow = optionValue(argv, "--workflow", "ci.yml");
  const event = optionValue(argv, "--event", "pull_request");
  const limit = Number.parseInt(optionValue(argv, "--limit", "40"), 10);
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const output = optionValue(argv, "--output", "docs/evidence/ci-timing-baseline.v1.json");

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

  const collected = [];
  for (const run of runs) {
    if (!["success", "failure"].includes(run.conclusion)) continue;
    const jobs = JSON.parse(
      gh(["api", `repos/${repository}/actions/runs/${run.databaseId}/jobs?per_page=100`, "--jq", ".jobs"]),
    );
    collected.push({
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
    });
  }

  const summary = summarizeRuns(collected);
  const document = {
    format: "honua.ci-timing-baseline.v1",
    repository,
    workflow,
    event,
    collectedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    summary: { ...summary, runs: undefined },
    runs: collected,
  };
  const absolute = path.resolve(PROJECT_ROOT, output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `collected ${collected.length} terminal runs of ${workflow} (${event}) into ${output}; ` +
      `wall p50=${summary.wallClock.p50?.toFixed(1)}m p90=${summary.wallClock.p90?.toFixed(1)}m, ` +
      `billed p50=${summary.billed.p50?.toFixed(1)}m\n`,
  );
}

function report(argv) {
  const input = optionValue(argv, "--input", "docs/evidence/ci-timing-baseline.v1.json");
  const document = JSON.parse(fs.readFileSync(path.resolve(PROJECT_ROOT, input), "utf8"));
  if (document.format !== "honua.ci-timing-baseline.v1") {
    throw new Error("Input is not a honua.ci-timing-baseline.v1 document");
  }
  process.stdout.write(
    formatBaselineReport(summarizeRuns(document.runs), {
      title: `${document.workflow} baseline (${document.event}, collected ${document.collectedAt})`,
    }),
  );
}

function main(argv) {
  const command = argv[0] ?? "report";
  if (command === "collect") return collect(argv);
  if (command === "report") return report(argv);
  throw new Error("Usage: node scripts/ci-timing-baseline.mjs [collect|report] [--repo|--workflow|--event|--limit|--output|--input <value>]");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
