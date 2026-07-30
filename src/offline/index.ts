/**
 * Storage-neutral contracts for bounded, downloadable offline regions.
 *
 * This experimental entrypoint provides an IndexedDB adapter for browser
 * persistence, but deliberately does not provide service-worker, network, or
 * edit-replay implementations. Applications inject a resource loader and an
 * atomic store transaction; the SDK owns deterministic
 * manifest identity, credential projection, quota admission, integrity checks,
 * cancellation, and progress semantics.
 *
 * @experimental
 */

export {
  createOfflineRegionManifest,
  downloadOfflineRegion,
  planOfflineRegionAdmission,
} from "./region.js";
export { createIndexedDbOfflineRegionStore, IndexedDbOfflineRegionStore } from "./indexeddb.js";
export type { IndexedDbOfflineRegionStoreOptions } from "./indexeddb.js";
export {
  DEFAULT_OFFLINE_REGION_MAX_ATTRIBUTIONS,
  DEFAULT_OFFLINE_REGION_MAX_LOGICAL_BYTES,
  DEFAULT_OFFLINE_REGION_MAX_METADATA_ENTRIES,
  DEFAULT_OFFLINE_REGION_MAX_RESOURCES,
  DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES,
  HONUA_OFFLINE_REGION_KIND,
  HONUA_OFFLINE_REGION_VERSION,
  HonuaOfflineRegionError,
} from "./types.js";
export type {
  CreateOfflineRegionManifestInput,
  OfflineRegionAdmissionPlan,
  OfflineRegionBounds,
  OfflineRegionCacheInventory,
  OfflineRegionCommitGuard,
  OfflineRegionDownloadOptions,
  OfflineRegionDownloadProgress,
  OfflineRegionDownloadReceipt,
  OfflineRegionErrorCode,
  OfflineRegionLimits,
  OfflineRegionManifestV1,
  OfflineRegionObservation,
  OfflineRegionResourceInput,
  OfflineRegionResourceRead,
  OfflineRegionResourceKind,
  OfflineRegionResourceLoader,
  OfflineRegionResourceV1,
  OfflineRegionStore,
  OfflineRegionStoredRegion,
  OfflineRegionValidator,
  OfflineRegionWriteTransaction,
} from "./types.js";
