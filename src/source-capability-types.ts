import type { JsonValue, ResolvedCrsDefinition, SourceProtocol } from "./contract/schema.js";
import type { Capability as BuiltInCapabilityId } from "./contract/types.js";

export const CAPABILITY_EVIDENCE_PROFILE_KIND = "honua.capability-evidence" as const;
export const CAPABILITY_EVIDENCE_PROFILE_VERSION = "1.0" as const;
export const CAPABILITY_EVIDENCE_FINGERPRINT_DOMAIN = "honua:capability-evidence:1.0" as const;
export const CAPABILITY_SOURCE_ENDPOINT_FINGERPRINT_DOMAIN = "honua:capability-source-endpoint:1.0" as const;
export const CAPABILITY_PROFILE_KIND = "honua.capabilities" as const;
export const CAPABILITY_PROFILE_VERSION = "1.0" as const;
export const CAPABILITY_PROFILE_FINGERPRINT_DOMAIN = "honua:capabilities:1.0" as const;

export type ExtensionIdentifier = `${string}.${string}`;
export type Sha256 = `sha256:${string}`;
export type IsoInstant = string;
export type CapabilityId = BuiltInCapabilityId | ExtensionIdentifier;
export type CapabilityTruth = "supported" | "unsupported" | "unknown";
export type ObservedCapabilityTruth = CapabilityTruth | "not-observed";

export type CapabilityClaimEvidenceKind = "protocol-default" | "declaration";
export type CapabilityObservationEvidenceKind = "metadata" | "conformance" | "probe";
export type CapabilityEvidenceKind = CapabilityClaimEvidenceKind | CapabilityObservationEvidenceKind;

interface CapabilityEvidenceBase {
  readonly truth: CapabilityTruth;
  /**
   * Stable evidence identity. Common credential-shaped forms are rejected, but
   * callers must still treat accepted values as potentially sensitive and must
   * not supply credentials, signed URLs, or secrets.
   */
  readonly reference: string;
  /** Evidence identity only; when present it must match the enclosing source profile. */
  readonly sourceFingerprint?: Sha256;
}

export interface CapabilityClaimEvidence extends CapabilityEvidenceBase {
  readonly kind: CapabilityClaimEvidenceKind;
  readonly observedAt?: never;
  readonly expiresAt?: never;
}

export interface CapabilityObservationEvidence extends CapabilityEvidenceBase {
  readonly kind: CapabilityObservationEvidenceKind;
  readonly observedAt: IsoInstant;
  /** Exclusive freshness boundary. */
  readonly expiresAt: IsoInstant;
}

export type CapabilityEvidence = CapabilityClaimEvidence | CapabilityObservationEvidence;

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
  /** Caller metadata. Sensitive keys/forms are rejected; credentials remain prohibited. */
  readonly extensions?: ExtensionMap;
}

export type CapabilityRuntimeEnvironment = "browser" | "worker" | "node" | "edge" | ExtensionIdentifier;

/**
 * Credential-free source endpoint coordinates used only to derive a digest.
 * Query strings, fragments, URL user-info, and credential-shaped source ids
 * are rejected before hashing and the raw coordinates are never transported.
 */
export interface CapabilitySourceEndpointIdentity {
  readonly endpoint: string;
  readonly protocol: SourceProtocol;
  readonly sourceId?: string;
}

/** Static execution requirements retained in evidence and evaluated decisions. */
export interface CapabilityRequirements {
  readonly environments?: readonly CapabilityRuntimeEnvironment[];
  /** Structural package/runtime identifiers; credential values are prohibited. */
  readonly peers?: readonly string[];
}

/** One normalized, cacheable claimed/observed entry. */
export interface CapabilityEvidenceEntry {
  readonly id: CapabilityId;
  readonly claimed: CapabilityTruth;
  readonly observed: ObservedCapabilityTruth;
  readonly evidence: readonly CapabilityEvidence[];
  /** Structural scope identifiers only. Tokens and credentials are prohibited. */
  readonly authorizationScopes?: readonly string[];
  readonly constraints?: CapabilityConstraints;
  readonly requirements?: CapabilityRequirements;
}

/** @deprecated Use {@link CapabilityEvidenceEntry}. */
export type CapabilityEvaluationEntry = CapabilityEvidenceEntry;

