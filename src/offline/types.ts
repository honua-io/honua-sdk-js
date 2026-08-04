import { type HonuaErrorCode, HonuaSdkError, isRetryableNetworkOrTimeoutHonuaError } from "../core/error-envelope.js";
import type { OfflineStorageBudgetV1 } from "./quota.js";

/** First version of the downloadable-region manifest contract. */
export const HONUA_OFFLINE_REGION_VERSION = "1.0" as const;

/** Stable discriminator for serialized downloadable-region manifests. */
export const HONUA_OFFLINE_REGION_KIND = "honua.offline-region" as const;

/** Stable discriminator and version for offline-region diagnostic snapshots. */
export const HONUA_OFFLINE_REGION_DIAGNOSTIC_KIND = "honua.offline-region-diagnostic" as const;
export const HONUA_OFFLINE_REGION_DIAGNOSTIC_VERSION = "1.0" as const;

/** Conservative bounds applied before descriptors are copied or sorted. */
export const DEFAULT_OFFLINE_REGION_MAX_RESOURCES = 100_000;
export const DEFAULT_OFFLINE_REGION_MAX_LOGICAL_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES = 1024 * 1024;
export const DEFAULT_OFFLINE_REGION_MAX_ATTRIBUTIONS = 4_096;
export const DEFAULT_OFFLINE_REGION_MAX_METADATA_ENTRIES = 200_000;

export type OfflineRegionResourceKind = "metadata" | "features" | "tile" | "asset" | "attribution";

/** Closed, non-antimeridian-crossing bounds in the declared CRS. */
export interface OfflineRegionBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly crs: string;
}

export interface OfflineRegionResourceInput {
  /** Stable non-secret identity used by the injected loader and store. */
  readonly id: string;
  readonly kind: OfflineRegionResourceKind;
  /** Logical payload bytes; physical storage may deduplicate or add overhead. */
  readonly byteLength: number;
  readonly integrity: `sha256:${string}`;
  readonly contentType?: string;
  readonly sourceVersion?: string;
  readonly schemaVersion?: string;
  readonly planVersion?: string;
  readonly attributionIds?: readonly string[];
}

export interface OfflineRegionObservation {
  readonly state: "live" | "cached" | "replayed";
  readonly observedAt: string;
  readonly validAt?: string;
}

export interface OfflineRegionValidator {
  readonly etag?: string;
  readonly lastModified?: string;
}

/** Credential-free resource descriptor safe to persist and log. */
export interface OfflineRegionResourceV1 {
  readonly id: string;
  readonly kind: OfflineRegionResourceKind;
  readonly byteLength: number;
  readonly integrity: `sha256:${string}`;
  readonly contentType?: string;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly planVersion: string;
  readonly attributionIds: readonly string[];
}

export interface CreateOfflineRegionManifestInput {
  readonly name: string;
  readonly sourceId: string;
  /** Credentials and signed query parameters are removed from the persisted endpoint. */
  readonly endpoint: string | URL;
  /** Opaque ACL/auth partition input. Only its SHA-256 digest is persisted. */
  readonly authorizationScopeFingerprint: string;
  readonly bounds: OfflineRegionBounds;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly planVersion: string;
  /** Freshness/provenance shared by every resource in this snapshot. */
  readonly observation: OfflineRegionObservation;
  readonly validator?: OfflineRegionValidator;
  readonly expiresAt?: string;
  readonly attribution?: Readonly<Record<string, string>>;
  readonly resources: readonly OfflineRegionResourceInput[];
  readonly limits?: OfflineRegionLimits;
}

/** Serializable, immutable description of one bounded offline snapshot. */
export interface OfflineRegionManifestV1 {
  readonly kind: typeof HONUA_OFFLINE_REGION_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_VERSION;
  readonly id: `sha256:${string}`;
  readonly name: string;
  readonly source: {
    readonly id: string;
    readonly endpoint: string;
    readonly authorizationScopeDigest: `sha256:${string}`;
    readonly sourceVersion: string;
    readonly schemaVersion: string;
    readonly planVersion: string;
    readonly observation: OfflineRegionObservation;
    readonly validator?: OfflineRegionValidator;
  };
  readonly bounds: OfflineRegionBounds;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly expiresAt?: string;
  readonly attribution: Readonly<Record<string, string>>;
  readonly resources: readonly OfflineRegionResourceV1[];
  /** Sum of resource payload lengths; not physical or unique backing-store bytes. */
  readonly totalLogicalBytes: number;
}

