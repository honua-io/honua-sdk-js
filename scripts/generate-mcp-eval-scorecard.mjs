#!/usr/bin/env node

/**
 * Generate `docs/generated/mcp-eval-scorecard.md` — the published cross-model
 * MCP eval scorecard (issue #960).
 *
 * The page never carries a hand-edited figure. Every number is rendered from the
 * committed run artifacts under `mcp/evals/runs/`, and every rate is recomputed
 * from the per-scenario graded rows before it is published.
 *
 * Modes:
 *   node scripts/generate-mcp-eval-scorecard.mjs write   # regenerate
 *   node scripts/generate-mcp-eval-scorecard.mjs check   # fail on drift
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OUTPUT_PATH, generateScorecardMarkdown } from "./lib/mcp-eval-scorecard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const mode = process.argv[2] ?? "write";
  if (mode !== "write" && mode !== "check") {
    throw new Error(`unknown mode "${mode}" (expected "write" or "check")`);
  }

  const markdown = generateScorecardMarkdown(ROOT);
  const output = path.join(ROOT, OUTPUT_PATH);

  if (mode === "write") {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, markdown, "utf8");
    process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
    return;
  }

  const existing = fs.existsSync(output) ? fs.readFileSync(output, "utf8").replace(/\r\n/g, "\n") : "";
  if (existing !== markdown) {
    throw new Error(`${OUTPUT_PATH} is out of date — run "npm run docs:mcp-scorecard".`);
  }
  process.stdout.write(`${OUTPUT_PATH} is up to date\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
