#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { dispatchReleasePleaseCi } from "./lib/release-please-ci-dispatch.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function appendSummary(lines) {
  const summary = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
}

function writeSuccess(result) {
  appendSummary([
    "## Trusted Release Please canonical CI",
    "",
    result.status === "already-dispatched"
      ? "The exact current release head already has a confirmed canonical CI dispatch."
      : "Canonical CI was dispatched and confirmed for the exact current release head.",
    `Pull request: ${result.repository}#${result.pullRequestNumber}.`,
    `Release head: ${result.headSha}.`,
    `Trusted trunk policy revision: ${result.trustedPolicySha}.`,
    `Workflow run: [${result.workflowRunId}](${result.workflowRunUrl}).`,
  ]);
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/trunk") {
    throw new Error("Trusted Release Please CI dispatch may run only for a trunk push.");
  }
  if (requiredEnvironment("RELEASE_PLEASE_PRS_CREATED") !== "true") {
    throw new Error("Release Please did not report a created or updated pull request.");
  }
  const trustedPolicySha = requiredEnvironment("TRUSTED_POLICY_SHA");
  if (trustedPolicySha !== requiredEnvironment("GITHUB_SHA")) {
    throw new Error("The checked-out trusted policy must match the triggering trunk revision.");
  }

  const result = await dispatchReleasePleaseCi({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    trustedPolicySha,
  });
  writeSuccess(result);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Trusted Release Please CI dispatch failed: ${message}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Trusted Release Please canonical CI\n\nFailed: ${message}\n`,
    );
  }
  process.exitCode = 1;
}
