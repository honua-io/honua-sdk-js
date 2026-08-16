/**
 * SDK build evidence (honua-io/honua-sdk-js#1286).
 *
 * One SDK build is produced once per validated input fingerprint and consumed,
 * unchanged, by every verification job in the graph: root unit/package, MCP,
 * and each browser shard. This module is the identity and admission policy for
 * that build -- what makes two builds the same build, and what makes a
 * downloaded build unusable.
 *
 * The repository already owns the *tree* half of that question:
 * scripts/lib/prepared-sdk-artifact.mjs digests the exact source inputs tsc can
 * reach and the exact dist tree it emitted, and `prepare:test-sdk:already`
 * fails a consumer whose trees do not match the manifest it was handed. What it
 * does not carry is the half a *reused* build needs -- the toolchain and
 * platform the build was produced on, the workflow contract it was produced
 * for, and when it stops being admissible. A dist tree is only evidence about
 * the run that produced it; reused across a different Node, a different
 * lockfile, a different runner architecture, or a different graph shape, it is
 * an assumption wearing a digest.
 *
 * Everything here is pure: snapshots and environment readings are arguments,
 * not side effects, so the admission policy is unit-testable without a build,
 * a runner, or a network. scripts/sdk-build-evidence.mjs is the impure shell.
 *
 * Failure is always closed. Missing, malformed, expired, digest-invalid,
 * fingerprint-mismatched, and contract-incompatible evidence all reject; the
 * caller's only recourse is a fresh build. There is deliberately no prefix
 * match, no "closest" artifact, and no cross-head fallback: a build that is
 * *nearly* the right build is the failure mode this exists to prevent.
 */

import { createHash } from "node:crypto";

export const SDK_BUILD_EVIDENCE_FORMAT = "honua.sdk-build-evidence.v1";

/**
 * The graph shape the evidence was produced for. Consumers refuse evidence
 * stamped with a different contract rather than guessing that the difference
 * did not matter: a graph revision that changes which job owns which gate can
 * make an otherwise byte-identical build the wrong build to trust.
 */
export const SDK_VERIFICATION_CONTRACT = "honua.sdk-verification-graph.v1";

/** Build evidence outlives a review round, not a working week. */
export const DEFAULT_EVIDENCE_TTL_SECONDS = 24 * 60 * 60;
/**
 * Ceiling, in seconds. Bounded by the artifact's own `retention-days: 3` in
 * .github/workflows/sdk-verification.yml: a TTL longer than the artifact lives
 * would let evidence claim to be admissible after the build it describes had
 * been deleted, so the policy would be promising something it cannot honour.
 * test/scripts/sdk-verification-workflow.test.mjs asserts the two stay tied.
 */
export const MAX_EVIDENCE_TTL_SECONDS = 3 * 24 * 60 * 60;
/**
 * Tolerance for runner clock disagreement. `createdAt` is written by the
 * producer and read by a consumer on a different machine; without a bound, a
 * producer whose clock ran fast would silently extend its own TTL, because
 * `expiresAt` is derived from `createdAt` rather than from the consumer's
 * clock. Five minutes covers ordinary NTP drift and nothing else.
 */
export const MAX_CLOCK_SKEW_SECONDS = 300;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FINGERPRINT_LENGTH = 64;

/** Every field that changes what `npm run build` can legitimately emit. */
export const FINGERPRINT_IDENTITY_FIELDS = Object.freeze([
  "contract",
  "sourceSha256",
  "lockfileSha256",
  "tsconfigSha256",
  "scriptsSha256",
  "nodeVersion",
  "npmVersion",
  "platform",
  "arch",
]);

export class SdkBuildEvidenceError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "SdkBuildEvidenceError";
    /** Machine-readable rejection reason; see REJECTION_REASONS. */
    this.reason = reason;
  }
}

