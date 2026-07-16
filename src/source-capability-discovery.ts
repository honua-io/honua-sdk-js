/**
 * Focused SourceSchemaV2-bound capability discovery for GeoServices and OData.
 *
 * The pure evaluator remains in `./source-capabilities`; this entrypoint owns
 * the heavier connect/discovery graph so evaluator-only consumers can still
 * tree-shake every protocol adapter.
 *
 * @experimental
 * @module
 */

import {
  type ConnectOptions,
  type ConnectSourceCapabilityProjection,
  type HonuaConnection,
  type HonuaConnectionInspection,
  connectWithSourceSchemaProjection,
} from "./connect.js";
import type {
  DiscoveryCapabilityDecision,
  DiscoveryCapabilityPolicy,
  SourceDiscoveryInspection,
} from "./contract/discovery.js";
import { parseSourceSchemaV2 } from "./contract/schema.js";
import type { SourceSchemaV2 } from "./contract/schema.js";
import {
  CAPABILITIES,
  type Capability,
  type CapabilityAwareSource,
  type Dataset,
  type SourceDescriptor,
  type SourceId,
} from "./contract/types.js";
import { HONUA_DEFAULT_METADATA_CACHE_TTL_MS } from "./core/cache-state.js";
import { HonuaDiscoveryError } from "./core/errors.js";
import { sourceCapabilityEndpointIdentity } from "./source-capability-discovery-endpoint.js";
import { evaluateCapabilityProfile, snapshotCapabilityEvaluationContext } from "./source-capability-evaluation.js";
import { createCapabilityEvidenceProfile } from "./source-capability-evidence.js";
import {
  assertPlainCapabilityObject,
  isCapabilityIsoInstant,
  snapshotCapabilityJson,
} from "./source-capability-json.js";
import { CAPABILITY_EVALUATION_CONTEXT_JSON_LIMITS } from "./source-capability-limits.js";
import type {
  CapabilityEvaluationContext,
  CapabilityEvidence,
  CapabilityEvidenceEntry,
  CapabilityId,
  CapabilityProfile,
  CapabilityTruth,
  ObservedCapabilityTruth,
  Sha256,
} from "./source-capability-types.js";
import { SOURCE_SCHEMA_V2_CONNECT_PROJECTION } from "./source-schema-connect-projection.js";

export { sourceCapabilityEndpointIdentity } from "./source-capability-discovery-endpoint.js";
export type { CapabilityDiscoveryProtocol } from "./source-capability-discovery-endpoint.js";

const CAPABILITY_DISCOVERY_PROJECTION_IDENTITY = "honua.source-capability-discovery@1.0";
const CERTIFIED_PROTOCOLS = new Set(["geoservices-feature-service", "geoservices-map-service", "odata"]);

/** Connect options accepted by the first certified capability-discovery rollout. */
export type SourceCapabilityConnectOptions = Omit<ConnectOptions, "protocol" | "capabilityPolicy"> & {
  /** `auto` is structural and therefore resolves only canonical GeoServices URLs. */
  readonly protocol: "auto" | "geoservices-feature-service" | "geoservices-map-service" | "odata";
};

/** Fresh dynamic inputs reapplied after every raw discovery-cache read. */
export interface SourceCapabilityEvaluationOptions extends CapabilityEvaluationContext {
  /** Required deterministic clock input for observation freshness. */
  readonly evaluatedAt: string;
  /** Exclusive lifetime of one metadata observation; defaults to five minutes. */
  readonly observationTtlMs?: number;
}

/** Descriptor refinement returned by the focused capability-aware connection path. */
export type SourceDescriptorWithCapabilityProfile = Omit<SourceDescriptor, "schemaV2" | "capabilityProfile"> & {
  readonly schemaV2: SourceSchemaV2;
  readonly capabilityProfile: CapabilityProfile;
};

/** Source refinement with a required evaluated profile and matching schema identity. */
export type SourceWithCapabilityProfile<T = Record<string, unknown>> = Omit<
  CapabilityAwareSource<T>,
  "descriptor" | "capabilityProfile"
> & {
  readonly descriptor: SourceDescriptorWithCapabilityProfile;
  readonly capabilityProfile: CapabilityProfile;
};

