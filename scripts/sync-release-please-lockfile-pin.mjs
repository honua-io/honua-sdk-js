#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { syncReleasePleaseLockfilePin } from "./lib/release-please-lockfile-pin.mjs";
import { validateTrustedReleasePleaseWorkflowContext } from "./lib/release-please-disposition-check.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeResult(result) {
  const lines = ["## Trusted Release Please lockfile digest pin", "", `Status: ${result.status}.`];
  if (result.status === "not-found") {
    lines.push("No open exact Release Please pull request exists.");
  } else {
    lines.push(`Pull request: ${result.repository}#${result.pullRequestNumber}.`);
    lines.push(`Release version bump: ${result.baseVersion} to ${result.headVersion}.`);
    lines.push(`Pinned \`package-lock.json\` digest: \`${result.lockfileSha256}\`.`);
    lines.push(`Previous release head: ${result.previousHeadSha}.`);
    lines.push(`Exact current release head: ${result.headSha}.`);
  }
  const summary = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `pin_status=${result.status}\nrelease_head_sha=${result.headSha ?? ""}\nlockfile_sha256=${result.lockfileSha256 ?? ""}\n`,
    );
  }
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
  writeResult(
    await syncReleasePleaseLockfilePin({
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      trustedPolicySha,
    }),
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Trusted Release Please lockfile digest pin failed: ${message}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Trusted Release Please lockfile digest pin\n\nFailed: ${message}\n`,
    );
  }
  process.exitCode = 1;
}
