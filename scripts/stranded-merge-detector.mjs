#!/usr/bin/env node
/**
 * Sweeps recently merged pull requests for merge commits that never reached the
 * default branch, and prints a markdown report.
 *
 * Usage:
 *   node scripts/stranded-merge-detector.mjs [options]
 *
 *   --repo <owner/name>        default: the repository `gh` resolves for cwd
 *   --default-branch <name>    default: trunk
 *   --limit <n>                merged pull requests to sweep (default 250)
 *   --transient-base <glob>    repeatable; bases expected to disappear
 *                              (default `train/batch/*`, the merge-train
 *                              batches honua-server lands through)
 *   --output <path>            also write the report here
 *   --no-fetch                 skip `git fetch` (tests, offline runs)
 *
 * Exit code 1 when at least one stranded pull request is found, so a scheduled
 * job fails loudly. Unresolved records never fail the run: a detector that
 * cries wolf gets muted, which reinstates the silence it exists to break.
 *
 * The classification lives in scripts/lib/stranded-merge-detector.mjs and is
 * repository-agnostic on purpose -- honua-io/honua-sdk-js#1317 and
 * honua-io/honua-server#3248 are the same failure and asked for one mechanism.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_TRANSIENT_BASE_PATTERNS,
  classifyMergedPullRequests,
  classifyOpenStacks,
  renderReport,
} from "./lib/stranded-merge-detector.mjs";

function parseArgs(argv) {
  const options = {
    repo: "",
    defaultBranch: "trunk",
    limit: 250,
    transientBasePatterns: [],
    output: "",
    fetch: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--repo") options.repo = next();
    else if (arg === "--default-branch") options.defaultBranch = next();
    else if (arg === "--limit") options.limit = Number.parseInt(next(), 10);
    else if (arg === "--transient-base") options.transientBasePatterns.push(next());
    else if (arg === "--output") options.output = next();
    else if (arg === "--no-fetch") options.fetch = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000");
  }
  if (options.transientBasePatterns.length === 0) {
    options.transientBasePatterns = [...DEFAULT_TRANSIENT_BASE_PATTERNS];
  }
  return options;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gh(args) {
  return JSON.parse(run("gh", args));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = options.repo || run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const remoteRef = `origin/${options.defaultBranch}`;

  if (options.fetch) {
    // The sweep is only as good as the local view of the default branch, and a
    // stranded merge commit is by definition on a branch nobody fetched.
    run("git", ["fetch", "--quiet", "--prune", "origin", `+refs/heads/*:refs/remotes/origin/*`]);
  }

  const repoArgs = ["--repo", repo];
  const mergedPullRequests = gh([
    "pr",
    "list",
    ...repoArgs,
    "--state",
    "merged",
    "--limit",
    String(options.limit),
    "--json",
    "number,title,baseRefName,headRefName,mergeCommit,mergedAt,url",
  ]);
  const openPullRequests = gh([
    "pr",
    "list",
    ...repoArgs,
    "--state",
    "open",
    "--limit",
    String(options.limit),
    "--json",
    "number,title,baseRefName,headRefName,mergeCommit,mergedAt,url",
  ]);

  const ancestry = new Map();
  const isAncestor = (sha) => {
    if (ancestry.has(sha)) return ancestry.get(sha);
    let result;
    try {
      run("git", ["cat-file", "-e", `${sha}^{commit}`]);
    } catch {
      result = undefined;
      ancestry.set(sha, result);
      return result;
    }
    try {
      run("git", ["merge-base", "--is-ancestor", sha, remoteRef]);
      result = true;
    } catch {
      result = false;
    }
    ancestry.set(sha, result);
    return result;
  };

  const branchState = new Map();
  const baseState = (baseRefName) => {
    if (branchState.has(baseRefName)) return branchState.get(baseRefName);
    let state;
    try {
      run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseRefName}`]);
      state = "open";
    } catch {
      state = "missing";
    }
    branchState.set(baseRefName, state);
    return state;
  };

  const classification = classifyMergedPullRequests({
    pullRequests: mergedPullRequests,
    defaultBranch: options.defaultBranch,
    isAncestor,
    transientBasePatterns: options.transientBasePatterns,
  });
  const openStacks = classifyOpenStacks({
    pullRequests: openPullRequests,
    defaultBranch: options.defaultBranch,
    baseState,
  });

  const report = renderReport({
    repo,
    defaultBranch: options.defaultBranch,
    scanned: mergedPullRequests.length,
    classification,
    openStacks,
  });

  process.stdout.write(report);
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, report, "utf8");
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report, "utf8");
  }

  if (classification.stranded.length > 0) {
    process.stderr.write(
      `\n${classification.stranded.length} merged pull request(s) are not on ${options.defaultBranch}.\n`,
    );
    process.exitCode = 1;
  }
}

main();
