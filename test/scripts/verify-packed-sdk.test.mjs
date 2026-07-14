import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runtimeSmokeSource,
  supportedEntrypoints,
  typeSmokeSource,
  validateInstalledManifest,
} from "../../scripts/lib/packed-sdk-smoke.mjs";

const surface = {
  entrypoints: [
    { subpath: ".", tier: "stable" },
    { subpath: "./honua", tier: "stable" },
    { subpath: "./geocoding", tier: "stable" },
    { subpath: "./plugin", tier: "experimental" },
    { subpath: "./app", tier: "deprecated" },
  ],
};
const entrypoints = supportedEntrypoints(surface);

function packageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-packed-sdk-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "index.js",
    "index.d.ts",
    "honua.js",
    "honua.d.ts",
    "geocoding.js",
    "geocoding.d.ts",
    "plugin.js",
    "plugin.d.ts",
    "bin.js",
  ]) {
    fs.writeFileSync(path.join(root, file), "export {};\n");
  }
  return {
    root,
    packageJson: {
      exports: {
        ".": { default: "./index.js", types: "./index.d.ts" },
        "./honua": { default: "./honua.js", types: "./honua.d.ts" },
        "./geocoding": { default: "./geocoding.js", types: "./geocoding.d.ts" },
        "./plugin": { default: "./plugin.js", types: "./plugin.d.ts" },
      },
      bin: { honua: "./bin.js" },
    },
  };
}

test("covers stable subpaths including geocoding while excluding deprecated shims", () => {
  assert.deepEqual(
    entrypoints.map((entrypoint) => entrypoint.subpath),
    [".", "./honua", "./geocoding", "./plugin"],
  );
  const runtime = runtimeSmokeSource("@honua/sdk-js", entrypoints);
  const types = typeSmokeSource("@honua/sdk-js", entrypoints);
  for (const specifier of [
    "@honua/sdk-js",
    "@honua/sdk-js/honua",
    "@honua/sdk-js/geocoding",
    "@honua/sdk-js/plugin",
  ]) {
    assert.ok(runtime.includes(specifier));
    assert.ok(types.includes(specifier));
  }
  assert.doesNotMatch(runtime, /@honua\/sdk-js\/app/);
  assert.doesNotMatch(types, /@honua\/sdk-js\/app/);
});

test("accepts a complete installed package manifest", (t) => {
  const fixture = packageFixture(t);
  assert.deepEqual(
    validateInstalledManifest({
      packageRoot: fixture.root,
      packageJson: fixture.packageJson,
      entrypoints,
    }),
    [],
  );
});

test("reports entrypoint-level missing runtime and declaration targets", (t) => {
  const fixture = packageFixture(t);
  fs.rmSync(path.join(fixture.root, "honua.js"));
  fs.rmSync(path.join(fixture.root, "plugin.d.ts"));
  assert.deepEqual(
    validateInstalledManifest({
      packageRoot: fixture.root,
      packageJson: fixture.packageJson,
      entrypoints,
    }),
    [
      "./honua installed default target is missing: ./honua.js",
      "./plugin installed types target is missing: ./plugin.d.ts",
    ],
  );
});

test("rejects missing and package-escaping bin and export targets", (t) => {
  const fixture = packageFixture(t);
  fixture.packageJson.exports["./plugin"].default = "../outside.js";
  fixture.packageJson.bin.honua = "./missing-bin.js";
  assert.deepEqual(
    validateInstalledManifest({
      packageRoot: fixture.root,
      packageJson: fixture.packageJson,
      entrypoints,
    }),
    [
      "./plugin installed default target escapes the package: ../outside.js",
      "installed honua bin target is missing: ./missing-bin.js",
    ],
  );
});
