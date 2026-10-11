#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRuntimeTarball, missingBrowserArtifactFiles } from "./lib/runtime-tarball.mjs";
import { runNpmSync } from "./lib/npm-cli.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const policy = JSON.parse(await readFile(path.join(root, "config/runtime-tarball-budget.v1.json"), "utf8"));
for (const [metric, limit] of Object.entries(policy.ceiling)) {
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit < policy.baseline[metric], `${metric}: runtime ceiling must remain below the audited baseline`);
}
const output = path.join(root, "test-results/runtime-tarball-budget.json");
await mkdir(path.dirname(output), { recursive: true });
const work = await mkdtemp(path.join(tmpdir(), "honua-runtime-tarball-"));
try {
  const result = runNpmSync(["pack", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: root, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [packed] = JSON.parse(result.stdout);
  const inventory = spawnSync("tar", ["-xOf", path.join(work, packed.filename), "package/dist/browser/honua-sdk.browser-artifacts.v1.json"], { encoding: "utf8" });
  assert.equal(inventory.status, 0, "packed runtime is missing the browser artifact manifest");
  assert.deepEqual(missingBrowserArtifactFiles(packed, JSON.parse(inventory.stdout)), [],
    "browser artifact inventory names files absent from the packed runtime");
  const verdict = evaluateRuntimeTarball(packed, policy);
  const receipt = { schema: "honua.runtime-tarball-budget/v1", ...verdict, package: { name: packed.name, version: packed.version, integrity: packed.integrity },
    sourceSha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    sourceDirty: spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim().length > 0,
    node: process.version, npm: runNpmSync(["--version"], { encoding: "utf8" }).stdout.trim(), baseline: policy.baseline, ceiling: policy.ceiling };
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
  assert.deepEqual(verdict.forbidden, [], "runtime tarball contains undocumented or non-runtime files");
  assert.deepEqual(verdict.missing, [], "runtime tarball is missing required runtime or metadata files");
  assert.equal(verdict.status, "passed", "runtime tarball exceeds the reduced distribution budget");
} finally {
  await rm(work, { recursive: true, force: true });
}
