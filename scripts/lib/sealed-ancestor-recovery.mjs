import assert from "node:assert/strict";

import { isGeneratedReleasePath } from "./generated-release-paths.mjs";

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function validateRecoveryRecord(record, { tag, source, repository }) {
  assert.equal(record.schemaVersion, "honua.sealed-ancestor-recovery/v1");
  assert.equal(repository, "honua-io/honua-sdk-js");
  assert.equal(record.repository, repository);
  assert.match(record.version, VERSION);
  assert.equal(tag, `js-sdk-v${record.version}`);
  assert.equal(record.tag, tag);
  assert.match(source, SHA);
  assert.equal(record.sealedSource, source);
  for (const key of ["managedSource", "generationBase", "sealedSource"]) assert.match(record[key], SHA);
  for (const key of ["releaseId", "generationRunId", "generationArtifactId", "strictRunId", "nativeRunId", "minimumNativeAttempt"])
    assert.ok(Number.isSafeInteger(record[key]) && record[key] > 0, `invalid ${key}`);
  assert.match(record.generationArtifactSha256, /^[a-f0-9]{64}$/);
  assert.match(record.nodeVersion, VERSION);
  const engineFloor = /^>=(\d+\.\d+\.\d+)$/.exec(record.nodeEngine)?.[1];
  assert.ok(engineFloor, "invalid nodeEngine");
  assert.ok(compareVersions(record.nodeVersion, engineFloor) >= 0, "nodeVersion is below the nodeEngine floor");
  if (record.sdkVerificationRunId !== undefined)
    assert.ok(Number.isSafeInteger(record.sdkVerificationRunId) && record.sdkVerificationRunId > 0, "invalid sdkVerificationRunId");
}

function compareVersions(left, right) {
  const [a, b] = [left, right].map((version) => version.split(".").map(Number));
  return a.map((part, index) => part - b[index]).find((difference) => difference !== 0) ?? 0;
}

const SDK_VERIFICATION_REQUIRED_JOBS = ["SDK build (producer)", "Verify: core, types, style, coverage",
  "Verify: merged unit coverage", "Verify: MCP", "SDK verified"];

function assertSdkVerification(record, snapshot) {
  for (const name of ["JS SDK", "MCP SDK"])
    assert.ok(snapshot.nativeJobs.some((job) => job.name === name && job.conclusion === "skipped"), `native ${name} must be skipped when SDK Verification is the proof`);
  successfulRun(snapshot.verification, record.sdkVerificationRunId, record.sealedSource, "pull_request", ".github/workflows/sdk-verification.yml");
  const jobs = snapshot.verificationJobs;
  assert.ok(jobs.every((job) => job.conclusion === "success"), "every SDK Verification job must succeed");
  for (const name of SDK_VERIFICATION_REQUIRED_JOBS)
    assert.ok(jobs.some((job) => job.name === name), `missing SDK Verification ${name}`);
  assert.ok(jobs.some((job) => job.name.startsWith("Browser (")), "missing SDK Verification browser job");
}

function successfulRun(run, id, source, event, path) {
  assert.equal(run.id, id);
  assert.equal(run.head_sha, source);
  assert.equal(run.event, event);
  assert.equal(run.path, path);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.repository.full_name, "honua-io/honua-sdk-js");
  assert.equal(run.head_repository.full_name, "honua-io/honua-sdk-js");
}

function assertExactSourceCi(record, snapshot) {
  successfulRun(snapshot.strict, record.strictRunId, record.sealedSource, "workflow_dispatch", ".github/workflows/ci.yml");
  successfulRun(snapshot.native, record.nativeRunId, record.sealedSource, "pull_request", ".github/workflows/ci.yml");
  assert.ok(snapshot.native.run_attempt >= record.minimumNativeAttempt);
  // In authoritative verification mode, pull_request SDK CI skips the JS and MCP SDK
  // jobs and the SDK Verification run on the same source carries that proof.
  const sdkVerified = record.sdkVerificationRunId !== undefined;
  const nativeSdkJobs = sdkVerified ? [] : ["JS SDK", "MCP SDK"];
  const gates = [[snapshot.strictJobs, ["JS SDK", "MCP SDK", "Deterministic Benchmark Lab"]],
    [snapshot.nativeJobs, [...nativeSdkJobs, "Deterministic Benchmark Lab", "PR Fast (under 2 minutes)"]]];
  for (const [jobs, names] of gates) {
    for (const name of names) assert.ok(jobs.some((job) => job.name === name && job.conclusion === "success"), `missing successful ${name}`);
    if (!names.includes("JS SDK")) continue;
    const sdk = jobs.find((job) => job.name === "JS SDK");
    for (const name of ["Unit tests with coverage", "Browser smoke suite", "Deterministic browser rendering benchmark"])
      assert.ok(sdk.steps.some((step) => step.name === name && step.conclusion === "success"), `missing actual ${name}`);
  }
  if (sdkVerified) assertSdkVerification(record, snapshot);
}

