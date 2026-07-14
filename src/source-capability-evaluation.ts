import { CAPABILITIES } from "./contract/types.js";
import { canonicalStringify, sha256, toJsonValue } from "./query-planner/canonical.js";
import {
  assertPlainCapabilityObject,
  capabilityInstantNanoseconds,
  compareCapabilityStrings,
  deepFreezeCapability,
  isCapabilityIsoInstant,
  snapshotCapabilityJson,
} from "./source-capability-json.js";
import {
  type CapabilityEvidenceRuntimeEntry,
  capabilityEvidenceRuntimeIndex,
  registerCapabilityProfile,
} from "./source-capability-registry.js";
import {
  CAPABILITY_PROFILE_FINGERPRINT_DOMAIN,
  CAPABILITY_PROFILE_KIND,
  CAPABILITY_PROFILE_VERSION,
  type CapabilityDecision,
  type CapabilityDecisionReason,
  type CapabilityEvaluationContext,
  type CapabilityEvaluationContextSnapshot,
  type CapabilityEvidenceEntry,
  type CapabilityEvidenceProfile,
  type CapabilityId,
  type CapabilityProfile,
  type CapabilityRuntimeEnvironment,
  type EffectiveCapabilityState,
  type IsoInstant,
  type Sha256,
} from "./source-capability-types.js";

