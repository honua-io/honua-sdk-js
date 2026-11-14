#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

import { loadCurrentPullRequestDisposition } from "./lib/github-pr-issue-disposition.mjs";
import { refreshReleaseWindows } from "./lib/refresh-release-window.mjs";
import { evaluateReleaseWindow } from "./lib/release-window.mjs";

async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const repository = process.env.GITHUB_REPOSITORY;
  let results;
  if (process.argv.includes("--refresh")) {
    results = await refreshReleaseWindows({ repository,
      pullRequestNumber: event.pull_request?.number ?? (Number(event.inputs?.pull_request_number) || undefined),
      detailsUrl: `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  } else {
    const current = await loadCurrentPullRequestDisposition({ repository,
      pullRequestNumber: event.pull_request?.number ?? Number(event.inputs?.pull_request_number) });
    results = [await evaluateReleaseWindow(current)];
  }
  const summary = results.map((result) => `${result.number ? `#${result.number}: ` : ""}${result.summary}`).join("\n\n");
  process.stdout.write(`${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (!process.argv.includes("--allow-held") && results.some((result) => !result.allowed)) process.exitCode = 1;
}

try { await main(); } catch (error) {
  process.stderr.write(`Release window validation failed: ${error.message}\n`);
  process.exitCode = 1;
}