export function validateRecoverySnapshot(record, snapshot) {
  assert.equal(snapshot.release.id, record.releaseId);
  assert.equal(snapshot.release.tag_name, record.tag);
  assert.equal(snapshot.release.target_commitish, record.managedSource);
  assert.equal(snapshot.release.draft, true);
  assert.equal(snapshot.release.immutable, false);
  assert.ok(snapshot.currentTrunkContainsSource, "sealed source must be an ancestor of current trunk");
  assert.ok(snapshot.managedContainsBase, "generation base must descend from managed release");
  assert.ok(snapshot.baseContainsSource, "generated source must descend from generation base");
  assert.ok(snapshot.subjects.length >= 1 && snapshot.subjects.length <= 4);
  assert.ok(snapshot.subjects.every((subject) => subject.startsWith("chore(evidence): regenerate derived artifacts")));
  assert.ok(snapshot.paths.length > 0);
  assert.ok(snapshot.paths.every(isGeneratedReleasePath), "non-generated candidate change");
  assert.ok(snapshot.existingTag === null || snapshot.existingTag === record.sealedSource, "immutable tag cannot be replaced");
  for (const identity of snapshot.identities) {
    assert.equal(identity.version, record.version);
    assert.equal(identity.manifest["."], record.version);
    assert.equal(identity.lockVersion, record.version);
    assert.equal(identity.lockRootVersion, record.version);
    assert.equal(identity.nodeVersion, record.nodeVersion);
    assert.deepEqual(identity.engines, [record.nodeEngine, record.nodeEngine, record.nodeEngine]);
  }
  assert.equal(snapshot.identities.length, 3);
  assert.deepEqual(snapshot.identities[0].manifest, snapshot.identities[1].manifest);
  assert.deepEqual(snapshot.identities[0].manifest, snapshot.identities[2].manifest);
  assertExactSourceCi(record, snapshot);
  const generation = snapshot.generation;
  assert.equal(generation.id, record.generationRunId);
  assert.equal(generation.head_sha, record.generationBase);
  assert.equal(generation.head_branch, "trunk");
  assert.equal(generation.path, ".github/workflows/regenerate-derived-artifacts.yml");
  assert.equal(generation.repository.full_name, record.repository);
  assert.equal(generation.head_repository.full_name, record.repository);
  assert.equal(generation.status, "completed");
  assert.ok(["workflow_dispatch", "push", "schedule"].includes(generation.event));
  // The write-enabled publisher failed on the original native check. Admit only
  // the separately successful canonical producer, then require current native CI above.
  const producer = snapshot.generationJobs.find((job) => job.name === "Regenerate + reseal on trunk");
  assert.equal(producer?.conclusion, "success");
  assert.ok(producer.steps.some((step) => step.name === "Verify regenerated artifacts strictly" && step.conclusion === "success"));
  assert.equal(snapshot.artifact.id, record.generationArtifactId);
  assert.equal(snapshot.artifact.name, "derived-artifacts-bundle");
  assert.equal(snapshot.artifact.expired, false);
  assert.equal(snapshot.artifact.workflow_run.id, record.generationRunId);
  assert.equal(snapshot.artifact.workflow_run.head_sha, record.generationBase);
  assert.equal(snapshot.artifact.digest, `sha256:${record.generationArtifactSha256}`);
  assert.equal(snapshot.archiveDigest, record.generationArtifactSha256);
  assert.equal(snapshot.bundleSource, record.sealedSource);
  return record;
}