/** Caller limits can tighten, but never raise, the SDK's conservative ceilings. */
export interface OfflineRegionLimits {
  readonly maxResources?: number;
  readonly maxLogicalBytes?: number;
  readonly maxStringBytes?: number;
  readonly maxAttributions?: number;
  readonly maxMetadataEntries?: number;
}

export interface OfflineRegionStoredRegion {
  readonly id: string;
  /** Logical payload bytes charged to quota, regardless of physical deduplication. */
  readonly logicalByteLength: number;
  readonly lastAccessedAt: string;
  readonly expiresAt?: string;
  /** Pinned regions are never selected for automatic eviction. */
  readonly pinned?: boolean;
}

/** A credential-free resource snapshot read from a persistent offline region. */
export interface OfflineRegionResourceRead {
  readonly regionId: string;
  readonly manifest: OfflineRegionManifestV1;
  readonly resource: OfflineRegionResourceV1;
  /** Caller-owned bytes; mutating them cannot mutate the persistent store. */
  readonly bytes: Uint8Array;
}

/**
 * Resolves a browser request to a credential-free resource identity.
 * Returning `undefined` leaves the request to the host's normal network path.
 */
export type OfflineRegionResourceMatcher = (request: Request) => string | undefined | Promise<string | undefined>;

/** Options for creating a service-worker/fetch-event resource handler. */
export interface OfflineRegionFetchHandlerOptions {
  readonly store: OfflineRegionStore;
  readonly regionId: string;
  readonly match: OfflineRegionResourceMatcher;
  readonly now?: () => Date;
}

/** A handler result; `undefined` means the request was not served from offline storage. */
export type OfflineRegionFetchHandler = (request: Request) => Promise<Response | undefined>;

export interface OfflineRegionCacheInventory {
  /** Opaque revision changed atomically by every committed store mutation. */
  readonly revision: string;
  readonly regions: readonly OfflineRegionStoredRegion[];
}

/**
 * Atomic lifecycle operations for a persistent offline-region cache.
 * Implementations must advance the inventory revision once for each mutation.
 */
export interface OfflineRegionCacheAdmin {
  /** Remove a region and all of its resources. Returns false when absent. */
  removeRegion(regionId: string): Promise<boolean>;
  /** Change whether automatic admission may evict a region. Returns false when unchanged or absent. */
  setRegionPinned(regionId: string, pinned: boolean): Promise<boolean>;
  /** Remove all regions expired at or before `now`, returning ids in inventory order. */
  pruneExpired(now?: Date): Promise<readonly string[]>;
}

export interface OfflineRegionAdmissionPlan {
  readonly logicalQuotaBytes: number;
  readonly logicalBytesBefore: number;
  readonly replacementLogicalBytes: number;
  readonly requiredLogicalBytes: number;
  readonly evictRegionIds: readonly string[];
  readonly evictedLogicalBytes: number;
  readonly logicalBytesAfter: number;
}

export interface CreateOfflineRegionDiagnosticOptions {
  /** Logical payload-byte ceiling used to explain admission and eviction. */
  readonly logicalQuotaBytes: number;
  /** Explicit clock input so persisted diagnostics are reproducible. */
  readonly now: Date;
  /** Age at which the snapshot observation becomes stale. */
  readonly staleAfterMs: number;
  /**
   * Optional storage-budget observation from `probeOfflineStorageBudget()`.
   * Persisted state changes the eviction risk of every cached region, so it is
   * reported here rather than inferred. The diagnostic never probes on its own.
   */
  readonly storage?: OfflineStorageBudgetV1;
}

export type OfflineRegionDiagnosticAdmission =
  | { readonly status: "accepted"; readonly plan: OfflineRegionAdmissionPlan }
  | {
      readonly status: "rejected";
      readonly reason: "expired" | "quota-exceeded";
      readonly logicalQuotaBytes: number;
      /** The plan that was attempted, when quota refused it. Nothing was evicted. */
      readonly attempted?: OfflineRegionAdmissionPlan;
    };

