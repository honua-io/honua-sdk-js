/**
 * Storage-neutral contracts for bounded, downloadable offline regions.
 *
 * This experimental entrypoint provides an IndexedDB adapter for browser
 * persistence and a storage-backed fetch handler for service-worker or fetch
 * integrations. Applications inject request matching, resource loading, and
 * network policy; the SDK owns deterministic manifest identity, credential
 * projection, cache diagnostics, quota admission, integrity checks,
 * cancellation, and progress semantics. Edit replay remains outside this
 * entrypoint.
 *
 * @experimental
 */

export {
  createOfflineRegionDiagnostic,
  createOfflineRegionManifest,
  downloadOfflineRegion,
  planOfflineRegionAdmission,
} from "./region.js";
export { createIndexedDbOfflineRegionStore, IndexedDbOfflineRegionStore } from "./indexeddb.js";
export { createOfflineRegionFetchHandler } from "./fetch-handler.js";
export type { IndexedDbOfflineRegionStoreOptions } from "./indexeddb.js";
export {
  DEFAULT_OFFLINE_REGION_MAX_ATTRIBUTIONS,
  DEFAULT_OFFLINE_REGION_MAX_LOGICAL_BYTES,
  DEFAULT_OFFLINE_REGION_MAX_METADATA_ENTRIES,
  DEFAULT_OFFLINE_REGION_MAX_RESOURCES,
  DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES,
  HONUA_OFFLINE_REGION_DIAGNOSTIC_KIND,
  HONUA_OFFLINE_REGION_DIAGNOSTIC_VERSION,
  HONUA_OFFLINE_REGION_KIND,
  HONUA_OFFLINE_REGION_VERSION,
  HonuaOfflineRegionError,
} from "./types.js";
export type {
  CreateOfflineRegionDiagnosticOptions,
  CreateOfflineRegionManifestInput,
  OfflineRegionAdmissionPlan,
  OfflineRegionBounds,
  OfflineRegionCacheAdmin,
  OfflineRegionCacheInventory,
  OfflineRegionCommitGuard,
  OfflineRegionDownloadOptions,
  OfflineRegionDownloadProgress,
  OfflineRegionDownloadReceipt,
  OfflineRegionDiagnosticAdmission,
  OfflineRegionDiagnosticV1,
  OfflineRegionErrorCode,
  OfflineRegionFetchHandler,
  OfflineRegionFetchHandlerOptions,
  OfflineRegionLimits,
  OfflineRegionManifestV1,
  OfflineRegionObservation,
  OfflineRegionResourceInput,
  OfflineRegionResourceMatcher,
  OfflineRegionResourceRead,
  OfflineRegionResourceKind,
  OfflineRegionResourceLoader,
  OfflineRegionResourceV1,
  OfflineRegionStore,
  OfflineRegionStoredRegion,
  OfflineRegionValidator,
  OfflineRegionWriteTransaction,
} from "./types.js";
