import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateRecoveryRecord, validateRecoverySnapshot } from "../../scripts/lib/sealed-ancestor-recovery.mjs";

const record = JSON.parse(fs.readFileSync("config/release-recoveries/js-sdk-v0.1.18.json", "utf8"));
function fixture() {
  const run = (id, sha, event, path = ".github/workflows/ci.yml") => ({ id, head_sha: sha, event, path, status: "completed", conclusion: "success", repository: { full_name: record.repository }, head_repository: { full_name: record.repository } });
  const identity = { version: record.version, manifest: { ".": record.version, mcp: "0.1.19", "packages/create-honua-app": "0.1.9" }, lockVersion: record.version, lockRootVersion: record.version, nodeVersion: record.nodeVersion, engines: Array(3).fill(record.nodeEngine) };
  return {
    release: { id: record.releaseId, tag_name: record.tag, target_commitish: record.managedSource, draft: true, immutable: false },
    currentTrunkContainsSource: true, managedContainsBase: true, baseContainsSource: true,
    subjects: ["chore(evidence): regenerate derived artifacts (evidence)"], paths: ["samples/dist/catalog.json"], existingTag: null,
    identities: Array.from({ length: 3 }, () => structuredClone(identity)),
    strict: run(record.strictRunId, record.sealedSource, "workflow_dispatch"),
    native: { ...run(record.nativeRunId, record.sealedSource, "pull_request"), run_attempt: 2 },
    strictJobs: ["JS SDK", "MCP SDK", "Deterministic Benchmark Lab"].map((name) => ({ name, conclusion: "success", steps: ["Unit tests with coverage", "Browser smoke suite", "Deterministic browser rendering benchmark"].map((name) => ({ name, conclusion: "success" })) })),
    nativeJobs: ["JS SDK", "MCP SDK", "Deterministic Benchmark Lab", "PR Fast (under 2 minutes)"].map((name) => ({ name, conclusion: "success", steps: ["Unit tests with coverage", "Browser smoke suite", "Deterministic browser rendering benchmark"].map((name) => ({ name, conclusion: "success" })) })),
    generation: { ...run(record.generationRunId, record.generationBase, "workflow_dispatch", ".github/workflows/regenerate-derived-artifacts.yml"), head_branch: "trunk", conclusion: "failure" },
    generationJobs: [{ name: "Regenerate + reseal on trunk", conclusion: "success", steps: [{ name: "Verify regenerated artifacts strictly", conclusion: "success" }] }],
    artifact: { id: record.generationArtifactId, name: "derived-artifacts-bundle", expired: false, workflow_run: { id: record.generationRunId, head_sha: record.generationBase }, digest: `sha256:${record.generationArtifactSha256}` },
    archiveDigest: record.generationArtifactSha256, bundleSource: record.sealedSource,
  };
}

test("reviewed record accepts only the exact stable tag/source and owning repository", () => {
  const request = { tag: record.tag, source: record.sealedSource, repository: record.repository };
  validateRecoveryRecord(record, request);
  for (const change of [{ tag: "../../tag" }, { tag: "js-sdk-v0.2.0" }, { source: "trunk" }, { source: "f".repeat(40) }, { repository: "other/repo" }])
    assert.throws(() => validateRecoveryRecord(record, { ...request, ...change }));
});

test("successful producer plus independently recovered CI can qualify a stranded publisher", () => {
  assert.equal(validateRecoverySnapshot(record, fixture()), record);
  const resumed = fixture(); resumed.existingTag = record.sealedSource;
  assert.equal(validateRecoverySnapshot(record, resumed), record);
});

