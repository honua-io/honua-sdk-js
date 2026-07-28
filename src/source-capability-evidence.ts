import { type ResolvedCrsDefinition, validateSourceCrsDefinition } from "./contract/schema.js";
import type { SourceProtocol } from "./contract/schema.js";
import { CAPABILITIES, type SourceDescriptor } from "./contract/types.js";
import { canonicalStringify, sha256, toJsonValue } from "./query-planner/canonical.js";
import type { JsonValue } from "./query-planner/types.js";
import { sourceCapabilityEndpointIdentity } from "./source-capability-discovery-endpoint.js";
import { createCapabilitySourceEndpointFingerprint } from "./source-capability-endpoint.js";
import {
  assertExactCapabilityKeys,
  assertPlainCapabilityObject,
  capabilityInstantNanoseconds,
  compareCapabilityCanonicalJson,
  compareCapabilityStrings,
  deepFreezeCapability,
  isCapabilityIsoInstant,
  parseCapabilityJson,
  snapshotCapabilityJson,
} from "./source-capability-json.js";
import {
  CAPABILITY_EVIDENCE_ENTRIES_JSON_LIMITS,
  CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS,
} from "./source-capability-limits.js";
import {
  type CapabilityEvidenceRuntimeEntry,
  type CapabilitySourceDescriptorMatcher,
  capabilityEvidenceRuntimeIndex as capabilityProfileRuntimeIndex,
  registerCapabilityEvidenceProfile,
} from "./source-capability-registry.js";
import {
  assertNoSensitiveCapabilityExtension,
  validateCapabilityEvidenceReference,
  validateCapabilityPeerIdentifier,
  validateCapabilityScopeIdentifier,
} from "./source-capability-security.js";
import {
  type BuiltInFilterOperator,
  CAPABILITY_EVIDENCE_FINGERPRINT_DOMAIN,
  CAPABILITY_EVIDENCE_PROFILE_KIND,
  CAPABILITY_EVIDENCE_PROFILE_VERSION,
  type CapabilityConstraints,
  type CapabilityEvidence,
  type CapabilityEvidenceEntry,
  type CapabilityEvidenceProfile,
  type CapabilityEvidenceProfileOptions,
  type CapabilityId,
  type CapabilityRequirements,
  type CapabilityRuntimeEnvironment,
  type CapabilitySourceEndpointIdentity,
  type CapabilitySourceVerificationOptions,
  type CapabilityTruth,
  type ExtensionIdentifier,
  type ExtensionMap,
  type FilterOperatorId,
  type ObservedCapabilityTruth,
  type PaginationMode,
  type Sha256,
  type SpatialPredicate,
  type TemporalPredicate,
} from "./source-capability-types.js";

