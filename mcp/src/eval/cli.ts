#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./report.js";
import { runEval } from "./runner.js";

/**
 * Cross-model MCP workflow eval CLI (honua-server #1956).
 *
 * Modes:
 *   (default)        Run the eval, write artifacts, exit non-zero if the
 *                    deterministic control did not pass every scenario.
 *   --artifact-only  Run the eval, write artifacts, ALWAYS exit 0 (evidence
 *                    upload step; runs with always() in CI).
 *   --offline        Force the in-memory fixture surface + deterministic driver
 *                    only, even if API keys / HONUA_MCP_REMOTE_URL are set.
 *
 * Offline and deterministic by default: zero model/API calls. Live cross-model
 * runs (Claude + GPT) activate when ANTHROPIC_API_KEY / OPENAI_API_KEY are set,
 * and live remote MCP runs when HONUA_MCP_REMOTE_URL is set. Keys are never
 * hardcoded — they come from the environment.
 */

interface CliOptions {
  artifactOnly: boolean;
  offline: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  let artifactOnly = false;
  let offline = false;
  let outDir = fileURLToPath(new URL("../../../", import.meta.url));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artifact-only") {
      artifactOnly = true;
    } else if (arg === "--offline") {
      offline = true;
    } else if (arg === "--out-dir") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--out-dir requires a directory argument");
      }
      outDir = resolve(value);
    }
  }
  return { artifactOnly, offline, outDir };
}

async function main(): Promise<void> {
  const { artifactOnly, offline, outDir } = parseArgs(process.argv.slice(2));
  const report = await runEval({ forceOffline: offline });

  const jsonPath = resolve(outDir, "mcp-eval-results.json");
  const mdPath = resolve(outDir, "mcp-eval-results.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");

  const s = report.summary;
  const status = s.pass ? "PASS" : "FAIL";
  process.stdout.write(
    `MCP cross-model eval ${status}: ${s.scenarios} scenarios, ${s.modelsEvaluated} models ` +
      `(${s.liveModelsEvaluated} live), surface=${report.surface.backend}.\n`,
  );
  for (const m of report.models) {
    process.stdout.write(
      `  ${m.id}: success ${(m.successRate * 100).toFixed(0)}%, clarify ${(m.clarificationRate * 100).toFixed(0)}%, ` +
        `edit ${(m.editRate * 100).toFixed(0)}% (${m.pass}/${m.scenarios} passed)\n`,
    );
  }
  process.stdout.write(`Artifacts: ${jsonPath}\n           ${mdPath}\n`);

  if (!artifactOnly && !s.pass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`Eval error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
