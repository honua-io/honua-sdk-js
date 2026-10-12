import assert from "node:assert/strict";

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const GENERATED_FILES = new Set([
  "README.md", "bench/cross-sdk/corpus.json", "docs/bundle-sizes.md", "docs/comparison.md",
  "docs/errors.md", "docs/generated/mcp-eval-scorecard.md", "docs/generated/sample-catalog.md",
  "llms.txt", "llms-full.txt", "samples/catalog.v2.json",
  "samples/contract/v2/migrations/catalog.v1-to-v2.json", "samples/contract/v2/release-matrix-lanes.v1.json",
  ...[2, 3, 4].map((version) => `samples/contract/v2/consumer-fixtures/honua-site-consumer.v${version}.json`),
]);
const GENERATED_PREFIXES = ["api-report/", "examples/migration-workbench/public/artifacts/",
  "examples/migration-workbench/src/generated/", "examples/ai-spatial-app-builder/evidence/",
  "examples/realtime-incident-dashboard/evidence/", "examples/spatial-analytics-workbench/evidence/",
  "samples/dist/", ...["imagery-cog-quickstart", "maplibre-quickstart", "migration-workbench", "service-explorer"]
    .map((name) => `samples/evidence/${name}/`)];

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
  assert.equal(record.nodeEngine, `>=${record.nodeVersion}`);
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
  assert.ok(snapshot.paths.every((file) => GENERATED_FILES.has(file) || GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix))), "non-generated candidate change");
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
  successfulRun(snapshot.strict, record.strictRunId, record.sealedSource, "workflow_dispatch", ".github/workflows/ci.yml");
  successfulRun(snapshot.native, record.nativeRunId, record.sealedSource, "pull_request", ".github/workflows/ci.yml");
  assert.ok(snapshot.native.run_attempt >= record.minimumNativeAttempt);
  for (const [jobs, names] of [[snapshot.strictJobs, ["JS SDK", "MCP SDK", "Deterministic Benchmark Lab"]], [snapshot.nativeJobs, ["JS SDK", "MCP SDK", "Deterministic Benchmark Lab", "PR Fast (under 2 minutes)"]]]) {
    for (const name of names) assert.ok(jobs.some((job) => job.name === name && job.conclusion === "success"), `missing successful ${name}`);
  }
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
