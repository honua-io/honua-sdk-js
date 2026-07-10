import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateLearningManifest } from "../../scripts/docs-learning.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
const manifest = readJson("docs/learning-paths.v1.json");
const packageJson = readJson("package.json");
const publicSurface = readJson("config/public-surface.json");

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
