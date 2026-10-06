#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { continueReleasePleaseCi } from "./lib/release-please-ci-continuation.mjs";

try {
  const result = await continueReleasePleaseCi({
    event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
    eventName: process.env.GITHUB_EVENT_NAME,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    trustedPolicySha: process.env.TRUSTED_POLICY_SHA,
    githubSha: process.env.GITHUB_SHA,
  });
  const summary = `## Release Please CI continuation\n\nPublished JS SDK, MCP SDK and PR Issue Disposition for exact head ${result.checks.headSha} from canonical run ${result.checks.workflowRunId}.\n`;
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
} catch (error) {
  process.stderr.write(`Trusted Release Please continuation failed: ${error.message}\n`);
  process.exitCode = 1;
}
