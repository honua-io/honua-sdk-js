/**
 * Focused experimental claimed/observed/effective capability evaluation.
 *
 * This subpath is intentionally independent of `Source` and connection
 * discovery. Adapters can cache the static evidence entries, but callers must
 * evaluate them again with the current policy, environment, peer, and
 * authorization context before making an execution decision.
 *
 * @experimental
 * @module
 */

import type { ResolvedCrsDefinition } from "./contract/schema.js";
import { type Capability as BuiltInCapabilityId, CAPABILITIES } from "./contract/types.js";
import { canonicalStringify, sha256, toJsonValue } from "./query-planner/canonical.js";
import type { JsonValue } from "./query-planner/types.js";

export const CAPABILITY_PROFILE_KIND = "honua.capabilities" as const;
export const CAPABILITY_PROFILE_VERSION = "1.0" as const;
export const CAPABILITY_PROFILE_FINGERPRINT_DOMAIN = "honua:capabilities:1.0" as const;

const BUILT_IN_CAPABILITIES = new Set<string>(CAPABILITIES);
const CAPABILITY_TRUTHS = new Set<CapabilityTruth>(["supported", "unsupported", "unknown"]);
const EVIDENCE_KINDS = new Set<CapabilityEvidenceKind>([
  "protocol-default",
  "metadata",
  "conformance",
  "probe",
  "declaration",
]);
const OBSERVED_EVIDENCE_KINDS = new Set<CapabilityEvidenceKind>(["metadata", "conformance", "probe"]);
const CLAIM_EVIDENCE_KINDS = new Set<CapabilityEvidenceKind>(["protocol-default", "declaration"]);
const BUILT_IN_FILTER_OPERATORS = new Set<BuiltInFilterOperator>([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "between",
  "is-null",
  "is-not-null",
  "like",
  "and",
  "or",
  "not",
  "equals",
  "intersects",
  "within",
  "contains",
  "disjoint",
  "touches",
  "overlaps",
  "crosses",
  "bbox-intersects",
  "within-distance",
  "beyond-distance",
  "before",
  "after",
  "during",
  "time-intersects",
]);
const SPATIAL_PREDICATES = new Set<SpatialPredicate>([
  "equals",
  "intersects",
  "within",
  "contains",
  "disjoint",
  "touches",
  "overlaps",
  "crosses",
  "bbox-intersects",
  "within-distance",
  "beyond-distance",
]);
const TEMPORAL_PREDICATES = new Set<TemporalPredicate>(["before", "after", "during", "time-intersects"]);
const PAGINATION_MODES = new Set<PaginationMode>(["offset", "cursor", "next-link"]);
const BUILT_IN_ENVIRONMENTS = new Set<string>(["browser", "worker", "node", "edge"]);
const LIMIT_KEYS = new Set(["maxRecords", "maxRequestBytes", "maxResponseBytes"]);
const RESOLVED_CRS_KINDS = new Set(["authority", "wkt", "uri", "projjson"]);
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*\.)+[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REFERENCE_LENGTH = 8_192;

export type ExtensionIdentifier = `${string}.${string}`;
export type Sha256 = `sha256:${string}`;
export type IsoInstant = string;
export type CapabilityId = BuiltInCapabilityId | ExtensionIdentifier;
export type CapabilityTruth = "supported" | "unsupported" | "unknown";
export type ObservedCapabilityTruth = CapabilityTruth | "not-observed";

export type CapabilityEvidenceKind = "protocol-default" | "metadata" | "conformance" | "probe" | "declaration";

/** One claim or observation. `sourceFingerprint` may carry a schema fingerprint. */
export interface CapabilityEvidence {
  readonly kind: CapabilityEvidenceKind;
  readonly truth: CapabilityTruth;
  /** Stable metadata/conformance/declaration identity; never credentials. */
  readonly reference: string;
  readonly observedAt?: IsoInstant;
  /** Evidence identity only. The evaluator has no separate schema input. */
  readonly sourceFingerprint?: Sha256;
}

export type TopologicalSpatialPredicate =
  | "equals"
  | "intersects"
  | "within"
  | "contains"
  | "disjoint"
  | "touches"
  | "overlaps"
  | "crosses";
export type DistanceSpatialPredicate = "within-distance" | "beyond-distance";
export type SpatialPredicate = TopologicalSpatialPredicate | "bbox-intersects" | DistanceSpatialPredicate;
export type TemporalPredicate = "before" | "after" | "during" | "time-intersects";

export type BuiltInFilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "between"
  | "is-null"
  | "is-not-null"
  | "like"
  | "and"
  | "or"
  | "not"
  | SpatialPredicate
  | TemporalPredicate;
export type FilterOperatorId = BuiltInFilterOperator | ExtensionIdentifier;
export type PaginationMode = "offset" | "cursor" | "next-link";
export type ExtensionMap = Readonly<Record<ExtensionIdentifier, JsonValue>>;

export interface CapabilityConstraints {
  readonly inputFormats?: readonly string[];
  readonly outputFormats?: readonly string[];
  readonly filterOperators?: readonly FilterOperatorId[];
  readonly spatialPredicates?: readonly SpatialPredicate[];
  readonly temporalPredicates?: readonly TemporalPredicate[];
  readonly supportedCrs?: readonly ResolvedCrsDefinition[];
  readonly pagination?: {
    readonly modes: readonly PaginationMode[];
    readonly maxPageSize?: number;
  };
  readonly limits?: {
    readonly maxRecords?: number;
    readonly maxRequestBytes?: number;
    readonly maxResponseBytes?: number;
  };
  readonly extensions?: ExtensionMap;
}

export type CapabilityRuntimeEnvironment = "browser" | "worker" | "node" | "edge" | ExtensionIdentifier;

/** Static execution requirements recorded beside cacheable capability evidence. */
export interface CapabilityRequirements {
  readonly environments?: readonly CapabilityRuntimeEnvironment[];
  readonly peers?: readonly string[];
}

/**
 * Cacheable claimed/observed input for one capability.
 *
 * This shape deliberately has no `effective` field. Store this evidence and
 * call {@link evaluateCapabilityProfile} with a fresh dynamic context after a
 * cache read.
 */
export interface CapabilityEvaluationEntry {
  readonly id: CapabilityId;
  readonly claimed: CapabilityTruth;
  readonly observed: ObservedCapabilityTruth;
  readonly evidence: readonly CapabilityEvidence[];
  /** Stable scope identifiers only; never credentials or tokens. */
  readonly authorizationScopes?: readonly string[];
  readonly constraints?: CapabilityConstraints;
  readonly requirements?: CapabilityRequirements;
}

export interface CapabilityPolicy {
  /** Optional allow-list. An omitted list allows every evidence-supported entry. */
  readonly allow?: readonly CapabilityId[];
  /** Explicit deny-list. Denial wins when an id appears in both lists. */
  readonly deny?: readonly CapabilityId[];
}

export interface CapabilityAuthorizationContext {
  readonly grantedScopes?: readonly string[];
  /** Scopes the current principal is known not to be allowed to acquire. */
  readonly deniedScopes?: readonly string[];
}

/** Dynamic inputs that must be refreshed before effective capability use. */
export interface CapabilityEvaluationContext {
  readonly policy?: CapabilityPolicy;
  readonly environment?: CapabilityRuntimeEnvironment;
  readonly availablePeers?: readonly string[];
  readonly authorization?: CapabilityAuthorizationContext;
}

export type EffectiveCapabilityState =
  | "supported"
  | "unsupported"
  | "unknown"
  | "policy-disabled"
  | "peer-unavailable"
  | "authorization-required"
  | "authorization-denied";

/** Stable codes; suffixed forms name the missing environment, peer, or scope. */
export type CapabilityDecisionReason =
  | "supported-by-claim-and-observation"
  | "unsupported-by-claim"
  | "unsupported-by-observation"
  | "claim-unknown"
  | "observation-unknown"
  | "observation-not-observed"
  | "policy-disabled"
  | `environment-unavailable:${string}`
  | `peer-unavailable:${string}`
  | `authorization-required:${string}`
  | `authorization-denied:${string}`;

export interface CapabilityDecision {
  readonly id: CapabilityId;
  readonly claimed: CapabilityTruth;
  readonly observed: ObservedCapabilityTruth;
  readonly effective: EffectiveCapabilityState;
  readonly evidence: readonly CapabilityEvidence[];
  readonly reasons: readonly CapabilityDecisionReason[];
  readonly authorizationScopes?: readonly string[];
  readonly constraints?: CapabilityConstraints;
}

export interface CapabilityProfile {
  readonly kind: typeof CAPABILITY_PROFILE_KIND;
  readonly version: typeof CAPABILITY_PROFILE_VERSION;
  readonly fingerprint: Sha256;
  /** Sorted by id with no duplicates. */
  readonly entries: readonly CapabilityDecision[];
}

interface NormalizedContext {
  readonly allow?: ReadonlySet<CapabilityId>;
  readonly deny: ReadonlySet<CapabilityId>;
  readonly environment?: CapabilityRuntimeEnvironment;
  readonly availablePeers: ReadonlySet<string>;
  readonly grantedScopes: ReadonlySet<string>;
  readonly deniedScopes: ReadonlySet<string>;
}

/**
 * Intersect claimed and observed truth with current dynamic availability.
 *
 * The function is deterministic and side-effect free. It performs no probes,
 * reads no globals, and never supplies a timestamp. Do not use a previously
 * returned profile as a cache hit: cache `entries`, then evaluate again with
 * the current context.
 */
export function evaluateCapabilityProfile(
  entries: readonly CapabilityEvaluationEntry[],
  context: CapabilityEvaluationContext = {},
): CapabilityProfile {
  if (!Array.isArray(entries)) throw new TypeError("Capability entries must be an array");
  const normalizedContext = normalizeContext(context);
  const ids = new Set<string>();
  const decisions = entries.map((entry, index) => {
    const normalized = normalizeEntry(entry, `entries[${index}]`);
    if (ids.has(normalized.id)) throw new TypeError(`Capability entries contain duplicate id ${normalized.id}`);
    ids.add(normalized.id);
    return evaluateEntry(normalized, normalizedContext);
  });
  decisions.sort((left, right) => compareStrings(left.id, right.id));

  const fingerprint = capabilityProfileFingerprint(decisions);
  return deepFreeze({
    kind: CAPABILITY_PROFILE_KIND,
    version: CAPABILITY_PROFILE_VERSION,
    fingerprint,
    entries: decisions,
  });
}

/** Deterministic JSON serialization for diagnostics and transport. */
export function serializeCapabilityProfile(profile: CapabilityProfile): string {
  return canonicalStringify(toJsonValue(profile));
}

function evaluateEntry(entry: CapabilityEvaluationEntry, context: NormalizedContext): CapabilityDecision {
  let effective: EffectiveCapabilityState;
  let reasons: CapabilityDecisionReason[];

  if (entry.claimed === "unsupported" || entry.observed === "unsupported") {
    effective = "unsupported";
    reasons = [
      ...(entry.claimed === "unsupported" ? (["unsupported-by-claim"] as const) : []),
      ...(entry.observed === "unsupported" ? (["unsupported-by-observation"] as const) : []),
    ];
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

  const decision: CapabilityDecision = {
    id: entry.id,
    claimed: entry.claimed,
    observed: entry.observed,
    effective,
    evidence: entry.evidence,
    reasons: Object.freeze([...reasons].sort(compareStrings)),
    ...(entry.authorizationScopes === undefined ? {} : { authorizationScopes: entry.authorizationScopes }),
    ...(entry.constraints === undefined ? {} : { constraints: entry.constraints }),
  };
  return deepFreeze(decision);
}

function policyAllows(id: CapabilityId, context: NormalizedContext): boolean {
  return !context.deny.has(id) && (context.allow === undefined || context.allow.has(id));
}

function availabilityFailures(
  entry: CapabilityEvaluationEntry,
  context: NormalizedContext,
): CapabilityDecisionReason[] {
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
  return reasons.sort(compareStrings);
}

function normalizeContext(context: CapabilityEvaluationContext): NormalizedContext {
  assertPlainObject(context, "Capability evaluation context");
  if (context.policy !== undefined) assertPlainObject(context.policy, "policy");
  if (context.authorization !== undefined) assertPlainObject(context.authorization, "authorization");
  const allow =
    context.policy?.allow === undefined ? undefined : normalizeCapabilityIds(context.policy.allow, "policy.allow");
  const deny = normalizeCapabilityIds(context.policy?.deny ?? [], "policy.deny");
  const environment = context.environment;
  if (environment !== undefined) validateEnvironment(environment, "environment");
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
  return { allow, deny, environment, availablePeers, grantedScopes, deniedScopes };
}

function normalizeEntry(entry: CapabilityEvaluationEntry, path: string): CapabilityEvaluationEntry {
  assertPlainObject(entry, path);
  if (Object.hasOwn(entry, "effective")) {
    throw new TypeError(`${path} must contain cacheable evidence, not a previously effective decision`);
  }
  validateCapabilityId(entry.id, `${path}.id`);
  if (!CAPABILITY_TRUTHS.has(entry.claimed)) throw new TypeError(`${path}.claimed is not a capability truth`);
  if (entry.observed !== "not-observed" && !CAPABILITY_TRUTHS.has(entry.observed)) {
    throw new TypeError(`${path}.observed is not a capability truth`);
  }
  const evidence = normalizeEvidence(entry.evidence, `${path}.evidence`);
  assertEvidenceMatchesTruth(entry.claimed, entry.observed, evidence, path);
  const authorizationScopes =
    entry.authorizationScopes === undefined
      ? undefined
      : normalizeRequiredOpaqueIdentifiers(entry.authorizationScopes, `${path}.authorizationScopes`);
  const constraints =
    entry.constraints === undefined ? undefined : normalizeConstraints(entry.constraints, `${path}.constraints`);
  const requirements =
    entry.requirements === undefined ? undefined : normalizeRequirements(entry.requirements, `${path}.requirements`);
  return deepFreeze({
    id: entry.id,
    claimed: entry.claimed,
    observed: entry.observed,
    evidence,
    ...(authorizationScopes === undefined ? {} : { authorizationScopes }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(requirements === undefined ? {} : { requirements }),
  });
}

function normalizeEvidence(values: readonly CapabilityEvidence[], path: string): readonly CapabilityEvidence[] {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  const identities = new Set<string>();
  const evidence = values.map((value, index): CapabilityEvidence => {
    const itemPath = `${path}[${index}]`;
    assertPlainObject(value, itemPath);
    if (!EVIDENCE_KINDS.has(value.kind)) throw new TypeError(`${itemPath}.kind is not supported`);
    if (!CAPABILITY_TRUTHS.has(value.truth)) throw new TypeError(`${itemPath}.truth is not supported`);
    validateBoundedText(value.reference, `${itemPath}.reference`, MAX_REFERENCE_LENGTH);
    if (value.observedAt !== undefined && !isIsoInstant(value.observedAt)) {
      throw new TypeError(`${itemPath}.observedAt must be an ISO-8601 UTC instant`);
    }
    if (value.sourceFingerprint !== undefined && !SHA256_PATTERN.test(value.sourceFingerprint)) {
      throw new TypeError(`${itemPath}.sourceFingerprint must be a lowercase SHA-256 digest`);
    }
    const identity = canonicalStringify(
      toJsonValue({
        kind: value.kind,
        truth: value.truth,
        reference: value.reference,
        ...(value.sourceFingerprint === undefined ? {} : { sourceFingerprint: value.sourceFingerprint }),
      }),
    );
    if (identities.has(identity)) throw new TypeError(`${path} contains duplicate evidence identity ${identity}`);
    identities.add(identity);
    return Object.freeze({
      kind: value.kind,
      truth: value.truth,
      reference: value.reference,
      ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
      ...(value.sourceFingerprint === undefined ? {} : { sourceFingerprint: value.sourceFingerprint }),
    });
  });
  evidence.sort((left, right) => compareStrings(evidenceSortKey(left), evidenceSortKey(right)));
  return Object.freeze(evidence);
}

function assertEvidenceMatchesTruth(
  claimed: CapabilityTruth,
  observed: ObservedCapabilityTruth,
  evidence: readonly CapabilityEvidence[],
  path: string,
): void {
  const claimEvidence = evidence.filter((item) => CLAIM_EVIDENCE_KINDS.has(item.kind));
  if (!claimEvidence.some((item) => item.truth === claimed)) {
    throw new TypeError(`${path}.claimed must have matching protocol-default or declaration evidence`);
  }
  if (claimEvidence.some((item) => item.truth !== "unknown" && item.truth !== claimed)) {
    throw new TypeError(`${path}.claimed conflicts with its claim evidence`);
  }

  const observedEvidence = evidence.filter((item) => OBSERVED_EVIDENCE_KINDS.has(item.kind));
  if (observed === "not-observed") {
    if (observedEvidence.length > 0)
      throw new TypeError(`${path}.observed cannot be not-observed when observations exist`);
    return;
  }
  if (!observedEvidence.some((item) => item.truth === observed)) {
    throw new TypeError(`${path}.observed must have matching metadata, conformance, or probe evidence`);
  }
  if (observed !== "unknown" && observedEvidence.some((item) => item.truth !== "unknown" && item.truth !== observed)) {
    throw new TypeError(`${path}.observed conflicts with its observation evidence`);
  }
}

function normalizeConstraints(value: CapabilityConstraints, path: string): CapabilityConstraints {
  assertPlainObject(value, path);
  const inputFormats = normalizeOptionalStrings(value.inputFormats, `${path}.inputFormats`);
  const outputFormats = normalizeOptionalStrings(value.outputFormats, `${path}.outputFormats`);
  const filterOperators = normalizeOptionalIdentifiers(
    value.filterOperators,
    `${path}.filterOperators`,
    (entry, itemPath) => {
      if (!BUILT_IN_FILTER_OPERATORS.has(entry as BuiltInFilterOperator) && !isExtensionIdentifier(entry)) {
        throw new TypeError(`${itemPath} is not a semantic filter operator or extension id`);
      }
    },
  );
  const spatialPredicates = normalizeOptionalIdentifiers(
    value.spatialPredicates,
    `${path}.spatialPredicates`,
    (entry, itemPath) => {
      if (!SPATIAL_PREDICATES.has(entry as SpatialPredicate))
        throw new TypeError(`${itemPath} is not a spatial predicate`);
    },
  );
  const temporalPredicates = normalizeOptionalIdentifiers(
    value.temporalPredicates,
    `${path}.temporalPredicates`,
    (entry, itemPath) => {
      if (!TEMPORAL_PREDICATES.has(entry as TemporalPredicate))
        throw new TypeError(`${itemPath} is not a temporal predicate`);
    },
  );
  const supportedCrs =
    value.supportedCrs === undefined ? undefined : normalizeCrs(value.supportedCrs, `${path}.supportedCrs`);
  const pagination =
    value.pagination === undefined ? undefined : normalizePagination(value.pagination, `${path}.pagination`);
  const limits = value.limits === undefined ? undefined : normalizeLimits(value.limits, `${path}.limits`);
  const extensions =
    value.extensions === undefined ? undefined : normalizeExtensions(value.extensions, `${path}.extensions`);
  const normalized: CapabilityConstraints = {
    ...(inputFormats === undefined ? {} : { inputFormats }),
    ...(outputFormats === undefined ? {} : { outputFormats }),
    ...(filterOperators === undefined ? {} : { filterOperators: filterOperators as readonly FilterOperatorId[] }),
    ...(spatialPredicates === undefined ? {} : { spatialPredicates: spatialPredicates as readonly SpatialPredicate[] }),
    ...(temporalPredicates === undefined
      ? {}
      : { temporalPredicates: temporalPredicates as readonly TemporalPredicate[] }),
    ...(supportedCrs === undefined ? {} : { supportedCrs }),
    ...(pagination === undefined ? {} : { pagination }),
    ...(limits === undefined ? {} : { limits }),
    ...(extensions === undefined ? {} : { extensions }),
  };
  if (Object.keys(normalized).length === 0) throw new TypeError(`${path} must contain at least one constraint`);
  return deepFreeze(normalized);
}

function normalizeRequirements(value: CapabilityRequirements, path: string): CapabilityRequirements {
  assertPlainObject(value, path);
  const environments =
    value.environments === undefined
      ? undefined
      : normalizeOptionalIdentifiers(value.environments, `${path}.environments`, validateEnvironment);
  const peers =
    value.peers === undefined ? undefined : normalizeRequiredOpaqueIdentifiers(value.peers, `${path}.peers`);
  if (environments === undefined && peers === undefined)
    throw new TypeError(`${path} must name an environment or peer`);
  return deepFreeze({
    ...(environments === undefined ? {} : { environments: environments as readonly CapabilityRuntimeEnvironment[] }),
    ...(peers === undefined ? {} : { peers }),
  });
}

function normalizePagination(value: NonNullable<CapabilityConstraints["pagination"]>, path: string) {
  assertPlainObject(value, path);
  const modes = normalizeRequiredIdentifiers(value.modes, `${path}.modes`, (entry, itemPath) => {
    if (!PAGINATION_MODES.has(entry as PaginationMode)) throw new TypeError(`${itemPath} is not a pagination mode`);
  }) as readonly PaginationMode[];
  if (value.maxPageSize !== undefined) validatePositiveInteger(value.maxPageSize, `${path}.maxPageSize`);
  return Object.freeze({ modes, ...(value.maxPageSize === undefined ? {} : { maxPageSize: value.maxPageSize }) });
}

function normalizeLimits(value: NonNullable<CapabilityConstraints["limits"]>, path: string) {
  assertPlainObject(value, path);
  for (const [name, limit] of Object.entries(value)) {
    if (!LIMIT_KEYS.has(name)) continue;
    if (limit !== undefined) validatePositiveInteger(limit, `${path}.${name}`);
  }
  const normalized = {
    ...(value.maxRecords === undefined ? {} : { maxRecords: value.maxRecords }),
    ...(value.maxRequestBytes === undefined ? {} : { maxRequestBytes: value.maxRequestBytes }),
    ...(value.maxResponseBytes === undefined ? {} : { maxResponseBytes: value.maxResponseBytes }),
  };
  if (Object.keys(normalized).length === 0) throw new TypeError(`${path} must contain at least one limit`);
  return Object.freeze(normalized);
}

function normalizeCrs(values: readonly ResolvedCrsDefinition[], path: string): readonly ResolvedCrsDefinition[] {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  const canonical = values.map((value, index) => {
    const json = toJsonValue(value, `${path}[${index}]`);
    if (json === null || Array.isArray(json) || typeof json !== "object") {
      throw new TypeError(`${path}[${index}] must be a resolved CRS object`);
    }
    const crs = json as { readonly kind?: JsonValue; readonly validation?: JsonValue };
    if (
      typeof crs.kind !== "string" ||
      !RESOLVED_CRS_KINDS.has(crs.kind) ||
      (crs.kind === "wkt" && crs.validation !== "engine")
    ) {
      throw new TypeError(`${path}[${index}] must contain an executable resolved CRS`);
    }
    return { key: canonicalStringify(json), value: json as unknown as ResolvedCrsDefinition };
  });
  rejectDuplicateKeys(
    canonical.map((entry) => entry.key),
    path,
  );
  canonical.sort((left, right) => compareStrings(left.key, right.key));
  return deepFreeze(canonical.map((entry) => entry.value));
}

function normalizeExtensions(value: ExtensionMap, path: string): ExtensionMap {
  assertPlainObject(value, path);
  for (const key of Object.keys(value)) {
    if (!isExtensionIdentifier(key)) throw new TypeError(`${path}.${key} must use a reverse-DNS extension id`);
  }
  const json = toJsonValue(value, path);
  if (json === null || Array.isArray(json) || typeof json !== "object")
    throw new TypeError(`${path} must be an object`);
  return deepFreeze(json as ExtensionMap);
}

function normalizeOptionalStrings(values: readonly string[] | undefined, path: string): readonly string[] | undefined {
  if (values === undefined) return undefined;
  return normalizeRequiredIdentifiers(values, path, (value, itemPath) =>
    validateBoundedText(value, itemPath, MAX_REFERENCE_LENGTH),
  );
}

function normalizeOptionalIdentifiers<T extends string>(
  values: readonly T[] | undefined,
  path: string,
  validate: (value: string, path: string) => void,
): readonly T[] | undefined {
  if (values === undefined) return undefined;
  return normalizeRequiredIdentifiers(values, path, validate) as readonly T[];
}

function normalizeRequiredIdentifiers<T extends string>(
  values: readonly T[],
  path: string,
  validate: (value: string, path: string) => void,
): readonly T[] {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  const normalized = values.map((value, index) => {
    validate(value, `${path}[${index}]`);
    return value;
  });
  rejectDuplicateKeys(normalized, path);
  return Object.freeze(normalized.sort(compareStrings));
}

function normalizeCapabilityIds(values: readonly CapabilityId[], path: string): ReadonlySet<CapabilityId> {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  values.forEach((value, index) => validateCapabilityId(value, `${path}[${index}]`));
  rejectDuplicateKeys(values, path);
  return new Set(values);
}

function normalizeOpaqueIdentifiers(values: readonly string[], path: string): ReadonlySet<string> {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  values.forEach((value, index) => validateBoundedText(value, `${path}[${index}]`, MAX_IDENTIFIER_LENGTH));
  rejectDuplicateKeys(values, path);
  return new Set(values);
}

function normalizeRequiredOpaqueIdentifiers(values: readonly string[], path: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  return Object.freeze([...normalizeOpaqueIdentifiers(values, path)].sort(compareStrings));
}

function validateCapabilityId(value: string, path: string): asserts value is CapabilityId {
  if (!BUILT_IN_CAPABILITIES.has(value) && !isExtensionIdentifier(value)) {
    throw new TypeError(`${path} must be a built-in capability or reverse-DNS extension id`);
  }
}

function validateEnvironment(value: string, path: string): void {
  if (!BUILT_IN_ENVIRONMENTS.has(value) && !isExtensionIdentifier(value)) {
    throw new TypeError(`${path} must be a built-in environment or reverse-DNS extension id`);
  }
}

function validateBoundedText(value: string, path: string, maxLength: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || hasControlCharacters(value)) {
    throw new TypeError(`${path} must be non-empty bounded text without control characters`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validatePositiveInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
}

function isExtensionIdentifier(value: string): value is ExtensionIdentifier {
  return typeof value === "string" && value.length <= MAX_IDENTIFIER_LENGTH && EXTENSION_ID_PATTERN.test(value);
}

function isIsoInstant(value: string): boolean {
  if (!ISO_INSTANT_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
}

function evidenceSortKey(value: CapabilityEvidence): string {
  return canonicalStringify(toJsonValue([value.kind, value.truth, value.reference, value.sourceFingerprint ?? ""]));
}

function capabilityProfileFingerprint(entries: readonly CapabilityDecision[]): Sha256 {
  const projection = {
    kind: CAPABILITY_PROFILE_KIND,
    version: CAPABILITY_PROFILE_VERSION,
    entries: entries.map((entry) => ({
      id: entry.id,
      claimed: entry.claimed,
      observed: entry.observed,
      effective: entry.effective,
      evidence: entry.evidence.map(({ observedAt: _observedAt, ...evidence }) => evidence),
      reasons: entry.reasons,
      ...(entry.authorizationScopes === undefined ? {} : { authorizationScopes: entry.authorizationScopes }),
      ...(entry.constraints === undefined ? {} : { constraints: entry.constraints }),
    })),
  };
  return sha256(`${CAPABILITY_PROFILE_FINGERPRINT_DOMAIN}\n${canonicalStringify(toJsonValue(projection))}`);
}

function assertPlainObject(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
}

function rejectDuplicateKeys(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`${path} contains duplicate value ${value}`);
    seen.add(value);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
