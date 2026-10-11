#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { build, loadConfigFromFile, normalizePath } from "vite";
import { runNpmSync } from "./lib/npm-cli.mjs";
import { verifyPreparedSdkArtifact } from "./lib/prepared-sdk-artifact.mjs";
import { packedSdkFilename, assertComparisonDependencies, assertInstalledConsumerModules } from "./lib/installed-consumer-lock.mjs";
import { INSTALLED_FIRST_MAP_BUDGET, firstMapVerdict } from "./lib/first-map-budget.mjs";
import { readInstalledCandidateInput } from "./installed-candidate-input.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const sourceDirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim().length > 0;
const localTarball = process.argv.includes("--local-tarball");
const consumerLockIndex = process.argv.indexOf("--consumer-lock");
if (consumerLockIndex >= 0) assert.ok(process.argv[consumerLockIndex + 1] && !process.argv[consumerLockIndex + 1].startsWith("--"), "--consumer-lock requires a path");
const previousLockBytes = consumerLockIndex < 0 ? undefined : await readFile(path.resolve(root, process.argv[consumerLockIndex + 1]));
const previousRenderer = previousLockBytes ? JSON.parse(previousLockBytes).packages?.["node_modules/maplibre-gl"] : undefined;
if (previousLockBytes) assert.ok(previousRenderer?.version && previousRenderer?.integrity, "comparison lock must bind the installed MapLibre version and integrity");
await mkdir(path.join(root, "test-results"), { recursive: true });
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(root, outputIndex < 0 ? "test-results/installed-quickstart-budget.json" : process.argv[outputIndex + 1]);
await rm(output, { force: true });
assert.ok(!(localTarball && process.env.HONUA_INSTALLED_CANDIDATE_MODE === "release-snapshot"),
  "release-snapshot cannot be combined with --local-tarball");
const candidate = await readInstalledCandidateInput();
const work = await mkdtemp(path.join(tmpdir(), "honua-installed-first-map-"));
const proveRegression = process.argv.includes("--prove-regression");
const enforceExecution = process.argv.includes("--enforce-execution-budget");
const measureExecution = enforceExecution || process.argv.includes("--measure-execution");
const fixtureDefines = measureExecution ? Object.fromEntries(Object.entries(
  (await import("../examples/maplibre-quickstart/mock-server.mjs")).FIXTURE_BUILD_ENV
).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])) : {};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const previousMode = process.env.HONUA_SAMPLE_SDK_MODE;
const previousDirectory = process.env.HONUA_SAMPLE_SDK_DIR;

