import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareNlMapConsumer } from "../../scripts/lib/nl-map-packed-consumer.mjs";

import {
  ADMIN_JOURNEY_GROUPS,
  ADMIN_JOURNEY_OPERATIONS,
  adminJourneyCliArgs,
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

const nativeEntrypoint = { subpath: "./geoparquet/node", tier: "experimental" };

function nativePackageFixture(t) {
  const fixture = packageFixture(t);
  fixture.packageJson.exports[nativeEntrypoint.subpath] = {
    types: "./plugin.d.ts",
    node: "./plugin.js",
  };
  return {
    packageRoot: fixture.root,
    packageJson: fixture.packageJson,
    entrypoints: [...entrypoints, nativeEntrypoint],
  };
}

test("accepts the installed Node-only export and includes it in runtime and type probes", (t) => {
  const fixture = nativePackageFixture(t);
  assert.deepEqual(validateInstalledManifest(fixture), []);
  assert.match(runtimeSmokeSource("@honua/sdk-js", fixture.entrypoints), /@honua\/sdk-js\/geoparquet\/node/);
  assert.match(typeSmokeSource("@honua/sdk-js", fixture.entrypoints), /@honua\/sdk-js\/geoparquet\/node/);
});

test("rejects browser or default fallbacks on the installed Node-only export", (t) => {
  for (const condition of ["default", "browser"]) {
    const fixture = nativePackageFixture(t);
    fixture.packageJson.exports[nativeEntrypoint.subpath][condition] = "./plugin.js";
    assert.deepEqual(validateInstalledManifest(fixture), [
      "./geoparquet/node installed export must declare exactly node and types",
    ]);
  }
});

test("validates Node-only runtime and declaration targets without weakening ordinary exports", (t) => {
  const fixture = nativePackageFixture(t);
  fixture.packageJson.exports[nativeEntrypoint.subpath].node = "../outside.js";
  fs.rmSync(path.join(fixture.packageRoot, "plugin.d.ts"));
  delete fixture.packageJson.exports["./honua"].default;
  fixture.packageJson.exports["./honua"].node = "./honua.js";
  assert.deepEqual(validateInstalledManifest(fixture), [
    "./honua installed export has no default target",
    "./plugin installed types target is missing: ./plugin.d.ts",
    "./geoparquet/node installed node target escapes the package: ../outside.js",
    "./geoparquet/node installed types target is missing: ./plugin.d.ts",
  ]);
});

test("rejects missing or nested Node-only runtime targets", (t) => {
  for (const node of ["./missing.js", { import: "./plugin.js" }]) {
    const fixture = nativePackageFixture(t);
    fixture.packageJson.exports[nativeEntrypoint.subpath].node = node;
    assert.deepEqual(validateInstalledManifest(fixture), [
      typeof node === "string"
        ? "./geoparquet/node installed node target is missing: ./missing.js"
        : "./geoparquet/node installed export has no node target",
    ]);
  }
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

test("admin journey coverage names the honua-release#123 stages that need a client verb", () => {
  const stages = ADMIN_JOURNEY_OPERATIONS.filter((entry) => entry.stage !== null).map((entry) => entry.stage);
  assert.deepEqual([...new Set(stages)].sort(), [2, 3, 8]);
});

test("admin journey coverage resolves an operation in every group", () => {
  const covered = new Set(ADMIN_JOURNEY_OPERATIONS.map((entry) => entry.group));
  for (const group of ADMIN_JOURNEY_GROUPS) {
    assert.ok(covered.has(group), `${group} is certified by a real operation, not help text alone`);
  }
});

test("admin journey operations match the generated admin inventory and interpolate their paths", async () => {
  let inventory;
  try {
    ({ ADMIN_OPERATIONS: inventory } = await import("../../dist/src/control-plane/index.js"));
  } catch {
    // The pure-helper suite runs before the build in some lanes; the packed run that
    // consumes these entries always executes against built output.
    return;
  }
  for (const { group, operationId, pathParams, expectedPath } of ADMIN_JOURNEY_OPERATIONS) {
    const descriptor = inventory[operationId];
    assert.ok(descriptor, `${operationId} exists in the generated admin inventory`);
    assert.equal(descriptor.group, group, `${operationId} belongs to the ${group} group`);

    // The declared placeholders must be exactly what the gate supplies, so a renamed
    // placeholder fails here instead of passing a pre-interpolation dry-run.
    const declared = [...descriptor.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(declared, Object.keys(pathParams).sort(), `${operationId} placeholders are covered`);

    const interpolated = descriptor.path.replace(/\{([^}]+)\}/g, (_match, name) =>
      encodeURIComponent(String(pathParams[name])),
    );
    assert.equal(interpolated, expectedPath, `${operationId} interpolates to its expected path`);
  }
});

test("the stage 8 entry carries the exact honua-release#123 approval command shape", () => {
  const stage8 = ADMIN_JOURNEY_OPERATIONS.find((entry) => entry.stage === 8);
  assert.equal(stage8.operationId, "approveOperationProposal");
  assert.deepEqual(adminJourneyCliArgs(stage8), [
    "admin",
    "operate",
    "approveOperationProposal",
    "--path",
    "id=packed-proposal",
    "--profile",
    "approver",
    "--yes",
  ]);
});

function sampleConsumerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-sample-consumer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const consumerRoot = path.join(root, "consumer");
  const sample = path.join(projectRoot, "examples", "nl-map-control");
  const sdk = path.join(consumerRoot, "node_modules", "@honua", "sdk-js");
  fs.mkdirSync(path.join(sample, "src"), { recursive: true });
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sample, "src", "main.ts"), 'import { available } from "@honua/sdk-js"; void available;\n');
  fs.writeFileSync(path.join(sample, "index.html"), '<script type="module" src="/src/main.ts"></script>');
  fs.writeFileSync(path.join(sample, "evaluation.v1.json"), '{}\n');
  fs.writeFileSync(path.join(sample, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, types: [],
    baseUrl: ".", paths: { "@honua/sdk-js": ["../../src/index.ts"] },
  } }));
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "@honua/sdk-js", types: "index.d.ts" }));
  fs.writeFileSync(path.join(sdk, "index.d.ts"), 'export declare const available: number;\n');
  return { projectRoot, consumerRoot, sdk };
}

test("copied sample resolves installed declarations and refuses missing exports or repository imports", (t) => {
  const fixture = sampleConsumerFixture(t);
  const sample = prepareNlMapConsumer(fixture);
  const config = JSON.parse(fs.readFileSync(path.join(sample, "tsconfig.json"), "utf8"));
  assert.equal(config.compilerOptions.paths, undefined);
  assert.equal(config.compilerOptions.baseUrl, undefined);
  const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
  const compile = () => spawnSync(process.execPath, [compiler, "-p", sample], { encoding: "utf8", timeout: 30_000 });
  const valid = compile();
  assert.equal(valid.status, 0, valid.stderr + valid.stdout);
  fs.writeFileSync(path.join(fixture.sdk, "index.d.ts"), 'export declare const other: number;\n');
  const missing = compile();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /no exported member 'available'/);
  fs.writeFileSync(path.join(sample, "src", "main.ts"), 'import { available } from "../../../src/index.js"; void available;\n');
  const escaping = compile();
  assert.notEqual(escaping.status, 0);
  assert.match(escaping.stdout, /Cannot find module '\.\.\/\.\.\/\.\.\/src\/index.js'/);
});
