/**
 * Protocol-neutral discovery truth and cache identity contracts.
 *
 * Protocol defaults describe what an adapter can implement; they are not
 * evidence that a particular endpoint enables those operations. These helpers
 * keep that distinction explicit while endpoint-specific discovery lands.
 */

import { HonuaDiscoveryError } from "../core/errors.js";

/** Default adapter implementation version included in every discovery cache identity. */
export const HONUA_DISCOVERY_ADAPTER_VERSION = "honua-discovery-adapter@1";
/** Default normalized inspection projection version included in every discovery cache identity. */
export const HONUA_DISCOVERY_PROJECTION_VERSION = "honua-source-inspection@1";
import {
  CAPABILITIES,
  type Capabilities,
  type Capability,
  PROTOCOLS,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type SourceDescriptor,
} from "./types.js";

export type DiscoveryEvidenceKind = "metadata" | "declared" | "inferred" | "unavailable";
export type DiscoveryState = DiscoveryEvidenceKind | "mixed";

const DISCOVERY_EVIDENCE_KINDS: readonly DiscoveryEvidenceKind[] = ["metadata", "declared", "inferred", "unavailable"];

export interface DiscoveryProvenance {
  readonly source: string;
  readonly retrievedAt?: string;
  readonly validator?: string;
}

export type DiscoveryCapabilityEvidence =
  | {
      readonly kind: "metadata" | "declared";
      readonly capabilities: readonly Capability[];
      /** Capabilities this record evaluated; omitted means the adapter's complete capability surface. */
      readonly scope?: readonly Capability[];
      readonly provenance?: readonly DiscoveryProvenance[];
    }
  | {
      readonly kind: "inferred";
      readonly capabilities: readonly Capability[];
      readonly scope?: readonly Capability[];
      readonly reason: string;
      readonly provenance?: readonly DiscoveryProvenance[];
    }
  | {
      readonly kind: "unavailable";
      /** Optional failed subset; omitted means discovery was unavailable for the complete adapter surface. */
      readonly scope?: readonly Capability[];
      readonly reason: string;
      readonly provenance?: readonly DiscoveryProvenance[];
    };

export interface DiscoveryCapabilityEvidenceSummary {
  readonly kind: DiscoveryEvidenceKind;
  readonly supported: boolean;
  readonly reason?: string;
  readonly provenance: readonly DiscoveryProvenance[];
}

export interface DiscoveryCapabilityPolicy {
  /** Optional allow-list applied after adapter and endpoint evidence. */
  readonly allow?: readonly Capability[];
  /** Explicit deny-list; denial always wins over allow. */
  readonly deny?: readonly Capability[];
  /** Inferred support is non-authoritative and rejected unless explicitly accepted. */
  readonly acceptInferred?: boolean;
}

export type DiscoveryCapabilityDecisionCode =
  | "enabled"
  | "adapter-unsupported"
  | "not-advertised"
  | "policy-denied"
  | "inferred-not-accepted"
  | "discovery-unavailable";

export interface DiscoveryCapabilityDecision {
  readonly capability: Capability;
  readonly effective: boolean;
  readonly code: DiscoveryCapabilityDecisionCode;
  readonly evidence: readonly DiscoveryCapabilityEvidenceSummary[];
  readonly adapterSupported: boolean;
  /** At least one evidence record asserted support; this is not the resolved truth decision. */
  readonly positiveEvidence: boolean;
  readonly policyAllowed: boolean;
  readonly reason: string;
}

export type DiscoveryDiagnosticCode =
  | "discovery-unavailable"
  | "partial-discovery"
  | "conflicting-evidence"
  | "inferred-capabilities-rejected"
  | "evidence-exceeds-adapter"
  | "capability-policy-restricted";

export interface DiscoveryDiagnostic {
  readonly code: DiscoveryDiagnosticCode;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly capabilities?: readonly Capability[];
}