try {
  let packageIdentity = candidate.package;
  let packageSpec = candidate.package.version;
  let prepared;
  if (localTarball) {
    prepared = verifyPreparedSdkArtifact({ projectRoot: root });
    const destination = path.join(work, "packed-input");
    await mkdir(destination);
    const result = runNpmSync(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: root, encoding: "utf8", timeout: 120_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const [packed] = JSON.parse(result.stdout);
    assert.equal(packed.name, candidate.package.coordinate, "development tarball must be the SDK package");
    const originalTarball = path.join(destination, packed.filename);
    const bytes = await readFile(originalTarball);
    const tarball = path.join(destination, packedSdkFilename(bytes));
    await rename(originalTarball, tarball);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    assert.equal(integrity, packed.integrity, "packed bytes must match reported integrity");
    packageIdentity = { coordinate: packed.name, version: packed.version, integrity };
    packageSpec = pathToFileURL(tarball).href;
  }
  await writeFile(path.join(work, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
    [candidate.package.coordinate]: packageSpec,
    ...candidate.consumerDependencies,
  } }));
  if (previousLockBytes) await writeFile(path.join(work, "package-lock.json"), previousLockBytes);
  for (const args of [["install", "--package-lock-only"], ["ci"]]) {
    const result = runNpmSync([...args, "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${candidate.package.registry}`],
      { cwd: work, encoding: "utf8", windowsHide: true, timeout: 300_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const lockBytes = await readFile(path.join(work, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  const installed = lock.packages[`node_modules/${candidate.package.coordinate}`];
  assert.equal(installed.version, packageIdentity.version, "installed version must match candidate");
  assert.equal(installed.integrity, packageIdentity.integrity, "installed tarball integrity must match candidate");
  if (previousLockBytes) assertComparisonDependencies(JSON.parse(previousLockBytes), lock, candidate.package.coordinate);
  if (previousRenderer) {
    const renderer = lock.packages["node_modules/maplibre-gl"];
    assert.equal(renderer.version, previousRenderer.version, "comparison must preserve installed renderer version");
    assert.equal(renderer.integrity, previousRenderer.integrity, "comparison must preserve installed renderer bytes");
  }
  assert.ok(!installed.link, "the installed SDK must not be a workspace link");
  process.env.HONUA_SAMPLE_SDK_MODE = "packed";
  process.env.HONUA_SAMPLE_SDK_DIR = path.join(work, "node_modules", candidate.package.coordinate);
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" },
    path.join(root, "examples/maplibre-quickstart/vite.config.ts"));
  assert.ok(loaded, "canonical First Map config must load");

  async function measure(label, removePeerAlias = false, removePeerSubpaths = false, fixtureBuild = false) {
    const outDir = path.join(work, label);
    const moduleIds = new Set();
    const renderedModules = new Map();
    const workerRenderedModules = new Map();
    let failure;
    let effectiveMinifier;
    const moduleProof = (worker = false) => ({ name: "installed-first-map-module-proof",
      configResolved(config) { effectiveMinifier ??= config.build.minify; }, generateBundle(_options, bundle) {
      for (const id of this.getModuleIds()) moduleIds.add(normalizePath(id));
      for (const chunk of Object.values(bundle).filter((entry) => entry.type === "chunk")) {
        for (const [id, module] of Object.entries(chunk.modules)) {
          const inventory = worker ? workerRenderedModules : renderedModules;
          inventory.set(normalizePath(id), (inventory.get(normalizePath(id)) ?? 0) + module.renderedLength);
        }
      }
    } });
    try {
      await build({ ...loaded.config, configFile: false, logLevel: "warn",
        define: { ...loaded.config.define, ...(fixtureBuild ? fixtureDefines : {}) },
        resolve: { ...loaded.config.resolve, alias: loaded.config.resolve.alias.filter((alias) =>
          !removePeerAlias || !(alias.find instanceof RegExp &&
            (alias.find.test("maplibre-gl") || alias.find.test("maplibre-gl/dist/maplibre-gl-worker.mjs"))))
          .filter((alias) => !removePeerSubpaths || !(alias.find instanceof RegExp && alias.find.test("maplibre-gl/dist/maplibre-gl-worker.mjs"))) },
        plugins: [...loaded.config.plugins, moduleProof()],
        worker: { ...loaded.config.worker, plugins: () => [moduleProof(true)] },
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
    assert.ok(sdkModules.every((id) => id.startsWith(normalizePath(process.env.HONUA_SAMPLE_SDK_DIR) + "/")), "SDK modules must belong to the isolated install");
    assert.ok(![...moduleIds].some((id) => id.startsWith(normalizePath(root) + "/src/")), "repository SDK source must not enter the bundle");
    return { minifier: effectiveMinifier, buildStatus: failure ? "failed" : "passed", ...(failure ? { diagnostic: failure } : {}),
      measurement: { javascriptBytes, javascriptGzipBytes },
      runtimeDependencyModules: [...renderedModules].filter(([id, bytes]) => bytes > 0 && id.includes("/node_modules/"))
        .map(([id]) => id.replace(normalizePath(work), "$CONSUMER")),
      workerRuntimeDependencyModules: [...workerRenderedModules].filter(([id, bytes]) => bytes > 0 && id.includes("/node_modules/"))
        .map(([id]) => id.replace(normalizePath(work), "$CONSUMER")),
      maplibreModules: [...moduleIds].filter((id) => /maplibre-gl\/dist\/maplibre-gl\.(mjs|js)$/.test(id))
        .map((id) => id.replace(normalizePath(work), "$CONSUMER").replace(normalizePath(root), "$REPOSITORY")),
      maplibreFiles: [...moduleIds].filter((id) => id.includes("/node_modules/maplibre-gl/"))
        .map((id) => id.replace(normalizePath(work), "$CONSUMER").replace(normalizePath(root), "$REPOSITORY")).sort(),
      resolutionDigest: sha256(JSON.stringify(resolution)), installedSdkModules: sdkModules.length,
      largestSdkModules: [...renderedModules].filter(([id]) => id.includes("/node_modules/@honua/sdk-js/"))
        .sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id, renderedBytes]) => ({
          module: id.replace(normalizePath(work), "$CONSUMER").replace(normalizePath(root), "$REPOSITORY"), renderedBytes })) };
  }

  const baseline = proveRegression ? await measure("baseline", true) : undefined;
  const runtimeOnly = proveRegression ? await measure("runtime-only", false, true) : undefined;
  const corrected = await measure("corrected");
  for (const observed of [baseline, runtimeOnly, corrected].filter(Boolean)) {
    try { assertPeerIdentity(observed); observed.peerIdentityStatus = "passed"; }
    catch { observed.peerIdentityStatus = "failed"; }
    Object.assign(observed, firstMapVerdict(observed));
  }
  let execution;
  if (measureExecution) {
    try {
      const { measureFirstMapExecution } = await import("./lib/first-map-execution.mjs");
      const fixture = await measure("execution-fixture", false, false, true);
      assert.equal(fixture.buildStatus, "passed", fixture.diagnostic);
      assertPeerIdentity(fixture);
      assert.equal(fixture.maplibreModules.length, 1, "CPU fixture must use one installed renderer");
      fixture.peerIdentityStatus = "passed";
      Object.assign(fixture, firstMapVerdict(fixture));
      execution = { status: "pending", buildMode: "canonical fixture", bundle: fixture };
      Object.assign(execution, await measureFirstMapExecution(path.join(work, "execution-fixture")), { status: "measured" });
      if (enforceExecution) {
        const { firstMapExecutionVerdict } = await import("./lib/first-map-execution-budget.mjs");
        const executionBudget = JSON.parse(await readFile(path.join(root, "config/first-map-execution-budget.v1.json"), "utf8"));
        execution.verdict = firstMapExecutionVerdict(execution, executionBudget);
        assert.equal(execution.verdict.status, "passed", execution.verdict.violations.join("; "));
      }
    } catch (error) { execution = { ...execution, status: "failed", diagnostic: error.message }; }
  }
  const budget = INSTALLED_FIRST_MAP_BUDGET;
  const receipt = { schema: "honua.installed-first-map-budget/v1", generatedAt: new Date().toISOString(),
    scope: localTarball ? "packed-development bundle benchmark; no registry, candidate or release certification claim" : `declared ${candidate.package.version === "0.1.9-beta.0" ? "legacy " : ""}registry candidate bundle regression; current release lineage and certification not asserted`,
    inputMode: localTarball ? "packed-development" : "declared-registry-candidate",
    ...(prepared ? { packedDevelopment: { sourceSha, sourceDirty, inputsSha256: prepared.inputs.sha256, distSha256: prepared.dist.sha256 } } : {}),
    ...(candidate.releaseInput ? { releaseInput: candidate.releaseInput } : {}),
    package: { ...packageIdentity, resolved: localTarball ? "$PACKED_DEVELOPMENT_TARBALL" : installed.resolved },
    consumerLockSha256: sha256(lockBytes),
    dependencies: Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key).map(([key, value]) =>
      [key, { version: value.version, integrity: value.integrity }])),
    sourceSha, sourceDirty,
    ...(previousLockBytes ? { comparisonLockSha256: sha256(previousLockBytes), comparisonRenderer: { version: previousRenderer.version, integrity: previousRenderer.integrity } } : {}),
    inputDigests: Object.fromEntries(await Promise.all(["package-lock.json", "scripts/installed-quickstart-budget.mjs",
      "scripts/lib/first-map-execution.mjs", "scripts/lib/first-map-execution-budget.mjs", "config/first-map-execution-budget.v1.json", "examples/maplibre-quickstart/mock-server.mjs", "examples/maplibre-quickstart/vite.config.ts"]
      .map(async (file) => [file, sha256(await readFile(path.join(root, file)))]))),
    budget, minifier: corrected.minifier, buildMode: "default public endpoint", measurementScope: "emitted JavaScript chunks, as defined by the canonical First Map budget",
    node: process.version, ...(execution ? { execution } : {}), status: execution?.status === "failed" ? "failed" : corrected.status, ...(baseline ? { baseline, runtimeOnly } : {}), corrected };
  await mkdir(path.dirname(output), { recursive: true });
  const lockOutput = output.endsWith(".json") ? output.slice(0, -5) + ".consumer-lock.json" : output + ".consumer-lock.json";
  await writeFile(lockOutput, lockBytes);
  receipt.consumerLockFile = path.basename(lockOutput);
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ baseline, runtimeOnly, corrected, output }, null, 2));
  if (baseline) {
    assert.equal(baseline.buildStatus, "failed", "removing the peer fix must reproduce the historical failure");
    assert.match(baseline.diagnostic, /First Map JavaScript bundle .* exceeds/);
    assert.equal(baseline.maplibreModules.length, 2, "baseline must retain both MapLibre copies");
  }
  if (execution) assert.equal(execution.status, "measured", execution.diagnostic);
  assert.equal(corrected.buildStatus, "passed", corrected.diagnostic);
  assert.ok(corrected.measurement.javascriptBytes <= budget.javascriptBytes, "written chunks exceed the existing JavaScript ceiling");
  assert.ok(corrected.measurement.javascriptGzipBytes <= budget.javascriptGzipBytes, "written chunks exceed the existing gzip ceiling");
  assert.equal(corrected.maplibreModules.length, 1, "corrected bundle must contain one MapLibre runtime");
  function assertPeerIdentity(observed) {
  assert.ok(observed.maplibreFiles.every((id) => id.startsWith("$CONSUMER/node_modules/maplibre-gl/")),
    "runtime, worker and CSS must all come from the installed peer");
  assert.ok(observed.maplibreFiles.some((id) => id.endsWith("/maplibre-gl-worker.mjs")), "the installed worker must be built");
  assert.ok(observed.maplibreFiles.some((id) => id.endsWith("/maplibre-gl.css")), "the installed stylesheet must be built");
  assertInstalledConsumerModules([...observed.runtimeDependencyModules, ...observed.workerRuntimeDependencyModules], "$CONSUMER");
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
