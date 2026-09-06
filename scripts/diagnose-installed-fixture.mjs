// Fixture-oracle diagnostic only. This cannot emit a release certification receipt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freezeCertification, validateInstalledLock } from "./installed-certification-identity.mjs";
import { executeCandidateFixture } from "./installed-candidate-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = process.argv[2];
assert.ok(output, "usage: node scripts/diagnose-installed-fixture.mjs <diagnostic.json>");
const candidate = JSON.parse(await readFile(path.join(root, "config/installed-package-certification.v1.json")));
const denominator = JSON.parse(await readFile(path.join(root, "config/certification-denominator.v1.json")));
const binding = await freezeCertification(candidate, denominator, root);
const work = await mkdtemp(path.join(tmpdir(), "sdk39-diagnostic-"));
try {
  await writeFile(path.join(work, "package.json"), JSON.stringify({ private: true, type: "module",
    dependencies: Object.fromEntries(candidate.packages.map((p) => [p.coordinate, p.version])) }));
  const installed = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    `--registry=${candidate.package.registry}`], { cwd: work, encoding: "utf8", timeout: 240_000 });
  assert.equal(installed.status, 0, installed.stderr);
  const lock = JSON.parse(await readFile(path.join(work, "package-lock.json")));
  const installedRoot = lock.packages["node_modules/@honua/sdk-js"];
  assert.equal(installedRoot.integrity, candidate.package.integrity);
  assert.equal(installedRoot.version, candidate.package.version);
  assert.equal(installedRoot.resolved, candidate.packages.find((p) => p.coordinate === "@honua/sdk-js").tarball);
  let candidateSet;
  try {
    validateInstalledLock(candidate, lock);
    candidateSet = { status: "identity-matched" };
  } catch (error) {
    candidateSet = { status: "failed", diagnostic: error.message };
  }
  const result = await executeCandidateFixture({ candidate, work, root });
  await writeFile(output, `${JSON.stringify({ mode: "harness-diagnostic-only", generatedAt: new Date().toISOString(),
    binding, installedRoot, node: process.version, candidateSet,
    reason: "Fixture oracle check only; not a package-set certification receipt.", ...result }, null, 2)}\n`);
  console.log(`Harness diagnostic only: ${result.observations.filter((row) => row.verdict === "pass").length} pass; ${output}`);
  if (result.observations.some((row) => row.verdict !== "pass")) process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
