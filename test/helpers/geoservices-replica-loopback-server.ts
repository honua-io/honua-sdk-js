/**
 * Loopback server speaking the honua-server GeoServices replica-sync dialect.
 *
 * Every response shape here is transcribed from the server repository's own
 * conformance tests, so the SDK transport is exercised against the wire the
 * server actually proves it emits — not against a shape the SDK invented:
 *
 * - `GET /rest/services/{id}/FeatureServer` sync advertisement —
 *   `FeatureServerReplicaSyncTests.ServiceMetadata_SyncEnabled_AdvertisesSyncCapabilities`
 *   (`syncEnabled`, `syncCapabilities.supportsRollbackOnFailure` /
 *   `supportsSyncDirectionControl` / `supportsPerReplicaSync` /
 *   `supportedSyncDataOptions`), plus the `"Sync"` capabilities token added by
 *   `FeatureServerUtilities.V2.BuildServiceCapabilitiesV2`.
 * - `POST …/createReplica` → `{ replicaID, serverGen }` —
 *   `FeatureServerReplicaSyncTests.CreateReplicaWithResponseAsync` /
 *   `SynchronizeReplica_Download_DeliversPostReplicaChangesAndAdvancesServerGen`.
 * - `POST …/synchronizeReplica` → `{ success, replicaID, syncDirection,
 *   serverGen, appliedAdds/Updates/Deletes, edits[], conflicts[] }` —
 *   `SynchronizeReplica_MultiLayerUpload_AppliesPerLayerEdits`,
 *   `SynchronizeReplica_Bidirectional_AppliesUploadAndDeliversServerDelta`,
 *   `SynchronizeReplica_ConcurrentServerEdit_RecordsConflictAndAppliesLastWriteWins`
 *   (conflict entry: `layerId`, `objectId`, `applied`, `conflictId`) and
 *   `SynchronizeReplica_GeometryOnlyConflict_ClassifiesAsGeometry`
 *   (`conflictType` as the `ReplicaConflictType` ordinal).
 * - `GET /api/v1/admin/services/{id}/replicas[/{replicaId}]` —
 *   `ReplicaManagementEndpointTests.ListReplicas_AfterCreate_ReturnsRegisteredReplica`
 *   and `GetReplica_ForRegisteredReplica_ReturnsDetail`; the derived
 *   `active` / `expired` status comes from
 *   `ReplicaConflictReviewEndpointTests.GetReplica_AfterRecentSync_ReportsActiveStatus`
 *   and `GetReplica_WhenLastSyncIsStale_ReportsExpiredStatus`.
 * - `GET …/replicas/{id}/conflicts[?status=]` —
 *   `ReplicaConflictReviewEndpointTests.ListConflicts_WhenPendingConflictExists_ReturnsConflict`
 *   and `ListConflicts_WhenBatchOfConflictsExist_ReturnsAllAndFiltersByStatus`
 *   (`statusFilter`, `conflictType` as a string, `serverGeneration`).
 * - `GET …/conflicts/{conflictId}` —
 *   `GetConflict_ForPendingConflict_ReturnsBaseClientServerStates` and
 *   `GetConflict_ForResolvedConflict_ReturnsResolutionEvidence`.
 * - `POST …/conflicts/{conflictId}/resolve` →
 *   `{ conflict, committedNewServerState }` —
 *   `ResolveConflict_WithAcceptClient_CommitsNewServerStateAndMarksResolved`,
 *   `ResolveConflict_WithKeepServer_DoesNotCommitNewServerState`,
 *   `ResolveConflict_WhenAlreadyResolved_ReturnsConflict` (HTTP 409) and
 *   `ResolveConflict_WithUnknownAction_ReturnsBadRequest`.
 * - `ListConflicts_WhenProviderDoesNotSupportReview_ReturnsNotImplemented` →
 *   HTTP 501, modelled by the `conflictReviewSupported: false` switch.
 * - `POST …/{layerId}/applyEdits` per-feature codes —
 *   `FeatureServerApplyEditsConflictCodeTests` and the code table in
 *   `GeoServicesEditErrorCodes`.
 * - The capability gate's HTTP 404 `application/problem+json` body
 *   (`type: honua:capability-experimental-disabled`) is
 *   `CapabilityGateEndpointFilter.CreateExperimentalDisabledProblem`, modelled
 *   by the `capabilityDisabled` switch.
 *
 * The recorded `requests` log exists so tests can prove no credential ever
 * reaches a URL.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const LOOPBACK_SERVICE_ID = "parcels";
export const LOOPBACK_UNSUPPORTED_SERVICE_ID = "hydrants-no-sync";

export interface GeoServicesReplicaLoopbackOptions {
  /** Answer every admin replica route with the capability gate's 404 problem. */
  readonly capabilityDisabled?: boolean;
  /** Answer conflict routes with HTTP 501, as a no-op conflict repository does. */
  readonly conflictReviewSupported?: boolean;
  /** Replace a member of the named response with a drifted value. */
  readonly drift?: GeoServicesReplicaDrift;
}

