#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import {
  BacklogDependencyError,
  DEFAULT_MAX_BACKLOG_ISSUES,
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
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const VALUE_ARGUMENTS = new Map([
  ["--repository", "repository"],
  ["--metadata", "metadata"],
  ["--max-pages", "maxPages"],
  ["--max-issues", "maxIssues"],
  ["--max-dependencies", "maxDependencies"],
  ["--concurrency", "concurrency"],
]);

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
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (seen.has(argument)) throw new BacklogDependencyCliError("invalid-argument");
      seen.add(argument);
      options.json = true;
      continue;
    }
    if (argument === "--help") {
      if (seen.has(argument)) throw new BacklogDependencyCliError("invalid-argument");
      seen.add(argument);
      options.help = true;
      continue;
    }
    const name = VALUE_ARGUMENTS.get(argument);
    if (!name || seen.has(argument)) throw new BacklogDependencyCliError("invalid-argument");
    seen.add(argument);
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

function readBoundedSnapshot(filePath) {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.length > MAX_PATH_LENGTH ||
    filePath.includes("\0")
  ) {
    throw new BacklogDependencyCliError("invalid-snapshot");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SNAPSHOT_BYTES)) {
      throw new BacklogDependencyCliError("invalid-snapshot");
    }
    const size = Number(before.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(descriptor, bytes, offset, size - offset, offset);
      if (read <= 0) throw new BacklogDependencyCliError("invalid-snapshot");
      offset += read;
    }
    const extra = Buffer.alloc(1);
    if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
      throw new BacklogDependencyCliError("invalid-snapshot");
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (before[key] !== after[key]) throw new BacklogDependencyCliError("invalid-snapshot");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof BacklogDependencyCliError) throw error;
    throw new BacklogDependencyCliError("invalid-snapshot");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The fixed snapshot error boundary must not expose filesystem details.
      }
    }
  }
}

function readSnapshot(filePath, repository) {
  let snapshot;
  try {
    snapshot = JSON.parse(readBoundedSnapshot(filePath));
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
    maxIssues: options.maxIssues ?? DEFAULT_MAX_BACKLOG_ISSUES,
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