const refusals = {
  "unpublished source branch": (s) => { s.currentTrunkContainsSource = false; },
  "wrong managed ancestry": (s) => { s.managedContainsBase = false; },
  "wrong generation ancestry": (s) => { s.baseContainsSource = false; },
  "source edits in generated chain": (s) => { s.paths.push("src/index.ts"); },
  "workflow edits in generated chain": (s) => { s.paths.push(".github/workflows/ci.yml"); },
  "unreviewed commit chain": (s) => { s.subjects.push("fix: alter runtime"); },
  "too many generated commits": (s) => { s.subjects = Array(5).fill(s.subjects[0]); },
  "wrong draft anchor": (s) => { s.release.target_commitish = record.generationBase; },
  "already published release": (s) => { s.release.draft = false; },
  "immutable existing release": (s) => { s.release.immutable = true; },
  "different immutable tag": (s) => { s.existingTag = record.generationBase; },
  "breaking runtime in old patch": (s) => { s.identities[2].engines[0] = ">=22.12.0"; },
  "different toolchain": (s) => { s.identities[2].nodeVersion = "22.23.3"; },
  "wrong SDK version": (s) => { s.identities[2].version = "0.2.0"; },
  "wrong managed manifest": (s) => { s.identities[2].manifest["."] = "0.2.0"; },
  "wrong package lock": (s) => { s.identities[2].lockRootVersion = "0.2.0"; },
  "wrong MCP cut": (s) => { s.identities[2].manifest.mcp = "0.2.0"; },
  "strict job failure": (s) => { s.strictJobs[0].conclusion = "failure"; },
  "skipped browser": (s) => { s.strictJobs[0].steps[1].conclusion = "skipped"; },
  "render benchmark failure": (s) => { s.nativeJobs[0].steps[2].conclusion = "failure"; },
  "native failure": (s) => { s.native.conclusion = "failure"; },
  "native cancelled": (s) => { s.native.conclusion = "cancelled"; },
  "original failed attempt": (s) => { s.native.run_attempt = 1; },
  "wrong strict source": (s) => { s.strict.head_sha = record.generationBase; },
  "relaxed PR as strict proof": (s) => { s.strict.event = "pull_request"; },
  "foreign run": (s) => { s.strict.head_repository.full_name = "other/repo"; },
  "different workflow": (s) => { s.strict.path = ".github/workflows/other.yml"; },
  "incomplete canonical producer": (s) => { s.generationJobs[0].conclusion = "failure"; },
  "strict generation failed": (s) => { s.generationJobs[0].steps[0].conclusion = "failure"; },
  "branch generation": (s) => { s.generation.head_branch = "feature"; },
  "different generation source": (s) => { s.generation.head_sha = record.managedSource; },
  "expired artifact": (s) => { s.artifact.expired = true; },
  "wrong artifact run": (s) => { s.artifact.workflow_run.id++; },
  "wrong artifact digest": (s) => { s.artifact.digest = `sha256:${"f".repeat(64)}`; },
  "corrupt archive": (s) => { s.archiveDigest = "f".repeat(64); },
  "different bundle source": (s) => { s.bundleSource = record.generationBase; },
};
for (const [name, mutate] of Object.entries(refusals)) test(`refuses ${name}`, () => {
  const snapshot = fixture(); mutate(snapshot);
  assert.throws(() => validateRecoverySnapshot(record, snapshot));
});

test("workflow rechecks exact-source seal before creating or publishing an ancestor tag", () => {
  const workflow = fs.readFileSync(".github/workflows/release-please.yml", "utf8");
  const seal = workflow.indexOf("- name: Recheck exact ancestor release seal");
  const dispatch = workflow.indexOf("- name: Dispatch package publish workflows");
  assert.ok(seal > 0 && seal < dispatch);
  assert.ok(workflow.includes('node scripts/release-seal.mjs check --expect-version "$RECOVERY_VERSION"'));
  assert.ok(workflow.includes('"${RECOVERY_SEAL_OUTCOME:-}" != "success"'));
  const recovery = workflow.slice(workflow.indexOf('if [[ -n "${RECOVER_SEALED_SOURCE:-}" ]]'));
  assert.ok(recovery.indexOf("node scripts/verify-sealed-ancestor-recovery.mjs") < recovery.indexOf('gh api --method POST'));
  assert.ok(recovery.indexOf('recovery_tag_sha=') < recovery.indexOf('publish_sealed_draft'));
  assert.ok(!recovery.includes('git push --force'));
});