/** Dataset refinement whose every discovered source carries a v2 capability profile. */
export type DatasetWithCapabilityProfiles = Omit<Dataset, "sourceDescriptors" | "source"> & {
  readonly sourceDescriptors: ReadonlyArray<SourceDescriptorWithCapabilityProfile>;
  source<T = Record<string, unknown>>(id: SourceId): SourceWithCapabilityProfile<T> | undefined;
};

/** Discovery inspection refinement for capability-aware connections. */
export type SourceDiscoveryInspectionWithCapabilityProfile = Omit<SourceDiscoveryInspection, "descriptor"> & {
  readonly descriptor: SourceDescriptorWithCapabilityProfile;
};

/** Connection inspection refinement for capability-aware connections. */
export type HonuaConnectionInspectionWithCapabilityProfiles = Omit<HonuaConnectionInspection, "sources"> & {
  readonly sources: readonly SourceDiscoveryInspectionWithCapabilityProfile[];
};

/** Connection returned by {@link connectWithSourceCapabilities}. */
export type HonuaConnectionWithCapabilityProfiles = Omit<HonuaConnection, "dataset" | "inspection" | "source"> & {
  readonly dataset: DatasetWithCapabilityProfiles;
  readonly inspection: HonuaConnectionInspectionWithCapabilityProfiles;
  source<T = Record<string, unknown>>(id?: SourceId): SourceWithCapabilityProfile<T>;
};

/**
 * Discover GeoServices or OData sources once, bind evidence to each canonical
 * descriptor/schema endpoint, and evaluate current support. Raw metadata and
 * SourceSchemaV2 remain the only cached values; policy, peers, environment,
 * authorization, clock, and freshness are reapplied after every cache read.
 */
export async function connectWithSourceCapabilities(
  options: SourceCapabilityConnectOptions,
  evaluation: SourceCapabilityEvaluationOptions,
): Promise<HonuaConnectionWithCapabilityProfiles> {
  assertCertifiedProtocol(options.protocol);
  const safeEvaluation = normalizeEvaluationOptions(evaluation);
  const projection = capabilityProjection(safeEvaluation);
  const capabilityPolicy = discoveryPolicy(safeEvaluation.policy);
  return (await connectWithSourceSchemaProjection(
    { ...options, ...(capabilityPolicy ? { capabilityPolicy } : {}) },
    SOURCE_SCHEMA_V2_CONNECT_PROJECTION,
    projection,
  )) as HonuaConnectionWithCapabilityProfiles;
}

function normalizeEvaluationOptions(evaluation: SourceCapabilityEvaluationOptions): SourceCapabilityEvaluationOptions {
  const safe = snapshotCapabilityJson(
    evaluation,
    "Source capability evaluation",
    CAPABILITY_EVALUATION_CONTEXT_JSON_LIMITS,
  ) as SourceCapabilityEvaluationOptions;
  assertPlainCapabilityObject(safe, "Source capability evaluation", [
    "evaluatedAt",
    "observationTtlMs",
    "policy",
    "environment",
    "availablePeers",
    "authorization",
  ]);
  if (!Object.hasOwn(safe, "evaluatedAt") || !isCapabilityIsoInstant(safe.evaluatedAt)) {
    throw new TypeError("Source capability evaluation evaluatedAt must be an ISO-8601 UTC instant");
  }
  if (
    safe.observationTtlMs !== undefined &&
    (!Number.isSafeInteger(safe.observationTtlMs) || safe.observationTtlMs <= 0)
  ) {
    throw new TypeError("Source capability evaluation observationTtlMs must be a positive safe integer");
  }
  return safe;
}

