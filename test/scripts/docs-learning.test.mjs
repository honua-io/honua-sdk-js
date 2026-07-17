import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateLearningMarkdown, validateLearningManifest } from "../../scripts/docs-learning.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
const manifest = readJson("docs/learning-paths.v1.json");
const packageJson = readJson("package.json");
const publicSurface = readJson("config/public-surface.json");
const sampleCatalog = readJson("samples/catalog.v2.json");

function copyManifest() {
  return structuredClone(manifest);
}

test("rejects a stale or deprecated SDK subpath", async () => {
  const invalid = copyManifest();
  invalid.paths[0].api[0].specifier = "@honua/sdk-js/app";
  await assert.rejects(
    validateLearningManifest({
      manifest: invalid,
      projectRoot: root,
      packageJson,
      publicSurface,
      sampleCatalog: undefined,
      checkRuntimeImports: false,
    }),
    /deprecated SDK subpath @honua\/sdk-js\/app cannot be taught/,
  );
});

test("rejects a broken canonical guide link", async () => {
  const invalid = copyManifest();
  invalid.paths[0].guidePath = "docs/does-not-exist.md";
  await assert.rejects(
    validateLearningManifest({
      manifest: invalid,
      projectRoot: root,
      packageJson,
      publicSurface,
      sampleCatalog: undefined,
      checkRuntimeImports: false,
    }),
    /guidePath does not exist: docs\/does-not-exist.md/,
  );
});

test("derives learning-card metadata from the versioned sample catalog", async () => {
  await assert.doesNotReject(
    validateLearningManifest({
      manifest,
      projectRoot: root,
      packageJson,
      publicSurface,
      sampleCatalog,
      checkRuntimeImports: false,
    }),
  );

  const markdown = generateLearningMarkdown(manifest, sampleCatalog);
  const edit = manifest.paths.find((learningPath) => learningPath.id === "edit");
  assert.equal(edit.sampleId, "planning-permitting-workbench");
  assert.equal(edit.sourceEntry, "examples/planning-permitting-workbench/src/journey.ts");
  assert.match(markdown, /planning-permitting-workbench[\s\S]*Sample contract: `lab` · `supported` · `active`/);
  assert.match(markdown, /spatial-analytics-workbench[\s\S]*Sample contract: `lab` · `experimental` · `rework`/);
  assert.match(markdown, /storytelling-25d-map[\s\S]*Sample contract: `lab` · `supported` · `merge`/);
  assert.match(markdown, /Data and auth: `hybrid` · `anonymous`/);
  assert.match(markdown, /Live sample: \[demo\.html\]\(https:\/\/honua\.io\/demo\.html\)/);
  assert.match(markdown, /effective version derived from `package\.json`|version in \[`package\.json`\]/);
});

test("rejects learning paths that drift from catalog-owned source metadata", async () => {
  const invalid = copyManifest();
  invalid.paths[0].sourcePath = "examples/maplibre-quickstart";
  invalid.paths[0].sourceEntry = "examples/maplibre-quickstart/src/main.ts";

  await assert.rejects(
    validateLearningManifest({
      manifest: invalid,
      projectRoot: root,
      packageJson,
      publicSurface,
      sampleCatalog,
      checkRuntimeImports: false,
    }),
    /start: sourcePath must match the sample catalog \(examples\/standalone-quickstart\)/,
  );
});

test("requires experimental catalog samples to carry the learning label", async () => {
  const invalid = copyManifest();
  const analyze = invalid.paths.find((learningPath) => learningPath.id === "analyze");
  analyze.labels = analyze.labels.filter((label) => label !== "experimental");

  await assert.rejects(
    validateLearningManifest({
      manifest: invalid,
      projectRoot: root,
      packageJson,
      publicSurface,
      sampleCatalog,
      checkRuntimeImports: false,
    }),
    /analyze: experimental sample must carry the experimental label/,
  );
});

test("rejects duplicated support status and auth labels that drift from the catalog", async () => {
  const duplicated = copyManifest();
  duplicated.paths[0].supportStatus = "experimental";
  await assert.rejects(
    validateLearningManifest({
      manifest: duplicated,
      projectRoot: root,
      packageJson,
      publicSurface,
      sampleCatalog,
      checkRuntimeImports: false,
    }),
    /start: supportStatus is catalog-owned and must not be duplicated/,
  );

  const mislabeled = copyManifest();
  const edit = mislabeled.paths.find((learningPath) => learningPath.id === "edit");
  edit.labels.push("authenticated");
  await assert.rejects(
    validateLearningManifest({
      manifest: mislabeled,
      projectRoot: root,
      packageJson,
      publicSurface,
      sampleCatalog,
      checkRuntimeImports: false,
    }),
    /edit: authenticated label must match catalog authMode none/,
  );
});

test("keeps clean-checkout verification and CI build prerequisites coherent", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const jobStart = workflow.indexOf("  js-sdk:");
  const jobEnd = workflow.indexOf("\n  mcp-sdk:", jobStart);
  const job = workflow.slice(jobStart, jobEnd);
  const buildStep = job.indexOf("- name: Build\n");
  const learningStep = job.indexOf("- name: Compile learning-path examples\n");
  const verifyStep = job.indexOf("- name: Verify task-oriented learning paths\n");

  assert.notEqual(jobStart, -1, "JS SDK job must exist");
  assert.notEqual(jobEnd, -1, "MCP SDK job must follow the JS SDK job");
  assert.notEqual(buildStep, -1, "JS SDK build step must exist");
  assert.notEqual(learningStep, -1, "learning-path compile step must exist");
  assert.notEqual(verifyStep, -1, "learning-path verification step must exist");
  assert.ok(buildStep < learningStep, "package exports must be built before examples resolve self-references");
  assert.ok(buildStep < verifyStep, "package exports must be built before runtime import verification");
  assert.match(job.slice(verifyStep), /run: npm run docs:learning:check/, "CI must reuse its existing build");
  assert.equal(
    packageJson.scripts["docs:learning:check"],
    "node --test test/scripts/docs-learning.test.mjs && node scripts/docs-learning.mjs check",
  );
  assert.equal(
    packageJson.scripts["docs:learning:verify"],
    "npm run build --silent && npm run docs:learning:check",
    "the public verify command must materialize runtime import targets on a clean checkout",
  );
});