export type GeoServicesReplicaDrift =
  | "conflict-classification"
  | "conflict-status"
  | "replica-status"
  | "resolution-action"
  | "unsafe-server-generation"
  | "missing-envelope-data"
  | "unknown-edit-code";

export interface GeoServicesReplicaLoopbackServer {
  readonly baseUrl: string;
  readonly requests: ReadonlyArray<{ readonly method: string; readonly url: string }>;
  close(): Promise<void>;
}

interface ConflictRow {
  conflictId: string;
  replicaId: string;
  layerId: number;
  objectId: number;
  conflictType: string;
  status: string;
  serverGeneration: number;
  detectedAt: string;
  resolutionAction: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolvedServerGeneration: number | null;
}

const REPLICAS = [
  {
    replicaId: "8f14e45fceea167a5a36dedd4bea2543",
    replicaName: "Parcels — North District",
    syncModel: "perReplica",
    layerIds: [0],
    createdAt: "2026-05-20T08:00:00.000Z",
    lastSyncTime: "2026-05-28T16:30:00.000Z",
    lastSyncGeneration: 42,
    status: "active",
  },
  {
    replicaId: "c9f0f895fb98ab9159f51fd0297e236d",
    replicaName: "Parcels — South District",
    syncModel: "perReplica",
    layerIds: [1],
    createdAt: "2026-03-01T08:00:00.000Z",
    lastSyncTime: "2026-03-30T12:00:00.000Z",
    lastSyncGeneration: 11,
    status: "expired",
  },
] as const;

function seedConflicts(): ConflictRow[] {
  return [
    {
      conflictId: "45c48cce2e2d7fbdea1afc51c7c6ad26",
      replicaId: REPLICAS[0].replicaId,
      layerId: 0,
      objectId: 1024,
      conflictType: "attribute",
      status: "pending",
      serverGeneration: 47,
      detectedAt: "2026-05-28T16:30:05.000Z",
      resolutionAction: null,
      resolvedBy: null,
      resolvedAt: null,
      resolvedServerGeneration: null,
    },
    {
      conflictId: "d3d9446802a44259755d38e6d163e820",
      replicaId: REPLICAS[0].replicaId,
      layerId: 0,
      objectId: 2048,
      conflictType: "geometry",
      status: "resolved",
      serverGeneration: 44,
      detectedAt: "2026-05-26T11:00:00.000Z",
      resolutionAction: "acceptClient",
      resolvedBy: "operator-1",
      resolvedAt: "2026-05-26T12:00:00.000Z",
      resolvedServerGeneration: 45,
    },
    {
      conflictId: "6512bd43d9caa6e02c990b0a82652dca",
      replicaId: REPLICAS[1].replicaId,
      layerId: 1,
      objectId: 3072,
      conflictType: "updateDelete",
      status: "pending",
      serverGeneration: 12,
      detectedAt: "2026-03-29T09:00:00.000Z",
      resolutionAction: null,
      resolvedBy: null,
      resolvedAt: null,
      resolvedServerGeneration: null,
    },
  ];
}

