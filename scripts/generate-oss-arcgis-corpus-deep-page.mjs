#!/usr/bin/env node

/**
 * Generate `docs/oss-arcgis-corpus-post-codemod-build.md` — the published
 * post-codemod build validation page (issue #955, acceptance criterion 2).
 *
 * Generated from two committed, independently regenerable inputs:
 *
 *   - `config/oss-arcgis-corpus.v1.json`                    (the pinned corpus + deep allowlist)
 *   - `docs/data/oss-arcgis-corpus-deep-build.v1.json`      (the published observation,
 *     written by `npm run corpus:oss-arcgis:deep:publish`)
 *
 * Modes:
 *   node scripts/generate-oss-arcgis-corpus-deep-page.mjs write   # regenerate
 *   node scripts/generate-oss-arcgis-corpus-deep-page.mjs check   # fail on drift
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "config", "oss-arcgis-corpus.v1.json");
const OUTPUT_PATH = path.join(ROOT, "docs", "oss-arcgis-corpus-post-codemod-build.md");
const CORPUS_MODULE = path.join(ROOT, "dist", "src", "migration", "oss-corpus.js");
const DEEP_MODULE = path.join(ROOT, "dist", "src", "migration", "oss-corpus-deep.js");

async function buildMarkdown() {
  for (const modulePath of [CORPUS_MODULE, DEEP_MODULE]) {
    if (!fs.existsSync(modulePath)) {
      throw new Error(`missing ${path.relative(ROOT, modulePath)} — run "npm run build" first.`);
    }
  }
  const corpus = await import(pathToFileURL(CORPUS_MODULE).href);
  const deepModule = await import(pathToFileURL(DEEP_MODULE).href);
  const manifest = corpus.loadOssArcGisCorpusManifest(MANIFEST_PATH);
  const summary = corpus.summarizeOssArcGisCorpus(manifest);
  if (summary.guardrailFailures.length > 0) {
    throw new Error(`corpus manifest guardrail failures:\n- ${summary.guardrailFailures.join("\n- ")}`);
  }

  const observationPath = path.resolve(ROOT, manifest.deepValidation.publishedObservationPath);
  if (!fs.existsSync(observationPath)) {
    throw new Error(
      `missing published observation ${path.relative(ROOT, observationPath)} — run the deep lane with --publish.`,
    );
  }
  const observation = JSON.parse(fs.readFileSync(observationPath, "utf8"));
  return deepModule.formatOssArcGisDeepBuildMarkdown(manifest, observation);
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
    throw new Error(`${relativeOutput} is out of date — run "npm run docs:oss-arcgis-corpus-deep".`);
  }
  process.stdout.write(`${relativeOutput} is up to date\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
