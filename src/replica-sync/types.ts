/**
 * Disconnected replica and sync-conflict SDK contracts.
 *
 * These types give Console, MCP, QGIS, Studio, and mobile-adjacent tools a
 * single product-level shape for disconnected replica metadata and sync
 * conflict review, instead of forcing every client to infer it from low-level
 * sync responses. The model is Esri-aligned (replicas, server generation
 * cursors, conflict behavior) but does not hard-code ArcGIS-only names into the
 * public Honua surface.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";

/**
 * Re-exported so replica-sync conflict records compose directly with the
 * temporal history contracts (honua-sdk-js#227), which key revisions and
 * timelines by the same {@link FeatureId} / {@link SourceId} aliases. A reviewer
 * can take a conflict's `featureId` and feed it straight into the temporal
 * feature-timeline contract without re-typing.
 */
export type { FeatureId, SourceId } from "../contract/types.js";

/** Stable identifier for a disconnected replica. */
export type ReplicaId = string;

/** Stable identifier for a sync conflict awaiting review. */
export type SyncConflictId = string;

/**
 * Monotonic server generation cursor. A replica tracks the server generation it
 * last synchronized against; the server advances this on every committed edit.
 * Esri exposes this as `serverGen` on Sync responses — Honua keeps the cursor
 * opaque so transports can use sequence numbers, hybrid logical clocks, or
 * vector cursors.
 */
export type ServerGenerationCursor = string;

/** Lifecycle state of a disconnected replica. */
export type ReplicaState = "provisioning" | "active" | "syncing" | "out-of-date" | "expired" | "removed";

/**
 * How a replica reconciles concurrent edits when synchronizing. Mirrors Esri
 * `createReplica` conflict behavior without binding to its wire spelling.
 */
export type ReplicaConflictPolicy = "server-wins" | "client-wins" | "manual" | "last-writer-wins";

/** Direction(s) of data flow a replica supports. */
export type ReplicaSyncDirection = "bidirectional" | "upload" | "download";

/** Per-source capability flags advertised for a replica's parent dataset. */
export interface ReplicaSyncCapabilities {
  /** Replica creation / disconnected editing is offered at all. */
  readonly sync: boolean;
  /** Server can register new replicas (`createReplica`). */
  readonly createReplica: boolean;
  /** Existing replicas can be synchronized (`synchronizeReplica`). */
  readonly synchronizeReplica: boolean;
  /** Server retains per-conflict detail for manual review. */
  readonly conflictReview: boolean;
  /** Conflict resolutions can be submitted back through the SDK. */
  readonly conflictResolution: boolean;
  /** Supported reconciliation policies for new replicas. */
  readonly conflictPolicies: ReadonlyArray<ReplicaConflictPolicy>;
  /** Supported sync directions. */
  readonly directions: ReadonlyArray<ReplicaSyncDirection>;
}

/** Actor (person, service, or agent) attributed to a replica or edit. */
export interface SyncActor {
  readonly id: string;
  readonly displayName?: string;
  readonly kind?: "user" | "service" | "agent" | (string & {});
}

/** Device a disconnected replica is checked out to. */
export interface SyncDevice {
  readonly id: string;
  readonly displayName?: string;
  readonly platform?: string;
  readonly lastSeenAt?: string;
}

/** Outcome of the most recent synchronization attempt for a replica. */
export interface ReplicaSyncStatus {
  /** Server generation the replica was last reconciled against. */
  readonly serverGen?: ServerGenerationCursor;
  /** Server generation the replica is currently aware of (may be ahead). */
  readonly targetServerGen?: ServerGenerationCursor;
  readonly lastSyncedAt?: string;
  readonly lastSyncDirection?: ReplicaSyncDirection;
  readonly inProgress: boolean;
  /** Count of edits uploaded but not yet acknowledged by the server. */
  readonly pendingUploads?: number;
  /** Count of server edits not yet applied to the replica. */
  readonly pendingDownloads?: number;
  /** Open conflicts attributed to this replica. */
  readonly openConflicts: number;
  readonly lastError?: string;
}

