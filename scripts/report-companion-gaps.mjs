#!/usr/bin/env node

// Keeps one open tracking issue per companion gap in a published-release
// verification receipt: a package that publishes from its own Release Please
// tag (the MCP server, the scaffold) whose tagged version never reached the
// registry. A new gap opens an issue; a gap that already has an open issue
// gets a comment naming the SDK release that found it again.
//
// Usage: node scripts/report-companion-gaps.mjs --receipt <path> --run-url <url>
// Needs GH_TOKEN with issues: write and GITHUB_REPOSITORY.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function companionGapTitle(gap) {
  return `Companion release ${gap.npmName}@${gap.version} (${gap.tag}) is tagged but not on the registry`;
}

function newIssueBody(gap, receipt, runUrl) {
  return [
    `\`${gap.tag}\` exists, but the registry has no \`${gap.npmName}@${gap.version}\`.`,
    `Found by the published-release verification for \`${receipt.sealedTag}\`: ${runUrl}`,
    "",
    "The SDK packages of that release verified; this is a companion package gap, not an SDK publish failure.",
    "",
    "Resolve it one of two ways:",
    `- **Publish it**: if \`${gap.version}\` is still the newest ${gap.npmName} release, run \`${gap.workflow}\` again on \`${gap.tag}\` once its prerequisite SDK version is public.`,
    `- **Record it as skipped**: if a newer ${gap.npmName} version is already published, do not publish \`${gap.version}\`; pre-1.0 publishes take the \`latest\` dist-tag, so publishing an older version would move \`latest\` backwards. Close this issue as skipped. The next SDK release verifies the companion version recorded at its own sealed commit.`,
  ].join("\n");
}

function recurrenceComment(receipt, runUrl) {
  return `Still missing from the registry at the published-release verification for \`${receipt.sealedTag}\`: ${runUrl}`;
}

/**
 * `issues` supplies `listOpenIssues()`, `createIssue(title, body)` and
 * `commentOnIssue(number, body)`, so the policy is tested without GitHub.
 */
export async function reportCompanionGaps({ receipt, runUrl, issues }) {
  const gaps = receipt.companionGaps ?? [];
  if (gaps.length === 0) return;
  const open = await issues.listOpenIssues();
  for (const gap of gaps) {
    const title = companionGapTitle(gap);
    const existing = open.find((issue) => issue.title === title);
    if (existing) await issues.commentOnIssue(existing.number, recurrenceComment(receipt, runUrl));
    else await issues.createIssue(title, newIssueBody(gap, receipt, runUrl));
  }
}

function githubIssues(repository) {
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return {
    listOpenIssues: async () =>
      JSON.parse(
        gh(["issue", "list", "--repo", repository, "--state", "open", "--search", "Companion release in:title", "--limit", "100", "--json", "number,title"]),
      ),
    createIssue: async (title, body) => {
      gh(["issue", "create", "--repo", repository, "--title", title, "--body", body]);
    },
    commentOnIssue: async (number, body) => {
      gh(["issue", "comment", String(number), "--repo", repository, "--body", body]);
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--receipt") options.receipt = value;
    else if (flag === "--run-url") options.runUrl = value;
    else throw new Error(`Unknown report-companion-gaps argument: ${flag}`);
  }
  if (!options.receipt || !options.runUrl) throw new Error("report-companion-gaps requires --receipt and --run-url");
  return options;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const receipt = JSON.parse(fs.readFileSync(options.receipt, "utf8"));
  await reportCompanionGaps({ receipt, runUrl: options.runUrl, issues: githubIssues(repository) });
}
