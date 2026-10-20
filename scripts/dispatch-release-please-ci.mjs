#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { dispatchReleasePleaseCi } from "./lib/release-please-ci-dispatch.mjs";
import { validateTrustedReleasePleaseWorkflowContext } from "./lib/release-please-disposition-check.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeSummary(result) {
  const lines = [
    "## Trusted Release Please canonical CI",
    "",
    result.status === "already-dispatched"
      ? "Canonical CI already exists for the exact current release head."
      : "Canonical CI was dispatched for the exact current release head; completion resumes through workflow_run.",
    `Pull request: ${result.repository}#${result.pullRequestNumber}.`,
    `Release head: ${result.headSha}.`,
    `Trusted trunk policy revision: ${result.trustedPolicySha}.`,
    `Workflow run: [${result.workflowRunId}](${result.workflowRunUrl}).`,
  ];
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `canonical_ci_success=${result.workflowRunConclusion === "success"}\n`);
  }
  const summary = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
}

async function main() {
  if (requiredEnvironment("RELEASE_PLEASE_PR_READY") !== "true") {
    throw new Error("The trusted base-refresh job did not expose an exact current Release Please pull request.");
  }
  const { trustedPolicySha } = validateTrustedReleasePleaseWorkflowContext({
    eventName: requiredEnvironment("GITHUB_EVENT_NAME"),
    ref: requiredEnvironment("GITHUB_REF"),
    trustedPolicySha: requiredEnvironment("TRUSTED_POLICY_SHA"),
    githubSha: requiredEnvironment("GITHUB_SHA"),
  });
  writeSummary(
    await dispatchReleasePleaseCi({
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      trustedPolicySha,
      waitForCompletion: false,
    }),
  );
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
