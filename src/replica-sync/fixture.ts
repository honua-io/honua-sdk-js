/**
 * In-memory fixture transport for disconnected replica and sync-conflict
 * review. It powers Console and Studio temporal/conflict viewer prototypes and
 * SDK tests without a live server.
 *
 * The default seed covers the states the issue calls out: an active replica, an
 * expired replica, a pending conflict, an already-resolved conflict, a batch of
 * conflicts, and a dataset where conflict review is unsupported.
 *
 * @module
 */

import { HonuaReplicaSyncError } from "./errors.js";
import type {
  BatchConflictResolutionResult,
  DisconnectedReplica,
  ListConflictsRequest,
  ListReplicasRequest,
  ReplicaId,
  ReplicaSyncCapabilities,
  ReplicaSyncTransport,
  SyncConflictDetail,
  SyncConflictId,
  SyncConflictResolution,
  SyncConflictResolutionRecord,
  SyncConflictSummary,
  SyncPage,
} from "./types.js";

export interface FixtureReplicaSyncSeed {
  readonly capabilities?: Record<string, ReplicaSyncCapabilities>;
  readonly replicas?: ReadonlyArray<DisconnectedReplica>;
  readonly conflicts?: ReadonlyArray<SyncConflictDetail>;
}

export interface FixtureReplicaSyncTransportOptions {
  readonly now?: () => Date;
  readonly seed?: FixtureReplicaSyncSeed;
}

const FULL_CAPABILITIES: ReplicaSyncCapabilities = {
  sync: true,
  createReplica: true,
  synchronizeReplica: true,
  conflictReview: true,
  conflictResolution: true,
  conflictPolicies: ["server-wins", "client-wins", "manual"],
  directions: ["bidirectional", "upload", "download"],
};

const NO_CONFLICT_REVIEW_CAPABILITIES: ReplicaSyncCapabilities = {
  sync: true,
  createReplica: true,
  synchronizeReplica: true,
  conflictReview: false,
  conflictResolution: false,
  conflictPolicies: ["server-wins", "client-wins"],
  directions: ["bidirectional"],
};

export function createFixtureReplicaSyncTransport(
  options: FixtureReplicaSyncTransportOptions = {},
): FixtureReplicaSyncTransport {
  return new FixtureReplicaSyncTransport(options);
}

export class FixtureReplicaSyncTransport implements ReplicaSyncTransport {
  readonly #now: () => Date;
  readonly #capabilities = new Map<string, ReplicaSyncCapabilities>();
  readonly #replicas = new Map<ReplicaId, DisconnectedReplica>();
  readonly #conflicts = new Map<SyncConflictId, SyncConflictDetail>();

  public constructor(options: FixtureReplicaSyncTransportOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    const seed = options.seed ?? defaultSeed();
    for (const [key, value] of Object.entries(seed.capabilities ?? {})) this.#capabilities.set(key, value);
    for (const replica of seed.replicas ?? []) this.#replicas.set(replica.id, replica);
    for (const conflict of seed.conflicts ?? []) this.#conflicts.set(conflict.id, conflict);
  }

  public async capabilities(datasetId: string, sourceId?: string): Promise<ReplicaSyncCapabilities> {
    const key = capabilityKey(datasetId, sourceId);
    const caps = this.#capabilities.get(key) ?? this.#capabilities.get(datasetId);
    if (!caps) {
      throw new HonuaReplicaSyncError(
        "unsupported-sync",
        `Disconnected sync is not available for dataset "${datasetId}".`,
      );
    }
    return caps;
  }

