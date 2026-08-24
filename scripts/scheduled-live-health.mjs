#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const DAY_MS = 24 * 60 * 60 * 1000;

export function classifyLane(lane, run, now = new Date()) {
  if (!run) return { status: "never-run", ageDays: null };
  const ageDays = (now.getTime() - Date.parse(run.created_at)) / DAY_MS;
  if (!isEligibleRun(lane, run)) {
    return { status: "ineligible-run", ageDays };
  }
  if (run.status !== "completed") return { status: "running", ageDays };
  if (run.conclusion !== "success") return { status: "failing", ageDays };
  if (ageDays > lane.maxAgeDays) return { status: "stale", ageDays };
  if (ageDays > lane.maxAgeDays - (lane.alertBeforeDays ?? 2)) return { status: "expiring", ageDays };
  return { status: "healthy", ageDays };
}

function isEligibleRun(lane, run) {
  if (!lane.eligibleEvents?.includes(run.event) || (lane.branch && run.head_branch !== lane.branch)) return false;
  if (run.event !== "workflow_dispatch" || lane.allowAnyWorkflowDispatch === true) return true;
  return lane.eligibleWorkflowDispatchRunIds?.includes(run.id) === true;
}

export async function buildScheduledLiveHealth(config, options = {}) {
  const now = options.now ?? new Date();
  const fetchRun = options.fetchRun ?? githubRunFetcher(config.repository, options.token);
  const lanes = [];
  for (const lane of config.lanes) {
    let run = null;
    let queryError = null;
    try {
      run = await fetchRun(lane);
    } catch (error) {
      queryError = error instanceof Error ? error.message : String(error);
    }
    if (queryError) {
      lanes.push({
        ...lane,
        status: "query-error",
        ageDays: null,
        lastRun: null,
        triage: null,
        queryError,
      });
      continue;
    }
    const state = classifyLane(lane, run, now);
    lanes.push({
      ...lane,
      ...state,
      lastRun: run
        ? {
            id: run.id,
            event: run.event,
            status: run.status,
            conclusion: run.conclusion || null,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            headSha: run.head_sha,
            url: run.html_url,
          }
        : null,
      triage: run && lane.triage?.runId === run.id ? lane.triage : null,
    });
  }
  const requiredFailures = lanes.filter((lane) => lane.required && lane.status !== "healthy").map((lane) => lane.id);
  return {
    schema: "honua.sdk-js-scheduled-live-health/v1",
    repository: config.repository,
    generatedAt: now.toISOString(),
    aggregate: requiredFailures.length === 0 ? "healthy" : "failing",
    requiredFailures,
    lanes,
  };
}

function githubRunFetcher(repository, token) {
  return async (lane) => {
    if (!Array.isArray(lane.eligibleEvents) || lane.eligibleEvents.length === 0) {
      throw new Error(`Lane ${lane.id} has no eligibleEvents contract`);
    }
    const runs = await Promise.all(lane.eligibleEvents.map(async (event) => {
      const query = new URLSearchParams({ per_page: event === "workflow_dispatch" ? "100" : "1", event });
      if (lane.branch) query.set("branch", lane.branch);
      const response = await fetch(
        `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(lane.workflow)}/runs?${query}`,
        { headers: { accept: "application/vnd.github+json", "user-agent": "honua-sdk-live-health", ...(token ? { authorization: `Bearer ${token}` } : {}) } },
      );
      if (!response.ok) throw new Error(`GitHub runs query failed for ${lane.workflow} (${event}): HTTP ${response.status}`);
      const payload = await response.json();
      return payload.workflow_runs?.find((run) => isEligibleRun(lane, run)) ?? null;
    }));
    return runs.filter(Boolean).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0] ?? null;
  };
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (key === "--strict") continue;
    if (key !== "--config" && key !== "--output") throw new Error(`unknown argument: ${key}`);
    const value = process.argv[index + 1];
    if (!value) throw new Error(`${key} requires a value`);
    args.set(key, value);
    index += 1;
  }
  const configPath = args.get("--config") ?? "config/scheduled-live-lanes.v1.json";
  const output = args.get("--output") ?? "test-results/scheduled-live-health.v1.json";
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const projection = await buildScheduledLiveHealth(config, { token: process.env.GITHUB_TOKEN });
  await writeFile(output, `${JSON.stringify(projection, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ aggregate: projection.aggregate, requiredFailures: projection.requiredFailures })}\n`);
  if (process.argv.includes("--strict") && projection.aggregate !== "healthy") process.exitCode = 1;
}

if (process.argv[1]?.endsWith("scheduled-live-health.mjs")) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
