/**
 * Client projection of the server capability manifest — the server-advertised
 * set of package families, feature capabilities, transports, limits, and policy
 * state a Console/MCP/QGIS client may rely on. Lets a client gate UI and tool
 * exposure on what the connected server actually supports for the current
 * tenant, workspace, environment, and caller policy scope rather than
 * hard-coding assumptions.
 *
 * These shapes mirror the frozen server wire contract
 * `honua.capability_manifest.v1` (honua-server `CapabilityManifestService` /
 * `CapabilityManifestDocument`, PR #2356) and are the TypeScript analogue of the
 * honua-sdk-dotnet `CapabilityManifest` / `CapabilityEntry` projection
 * (honua-sdk-dotnet PR #253). The wire is frozen; field names, the
 * `supported`/`available` split, and the reason-code surface are stable, so
 * these shapes are no longer marked `@experimental`. Fetch a manifest with the
 * control-plane client's `getCapabilityManifest()`.
 *
 * @module
 */

/**
 * Tenant, workspace, environment, and authentication scope a capability
 * manifest was generated for.
 */
export interface StudioCapabilityScope {
  readonly tenantId?: string;
  readonly tenantSource?: string;
  readonly environment?: string;
  readonly workspaceId?: string;
  readonly workspaceAvailable?: boolean;
  readonly workspaceReasonCode?: string;
  readonly authenticated?: boolean;
  readonly [extra: string]: unknown;
}

/** Server and API version information carried by a capability manifest. */
export interface StudioCapabilityServerInfo {
  readonly serverVersion?: string;
  readonly apiVersion?: string;
  readonly metadataApiVersion?: string;
  readonly metadataSchemaVersion?: string;
  readonly deploymentEnvironment?: string;
  readonly [extra: string]: unknown;
}

/** Environment (metadata snapshot) availability state for a capability manifest. */
export interface StudioCapabilityEnvironment {
  readonly environmentId?: string;
  readonly requested?: boolean;
  readonly available?: boolean;
  readonly reasonCode?: string;
  readonly revision?: number;
  readonly loadedAt?: string;
  readonly [extra: string]: unknown;
}

/** One package family advertised by a capability manifest. */
export interface StudioCapabilityPackageFamily {
  readonly id: string;
  readonly kind?: string;
  readonly schemaVersion?: string;
  readonly supported: boolean;
  readonly [extra: string]: unknown;
}

/** Package schema versions and family support state for a capability manifest. */
export interface StudioCapabilityPackages {
  readonly schemaVersions?: readonly string[];
  readonly families?: readonly StudioCapabilityPackageFamily[];
  readonly storageFamilies?: readonly string[];
  readonly publicationFamilies?: readonly string[];
  readonly [extra: string]: unknown;
}

/**
 * One advertised capability entry. Mirrors the frozen server
 * `honua.capability_manifest.v1` capability shape and the honua-sdk-dotnet
 * `CapabilityEntry` projection.
 *
 * `supported` reports whether the server implements the capability at all;
 * `available` reports whether it is usable in the current scope (a supported
 * capability can still be unavailable — e.g. gated by edition or entitlement,
 * with `reasonCode` explaining why).
 */
export interface StudioCapabilityEntry {
  readonly id: string;
  readonly category?: string;
  /** Server-owned governance lifecycle. Unknown future values remain intact. */
  readonly lifecycle: string;
  /** Whether server governance requires explicit opt-in before use. */
  readonly optInRequired: boolean;
  readonly supported: boolean;
  readonly available: boolean;
  readonly reasonCode?: string;
  readonly entitlementKey?: string;
  readonly entitlementKeys?: readonly string[];
  readonly minimumEdition?: string;
  readonly messageKey?: string;
  readonly [extra: string]: unknown;
}

/** Typed failure raised when a capability manifest drops required governance fields. */
export class HonuaCapabilityManifestContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HonuaCapabilityManifestContractError";
  }
}