/** Secret-safe, payload-free explanation of one persistent offline region. */
export interface OfflineRegionDiagnosticV1 {
  readonly kind: typeof HONUA_OFFLINE_REGION_DIAGNOSTIC_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_DIAGNOSTIC_VERSION;
  readonly generatedAt: string;
  readonly regionId: string;
  readonly inventoryRevision: string;
  readonly cache: {
    readonly state: "offline" | "missing";
    readonly freshness: "fresh" | "stale" | "expired";
    readonly completeness: "complete" | "partial" | "missing";
    readonly reason: "offline-entry" | "stale-entry" | "expired-entry" | "partial-entry" | "cache-miss";
    readonly readable: boolean;
    readonly observedAt: string;
    readonly ageMs: number;
    readonly staleAfterMs: number;
    readonly expectedLogicalBytes: number;
    readonly storedLogicalBytes?: number;
    readonly lastAccessedAt?: string;
    readonly expiresAt?: string;
    readonly pinned: boolean;
  };
  readonly provenance: {
    readonly sourceId: string;
    readonly endpointFingerprint: `sha256:${string}`;
    readonly authorizationScopeDigest: `sha256:${string}`;
    readonly sourceVersion: string;
    readonly schemaVersion: string;
    readonly planVersion: string;
    readonly observation: OfflineRegionObservation;
    readonly validator?: {
      readonly etagFingerprint?: `sha256:${string}`;
      readonly lastModified?: string;
    };
  };
  readonly contents: {
    readonly resourceCount: number;
    readonly logicalBytes: number;
    readonly resourceKinds: Readonly<Record<OfflineRegionResourceKind, number>>;
    readonly attributionIds: readonly string[];
  };
  readonly admission: OfflineRegionDiagnosticAdmission;
  /** Present only when the caller supplied a storage-budget observation. */
  readonly storage?: OfflineStorageBudgetV1;
}

export interface OfflineRegionCommitGuard {
  readonly expectedInventoryRevision: string;
  readonly logicalQuotaBytes: number;
  readonly admission: OfflineRegionAdmissionPlan;
}

/**
 * One atomic update. Implementations stage evictions and copied resource bytes.
 * `commit` must atomically compare `expectedInventoryRevision`, independently
 * verify resulting logical quota, then publish or return `inventory-changed`.
 */
export interface OfflineRegionWriteTransaction {
  evict(regionId: string): Promise<void>;
  /** Return a previously staged payload for this resource when it passed storage validation. */
  readonly readStaged?: (resource: OfflineRegionResourceV1) => Promise<Readonly<Uint8Array> | undefined>;
  /** Discard a failed staged checkpoint before retrying the loader. */
  readonly discardStaged?: (resource: OfflineRegionResourceV1) => Promise<void>;
  /** Resolve only after the store no longer depends on caller mutation of `bytes`. */
  write(resource: OfflineRegionResourceV1, bytes: Readonly<Uint8Array>): Promise<void>;
  commit(
    manifest: OfflineRegionManifestV1,
    receipt: OfflineRegionDownloadReceipt,
    guard: OfflineRegionCommitGuard,
  ): Promise<"committed" | "inventory-changed">;
  rollback(options?: { readonly preserveStaged?: boolean }): Promise<void>;
}

/** Storage adapter boundary; no browser or platform storage is selected by the SDK. */
export interface OfflineRegionStore {
  inventory(): Promise<OfflineRegionCacheInventory>;
  /** Read one committed resource, or `undefined` when it is absent. */
  readResource(regionId: string, resourceId: string): Promise<OfflineRegionResourceRead | undefined>;
  beginWrite(regionId: string): Promise<OfflineRegionWriteTransaction>;
}

/** Loader resolves logical resource identity without persisting URLs or tokens. */
export type OfflineRegionResourceLoader = (
  resource: OfflineRegionResourceV1,
  context: { readonly manifest: OfflineRegionManifestV1; readonly signal?: AbortSignal },
) => Promise<ArrayBuffer | Uint8Array>;

