#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { refreshReleasePleaseBase } from "./lib/release-please-base-refresh.mjs";
import { validateTrustedReleasePleaseWorkflowContext } from "./lib/release-please-disposition-check.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function exactBooleanEnvironment(name) {
  const value = requiredEnvironment(name);
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return value === "true";
}

function writeResult(result) {
  const present = result.status !== "not-found";
  const lines = [
    "## Trusted Release Please base refresh",
    "",
    `Status: ${result.status}.`,
    `Trusted trunk policy revision: ${result.trustedPolicySha}.`,
  ];
  if (present) {
    lines.push(`Pull request: ${result.repository}#${result.pullRequestNumber}.`);
    lines.push(`Exact current release head: ${result.headSha}.`);
  } else {
    lines.push("No open exact Release Please pull request exists.");
  }
  const summary = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `release_pr_present=${present}\nrelease_head_sha=${result.headSha ?? ""}\nrefresh_status=${result.status}\n`,
    );
  }
  process.stdout.write(summary);
}

async function main() {
  const { trustedPolicySha } = validateTrustedReleasePleaseWorkflowContext({
    eventName: requiredEnvironment("GITHUB_EVENT_NAME"),
    ref: requiredEnvironment("GITHUB_REF"),
    trustedPolicySha: requiredEnvironment("TRUSTED_POLICY_SHA"),
    githubSha: requiredEnvironment("GITHUB_SHA"),
  });
  writeResult(
    await refreshReleasePleaseBase({
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      trustedPolicySha,
      releasePleaseReportedUpdate: exactBooleanEnvironment("RELEASE_PLEASE_PRS_CREATED"),
    }),
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Trusted Release Please base refresh failed: ${message}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Trusted Release Please base refresh\n\nFailed: ${message}\n`);
  }
  process.exitCode = 1;
}