export async function startGeoServicesReplicaLoopbackServer(
  options: GeoServicesReplicaLoopbackOptions = {},
): Promise<GeoServicesReplicaLoopbackServer> {
  const conflictReviewSupported = options.conflictReviewSupported ?? true;
  const conflicts = seedConflicts();
  const requests: Array<{ method: string; url: string }> = [];

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const rawUrl = request.url ?? "/";
    requests.push({ method, url: rawUrl });
    const url = new URL(rawUrl, "http://127.0.0.1");

    readBody(request)
      .then((body) => route(method, url, body))
      .then((result) => send(response, result.status, result.body, result.contentType))
      .catch(() => send(response, 500, { error: { code: 500, message: "loopback failure" } }));
  });

  async function route(
    method: string,
    url: URL,
    body: string,
  ): Promise<{ status: number; body: unknown; contentType?: string }> {
    const path = url.pathname;

    // ── FeatureServer metadata ────────────────────────────────────────────
    const metadata = /^\/rest\/services\/([^/]+)\/FeatureServer(?:\/(\d+))?$/.exec(path);
    if (metadata && method === "GET") {
      const serviceId = decodeURIComponent(metadata[1]!);
      if (serviceId === LOOPBACK_UNSUPPORTED_SERVICE_ID) {
        return { status: 200, body: { currentVersion: 11.4, syncEnabled: false, capabilities: "Query" } };
      }
      return {
        status: 200,
        body: {
          currentVersion: 11.4,
          syncEnabled: true,
          capabilities: "Query,Create,Update,Delete,Sync",
          syncCapabilities: {
            supportsAsync: false,
            supportsRegisteringExistingData: false,
            supportsSyncDirectionControl: true,
            supportsPerLayerSync: true,
            supportsPerReplicaSync: true,
            supportsSyncModelNone: false,
            supportsRollbackOnFailure: true,
            supportsAttachmentsSyncDirection: false,
            supportedSyncDataOptions: 1,
          },
        },
      };
    }

    // ── FeatureServer replica operations ──────────────────────────────────
    if (method === "POST" && path.endsWith("/FeatureServer/createReplica")) {
      const payload = parseJson(body);
      return {
        status: 200,
        body: {
          replicaID: "e4da3b7fbbce2345d7772b0674a318d5",
          replicaName: payload.replicaName ?? "replica",
          syncModel: payload.syncModel ?? "perReplica",
          serverGen: options.drift === "unsafe-server-generation" ? Number.MAX_SAFE_INTEGER + 2 : 50,
          layers: [{ id: 0, serverGen: 50 }],
          creationDate: "2026-08-04T00:00:00.000Z",
        },
      };
    }

    if (method === "POST" && path.endsWith("/FeatureServer/synchronizeReplica")) {
      const payload = parseJson(body);
      const direction = typeof payload.syncDirection === "string" ? payload.syncDirection : "bidirectional";
      return {
        status: 200,
        body: {
          success: true,
          replicaID: payload.replicaID,
          syncDirection: direction,
          serverGen: 51,
          ...(direction === "upload"
            ? {}
            : { edits: [{ id: 0, adds: 1, updates: 0, deletes: 0, addFeatures: [{ attributes: { objectid: 7 } }] }] }),
          appliedAdds: direction === "download" ? undefined : 1,
          appliedUpdates: direction === "download" ? undefined : 0,
          appliedDeletes: direction === "download" ? undefined : 0,
          conflicts:
            direction === "download"
              ? undefined
              : [
                  {
                    layerId: 0,
                    objectId: 1024,
                    // ReplicaConflictType ordinal: 1 = Geometry.
                    conflictType: options.drift === "conflict-classification" ? 99 : 1,
                    applied: true,
                    conflictId: conflicts[0]!.conflictId,
                  },
                ],
        },
      };
    }

    if (method === "POST" && path.endsWith("/FeatureServer/unRegisterReplica")) {
      return { status: 200, body: { success: true } };
    }

    const applyEdits = /\/FeatureServer\/(\d+)\/applyEdits$/.exec(path);
    if (applyEdits && method === "POST") {
      return { status: 200, body: applyEditsEnvelope(options.drift) };
    }

    // ── Admin replica management ──────────────────────────────────────────
    const admin =
      /^\/api\/v1\/admin\/services\/([^/]+)\/replicas(?:\/([^/]+))?(?:\/conflicts(?:\/([^/]+))?)?(?:\/(resolve))?$/.exec(
        path,
      );
    if (!admin) return { status: 404, body: { error: { code: 404, message: "unknown route" } } };

    if (options.capabilityDisabled) {
      return {
        status: 404,
        contentType: "application/problem+json",
        body: {
          type: "honua:capability-experimental-disabled",
          title: "Not Found",
          status: 404,
          detail:
            "The 'sync.offline' capability is experimental and disabled. Enable it via the configuration key 'Capabilities:Experimental:sync.offline:Enabled=true'.",
        },
      };
    }

    const serviceId = decodeURIComponent(admin[1]!);
    const replicaId = admin[2] === undefined ? undefined : decodeURIComponent(admin[2]);
    const conflictId = admin[3] === undefined ? undefined : decodeURIComponent(admin[3]);
    const isResolve = admin[4] === "resolve";

    if (replicaId === undefined) {
      if (options.drift === "missing-envelope-data") return { status: 200, body: { success: true } };
      return {
        status: 200,
        body: {
          success: true,
          data: {
            serviceId,
            replicas: REPLICAS.map((replica) => ({
              replicaId: replica.replicaId,
              replicaName: replica.replicaName,
              serviceId,
              syncModel: replica.syncModel,
              layerIds: replica.layerIds,
              createdAt: replica.createdAt,
              lastSyncTime: replica.lastSyncTime,
              status: options.drift === "replica-status" ? "quiesced" : replica.status,
            })),
          },
        },
      };
    }

    const replica = REPLICAS.find((entry) => entry.replicaId === replicaId);
    if (!replica) return { status: 404, body: { error: { code: 404, message: "replica not found" } } };

    if (conflictId === undefined && !isResolve && admin[0]!.includes("/conflicts")) {
      if (!conflictReviewSupported) {
        return { status: 501, body: { error: { code: 501, message: "conflict review is not supported" } } };
      }
      const statusFilter = url.searchParams.get("status") ?? undefined;
      const rows = conflicts.filter(
        (row) => row.replicaId === replicaId && (statusFilter === undefined || row.status === statusFilter),
      );
      return {
        status: 200,
        body: {
          success: true,
          data: {
            serviceId,
            replicaId,
            ...(statusFilter === undefined ? {} : { statusFilter }),
            conflicts: rows.map((row) => summaryOf(row, serviceId, options.drift)),
          },
        },
      };
    }

    if (conflictId === undefined) {
      // Replica detail.
      return {
        status: 200,
        body: {
          success: true,
          data: {
            replicaId: replica.replicaId,
            replicaName: replica.replicaName,
            serviceId,
            syncModel: replica.syncModel,
            layerIds: replica.layerIds,
            createdAt: replica.createdAt,
            lastSyncTime: replica.lastSyncTime,
            lastSyncGeneration:
              options.drift === "unsafe-server-generation" ? Number.MAX_SAFE_INTEGER + 2 : replica.lastSyncGeneration,
            status: options.drift === "replica-status" ? "quiesced" : replica.status,
          },
        },
      };
    }

    if (!conflictReviewSupported) {
      return { status: 501, body: { error: { code: 501, message: "conflict review is not supported" } } };
    }

    const row = conflicts.find((entry) => entry.conflictId === conflictId);
    if (!row) return { status: 404, body: { error: { code: 404, message: "conflict not found" } } };

    if (isResolve && method === "POST") {
      const payload = parseJson(body);
      const action = payload.action;
      if (row.status !== "pending") {
        return { status: 409, body: { error: { code: 409, message: "conflict is already resolved" } } };
      }
      if (typeof action !== "string" || !KNOWN_ACTIONS.has(action)) {
        return { status: 400, body: { error: { code: 400, message: "unknown resolution action" } } };
      }
      const commits = action === "acceptClient" || action === "mergeFields" || action === "chooseGeometry";
      row.status = action === "defer" ? "deferred" : "resolved";
      row.resolutionAction = action;
      row.resolvedBy = "operator-1";
      row.resolvedAt = "2026-08-04T12:00:00.000Z";
      row.resolvedServerGeneration = commits ? row.serverGeneration + 1 : null;
      return {
        status: 200,
        body: {
          success: true,
          data: { conflict: detailOf(row, serviceId, options.drift), committedNewServerState: commits },
        },
      };
    }

    return { status: 200, body: { success: true, data: detailOf(row, serviceId, options.drift) } };
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () => closeServer(server),
  };
}