export type OfflineRegionDownloadProgress =
  | {
      readonly phase: "planned";
      readonly completedResources: 0;
      readonly totalResources: number;
      readonly completedLogicalBytes: 0;
      readonly totalLogicalBytes: number;
      readonly evictionRegionIds: readonly string[];
    }
  | {
      readonly phase: "downloading" | "writing";
      readonly completedResources: number;
      readonly totalResources: number;
      readonly completedLogicalBytes: number;
      readonly totalLogicalBytes: number;
      readonly resourceId: string;
    }
  | {
      readonly phase: "committing" | "complete";
      readonly completedResources: number;
      readonly totalResources: number;
      readonly completedLogicalBytes: number;
      readonly totalLogicalBytes: number;
    };

export interface OfflineRegionDownloadReceipt {
  readonly regionId: string;
  readonly resourceCount: number;
  readonly logicalByteLength: number;
  readonly evictedRegionIds: readonly string[];
  readonly integrity: "verified";
  readonly quotaAccounting: "logical-payload-bytes";
  readonly completedAt: string;
}

export interface OfflineRegionDownloadOptions {
  readonly store: OfflineRegionStore;
  readonly load: OfflineRegionResourceLoader;
  /** Logical payload-byte ceiling, not a claim about physical store occupancy. */
  readonly logicalQuotaBytes: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /** Observational callback; exceptions are ignored and never alter transaction state. */
  readonly onProgress?: (progress: OfflineRegionDownloadProgress) => void;
}

export type OfflineRegionErrorCode =
  | "invalid-manifest"
  | "resource-limit-exceeded"
  | "quota-exceeded"
  | "expired"
  | "integrity-mismatch"
  | "aborted"
  | "resource-load-failed"
  | "inventory-changed"
  | "store-failed";

/**
 * Public offline region failure. The detailed legacy reason remains on
 * `.code`; `.sdkCode` provides a stable common-envelope recovery class.
 */
export class HonuaOfflineRegionError extends HonuaSdkError {
  public constructor(
    public readonly code: OfflineRegionErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly resourceId?: string;
      readonly path?: string;
      readonly admission?: OfflineRegionAdmissionPlan;
    } = {},
  ) {
    const cause = options.cause;
    super(offlineRegionSdkCode(code, cause), message, {
      ...(cause === undefined ? {} : { cause }),
      context: { reasonCode: offlineRegionContextReason(code) },
    });
    this.name = "HonuaOfflineRegionError";
    this.resourceId = options.resourceId;
    this.path = options.path;
    this.admission = options.admission;
  }

  public readonly resourceId?: string;
  public readonly path?: string;
  /**
   * The admission plan that was attempted when a `quota-exceeded` failure was
   * raised: required, evicted, and projected logical bytes. A refused plan is
   * what was attempted, not what happened — nothing outside it is ever evicted,
   * and a plan refused before the download starts evicts nothing at all.
   */
  public readonly admission?: OfflineRegionAdmissionPlan;
}

const OFFLINE_REGION_ERROR_CODES = {
  "invalid-manifest": "offline.region.validation",
  "resource-limit-exceeded": "offline.region.validation",
  "quota-exceeded": "offline.region.quota",
  expired: "offline.region.validation",
  "integrity-mismatch": "offline.region.integrity",
  aborted: "offline.cancelled",
  "resource-load-failed": "offline.transport.failure",
  "inventory-changed": "offline.storage.concurrent",
  "store-failed": "offline.storage.failure",
} as const satisfies Record<OfflineRegionErrorCode, HonuaErrorCode>;

function offlineRegionSdkCode(code: unknown, cause: unknown): HonuaErrorCode {
  if (!isOfflineRegionErrorCode(code)) return "offline.region.validation";
  if (code === "resource-load-failed" && isRetryableNetworkOrTimeoutHonuaError(cause)) {
    return "offline.transport.transient";
  }
  return OFFLINE_REGION_ERROR_CODES[code];
}

function offlineRegionContextReason(code: unknown): OfflineRegionErrorCode | "invalid-error-code" {
  return isOfflineRegionErrorCode(code) ? code : "invalid-error-code";
}

function isOfflineRegionErrorCode(code: unknown): code is OfflineRegionErrorCode {
  return typeof code === "string" && Object.hasOwn(OFFLINE_REGION_ERROR_CODES, code);
}
