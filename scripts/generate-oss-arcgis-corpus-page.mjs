#!/usr/bin/env node

/**
 * Generate `docs/oss-arcgis-corpus-readiness.md` — the published readiness
 * summary for the third-party OSS ArcGIS app corpus (issue #955, REQ-003).
 *
 * The page never carries a hand-edited figure. Every number is rendered from
 * two committed, independently regenerable inputs:
 *
 *   - `config/oss-arcgis-corpus.v1.json`            (the pinned corpus)
 *   - `docs/data/oss-arcgis-corpus-readiness.v1.json` (the published
 *     observation, written by `npm run corpus:oss-arcgis:publish`)
 *
 * Modes:
 *   node scripts/generate-oss-arcgis-corpus-page.mjs write   # regenerate
 *   node scripts/generate-oss-arcgis-corpus-page.mjs check   # fail on drift
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "config", "oss-arcgis-corpus.v1.json");
const OUTPUT_PATH = path.join(ROOT, "docs", "oss-arcgis-corpus-readiness.md");
const CORPUS_MODULE = path.join(ROOT, "dist", "src", "migration", "oss-corpus.js");

async function buildMarkdown() {
  if (!fs.existsSync(CORPUS_MODULE)) {
    throw new Error(`missing ${path.relative(ROOT, CORPUS_MODULE)} — run "npm run build" first.`);
  }
  const corpus = await import(pathToFileURL(CORPUS_MODULE).href);
  const manifest = corpus.loadOssArcGisCorpusManifest(MANIFEST_PATH);
  const summary = corpus.summarizeOssArcGisCorpus(manifest);
  if (summary.guardrailFailures.length > 0) {
    throw new Error(`corpus manifest guardrail failures:\n- ${summary.guardrailFailures.join("\n- ")}`);
  }

  const observationPath = path.resolve(ROOT, manifest.lane.publishedObservationPath);
  if (!fs.existsSync(observationPath)) {
    throw new Error(
      `missing published observation ${path.relative(ROOT, observationPath)} — run the opt-in lane with --publish.`,
    );
  }
  const observation = JSON.parse(fs.readFileSync(observationPath, "utf8"));
  return corpus.formatOssArcGisCorpusMarkdown(manifest, observation);
}

async function main() {
  const mode = process.argv[2] ?? "write";
  if (mode !== "write" && mode !== "check") {
    throw new Error(`unknown mode "${mode}" (expected "write" or "check")`);
  }

  const markdown = await buildMarkdown();
  const relativeOutput = path.relative(ROOT, OUTPUT_PATH);

  if (mode === "write") {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, markdown, "utf8");
    process.stdout.write(`wrote ${relativeOutput}\n`);
    return;
  }

  const existing = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8").replace(/\r\n/g, "\n") : "";
  if (existing !== markdown) {
    throw new Error(`${relativeOutput} is out of date — run "npm run docs:oss-arcgis-corpus".`);
  }
  process.stdout.write(`${relativeOutput} is up to date\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