/** Validate and narrow an untrusted capability-manifest response. */
export function assertStudioCapabilityManifest(value: unknown): asserts value is StudioCapabilityManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "honua.capability_manifest.v1" ||
    !Array.isArray(value.capabilities)
  ) {
    throw new HonuaCapabilityManifestContractError("Response is not a honua.capability_manifest.v1 document.");
  }
  for (const [index, capability] of value.capabilities.entries()) {
    if (!isRecord(capability) || typeof capability.lifecycle !== "string" || capability.lifecycle.length === 0) {
      throw new HonuaCapabilityManifestContractError(`capabilities[${index}].lifecycle is required.`);
    }
    if (typeof capability.optInRequired !== "boolean") {
      throw new HonuaCapabilityManifestContractError(`capabilities[${index}].optInRequired is required.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Availability state of one transport (for example HTTP, gRPC, gRPC-Web). */
export interface StudioCapabilityTransportState {
  readonly id: string;
  readonly supported: boolean;
  readonly available: boolean;
  readonly reasonCode?: string;
  readonly messageKey?: string;
  readonly [extra: string]: unknown;
}

/** Transport availability and mTLS state for a capability manifest. */
export interface StudioCapabilityTransports {
  readonly items: readonly StudioCapabilityTransportState[];
  readonly mtlsMode?: string;
  readonly forwardedClientCertificateEnabled?: boolean;
  readonly [extra: string]: unknown;
}

/** Preview limits advertised by a capability manifest. */
export interface StudioCapabilityPreviewLimits {
  readonly maxPreviewSizeBytes?: number;
  readonly maxPreviewFeatures?: number;
  readonly maxPreviewCountScan?: number;
  readonly [extra: string]: unknown;
}

/** Query limits advertised by a capability manifest. */
export interface StudioCapabilityQueryLimits {
  readonly defaultRecordCount?: number;
  readonly maxRecordCount?: number;
  readonly maxFeatures?: number;
  readonly maxPageSize?: number;
  readonly queryTimeoutSeconds?: number;
  readonly maxBboxAreaSqKm?: number;
  readonly maxFilterDepth?: number;
  readonly maxSpatialOperations?: number;
  readonly [extra: string]: unknown;
}

/** Analysis limits advertised by a capability manifest. */
export interface StudioCapabilityAnalysisLimits {
  readonly maxInputFeatures?: number;
  readonly maxClusters?: number;
  readonly maxDbscanEpsMeters?: number;
  readonly maxKMeansK?: number;
  readonly maxBufferDistanceMeters?: number;
  readonly minDensityCellSizeMeters?: number;
  readonly maxDensityCellSizeMeters?: number;
  readonly maxDensityCells?: number;
  readonly maxDWithinDistanceMeters?: number;
  readonly maxH3CellsPerQuery?: number;
  readonly maxSpatialOperations?: number;
  readonly maxJoins?: number;
  readonly [extra: string]: unknown;
}

/** Publication limits advertised by a capability manifest. */
export interface StudioCapabilityPublicationLimits {
  readonly configuredDeployTargetCount?: number;
  readonly gitOpsManifestExportSupported?: boolean;
  readonly [extra: string]: unknown;
}

/** Job limits advertised by a capability manifest. */
export interface StudioCapabilityJobLimits {
  readonly configuredWorkloadCount?: number;
  readonly availableBackendCount?: number;
  readonly supportsCancellation?: boolean;
  readonly supportsProgressPolling?: boolean;
  readonly [extra: string]: unknown;
}

/** Upload limits advertised by a capability manifest. */
export interface StudioCapabilityUploadLimits {
  readonly maxUploadSizeBytes?: number;
  readonly maxFileSizeBytes?: number;
  readonly maxConcurrentUploads?: number;
  readonly maxQueuedUploads?: number;
  readonly maxSecurityScanSizeBytes?: number;
  readonly [extra: string]: unknown;
}

/** Streaming limits advertised by a capability manifest. */
export interface StudioCapabilityStreamingLimits {
  readonly maxConcurrentSessions?: number;
  readonly maxBufferPerConnection?: number;
  readonly maxSubscriptionsPerSession?: number;
  readonly maxSubscriptionIdLength?: number;
  readonly maxControlFrameBytes?: number;
  readonly cursorRetentionLimit?: number;
  readonly heartbeatIntervalSeconds?: number;
  readonly grpcStreamBatchSize?: number;
  readonly [extra: string]: unknown;
}

/** Edit limits advertised by a capability manifest. */
export interface StudioCapabilityEditLimits {
  readonly maxFeaturesPerEdit?: number;
  readonly maxEditsPerTransaction?: number;
  readonly maxPayloadSizeBytes?: number;
  readonly [extra: string]: unknown;
}

/** Geometry limits advertised by a capability manifest. */
export interface StudioCapabilityGeometryLimits {
  readonly maxVerticesPerGeometry?: number;
  readonly maxGeometrySizeBytes?: number;
  readonly maxCoordinatePrecision?: number;
  readonly [extra: string]: unknown;
}

/** Attachment limits advertised by a capability manifest. */
export interface StudioCapabilityAttachmentLimits {
  readonly maxAttachmentsPerFeature?: number;
  readonly maxAttachmentSizeBytes?: number;
  readonly [extra: string]: unknown;
}

/** Operational limits advertised by a capability manifest. */
export interface StudioCapabilityLimits {
  readonly preview?: StudioCapabilityPreviewLimits;
  readonly query?: StudioCapabilityQueryLimits;
  readonly analysis?: StudioCapabilityAnalysisLimits;
  readonly publication?: StudioCapabilityPublicationLimits;
  readonly job?: StudioCapabilityJobLimits;
  readonly upload?: StudioCapabilityUploadLimits;
  readonly streaming?: StudioCapabilityStreamingLimits;
  readonly edit?: StudioCapabilityEditLimits;
  readonly geometry?: StudioCapabilityGeometryLimits;
  readonly attachment?: StudioCapabilityAttachmentLimits;
  readonly [extra: string]: unknown;
}

/** One entitlement decision advertised by a capability manifest. */
export interface StudioCapabilityEntitlementDecision {
  readonly key: string;
  readonly active: boolean;
  readonly minimumEdition?: string;
  readonly reasonCode?: string;
  readonly [extra: string]: unknown;
}

/** Edition, license, and entitlement policy state for a capability manifest. */
export interface StudioCapabilityPolicies {
  readonly currentEdition?: string;
  readonly licenseValidationState?: string;
  readonly licenseValid?: boolean;
  readonly callerCapabilities?: readonly string[];
  readonly entitlements?: readonly StudioCapabilityEntitlementDecision[];
  readonly authorizationNotice?: string;
  readonly [extra: string]: unknown;
}

/** A related resource link advertised by a capability manifest. */
export interface StudioCapabilityLink {
  readonly rel: string;
  readonly href: string;
  readonly type?: string;
  readonly [extra: string]: unknown;
}

/**
 * The capability manifest a server returns describing supported package
 * families, feature capabilities, transports, limits, and policy state.
 * Schema `honua.capability_manifest.v1`.
 */
export interface StudioCapabilityManifest {
  readonly schemaVersion: string;
  readonly issuedAt?: string;
  readonly scope?: StudioCapabilityScope;
  readonly server?: StudioCapabilityServerInfo;
  readonly environment?: StudioCapabilityEnvironment;
  readonly packages?: StudioCapabilityPackages;
  readonly capabilities: readonly StudioCapabilityEntry[];
  readonly transports?: StudioCapabilityTransports;
  readonly limits?: StudioCapabilityLimits;
  readonly policies?: StudioCapabilityPolicies;
  readonly links?: readonly StudioCapabilityLink[];
  readonly [extra: string]: unknown;
}

/**
 * Return the capability entry with the given id, or `undefined` if the
 * manifest does not advertise it (regardless of supported/available state).
 * Mirrors the .NET `CapabilityManifest.GetCapability`.
 */
export function getCapability(manifest: StudioCapabilityManifest, id: string): StudioCapabilityEntry | undefined {
  return manifest.capabilities.find((entry) => entry.id === id);
}

/**
 * Return `true` when the manifest advertises the capability as available in the
 * current scope. Mirrors the .NET `CapabilityManifest.IsAvailable`.
 */
export function hasCapability(manifest: StudioCapabilityManifest, id: string): boolean {
  return getCapability(manifest, id)?.available === true;
}

/**
 * Return `true` when the server implements the capability at all, even if it is
 * not currently available (for example gated by edition or entitlement).
 * Inspect {@link getCapabilityReasonCode} to explain an unavailable but
 * supported capability. Mirrors the .NET `CapabilityManifest.IsSupported`.
 */
export function isCapabilitySupported(manifest: StudioCapabilityManifest, id: string): boolean {
  return getCapability(manifest, id)?.supported === true;
}

/**
 * Return the machine-friendly reason code explaining a capability's
 * availability state, or `undefined` when unknown or the capability is
 * unrecognized. Mirrors the .NET `CapabilityManifest.GetReasonCode`.
 */
export function getCapabilityReasonCode(manifest: StudioCapabilityManifest, id: string): string | undefined {
  return getCapability(manifest, id)?.reasonCode;
}

/**
 * Return `true` when the server advertises a supported package family with the
 * given identifier (for example `map`). Mirrors the .NET
 * `CapabilityManifest.HasPackageFamily`.
 */
export function hasPackageFamily(manifest: StudioCapabilityManifest, familyId: string): boolean {
  return manifest.packages?.families?.some((family) => family.id === familyId && family.supported) === true;
}