  public async listReplicas(request: ListReplicasRequest = {}): Promise<SyncPage<DisconnectedReplica>> {
    const items = [...this.#replicas.values()].filter((replica) => {
      if (request.datasetId !== undefined && replica.datasetId !== request.datasetId) return false;
      if (request.sourceId !== undefined && replica.sourceId !== request.sourceId) return false;
      if (request.ownerId !== undefined && replica.owner?.id !== request.ownerId) return false;
      if (request.states !== undefined && !request.states.includes(replica.state)) return false;
      return true;
    });
    return paginate(items, request.limit, request.cursor);
  }

  public async getReplica(replicaId: ReplicaId): Promise<DisconnectedReplica> {
    const replica = this.#replicas.get(replicaId);
    if (!replica) {
      throw new HonuaReplicaSyncError("replica-not-found", `Replica "${replicaId}" was not found.`);
    }
    return replica;
  }

  public async listConflicts(request: ListConflictsRequest = {}): Promise<SyncPage<SyncConflictSummary>> {
    const replica = request.replicaId === undefined ? undefined : this.#replicas.get(request.replicaId);
    if (request.replicaId !== undefined && replica === undefined) {
      throw new HonuaReplicaSyncError("replica-not-found", `Replica "${request.replicaId}" was not found.`);
    }
    this.assertConflictReviewSupported(replica?.datasetId ?? request.datasetId);

    const items = [...this.#conflicts.values()].filter((conflict) => {
      if (request.replicaId !== undefined && conflict.replicaId !== request.replicaId) return false;
      if (request.datasetId !== undefined && conflict.datasetId !== request.datasetId) return false;
      if (request.statuses !== undefined && !request.statuses.includes(conflict.status)) return false;
      if (request.kinds !== undefined && !request.kinds.includes(conflict.kind)) return false;
      return true;
    });
    return paginate(items.map(toSummary), request.limit, request.cursor);
  }

  public async getConflict(conflictId: SyncConflictId): Promise<SyncConflictDetail> {
    const conflict = this.#conflicts.get(conflictId);
    if (!conflict) {
      throw new HonuaReplicaSyncError("conflict-not-found", `Sync conflict "${conflictId}" was not found.`);
    }
    this.assertConflictReviewSupported(conflict.datasetId);
    return conflict;
  }

  public async resolveConflict(resolution: SyncConflictResolution): Promise<SyncConflictResolutionRecord> {
    const conflict = this.#conflicts.get(resolution.conflictId);
    if (!conflict) {
      throw new HonuaReplicaSyncError("conflict-not-found", `Sync conflict "${resolution.conflictId}" was not found.`);
    }
    this.assertConflictReviewSupported(conflict.datasetId);
    if (conflict.status === "resolved" || conflict.status === "discarded") {
      throw new HonuaReplicaSyncError(
        "conflict-already-resolved",
        `Sync conflict "${conflict.id}" is already resolved.`,
        {
          details: { status: conflict.status },
        },
      );
    }

    const record: SyncConflictResolutionRecord = {
      conflictId: conflict.id,
      choice: resolution.choice,
      status: resolution.choice === "discard" ? "discarded" : "resolved",
      resolvedAt: this.#now().toISOString(),
      resolvedBy: resolution.resolvedBy,
      serverGen: bumpServerGen(conflict.serverGen),
      note: resolution.note,
    };
    this.#conflicts.set(conflict.id, { ...conflict, status: record.status, resolution: record });
    return record;
  }

  public async resolveConflicts(
    resolutions: ReadonlyArray<SyncConflictResolution>,
  ): Promise<BatchConflictResolutionResult> {
    const records: SyncConflictResolutionRecord[] = [];
    const failures: Array<{ readonly conflictId: SyncConflictId; readonly reason: string }> = [];
    for (const resolution of resolutions) {
      try {
        records.push(await this.resolveConflict(resolution));
      } catch (error) {
        failures.push({
          conflictId: resolution.conflictId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { records, failures };
  }

  private assertConflictReviewSupported(datasetId: string | undefined): void {
    if (datasetId === undefined) return;
    const caps = this.#capabilities.get(datasetId);
    if (caps && !caps.conflictReview) {
      throw new HonuaReplicaSyncError(
        "unsupported-conflict-review",
        `Manual conflict review is not available for dataset "${datasetId}".`,
      );
    }
  }
}

function capabilityKey(datasetId: string, sourceId?: string): string {
  return sourceId === undefined ? datasetId : `${datasetId}::${sourceId}`;
}

function toSummary(conflict: SyncConflictDetail): SyncConflictSummary {
  const {
    base: _base,
    clientState: _clientState,
    serverState: _serverState,
    fieldConflicts: _fieldConflicts,
    geometryConflict: _geometryConflict,
    resolutionOptions: _resolutionOptions,
    resolution: _resolution,
    serverGen: _serverGen,
    metadata: _metadata,
    ...summary
  } = conflict;
  return summary;
}

function paginate<T>(items: ReadonlyArray<T>, limit?: number, cursor?: string): SyncPage<T> {
  const start = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
  const end = limit === undefined ? items.length : start + limit;
  const page = items.slice(start, end);
  const nextCursor = end < items.length ? String(end) : undefined;
  return { items: page, cursor: nextCursor, totalCount: items.length };
}

function bumpServerGen(serverGen: string | undefined): string {
  const current = serverGen === undefined ? 0 : Number.parseInt(serverGen, 10) || 0;
  return String(current + 1);
}

/**
 * Default seed covering every state the issue enumerates. Re-export so apps and
 * tests can extend it.
 */
export function defaultSeed(): FixtureReplicaSyncSeed {
  const owner = { id: "user-amelia", displayName: "Amelia Stone", kind: "user" as const };
  const device = { id: "device-field-01", displayName: "Field Tablet 01", platform: "android" };

  const activeReplica: DisconnectedReplica = {
    id: "replica-active-1",
    name: "Parcels — North District",
    datasetId: "parcels",
    sourceId: "parcels",
    state: "active",
    direction: "bidirectional",
    conflictPolicy: "manual",
    owner,
    device,
    createdAt: "2026-05-20T08:00:00.000Z",
    expiresAt: "2026-06-20T08:00:00.000Z",
    status: {
      serverGen: "42",
      targetServerGen: "47",
      lastSyncedAt: "2026-05-28T16:30:00.000Z",
      lastSyncDirection: "bidirectional",
      inProgress: false,
      pendingUploads: 3,
      pendingDownloads: 5,
      openConflicts: 2,
    },
  };

  const expiredReplica: DisconnectedReplica = {
    id: "replica-expired-1",
    name: "Inspections — South District",
    datasetId: "inspections",
    sourceId: "inspections",
    state: "expired",
    direction: "upload",
    conflictPolicy: "server-wins",
    owner: { id: "user-noah", displayName: "Noah Patel", kind: "user" },
    device: { id: "device-field-07", displayName: "Field Tablet 07", platform: "ios" },
    createdAt: "2026-03-01T08:00:00.000Z",
    expiresAt: "2026-04-01T08:00:00.000Z",
    status: {
      serverGen: "11",
      lastSyncedAt: "2026-03-30T12:00:00.000Z",
      lastSyncDirection: "upload",
      inProgress: false,
      pendingUploads: 0,
      pendingDownloads: 0,
      openConflicts: 0,
      lastError: "Replica lease expired before final synchronization.",
    },
  };

  const pendingConflict: SyncConflictDetail = {
    id: "conflict-pending-1",
    replicaId: "replica-active-1",
    datasetId: "parcels",
    sourceId: "parcels",
    layerId: 0,
    featureId: "parcel-1024",
    kind: "replica-sync",
    status: "pending",
    clientOperation: "update",
    serverOperation: "update",
    detectedAt: "2026-05-28T16:30:05.000Z",
    fieldConflictCount: 1,
    hasGeometryConflict: true,
    client: owner,
    device,
    serverGen: "47",
    base: {
      operation: "update",
      attributes: { zoning: "R1", area: 1200 },
      editedAt: "2026-05-20T08:00:00.000Z",
    },
    clientState: {
      operation: "update",
      attributes: { zoning: "R2", area: 1200 },
      geometry: { type: "Polygon", coordinates: [] },
      editedAt: "2026-05-27T10:15:00.000Z",
      editedBy: owner,
      device,
    },
    serverState: {
      operation: "update",
      attributes: { zoning: "C1", area: 1200 },
      geometry: { type: "Polygon", coordinates: [] },
      editedAt: "2026-05-28T09:45:00.000Z",
      editedBy: { id: "user-office", displayName: "Office Editor", kind: "user" },
    },
    fieldConflicts: [{ field: "zoning", baseValue: "R1", clientValue: "R2", serverValue: "C1", diverged: true }],
    geometryConflict: {
      changed: true,
      clientChanged: true,
      serverChanged: true,
      geometryType: "Polygon",
      divergenceMeters: 3.4,
      note: "Both sides moved a shared vertex.",
    },
    resolutionOptions: [
      { choice: "accept-client", label: "Keep field edit", available: true },
      { choice: "accept-server", label: "Keep office edit", available: true },
      { choice: "merge", label: "Merge values", available: true },
      { choice: "discard", label: "Discard both", available: true },
    ],
  };

  const resolvedConflict: SyncConflictDetail = {
    id: "conflict-resolved-1",
    replicaId: "replica-active-1",
    datasetId: "parcels",
    sourceId: "parcels",
    layerId: 0,
    featureId: "parcel-2048",
    kind: "replica-sync",
    status: "resolved",
    clientOperation: "update",
    serverOperation: "delete",
    detectedAt: "2026-05-26T11:00:00.000Z",
    fieldConflictCount: 0,
    hasGeometryConflict: false,
    client: owner,
    device,
    serverGen: "44",
    base: { operation: "update", attributes: { owner: "Acme" } },
    clientState: {
      operation: "update",
      attributes: { owner: "Acme Holdings" },
      editedAt: "2026-05-25T14:00:00.000Z",
      editedBy: owner,
      device,
    },
    serverState: {
      operation: "delete",
      deleted: true,
      editedAt: "2026-05-26T10:00:00.000Z",
      editedBy: { id: "user-office", displayName: "Office Editor", kind: "user" },
    },
    fieldConflicts: [],
    resolutionOptions: [
      { choice: "accept-client", label: "Restore feature", available: true },
      { choice: "accept-server", label: "Keep deletion", available: true },
      { choice: "merge", label: "Merge values", available: false, reason: "Server side was deleted." },
      { choice: "discard", label: "Discard", available: true },
    ],
    resolution: {
      conflictId: "conflict-resolved-1",
      choice: "accept-client",
      status: "resolved",
      resolvedAt: "2026-05-26T12:00:00.000Z",
      resolvedBy: owner,
      serverGen: "45",
      note: "Restored — feature was edited in the field after the office delete.",
    },
  };

  // A second pending conflict so batch-resolution scenarios have >1 input.
  const batchConflict: SyncConflictDetail = {
    ...pendingConflict,
    id: "conflict-pending-2",
    featureId: "parcel-3072",
    detectedAt: "2026-05-28T16:31:00.000Z",
    serverGen: "47",
    fieldConflicts: [{ field: "area", baseValue: 1200, clientValue: 1250, serverValue: 1300, diverged: true }],
    fieldConflictCount: 1,
    hasGeometryConflict: false,
    geometryConflict: undefined,
  };

  // Dataset that supports sync but not manual conflict review.
  const unsupportedReviewReplica: DisconnectedReplica = {
    id: "replica-no-review-1",
    name: "Hydrants — server-wins",
    datasetId: "hydrants",
    sourceId: "hydrants",
    state: "active",
    direction: "bidirectional",
    conflictPolicy: "server-wins",
    createdAt: "2026-05-22T08:00:00.000Z",
    status: {
      serverGen: "9",
      lastSyncedAt: "2026-05-29T07:00:00.000Z",
      lastSyncDirection: "bidirectional",
      inProgress: false,
      openConflicts: 0,
    },
  };

  return {
    capabilities: {
      parcels: FULL_CAPABILITIES,
      inspections: FULL_CAPABILITIES,
      hydrants: NO_CONFLICT_REVIEW_CAPABILITIES,
    },
    replicas: [activeReplica, expiredReplica, unsupportedReviewReplica],
    conflicts: [pendingConflict, resolvedConflict, batchConflict],
  };
}
