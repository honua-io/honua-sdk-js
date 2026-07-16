#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { publishReleasePleaseDispositionCheck } from "./lib/release-please-disposition-check.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function workflowRunUrl() {
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const runId = process.env.GITHUB_RUN_ID;
  return runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : undefined;
}

function writeSummary(result) {
  const lines = ["## Trusted Release Please issue disposition", ""];
  if (result.status === "not-found") {
    lines.push("No open Release Please pull request exists; no disposition check was emitted.");
  } else {
    lines.push(`Exempt: ${result.exemption}.`);
    lines.push(`Validated ${result.repository}#${result.pullRequestNumber} at ${result.headSha}.`);
    lines.push(`Created source-bound check run ${result.checkRunId}.`);
  }
  lines.push(`Trusted trunk policy revision: ${result.trustedPolicySha}.`);
  const summary = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/trunk") {
    throw new Error("Trusted Release Please disposition checks may run only for a trunk push.");
  }
  const trustedPolicySha = requiredEnvironment("TRUSTED_POLICY_SHA");
  if (trustedPolicySha !== requiredEnvironment("GITHUB_SHA")) {
    throw new Error("The checked-out trusted policy must match the triggering trunk revision.");
  }
  const result = await publishReleasePleaseDispositionCheck({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    trustedPolicySha,
    detailsUrl: workflowRunUrl(),
  });
  writeSummary(result);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Trusted Release Please disposition failed: ${message}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Trusted Release Please issue disposition\n\nFailed: ${message}\n`,
    );
  }
  process.exitCode = 1;
}