function capabilityProjection(evaluation: SourceCapabilityEvaluationOptions): ConnectSourceCapabilityProjection {
  const observationTtlMs = evaluation.observationTtlMs ?? HONUA_DEFAULT_METADATA_CACHE_TTL_MS;
  const context = snapshotCapabilityEvaluationContext({
    evaluatedAt: evaluation.evaluatedAt,
    ...(evaluation.policy !== undefined ? { policy: evaluation.policy } : {}),
    ...(evaluation.environment !== undefined ? { environment: evaluation.environment } : {}),
    ...(evaluation.availablePeers !== undefined ? { availablePeers: evaluation.availablePeers } : {}),
    ...(evaluation.authorization !== undefined ? { authorization: evaluation.authorization } : {}),
  });
  const projection: ConnectSourceCapabilityProjection = {
    cacheIdentity: CAPABILITY_DISCOVERY_PROJECTION_IDENTITY,
    project(descriptor, resolution, projectionContext) {
      if (!CERTIFIED_PROTOCOLS.has(descriptor.protocol)) {
        throw new HonuaDiscoveryError(
          "unsupported-protocol",
          `Capability-aware discovery is not certified for protocol "${descriptor.protocol}".`,
          { protocol: descriptor.protocol },
        );
      }
      if (descriptor.schemaV2 === undefined) {
        throw new HonuaDiscoveryError(
          "invalid-capability",
          `Capability-aware discovery requires SourceSchemaV2 metadata for source "${descriptor.id}".`,
          { sourceId: descriptor.id, protocol: descriptor.protocol },
        );
      }
      const schema = parseSourceSchemaV2(descriptor.schemaV2);
      const expiresAt = observationExpiry(projectionContext.observedAt, observationTtlMs);
      const entries = resolution.decisions.map((decision) =>
        discoveryEvidenceEntry(
          decision,
          descriptor.protocol,
          schema.fingerprint,
          projectionContext.observedAt,
          expiresAt,
        ),
      );
      const evidenceProfile = createCapabilityEvidenceProfile(entries, {
        sourceFingerprint: schema.fingerprint,
        sourceEndpoint: sourceCapabilityEndpointIdentity(descriptor),
      });
      return evaluateCapabilityProfile(evidenceProfile, context);
    },
  };
  return Object.freeze(projection);
}

function discoveryEvidenceEntry(
  decision: DiscoveryCapabilityDecision,
  protocol: SourceDescriptor["protocol"],
  sourceFingerprint: Sha256,
  observedAt: string,
  expiresAt: string,
): CapabilityEvidenceEntry {
  const claimed: CapabilityTruth = decision.adapterSupported ? "supported" : "unsupported";
  const observed = observedTruth(decision);
  const evidence: CapabilityEvidence[] = [
    {
      kind: "protocol-default",
      truth: claimed,
      reference: `adapter:${protocol}:${decision.capability}`,
      sourceFingerprint,
    },
  ];
  if (observed !== "not-observed") {
    evidence.push({
      kind: "metadata",
      truth: observed,
      reference: `discovery:${protocol}:${decision.capability}:${observed}`,
      observedAt,
      expiresAt,
      sourceFingerprint,
    });
  }
  return {
    id: decision.capability,
    claimed,
    observed,
    evidence,
  };
}

function observedTruth(decision: DiscoveryCapabilityDecision): ObservedCapabilityTruth {
  if (!decision.adapterSupported) return "not-observed";
  const authoritative = decision.evidence.filter((entry) => entry.kind === "metadata" || entry.kind === "declared");
  if (authoritative.some((entry) => !entry.supported)) return "unsupported";
  if (authoritative.some((entry) => entry.supported)) return "supported";
  if (decision.evidence.some((entry) => entry.kind === "unavailable" || entry.kind === "inferred")) return "unknown";
  return "not-observed";
}

function discoveryPolicy(policy: CapabilityEvaluationContext["policy"]): DiscoveryCapabilityPolicy | undefined {
  if (policy === undefined) return undefined;
  const allow = policy.allow?.filter(isBuiltInCapability);
  const deny = (policy.deny ?? []).filter(isBuiltInCapability);
  return Object.freeze({ ...(allow ? { allow: Object.freeze(allow) } : {}), deny: Object.freeze(deny) });
}

function isBuiltInCapability(value: CapabilityId): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

function observationExpiry(observedAt: string, ttlMs: number): string {
  if (!isCapabilityIsoInstant(observedAt)) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Capability discovery snapshot has an invalid retrieval instant.",
    );
  }
  const observedMs = Date.parse(observedAt);
  const expiryMs = observedMs + ttlMs;
  if (!Number.isFinite(observedMs) || !Number.isFinite(expiryMs)) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Capability discovery snapshot retrieval instant is outside the supported freshness range.",
    );
  }
  try {
    return new Date(expiryMs).toISOString();
  } catch (cause) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Capability discovery freshness boundary is outside the supported date range.",
      undefined,
      { cause },
    );
  }
}

function assertCertifiedProtocol(protocol: SourceCapabilityConnectOptions["protocol"]): void {
  if (protocol === "auto" || CERTIFIED_PROTOCOLS.has(protocol)) return;
  throw new HonuaDiscoveryError(
    "unsupported-protocol",
    `Capability-aware discovery is currently certified for GeoServices and OData, not "${String(protocol)}".`,
    { protocol },
  );
}