export interface CapabilityEvidenceProfileOptions {
  /** SourceSchemaV2 SHA-256 identity. May be derived only from consistent evidence. */
  readonly sourceFingerprint?: Sha256;
  /** Required credential-free endpoint coordinates; only their derived digest is retained. */
  readonly sourceEndpoint: CapabilitySourceEndpointIdentity;
}

export interface CapabilitySourceVerificationOptions {
  /** Current SourceSchemaV2 SHA-256 identity. Must be paired with expectedSourceEndpoint. */
  readonly expectedSourceFingerprint?: Sha256;
  /** Current credential-free endpoint coordinates. Must be paired with expectedSourceFingerprint. */
  readonly expectedSourceEndpoint?: CapabilitySourceEndpointIdentity;
}

/** Heavy, one-time validated transport/cache envelope for one source. */
export interface CapabilityEvidenceProfile {
  readonly kind: typeof CAPABILITY_EVIDENCE_PROFILE_KIND;
  readonly version: typeof CAPABILITY_EVIDENCE_PROFILE_VERSION;
  readonly fingerprint: Sha256;
  /** Required SourceSchemaV2 identity for cache invalidation and source binding. */
  readonly sourceFingerprint: Sha256;
  /** Required digest of normalized protocol/endpoint/source coordinates. */
  readonly sourceEndpointFingerprint: Sha256;
  readonly entries: readonly CapabilityEvidenceEntry[];
}

/** Dynamic policy for the canonical claimed/observed/effective evaluator. */
export interface CapabilityEvaluationPolicy {
  /** Optional allow-list. An omitted list allows every evidence-supported entry. */
  readonly allow?: readonly CapabilityId[];
  /** Explicit deny-list. Denial wins when an id appears in both lists. */
  readonly deny?: readonly CapabilityId[];
}

export interface CapabilityAuthorizationContext {
  /** Structural scope identifiers; credential/token values are prohibited. */
  readonly grantedScopes?: readonly string[];
  /** Scopes the current principal is known not to be allowed to acquire. */
  readonly deniedScopes?: readonly string[];
}

/** Dynamic inputs refreshed for each lightweight evaluation. */
export interface CapabilityEvaluationContext {
  /** Explicit deterministic clock input. Omission makes observation freshness unknown. */
  readonly evaluatedAt?: IsoInstant;
  readonly policy?: CapabilityEvaluationPolicy;
  readonly environment?: CapabilityRuntimeEnvironment;
  /** Structural package/runtime identifiers; credential values are prohibited. */
  readonly availablePeers?: readonly string[];
  readonly authorization?: CapabilityAuthorizationContext;
}

/**
 * Normalized caller-controlled context retained so transported decisions can
 * be reverified. It is not a sanitizer; profiles remain potentially sensitive.
 */
export interface CapabilityEvaluationContextSnapshot {
  readonly policy?: {
    readonly allow?: readonly CapabilityId[];
    readonly deny: readonly CapabilityId[];
  };
  readonly environment?: CapabilityRuntimeEnvironment;
  readonly availablePeers: readonly string[];
  readonly authorization: {
    readonly grantedScopes: readonly string[];
    readonly deniedScopes: readonly string[];
  };
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
  | "freshness-not-evaluated"
  | "evidence-not-yet-current"
  | "evidence-stale"
  | "policy-disabled"
  | `environment-unavailable:${string}`
  | `peer-unavailable:${string}`
  | `authorization-required:${string}`
  | `authorization-denied:${string}`;

export interface CapabilityDecision extends CapabilityEvidenceEntry {
  readonly effective: EffectiveCapabilityState;
  readonly reasons: readonly CapabilityDecisionReason[];
}

/**
 * Auditable evaluated truth derived from one evidence envelope and one dynamic
 * context. Caller-controlled values make serialized profiles potentially sensitive.
 */
export interface CapabilityProfile {
  readonly kind: typeof CAPABILITY_PROFILE_KIND;
  readonly version: typeof CAPABILITY_PROFILE_VERSION;
  readonly fingerprint: Sha256;
  readonly evidenceFingerprint: Sha256;
  readonly sourceFingerprint: Sha256;
  readonly sourceEndpointFingerprint: Sha256;
  readonly evaluatedAt: IsoInstant | null;
  /** Exclusive conservative boundary; null means no freshness window was established. */
  readonly validUntil: IsoInstant | null;
  readonly context: CapabilityEvaluationContextSnapshot;
  readonly entries: readonly CapabilityDecision[];
}