const CONTEXT_JSON_LIMITS = Object.freeze({ depth: 8, nodes: 8_192, bytes: 512 * 1_024 });
const MAX_SET_VALUES = 1_024;
const MAX_IDENTIFIER_LENGTH = 256;
const BUILT_IN_CAPABILITIES = new Set<string>(CAPABILITIES);
const BUILT_IN_ENVIRONMENTS = new Set<string>(["browser", "worker", "node", "edge"]);
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*\.)+[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface NormalizedContext {
  readonly evaluatedAtText?: IsoInstant;
  readonly evaluatedAt?: bigint;
  readonly allow?: ReadonlySet<CapabilityId>;
  readonly deny: ReadonlySet<CapabilityId>;
  readonly environment?: CapabilityRuntimeEnvironment;
  readonly availablePeers: ReadonlySet<string>;
  readonly grantedScopes: ReadonlySet<string>;
  readonly deniedScopes: ReadonlySet<string>;
  readonly snapshot: CapabilityEvaluationContextSnapshot;
}

interface FreshnessResult {
  readonly reasons: readonly CapabilityDecisionReason[];
  readonly boundary?: { readonly instant: bigint; readonly text: IsoInstant };
}

/**
 * Intersect a previously validated static evidence profile with current policy,
 * runtime, peer, authorization, and clock state. This path performs no CRS or
 * PROJJSON validation and shares the immutable static envelope by reference.
 */
export function evaluateCapabilityProfile(
  profile: CapabilityEvidenceProfile,
  context: CapabilityEvaluationContext = {},
): CapabilityProfile {
  const runtime = capabilityEvidenceRuntimeIndex(profile);
  if (runtime === undefined) {
    throw new TypeError("Capability evidence profile must be created or parsed by this SDK instance");
  }
  const safeContext = snapshotCapabilityJson(
    context,
    "Capability evaluation context",
    CONTEXT_JSON_LIMITS,
  ) as CapabilityEvaluationContext;
  const normalizedContext = normalizeContext(safeContext);
  let validUntil: { readonly instant: bigint; readonly text: IsoInstant } | undefined;
  const decisions = profile.entries.map((entry, index) => {
    const result = evaluateEntry(entry, runtime.entries[index]!, normalizedContext);
    if (result.boundary !== undefined && (validUntil === undefined || result.boundary.instant < validUntil.instant)) {
      validUntil = result.boundary;
    }
    return result.decision;
  });

  const evaluatedAt = normalizedContext.evaluatedAtText ?? null;
  const validUntilText = normalizedContext.evaluatedAt === undefined ? null : (validUntil?.text ?? null);
  const envelope = {
    kind: CAPABILITY_PROFILE_KIND,
    version: CAPABILITY_PROFILE_VERSION,
    evidenceFingerprint: profile.fingerprint,
    ...(profile.sourceFingerprint === undefined ? {} : { sourceFingerprint: profile.sourceFingerprint }),
    evaluatedAt,
    validUntil: validUntilText,
    context: normalizedContext.snapshot,
    entries: decisions,
  };
  // Static detail is already content-addressed by evidenceFingerprint. Keeping
  // only dynamic decisions in this projection prevents repeat evaluation from
  // walking complete PROJJSON definitions.
  const fingerprintProjection = {
    kind: envelope.kind,
    version: envelope.version,
    evidenceFingerprint: envelope.evidenceFingerprint,
    ...(profile.sourceFingerprint === undefined ? {} : { sourceFingerprint: profile.sourceFingerprint }),
    evaluatedAt,
    validUntil: validUntilText,
    context: normalizedContext.snapshot,
    entries: decisions.map(({ id, effective, reasons }) => ({ id, effective, reasons })),
  };
  const fingerprint = sha256(
    `${CAPABILITY_PROFILE_FINGERPRINT_DOMAIN}\n${canonicalStringify(toJsonValue(fingerprintProjection))}`,
  ) as Sha256;
  return registerCapabilityProfile(deepFreezeCapability({ ...envelope, fingerprint }) as CapabilityProfile);
}

function evaluateEntry(
  entry: CapabilityEvidenceEntry,
  runtime: CapabilityEvidenceRuntimeEntry,
  context: NormalizedContext,
): { readonly decision: CapabilityDecision; readonly boundary?: FreshnessResult["boundary"] } {
  const freshness = observationFreshness(entry, runtime, context);
  let effective: EffectiveCapabilityState;
  let reasons: CapabilityDecisionReason[];

  if (entry.claimed === "unsupported") {
    effective = "unsupported";
    reasons = [
      "unsupported-by-claim",
      ...(entry.observed === "unsupported" && freshness.reasons.length === 0
        ? (["unsupported-by-observation"] as const)
        : []),
    ];
  } else if (freshness.reasons.length > 0) {
    effective = "unknown";
    reasons = [...(entry.claimed === "unknown" ? (["claim-unknown"] as const) : []), ...freshness.reasons];
  } else if (entry.observed === "unsupported") {
    effective = "unsupported";
    reasons = ["unsupported-by-observation"];
  } else if (entry.claimed === "unknown" || entry.observed === "unknown" || entry.observed === "not-observed") {
    effective = "unknown";
    reasons = [
      ...(entry.claimed === "unknown" ? (["claim-unknown"] as const) : []),
      ...(entry.observed === "unknown" ? (["observation-unknown"] as const) : []),
      ...(entry.observed === "not-observed" ? (["observation-not-observed"] as const) : []),
    ];
  } else if (!policyAllows(entry.id, context)) {
    effective = "policy-disabled";
    reasons = ["policy-disabled"];
  } else {
    const availabilityReasons = availabilityFailures(entry, context);
    if (availabilityReasons.length > 0) {
      effective = "peer-unavailable";
      reasons = availabilityReasons;
    } else {
      const denied = (entry.authorizationScopes ?? []).filter((scope) => context.deniedScopes.has(scope));
      const missing = (entry.authorizationScopes ?? []).filter((scope) => !context.grantedScopes.has(scope));
      if (denied.length > 0) {
        effective = "authorization-denied";
        reasons = denied.map((scope) => `authorization-denied:${scope}` as const);
      } else if (missing.length > 0) {
        effective = "authorization-required";
        reasons = missing.map((scope) => `authorization-required:${scope}` as const);
      } else {
        effective = "supported";
        reasons = ["supported-by-claim-and-observation"];
      }
    }
  }

  const decision = Object.freeze({
    id: entry.id,
    claimed: entry.claimed,
    observed: entry.observed,
    effective,
    evidence: entry.evidence,
    reasons: Object.freeze([...reasons].sort(compareCapabilityStrings)),
    ...(entry.authorizationScopes === undefined ? {} : { authorizationScopes: entry.authorizationScopes }),
    ...(entry.constraints === undefined ? {} : { constraints: entry.constraints }),
    ...(entry.requirements === undefined ? {} : { requirements: entry.requirements }),
  }) as CapabilityDecision;
  return { decision, ...(freshness.boundary === undefined ? {} : { boundary: freshness.boundary }) };
}

function observationFreshness(
  entry: CapabilityEvidenceEntry,
  runtime: CapabilityEvidenceRuntimeEntry,
  context: NormalizedContext,
): FreshnessResult {
  if (entry.observed === "not-observed") return { reasons: [] };
  if (context.evaluatedAt === undefined || context.evaluatedAtText === undefined) {
    return { reasons: ["freshness-not-evaluated"] };
  }
  const matching = runtime.observations.filter((evidence) => evidence.truth === entry.observed);
  const current = matching.filter(
    (evidence) => evidence.observedAt <= context.evaluatedAt! && context.evaluatedAt! < evidence.expiresAt,
  );
  if (current.length > 0) {
    const expiry = current.reduce((earliest, value) => (value.expiresAt < earliest.expiresAt ? value : earliest));
    return { reasons: [], boundary: { instant: expiry.expiresAt, text: expiry.expiresAtText } };
  }
  const reasons: CapabilityDecisionReason[] = [];
  if (matching.some((evidence) => context.evaluatedAt! < evidence.observedAt)) reasons.push("evidence-not-yet-current");
  if (matching.some((evidence) => context.evaluatedAt! >= evidence.expiresAt)) reasons.push("evidence-stale");
  return {
    reasons: reasons.length === 0 ? ["evidence-stale"] : reasons.sort(compareCapabilityStrings),
    boundary: { instant: context.evaluatedAt, text: context.evaluatedAtText },
  };
}

function policyAllows(id: CapabilityId, context: NormalizedContext): boolean {
  return !context.deny.has(id) && (context.allow === undefined || context.allow.has(id));
}

function availabilityFailures(entry: CapabilityEvidenceEntry, context: NormalizedContext): CapabilityDecisionReason[] {
  const reasons: CapabilityDecisionReason[] = [];
  const environments = entry.requirements?.environments;
  if (
    environments !== undefined &&
    (context.environment === undefined || !environments.includes(context.environment))
  ) {
    reasons.push(`environment-unavailable:${context.environment ?? "unspecified"}`);
  }
  for (const peer of entry.requirements?.peers ?? []) {
    if (!context.availablePeers.has(peer)) reasons.push(`peer-unavailable:${peer}`);
  }
  return reasons.sort(compareCapabilityStrings);
}

function normalizeContext(context: CapabilityEvaluationContext): NormalizedContext {
  assertPlainCapabilityObject(context, "Capability evaluation context", [
    "evaluatedAt",
    "policy",
    "environment",
    "availablePeers",
    "authorization",
  ]);
  if (context.policy !== undefined) assertPlainCapabilityObject(context.policy, "policy", ["allow", "deny"]);
  if (context.authorization !== undefined) {
    assertPlainCapabilityObject(context.authorization, "authorization", ["grantedScopes", "deniedScopes"]);
  }
  if (context.evaluatedAt !== undefined && !isCapabilityIsoInstant(context.evaluatedAt)) {
    throw new TypeError("evaluatedAt must be an ISO-8601 UTC instant");
  }
  const allow =
    context.policy?.allow === undefined ? undefined : normalizeCapabilityIds(context.policy.allow, "policy.allow");
  const deny = normalizeCapabilityIds(context.policy?.deny ?? [], "policy.deny");
  if (context.environment !== undefined) validateEnvironment(context.environment, "environment");
  const availablePeers = normalizeOpaqueIdentifiers(context.availablePeers ?? [], "availablePeers");
  const grantedScopes = normalizeOpaqueIdentifiers(
    context.authorization?.grantedScopes ?? [],
    "authorization.grantedScopes",
  );
  const deniedScopes = normalizeOpaqueIdentifiers(
    context.authorization?.deniedScopes ?? [],
    "authorization.deniedScopes",
  );
  for (const scope of grantedScopes) {
    if (deniedScopes.has(scope)) throw new TypeError(`Authorization scope ${scope} cannot be both granted and denied`);
  }
  const allowValues = allow === undefined ? undefined : Object.freeze([...allow].sort(compareCapabilityStrings));
  const denyValues = Object.freeze([...deny].sort(compareCapabilityStrings));
  const peerValues = Object.freeze([...availablePeers].sort(compareCapabilityStrings));
  const grantedValues = Object.freeze([...grantedScopes].sort(compareCapabilityStrings));
  const deniedValues = Object.freeze([...deniedScopes].sort(compareCapabilityStrings));
  const snapshot = deepFreezeCapability({
    ...(context.policy === undefined
      ? {}
      : { policy: { ...(allowValues === undefined ? {} : { allow: allowValues }), deny: denyValues } }),
    ...(context.environment === undefined ? {} : { environment: context.environment }),
    availablePeers: peerValues,
    authorization: { grantedScopes: grantedValues, deniedScopes: deniedValues },
  }) as CapabilityEvaluationContextSnapshot;
  return {
    ...(context.evaluatedAt === undefined
      ? {}
      : {
          evaluatedAtText: context.evaluatedAt,
          evaluatedAt: capabilityInstantNanoseconds(context.evaluatedAt),
        }),
    allow,
    deny,
    ...(context.environment === undefined ? {} : { environment: context.environment }),
    availablePeers,
    grantedScopes,
    deniedScopes,
    snapshot,
  };
}

function normalizeCapabilityIds(values: readonly CapabilityId[], path: string): ReadonlySet<CapabilityId> {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  assertMaximumCount(values.length, MAX_SET_VALUES, path);
  values.forEach((value, index) => validateCapabilityId(value, `${path}[${index}]`));
  rejectDuplicateKeys(values, path);
  return new Set(values);
}

function normalizeOpaqueIdentifiers(values: readonly string[], path: string): ReadonlySet<string> {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  assertMaximumCount(values.length, MAX_SET_VALUES, path);
  values.forEach((value, index) => validateBoundedText(value, `${path}[${index}]`));
  rejectDuplicateKeys(values, path);
  return new Set(values);
}

function validateCapabilityId(value: unknown, path: string): asserts value is CapabilityId {
  if (
    typeof value !== "string" ||
    (!BUILT_IN_CAPABILITIES.has(value) && !(value.length <= MAX_IDENTIFIER_LENGTH && EXTENSION_ID_PATTERN.test(value)))
  ) {
    throw new TypeError(`${path} must be a built-in capability or reverse-DNS extension id`);
  }
}

function validateEnvironment(value: string, path: string): void {
  if (
    !BUILT_IN_ENVIRONMENTS.has(value) &&
    !(value.length <= MAX_IDENTIFIER_LENGTH && EXTENSION_ID_PATTERN.test(value))
  ) {
    throw new TypeError(`${path} must be a built-in environment or reverse-DNS extension id`);
  }
}

function validateBoundedText(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(`${path} must be non-empty bounded text`);
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError(`${path} must not contain control characters`);
  }
}

function rejectDuplicateKeys(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`${path} contains duplicate value ${value}`);
    seen.add(value);
  }
}

function assertMaximumCount(count: number, maximum: number, path: string): void {
  if (count > maximum) throw new TypeError(`${path} exceeds the maximum count ${maximum}`);
}
