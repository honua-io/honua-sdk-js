/**
 * Disconnected replica and sync-conflict SDK contracts.
 *
 * Console, MCP, QGIS, Studio, and mobile-adjacent tools share one product
 * contract for disconnected replica metadata and sync conflict review. The
 * surface is Esri-aligned (Sync, createReplica, synchronizeReplica, replica
 * names, server generation cursors, conflict behavior) without hard-coding
 * ArcGIS-only names, and composes with the temporal history contracts in
 * honua-sdk-js#227.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver
 *   contract — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export { HonuaReplicaSyncClient, createHonuaReplicaSync } from "./client.js";
export type { HonuaReplicaSyncClientOptions } from "./client.js";
export {
  HonuaReplicaSyncError,
  isHonuaReplicaSyncError,
  isUnsupportedReplicaSyncError,
} from "./errors.js";
export type { ReplicaSyncErrorCode } from "./errors.js";
export {
  FixtureReplicaSyncTransport,
  createFixtureReplicaSyncTransport,
  defaultSeed as defaultReplicaSyncSeed,
} from "./fixture.js";
export type {
  FixtureReplicaSyncSeed,
  FixtureReplicaSyncTransportOptions,
} from "./fixture.js";
export type {
  BatchConflictResolutionResult,
  ConflictFeatureState,
  ConflictResolutionChoice,
  ConflictResolutionOption,
  DisconnectedReplica,
  FieldConflict,
  GeometryConflictSummary,
  ListConflictsRequest,
  ListReplicasRequest,
  ReplicaConflictPolicy,
  ReplicaId,
  ReplicaState,
  ReplicaSyncCapabilities,
  ReplicaSyncDirection,
  ReplicaSyncStatus,
  ReplicaSyncTransport,
  ServerGenerationCursor,
  SyncActor,
  SyncConflictDetail,
  SyncConflictId,
  SyncConflictKind,
  SyncConflictOperation,
  SyncConflictResolution,
  SyncConflictResolutionRecord,
  SyncConflictStatus,
  SyncConflictSummary,
  SyncDevice,
  SyncPage,
} from "./types.js";
