import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildArtifactName,
  computeBuildFingerprint,
  createSdkBuildEvidence,
  DEFAULT_EVIDENCE_TTL_SECONDS,
  digestPackageScripts,
  FINGERPRINT_IDENTITY_FIELDS,
  SDK_BUILD_EVIDENCE_FORMAT,
  SDK_VERIFICATION_CONTRACT,
  SdkBuildEvidenceError,
  verifySdkBuildEvidence,
} from "../../scripts/lib/sdk-build-evidence.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);

function environment(overrides = {}) {
  return {
    nodeVersion: "v20.19.0",
    npmVersion: "10.8.2",
    platform: "linux",
    arch: "x64",
    runnerImage: "ubuntu24",
    lockfileSha256: DIGEST_B,
    tsconfigSha256: DIGEST_C,
    scriptsSha256: DIGEST_D,
    ...overrides,
  };
}

function producer(overrides = {}) {
  return {
    repository: "honua-io/honua-sdk-js",
    runId: "1234567890",
    runAttempt: "1",
    headSha: "0".repeat(40),
    workflowRef: "honua-io/honua-sdk-js/.github/workflows/sdk-verification.yml@refs/pull/1/merge",
    eventName: "pull_request",
    ...overrides,
  };
}

function evidenceFor(overrides = {}) {
  const { environmentOverrides, producerOverrides, ...rest } = overrides;
  return createSdkBuildEvidence({
    inputs: { sha256: DIGEST_A, fileCount: 900 },
    dist: { sha256: DIGEST_E, fileCount: 700, byteLength: 12_345 },
    environment: environment(environmentOverrides),
    producer: producer(producerOverrides),
    createdAt: "2026-08-16T12:00:00Z",
    ...rest,
  });
}

function admit(overrides = {}) {
  const { ...rest } = overrides;
  // Deliberately not a destructuring default: `{ evidence: undefined }` is the
  // "no manifest was downloaded" case and must reach the verifier as absent.
  const evidence = "evidence" in overrides ? overrides.evidence : evidenceFor();
  delete rest.evidence;
  return verifySdkBuildEvidence({
    evidence,
    expectedFingerprint: evidence?.fingerprint,
    observedDistSha256: evidence?.artifact?.distSha256,
    now: "2026-08-16T13:00:00Z",
    ...rest,
  });
}

function rejection(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SdkBuildEvidenceError, `expected a build-evidence rejection, got ${error}`);
    return error;
  }
  assert.fail("expected the build evidence to be rejected");
}

describe("SDK build evidence identity", () => {
  it("carries every input REQ-002 names", () => {
    const evidence = evidenceFor();
    assert.equal(evidence.format, SDK_BUILD_EVIDENCE_FORMAT);
    assert.equal(evidence.contract, SDK_VERIFICATION_CONTRACT);
    assert.equal(evidence.environment.nodeVersion, "v20.19.0");
    assert.equal(evidence.environment.npmVersion, "10.8.2");
    assert.equal(evidence.environment.platform, "linux");
    assert.equal(evidence.environment.arch, "x64");
    assert.equal(evidence.environment.runnerImage, "ubuntu24");
    assert.equal(evidence.inputs.lockfileSha256, DIGEST_B);
    assert.equal(evidence.inputs.tsconfigSha256, DIGEST_C);
    assert.equal(evidence.inputs.scriptsSha256, DIGEST_D);
    assert.equal(evidence.inputs.sourceSha256, DIGEST_A);
    assert.equal(evidence.artifact.distSha256, DIGEST_E);
    assert.equal(evidence.producer.runId, "1234567890");
    assert.equal(evidence.producer.headSha, "0".repeat(40));
    assert.equal(evidence.createdAt, "2026-08-16T12:00:00Z");
    assert.equal(evidence.expiresAt, "2026-08-17T12:00:00Z");
    assert.equal(evidence.artifactName, buildArtifactName(evidence.fingerprint));
  });

  it("expires one TTL after creation", () => {
    const evidence = evidenceFor({ ttlSeconds: 3600 });
    assert.equal(evidence.expiresAt, "2026-08-16T13:00:00Z");
    assert.equal(DEFAULT_EVIDENCE_TTL_SECONDS, 24 * 60 * 60);
  });

  it("is stable for identical inputs and moves for every identity field", () => {
    const identity = {
      contract: SDK_VERIFICATION_CONTRACT,
      sourceSha256: DIGEST_A,
      lockfileSha256: DIGEST_B,
      tsconfigSha256: DIGEST_C,
      scriptsSha256: DIGEST_D,
      nodeVersion: "v20.19.0",
      npmVersion: "10.8.2",
      platform: "linux",
      arch: "x64",
    };
    const baseline = computeBuildFingerprint(identity);
    assert.equal(computeBuildFingerprint({ ...identity }), baseline);

    for (const field of FINGERPRINT_IDENTITY_FIELDS) {
      const moved = computeBuildFingerprint({ ...identity, [field]: `${identity[field]}-changed` });
      assert.notEqual(moved, baseline, `${field} must participate in the build fingerprint`);
    }
  });

  it("cannot be forged by concatenating adjacent fields", () => {
    const base = {
      contract: "c",
      sourceSha256: "a",
      lockfileSha256: "bc",
      tsconfigSha256: "d",
      scriptsSha256: "e",
      nodeVersion: "f",
      npmVersion: "g",
      platform: "h",
      arch: "i",
    };
    const shifted = { ...base, sourceSha256: "ab", lockfileSha256: "c" };
    assert.notEqual(computeBuildFingerprint(base), computeBuildFingerprint(shifted));
  });

  it("names the artifact with the full fingerprint so no prefix can match it", () => {
    const fingerprint = "f".repeat(64);
    assert.equal(buildArtifactName(fingerprint), `sdk-build-${fingerprint}`);
    rejection(() => buildArtifactName(fingerprint.slice(0, 12)));
  });

  it("digests the npm scripts block independently of key order", () => {
    const first = digestPackageScripts({ build: "tsc", test: "vitest run" });
    const second = digestPackageScripts({ test: "vitest run", build: "tsc" });
    assert.equal(first, second);
    assert.notEqual(first, digestPackageScripts({ build: "tsc", test: "vitest run --coverage" }));
    // A renamed script is a different scripts block even when the commands are
    // unchanged: consumers execute scripts by name.
    assert.notEqual(first, digestPackageScripts({ compile: "tsc", test: "vitest run" }));
  });
});

