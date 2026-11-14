#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { prepareReleasePleaseRefresh } from "./lib/release-please-refresh-recovery.mjs";
import { prepareReleasePleaseCandidates } from "./lib/release-please-candidates.mjs";
import { validateTrustedReleasePleaseWorkflowContext } from "./lib/release-please-disposition-check.mjs";
import { renderReleasePleaseRefreshSummary } from "./lib/release-please-run-summary.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeResult(result, candidates, refreshedCandidates) {
  const present = result.status !== "not-found";
  const summary = renderReleasePleaseRefreshSummary({
    trustedPolicySha: result.trustedPolicySha,
    candidates,
    refreshedCandidates,
  });
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
  const result = await prepareReleasePleaseRefresh({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    trustedPolicySha,
    releasePleasePullRequests: process.env.RELEASE_PLEASE_PRS ?? "[]",
    retryAttempted: process.env.RELEASE_PLEASE_REFRESH_RETRY === "true",
  }, prepareReleasePleaseCandidates);
  if (result.recoveryRequired) {
    const summary = `## Trusted Release Please base refresh\n\n${result.reason}\nA single refresh-only retry on current trunk is required. No candidate is ready for CI from this run.\n`;
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "recovery_required=true\nrelease_pr_present=false\n");
    }
    return;
  }
  const { legacy, candidates, refreshedCandidates } = result;
  writeResult(legacy, candidates, refreshedCandidates);
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
