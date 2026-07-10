#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_OUTPUT = "test-results/pr-fast.json";

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    budgetMs: DEFAULT_BUDGET_MS,
    output: DEFAULT_OUTPUT,
    startedAtMonotonicMs: os.uptime() * 1000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--budget-ms") {
      options.budgetMs = Number.parseInt(requiredValue(argv, index, arg), 10);
      index += 1;
    } else if (arg === "--output") {
      options.output = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--started-at-monotonic-ms") {
      options.startedAtMonotonicMs = Number.parseInt(requiredValue(argv, index, arg), 10);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0) {
    throw new Error("--budget-ms must be a positive integer");
  }
  if (!Number.isFinite(options.startedAtMonotonicMs) || options.startedAtMonotonicMs <= 0) {
    throw new Error("--started-at-monotonic-ms must be a positive system-uptime timestamp");
  }
  if (!options.output) {
    throw new Error("--output must not be empty");
  }
  return options;
}

function run(command, args) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.once("error", (error) => {
      resolve({
        command: [command, ...args].join(" "),
        durationMs: performance.now() - startedAt,
        exitCode: null,
        error: error.message,
      });
    });
    child.once("exit", (exitCode, signal) => {
      resolve({
        command: [command, ...args].join(" "),
        durationMs: performance.now() - startedAt,
        exitCode,
        signal,
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const steps = [
    ["npm", ["run", "samples:verify"]],
    ["npm", ["run", "typecheck"]],
    ["npm", ["run", "check"]],
    ["npm", ["run", "test:pr-fast"]],
  ];
  const results = [];

  for (const [command, args] of steps) {
    const result = await run(command, args);
    results.push(result);
    if (result.exitCode !== 0) {
      break;
    }
  }

  const completedAtEpochMs = Date.now();
  // System uptime is monotonic across processes, so NTP/WSL wall-clock jumps
  // cannot create a false two-minute budget failure. CI captures this value
  // before Node setup and dependency installation.
  const elapsedMs = os.uptime() * 1000 - options.startedAtMonotonicMs;
  const commandsPassed = results.length === steps.length && results.every((result) => result.exitCode === 0);
  const withinBudget = elapsedMs <= options.budgetMs;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date(completedAtEpochMs).toISOString(),
    budgetMs: options.budgetMs,
    elapsedMs,
    withinBudget,
    commandsPassed,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      ci: process.env.CI === "true",
      githubRunnerImage: process.env.ImageOS ?? null,
    },
    steps: results,
  };

  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `PR-fast validation: ${(elapsedMs / 1000).toFixed(2)}s / ${(options.budgetMs / 1000).toFixed(0)}s budget\n`,
  );

  if (!commandsPassed) {
    process.exitCode = 1;
  } else if (!withinBudget) {
    process.stderr.write(`PR-fast validation exceeded its budget by ${elapsedMs - options.budgetMs}ms\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`pr-fast failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