describe("SDK build evidence admission", () => {
  it("admits evidence that matches this checkout and these bytes", () => {
    const evidence = evidenceFor();
    assert.equal(admit({ evidence }).fingerprint, evidence.fingerprint);
  });

  it("rejects a missing manifest rather than proceeding without one", () => {
    assert.equal(rejection(() => admit({ evidence: undefined })).reason, "missing");
    assert.equal(rejection(() => admit({ evidence: null })).reason, "missing");
  });

  it("rejects a build produced for a different graph contract", () => {
    const evidence = evidenceFor({ contract: "honua.sdk-verification-graph.v0" });
    const error = rejection(() =>
      verifySdkBuildEvidence({
        evidence,
        expectedFingerprint: evidence.fingerprint,
        observedDistSha256: evidence.artifact.distSha256,
        now: "2026-08-16T13:00:00Z",
      }),
    );
    assert.equal(error.reason, "incompatible-contract");
  });

  it("rejects evidence at and after its expiry, not merely well after it", () => {
    const evidence = evidenceFor();
    assert.equal(rejection(() => admit({ evidence, now: "2026-08-17T12:00:00Z" })).reason, "expired");
    assert.equal(rejection(() => admit({ evidence, now: "2026-08-20T00:00:00Z" })).reason, "expired");
    // One second before expiry is still admissible.
    assert.ok(admit({ evidence, now: "2026-08-17T11:59:59Z" }));
  });

  it("rejects a fingerprint that is close but not this checkout's", () => {
    const evidence = evidenceFor();
    const error = rejection(() =>
      verifySdkBuildEvidence({
        evidence,
        expectedFingerprint: `${evidence.fingerprint.slice(0, 63)}${evidence.fingerprint.at(-1) === "0" ? "1" : "0"}`,
        observedDistSha256: evidence.artifact.distSha256,
        now: "2026-08-16T13:00:00Z",
      }),
    );
    assert.equal(error.reason, "fingerprint-mismatch");
    assert.match(error.message, /no nearest-match reuse/);
  });

  it("rejects a dist tree that was mutated after the evidence was written", () => {
    const evidence = evidenceFor();
    const error = rejection(() =>
      verifySdkBuildEvidence({
        evidence,
        expectedFingerprint: evidence.fingerprint,
        observedDistSha256: DIGEST_C,
        now: "2026-08-16T13:00:00Z",
      }),
    );
    assert.equal(error.reason, "digest-mismatch");
  });

  it("rejects evidence produced by another repository", () => {
    const evidence = evidenceFor({ producerOverrides: { repository: "attacker/fork" } });
    const error = rejection(() => admit({ evidence, expectedRepository: "honua-io/honua-sdk-js" }));
    assert.equal(error.reason, "untrusted-producer");
  });

  it("rejects a manifest whose artifact name does not name its own fingerprint", () => {
    const evidence = { ...evidenceFor(), artifactName: "sdk-build-latest" };
    assert.equal(rejection(() => admit({ evidence })).reason, "malformed");
  });

  it("rejects a manifest with a tampered format, digest, or clock", () => {
    assert.equal(rejection(() => admit({ evidence: { ...evidenceFor(), format: "other" } })).reason, "malformed");
    assert.equal(rejection(() => admit({ evidence: { ...evidenceFor(), fingerprint: "short" } })).reason, "malformed");
    assert.equal(
      rejection(() => admit({ evidence: { ...evidenceFor(), expiresAt: "2026-08-16T11:00:00Z" } })).reason,
      "malformed",
    );
  });

  it("refuses to create evidence from an incomplete build", () => {
    rejection(() => evidenceFor({ ttlSeconds: 0 }));
    rejection(() =>
      createSdkBuildEvidence({
        inputs: { sha256: DIGEST_A, fileCount: 900 },
        dist: { sha256: DIGEST_E, fileCount: 0 },
        environment: environment(),
        producer: producer(),
        createdAt: "2026-08-16T12:00:00Z",
      }),
    );
    rejection(() => evidenceFor({ environmentOverrides: { nodeVersion: "" } }));
    rejection(() => evidenceFor({ producerOverrides: { runId: "" } }));
  });
});
