#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCorpus } from "./corpus.js";
import { type DriverName, parseDriverName, selectDrivers } from "./drivers/index.js";
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
 *   --driver <name>  Run the deterministic control plus the named live driver(s)
 *                    (repeatable or comma-separated): anthropic | openai | bedrock.
 *                    The named driver is run even if its key/opt-in is absent so an
 *                    explicit request yields an honest driverError, not a silent
 *                    skip. Without --driver, drivers are auto-resolved from env.
 *   --corpus <name>  Select the corpus explicitly: analyst | operator | northstar |
 *                    all. This overrides HONUA_EVAL_CORPUS and is how the `eval:live`
 *                    script targets the operator surface without relying on shell env
 *                    (cross-platform). `northstar` targets the three P1-gate
 *                    workflows. Defaults to the env-driven selection.
 *
 * Corpus selection is env-driven (see `resolveCorpus`): default is the analyst
 * corpus (in-process SDK fixture surface, the CI control); `HONUA_EVAL_CORPUS=operator`
 * targets the honua-server operator MCP surface for live runs; `all` runs both.
 *
 * Offline and deterministic by default: zero model/API calls. Live cross-model
 * runs activate when ANTHROPIC_API_KEY / OPENAI_API_KEY are set (Anthropic/OpenAI
 * APIs) or HONUA_EVAL_BEDROCK is set (Claude via Amazon Bedrock, AWS credential
 * chain), and live remote MCP runs when HONUA_MCP_REMOTE_URL is set. Keys are
 * never hardcoded — they come from the environment.
 */

const CORPUS_NAMES = ["analyst", "operator", "northstar", "standalone", "all"] as const;
type CorpusName = (typeof CORPUS_NAMES)[number];

interface CliOptions {
  artifactOnly: boolean;
  offline: boolean;
  outDir: string;
  drivers: DriverName[];
  corpus?: CorpusName;
}

function parseArgs(argv: string[]): CliOptions {
  let artifactOnly = false;
  let offline = false;
  let outDir = fileURLToPath(new URL("../../../", import.meta.url));
  const drivers: DriverName[] = [];
  let corpus: CorpusName | undefined;
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
    } else if (arg === "--corpus") {
      const value = argv[++i];
      if (!value || !(CORPUS_NAMES as readonly string[]).includes(value)) {
        throw new Error(`--corpus requires one of: ${CORPUS_NAMES.join(", ")}`);
      }
      corpus = value as CorpusName;
    } else if (arg === "--driver") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--driver requires a driver name (anthropic | openai | bedrock)");
      }
      for (const name of value.split(",")) {
        const trimmed = name.trim();
        if (trimmed.length > 0) {
          drivers.push(parseDriverName(trimmed));
        }
      }
    }
  }
  return { artifactOnly, offline, outDir, drivers, ...(corpus ? { corpus } : {}) };
}

/** Map the `--corpus` alias to the corresponding HONUA_EVAL_CORPUS selection. */
function corpusForName(name: CorpusName): ReturnType<typeof resolveCorpus> {
  const selector = name === "analyst" ? "" : name; // analyst is the env default
  return resolveCorpus({ ...process.env, HONUA_EVAL_CORPUS: selector });
}

async function main(): Promise<void> {
  const { artifactOnly, offline, outDir, drivers, corpus } = parseArgs(process.argv.slice(2));
  const report = await runEval({
    forceOffline: offline,
    ...(drivers.length > 0 ? { drivers: selectDrivers(drivers) } : {}),
    ...(corpus ? { corpus: corpusForName(corpus) } : {}),
    ...(corpus === "standalone" ? { forceStandaloneSurface: true } : {}),
  });

  mkdirSync(outDir, { recursive: true });
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
