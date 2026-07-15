#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import {
  DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
  RECONCILIATION_KINDS,
  normalizeRepository,
  planBacklogReconciliation,
} from "./lib/backlog-dependencies.mjs";
import { loadGitHubBacklogSnapshot } from "./lib/github-backlog-dependencies.mjs";

function usage() {
  return (
    "Usage: node scripts/reconcile-backlog-dependencies.mjs --repository owner/repo " +
    "[--metadata snapshot.json] [--json] [--max-pages N] [--max-issues N] " +
    "[--max-dependencies N] [--concurrency N]"
  );
}

function positiveInteger(value, option) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${option} requires a positive integer.\n${usage()}`);
  const result = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(result)) throw new Error(`${option} exceeds the safe integer range.\n${usage()}`);
  return result;
}

function parseArguments(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    const names = new Map([
      ["--repository", "repository"],
      ["--metadata", "metadata"],
      ["--max-pages", "maxPages"],
      ["--max-issues", "maxIssues"],
      ["--max-dependencies", "maxDependencies"],
      ["--concurrency", "concurrency"],
    ]);
    const name = names.get(argument);
    if (!name) throw new Error(usage());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage());
    options[name] = value;
    index += 1;
  }

  if (options.help) return options;
  options.repository = normalizeRepository(options.repository ?? process.env.GITHUB_REPOSITORY);
  for (const [name, flag] of [
    ["maxPages", "--max-pages"],
    ["maxIssues", "--max-issues"],
    ["maxDependencies", "--max-dependencies"],
    ["concurrency", "--concurrency"],
  ]) {
    if (options[name] !== undefined) options[name] = positiveInteger(options[name], flag);
  }
  return options;
}

function readSnapshot(filePath, repository) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Metadata snapshot could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (normalizeRepository(snapshot?.repository) !== repository) {
    throw new Error(`Metadata snapshot repository does not match ${repository}.`);
  }
  return snapshot;
}

function formatHuman(plan) {
  const lines = [
    `Backlog dependency dry run: ${plan.repository}`,
    `Targets: ${plan.targetCount}; stabilized issue metadata: ${plan.metadataIssueCount}`,
    "Mutations performed: no",
    "",
    "Disposition counts:",
  ];
  for (const kind of RECONCILIATION_KINDS) lines.push(`- ${kind}: ${plan.counts[kind]}`);
  lines.push("", "Issues:");
  for (const item of plan.dispositions) {
    lines.push(`- ${item.issue}: ${item.kind} — ${item.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const snapshot = options.metadata
    ? readSnapshot(options.metadata, options.repository)
    : await loadGitHubBacklogSnapshot({
        repository: options.repository,
        maxPages: options.maxPages,
        maxIssues: options.maxIssues,
        maxDependencies: options.maxDependencies,
        concurrency: options.concurrency,
      });
  const plan = planBacklogReconciliation(snapshot, {
    maxDependencies: options.maxDependencies ?? DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
  });
  process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : formatHuman(plan));
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Backlog dependency dry run failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