const CAPABILITY_OPTIONS_JSON_LIMITS = { depth: 3, nodes: 16, bytes: 4_096 } as const;
const EXTENSION_JSON_LIMITS = { depth: 16, nodes: 4_096, bytes: 256 * 1_024 } as const;
const CRS_JSON_LIMITS = { depth: 36, nodes: 8_192, bytes: 128 * 1_024 } as const;
const CAPABILITY_TRUTHS: readonly CapabilityTruth[] = ["supported", "unsupported", "unknown"];
const EVIDENCE_KINDS = ["protocol-default", "metadata", "conformance", "probe", "declaration"] as const;
const OBSERVED_EVIDENCE_KINDS = ["metadata", "conformance", "probe"] as const;
const CLAIM_EVIDENCE_KINDS = ["protocol-default", "declaration"] as const;
const BUILT_IN_FILTER_OPERATORS: readonly BuiltInFilterOperator[] = [
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
];
const SPATIAL_PREDICATES: readonly SpatialPredicate[] = [
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
];
const TEMPORAL_PREDICATES: readonly TemporalPredicate[] = ["before", "after", "during", "time-intersects"];
const PAGINATION_MODES: readonly PaginationMode[] = ["offset", "cursor", "next-link"];
const BUILT_IN_ENVIRONMENTS = ["browser", "worker", "node", "edge"] as const;
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*\.)+[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REFERENCE_LENGTH = 8_192;
const MAX_CAPABILITY_ENTRIES = 256;
const MAX_EVIDENCE_PER_ENTRY = 64;
const MAX_SET_VALUES = 1_024;
const MAX_SUPPORTED_CRS = 64;
const MAX_EXTENSION_KEYS = 64;

/** Validate and fingerprint static evidence once before caching or evaluation. */
export function createCapabilityEvidenceProfile(
  entries: readonly CapabilityEvidenceEntry[],
  options: CapabilityEvidenceProfileOptions,
): CapabilityEvidenceProfile {
  const safeOptions = snapshotCapabilityJson(
    options,
    "Capability evidence profile options",
    CAPABILITY_OPTIONS_JSON_LIMITS,
  ) as CapabilityEvidenceProfileOptions;
  assertPlainCapabilityObject(safeOptions, "Capability evidence profile options", [
    "sourceFingerprint",
    "sourceEndpoint",
  ]);
  if (!Object.hasOwn(safeOptions, "sourceEndpoint")) {
    throw new TypeError("Capability evidence profile options.sourceEndpoint is required");
  }
  if (safeOptions.sourceFingerprint !== undefined) {
    validateSha256(safeOptions.sourceFingerprint, "Capability evidence profile options.sourceFingerprint");
  }
  return createBoundCapabilityEvidenceProfile(entries, {
    sourceFingerprint: safeOptions.sourceFingerprint,
    sourceEndpointFingerprint: createCapabilitySourceEndpointFingerprint(safeOptions.sourceEndpoint),
    sourceEndpoint: safeOptions.sourceEndpoint,
  });
}

function createBoundCapabilityEvidenceProfile(
  entries: readonly CapabilityEvidenceEntry[],
  binding: {
    readonly sourceFingerprint?: Sha256;
    readonly sourceEndpointFingerprint: Sha256;
    readonly sourceEndpoint?: CapabilitySourceEndpointIdentity;
  },
): CapabilityEvidenceProfile {
  const safeEntries = snapshotCapabilityJson(
    entries,
    "Capability evidence entries",
    CAPABILITY_EVIDENCE_ENTRIES_JSON_LIMITS,
  ) as readonly CapabilityEvidenceEntry[];
  if (!Array.isArray(safeEntries)) throw new TypeError("Capability evidence entries must be an array");
  assertMaximumCount(safeEntries.length, MAX_CAPABILITY_ENTRIES, "Capability evidence entries");
  validateSha256(binding.sourceEndpointFingerprint, "Capability source endpoint fingerprint");
  const sourceDescriptorMatches =
    binding.sourceEndpoint === undefined ? undefined : createSourceDescriptorMatcher(binding.sourceEndpointFingerprint);

  const ids = new Set<string>();
  const normalizedEntries = safeEntries.map((entry, index) => {
    const normalized = normalizeEntry(entry, `entries[${index}]`);
    if (ids.has(normalized.id))
      throw new TypeError(`Capability evidence entries contain duplicate id ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
  normalizedEntries.sort((left, right) => compareCapabilityStrings(left.id, right.id));

  const evidenceFingerprints = new Set<Sha256>();
  for (const entry of normalizedEntries) {
    for (const evidence of entry.evidence) {
      if (evidence.sourceFingerprint !== undefined) evidenceFingerprints.add(evidence.sourceFingerprint);
    }
  }
  if (evidenceFingerprints.size > 1) {
    throw new TypeError("Capability evidence profile combines evidence from multiple source fingerprints");
  }
  const soleEvidenceFingerprint = evidenceFingerprints.values().next().value as Sha256 | undefined;
  const sourceFingerprint = binding.sourceFingerprint ?? soleEvidenceFingerprint;
  if (
    sourceFingerprint !== undefined &&
    soleEvidenceFingerprint !== undefined &&
    sourceFingerprint !== soleEvidenceFingerprint
  ) {
    throw new TypeError(
      `Capability evidence sourceFingerprint ${soleEvidenceFingerprint} does not match expected ${sourceFingerprint}`,
    );
  }
  if (sourceFingerprint === undefined) {
    throw new TypeError(
      "Capability evidence profile requires one SourceSchemaV2 sourceFingerprint, supplied explicitly or consistently by evidence",
    );
  }

  const envelope = {
    kind: CAPABILITY_EVIDENCE_PROFILE_KIND,
    version: CAPABILITY_EVIDENCE_PROFILE_VERSION,
    sourceFingerprint,
    sourceEndpointFingerprint: binding.sourceEndpointFingerprint,
    entries: normalizedEntries,
  };
  const fingerprintProjection = {
    kind: envelope.kind,
    version: envelope.version,
    sourceFingerprint: envelope.sourceFingerprint,
    sourceEndpointFingerprint: envelope.sourceEndpointFingerprint,
    entries: envelope.entries.map(projectSemanticEvidenceEntry),
  };
  const fingerprint = sha256(
    `${CAPABILITY_EVIDENCE_FINGERPRINT_DOMAIN}\n${canonicalStringify(toJsonValue(fingerprintProjection))}`,
  ) as Sha256;
  const profile = deepFreezeCapability({ ...envelope, fingerprint }) as CapabilityEvidenceProfile;
  snapshotCapabilityJson(profile, "Capability evidence profile", CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS);
  const runtimeEntries: CapabilityEvidenceRuntimeEntry[] = profile.entries.map((entry) => ({
    observations: entry.evidence.flatMap((evidence) =>
      isObservedEvidence(evidence)
        ? [
            Object.freeze({
              truth: evidence.truth,
              observedAt: capabilityInstantNanoseconds(evidence.observedAt),
              expiresAt: capabilityInstantNanoseconds(evidence.expiresAt),
              expiresAtText: evidence.expiresAt,
            }),
          ]
        : [],
    ),
  }));
  return registerCapabilityEvidenceProfile(profile, {
    entries: deepFreezeCapability(runtimeEntries),
    ...(sourceDescriptorMatches === undefined ? {} : { sourceDescriptorMatches }),
  });
}

function createSourceDescriptorMatcher(expectedFingerprint: Sha256): CapabilitySourceDescriptorMatcher {
  return (descriptor: Pick<SourceDescriptor, "id" | "protocol" | "locator">): boolean => {
    if (
      descriptor.protocol === "geoservices-feature-service" ||
      descriptor.protocol === "geoservices-map-service" ||
      descriptor.protocol === "odata" ||
      descriptor.protocol === "wms" ||
      descriptor.protocol === "wmts"
    ) {
      try {
        const identity = sourceCapabilityEndpointIdentity(descriptor);
        return createCapabilitySourceEndpointFingerprint(identity) === expectedFingerprint;
      } catch {
        return false;
      }
    }
    const identity = {
      endpoint: descriptor.locator.url,
      protocol: descriptor.protocol as SourceProtocol,
      sourceId: descriptor.id,
    };
    return createCapabilitySourceEndpointFingerprint(identity) === expectedFingerprint;
  };
}

/** Parse a strict, content-addressed static evidence envelope. */
export function parseCapabilityEvidenceProfile(
  value: string | unknown,
  options: CapabilitySourceVerificationOptions = {},
): CapabilityEvidenceProfile {
  const safeOptions = snapshotCapabilityJson(
    options,
    "Capability source verification options",
    CAPABILITY_OPTIONS_JSON_LIMITS,
  ) as CapabilitySourceVerificationOptions;
  const expectedBinding = normalizeSourceVerificationOptions(safeOptions);
  const parsed = parseCapabilityJson(value, "Capability evidence profile", CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS);
  assertPlainCapabilityObject(parsed, "Capability evidence profile", [
    "kind",
    "version",
    "fingerprint",
    "sourceFingerprint",
    "sourceEndpointFingerprint",
    "entries",
  ]);
  const record = parsed as Record<string, unknown>;
  if (record.kind !== CAPABILITY_EVIDENCE_PROFILE_KIND) {
    throw new TypeError(`Capability evidence profile.kind must be ${CAPABILITY_EVIDENCE_PROFILE_KIND}`);
  }
  if (record.version !== CAPABILITY_EVIDENCE_PROFILE_VERSION) {
    throw new TypeError(`Capability evidence profile.version must be ${CAPABILITY_EVIDENCE_PROFILE_VERSION}`);
  }
  validateSha256(record.fingerprint, "Capability evidence profile.fingerprint");
  if (!Object.hasOwn(record, "sourceFingerprint")) {
    throw new TypeError("Capability evidence profile.sourceFingerprint is required");
  }
  validateSha256(record.sourceFingerprint, "Capability evidence profile.sourceFingerprint");
  if (!Object.hasOwn(record, "sourceEndpointFingerprint")) {
    throw new TypeError("Capability evidence profile.sourceEndpointFingerprint is required");
  }
  validateSha256(record.sourceEndpointFingerprint, "Capability evidence profile.sourceEndpointFingerprint");
  const profile = createBoundCapabilityEvidenceProfile(record.entries as readonly CapabilityEvidenceEntry[], {
    sourceFingerprint: record.sourceFingerprint,
    sourceEndpointFingerprint: record.sourceEndpointFingerprint,
    ...(expectedBinding === undefined ? {} : { sourceEndpoint: expectedBinding.sourceEndpoint }),
  });
  if (profile.fingerprint !== record.fingerprint) {
    throw new TypeError("Capability evidence profile fingerprint does not match its normalized static envelope");
  }
  return expectedBinding === undefined
    ? profile
    : verifyCapabilityEvidenceProfileSource(profile, expectedBinding.sourceFingerprint, expectedBinding.sourceEndpoint);
}

/**
 * Serialize a validated evidence profile using canonical JSON. This function
 * validates common credential-shaped forms but does not sanitize caller data;
 * its output must be handled as potentially sensitive.
 */
export function serializeCapabilityEvidenceProfile(profile: CapabilityEvidenceProfile): string {
  // The runtime index is the unforgeable brand shared with the lightweight evaluator.
  // Importing the registry does not retain the CRS validator in evaluator-only bundles.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  if (!isValidatedEvidenceProfile(profile)) {
    throw new TypeError("Capability evidence profile must be created or parsed by this SDK instance");
  }
  const safeProfile = snapshotCapabilityJson(
    profile,
    "Capability evidence profile",
    CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS,
  ) as CapabilityEvidenceProfile;
  return canonicalStringify(toJsonValue(safeProfile));
}

/** Verify that a validated in-memory/cache profile belongs to the current source schema. */
export function verifyCapabilityEvidenceProfileSource(
  profile: CapabilityEvidenceProfile,
  expectedSourceFingerprint: Sha256,
  expectedSourceEndpoint: CapabilitySourceEndpointIdentity,
): CapabilityEvidenceProfile {
  if (!isValidatedEvidenceProfile(profile)) {
    throw new TypeError("Capability evidence profile must be created or parsed by this SDK instance");
  }
  validateSha256(expectedSourceFingerprint, "expectedSourceFingerprint");
  if (profile.sourceFingerprint !== expectedSourceFingerprint) {
    throw new TypeError("Capability evidence profile sourceFingerprint does not match current source schema");
  }
  const expectedEndpointFingerprint = createCapabilitySourceEndpointFingerprint(expectedSourceEndpoint);
  if (profile.sourceEndpointFingerprint !== expectedEndpointFingerprint) {
    throw new TypeError("Capability evidence profile sourceEndpointFingerprint does not match current source endpoint");
  }
  return profile;
}

function normalizeSourceVerificationOptions(
  options: CapabilitySourceVerificationOptions,
): { readonly sourceFingerprint: Sha256; readonly sourceEndpoint: CapabilitySourceEndpointIdentity } | undefined {
  assertPlainCapabilityObject(options, "Capability source verification options", [
    "expectedSourceFingerprint",
    "expectedSourceEndpoint",
  ]);
  const hasFingerprint = options.expectedSourceFingerprint !== undefined;
  const hasEndpoint = options.expectedSourceEndpoint !== undefined;
  if (hasFingerprint !== hasEndpoint) {
    throw new TypeError(
      "Capability source verification requires both expectedSourceFingerprint and expectedSourceEndpoint",
    );
  }
  if (
    !hasFingerprint ||
    options.expectedSourceFingerprint === undefined ||
    options.expectedSourceEndpoint === undefined
  ) {
    return undefined;
  }
  validateSha256(options.expectedSourceFingerprint, "expectedSourceFingerprint");
  // Validate now so malformed or credential-bearing endpoint coordinates fail
  // before transported capability content is considered.
  createCapabilitySourceEndpointFingerprint(options.expectedSourceEndpoint);
  return {
    sourceFingerprint: options.expectedSourceFingerprint,
    sourceEndpoint: options.expectedSourceEndpoint,
  };
}

function projectSemanticEvidenceEntry(entry: CapabilityEvidenceEntry): JsonValue {
  // Freshness windows remain validated transport state. Collapse otherwise
  // identical clock refreshes so endpoint capability identity stays stable.
  const evidenceByIdentity = new Map<string, JsonValue>();
  for (const evidence of entry.evidence) {
    const projection = {
      kind: evidence.kind,
      truth: evidence.truth,
      reference: evidence.reference,
      ...(evidence.sourceFingerprint === undefined ? {} : { sourceFingerprint: evidence.sourceFingerprint }),
    };
    const canonical = canonicalStringify(toJsonValue(projection));
    evidenceByIdentity.set(canonical, toJsonValue(projection));
  }
  const evidence = [...evidenceByIdentity.entries()]
    .sort(([left], [right]) => compareCapabilityCanonicalJson(left, right))
    .map(([, projection]) => projection);
  return toJsonValue({
    id: entry.id,
    claimed: entry.claimed,
    observed: entry.observed,
    evidence,
    ...(entry.authorizationScopes === undefined ? {} : { authorizationScopes: entry.authorizationScopes }),
    ...(entry.constraints === undefined ? {} : { constraints: entry.constraints }),
    ...(entry.requirements === undefined ? {} : { requirements: entry.requirements }),
  });
}

function isValidatedEvidenceProfile(profile: CapabilityEvidenceProfile): boolean {
  // Kept behind a local dynamic-free helper to make the public path explicit.
  return capabilityProfileIsRegistered(profile);
}

function capabilityProfileIsRegistered(profile: CapabilityEvidenceProfile): boolean {
  return profile !== null && typeof profile === "object" && capabilityProfileRuntimeIndex(profile) !== undefined;
}

function normalizeEntry(entry: CapabilityEvidenceEntry, path: string): CapabilityEvidenceEntry {
  assertPlainCapabilityObject(entry, path);
  const record = entry as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, "effective")) {
    throw new TypeError(`${path} must contain cacheable evidence, not a previously effective decision`);
  }
  assertExactCapabilityKeys(entry, path, [
    "id",
    "claimed",
    "observed",
    "evidence",
    "authorizationScopes",
    "constraints",
    "requirements",
  ]);
  validateCapabilityId(record.id, `${path}.id`);
  if (!CAPABILITY_TRUTHS.includes(record.claimed as CapabilityTruth)) throw new TypeError(`${path}.claimed is invalid`);
  if (record.observed !== "not-observed" && !CAPABILITY_TRUTHS.includes(record.observed as CapabilityTruth)) {
    throw new TypeError(`${path}.observed is invalid`);
  }
  const claimed = record.claimed as CapabilityTruth;
  const observed = record.observed as ObservedCapabilityTruth;
  const evidence = normalizeEvidence(record.evidence as readonly CapabilityEvidence[], `${path}.evidence`);
  assertEvidenceMatchesTruth(claimed, observed, evidence, path);
  const authorizationScopes =
    record.authorizationScopes === undefined
      ? undefined
      : normalizeRequiredIdentifiers(
          record.authorizationScopes as readonly string[],
          `${path}.authorizationScopes`,
          validateCapabilityScopeIdentifier,
        );
  const constraints =
    record.constraints === undefined
      ? undefined
      : normalizeConstraints(record.constraints as CapabilityConstraints, `${path}.constraints`);
  const requirements =
    record.requirements === undefined
      ? undefined
      : normalizeRequirements(record.requirements as CapabilityRequirements, `${path}.requirements`);
  return deepFreezeCapability({
    id: record.id as CapabilityId,
    claimed,
    observed,
    evidence,
    ...(authorizationScopes === undefined ? {} : { authorizationScopes }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(requirements === undefined ? {} : { requirements }),
  });
}

function normalizeEvidence(values: readonly CapabilityEvidence[], path: string): readonly CapabilityEvidence[] {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  assertMaximumCount(values.length, MAX_EVIDENCE_PER_ENTRY, path);
  const identities = new Set<string>();
  const normalized = values.map((value, index): CapabilityEvidence => {
    const itemPath = `${path}[${index}]`;
    assertPlainCapabilityObject(value, itemPath, [
      "kind",
      "truth",
      "reference",
      "observedAt",
      "expiresAt",
      "sourceFingerprint",
    ]);
    const record = value as unknown as Record<string, unknown>;
    if (!EVIDENCE_KINDS.includes(record.kind as never)) throw new TypeError(`${itemPath}.kind is not supported`);
    if (!CAPABILITY_TRUTHS.includes(record.truth as CapabilityTruth))
      throw new TypeError(`${itemPath}.truth is invalid`);
    validateCapabilityEvidenceReference(record.reference, `${itemPath}.reference`);
    if (record.sourceFingerprint !== undefined)
      validateSha256(record.sourceFingerprint, `${itemPath}.sourceFingerprint`);
    const observed = OBSERVED_EVIDENCE_KINDS.includes(record.kind as never);
    if (observed) {
      if (record.observedAt === undefined || record.expiresAt === undefined) {
        throw new TypeError(`${itemPath} observed evidence requires observedAt and expiresAt freshness bounds`);
      }
      if (typeof record.observedAt !== "string" || !isCapabilityIsoInstant(record.observedAt)) {
        throw new TypeError(`${itemPath}.observedAt must be an ISO-8601 UTC instant`);
      }
      if (typeof record.expiresAt !== "string" || !isCapabilityIsoInstant(record.expiresAt)) {
        throw new TypeError(`${itemPath}.expiresAt must be an ISO-8601 UTC instant`);
      }
      if (capabilityInstantNanoseconds(record.expiresAt) <= capabilityInstantNanoseconds(record.observedAt)) {
        throw new TypeError(`${itemPath}.expiresAt must be later than observedAt`);
      }
    } else if (Object.hasOwn(record, "observedAt") || Object.hasOwn(record, "expiresAt")) {
      throw new TypeError(`${itemPath} claim evidence must not contain observation freshness timestamps`);
    }
    const evidence = Object.freeze({
      kind: record.kind,
      truth: record.truth,
      reference: record.reference,
      ...(observed ? { observedAt: record.observedAt, expiresAt: record.expiresAt } : {}),
      ...(record.sourceFingerprint === undefined ? {} : { sourceFingerprint: record.sourceFingerprint }),
    }) as CapabilityEvidence;
    const identity = canonicalStringify(toJsonValue(evidence));
    if (identities.has(identity)) throw new TypeError(`${path} contains a duplicate evidence identity`);
    identities.add(identity);
    return evidence;
  });
  normalized.sort((left, right) => compareCapabilityCanonicalJson(evidenceSortKey(left), evidenceSortKey(right)));
  return Object.freeze(normalized);
}

function assertEvidenceMatchesTruth(
  claimed: CapabilityTruth,
  observed: ObservedCapabilityTruth,
  evidence: readonly CapabilityEvidence[],
  path: string,
): void {
  const claims = evidence.filter((item) => CLAIM_EVIDENCE_KINDS.includes(item.kind as never));
  if (!claims.some((item) => item.truth === claimed)) {
    throw new TypeError(`${path}.claimed must have matching protocol-default or declaration evidence`);
  }
  if (claims.some((item) => item.truth !== "unknown" && item.truth !== claimed)) {
    throw new TypeError(`${path}.claimed conflicts with its claim evidence`);
  }
  const observations = evidence.filter(isObservedEvidence);
  if (observed === "not-observed") {
    if (observations.length > 0) {
      throw new TypeError(`${path}.observed cannot be not-observed when observations exist`);
    }
    return;
  }
  if (!observations.some((item) => item.truth === observed)) {
    throw new TypeError(`${path}.observed must have matching metadata, conformance, or probe evidence`);
  }
  if (observed !== "unknown" && observations.some((item) => item.truth !== "unknown" && item.truth !== observed)) {
    throw new TypeError(`${path}.observed conflicts with its observation evidence`);
  }
}

function normalizeConstraints(value: CapabilityConstraints, path: string): CapabilityConstraints {
  assertPlainCapabilityObject(value, path, [
    "inputFormats",
    "outputFormats",
    "filterOperators",
    "spatialPredicates",
    "temporalPredicates",
    "supportedCrs",
    "pagination",
    "limits",
    "extensions",
  ]);
  const inputFormats = normalizeOptionalStrings(value.inputFormats, `${path}.inputFormats`);
  const outputFormats = normalizeOptionalStrings(value.outputFormats, `${path}.outputFormats`);
  const filterOperators = normalizeOptionalIdentifiers(
    value.filterOperators,
    `${path}.filterOperators`,
    (entry, itemPath) => {
      if (!BUILT_IN_FILTER_OPERATORS.includes(entry as BuiltInFilterOperator) && !isExtensionIdentifier(entry)) {
        throw new TypeError(`${itemPath} is not a semantic filter operator or extension id`);
      }
    },
  );
  const spatialPredicates = normalizeOptionalIdentifiers(
    value.spatialPredicates,
    `${path}.spatialPredicates`,
    (entry, itemPath) => {
      if (!SPATIAL_PREDICATES.includes(entry as SpatialPredicate))
        throw new TypeError(`${itemPath} is not a spatial predicate`);
    },
  );
  const temporalPredicates = normalizeOptionalIdentifiers(
    value.temporalPredicates,
    `${path}.temporalPredicates`,
    (entry, itemPath) => {
      if (!TEMPORAL_PREDICATES.includes(entry as TemporalPredicate)) {
        throw new TypeError(`${itemPath} is not a temporal predicate`);
      }
    },
  );
  const supportedCrs =
    value.supportedCrs === undefined ? undefined : normalizeCrs(value.supportedCrs, `${path}.supportedCrs`);
  const pagination =
    value.pagination === undefined ? undefined : normalizePagination(value.pagination, `${path}.pagination`);
  const limits = value.limits === undefined ? undefined : normalizeLimits(value.limits, `${path}.limits`);
  const extensions =
    value.extensions === undefined ? undefined : normalizeExtensions(value.extensions, `${path}.extensions`);
  const result: CapabilityConstraints = {
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
  if (Object.keys(result).length === 0) throw new TypeError(`${path} must contain at least one constraint`);
  return deepFreezeCapability(result);
}

function normalizeRequirements(value: CapabilityRequirements, path: string): CapabilityRequirements {
  assertPlainCapabilityObject(value, path, ["environments", "peers"]);
  const environments =
    value.environments === undefined
      ? undefined
      : normalizeRequiredIdentifiers(value.environments, `${path}.environments`, validateEnvironment);
  const peers =
    value.peers === undefined
      ? undefined
      : normalizeRequiredIdentifiers(value.peers, `${path}.peers`, validateCapabilityPeerIdentifier);
  if (environments === undefined && peers === undefined)
    throw new TypeError(`${path} must name an environment or peer`);
  return deepFreezeCapability({
    ...(environments === undefined ? {} : { environments: environments as readonly CapabilityRuntimeEnvironment[] }),
    ...(peers === undefined ? {} : { peers }),
  });
}

function normalizePagination(value: NonNullable<CapabilityConstraints["pagination"]>, path: string) {
  assertPlainCapabilityObject(value, path, ["modes", "maxPageSize"]);
  const modes = normalizeSetIdentifiers(value.modes, `${path}.modes`, (entry, itemPath) => {
    if (!PAGINATION_MODES.includes(entry as PaginationMode))
      throw new TypeError(`${itemPath} is not a pagination mode`);
  }) as readonly PaginationMode[];
  if (value.maxPageSize !== undefined) validatePositiveInteger(value.maxPageSize, `${path}.maxPageSize`);
  return Object.freeze({ modes, ...(value.maxPageSize === undefined ? {} : { maxPageSize: value.maxPageSize }) });
}

function normalizeLimits(value: NonNullable<CapabilityConstraints["limits"]>, path: string) {
  assertPlainCapabilityObject(value, path, ["maxRecords", "maxRequestBytes", "maxResponseBytes"]);
  for (const [name, limit] of Object.entries(value)) {
    if (limit !== undefined) validatePositiveInteger(limit, `${path}.${name}`);
  }
  const result = {
    ...(value.maxRecords === undefined ? {} : { maxRecords: value.maxRecords }),
    ...(value.maxRequestBytes === undefined ? {} : { maxRequestBytes: value.maxRequestBytes }),
    ...(value.maxResponseBytes === undefined ? {} : { maxResponseBytes: value.maxResponseBytes }),
  };
  if (Object.keys(result).length === 0) throw new TypeError(`${path} must contain at least one limit`);
  return Object.freeze(result);
}

function normalizeCrs(values: readonly ResolvedCrsDefinition[], path: string): readonly ResolvedCrsDefinition[] {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  assertMaximumCount(values.length, MAX_SUPPORTED_CRS, path);
  const canonical = values.map((value, index) => {
    const safeValue = snapshotCapabilityJson(value, `${path}[${index}]`, CRS_JSON_LIMITS);
    const definition = validateSourceCrsDefinition(safeValue);
    if (definition.kind === "unknown" || (definition.kind === "wkt" && definition.validation !== "engine")) {
      throw new TypeError(`${path}[${index}] must contain an executable resolved CRS`);
    }
    const resolved = definition as ResolvedCrsDefinition;
    return { key: canonicalStringify(toJsonValue(resolved)), value: resolved };
  });
  rejectDuplicateKeys(
    canonical.map((entry) => entry.key),
    path,
  );
  canonical.sort((left, right) => compareCapabilityCanonicalJson(left.key, right.key));
  return deepFreezeCapability(canonical.map((entry) => entry.value));
}

function normalizeExtensions(value: ExtensionMap, path: string): ExtensionMap {
  const safeValue = snapshotCapabilityJson(value, path, EXTENSION_JSON_LIMITS);
  assertPlainCapabilityObject(safeValue, path);
  assertNoSensitiveCapabilityExtension(safeValue, path);
  const keys = Object.keys(safeValue as object);
  assertMaximumCount(keys.length, MAX_EXTENSION_KEYS, path);
  for (const key of keys) {
    if (!isExtensionIdentifier(key)) throw new TypeError(`${path} keys must use reverse-DNS extension ids`);
  }
  const json = toJsonValue(safeValue, path);
  if (json === null || Array.isArray(json) || typeof json !== "object")
    throw new TypeError(`${path} must be an object`);
  return deepFreezeCapability(json as ExtensionMap);
}

function normalizeOptionalStrings(values: readonly string[] | undefined, path: string): readonly string[] | undefined {
  return values === undefined
    ? undefined
    : normalizeSetIdentifiers(values, path, (entry, itemPath) =>
        validateBoundedText(entry, itemPath, MAX_REFERENCE_LENGTH),
      );
}

function normalizeOptionalIdentifiers<T extends string>(
  values: readonly T[] | undefined,
  path: string,
  validate: (value: string, path: string) => void,
): readonly T[] | undefined {
  return values === undefined ? undefined : normalizeSetIdentifiers(values, path, validate);
}

function normalizeRequiredIdentifiers<T extends string>(
  values: readonly T[],
  path: string,
  validate: (value: string, path: string) => void,
): readonly T[] {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  return normalizeSetIdentifiers(values, path, validate);
}

function normalizeSetIdentifiers<T extends string>(
  values: readonly T[],
  path: string,
  validate: (value: string, path: string) => void,
): readonly T[] {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  assertMaximumCount(values.length, MAX_SET_VALUES, path);
  const normalized = values.map((value, index) => {
    validate(value, `${path}[${index}]`);
    return value;
  });
  rejectDuplicateKeys(normalized, path);
  return Object.freeze(normalized.sort(compareCapabilityStrings));
}

function validateCapabilityId(value: unknown, path: string): asserts value is CapabilityId {
  if (
    typeof value !== "string" ||
    (!(CAPABILITIES as readonly string[]).includes(value) && !isExtensionIdentifier(value))
  ) {
    throw new TypeError(`${path} must be a built-in capability or reverse-DNS extension id`);
  }
}

function validateEnvironment(value: string, path: string): void {
  if (!(BUILT_IN_ENVIRONMENTS as readonly string[]).includes(value) && !isExtensionIdentifier(value)) {
    throw new TypeError(`${path} must be a built-in environment or reverse-DNS extension id`);
  }
}

function validateSha256(value: unknown, path: string): asserts value is Sha256 {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  }
}

function validateBoundedText(value: unknown, path: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || hasControlCharacters(value)) {
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
  return value.length <= MAX_IDENTIFIER_LENGTH && EXTENSION_ID_PATTERN.test(value);
}

function isObservedEvidence(value: CapabilityEvidence): value is Extract<CapabilityEvidence, { observedAt: string }> {
  return OBSERVED_EVIDENCE_KINDS.includes(value.kind as never);
}

function evidenceSortKey(value: CapabilityEvidence): string {
  return canonicalStringify(toJsonValue(value));
}

function rejectDuplicateKeys(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`${path} contains a duplicate value`);
    seen.add(value);
  }
}

function assertMaximumCount(count: number, maximum: number, path: string): void {
  if (count > maximum) throw new TypeError(`${path} exceeds the maximum count ${maximum}`);
}
