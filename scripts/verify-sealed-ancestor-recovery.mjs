#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRecoveryRecord, validateRecoverySnapshot } from "./lib/sealed-ancestor-recovery.mjs";

const [tag, source] = process.argv.slice(2);
assert.equal(process.argv.length, 4, "expected tag and exact sealed source");
assert.match(tag ?? "", /^js-sdk-v\d+\.\d+\.\d+$/);
assert.match(source ?? "", /^[a-f0-9]{40}$/);
const repository = process.env.GITHUB_REPOSITORY;
const record = JSON.parse(fs.readFileSync(`config/release-recoveries/${tag}.json`, "utf8"));
validateRecoveryRecord(record, { tag, source, repository });
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const api = (route) => JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${route}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const jobs = (run) => {
  const rows = [];
  for (let page = 1; ; page++) {
    const result = api(`actions/runs/${run}/jobs?filter=latest&per_page=100&page=${page}`);
    rows.push(...result.jobs);
    if (rows.length >= result.total_count) return rows;
  }
};
const contains = (ancestor, descendant) => git("merge-base", ancestor, descendant) === ancestor;
const jsonAt = (revision, file) => JSON.parse(git("show", `${revision}:${file}`));
const identity = (revision) => {
  const sdk = jsonAt(revision, "package.json");
  const mcp = jsonAt(revision, "mcp/package.json");
  const scaffold = jsonAt(revision, "packages/create-honua-app/package.json");
  const lock = jsonAt(revision, "package-lock.json");
  const manifest = jsonAt(revision, ".release-please-manifest.json");
  assert.equal(mcp.version, manifest.mcp);
  assert.equal(scaffold.version, manifest["packages/create-honua-app"]);
  return { version: sdk.version, manifest, lockVersion: lock.version, lockRootVersion: lock.packages[""].version,
    nodeVersion: git("show", `${revision}:.nvmrc`), engines: [sdk.engines.node, mcp.engines.node, scaffold.engines.node] };
};
const trunk = api("git/ref/heads/trunk").object.sha;
assert.equal(trunk, process.env.GITHUB_SHA, "recovery must execute at exact current trunk");
const artifact = api(`actions/artifacts/${record.generationArtifactId}`);
const archive = execFileSync("gh", ["api", `repos/${repository}/actions/artifacts/${record.generationArtifactId}/zip`], { maxBuffer: 32 * 1024 * 1024 });
assert.equal(createHash("sha256").update(archive).digest("hex"), record.generationArtifactSha256, "archive digest differs from reviewed record");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "honua-sealed-recovery-"));
try {
  const archivePath = path.join(temp, "artifact.zip");
  const bundle = path.join(temp, "derived-artifacts.bundle");
  fs.writeFileSync(archivePath, archive);
  // Read only the one expected bundle; never extract arbitrary archive paths.
  execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); assert names==['derived-artifacts.bundle']; assert z.getinfo(names[0]).file_size<32*1024*1024; data=z.read(names[0]); open(sys.argv[2],'wb').write(data)", archivePath, bundle]);
  git("bundle", "verify", bundle);
  const bundleLine = git("bundle", "list-heads", bundle);
  assert.match(bundleLine, /^[a-f0-9]{40} refs\/heads\/derived-artifacts-output$/);
  const tags = api(`git/matching-refs/tags/${tag}`).filter((ref) => ref.ref === `refs/tags/${tag}`);
  assert.ok(tags.length <= 1);
  const snapshot = {
    release: api(`releases/${record.releaseId}`),
    currentTrunkContainsSource: contains(source, trunk),
    managedContainsBase: contains(record.managedSource, record.generationBase),
    baseContainsSource: contains(record.generationBase, source),
    subjects: git("log", "--format=%s", `${record.generationBase}..${source}`).split("\n"),
    paths: git("diff", "--name-only", `${record.generationBase}..${source}`).split("\n"),
    existingTag: tags.length === 0 ? null : api(`commits/${tag}`).sha,
    identities: [record.managedSource, record.generationBase, source].map(identity),
    strict: api(`actions/runs/${record.strictRunId}`), strictJobs: jobs(record.strictRunId),
    native: api(`actions/runs/${record.nativeRunId}`), nativeJobs: jobs(record.nativeRunId),
    generation: api(`actions/runs/${record.generationRunId}`), generationJobs: jobs(record.generationRunId),
    artifact, archiveDigest: createHash("sha256").update(archive).digest("hex"), bundleSource: bundleLine.split(" ")[0],
  };
  validateRecoverySnapshot(record, snapshot);
  const receipt = { schemaVersion: "honua.sealed-ancestor-recovery-verification/v1", record, trunk, verifiedAt: new Date().toISOString(), snapshot };
  fs.mkdirSync(".tmp/release-recovery", { recursive: true });
  fs.writeFileSync(".tmp/release-recovery/verification.json", `${JSON.stringify(receipt, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `node_version=${record.nodeVersion}\nversion=${record.version}\nsource=${source}\n`);
  console.log(`Verified canonical generated ancestor ${source} for ${tag}; fresh release-seal check is still required before tag creation.`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
