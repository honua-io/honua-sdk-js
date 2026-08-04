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
  isWgs84LonLatCrs,
  normalizeOfflineRegionTileKey,
  OFFLINE_REGION_DEFAULT_TILE_MATRIX_SET,
  OFFLINE_REGION_MAX_TILE_ZOOM,
  OFFLINE_REGION_PROTOCOL,
  offlineRegionAssetSelector,
  offlineRegionAuthorizationScopeDigest,
  offlineRegionMetadataSelector,
  offlineRegionQueryFingerprint,
  offlineRegionResourceId,
  offlineRegionTileEnvelope,
  offlineRegionTileSelector,
} from "./selection.js";
export type {
  OfflineRegionBoundsRelation,
  OfflineRegionCanonicalQueryV1,
  OfflineRegionQueryScopeV1,
  OfflineRegionResourceSelector,
  OfflineRegionSelectionIdentityV1,
  OfflineRegionTileSelectorOptions,
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
} from "./read-gate.js";
export type {
  OfflineRegionReadCacheDecisionV1,
  OfflineRegionReadFreshness,
  OfflineRegionReadGateOptions,
  OfflineRegionReadProvenanceV1,
  OfflineRegionStoreReadOptions,
} from "./read-gate.js";
export { readOfflineRegionQuery } from "./read.js";
export type { OfflineRegionQueryReadV1, ReadOfflineRegionQueryOptions } from "./read.js";
export {
  readOfflineRegionAsset,
  readOfflineRegionMetadata,
  readOfflineRegionResource,
  readOfflineRegionTile,
  resolveOfflineRegionResourceId,
} from "./read-resource.js";
export type {
  OfflineRegionMetadataReadV1,
  OfflineRegionResourceReadV1,
  OfflineRegionTileReadV1,
  ReadOfflineRegionAssetOptions,
  ReadOfflineRegionMetadataOptions,
  ReadOfflineRegionResourceOptions,
  ReadOfflineRegionTileOptions,
} from "./read-resource.js";
export {
  buildOfflineRegionTileUrlTemplate,
  createOfflineRegionTileProtocol,
  OFFLINE_REGION_TILE_SCHEME,
  parseOfflineRegionTileUrl,
  registerOfflineRegionTileProtocol,
} from "./tile-protocol.js";
export type {
  CreateOfflineRegionTileProtocolOptions,
  OfflineRegionProtocolHandler,
  OfflineRegionProtocolRegistrar,
  OfflineRegionProtocolRequest,
  OfflineRegionProtocolResponse,
  OfflineRegionTileAddressV1,
} from "./tile-protocol.js";
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
export {
  applyOfflineRegionSchemaMigration,
  createIndexedDbOfflineRegionStore,
  HONUA_OFFLINE_REGION_SCHEMA_VERSION,
  HONUA_OFFLINE_REGION_STORE_RECOVERY_KIND,
  HONUA_OFFLINE_REGION_STORE_RECOVERY_VERSION,
  IndexedDbOfflineRegionStore,
  OFFLINE_REGION_SCHEMA_MIGRATIONS,
  planOfflineRegionSchemaMigration,
  readableOfflineRegionSchemaVersions,
} from "./indexeddb.js";
export type {
  OfflineRegionSchemaMigrationPlanV1,
  OfflineRegionSchemaMigrationRefusal,
  OfflineRegionSchemaMigrationV1,
  OfflineRegionStoreRecoveryV1,
} from "./indexeddb.js";
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
  DEFAULT_OFFLINE_EDIT_QUEUE_MAX_RECOVERY_BYTES,
  DEFAULT_OFFLINE_EDIT_QUEUE_MAX_RECOVERY_RECORDS,
  HONUA_OFFLINE_EDIT_QUEUE_RECOVERY_KIND,
  HONUA_OFFLINE_EDIT_QUEUE_RECOVERY_VERSION,
  HONUA_OFFLINE_EDIT_QUEUE_VERSION,
  HonuaOfflineEditQueueError,
  inspectStoredOfflineEdit,
  inspectStoredOfflineEditMetadata,
  inspectStoredOfflineEditTombstone,
  MAX_OFFLINE_EDIT_LEASE_DURATION_MS,
  planOfflineEditQueueRecovery,
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
  OfflineEditQueueDiscardReason,
  OfflineEditQueueErrorCode,
  OfflineEditQueueInspection,
  OfflineEditQueueMetadata,
  OfflineEditQueueOptions,
  OfflineEditQueuePartition,
  OfflineEditQueueRecoveryLimits,
  OfflineEditQueueRecoveryPlanV1,
  OfflineEditQueueRecoveryRowsV1,
  OfflineEditQueueRecoveryV1,
  OfflineEditQueueRepairReason,
  OfflineEditQueueStateCounts,
  OfflineEditQueueStoredRecord,
  OfflineEditQueueTombstone,
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