const KNOWN_ACTIONS = new Set(["acceptClient", "keepServer", "mergeFields", "chooseGeometry", "rejectClient", "defer"]);

function summaryOf(row: ConflictRow, serviceId: string, drift: GeoServicesReplicaDrift | undefined): unknown {
  return {
    conflictId: row.conflictId,
    replicaId: row.replicaId,
    serviceId,
    layerId: row.layerId,
    objectId: row.objectId,
    conflictType: drift === "conflict-classification" ? "topology" : row.conflictType,
    status: drift === "conflict-status" ? "quarantined" : row.status,
    serverGeneration: row.serverGeneration,
    detectedAt: row.detectedAt,
  };
}

function detailOf(row: ConflictRow, serviceId: string, drift: GeoServicesReplicaDrift | undefined): unknown {
  return {
    ...(summaryOf(row, serviceId, drift) as Record<string, unknown>),
    syncOperationId: "sync-op-1",
    deviceId: "device-42",
    userId: "field-user",
    baseState: { attributes: { OBJECTID: row.objectId, name: "base" } },
    clientState: { attributes: { OBJECTID: row.objectId, name: "client" }, geometry: { x: 1, y: 2 } },
    serverState: { attributes: { OBJECTID: row.objectId, name: "server" }, geometry: { x: 3, y: 4 } },
    geometryChanged: row.conflictType === "geometry",
    fieldChanges: [
      {
        field: "name",
        baseValue: "base",
        clientValue: "client",
        serverValue: "server",
        changedOnClient: true,
        changedOnServer: true,
      },
    ],
    resolutionAction:
      drift === "resolution-action" && row.resolutionAction !== null ? "teleport" : row.resolutionAction,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    resolvedServerGeneration: row.resolvedServerGeneration,
  };
}

/**
 * Every per-feature classification the server's `applyEdits` tests document,
 * in one HTTP-200 envelope: a success, the update `notFound` class, the
 * `deleteNotFound` (delete-delete) class, and the `invalidObjectId` request
 * error. The remaining published codes are exercised through the pure
 * classifier, which is the same code path.
 */
function applyEditsEnvelope(drift: GeoServicesReplicaDrift | undefined): unknown {
  return {
    success: false,
    addResults: [{ objectId: 900, success: true }],
    updateResults: [
      {
        objectId: 999_999,
        success: false,
        error: { code: drift === "unknown-edit-code" ? 1099 : 1002, description: "feature not found" },
      },
      { objectId: 12, success: false, error: { code: 1004, description: "row changed since read" } },
    ],
    deleteResults: [
      { objectId: 999_999, success: false, error: { code: 1003, description: "already deleted" } },
      { objectId: 0, success: false, error: { code: 1001, description: "object id was not numeric" } },
    ],
  };
}

function parseJson(body: string): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown, contentType?: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType ?? "application/json");
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
