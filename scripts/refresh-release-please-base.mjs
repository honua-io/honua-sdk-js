#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { prepareReleasePleaseCandidates } from "./lib/release-please-candidates.mjs";
import { validateTrustedReleasePleaseWorkflowContext } from "./lib/release-please-disposition-check.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeResult(result, candidates) {
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
    lines.push(`Workspace dependency notes: ${result.workspaceNotes ?? "unchanged"}.`);
  } else {
    lines.push("No open exact Release Please pull request exists.");
  }
  const summary = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `release_pr_present=${present}\nrelease_head_sha=${result.headSha ?? ""}\nrefresh_status=${result.status}\ncandidates=${JSON.stringify(candidates)}\n`,
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
  const { legacy, candidates } = await prepareReleasePleaseCandidates({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    trustedPolicySha,
    releasePleasePullRequests: process.env.RELEASE_PLEASE_PRS ?? "[]",
  });
  writeResult(legacy, candidates);
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
