import { canonicalStringify, toJsonValue } from "./query-planner/canonical.js";
import { evaluateCapabilityProfile } from "./source-capability-evaluation.js";
import { parseCapabilityEvidenceProfile } from "./source-capability-evidence.js";
import {
  assertPlainCapabilityObject,
  isCapabilityIsoInstant,
  parseCapabilityJson,
  snapshotCapabilityJson,
} from "./source-capability-json.js";
import { CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS } from "./source-capability-limits.js";
import { isRegisteredCapabilityProfile } from "./source-capability-registry.js";
import {
  CAPABILITY_EVIDENCE_PROFILE_KIND,
  CAPABILITY_EVIDENCE_PROFILE_VERSION,
  CAPABILITY_PROFILE_KIND,
  CAPABILITY_PROFILE_VERSION,
  type CapabilityDecision,
  type CapabilityEvaluationContext,
  type CapabilityEvidenceEntry,
  type CapabilityProfile,
  type CapabilitySourceVerificationOptions,
  type Sha256,
} from "./source-capability-types.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Serialize an evaluated profile produced or verified by this SDK instance.
 * Serialization is canonical, not sanitizing; output remains potentially sensitive.
 */
export function serializeCapabilityProfile(profile: CapabilityProfile): string {
  if (profile === null || typeof profile !== "object" || !isRegisteredCapabilityProfile(profile)) {
    throw new TypeError("Capability profile must be evaluated or parsed by this SDK instance");
  }
  const safeProfile = snapshotCapabilityJson(
    profile,
    "Capability profile",
    CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS,
  ) as CapabilityProfile;
  return canonicalStringify(toJsonValue(safeProfile));
}

/**
 * Parse and verify a transported evaluated profile by reconstructing its static
 * evidence profile and reproducing every dynamic decision from the retained
 * caller-controlled evaluation context. This verifies internal consistency;
 * Pass both expected source verification coordinates to bind use to the
 * current SourceSchemaV2 and credential-free endpoint identity.
 */
export function parseCapabilityProfile(
  value: string | unknown,
  options: CapabilitySourceVerificationOptions = {},
): CapabilityProfile {
  const parsed = parseCapabilityJson(value, "Capability profile", CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS);
  assertPlainCapabilityObject(parsed, "Capability profile", [
    "kind",
    "version",
    "fingerprint",
    "evidenceFingerprint",
    "sourceFingerprint",
    "sourceEndpointFingerprint",
    "evaluatedAt",
    "validUntil",
    "context",
    "entries",
  ]);
  const record = parsed as Record<string, unknown>;
  if (record.kind !== CAPABILITY_PROFILE_KIND) {
    throw new TypeError(`Capability profile.kind must be ${CAPABILITY_PROFILE_KIND}`);
  }
  if (record.version !== CAPABILITY_PROFILE_VERSION) {
    throw new TypeError(`Capability profile.version must be ${CAPABILITY_PROFILE_VERSION}`);
  }
  validateSha256(record.fingerprint, "Capability profile.fingerprint");
  validateSha256(record.evidenceFingerprint, "Capability profile.evidenceFingerprint");
  if (!Object.hasOwn(record, "sourceFingerprint")) {
    throw new TypeError("Capability profile.sourceFingerprint is required");
  }
  validateSha256(record.sourceFingerprint, "Capability profile.sourceFingerprint");
  if (!Object.hasOwn(record, "sourceEndpointFingerprint")) {
    throw new TypeError("Capability profile.sourceEndpointFingerprint is required");
  }
  validateSha256(record.sourceEndpointFingerprint, "Capability profile.sourceEndpointFingerprint");
  validateNullableInstant(record.evaluatedAt, "Capability profile.evaluatedAt");
  validateNullableInstant(record.validUntil, "Capability profile.validUntil");
  assertPlainCapabilityObject(record.context, "Capability profile.context", [
    "policy",
    "environment",
    "availablePeers",
    "authorization",
  ]);
  if (!Array.isArray(record.entries)) throw new TypeError("Capability profile.entries must be an array");

  const staticEntries = record.entries.map((entry, index) => projectStaticEntry(entry, index));
  const evidenceEnvelope = {
    kind: CAPABILITY_EVIDENCE_PROFILE_KIND,
    version: CAPABILITY_EVIDENCE_PROFILE_VERSION,
    fingerprint: record.evidenceFingerprint,
    sourceFingerprint: record.sourceFingerprint,
    sourceEndpointFingerprint: record.sourceEndpointFingerprint,
    entries: staticEntries,
  };
  const evidenceProfile = parseCapabilityEvidenceProfile(evidenceEnvelope, options);
  const context = {
    ...(record.context as CapabilityEvaluationContext),
    ...(record.evaluatedAt === null ? {} : { evaluatedAt: record.evaluatedAt }),
  } as CapabilityEvaluationContext;
  const verified = evaluateCapabilityProfile(evidenceProfile, context);
  if (canonicalStringify(toJsonValue(parsed)) !== canonicalStringify(toJsonValue(verified))) {
    throw new TypeError("Capability profile does not match a fresh evaluation of its evidence and context");
  }
  return verified;
}

function projectStaticEntry(value: unknown, index: number): CapabilityEvidenceEntry {
  const path = `Capability profile.entries[${index}]`;
  assertPlainCapabilityObject(value, path, [
    "id",
    "claimed",
    "observed",
    "effective",
    "evidence",
    "reasons",
    "authorizationScopes",
    "constraints",
    "requirements",
  ]);
  const decision = value as CapabilityDecision;
  if (typeof decision.effective !== "string") throw new TypeError(`${path}.effective must be a decision state`);
  if (!Array.isArray(decision.reasons)) throw new TypeError(`${path}.reasons must be an array`);
  return {
    id: decision.id,
    claimed: decision.claimed,
    observed: decision.observed,
    evidence: decision.evidence,
    ...(decision.authorizationScopes === undefined ? {} : { authorizationScopes: decision.authorizationScopes }),
    ...(decision.constraints === undefined ? {} : { constraints: decision.constraints }),
    ...(decision.requirements === undefined ? {} : { requirements: decision.requirements }),
  };
}

function validateSha256(value: unknown, path: string): asserts value is Sha256 {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  }
}

function validateNullableInstant(value: unknown, path: string): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !isCapabilityIsoInstant(value))) {
    throw new TypeError(`${path} must be null or an ISO-8601 UTC instant`);
  }
}
