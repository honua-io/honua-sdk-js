#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

import { loadCurrentPullRequestDisposition } from "./lib/github-pr-issue-disposition.mjs";
import { refreshReleaseWindows } from "./lib/refresh-release-window.mjs";
import { evaluateReleaseWindow, releaseWindowRunFails, targetPullRequestNumber } from "./lib/release-window.mjs";

async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const repository = process.env.GITHUB_REPOSITORY;
  const refresh = process.argv.includes("--refresh");
  const pullRequestNumber = targetPullRequestNumber(event);
  let results;
  if (refresh) {
    results = await refreshReleaseWindows({ repository,
      pullRequestNumber,
      detailsUrl: `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  } else {
    const current = await loadCurrentPullRequestDisposition({ repository, pullRequestNumber });
    results = [await evaluateReleaseWindow(current)];
  }
  const summary = results.map((result) => `${result.number ? `#${result.number}: ` : ""}${result.summary}`).join("\n\n");
  process.stdout.write(`${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  const allowHeld = process.argv.includes("--allow-held");
  if (releaseWindowRunFails({ refresh, targeted: pullRequestNumber !== undefined, allowHeld, results })) process.exitCode = 1;
}

try { await main(); } catch (error) {
  process.stderr.write(`Release window validation failed: ${error.message}\n`);
  process.exitCode = 1;
}