export const REJECTION_REASONS = Object.freeze([
  "missing",
  "malformed",
  "incompatible-contract",
  "expired",
  "fingerprint-mismatch",
  "digest-mismatch",
  "untrusted-producer",
]);

function reject(reason, message) {
  if (!REJECTION_REASONS.includes(reason)) {
    throw new Error(`Unknown build-evidence rejection reason: ${reason}`);
  }
  throw new SdkBuildEvidenceError(reason, message);
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    reject("malformed", `${label} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    reject("malformed", `${label} must be a non-empty string of at most 512 characters`);
  }
  return value;
}

function requireInstant(value, label) {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    reject("malformed", `${label} must be an ISO-8601 UTC instant`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) reject("malformed", `${label} is not a real instant: ${value}`);
  return parsed;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Digest of the npm `scripts` block. The scripts are build inputs in the
 * literal sense -- `build`, every `:prepared` consumer entry point, and the
 * browser-shard entry point are what a consumer will actually execute against
 * the reused dist -- and they live in package.json, whose whole-file digest
 * also moves on an unrelated version bump. Digesting the block alone keeps the
 * fingerprint answerable to the thing that matters.
 */
export function digestPackageScripts(scripts) {
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    reject("malformed", "package scripts must be an object");
  }
  const canonical = Object.keys(scripts)
    .sort()
    .map((name) => {
      const command = scripts[name];
      if (typeof command !== "string") {
        reject("malformed", `package script ${name} must be a string`);
      }
      // Escapes, never the raw bytes. Written literally, these two
      // separators make git classify this file as binary, and the most
      // security-sensitive module in the change becomes unreviewable --
      // `gh pr diff` prints "Binary files differ" and every human and
      // reviewing agent sees nothing. Same defect class as
      // honua-io/honua-sdk-js#1332. The emitted string is byte-identical.
      return `${name}\u0000${command}`;
    })
    .join("\u0001");
  return sha256Hex(canonical);
}

/**
 * The exact validated input fingerprint (REQ-001). Length-framed so no two
 * distinct field tuples can collide by concatenation, and computed over a fixed
 * field order so the digest cannot drift with object key insertion order.
 */
export function computeBuildFingerprint(identity) {
  const parts = [];
  for (const field of FINGERPRINT_IDENTITY_FIELDS) {
    const value = identity?.[field];
    requireNonEmptyString(value, `build fingerprint field ${field}`);
    parts.push(`${field}=${Buffer.byteLength(value, "utf8")}:${value}`);
  }
  return sha256Hex(parts.join("\n"));
}

/**
 * Names the workflow artifact for a fingerprint. The full digest is in the
 * name: an artifact name is the only thing a consumer's `download-artifact`
 * step matches on, so a truncated name would reintroduce exactly the prefix
 * ambiguity NFR-001 forbids.
 */
export function buildArtifactName(fingerprint) {
  if (typeof fingerprint !== "string" || fingerprint.length !== FINGERPRINT_LENGTH || !SHA256_PATTERN.test(fingerprint)) {
    reject("malformed", "build fingerprint must be a lowercase 64-character SHA-256 digest");
  }
  return `sdk-build-${fingerprint}`;
}

/**
 * Builds the evidence manifest (REQ-002). `inputs` and `dist` are
 * prepared-sdk-artifact snapshots; `environment` and `producer` are read from
 * the runner by the CLI shell.
 */
export function createSdkBuildEvidence(options) {
  const {
    inputs,
    dist,
    environment,
    producer,
    createdAt,
    ttlSeconds = DEFAULT_EVIDENCE_TTL_SECONDS,
    contract = SDK_VERIFICATION_CONTRACT,
  } = options ?? {};

  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_EVIDENCE_TTL_SECONDS) {
    reject("malformed", `build evidence ttlSeconds must be a positive integer at most ${MAX_EVIDENCE_TTL_SECONDS}`);
  }
  const createdAtMs = requireInstant(createdAt, "build evidence createdAt");

  const identity = {
    contract: requireNonEmptyString(contract, "build evidence contract"),
    sourceSha256: requireDigest(inputs?.sha256, "build evidence inputs.sha256"),
    lockfileSha256: requireDigest(environment?.lockfileSha256, "build environment lockfileSha256"),
    tsconfigSha256: requireDigest(environment?.tsconfigSha256, "build environment tsconfigSha256"),
    scriptsSha256: requireDigest(environment?.scriptsSha256, "build environment scriptsSha256"),
    nodeVersion: requireNonEmptyString(environment?.nodeVersion, "build environment nodeVersion"),
    npmVersion: requireNonEmptyString(environment?.npmVersion, "build environment npmVersion"),
    platform: requireNonEmptyString(environment?.platform, "build environment platform"),
    arch: requireNonEmptyString(environment?.arch, "build environment arch"),
  };
  const fingerprint = computeBuildFingerprint(identity);

  const distSha256 = requireDigest(dist?.sha256, "build evidence dist.sha256");
  if (!Number.isInteger(dist?.fileCount) || dist.fileCount <= 0) {
    reject("malformed", "build evidence dist.fileCount must be a positive integer");
  }
  if (!Number.isInteger(inputs?.fileCount) || inputs.fileCount <= 0) {
    reject("malformed", "build evidence inputs.fileCount must be a positive integer");
  }

  return {
    format: SDK_BUILD_EVIDENCE_FORMAT,
    contract: identity.contract,
    fingerprint,
    artifactName: buildArtifactName(fingerprint),
    createdAt,
    expiresAt: new Date(createdAtMs + ttlSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    inputs: {
      sourceSha256: identity.sourceSha256,
      fileCount: inputs.fileCount,
      lockfileSha256: identity.lockfileSha256,
      tsconfigSha256: identity.tsconfigSha256,
      scriptsSha256: identity.scriptsSha256,
    },
    environment: {
      nodeVersion: identity.nodeVersion,
      npmVersion: identity.npmVersion,
      platform: identity.platform,
      arch: identity.arch,
      runnerImage: typeof environment?.runnerImage === "string" ? environment.runnerImage : "",
    },
    artifact: {
      distSha256,
      fileCount: dist.fileCount,
      byteLength: Number.isInteger(dist?.byteLength) ? dist.byteLength : undefined,
    },
    producer: {
      repository: requireNonEmptyString(producer?.repository, "build producer repository"),
      runId: requireNonEmptyString(producer?.runId, "build producer runId"),
      runAttempt: requireNonEmptyString(producer?.runAttempt, "build producer runAttempt"),
      headSha: requireNonEmptyString(producer?.headSha, "build producer headSha"),
      workflowRef: requireNonEmptyString(producer?.workflowRef, "build producer workflowRef"),
      eventName: requireNonEmptyString(producer?.eventName, "build producer eventName"),
    },
  };
}

function validateEvidenceShape(evidence) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    reject("missing", "SDK build evidence is absent; rebuild from source");
  }
  if (evidence.format !== SDK_BUILD_EVIDENCE_FORMAT) {
    reject("malformed", `SDK build evidence format must be ${SDK_BUILD_EVIDENCE_FORMAT}`);
  }
  requireNonEmptyString(evidence.contract, "build evidence contract");
  requireDigest(evidence.fingerprint, "build evidence fingerprint");
  requireDigest(evidence.artifact?.distSha256, "build evidence artifact.distSha256");
  requireDigest(evidence.inputs?.sourceSha256, "build evidence inputs.sourceSha256");
  requireInstant(evidence.createdAt, "build evidence createdAt");
  requireInstant(evidence.expiresAt, "build evidence expiresAt");
  if (evidence.artifactName !== buildArtifactName(evidence.fingerprint)) {
    reject("malformed", "build evidence artifactName does not name its own fingerprint");
  }
}

/**
 * Admission check run by every consumer job before it trusts a downloaded
 * build (NFR-001). `expectedFingerprint` is recomputed by the consumer from its
 * own checkout, so a build produced for different inputs is rejected even when
 * the workflow handed over the wrong artifact name; `observedDistSha256` is
 * recomputed from the downloaded tree, so a mutated dist is rejected even when
 * the manifest is internally consistent.
 */
export function verifySdkBuildEvidence(options) {
  const {
    evidence,
    expectedFingerprint,
    observedDistSha256,
    now,
    contract = SDK_VERIFICATION_CONTRACT,
    expectedRepository,
  } = options ?? {};


  validateEvidenceShape(evidence);

  // Required, not optional. An admission check that silently skips its
  // producer-identity comparison when the caller forgets to pass one is a
  // policy with a hole in it, and the hole is invisible at the call site.
  // Checked after the shape so an absent manifest still reports "missing",
  // which is the diagnosis the operator needs.
  requireNonEmptyString(expectedRepository, "expected producer repository");

  if (evidence.contract !== contract) {
    reject(
      "incompatible-contract",
      `SDK build evidence was produced for ${evidence.contract}, but this graph is ${contract}. ` +
        "Rebuild from source; a build produced for a different graph shape is not evidence about this one.",
    );
  }

  const nowMs = requireInstant(now, "verification clock");
  const expiresAtMs = Date.parse(evidence.expiresAt);
  const createdAtMs = Date.parse(evidence.createdAt);
  // `expiresAt` is derived from the producer's `createdAt`, so a producer clock
  // running ahead would hand itself a longer life measured against the
  // consumer's clock. Reject the skew rather than absorb it.
  if (createdAtMs > nowMs + MAX_CLOCK_SKEW_SECONDS * 1000) {
    reject(
      "malformed",
      `SDK build evidence claims to have been created at ${evidence.createdAt}, more than ` +
        `${MAX_CLOCK_SKEW_SECONDS}s ahead of the verifying clock ${now}.`,
    );
  }
  if (expiresAtMs - createdAtMs > MAX_EVIDENCE_TTL_SECONDS * 1000) {
    reject(
      "malformed",
      `SDK build evidence declares a lifetime longer than the ${MAX_EVIDENCE_TTL_SECONDS}s ceiling.`,
    );
  }
  // Checked before the clock comparison: evidence that expires at or before it
  // was written is malformed whatever the time is, and reporting it as merely
  // "expired" would send the reader looking for a slow queue.
  if (expiresAtMs <= createdAtMs) {
    reject("malformed", "SDK build evidence expires at or before it was created");
  }
  if (nowMs >= expiresAtMs) {
    reject(
      "expired",
      `SDK build evidence expired at ${evidence.expiresAt}; rebuild from source rather than reusing it.`,
    );
  }

  if (evidence.producer?.repository !== expectedRepository) {
    reject(
      "untrusted-producer",
      `SDK build evidence was produced by ${evidence.producer?.repository ?? "an unnamed repository"}, ` +
        `not ${expectedRepository}.`,
    );
  }

  requireDigest(expectedFingerprint, "expected build fingerprint");
  if (evidence.fingerprint !== expectedFingerprint) {
    reject(
      "fingerprint-mismatch",
      `SDK build evidence fingerprint ${evidence.fingerprint} does not match this checkout's ` +
        `${expectedFingerprint}. There is no nearest-match reuse: rebuild from source.`,
    );
  }

  requireDigest(observedDistSha256, "observed dist digest");
  if (evidence.artifact.distSha256 !== observedDistSha256) {
    reject(
      "digest-mismatch",
      `Downloaded SDK build dist digest ${observedDistSha256} does not match the evidence's ` +
        `${evidence.artifact.distSha256}; the build was mutated in transit or in the consumer.`,
    );
  }

  return evidence;
}

export function serializeSdkBuildEvidence(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}
