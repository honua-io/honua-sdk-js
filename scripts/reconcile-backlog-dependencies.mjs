#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import {
  BacklogDependencyError,
  DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
  RECONCILIATION_KINDS,
  normalizeRepository,
  planBacklogReconciliation,
} from "./lib/backlog-dependencies.mjs";
import { GitHubBacklogMetadataError, loadGitHubBacklogSnapshot } from "./lib/github-backlog-dependencies.mjs";

const CLI_ERROR_MESSAGES = Object.freeze({
  "invalid-argument": "Command arguments are invalid.",
  "invalid-positive-integer": "A numeric option requires a positive safe integer.",
  "invalid-snapshot": "Metadata snapshot could not be read safely.",
  "snapshot-repository-mismatch": "Metadata snapshot repository does not match the requested repository.",
});

class BacklogDependencyCliError extends Error {
  constructor(code) {
    const knownCode = Object.hasOwn(CLI_ERROR_MESSAGES, code) ? code : "cli-error";
    super(CLI_ERROR_MESSAGES[knownCode] ?? "Backlog dependency command failed.");
    this.name = "BacklogDependencyCliError";
    this.code = knownCode;
  }
}

function usage() {
  return (
    "Usage: node scripts/reconcile-backlog-dependencies.mjs --repository owner/repo " +
    "[--metadata snapshot.json] [--json] [--max-pages N] [--max-issues N] " +
    "[--max-dependencies N] [--concurrency N]"
  );
}

function positiveInteger(value) {
  if (!/^[1-9][0-9]*(?![\s\S])/u.test(value)) throw new BacklogDependencyCliError("invalid-positive-integer");
  const result = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(result)) throw new BacklogDependencyCliError("invalid-positive-integer");
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
    if (!name) throw new BacklogDependencyCliError("invalid-argument");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new BacklogDependencyCliError("invalid-argument");
    options[name] = value;
    index += 1;
  }

  if (options.help) return options;
  options.repository = normalizeRepository(options.repository ?? process.env.GITHUB_REPOSITORY);
  for (const name of ["maxPages", "maxIssues", "maxDependencies", "concurrency"]) {
    if (options[name] !== undefined) options[name] = positiveInteger(options[name]);
  }
  return options;
}

function readSnapshot(filePath, repository) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new BacklogDependencyCliError("invalid-snapshot");
  }
  try {
    if (normalizeRepository(snapshot?.repository) !== repository) {
      throw new BacklogDependencyCliError("snapshot-repository-mismatch");
    }
  } catch (error) {
    if (error instanceof BacklogDependencyCliError) throw error;
    throw new BacklogDependencyCliError("invalid-snapshot");
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
  const knownError =
    error instanceof BacklogDependencyCliError ||
    error instanceof BacklogDependencyError ||
    error instanceof GitHubBacklogMetadataError;
  const detail = knownError ? `${error.code}: ${error.message}` : "unexpected-error: Dry run failed safely.";
  process.stderr.write(`Backlog dependency dry run failed: ${detail}\n`);
  process.exitCode = 1;
}
