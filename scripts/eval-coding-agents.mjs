#!/usr/bin/env node
/**
 * Coding-agent evaluation harness CLI (issue #501).
 *
 * Runs the task corpus under `eval/coding-agents/tasks/` through an agent
 * adapter and scores every generated program objectively (typecheck against
 * the built SDK + runtime execution against the deterministic fixture server
 * + expected-output assertions). Writes a JSON + Markdown scorecard.
 *
 * Usage:
 *   node scripts/eval-coding-agents.mjs                         # fixture adapter, known-good lane (gate)
 *   node scripts/eval-coding-agents.mjs --variant known-bad --expect-fail
 *                                                               # self-test lane: every known-bad generation must fail
 *   HONUA_EVAL_AGENTS=1 node scripts/eval-coding-agents.mjs --adapter claude-cli
 *                                                               # live Claude Code headless lane (opt-in)
 *
 * Flags:
 *   --adapter fixture|claude-cli   (default fixture)
 *   --variant known-good|known-bad (fixture adapter only; default known-good)
 *   --tasks id1,id2                run a subset of the corpus
 *   --output <dir>                 artifact directory (default test-results/coding-agent-eval/<lane>)
 *   --expect-fail                  gate inverts: exit 0 only when every scored task FAILS
 *   --publish                      also refresh docs/generated/coding-agent-scorecard.md
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAdapter } from "./lib/coding-agent-eval/adapters.mjs";
import { startEvalFixtureServer } from "./lib/coding-agent-eval/fixture-server.mjs";
import { runEvalLane } from "./lib/coding-agent-eval/runner.mjs";
import { buildScorecard, publishScorecard, renderScorecardMarkdown } from "./lib/coding-agent-eval/scorecard.mjs";
import { loadTasks } from "./lib/coding-agent-eval/tasks.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export function parseArgs(argv) {
  const options = {
    adapter: "fixture",
    variant: "known-good",
    tasks: undefined,
    output: undefined,
    expectFail: false,
    publish: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const requiredValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--adapter":
        options.adapter = requiredValue();
        break;
      case "--variant":
        options.variant = requiredValue();
        break;
      case "--tasks":
        options.tasks = requiredValue()
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        break;
      case "--output":
        options.output = requiredValue();
        break;
      case "--expect-fail":
        options.expectFail = true;
        break;
      case "--publish":
        options.publish = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const lane = options.adapter === "fixture" ? `fixture-${options.variant}` : options.adapter;
  const outputDir = path.resolve(REPO_ROOT, options.output ?? path.join("test-results", "coding-agent-eval", lane));
  const workDir = path.join(outputDir, "scaffold");

  const tasks = loadTasks(REPO_ROOT);
  const adapter = createAdapter(options.adapter, { repoRoot: REPO_ROOT, variant: options.variant });

  const server = await startEvalFixtureServer({ repoRoot: REPO_ROOT });
  let laneResult;
  try {
    laneResult = await runEvalLane({
      repoRoot: REPO_ROOT,
      workDir,
      tasks,
      adapter,
      baseUrl: server.url,
      taskFilter: options.tasks,
    });
  } finally {
    await server.close();
  }

  const scorecard = buildScorecard({ repoRoot: REPO_ROOT, lane, laneResult });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "scorecard.md"), `${renderScorecardMarkdown(scorecard)}\n`);
  if (options.publish) {
    const published = publishScorecard({ repoRoot: REPO_ROOT, scorecards: [scorecard] });
    console.log(`published ${path.relative(REPO_ROOT, published)}`);
  }

  const scored = scorecard.tasks.filter((task) => !task.skipped);
  console.log(
    `[coding-agent-eval] lane=${lane} model=${scorecard.adapter.model} tasks=${scored.length} passed=${scorecard.summary.passed} failed=${scorecard.summary.failed} (artifacts: ${path.relative(REPO_ROOT, outputDir)})`,
  );
  for (const task of scored) {
    if (!task.pass) {
      const stage = task.generation?.status === "error" ? "generation" : !task.typecheck?.pass ? "typecheck" : !task.runtime?.pass ? "runtime" : "assertions";
      console.log(`  FAIL ${task.id} (${stage})`);
    }
  }

  if (options.expectFail) {
    const unexpectedPasses = scored.filter((task) => task.pass);
    if (scored.length === 0) {
      console.error("expect-fail lane scored zero tasks");
      process.exitCode = 1;
    } else if (unexpectedPasses.length > 0) {
      console.error(`expect-fail lane had unexpected passes: ${unexpectedPasses.map((task) => task.id).join(", ")}`);
      process.exitCode = 1;
    }
  } else if (scorecard.summary.failed > 0 || scored.length === 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