export interface DiscoveryCapabilityResolution {
  readonly protocol: Protocol;
  readonly discovery: DiscoveryState;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly provenance: readonly DiscoveryProvenance[];
  readonly capabilities: Capabilities;
  readonly decisions: readonly DiscoveryCapabilityDecision[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

export interface SourceDiscoveryInspection {
  readonly descriptor: SourceDescriptor;
  readonly discovery: DiscoveryState;
  readonly provenance: readonly DiscoveryProvenance[];
  readonly capabilityDecisions: readonly DiscoveryCapabilityDecision[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

/**
 * Intersect adapter support, endpoint evidence, and caller policy.
 *
 * `unavailable` and unaccepted `inferred` evidence intentionally produce no
 * effective capabilities. Callers with trusted configuration should use
 * `declared` evidence rather than presenting protocol defaults as discovery.
 */
export function resolveDiscoveryCapabilities(
  protocol: Protocol,
  evidence: DiscoveryCapabilityEvidence | readonly DiscoveryCapabilityEvidence[],
  policy: DiscoveryCapabilityPolicy = {},
): DiscoveryCapabilityResolution {
  const adapter = DISCOVERY_ADAPTER_MAXIMA.get(protocol);
  if (!adapter) {
    throw new HonuaDiscoveryError("unsupported-protocol", `Unknown discovery protocol "${String(protocol)}".`, {
      protocol,
    });
  }
  const evidenceRecords = normalizeEvidence(evidence, adapter);
  const allow = policy.allow ? capabilitySet(policy.allow, "policy.allow") : undefined;
  const deny = capabilitySet(policy.deny ?? [], "policy.deny");
  const effective: Capability[] = [];
  const decisions = CAPABILITIES.map((capability): DiscoveryCapabilityDecision => {
    const adapterSupported = adapter.has(capability);
    const relevant = evidenceRecords.filter((record) => record.scope.has(capability));
    const positive = relevant.filter((record) => record.capabilities.has(capability));
    const authoritativeNegative = relevant.some(
      (record) => (record.kind === "metadata" || record.kind === "declared") && !record.capabilities.has(capability),
    );
    const metadataPositive = positive.some((record) => record.kind === "metadata");
    const declaredPositive = positive.some((record) => record.kind === "declared");
    const inferredPositive = positive.some((record) => record.kind === "inferred");
    const unavailable = relevant.some((record) => record.kind === "unavailable");
    const positiveEvidence = metadataPositive || declaredPositive || inferredPositive;
    const policyAllowed = (allow === undefined || allow.has(capability)) && !deny.has(capability);
    const code = !adapterSupported
      ? "adapter-unsupported"
      : authoritativeNegative
        ? "not-advertised"
        : metadataPositive
          ? policyAllowed
            ? "enabled"
            : "policy-denied"
          : declaredPositive
            ? policyAllowed
              ? "enabled"
              : "policy-denied"
            : inferredPositive
              ? policy.acceptInferred === true
                ? policyAllowed
                  ? "enabled"
                  : "policy-denied"
                : "inferred-not-accepted"
              : unavailable
                ? "discovery-unavailable"
                : "not-advertised";
    const isEffective = code === "enabled";
    if (isEffective) effective.push(capability);
    return Object.freeze({
      capability,
      effective: isEffective,
      code,
      evidence: Object.freeze(relevant.map((record) => evidenceSummary(record, capability))),
      adapterSupported,
      positiveEvidence,
      policyAllowed,
      reason: capabilityDecisionReason(code, capability),
    });
  });

  const observed = new Set(evidenceRecords.flatMap((record) => [...record.capabilities]));
  const outsideAdapter = [...observed].filter((capability) => !adapter.has(capability));
  const policyRestricted = decisions
    .filter((decision) => decision.code === "policy-denied")
    .map((decision) => decision.capability);
  const diagnostics: DiscoveryDiagnostic[] = [];
  const unavailableRecords = evidenceRecords.filter((record) => record.kind === "unavailable");
  for (const record of unavailableRecords) {
    diagnostics.push({
      code: "discovery-unavailable",
      severity: "warning",
      message: record.reason ?? "Discovery evidence is unavailable.",
      capabilities: orderedCapabilities(record.scope),
    });
  }
  if (unavailableRecords.length > 0 && evidenceRecords.some((record) => record.kind !== "unavailable")) {
    diagnostics.push({
      code: "partial-discovery",
      severity: "warning",
      message: "Some capability evidence is available while one or more discovery sources failed.",
    });
  }
  const inferredRejected = decisions
    .filter((decision) => decision.code === "inferred-not-accepted")
    .map((decision) => decision.capability);
  if (inferredRejected.length > 0) {
    diagnostics.push({
      code: "inferred-capabilities-rejected",
      severity: "warning",
      message: "Inferred capabilities were recorded but not enabled without explicit caller acceptance.",
      capabilities: Object.freeze(inferredRejected),
    });
  }
  const conflicts = decisions
    .filter(
      (decision) =>
        decision.code === "not-advertised" &&
        decision.evidence.some(
          (entry) => (entry.kind === "metadata" || entry.kind === "declared") && entry.supported,
        ) &&
        decision.evidence.some((entry) => (entry.kind === "metadata" || entry.kind === "declared") && !entry.supported),
    )
    .map((decision) => decision.capability);
  if (conflicts.length > 0) {
    diagnostics.push({
      code: "conflicting-evidence",
      severity: "warning",
      message: "Conflicting authoritative evidence was resolved conservatively by disabling the affected capabilities.",
      capabilities: Object.freeze(conflicts),
    });
  }
  if (outsideAdapter.length > 0) {
    diagnostics.push({
      code: "evidence-exceeds-adapter",
      severity: "warning",
      message: "Discovery evidence asserts operations that this SDK adapter cannot implement.",
      capabilities: orderedCapabilities(new Set(outsideAdapter)),
    });
  }
  if (policyRestricted.length > 0) {
    diagnostics.push({
      code: "capability-policy-restricted",
      severity: "info",
      message: "Caller policy removed endpoint-supported capabilities.",
      capabilities: orderedCapabilities(new Set(policyRestricted)),
    });
  }

  return Object.freeze({
    protocol,
    discovery: discoveryState(evidenceRecords),
    evidence: Object.freeze(evidenceRecords.map((record) => record.original)),
    provenance: Object.freeze(uniqueProvenance(evidenceRecords.flatMap((record) => record.provenance))),
    capabilities: immutableCapabilities(effective),
    decisions: Object.freeze(decisions),
    diagnostics: Object.freeze(diagnostics.map(freezeDiagnostic)),
  });
}

/** Apply one reviewed discovery resolution to a source descriptor. */
export function inspectDiscoveredSource(
  descriptor: SourceDescriptor,
  resolution: DiscoveryCapabilityResolution,
): SourceDiscoveryInspection {
  if (descriptor.protocol !== resolution.protocol) {
    throw new HonuaDiscoveryError(
      "protocol-mismatch",
      `Source protocol "${descriptor.protocol}" does not match discovery protocol "${resolution.protocol}".`,
      { sourceId: descriptor.id, descriptorProtocol: descriptor.protocol, discoveryProtocol: resolution.protocol },
    );
  }
  assertResolutionIntegrity(resolution);
  return Object.freeze({
    descriptor: immutableDescriptor(descriptor, resolution.capabilities),
    discovery: resolution.discovery,
    provenance: resolution.provenance,
    capabilityDecisions: resolution.decisions,
    diagnostics: resolution.diagnostics,
  });
}

function assertResolutionIntegrity(resolution: DiscoveryCapabilityResolution): void {
  const effectiveDecisions = resolution.decisions
    .filter((decision) => decision.effective && decision.code === "enabled")
    .map((decision) => decision.capability);
  const resolved = orderedCapabilities(resolution.capabilities);
  if (
    effectiveDecisions.length !== resolved.length ||
    effectiveDecisions.some((capability, index) => capability !== resolved[index])
  ) {
    throw new HonuaDiscoveryError(
      "invalid-capability",
      "Discovery capability resolution was mutated or does not match its per-capability decisions.",
      { protocol: resolution.protocol },
    );
  }
}

export interface DiscoveryCacheResourceIdentity {
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly sourceId?: string;
  readonly serviceId?: string;
  readonly layerId?: string | number;
  readonly collectionId?: string | number;
  /** WFS feature type or WMS layer name at a shared service endpoint. */
  readonly typeName?: string;
  readonly tileMatrixSetId?: string;
  readonly styleId?: string;
  readonly entitySet?: string;
  readonly processId?: string;
  readonly crs?: string;
  readonly format?: string;
  readonly locale?: string;
  readonly profile?: string;
}

export interface DiscoveryCacheIdentityOptions extends DiscoveryCacheResourceIdentity {
  readonly endpoint: string | URL;
  readonly protocol: Protocol | "auto";
  /** Stable opaque fingerprint for the auth/ACL scope; never pass a token. */
  readonly authorizationScopeFingerprint: string;
  /** Defaults to {@link HONUA_DISCOVERY_ADAPTER_VERSION}; never omitted from the key. */
  readonly adapterVersion?: string;
  /** Defaults to {@link HONUA_DISCOVERY_PROJECTION_VERSION}; never omitted from the key. */
  readonly projectionVersion?: string;
  /** Additional endpoint query names the owning adapter classifies as transient. */
  readonly transientQueryParameters?: readonly string[];
}

export interface DiscoveryCacheIdentity {
  readonly version: 1;
  readonly endpoint: string;
  readonly protocol: Protocol | "auto";
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly key: string;
}

const CREDENTIAL_ENDPOINT_PARAMETERS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "client_secret",
  "code",
  "id_token",
  "jwt",
  "password",
  "passwd",
  "refresh_token",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "sig",
  "signature",
  "token",
]);

const AMBIGUOUS_CREDENTIAL_ENDPOINT_PARAMETERS = new Set([
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "code",
  "credential",
  "key",
  "ocp-apim-subscription-key",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "subscription-key",
  "subscription_key",
]);

/** Normalize an endpoint for discovery identity without retaining credentials. */
export function normalizeDiscoveryEndpoint(
  endpoint: string | URL,
  options: { readonly transientQueryParameters?: readonly string[] } = {},
): string {
  const callerTransient = new Set((options.transientQueryParameters ?? []).map((value) => value.toLowerCase()));
  return normalizeEndpoint(endpoint, (key) => {
    const normalized = key.toLowerCase();
    return isCredentialEndpointParameter(normalized) || callerTransient.has(normalized);
  });
}

/**
 * Build the deterministic logical identity used by discovery metadata caches.
 * The key contains no URL credentials, bearer tokens, signed-URL parameters,
 * or raw authorization material.
 */
export async function createDiscoveryCacheIdentity(
  options: DiscoveryCacheIdentityOptions,
): Promise<DiscoveryCacheIdentity> {
  const authorizationScopeFingerprint = requiredIdentity(
    options.authorizationScopeFingerprint,
    "authorizationScopeFingerprint",
  );
  const adapterVersion =
    options.adapterVersion === undefined
      ? HONUA_DISCOVERY_ADAPTER_VERSION
      : requiredIdentity(options.adapterVersion, "adapterVersion");
  const projectionVersion =
    options.projectionVersion === undefined
      ? HONUA_DISCOVERY_PROJECTION_VERSION
      : requiredIdentity(options.projectionVersion, "projectionVersion");
  if (options.protocol !== "auto" && !(PROTOCOLS as readonly string[]).includes(options.protocol)) {
    throw new HonuaDiscoveryError("unsupported-protocol", `Unknown discovery protocol "${String(options.protocol)}".`, {
      protocol: options.protocol,
    });
  }
  const endpoint = normalizeDiscoveryEndpoint(options.endpoint, options);
  const callerTransient = new Set((options.transientQueryParameters ?? []).map((value) => value.toLowerCase()));
  const identityEndpoint = normalizeEndpoint(options.endpoint, (key) => {
    const normalized = key.toLowerCase();
    return (
      (isCredentialEndpointParameter(normalized) && !AMBIGUOUS_CREDENTIAL_ENDPOINT_PARAMETERS.has(normalized)) ||
      callerTransient.has(normalized)
    );
  });
  const [endpointDigest, authorizationScopeDigest] = await Promise.all([
    sha256(identityEndpoint),
    sha256(`honua-discovery-scope:v1:${authorizationScopeFingerprint}`),
  ]);
  const dimensions: Record<string, string> = {
    endpointDigest,
    protocol: options.protocol,
    authorizationScopeDigest,
    adapterVersion,
    projectionVersion,
  };
  for (const key of DISCOVERY_RESOURCE_KEYS) {
    const value = options[key];
    if (value !== undefined && String(value).length > 0) dimensions[key] = String(value);
  }
  const key = `discovery:v1:${Object.keys(dimensions)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(dimensions[name] as string)}`)
    .join("&")}`;
  return Object.freeze({
    version: 1 as const,
    endpoint,
    protocol: options.protocol,
    authorizationScopeDigest,
    key,
  });
}

const DISCOVERY_RESOURCE_KEYS: readonly (keyof DiscoveryCacheResourceIdentity)[] = [
  "tenantId",
  "projectId",
  "sourceId",
  "serviceId",
  "layerId",
  "collectionId",
  "typeName",
  "tileMatrixSetId",
  "styleId",
  "entitySet",
  "processId",
  "crs",
  "format",
  "locale",
  "profile",
];

function capabilitySet(values: readonly Capability[], path: string): Set<Capability> {
  const known = new Set<Capability>(CAPABILITIES);
  const out = new Set<Capability>();
  for (const value of values) {
    if (!known.has(value)) {
      throw new HonuaDiscoveryError("invalid-capability", `${path} contains unknown capability "${String(value)}".`, {
        path,
        capability: value,
      });
    }
    out.add(value);
  }
  return out;
}

interface NormalizedEvidenceRecord {
  readonly kind: DiscoveryEvidenceKind;
  readonly capabilities: ReadonlySet<Capability>;
  readonly scope: ReadonlySet<Capability>;
  readonly reason?: string;
  readonly provenance: readonly DiscoveryProvenance[];
  readonly original: DiscoveryCapabilityEvidence;
}

function normalizeEvidence(
  input: DiscoveryCapabilityEvidence | readonly DiscoveryCapabilityEvidence[],
  adapter: Capabilities,
): readonly NormalizedEvidenceRecord[] {
  const values: readonly DiscoveryCapabilityEvidence[] = Array.isArray(input)
    ? input
    : [input as DiscoveryCapabilityEvidence];
  if (values.length === 0) {
    throw new HonuaDiscoveryError("invalid-capability", "Discovery evidence must contain at least one record.");
  }
  return Object.freeze(
    values.map((value, index): NormalizedEvidenceRecord => {
      const path = `evidence[${index}]`;
      const kind = discoveryEvidenceKind(value, path);
      const observed =
        kind === "unavailable"
          ? new Set<Capability>()
          : capabilitySet((value as { readonly capabilities: readonly Capability[] }).capabilities, path);
      const scope = value.scope
        ? capabilitySet(value.scope, `${path}.scope`)
        : new Set<Capability>([...adapter, ...observed]);
      for (const capability of observed) {
        if (!scope.has(capability)) {
          throw new HonuaDiscoveryError(
            "invalid-capability",
            `${path}.capabilities contains "${capability}" outside its evaluated scope.`,
            { path, capability },
          );
        }
      }
      const provenance = Object.freeze(
        (value.provenance ?? []).map((entry, provenanceIndex) =>
          normalizeProvenance(entry, `${path}.provenance[${provenanceIndex}]`),
        ),
      );
      const original = Object.freeze({
        ...value,
        ...(kind !== "unavailable" ? { capabilities: Object.freeze([...observed]) } : {}),
        ...(value.scope ? { scope: Object.freeze([...scope]) } : {}),
        ...(provenance.length > 0 ? { provenance } : {}),
      }) as DiscoveryCapabilityEvidence;
      return Object.freeze({
        kind,
        capabilities: observed,
        scope,
        ...(kind === "inferred" || kind === "unavailable"
          ? { reason: (value as { readonly reason: string }).reason }
          : {}),
        provenance,
        original,
      });
    }),
  );
}

function discoveryEvidenceKind(value: unknown, path: string): DiscoveryEvidenceKind {
  const kind = value !== null && typeof value === "object" ? (value as { readonly kind?: unknown }).kind : undefined;
  if (!(DISCOVERY_EVIDENCE_KINDS as readonly unknown[]).includes(kind)) {
    throw new HonuaDiscoveryError(
      "invalid-capability",
      `${path}.kind must be one of ${DISCOVERY_EVIDENCE_KINDS.join(", ")}; received "${String(kind)}".`,
      { path: `${path}.kind`, kind },
    );
  }
  return kind as DiscoveryEvidenceKind;
}

function evidenceSummary(record: NormalizedEvidenceRecord, capability: Capability): DiscoveryCapabilityEvidenceSummary {
  return Object.freeze({
    kind: record.kind,
    supported: record.capabilities.has(capability),
    ...(record.reason ? { reason: record.reason } : {}),
    provenance: record.provenance,
  });
}

function discoveryState(records: readonly NormalizedEvidenceRecord[]): DiscoveryState {
  const kinds = new Set(records.map((record) => record.kind));
  return kinds.size === 1 ? (records[0]?.kind ?? "unavailable") : "mixed";
}

function normalizeProvenance(value: DiscoveryProvenance, path: string): DiscoveryProvenance {
  const source = value.source.trim();
  if (source.length === 0) {
    throw new HonuaDiscoveryError("invalid-capability", `${path}.source must be non-empty.`, { path });
  }
  return Object.freeze({
    source,
    ...(value.retrievedAt ? { retrievedAt: value.retrievedAt } : {}),
    ...(value.validator ? { validator: value.validator } : {}),
  });
}

function uniqueProvenance(values: readonly DiscoveryProvenance[]): readonly DiscoveryProvenance[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.source}\u0000${value.retrievedAt ?? ""}\u0000${value.validator ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function immutableCapabilities(values: readonly Capability[]): Capabilities {
  return Object.freeze(new ImmutableCapabilitySet(values));
}

class ImmutableCapabilitySet implements ReadonlySet<Capability> {
  readonly #values: Set<Capability>;

  public constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  public get size(): number {
    return this.#values.size;
  }

  public has(value: Capability): boolean {
    return this.#values.has(value);
  }

  public entries(): SetIterator<[Capability, Capability]> {
    return this.#values.entries();
  }

  public keys(): SetIterator<Capability> {
    return this.#values.keys();
  }

  public values(): SetIterator<Capability> {
    return this.#values.values();
  }

  public forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  public [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }

  public readonly [Symbol.toStringTag] = "Set";
}

const DISCOVERY_ADAPTER_MAXIMA: ReadonlyMap<Protocol, Capabilities> = new Map(
  PROTOCOLS.map((protocol) => [protocol, immutableCapabilities([...PROTOCOL_DEFAULT_CAPABILITIES[protocol]])]),
);

function freezeDiagnostic(diagnostic: DiscoveryDiagnostic): DiscoveryDiagnostic {
  return Object.freeze({
    ...diagnostic,
    ...(diagnostic.capabilities ? { capabilities: Object.freeze([...diagnostic.capabilities]) } : {}),
  });
}

function immutableDescriptor(descriptor: SourceDescriptor, effectiveCapabilities: Capabilities): SourceDescriptor {
  return Object.freeze({
    ...descriptor,
    locator: cloneAndDeepFreeze(descriptor.locator),
    capabilities: immutableCapabilities([...effectiveCapabilities]),
    ...(descriptor.schema ? { schema: cloneAndDeepFreeze(descriptor.schema) } : {}),
    ...(descriptor.analytics ? { analytics: cloneAndDeepFreeze(descriptor.analytics) } : {}),
  });
}

function cloneAndDeepFreeze<T>(value: T): T {
  try {
    return deepFreeze(structuredClone(value));
  } catch (cause) {
    throw new HonuaDiscoveryError(
      "invalid-capability",
      "Source discovery descriptors must contain structured-clone-compatible metadata.",
      undefined,
      { cause },
    );
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Discovery descriptor metadata must contain only arrays and plain objects.");
  }
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  Object.freeze(value);
  return value;
}

function capabilityDecisionReason(code: DiscoveryCapabilityDecisionCode, capability: Capability): string {
  switch (code) {
    case "enabled":
      return `${capability} is supported by the adapter, endpoint evidence, and caller policy.`;
    case "adapter-unsupported":
      return `${capability} is not implemented by this protocol adapter.`;
    case "not-advertised":
      return `${capability} was not advertised by endpoint evidence.`;
    case "policy-denied":
      return `${capability} was removed by caller policy.`;
    case "inferred-not-accepted":
      return `${capability} was inferred but the caller did not accept inferred support.`;
    case "discovery-unavailable":
      return `${capability} cannot be enabled because discovery evidence is unavailable.`;
  }
}

function orderedCapabilities(values: ReadonlySet<Capability>): readonly Capability[] {
  return CAPABILITIES.filter((capability) => values.has(capability));
}

function requiredIdentity(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new HonuaDiscoveryError("invalid-cache-identity", `${name} must be a non-empty opaque fingerprint.`, {
      name,
    });
  }
  return normalized;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCredentialEndpointParameter(normalized: string): boolean {
  return (
    CREDENTIAL_ENDPOINT_PARAMETERS.has(normalized) ||
    AMBIGUOUS_CREDENTIAL_ENDPOINT_PARAMETERS.has(normalized) ||
    normalized.startsWith("x-amz-") ||
    normalized.startsWith("x-goog-")
  );
}

const AZURE_SAS_PARAMETER =
  /^(?:rscc|rscd|rsce|rscl|rsct|saoid|scid|sdd|se|ses|sig|sip|si|ske|skoid|sks|skt|sktid|skv|sp|spr|sr|srt|ss|st|suoid|sv)$/;
const CLOUDFRONT_SIGNED_URL_PARAMETER = /^(?:expires|key-pair-id|policy|signature)$/;
const AWS_V2_SIGNED_URL_PARAMETER = /^(?:awsaccesskeyid|expires|securitytoken|signature)$/;
const GCS_V2_SIGNED_URL_PARAMETER = /^(?:expires|googleaccessid|signature)$/;

function signedUrlTransientParameter(parameters: URLSearchParams): (name: string) => boolean {
  const names = new Set([...parameters.keys()].map((name) => name.toLowerCase()));
  const azure = names.has("sig") && [...names].some((name) => name !== "sig" && AZURE_SAS_PARAMETER.test(name));
  const signedV2 = names.has("signature");
  const cloudFront = signedV2 && names.has("key-pair-id");
  const aws = signedV2 && names.has("awsaccesskeyid");
  const gcs = signedV2 && names.has("googleaccessid");
  return (name) =>
    (azure && AZURE_SAS_PARAMETER.test(name)) ||
    (cloudFront && CLOUDFRONT_SIGNED_URL_PARAMETER.test(name)) ||
    (aws && AWS_V2_SIGNED_URL_PARAMETER.test(name)) ||
    (gcs && GCS_V2_SIGNED_URL_PARAMETER.test(name));
}

function normalizeEndpoint(endpoint: string | URL, omit: (key: string) => boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint.toString());
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "Discovery endpoints must be absolute URLs.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  const isSignedUrlTransient = signedUrlTransientParameter(parsed.searchParams);
  const retained = [...parsed.searchParams.entries()]
    .filter(([key]) => !omit(key) && !isSignedUrlTransient(key.toLowerCase()))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? compareText(leftValue, rightValue) : compareText(leftKey, rightKey),
    );
  parsed.search = "";
  for (const [key, value] of retained) parsed.searchParams.append(key, value);
  while (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  if (!globalThis.crypto?.subtle) {
    throw new HonuaDiscoveryError("invalid-cache-identity", "Discovery cache identity requires Web Crypto SHA-256.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
