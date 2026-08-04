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

  // Derived-artifact decoupling (#677), mirroring `npm run verify:llms`: the
  // page is regenerated on trunk by the workflows that commit new run artifacts
  // (mcp-cert-scheduled, mcp-eval-live). Rendering it above already proves it is
  // producible from the committed evidence without error; at PR time (relax
  // signal set) we do not additionally require it to be committed-fresh, so a
  // scheduled run landing on trunk cannot wedge every open pull request.
  if (/^(1|true|yes|on)$/i.test(process.env.HONUA_DERIVED_ARTIFACTS_RELAX ?? "")) {
    process.stdout.write(`${OUTPUT_PATH} freshness relaxed for PR (regenerated on trunk; #677)\n`);
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
