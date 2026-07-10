import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyBuiltEntrypoints } from "../../scripts/lib/verify-built-entrypoints.mjs";

const entrypoints = [{ subpath: "." }, { subpath: "./honua" }];

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-public-surface-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("fails each supported entrypoint when run before build artifacts exist", async (t) => {
  const projectRoot = fixtureRoot(t);
  const result = await verifyBuiltEntrypoints({
    entrypoints,
    packageJson: {
      exports: {
        ".": { default: "./dist/index.mjs" },
        "./honua": { default: "./dist/honua.mjs" },
      },
    },
    projectRoot,
    rootRuntimeExportCeiling: 10,
  });

  assert.equal(result.importCount, 0);
  assert.deepEqual(result.failures, [
    ". built-entrypoint target is missing: ./dist/index.mjs",
    "./honua built-entrypoint target is missing: ./dist/honua.mjs",
  ]);
});

test("reports a mistyped target while still importing valid sibling entrypoints", async (t) => {
  const projectRoot = fixtureRoot(t);
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist", "index.mjs"), "export const ready = true;\n");

  const result = await verifyBuiltEntrypoints({
    entrypoints,
    packageJson: {
      exports: {
        ".": { default: "./dist/index.mjs" },
        "./honua": { default: "./dist/mistyped.mjs" },
      },
    },
    projectRoot,
    rootRuntimeExportCeiling: 10,
  });

  assert.equal(result.importCount, 1);
  assert.deepEqual(result.failures, [
    "./honua built-entrypoint target is missing: ./dist/mistyped.mjs",
  ]);
});
