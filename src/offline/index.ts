/**
 * Storage-neutral contracts for bounded, downloadable offline regions.
 *
 * This experimental entrypoint provides an IndexedDB adapter for browser
 * persistence and a storage-backed fetch handler for service-worker or fetch
 * integrations. Applications inject request matching, resource loading, and
 * network policy; the SDK owns deterministic manifest identity, credential
 * projection, cache diagnostics, quota admission against the origin's real
 * storage estimate, integrity checks, cancellation, progress semantics, durable
 * edit-queue state, and the composed local-first status that names one honest
 * state across cached reads and undelivered writes. Applications still own
 * connectivity policy, persistence requests, and edit replay transport binding.
 *
 * @experimental
 */

export {
  createOfflineRegionDiagnostic,
  createOfflineRegionManifest,
  downloadOfflineRegion,
  planOfflineRegionAdmission,
  verifyOfflineRegionManifest,
} from "./region.js";
export {
  canonicalizeOfflineRegionQuery,
  compareOfflineRegionBounds,
  OFFLINE_REGION_PROTOCOL,
  offlineRegionAuthorizationScopeDigest,
  offlineRegionQueryFingerprint,
  offlineRegionResourceId,
} from "./selection.js";
export type {
  OfflineRegionBoundsRelation,
  OfflineRegionCanonicalQueryV1,
  OfflineRegionQueryScopeV1,
  OfflineRegionResourceSelector,
  OfflineRegionSelectionIdentityV1,
} from "./selection.js";
export {
  createOfflineRegionFeatureBatch,
  createOfflineRegionSnapshotLoader,
  decodeOfflineRegionFeatureBatch,
  DEFAULT_OFFLINE_REGION_SNAPSHOT_MAX_CONTENTS,
  encodeOfflineRegionFeatureBatch,
  HONUA_OFFLINE_FEATURE_BATCH_KIND,
  HONUA_OFFLINE_FEATURE_BATCH_VERSION,
  HONUA_OFFLINE_REGION_SNAPSHOT_KIND,
  HONUA_OFFLINE_REGION_SNAPSHOT_VERSION,
  planOfflineRegionSnapshot,
} from "./snapshot.js";
export type {
  OfflineRegionFeatureBatchV1,
  OfflineRegionSnapshotContentV1,
  OfflineRegionSnapshotEntryV1,
  OfflineRegionSnapshotSelectionV1,
  OfflineRegionSnapshotV1,
} from "./snapshot.js";
export {
  createOfflineRegionQueryPlanCache,
  DEFAULT_OFFLINE_REGION_READ_STALE_AFTER_MS,
  HONUA_OFFLINE_REGION_READ_KIND,
  HONUA_OFFLINE_REGION_READ_VERSION,
  readOfflineRegionQuery,
} from "./read.js";
export type {
  OfflineRegionQueryReadV1,
  OfflineRegionReadCacheDecisionV1,
  OfflineRegionReadFreshness,
  OfflineRegionReadProvenanceV1,
  ReadOfflineRegionQueryOptions,
} from "./read.js";
export { createMemoryOfflineRegionStore, MemoryOfflineRegionStore } from "./memory-store.js";
export type { MemoryOfflineRegionStoreOptions } from "./memory-store.js";
export {
  HONUA_OFFLINE_REGION_STORE_CONFORMANCE_KIND,
  HONUA_OFFLINE_REGION_STORE_CONFORMANCE_VERSION,
  OFFLINE_REGION_STORE_CONFORMANCE_CASES,
  runOfflineRegionStoreConformance,
} from "./store-conformance.js";
export type {
  OfflineRegionStoreConformanceCaseResultV1,
  OfflineRegionStoreConformanceOptions,
  OfflineRegionStoreConformanceReportV1,
} from "./store-conformance.js";
export { createIndexedDbOfflineRegionStore, IndexedDbOfflineRegionStore } from "./indexeddb.js";
export {
  DEFAULT_OFFLINE_STORAGE_HEADROOM_RATIO,
  DEFAULT_OFFLINE_STORAGE_MIN_RESERVE_BYTES,
  HONUA_OFFLINE_STORAGE_BUDGET_KIND,
  HONUA_OFFLINE_STORAGE_BUDGET_VERSION,
  HONUA_OFFLINE_STORAGE_PERSISTENCE_KIND,
  HONUA_OFFLINE_STORAGE_PERSISTENCE_VERSION,
  isStorageQuotaPressureError,
  probeOfflineStorageBudget,
  requestOfflinePersistentStorage,
} from "./quota.js";
export type {
  OfflineStorageBudgetAvailableV1,
  OfflineStorageBudgetUnavailableReason,
  OfflineStorageBudgetUnavailableV1,
  OfflineStorageBudgetV1,
  OfflineStorageManagerLike,
  OfflineStoragePersistence,
  OfflineStoragePersistenceRequestStatus,
  OfflineStoragePersistenceRequestV1,
  OfflineStoragePersistenceUnavailableReason,
  ProbeOfflineStorageBudgetOptions,
  RequestOfflinePersistentStorageOptions,
} from "./quota.js";
export { createOfflineRegionFetchHandler } from "./fetch-handler.js";
export {
  createIndexedDbOfflineEditQueue,
  createMemoryOfflineEditQueue,
  IndexedDbOfflineEditQueue,
  MemoryOfflineEditQueue,
} from "./edit-queue.js";
export { HONUA_OFFLINE_EDIT_REPLAY_VERSION, replayOfflineEditPass } from "./edit-replay.js";
export {
  createLocalFirstStatus,
  DEFAULT_LOCAL_FIRST_MAX_EDITS,
  DEFAULT_LOCAL_FIRST_MAX_LISTED_EDIT_IDS,
  DEFAULT_LOCAL_FIRST_MAX_REGIONS,
  HONUA_LOCAL_FIRST_STATUS_KIND,
  HONUA_LOCAL_FIRST_STATUS_VERSION,
} from "./status.js";
export type {
  CreateLocalFirstStatusOptions,
  LocalFirstCompleteness,
  LocalFirstConnectivity,
  LocalFirstFreshness,
  LocalFirstReadAvailability,
  LocalFirstReads,
  LocalFirstRegionSummary,
  LocalFirstState,
  LocalFirstStateReason,
  LocalFirstStatusLimits,
  LocalFirstStatusV1,
  LocalFirstWriteCoverage,
  LocalFirstWrites,
  LocalFirstWriteState,
} from "./status.js";
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
  OfflineEditQueueStateCounts,
  OfflineEditRetry,
  OfflineFeatureEdit,
  OfflineQueuedEdit,
  OfflineQueuedEditState,
  PruneTerminalOfflineEditsOptions,
} from "./edit-queue.js";
export type {
  OfflineEditAppliedAcknowledgement,
  OfflineEditConflictedAcknowledgement,
  OfflineEditReplayAcknowledgement,
  OfflineEditReplayIdentity,
  OfflineEditReplayItemReceipt,
  OfflineEditReplayPassReceipt,
  OfflineEditReplayRequest,
  OfflineEditReplayTransport,
  OfflineEditReplayTransportContext,
  OfflineEditReplayUnacknowledgedReason,
  OfflineEditRetryableAcknowledgement,
  ReplayOfflineEditPassOptions,
} from "./edit-replay.js";
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
