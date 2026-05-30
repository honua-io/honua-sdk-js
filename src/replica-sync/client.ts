/**
 * Disconnected replica and sync-conflict client.
 *
 * The client is a thin, ergonomic wrapper over a {@link ReplicaSyncTransport}.
 * It centralizes validation (e.g. rejecting a `merge` resolution that omits
 * merged attributes) so every consuming surface — Console, MCP, QGIS, Studio —
 * gets the same guarantees regardless of the transport behind it.
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

export interface HonuaReplicaSyncClientOptions {
  readonly transport: ReplicaSyncTransport;
}

export function createHonuaReplicaSync(options: HonuaReplicaSyncClientOptions): HonuaReplicaSyncClient {
  return new HonuaReplicaSyncClient(options);
}

export class HonuaReplicaSyncClient {
  readonly #transport: ReplicaSyncTransport;

  public constructor(options: HonuaReplicaSyncClientOptions) {
    this.#transport = options.transport;
  }

  /** Discover replica/sync capabilities for a dataset (or one of its sources). */
  public capabilities(datasetId: string, sourceId?: string): Promise<ReplicaSyncCapabilities> {
    return this.#transport.capabilities(datasetId, sourceId);
  }

  public listReplicas(request: ListReplicasRequest = {}): Promise<SyncPage<DisconnectedReplica>> {
    return this.#transport.listReplicas(request);
  }

  public getReplica(
    replicaId: ReplicaId,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<DisconnectedReplica> {
    return this.#transport.getReplica(replicaId, options);
  }

  public listConflicts(request: ListConflictsRequest = {}): Promise<SyncPage<SyncConflictSummary>> {
    return this.#transport.listConflicts(request);
  }

  public getConflict(
    conflictId: SyncConflictId,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SyncConflictDetail> {
    return this.#transport.getConflict(conflictId, options);
  }

  public async resolveConflict(resolution: SyncConflictResolution): Promise<SyncConflictResolutionRecord> {
    assertResolutionWellFormed(resolution);
    return this.#transport.resolveConflict(resolution);
  }

  public async resolveConflicts(
    resolutions: ReadonlyArray<SyncConflictResolution>,
  ): Promise<BatchConflictResolutionResult> {
    for (const resolution of resolutions) assertResolutionWellFormed(resolution);
    return this.#transport.resolveConflicts(resolutions);
  }
}

function assertResolutionWellFormed(resolution: SyncConflictResolution): void {
  if (
    resolution.choice === "merge" &&
    resolution.mergedAttributes === undefined &&
    resolution.mergedGeometry === undefined
  ) {
    throw new HonuaReplicaSyncError(
      "merge-required",
      "A merge resolution must supply mergedAttributes and/or mergedGeometry.",
      { details: { conflictId: resolution.conflictId } },
    );
  }
}