/** A disconnected replica registered against a Honua dataset. */
export interface DisconnectedReplica {
  readonly id: ReplicaId;
  /**
   * Human-facing replica name. Esri parity surfaces a server-assigned replica
   * name; Honua keeps it optional and informational.
   */
  readonly name?: string;
  readonly datasetId: string;
  readonly sourceId?: SourceId;
  readonly state: ReplicaState;
  readonly direction: ReplicaSyncDirection;
  readonly conflictPolicy: ReplicaConflictPolicy;
  readonly owner?: SyncActor;
  readonly device?: SyncDevice;
  readonly createdAt: string;
  /** When the replica's server-side lease expires; absent means no expiry. */
  readonly expiresAt?: string;
  readonly status: ReplicaSyncStatus;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Lifecycle of a single sync conflict. */
export type SyncConflictStatus = "pending" | "resolving" | "resolved" | "discarded";

/** The kind of edit that produced a conflicting side. */
export type SyncConflictOperation = "create" | "update" | "delete";

/**
 * Distinguishes a disconnected-replica sync conflict from a named-version
 * reconcile/post conflict. Clients use this to route review UI correctly and to
 * avoid mixing the two conflict models (see honua-server#371).
 */
export type SyncConflictKind = "replica-sync" | "version-reconcile";

/** A single conflicting attribute value. */
export interface FieldConflict {
  readonly field: string;
  readonly baseValue?: unknown;
  readonly clientValue?: unknown;
  readonly serverValue?: unknown;
  /** True when client and server diverged from the common base. */
  readonly diverged: boolean;
}

/** Summary of a geometry-level conflict without shipping full geometries. */
export interface GeometryConflictSummary {
  readonly changed: boolean;
  readonly clientChanged: boolean;
  readonly serverChanged: boolean;
  readonly geometryType?: string;
  /** Hausdorff-style or area-delta hint, when the transport computes one. */
  readonly divergenceMeters?: number;
  readonly note?: string;
}

/** One side of a three-way conflict (base / client / server feature state). */
export interface ConflictFeatureState {
  readonly operation: SyncConflictOperation;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
  readonly editedAt?: string;
  readonly editedBy?: SyncActor;
  readonly device?: SyncDevice;
  /** Present when the feature was deleted on this side. */
  readonly deleted?: boolean;
}

/** How a single conflict may be resolved. */
export type ConflictResolutionChoice = "accept-client" | "accept-server" | "merge" | "discard";

/** A resolution option the server is willing to accept for a conflict. */
export interface ConflictResolutionOption {
  readonly choice: ConflictResolutionChoice;
  readonly label?: string;
  /** False when the option is shown but not currently selectable. */
  readonly available: boolean;
  readonly reason?: string;
}

/** Lightweight conflict record returned by listings. */
export interface SyncConflictSummary {
  readonly id: SyncConflictId;
  readonly replicaId: ReplicaId;
  readonly datasetId: string;
  readonly sourceId?: SourceId;
  readonly layerId?: string | number;
  /** Shared with the temporal contracts (#227) so a conflict's feature can be
   * fed straight into a temporal feature timeline. */
  readonly featureId: FeatureId;
  readonly kind: SyncConflictKind;
  readonly status: SyncConflictStatus;
  readonly clientOperation: SyncConflictOperation;
  readonly serverOperation: SyncConflictOperation;
  readonly detectedAt: string;
  /** Number of conflicting fields; geometry counts separately. */
  readonly fieldConflictCount: number;
  readonly hasGeometryConflict: boolean;
  readonly client?: SyncActor;
  readonly device?: SyncDevice;
}

/** Full three-way conflict detail for manual review. */
export interface SyncConflictDetail extends SyncConflictSummary {
  readonly serverGen?: ServerGenerationCursor;
  readonly base: ConflictFeatureState;
  readonly clientState: ConflictFeatureState;
  readonly serverState: ConflictFeatureState;
  readonly fieldConflicts: ReadonlyArray<FieldConflict>;
  readonly geometryConflict?: GeometryConflictSummary;
  readonly resolutionOptions: ReadonlyArray<ConflictResolutionOption>;
  /** Resolution recorded once the conflict reaches a terminal state. */
  readonly resolution?: SyncConflictResolutionRecord;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A resolution submitted by a reviewer. */
export interface SyncConflictResolution {
  readonly conflictId: SyncConflictId;
  readonly choice: ConflictResolutionChoice;
  /** Required when `choice` is `merge`: the field values to commit. */
  readonly mergedAttributes?: Readonly<Record<string, unknown>>;
  readonly mergedGeometry?: unknown;
  readonly note?: string;
  readonly resolvedBy?: SyncActor;
}

/** Server acknowledgement of an applied resolution. */
export interface SyncConflictResolutionRecord {
  readonly conflictId: SyncConflictId;
  readonly choice: ConflictResolutionChoice;
  readonly status: "resolved" | "discarded";
  readonly resolvedAt: string;
  readonly resolvedBy?: SyncActor;
  /** Server generation produced by committing the resolution. */
  readonly serverGen?: ServerGenerationCursor;
  readonly note?: string;
}

/** Pageable request for the replica listing. */
export interface ListReplicasRequest {
  readonly datasetId?: string;
  readonly sourceId?: SourceId;
  readonly states?: ReadonlyArray<ReplicaState>;
  readonly ownerId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

/** Pageable request for conflict listings. */
export interface ListConflictsRequest {
  readonly replicaId?: ReplicaId;
  readonly datasetId?: string;
  readonly statuses?: ReadonlyArray<SyncConflictStatus>;
  readonly kinds?: ReadonlyArray<SyncConflictKind>;
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

/** A page of results plus an optional continuation cursor. */
export interface SyncPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly cursor?: string;
  readonly totalCount?: number;
}

/** Result of submitting a batch of resolutions. */
export interface BatchConflictResolutionResult {
  readonly records: ReadonlyArray<SyncConflictResolutionRecord>;
  /** Conflicts that could not be resolved, with a reason. */
  readonly failures: ReadonlyArray<{
    readonly conflictId: SyncConflictId;
    readonly reason: string;
  }>;
}

/**
 * Transport-neutral contract the client drives. A fixture transport ships with
 * the SDK; a Connect/HTTP adapter can implement the same surface when the
 * server endpoints land.
 */
export interface ReplicaSyncTransport {
  /** Capabilities for a dataset (or the default source within it). */
  capabilities(datasetId: string, sourceId?: string): Promise<ReplicaSyncCapabilities>;
  listReplicas(request?: ListReplicasRequest): Promise<SyncPage<DisconnectedReplica>>;
  getReplica(replicaId: ReplicaId, options?: { readonly signal?: AbortSignal }): Promise<DisconnectedReplica>;
  listConflicts(request?: ListConflictsRequest): Promise<SyncPage<SyncConflictSummary>>;
  getConflict(conflictId: SyncConflictId, options?: { readonly signal?: AbortSignal }): Promise<SyncConflictDetail>;
  resolveConflict(resolution: SyncConflictResolution): Promise<SyncConflictResolutionRecord>;
  resolveConflicts(resolutions: ReadonlyArray<SyncConflictResolution>): Promise<BatchConflictResolutionResult>;
}
