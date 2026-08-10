#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { publishReleasePleaseCiChecks } from "./lib/release-please-ci-checks.mjs";
import { validateTrustedReleasePleaseWorkflowContext } from "./lib/release-please-disposition-check.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeSummary(result) {
  const lines = [
    "## Trusted Release Please required checks",
    "",
    `Published ${result.checks.map((check) => `\`${check.name}\``).join(" and ")} for ${result.repository}#${result.pullRequestNumber}.`,
    `Release head: ${result.headSha}.`,
    `Trusted trunk policy revision: ${result.trustedPolicySha}.`,
    `Canonical workflow run: [${result.workflowRunId}](${result.workflowRunUrl}).`,
  ];
  const summary = `${lines.join("\n")}\n`;
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
  writeSummary(
    await publishReleasePleaseCiChecks({
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      trustedPolicySha,
    }),
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Trusted Release Please check publication failed: ${message}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Trusted Release Please required checks\n\nFailed: ${message}\n`,
    );
  }
  process.exitCode = 1;
}
