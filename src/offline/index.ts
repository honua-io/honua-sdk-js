/**
 * Storage-neutral contracts for bounded, downloadable offline regions.
 *
 * This experimental entrypoint provides an IndexedDB adapter for browser
 * persistence and a storage-backed fetch handler for service-worker or fetch
 * integrations. Applications inject request matching, resource loading, and
 * network policy; the SDK owns deterministic manifest identity, credential
 * projection, cache diagnostics, quota admission, integrity checks,
 * cancellation, progress semantics, and durable edit-queue state. Applications
 * still own edit replay transport binding.
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
export {
  createIndexedDbOfflineEditQueue,
  createMemoryOfflineEditQueue,
  IndexedDbOfflineEditQueue,
  MemoryOfflineEditQueue,
} from "./edit-queue.js";
export {
  DEFAULT_OFFLINE_EDIT_QUEUE_MAX_AUDIT_EVENTS,
  DEFAULT_OFFLINE_EDIT_QUEUE_MAX_DEPENDENCIES,
  DEFAULT_OFFLINE_EDIT_QUEUE_MAX_EDITS,
  DEFAULT_OFFLINE_EDIT_QUEUE_MAX_PAYLOAD_BYTES,
  HONUA_OFFLINE_EDIT_QUEUE_VERSION,
  HonuaOfflineEditQueueError,
  MAX_OFFLINE_EDIT_LEASE_DURATION_MS,
} from "./edit-queue.js";
export type {
  CancelOfflineEditInput,
  ClaimOfflineEditsOptions,
  EnqueueOfflineEditInput,
  IndexedDbOfflineEditQueueOptions,
  ListOfflineEditsOptions,
  MarkOfflineEditAppliedInput,
  MarkOfflineEditConflictedInput,
  MarkOfflineEditRetryInput,
  OfflineEditAppliedOutcome,
  OfflineEditAuditEvent,
  OfflineEditAuditEventKind,
  OfflineEditCancellationOutcome,
  OfflineEditConflictOutcome,
  OfflineEditEnqueueResult,
  OfflineEditJsonValue,
  OfflineEditLease,
  OfflineEditOperation,
  OfflineEditQueue,
  OfflineEditQueueErrorCode,
  OfflineEditQueueOptions,
  OfflineEditQueuePartition,
  OfflineEditRetry,
  OfflineFeatureEdit,
  OfflineQueuedEdit,
  OfflineQueuedEditState,
  PruneTerminalOfflineEditsOptions,
} from "./edit-queue.js";
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
