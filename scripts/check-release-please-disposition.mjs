#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import {
  publishReleasePleaseDispositionCheck,
  validateTrustedReleasePleaseWorkflowContext,
} from "./lib/release-please-disposition-check.mjs";
import { renderReleasePleaseDispositionSummary } from "./lib/release-please-run-summary.mjs";

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
  const summary = renderReleasePleaseDispositionSummary(result);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
}

async function main() {
  const { trustedPolicySha } = validateTrustedReleasePleaseWorkflowContext({
    eventName: requiredEnvironment("GITHUB_EVENT_NAME"),
    ref: requiredEnvironment("GITHUB_REF"),
    trustedPolicySha: requiredEnvironment("TRUSTED_POLICY_SHA"),
    githubSha: requiredEnvironment("GITHUB_SHA"),
  });
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
