#!/usr/bin/env node
// Reuse the reviewed default-CLI proof, with fresh public publication verification.
// Product packages always come from npm; repository code supplies only the test harness.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { receiptJson, verifyPublishedRelease } from "./verify-published-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = process.argv[2];
assert.ok(["vanilla-ts", "react-ts"].includes(template), "Select one maintained template");
assert.match(process.version, /^v22\./);
const output = path.join(root, "test-results/published-default");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output, { recursive: false });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cohortBytes = fs.readFileSync(path.join(root, "config/published-scaffold-qualification.v1.json"));
const cohort = JSON.parse(cohortBytes);
assert.equal(cohort.schemaVersion, 1);
assert.equal(cohort.repository, "honua-io/honua-sdk-js");
fs.writeFileSync(path.join(output, "cohort.json"), cohortBytes);
const producerRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
fs.writeFileSync(path.join(output, "runner.json"), `${JSON.stringify({
  producerRevision, node: process.version, platform: process.platform, architecture: process.arch,
  release: os.release(), cpus: os.cpus().length, availableParallelism: os.availableParallelism(),
  runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  cohortSha256: hash(cohortBytes), installedServerQualification: false,
}, null, 2)}\n`);
const publication = await verifyPublishedRelease({
  targets: [cohort.sdk, cohort.scaffold], sealedTag: cohort.sdk.tag, sealedCommit: cohort.sdk.commit,
  repository: cohort.repository, selection: "exact-version",
});
const receiptBytes = Buffer.from(receiptJson(publication));
const receiptPath = path.join(output, "published-release-verification.v1.json");
fs.writeFileSync(receiptPath, receiptBytes);
assert.equal(publication.status, "verified", JSON.stringify(publication.failures));
const harnessBytes = fs.readFileSync(path.join(root,
  "packages/create-honua-app/evidence/default-022/published-default-proof.mjs.raw"));
assert.equal(hash(harnessBytes), "076d13877b9e55c4a169bd59064c4daaa26d485e612dbebcb23035e24dfc7ab9");
const harness = path.join(output, "published-default-proof.mjs");
fs.writeFileSync(harness, harnessBytes);
const identity = (target) => ({
  version: target.version, sourceRevision: target.commit, receiptPath, receiptSha256: hash(receiptBytes),
});
const config = {
  repoRoot: root, producerRevision, template, outputDirectory: path.join(output, template),
  sdk: identity(cohort.sdk), scaffold: identity(cohort.scaffold),
};
const configPath = path.join(output, "execution-config.json");
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const result = spawnSync(process.execPath, [harness, configPath], {
  cwd: root, env: process.env, stdio: "inherit", timeout: 480_000,
});
fs.writeFileSync(path.join(output, "execution-outcome.json"), `${JSON.stringify({
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
}, null, 2)}\n`);
process.exitCode = result.status === 0 && !result.error ? 0 : 1;
