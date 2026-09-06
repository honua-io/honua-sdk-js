#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { build, loadConfigFromFile } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const candidate = JSON.parse(await readFile(path.join(root, "config/installed-package-certification.v1.json"), "utf8"));
const work = await mkdtemp(path.join(tmpdir(), "honua-installed-first-map-"));
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(root, outputIndex < 0 ? "test-results/installed-quickstart-budget.json" : process.argv[outputIndex + 1]);
const proveRegression = process.argv.includes("--prove-regression");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const previousMode = process.env.HONUA_SAMPLE_SDK_MODE;
const previousDirectory = process.env.HONUA_SAMPLE_SDK_DIR;

try {
  await writeFile(path.join(work, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
    [candidate.package.coordinate]: candidate.package.version,
    ...candidate.consumerDependencies,
  } }));
  for (const args of [["install", "--package-lock-only"], ["ci"]]) {
    const result = spawnSync("npm", [...args, "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${candidate.package.registry}`],
      { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const lockBytes = await readFile(path.join(work, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  const installed = lock.packages[`node_modules/${candidate.package.coordinate}`];
  assert.equal(installed.version, candidate.package.version, "installed version must match candidate");
  assert.equal(installed.integrity, candidate.package.integrity, "installed tarball integrity must match candidate");
  assert.ok(!installed.link, "the installed SDK must not be a workspace link");
  process.env.HONUA_SAMPLE_SDK_MODE = "packed";
  process.env.HONUA_SAMPLE_SDK_DIR = path.join(work, "node_modules", candidate.package.coordinate);
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" },
    path.join(root, "examples/maplibre-quickstart/vite.config.ts"));
  assert.ok(loaded, "canonical First Map config must load");

  async function measure(label, removePeerAlias = false, removePeerSubpaths = false) {
    const outDir = path.join(work, label);
    const moduleIds = new Set();
    let failure;
    const moduleProof = () => ({ name: "installed-first-map-module-proof", generateBundle() {
      for (const id of this.getModuleIds()) moduleIds.add(id);
    } });
    try {
      await build({ ...loaded.config, configFile: false, logLevel: "warn",
        resolve: { ...loaded.config.resolve, alias: loaded.config.resolve.alias.filter((alias) =>
          !removePeerAlias || !(alias.find instanceof RegExp &&
            (alias.find.test("maplibre-gl") || alias.find.test("maplibre-gl/dist/maplibre-gl-worker.mjs"))))
          .filter((alias) => !removePeerSubpaths || !(alias.find instanceof RegExp && alias.find.test("maplibre-gl/dist/maplibre-gl-worker.mjs"))) },
        plugins: [...loaded.config.plugins, moduleProof()],
        worker: { ...loaded.config.worker, plugins: () => [moduleProof()] },
        build: { ...loaded.config.build, outDir, emptyOutDir: true },
      });
    } catch (error) { failure = error.message; }
    const resolution = JSON.parse(await readFile(path.join(outDir, "honua-sample-sdk-resolution.json"), "utf8"));
    // Match the existing generateBundle budget's chunk scope. Worker scripts
    // emitted as assets remain in the final-byte inventory, not this ceiling.
    let javascriptBytes = 0;
    let javascriptGzipBytes = 0;
    for (const entry of resolution.bundle.filter((entry) => entry.kind === "chunk")) {
      const bytes = await readFile(path.join(outDir, entry.fileName));
      javascriptBytes += bytes.length;
      javascriptGzipBytes += gzipSync(bytes).length;
    }
    assert.equal(resolution.mode, "packed");
    const sdkModules = [...moduleIds].filter((id) => id.includes("/node_modules/@honua/sdk-js/"));
    assert.ok(sdkModules.length > 0, "bundle must execute installed SDK modules");
    assert.ok(sdkModules.every((id) => id.startsWith(process.env.HONUA_SAMPLE_SDK_DIR + "/")), "SDK modules must belong to the isolated install");
    assert.ok(![...moduleIds].some((id) => id.startsWith(root + "/src/")), "repository SDK source must not enter the bundle");
    return { buildStatus: failure ? "failed" : "passed", ...(failure ? { diagnostic: failure } : {}),
      measurement: { javascriptBytes, javascriptGzipBytes },
      maplibreModules: [...moduleIds].filter((id) => /maplibre-gl\/dist\/maplibre-gl\.(mjs|js)$/.test(id))
        .map((id) => id.replace(work, "$CONSUMER").replace(root, "$REPOSITORY")),
      maplibreFiles: [...moduleIds].filter((id) => id.includes("/node_modules/maplibre-gl/"))
        .map((id) => id.replace(work, "$CONSUMER").replace(root, "$REPOSITORY")).sort(),
      resolutionDigest: sha256(JSON.stringify(resolution)), installedSdkModules: sdkModules.length };
  }

  const baseline = proveRegression ? await measure("baseline", true) : undefined;
  const runtimeOnly = proveRegression ? await measure("runtime-only", false, true) : undefined;
  const corrected = await measure("corrected");
  for (const observed of [baseline, runtimeOnly, corrected].filter(Boolean)) {
    try { assertPeerIdentity(observed); observed.peerIdentityStatus = "passed"; }
    catch { observed.peerIdentityStatus = "failed"; }
    observed.status = observed.buildStatus === "passed" && observed.peerIdentityStatus === "passed" ? "passed" : "failed";
  }
  const budget = { javascriptBytes: 1_990_000, javascriptGzipBytes: 524_000 };
  const receipt = { schema: "honua.installed-first-map-budget/v1", generatedAt: new Date().toISOString(),
    scope: "installed-package bundle regression; no live-server or release certification claim",
    package: { ...candidate.package, resolved: installed.resolved },
    consumerLockSha256: sha256(lockBytes),
    dependencies: Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key).map(([key, value]) =>
      [key, { version: value.version, integrity: value.integrity }])),
    sourceSha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    budget, measurementScope: "emitted JavaScript chunks, as defined by the canonical First Map budget",
    node: process.version, status: corrected.status, ...(baseline ? { baseline, runtimeOnly } : {}), corrected };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ baseline, runtimeOnly, corrected, output }, null, 2));
  if (baseline) {
    assert.equal(baseline.buildStatus, "failed", "removing the peer fix must reproduce the historical failure");
    assert.match(baseline.diagnostic, /First Map JavaScript bundle .* exceeds/);
    assert.equal(baseline.maplibreModules.length, 2, "baseline must retain both MapLibre copies");
  }
  assert.equal(corrected.buildStatus, "passed", corrected.diagnostic);
  assert.ok(corrected.measurement.javascriptBytes <= budget.javascriptBytes, "written chunks exceed the existing JavaScript ceiling");
  assert.ok(corrected.measurement.javascriptGzipBytes <= budget.javascriptGzipBytes, "written chunks exceed the existing gzip ceiling");
  assert.equal(corrected.maplibreModules.length, 1, "corrected bundle must contain one MapLibre runtime");
  function assertPeerIdentity(observed) {
  assert.ok(observed.maplibreFiles.every((id) => id.startsWith("$CONSUMER/node_modules/maplibre-gl/")),
    "runtime, worker and CSS must all come from the installed peer");
  assert.ok(observed.maplibreFiles.some((id) => id.endsWith("/maplibre-gl-worker.mjs")), "the installed worker must be built");
  assert.ok(observed.maplibreFiles.some((id) => id.endsWith("/maplibre-gl.css")), "the installed stylesheet must be built");

  }
  if (runtimeOnly) {
    assert.equal(runtimeOnly.buildStatus, "passed", "the runtime-only build illustrates why the byte budget is insufficient");
    assert.throws(() => assertPeerIdentity(runtimeOnly), /runtime, worker and CSS must all come from the installed peer/);
  }
  assertPeerIdentity(corrected);

} finally {
  if (previousMode === undefined) delete process.env.HONUA_SAMPLE_SDK_MODE;
  else process.env.HONUA_SAMPLE_SDK_MODE = previousMode;
  if (previousDirectory === undefined) delete process.env.HONUA_SAMPLE_SDK_DIR;
  else process.env.HONUA_SAMPLE_SDK_DIR = previousDirectory;
  await rm(work, { recursive: true, force: true });
}
