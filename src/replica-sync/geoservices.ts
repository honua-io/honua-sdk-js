/**
 * GeoServices FeatureServer replica-sync transport.
 *
 * This is the real HTTP transport behind {@link ReplicaSyncTransport}: it speaks
 * the GeoServices FeatureServer REST dialect that honua-server implements for
 * disconnected replicas, plus the durable conflict review/resolution API that
 * ships beside it. It is the production counterpart to
 * `FixtureReplicaSyncTransport`, and it passes the same
 * `REPLICA_SYNC_TRANSPORT_CONFORMANCE_CASES` suite.
 *
 * ## Endpoint contract
 *
 * Two route families, deliberately distinct:
 *
 * | Transport call            | Server endpoint                                                              |
 * | ------------------------- | ---------------------------------------------------------------------------- |
 * | `capabilities`            | `GET  {rest}/services/{serviceId}/FeatureServer[/{layerId}]?f=json`            |
 * | `listReplicas`            | `GET  {admin}/services/{serviceId}/replicas`                                   |
 * | `getReplica`              | `GET  {admin}/services/{serviceId}/replicas/{replicaId}`                       |
 * | `listConflicts`           | `GET  {admin}/services/{serviceId}/replicas/{replicaId}/conflicts[?status=]`   |
 * | `getConflict`             | `GET  {admin}/services/{serviceId}/replicas/{replicaId}/conflicts/{conflictId}`|
 * | `resolveConflict`         | `POST {admin}/…/conflicts/{conflictId}/resolve`                                |
 * | `createReplica`           | `POST {rest}/services/{serviceId}/FeatureServer/createReplica`                 |
 * | `synchronizeReplica`      | `POST {rest}/services/{serviceId}/FeatureServer/synchronizeReplica`            |
 * | `unregisterReplica`       | `POST {rest}/services/{serviceId}/FeatureServer/unRegisterReplica`             |
 * | `applyEdits`              | `POST {rest}/services/{serviceId}/FeatureServer/{layerId}/applyEdits`          |
 *
 * ## Capability gating
 *
 * Nothing is attempted before the service advertises it. `capabilities()` reads
 * the FeatureServer metadata resource and refuses with
 * {@link HonuaCapabilityNotSupportedError} naming `Sync` when the service does
 * not advertise sync. The admin replica routes sit behind the server's
 * `sync.offline` experimental capability gate, which answers a disabled
 * deployment with HTTP 404 and an `application/problem+json` body whose `type`
 * is `honua:capability-experimental-disabled`. That 404 is recognized and
 * re-raised as `HonuaCapabilityNotSupportedError("sync.offline", …)` — a
 * disabled capability is never surfaced as a missing replica or as corruption.
 *
 * ## Fail closed on drift
 *
 * Every response member this transport reads is validated. An unknown conflict
 * classification, an unknown lifecycle status, an unknown per-feature edit error
 * code, a non-integer-safe generation cursor, or a missing required member
 * raises `HonuaReplicaSyncError("response-drift")` naming the member that
 * drifted. There is no fallback mapping and no partially-populated contract
 * object: the GA hardening tracked in honua-server#2430 may move this surface,
 * and a silent guess would be worse than a refusal.
 *
 * ## Credential discipline
 *
 * Authentication rides the caller's `HonuaClient` header plumbing (API key,
 * bearer token, or auth provider) and is never re-read here. No request URL, no
 * token, and no header value is copied into a conflict record, a replica record,
 * or an error `details` payload; every string this transport places in a durable
 * or reported position is screened with `screenPersistedString`.
 *
 * @experimental
 * @module
 */

import { screenPersistedString } from "../connect-url-safety.js";
import { HonuaCapabilityNotSupportedError, HonuaHttpError } from "../core/errors.js";
import { encodeServiceIdPath } from "../core/path-utils.js";
import type { HonuaRawRequest, QueryMethod } from "../core/types.js";
import { HonuaReplicaSyncError } from "./errors.js";
import type {
  BatchConflictResolutionResult,
  ConflictFeatureState,
  ConflictResolutionChoice,
  ConflictResolutionOption,
  DisconnectedReplica,
  FieldConflict,
  ListConflictsRequest,
  ListReplicasRequest,
  ReplicaId,
  ReplicaState,
  ReplicaSyncCapabilities,
  ReplicaSyncDirection,
  ReplicaSyncTransport,
  ServerGenerationCursor,
  SyncConflictDetail,
  SyncConflictId,
  SyncConflictOperation,
  SyncConflictResolution,
  SyncConflictResolutionRecord,
  SyncConflictStatus,
  SyncConflictSummary,
  SyncPage,
} from "./types.js";

/** The server capability descriptor that gates the disconnected-sync surface. */
export const GEOSERVICES_REPLICA_SYNC_CAPABILITY = "sync.offline" as const;

/** The FeatureServer capability token that advertises replica synchronization. */
export const GEOSERVICES_SYNC_CAPABILITY_TOKEN = "Sync" as const;

/** Protocol name reported on capability refusals raised by this transport. */
export const GEOSERVICES_REPLICA_SYNC_PROTOCOL = "geoservices" as const;

/**
 * `application/problem+json` `type` the server's capability gate returns when an
 * experimental capability is disabled. It arrives on an HTTP 404, which is why
 * the transport must inspect the body before concluding "not found".
 */
const EXPERIMENTAL_DISABLED_PROBLEM_TYPE = "honua:capability-experimental-disabled";

const DEFAULT_ADMIN_BASE_PATH = "/api/v1/admin";
const DEFAULT_REST_BASE_PATH = "/rest";

/**
 * The narrow slice of `HonuaClient` this transport drives. `HonuaClient`
 * satisfies it structurally, so the transport composes with the client's
 * existing auth, retry, timeout, and interceptor pipeline without importing the
 * client implementation or re-deriving credentials.
 *
 * `request` is the GeoServices path (it appends `f=json`); `pipelineRequestJson`
 * is the plain-JSON path used for the admin API, which does not model `f=`.
 */
export interface GeoServicesReplicaSyncHttpPort {
  request<T = unknown>(request: HonuaRawRequest): Promise<T>;
  pipelineRequestJson<T = unknown>(
    method: QueryMethod,
    path: string,
    init?: { headers?: HeadersInit; body?: BodyInit | null },
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface GeoServicesReplicaSyncTransportOptions {
  /** Drives every request. A `HonuaClient` satisfies this structurally. */
  readonly client: GeoServicesReplicaSyncHttpPort;
  /**
   * FeatureServer service id used when a request omits `datasetId`. A Honua
   * dataset id maps onto a GeoServices service id one-for-one.
   */
  readonly serviceId: string;
  /** Admin API base path. Defaults to `/api/v1/admin`. */
  readonly adminBasePath?: string;
  /** GeoServices REST base path. Defaults to `/rest`. */
  readonly restBasePath?: string;
  /**
   * Optional projection from a GeoServices `(serviceId, layerId)` pair onto a
   * Honua `SourceId`. GeoServices names a layer by its service-local integer id,
   * which is not a `SourceId`; rather than invent one, the transport omits
   * `sourceId` unless this hook supplies it.
   */
  readonly sourceIdForLayer?: (serviceId: string, layerId: number) => string | undefined;
}

/** Sync direction accepted by `synchronizeReplica`. */
export type GeoServicesSyncDirection = "upload" | "download" | "bidirectional";

export interface GeoServicesCreateReplicaRequest {
  readonly replicaName: string;
  /** Service-local layer ids. Serialized as the comma-joined `layers` form. */
  readonly layers: ReadonlyArray<number>;
  readonly syncModel?: "perReplica" | "perLayer";
  readonly datasetId?: string;
  readonly signal?: AbortSignal;
}

export interface GeoServicesCreateReplicaResult {
  readonly replicaId: ReplicaId;
  readonly replicaName?: string;
  readonly syncModel?: string;
  readonly serverGen: ServerGenerationCursor;
}

/** One layer's uploaded edits, matching the GeoServices sync `edits` element. */
export interface GeoServicesLayerEdits {
  readonly id: number;
  readonly adds?: ReadonlyArray<unknown>;
  readonly updates?: ReadonlyArray<unknown>;
  readonly deletes?: ReadonlyArray<number | string>;
}

export interface GeoServicesSynchronizeRequest {
  readonly replicaId: ReplicaId;
  readonly direction: GeoServicesSyncDirection;
  /** The replica's current cursor, echoed back so the server can compute a delta. */
  readonly replicaServerGen?: ServerGenerationCursor;
  readonly edits?: ReadonlyArray<GeoServicesLayerEdits>;
  readonly rollbackOnFailure?: boolean;
  readonly datasetId?: string;
  readonly signal?: AbortSignal;
}

/** A conflict reported inline by a synchronize upload. */
export interface GeoServicesSyncConflict {
  readonly layerId: number;
  readonly featureId: string;
  readonly classification: GeoServicesConflictClassification;
  /** True when the client edit was still committed under last-write-wins. */
  readonly applied: boolean;
  /** Present when a durable, reviewable record was written. */
  readonly conflictId?: SyncConflictId;
}

export interface GeoServicesSynchronizeResult {
  readonly replicaId: ReplicaId;
  readonly direction: GeoServicesSyncDirection;
  readonly serverGen: ServerGenerationCursor;
  readonly appliedAdds?: number;
  readonly appliedUpdates?: number;
  readonly appliedDeletes?: number;
  readonly conflicts: ReadonlyArray<GeoServicesSyncConflict>;
  /** Server-to-client delta, verbatim, for download and bidirectional syncs. */
  readonly edits?: ReadonlyArray<unknown>;
}

/**
 * Stable per-feature edit error codes the FeatureServer `applyEdits` HTTP-200
 * envelope carries (honua-server#2251). The Esri wire shape only has a numeric
 * `code` and a free-form `description`; these codes are the machine-readable
 * classification, and the transport keys on them rather than on the prose.
 */
export const GEOSERVICES_EDIT_ERROR_CODES = {
  genericFailure: 1000,
  invalidObjectId: 1001,
  notFound: 1002,
  deleteNotFound: 1003,
  updateConflict: 1004,
  featureLocked: 1005,
  validationFailed: 1006,
  notPermitted: 1007,
  operationRolledBack: 1008,
} as const;

/** The edit operation an `applyEdits` result belongs to. */
export type GeoServicesEditKind = "add" | "update" | "delete";

/**
 * How a per-feature `applyEdits` failure maps onto the offline replay
 * acknowledgement vocabulary (`src/offline/edit-replay.ts`).
 *
 * - `conflicted` — another writer won the race, or the row is gone. The caller
 *   holds a conflict, not a broken request.
 * - `retryable` — transient: a lock, a rolled-back sibling, or an unclassified
 *   provider failure. Resubmitting the same payload can succeed.
 * - `rejected` — the request itself is wrong (shape, validation, authorization).
 *   Resubmitting the same payload fails identically.
 */
export type GeoServicesEditOutcome = "applied" | "conflicted" | "retryable" | "rejected";

/** Conflict classes the server's durable records and sync responses name. */
export type GeoServicesConflictClassification =
  | "attribute"
  | "geometry"
  | "deleteUpdate"
  | "updateDelete"
  | "duplicateInsert"
  | "attachment"
  | "relationship";

export interface GeoServicesEditResultClassification {
  readonly outcome: GeoServicesEditOutcome;
  readonly kind: GeoServicesEditKind;
  readonly featureId?: string;
  /** The stable numeric code, absent for a successful result. */
  readonly code?: number;
  /** Symbolic name of the stable code, absent for a successful result. */
  readonly reason?: keyof typeof GEOSERVICES_EDIT_ERROR_CODES;
}

/**
 * Classification table for the stable per-feature codes. Every code the server
 * publishes is listed; anything absent is drift and is refused rather than
 * folded into the catch-all.
 */
const EDIT_CODE_OUTCOMES: Readonly<
  Record<number, { outcome: GeoServicesEditOutcome; reason: keyof typeof GEOSERVICES_EDIT_ERROR_CODES }>
> = {
  // Unclassified provider failure during the write — transient by construction.
  1000: { outcome: "retryable", reason: "genericFailure" },
  // Request-shape errors: the same payload fails identically on resubmission.
  1001: { outcome: "rejected", reason: "invalidObjectId" },
  // The "not-found" class: no row to update.
  1002: { outcome: "conflicted", reason: "notFound" },
  // The "delete-delete" class: concurrent or repeated delete.
  1003: { outcome: "conflicted", reason: "deleteNotFound" },
  // The "update-update" class: optimistic-concurrency race.
  1004: { outcome: "conflicted", reason: "updateConflict" },
  // The "lock/locked" class: another editor holds the feature.
  1005: { outcome: "retryable", reason: "featureLocked" },
  1006: { outcome: "rejected", reason: "validationFailed" },
  1007: { outcome: "rejected", reason: "notPermitted" },
  // A sibling operation failed under rollbackOnFailure; the batch can be retried.
  1008: { outcome: "retryable", reason: "operationRolledBack" },
};

/** Per-side feature operation implied by each conflict classification. */
const CLASSIFICATION_OPERATIONS: Readonly<
  Record<
    GeoServicesConflictClassification,
    { client: SyncConflictOperation; server: SyncConflictOperation; geometry: boolean }
  >
> = {
  attribute: { client: "update", server: "update", geometry: false },
  geometry: { client: "update", server: "update", geometry: true },
  deleteUpdate: { client: "delete", server: "update", geometry: false },
  updateDelete: { client: "update", server: "delete", geometry: false },
  duplicateInsert: { client: "create", server: "create", geometry: false },
  // An attachment or related-record conflict is a feature-level update on both
  // sides; the exact sub-kind is preserved verbatim in `metadata.geoServices`.
  attachment: { client: "update", server: "update", geometry: false },
  relationship: { client: "update", server: "update", geometry: false },
};

/** Ordinal encoding used by the inline `synchronizeReplica` conflict summaries. */
const CLASSIFICATION_ORDINALS: ReadonlyArray<GeoServicesConflictClassification> = [
  "attribute",
  "geometry",
  "deleteUpdate",
  "updateDelete",
  "duplicateInsert",
  "attachment",
  "relationship",
];

/** Server lifecycle status → SDK status. `deferred` is still an open conflict. */
const CONFLICT_STATUSES: Readonly<Record<string, SyncConflictStatus>> = {
  pending: "pending",
  resolved: "resolved",
  deferred: "pending",
};

/** Server resolution action → SDK choice. `defer` closes nothing, so it has none. */
const RESOLUTION_ACTION_CHOICES: Readonly<Record<string, ConflictResolutionChoice | undefined>> = {
  acceptClient: "accept-client",
  keepServer: "accept-server",
  mergeFields: "merge",
  chooseGeometry: "merge",
  rejectClient: "discard",
  defer: undefined,
};

/** SDK choice → server action. `merge` has no lossless encoding; see below. */
const CHOICE_ACTIONS: Readonly<Record<ConflictResolutionChoice, string | undefined>> = {
  "accept-client": "acceptClient",
  "accept-server": "keepServer",
  discard: "rejectClient",
  merge: undefined,
};

const REPLICA_STATES: Readonly<Record<string, ReplicaState>> = {
  active: "active",
  expired: "expired",
};

export function createGeoServicesReplicaSyncTransport(
  options: GeoServicesReplicaSyncTransportOptions,
): GeoServicesReplicaSyncTransport {
  return new GeoServicesReplicaSyncTransport(options);
}

export class GeoServicesReplicaSyncTransport implements ReplicaSyncTransport {
  readonly #client: GeoServicesReplicaSyncHttpPort;
  readonly #serviceId: string;
  readonly #adminBasePath: string;
  readonly #restBasePath: string;
  readonly #sourceIdForLayer: ((serviceId: string, layerId: number) => string | undefined) | undefined;
  /** conflictId → owning (serviceId, replicaId), learned from listings. */
  readonly #conflictRoutes = new Map<SyncConflictId, { serviceId: string; replicaId: ReplicaId }>();

  public constructor(options: GeoServicesReplicaSyncTransportOptions) {
    this.#client = options.client;
    this.#serviceId = requireNonEmpty(options.serviceId, "options.serviceId");
    this.#adminBasePath = trimTrailingSlash(options.adminBasePath ?? DEFAULT_ADMIN_BASE_PATH);
    this.#restBasePath = trimTrailingSlash(options.restBasePath ?? DEFAULT_REST_BASE_PATH);
    this.#sourceIdForLayer = options.sourceIdForLayer;
  }

  // ── Capability discovery ───────────────────────────────────────────────────

  /**
   * Read the FeatureServer metadata resource and project its advertised sync
   * surface onto {@link ReplicaSyncCapabilities}.
   *
   * `conflictReview` / `conflictResolution` are observed, not assumed: the
   * durable review route is probed against the first registered replica. When
   * the service has no replica yet the provider's answer is unobservable, and
   * the flags report the admin surface's reachability — `listConflicts` and
   * `getConflict` still fail closed with `unsupported-conflict-review` if the
   * provider denies review.
   */
  public async capabilities(datasetId: string, sourceId?: string): Promise<ReplicaSyncCapabilities> {
    const serviceId = requireNonEmpty(datasetId, "datasetId");
    const layerSuffix = layerPathSuffix(sourceId);
    const metadata = await this.#geoServices<Record<string, unknown>>({
      path: `${this.#restBasePath}/services/${encodeServiceIdPath(serviceId)}/FeatureServer${layerSuffix}`,
    });

    if (!isRecord(metadata)) {
      throw drift("FeatureServer", "the metadata resource was not a JSON object");
    }
    if (!advertisesSync(metadata)) {
      throw new HonuaCapabilityNotSupportedError(
        GEOSERVICES_SYNC_CAPABILITY_TOKEN,
        GEOSERVICES_REPLICA_SYNC_PROTOCOL,
        serviceId,
      );
    }

    const directions = syncDirections(metadata.syncCapabilities);
    const review = await this.#probeConflictReview(serviceId);

    return {
      sync: true,
      createReplica: true,
      synchronizeReplica: true,
      conflictReview: review,
      conflictResolution: review,
      // The upload pipeline commits the client edit and records a reviewable
      // conflict; that is last-writer-wins, plus manual review when the
      // provider retains durable records.
      conflictPolicies: review ? ["last-writer-wins", "manual"] : ["last-writer-wins"],
      directions,
    };
  }

  // ── Replica listing ────────────────────────────────────────────────────────

  public async listReplicas(request: ListReplicasRequest = {}): Promise<SyncPage<DisconnectedReplica>> {
    if (request.ownerId !== undefined) {
      // The replica registry records no owner; filtering on one would silently
      // return the wrong set either way.
      throw new HonuaCapabilityNotSupportedError(
        "replica-sync.listReplicas.ownerId",
        GEOSERVICES_REPLICA_SYNC_PROTOCOL,
        request.datasetId ?? this.#serviceId,
      );
    }

    const serviceId = request.datasetId ?? this.#serviceId;
    const summaries = await this.#listReplicaSummaries(serviceId, request.signal);

    const matched = summaries.filter((summary) => {
      if (request.states !== undefined && !request.states.includes(summary.state)) return false;
      return true;
    });

    const page = paginate(matched, request.limit, request.cursor);
    // Hydrate only the requested page: the listing carries no generation cursor
    // and no conflict count, both of which the contract requires.
    const items: DisconnectedReplica[] = [];
    for (const summary of page.items) {
      items.push(await this.#hydrateReplica(serviceId, summary, request.signal));
    }

    // `sourceId` filtering happens after hydration because the projection is the
    // only place a layer id becomes a SourceId.
    const filtered =
      request.sourceId === undefined ? items : items.filter((replica) => replica.sourceId === request.sourceId);

    return {
      items: filtered,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      totalCount: matched.length,
    };
  }

  public async getReplica(
    replicaId: ReplicaId,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<DisconnectedReplica> {
    const serviceId = this.#serviceId;
    const summary = await this.#getReplicaSummary(serviceId, replicaId, options.signal);
    return this.#hydrateReplica(serviceId, summary, options.signal, summary);
  }

  // ── Conflict review ────────────────────────────────────────────────────────

  public async listConflicts(request: ListConflictsRequest = {}): Promise<SyncPage<SyncConflictSummary>> {
    const serviceId = request.datasetId ?? this.#serviceId;
    const replicaIds =
      request.replicaId === undefined
        ? (await this.#listReplicaSummaries(serviceId, request.signal)).map((summary) => summary.replicaId)
        : [request.replicaId];

    if (request.replicaId !== undefined) {
      // Surface an unknown replica as `replica-not-found` rather than an empty
      // conflict page, which would read as "this replica is clean".
      await this.#getReplicaSummary(serviceId, request.replicaId, request.signal);
    }

    const statusFilter = singleServerStatus(request.statuses);
    const collected: SyncConflictSummary[] = [];
    for (const replicaId of replicaIds) {
      const conflicts = await this.#listReplicaConflicts(serviceId, replicaId, statusFilter, request.signal);
      for (const conflict of conflicts) collected.push(conflict);
    }

    const matched = collected.filter((conflict) => {
      if (request.statuses !== undefined && !request.statuses.includes(conflict.status)) return false;
      if (request.kinds !== undefined && !request.kinds.includes(conflict.kind)) return false;
      return true;
    });

    return paginate(matched, request.limit, request.cursor);
  }

  public async getConflict(
    conflictId: SyncConflictId,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SyncConflictDetail> {
    const route = await this.#resolveConflictRoute(conflictId, options.signal);
    const detail = await this.#adminJson<unknown>(
      "GET",
      `${this.#conflictPath(route.serviceId, route.replicaId, conflictId)}`,
      undefined,
      options.signal,
      { conflictId },
    );
    return this.#projectConflictDetail(route.serviceId, route.replicaId, unwrapApiData(detail, "conflict"));
  }

  public async resolveConflict(resolution: SyncConflictResolution): Promise<SyncConflictResolutionRecord> {
    const action = CHOICE_ACTIONS[resolution.choice];
    if (action === undefined) {
      // The resolve endpoint's request body carries a single `action` member and
      // no merge payload, so an operator-authored merge cannot be transmitted.
      // Sending `mergeFields` would commit the server's merge, not the caller's.
      throw new HonuaReplicaSyncError(
        "unsupported-conflict-resolution",
        'The GeoServices conflict-resolution endpoint accepts only an "action" and cannot carry mergedAttributes or mergedGeometry, so a "merge" resolution cannot be submitted through this transport.',
        { details: { conflictId: screened(resolution.conflictId, "conflictId"), choice: resolution.choice } },
      );
    }

    const route = await this.#resolveConflictRoute(resolution.conflictId);
    const body = await this.#adminJson<unknown>(
      "POST",
      `${this.#conflictPath(route.serviceId, route.replicaId, resolution.conflictId)}/resolve`,
      { action },
      undefined,
      { conflictId: resolution.conflictId },
    );

    const payload = unwrapApiData(body, "resolution");
    if (!isRecord(payload)) throw drift("resolution", "the resolution response carried no object payload");
    if (typeof payload.committedNewServerState !== "boolean") {
      throw drift("resolution.committedNewServerState", "expected a boolean");
    }
    const conflict = payload.conflict;
    if (!isRecord(conflict)) throw drift("resolution.conflict", "expected the resolved conflict object");

    const detail = this.#projectConflictDetail(route.serviceId, route.replicaId, conflict);
    const record = detail.resolution;
    if (record === undefined) {
      throw drift(
        "resolution.conflict.resolutionAction",
        "the server acknowledged the resolution but returned no resolution evidence",
      );
    }
    return {
      ...record,
      // The caller's choice is authoritative for the record it gets back; the
      // server's action is preserved on the detail's metadata.
      choice: resolution.choice,
      status: resolution.choice === "discard" ? "discarded" : "resolved",
      ...(resolution.note === undefined ? {} : { note: resolution.note }),
      ...(resolution.resolvedBy === undefined ? {} : { resolvedBy: resolution.resolvedBy }),
    };
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

  // ── Replica lifecycle and delta exchange ───────────────────────────────────

  /** Register a disconnected replica (`createReplica`). */
  public async createReplica(request: GeoServicesCreateReplicaRequest): Promise<GeoServicesCreateReplicaResult> {
    const serviceId = request.datasetId ?? this.#serviceId;
    const body = await this.#geoServices<unknown>({
      method: "POST",
      path: `${this.#restBasePath}/services/${encodeServiceIdPath(serviceId)}/FeatureServer/createReplica`,
      body: {
        replicaName: requireNonEmpty(request.replicaName, "replicaName"),
        layers: request.layers.join(","),
        syncModel: request.syncModel ?? "perReplica",
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (!isRecord(body)) throw drift("createReplica", "expected a JSON object response");
    const replicaId = readString(body, "replicaID", "createReplica.replicaID");
    return {
      replicaId,
      ...(typeof body.replicaName === "string" ? { replicaName: body.replicaName } : {}),
      ...(typeof body.syncModel === "string" ? { syncModel: body.syncModel } : {}),
      serverGen: readCursor(body, "serverGen", "createReplica.serverGen"),
    };
  }

  /** Exchange a delta with the server (`synchronizeReplica`). */
  public async synchronizeReplica(request: GeoServicesSynchronizeRequest): Promise<GeoServicesSynchronizeResult> {
    const serviceId = request.datasetId ?? this.#serviceId;
    const payload: Record<string, unknown> = {
      replicaID: requireNonEmpty(request.replicaId, "replicaId"),
      syncDirection: request.direction,
    };
    if (request.replicaServerGen !== undefined) {
      payload.replicaServerGen = requireIntegerCursor(request.replicaServerGen, "replicaServerGen");
    }
    if (request.edits !== undefined) {
      // The sync `edits` parameter is a JSON *string* holding the per-layer array.
      payload.edits = JSON.stringify(request.edits);
    }
    if (request.rollbackOnFailure !== undefined) payload.rollbackOnFailure = request.rollbackOnFailure;

    const body = await this.#geoServices<unknown>({
      method: "POST",
      path: `${this.#restBasePath}/services/${encodeServiceIdPath(serviceId)}/FeatureServer/synchronizeReplica`,
      body: payload,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (!isRecord(body)) throw drift("synchronizeReplica", "expected a JSON object response");
    if (body.success !== true) {
      throw drift("synchronizeReplica.success", "the server did not report a successful synchronization");
    }
    const direction = readString(body, "syncDirection", "synchronizeReplica.syncDirection");
    if (direction !== "upload" && direction !== "download" && direction !== "bidirectional") {
      throw drift("synchronizeReplica.syncDirection", "unknown sync direction", direction);
    }

    return {
      replicaId: readString(body, "replicaID", "synchronizeReplica.replicaID"),
      direction,
      serverGen: readCursor(body, "serverGen", "synchronizeReplica.serverGen"),
      ...optionalCount(body.appliedAdds, "appliedAdds", "synchronizeReplica.appliedAdds"),
      ...optionalCount(body.appliedUpdates, "appliedUpdates", "synchronizeReplica.appliedUpdates"),
      ...optionalCount(body.appliedDeletes, "appliedDeletes", "synchronizeReplica.appliedDeletes"),
      conflicts: this.#projectSyncConflicts(body.conflicts),
      ...(Array.isArray(body.edits) ? { edits: body.edits as ReadonlyArray<unknown> } : {}),
    };
  }

  /** Release a replica's server-side registration (`unRegisterReplica`). */
  public async unregisterReplica(
    replicaId: ReplicaId,
    options: { readonly datasetId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const serviceId = options.datasetId ?? this.#serviceId;
    const body = await this.#geoServices<unknown>({
      method: "POST",
      path: `${this.#restBasePath}/services/${encodeServiceIdPath(serviceId)}/FeatureServer/unRegisterReplica`,
      body: { replicaID: requireNonEmpty(replicaId, "replicaId") },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!isRecord(body) || body.success !== true) {
      throw drift("unRegisterReplica.success", "the server did not acknowledge the unregistration");
    }
  }

  /**
   * Apply edits directly to a layer and classify every per-feature result.
   *
   * `applyEdits` answers HTTP 200 even when individual features fail; the
   * per-feature `error.code` is the stable classification. Each result is
   * projected onto the offline replay acknowledgement vocabulary so a caller can
   * branch on conflict versus retry versus reject without parsing prose.
   */
  public async applyEdits(request: {
    readonly layerId: number;
    readonly adds?: ReadonlyArray<unknown>;
    readonly updates?: ReadonlyArray<unknown>;
    readonly deletes?: ReadonlyArray<number | string>;
    readonly rollbackOnFailure?: boolean;
    readonly datasetId?: string;
    readonly signal?: AbortSignal;
  }): Promise<ReadonlyArray<GeoServicesEditResultClassification>> {
    const serviceId = request.datasetId ?? this.#serviceId;
    const payload: Record<string, unknown> = {};
    if (request.adds !== undefined) payload.adds = request.adds;
    if (request.updates !== undefined) payload.updates = request.updates;
    if (request.deletes !== undefined) payload.deletes = request.deletes;
    if (request.rollbackOnFailure !== undefined) payload.rollbackOnFailure = request.rollbackOnFailure;

    const body = await this.#geoServices<unknown>({
      method: "POST",
      path: `${this.#restBasePath}/services/${encodeServiceIdPath(serviceId)}/FeatureServer/${request.layerId}/applyEdits`,
      body: payload,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (!isRecord(body)) throw drift("applyEdits", "expected a JSON object response");
    return [
      ...classifyEditResults(body.addResults, "add"),
      ...classifyEditResults(body.updateResults, "update"),
      ...classifyEditResults(body.deleteResults, "delete"),
    ];
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #conflictPath(serviceId: string, replicaId: ReplicaId, conflictId: SyncConflictId): string {
    return `${this.#replicaPath(serviceId, replicaId)}/conflicts/${encodePathSegment(conflictId)}`;
  }

  #replicaPath(serviceId: string, replicaId: ReplicaId): string {
    return `${this.#adminBasePath}/services/${encodeServiceIdPath(serviceId)}/replicas/${encodePathSegment(replicaId)}`;
  }

  async #probeConflictReview(serviceId: string): Promise<boolean> {
    const summaries = await this.#listReplicaSummaries(serviceId);
    const probe = summaries[0];
    // Without a replica the provider's answer is unobservable; the admin surface
    // answered, which is the only fact available.
    if (probe === undefined) return true;
    try {
      await this.#listReplicaConflicts(serviceId, probe.replicaId, "pending");
      return true;
    } catch (error) {
      if (error instanceof HonuaReplicaSyncError && error.code === "unsupported-conflict-review") return false;
      throw error;
    }
  }

  async #listReplicaSummaries(serviceId: string, signal?: AbortSignal): Promise<ReadonlyArray<ReplicaSummaryRow>> {
    const body = await this.#adminJson<unknown>(
      "GET",
      `${this.#adminBasePath}/services/${encodeServiceIdPath(serviceId)}/replicas`,
      undefined,
      signal,
      {},
    );
    const payload = unwrapApiData(body, "replicas");
    if (!isRecord(payload)) throw drift("replicas", "the replica listing carried no object payload");
    const replicas = payload.replicas;
    if (!Array.isArray(replicas)) throw drift("replicas.replicas", "expected an array");
    return replicas.map((entry, index) => readReplicaSummary(entry, `replicas.replicas[${index}]`));
  }

  async #getReplicaSummary(serviceId: string, replicaId: ReplicaId, signal?: AbortSignal): Promise<ReplicaDetailRow> {
    const body = await this.#adminJson<unknown>("GET", this.#replicaPath(serviceId, replicaId), undefined, signal, {
      replicaId,
    });
    const payload = unwrapApiData(body, "replica");
    return readReplicaDetail(payload, "replica");
  }

  async #hydrateReplica(
    serviceId: string,
    summary: ReplicaSummaryRow,
    signal?: AbortSignal,
    known?: ReplicaDetailRow,
  ): Promise<DisconnectedReplica> {
    const detail = known ?? (await this.#getReplicaSummary(serviceId, summary.replicaId, signal));
    const openConflicts = await this.#countOpenConflicts(serviceId, summary.replicaId, signal);
    const sourceId = this.#sourceId(serviceId, detail.layerIds);

    return {
      id: detail.replicaId,
      ...(detail.replicaName === undefined ? {} : { name: detail.replicaName }),
      datasetId: serviceId,
      ...(sourceId === undefined ? {} : { sourceId }),
      state: detail.state,
      // GeoServices chooses the sync direction per `synchronizeReplica` call, not
      // per replica; a registered replica supports the full surface.
      direction: "bidirectional",
      // The upload pipeline commits the client edit and records a reviewable
      // conflict — last-writer-wins with durable review.
      conflictPolicy: "last-writer-wins",
      createdAt: detail.createdAt,
      status: {
        serverGen: detail.lastSyncGeneration,
        ...(detail.lastSyncTime === undefined ? {} : { lastSyncedAt: detail.lastSyncTime }),
        // Replica synchronization runs inline (`supportsAsync: false`), so no
        // registered replica is ever mid-sync from the server's perspective.
        inProgress: false,
        openConflicts,
      },
      metadata: { geoServices: { syncModel: detail.syncModel, layerIds: detail.layerIds, status: detail.rawStatus } },
    };
  }

  async #countOpenConflicts(serviceId: string, replicaId: ReplicaId, signal?: AbortSignal): Promise<number> {
    try {
      const conflicts = await this.#listReplicaConflicts(serviceId, replicaId, "pending", signal);
      return conflicts.length;
    } catch (error) {
      // A provider that retains no durable records has no reviewable conflict —
      // zero is the observed count, not a fabricated one.
      if (error instanceof HonuaReplicaSyncError && error.code === "unsupported-conflict-review") return 0;
      throw error;
    }
  }

  async #listReplicaConflicts(
    serviceId: string,
    replicaId: ReplicaId,
    statusFilter?: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<SyncConflictSummary>> {
    const query = statusFilter === undefined ? "" : `?status=${encodeURIComponent(statusFilter)}`;
    const body = await this.#adminJson<unknown>(
      "GET",
      `${this.#replicaPath(serviceId, replicaId)}/conflicts${query}`,
      undefined,
      signal,
      { replicaId },
    );
    const payload = unwrapApiData(body, "conflicts");
    if (!isRecord(payload)) throw drift("conflicts", "the conflict listing carried no object payload");
    const rows = payload.conflicts;
    if (!Array.isArray(rows)) throw drift("conflicts.conflicts", "expected an array");

    return rows.map((entry, index) => {
      const summary = this.#projectConflictSummary(serviceId, replicaId, entry, `conflicts.conflicts[${index}]`);
      this.#conflictRoutes.set(summary.id, { serviceId, replicaId });
      return summary;
    });
  }

  async #resolveConflictRoute(
    conflictId: SyncConflictId,
    signal?: AbortSignal,
  ): Promise<{ serviceId: string; replicaId: ReplicaId }> {
    const known = this.#conflictRoutes.get(conflictId);
    if (known !== undefined) return known;

    // A conflict is addressed by (service, replica, conflict); the id alone is
    // not routable. Learn the binding from the listings rather than probing.
    const serviceId = this.#serviceId;
    const summaries = await this.#listReplicaSummaries(serviceId, signal);
    for (const summary of summaries) {
      await this.#listReplicaConflicts(serviceId, summary.replicaId, undefined, signal);
      const found = this.#conflictRoutes.get(conflictId);
      if (found !== undefined) return found;
    }
    throw new HonuaReplicaSyncError(
      "conflict-not-found",
      `Sync conflict "${screened(conflictId, "conflictId")}" was not found.`,
    );
  }

  #sourceId(serviceId: string, layerIds: ReadonlyArray<number>): string | undefined {
    if (this.#sourceIdForLayer === undefined) return undefined;
    // A multi-layer replica has no single source; the contract's `sourceId` is
    // singular, so it stays absent rather than naming an arbitrary layer.
    const only = layerIds.length === 1 ? layerIds[0] : undefined;
    return only === undefined ? undefined : this.#sourceIdForLayer(serviceId, only);
  }

  #projectSyncConflicts(value: unknown): ReadonlyArray<GeoServicesSyncConflict> {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw drift("synchronizeReplica.conflicts", "expected an array");
    return value.map((entry, index) => {
      const path = `synchronizeReplica.conflicts[${index}]`;
      if (!isRecord(entry)) throw drift(path, "expected an object");
      const ordinal = entry.conflictType;
      if (typeof ordinal !== "number" || !Number.isInteger(ordinal)) {
        throw drift(`${path}.conflictType`, "expected an integer classification ordinal", ordinal);
      }
      const classification = CLASSIFICATION_ORDINALS[ordinal];
      if (classification === undefined) {
        throw drift(`${path}.conflictType`, "unknown conflict classification ordinal", ordinal);
      }
      if (typeof entry.applied !== "boolean") throw drift(`${path}.applied`, "expected a boolean");
      return {
        layerId: readInteger(entry, "layerId", `${path}.layerId`),
        featureId: String(readInteger(entry, "objectId", `${path}.objectId`)),
        classification,
        applied: entry.applied,
        ...(typeof entry.conflictId === "string" && entry.conflictId.length > 0
          ? { conflictId: entry.conflictId }
          : {}),
      };
    });
  }

  #projectConflictSummary(serviceId: string, replicaId: ReplicaId, entry: unknown, path: string): SyncConflictSummary {
    if (!isRecord(entry)) throw drift(path, "expected an object");
    const classification = readClassification(entry, `${path}.conflictType`);
    const operations = CLASSIFICATION_OPERATIONS[classification];
    const layerId = readInteger(entry, "layerId", `${path}.layerId`);
    const sourceId = this.#sourceId(serviceId, [layerId]);

    return {
      id: readString(entry, "conflictId", `${path}.conflictId`),
      replicaId,
      datasetId: serviceId,
      ...(sourceId === undefined ? {} : { sourceId }),
      layerId,
      featureId: String(readInteger(entry, "objectId", `${path}.objectId`)),
      // The durable records this API serves are all disconnected-replica sync
      // conflicts; named-version reconcile conflicts live on another surface.
      kind: "replica-sync",
      status: readStatus(entry, `${path}.status`),
      clientOperation: operations.client,
      serverOperation: operations.server,
      detectedAt: readTimestamp(entry, "detectedAt", `${path}.detectedAt`),
      fieldConflictCount: 0,
      hasGeometryConflict: classification === "geometry",
    };
  }

  #projectConflictDetail(serviceId: string, replicaId: ReplicaId, entry: unknown): SyncConflictDetail {
    const path = "conflict";
    if (!isRecord(entry)) throw drift(path, "expected an object");
    const classification = readClassification(entry, `${path}.conflictType`);
    const operations = CLASSIFICATION_OPERATIONS[classification];
    const summary = this.#projectConflictSummary(serviceId, replicaId, entry, path);

    const fieldConflicts = readFieldConflicts(entry.fieldChanges, `${path}.fieldChanges`);
    const geometryChanged = readOptionalBoolean(entry.geometryChanged, `${path}.geometryChanged`);
    const client = readActor(entry.userId);
    const device = readDevice(entry.deviceId);
    const resolution = readResolutionRecord(entry, summary.id, path);
    const rawStatus = readString(entry, "status", `${path}.status`);

    this.#conflictRoutes.set(summary.id, { serviceId, replicaId });

    return {
      ...summary,
      ...(client === undefined ? {} : { client }),
      ...(device === undefined ? {} : { device }),
      fieldConflictCount: fieldConflicts.length,
      hasGeometryConflict: geometryChanged === true || classification === "geometry",
      serverGen: readCursor(entry, "serverGeneration", `${path}.serverGeneration`),
      base: readFeatureState(entry.baseState, operations.client, `${path}.baseState`),
      clientState: readFeatureState(entry.clientState, operations.client, `${path}.clientState`),
      serverState: readFeatureState(entry.serverState, operations.server, `${path}.serverState`),
      fieldConflicts,
      ...(geometryChanged === true || classification === "geometry"
        ? {
            geometryConflict: {
              changed: true,
              clientChanged: true,
              serverChanged: true,
              note: "The server records a single client-versus-server geometry divergence; it does not attribute the change to one side independently.",
            },
          }
        : {}),
      resolutionOptions: resolutionOptions(),
      ...(resolution === undefined ? {} : { resolution }),
      metadata: {
        geoServices: {
          conflictType: classification,
          status: rawStatus,
          ...(typeof entry.syncOperationId === "string" ? { syncOperationId: entry.syncOperationId } : {}),
          ...(typeof entry.resolutionAction === "string" ? { resolutionAction: entry.resolutionAction } : {}),
        },
      },
    };
  }

  async #geoServices<T>(request: {
    path: string;
    method?: QueryMethod;
    body?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<T> {
    const raw: HonuaRawRequest = {
      path: request.path,
      method: request.method ?? "GET",
      ...(request.body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...request.body, f: "json" }),
          }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    try {
      return await this.#client.request<T>(raw);
    } catch (error) {
      throw this.#translate(error, {});
    }
  }

  async #adminJson<T>(
    method: QueryMethod,
    path: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    context: { readonly replicaId?: ReplicaId; readonly conflictId?: SyncConflictId },
  ): Promise<T> {
    try {
      return await this.#client.pipelineRequestJson<T>(
        method,
        path,
        body === undefined
          ? undefined
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        signal,
      );
    } catch (error) {
      throw this.#translate(error, context);
    }
  }

  /**
   * Map a transport-level failure onto the replica-sync error vocabulary.
   *
   * The capability gate answers a disabled deployment with HTTP 404 carrying an
   * `application/problem+json` body, so a 404 is only "not found" once its body
   * has been ruled out as a capability refusal.
   */
  #translate(
    error: unknown,
    context: { readonly replicaId?: ReplicaId; readonly conflictId?: SyncConflictId },
  ): unknown {
    if (!(error instanceof HonuaHttpError)) return error;

    if (isExperimentalDisabledProblem(error.body)) {
      return new HonuaCapabilityNotSupportedError(
        GEOSERVICES_REPLICA_SYNC_CAPABILITY,
        GEOSERVICES_REPLICA_SYNC_PROTOCOL,
        this.#serviceId,
        { cause: error },
      );
    }

    switch (error.statusCode) {
      case 404:
        if (context.conflictId !== undefined) {
          return new HonuaReplicaSyncError(
            "conflict-not-found",
            `Sync conflict "${screened(context.conflictId, "conflictId")}" was not found.`,
            { cause: error },
          );
        }
        if (context.replicaId !== undefined) {
          return new HonuaReplicaSyncError(
            "replica-not-found",
            `Replica "${screened(context.replicaId, "replicaId")}" was not found.`,
            { cause: error },
          );
        }
        return new HonuaReplicaSyncError("replica-not-found", "The requested replica resource was not found.", {
          cause: error,
        });
      case 409:
        return new HonuaReplicaSyncError(
          "conflict-already-resolved",
          `Sync conflict "${screened(context.conflictId ?? "", "conflictId")}" is already resolved.`,
          { cause: error },
        );
      case 501:
        return new HonuaReplicaSyncError(
          "unsupported-conflict-review",
          "Manual conflict review is not available: the deployment's feature provider retains no durable conflict records.",
          { cause: error },
        );
      case 401:
      case 403:
        return new HonuaReplicaSyncError("permission-denied", "The replica-sync request was not authorized.", {
          cause: error,
        });
      default:
        return new HonuaReplicaSyncError("transport-failure", "The replica-sync request failed.", { cause: error });
    }
  }
}

// ── Pure projections (exported for direct testing) ───────────────────────────

/**
 * Classify one per-feature `applyEdits` result. A code outside the published
 * table is drift and is refused; it is never folded into the generic class,
 * because a future code could mean the opposite of "retry".
 */
export function classifyGeoServicesEditResult(
  result: unknown,
  kind: GeoServicesEditKind,
  path = "editResult",
): GeoServicesEditResultClassification {
  if (!isRecord(result)) throw drift(path, "expected an object");
  const featureId =
    typeof result.objectId === "number" && Number.isSafeInteger(result.objectId)
      ? String(result.objectId)
      : typeof result.globalId === "string" && result.globalId.length > 0
        ? result.globalId
        : undefined;

  if (result.success === true) {
    return { outcome: "applied", kind, ...(featureId === undefined ? {} : { featureId }) };
  }
  if (result.success !== false) throw drift(`${path}.success`, "expected a boolean");

  const error = result.error;
  if (!isRecord(error)) throw drift(`${path}.error`, "a failed edit result carried no error object");
  const code = error.code;
  if (typeof code !== "number" || !Number.isInteger(code)) {
    throw drift(`${path}.error.code`, "expected an integer classification code", code);
  }
  const mapped = EDIT_CODE_OUTCOMES[code];
  if (mapped === undefined) {
    throw drift(
      `${path}.error.code`,
      "unknown per-feature edit classification code; refusing to guess whether it is retryable",
      code,
    );
  }
  return {
    outcome: mapped.outcome,
    kind,
    ...(featureId === undefined ? {} : { featureId }),
    code,
    reason: mapped.reason,
  };
}

function classifyEditResults(value: unknown, kind: GeoServicesEditKind): GeoServicesEditResultClassification[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw drift(`applyEdits.${kind}Results`, "expected an array");
  return value.map((entry, index) => classifyGeoServicesEditResult(entry, kind, `applyEdits.${kind}Results[${index}]`));
}

// ── Response readers ─────────────────────────────────────────────────────────

interface ReplicaSummaryRow {
  readonly replicaId: ReplicaId;
  readonly state: ReplicaState;
}

interface ReplicaDetailRow extends ReplicaSummaryRow {
  readonly replicaName: string | undefined;
  readonly syncModel: string;
  readonly layerIds: ReadonlyArray<number>;
  readonly createdAt: string;
  readonly lastSyncTime: string | undefined;
  readonly lastSyncGeneration: ServerGenerationCursor;
  readonly rawStatus: string;
}

function readReplicaSummary(entry: unknown, path: string): ReplicaSummaryRow {
  if (!isRecord(entry)) throw drift(path, "expected an object");
  return {
    replicaId: readString(entry, "replicaId", `${path}.replicaId`),
    state: readReplicaState(entry, `${path}.status`),
  };
}

function readReplicaDetail(entry: unknown, path: string): ReplicaDetailRow {
  if (!isRecord(entry)) throw drift(path, "expected an object");
  const layerIds = entry.layerIds;
  if (!Array.isArray(layerIds)) throw drift(`${path}.layerIds`, "expected an array");
  return {
    ...readReplicaSummary(entry, path),
    replicaName: typeof entry.replicaName === "string" ? entry.replicaName : undefined,
    syncModel: readString(entry, "syncModel", `${path}.syncModel`),
    layerIds: layerIds.map((value, index) => {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw drift(`${path}.layerIds[${index}]`, "expected an integer layer id", value);
      }
      return value;
    }),
    createdAt: readTimestamp(entry, "createdAt", `${path}.createdAt`),
    lastSyncTime:
      typeof entry.lastSyncTime === "string" ? readTimestamp(entry, "lastSyncTime", `${path}.lastSyncTime`) : undefined,
    lastSyncGeneration: readCursor(entry, "lastSyncGeneration", `${path}.lastSyncGeneration`),
    rawStatus: readString(entry, "status", `${path}.status`),
  };
}

function readReplicaState(entry: Record<string, unknown>, path: string): ReplicaState {
  const raw = entry.status;
  if (typeof raw !== "string") throw drift(path, "expected a status string");
  const state = REPLICA_STATES[raw];
  if (state === undefined) throw drift(path, "unknown replica status", raw);
  return state;
}

function readClassification(entry: Record<string, unknown>, path: string): GeoServicesConflictClassification {
  const raw = entry.conflictType;
  if (typeof raw !== "string") throw drift(path, "expected a classification string");
  if (!Object.hasOwn(CLASSIFICATION_OPERATIONS, raw)) {
    throw drift(path, "unknown conflict classification", raw);
  }
  return raw as GeoServicesConflictClassification;
}

function readStatus(entry: Record<string, unknown>, path: string): SyncConflictStatus {
  const raw = entry.status;
  if (typeof raw !== "string") throw drift(path, "expected a status string");
  const status = CONFLICT_STATUSES[raw];
  if (status === undefined) throw drift(path, "unknown conflict lifecycle status", raw);
  return status;
}

function readFieldConflicts(value: unknown, path: string): ReadonlyArray<FieldConflict> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw drift(path, "expected an array");
  return value.map((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) throw drift(at, "expected an object");
    if (typeof entry.changedOnClient !== "boolean") throw drift(`${at}.changedOnClient`, "expected a boolean");
    if (typeof entry.changedOnServer !== "boolean") throw drift(`${at}.changedOnServer`, "expected a boolean");
    return {
      field: readString(entry, "field", `${at}.field`),
      ...(entry.baseValue === undefined ? {} : { baseValue: entry.baseValue }),
      ...(entry.clientValue === undefined ? {} : { clientValue: entry.clientValue }),
      ...(entry.serverValue === undefined ? {} : { serverValue: entry.serverValue }),
      // Divergence is both sides moving off the common ancestor; a one-sided
      // change is a clean edit, not a conflict.
      diverged: entry.changedOnClient && entry.changedOnServer,
    };
  });
}

function readFeatureState(value: unknown, operation: SyncConflictOperation, path: string): ConflictFeatureState {
  if (value === undefined || value === null) {
    return { operation, ...(operation === "delete" ? { deleted: true } : {}) };
  }
  if (!isRecord(value)) throw drift(path, "expected an object");
  return {
    operation,
    ...(isRecord(value.attributes) ? { attributes: value.attributes } : {}),
    ...(value.geometry === undefined ? {} : { geometry: value.geometry }),
    ...(operation === "delete" ? { deleted: true } : {}),
  };
}

function readResolutionRecord(
  entry: Record<string, unknown>,
  conflictId: SyncConflictId,
  path: string,
): SyncConflictResolutionRecord | undefined {
  const action = entry.resolutionAction;
  if (action === undefined || action === null) return undefined;
  if (typeof action !== "string") throw drift(`${path}.resolutionAction`, "expected a resolution action string");
  if (!Object.hasOwn(RESOLUTION_ACTION_CHOICES, action)) {
    throw drift(`${path}.resolutionAction`, "unknown resolution action", action);
  }
  const choice = RESOLUTION_ACTION_CHOICES[action];
  // `defer` is a postponement, not a closure: the conflict stays reviewable and
  // carries no resolution record.
  if (choice === undefined) return undefined;

  return {
    conflictId,
    choice,
    status: choice === "discard" ? "discarded" : "resolved",
    resolvedAt: readTimestamp(entry, "resolvedAt", `${path}.resolvedAt`),
    ...(typeof entry.resolvedBy === "string" && entry.resolvedBy.length > 0
      ? { resolvedBy: { id: entry.resolvedBy } }
      : {}),
    ...(entry.resolvedServerGeneration === undefined || entry.resolvedServerGeneration === null
      ? {}
      : { serverGen: readCursor(entry, "resolvedServerGeneration", `${path}.resolvedServerGeneration`) }),
  };
}

/**
 * The options this transport can actually execute. They are derived from the
 * shipped resolve-request shape, not from a server advertisement — the server
 * publishes no per-conflict option list.
 */
function resolutionOptions(): ReadonlyArray<ConflictResolutionOption> {
  return [
    { choice: "accept-client", available: true },
    { choice: "accept-server", available: true },
    {
      choice: "merge",
      available: false,
      reason:
        'The GeoServices conflict-resolution endpoint accepts only an "action" and cannot carry merged attributes or geometry.',
    },
    { choice: "discard", available: true },
  ];
}

function readActor(value: unknown): { readonly id: string; readonly kind: "user" } | undefined {
  return typeof value === "string" && value.length > 0 ? { id: value, kind: "user" } : undefined;
}

function readDevice(value: unknown): { readonly id: string } | undefined {
  return typeof value === "string" && value.length > 0 ? { id: value } : undefined;
}

function readString(entry: Record<string, unknown>, key: string, path: string): string {
  const value = entry[key];
  if (typeof value !== "string" || value.length === 0) throw drift(path, "expected a non-empty string");
  return value;
}

function readInteger(entry: Record<string, unknown>, key: string, path: string): number {
  const value = entry[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw drift(path, "expected an integer safely representable in JavaScript", value);
  }
  return value;
}

function readTimestamp(entry: Record<string, unknown>, key: string, path: string): string {
  const value = readString(entry, key, path);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw drift(path, "expected an ISO-8601 timestamp");
  return new Date(parsed).toISOString();
}

/**
 * Read a server generation as a {@link ServerGenerationCursor}. The wire carries
 * a 64-bit integer; a value outside JavaScript's safe integer range has already
 * lost precision by the time it is parsed, so it is refused rather than silently
 * rounded into a cursor that would order edits wrongly.
 */
function readCursor(entry: Record<string, unknown>, key: string, path: string): ServerGenerationCursor {
  const value = entry[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw drift(path, "expected an integer generation");
  if (!Number.isSafeInteger(value)) {
    throw drift(path, "the generation cursor exceeds JavaScript's safe integer range and cannot be read losslessly");
  }
  return String(value);
}

function requireIntegerCursor(cursor: ServerGenerationCursor, label: string): number {
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed)) {
    throw new HonuaReplicaSyncError(
      "response-drift",
      `${label} must be a decimal server generation cursor produced by this transport.`,
      { details: { member: label } },
    );
  }
  return parsed;
}

function optionalCount(value: unknown, key: string, path: string): Record<string, number> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "number" || !Number.isInteger(value)) throw drift(path, "expected an integer count", value);
  return { [key]: value };
}

function readOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw drift(path, "expected a boolean");
  return value;
}

/** Unwrap the admin API's `{ success, data }` envelope. */
function unwrapApiData(body: unknown, path: string): unknown {
  if (!isRecord(body)) throw drift(path, "expected a JSON object response");
  if (body.success !== true) throw drift(`${path}.success`, "the server did not report a successful response");
  if (!Object.hasOwn(body, "data")) throw drift(`${path}.data`, "the response envelope carried no data member");
  return body.data;
}

// ── Metadata helpers ─────────────────────────────────────────────────────────

function advertisesSync(metadata: Record<string, unknown>): boolean {
  if (metadata.syncEnabled === true) return true;
  const capabilities = metadata.capabilities;
  if (typeof capabilities !== "string") return false;
  return capabilities
    .split(",")
    .some((token) => token.trim().toLowerCase() === GEOSERVICES_SYNC_CAPABILITY_TOKEN.toLowerCase());
}

function syncDirections(value: unknown): ReadonlyArray<ReplicaSyncDirection> {
  // Without direction control the server picks; only the full round trip is
  // guaranteed to be honoured.
  if (!isRecord(value) || value.supportsSyncDirectionControl !== true) return ["bidirectional"];
  return ["bidirectional", "upload", "download"];
}

function layerPathSuffix(sourceId: string | undefined): string {
  if (sourceId === undefined) return "";
  // GeoServices addresses a layer by its service-local integer id. A source id
  // that is not one names no layer resource, so the service resource answers.
  return /^\d+$/.test(sourceId) ? `/${sourceId}` : "";
}

function isExperimentalDisabledProblem(body: unknown): boolean {
  return isRecord(body) && body.type === EXPERIMENTAL_DISABLED_PROBLEM_TYPE;
}

// ── Shared utilities ─────────────────────────────────────────────────────────

function singleServerStatus(statuses: ReadonlyArray<SyncConflictStatus> | undefined): string | undefined {
  if (statuses === undefined || statuses.length !== 1) return undefined;
  // Only `pending` and `resolved` round-trip to a server-side filter; the rest
  // are filtered locally after projection.
  const only = statuses[0];
  return only === "pending" || only === "resolved" ? only : undefined;
}

function paginate<T>(items: ReadonlyArray<T>, limit?: number, cursor?: string): SyncPage<T> {
  const start = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
  const end = limit === undefined ? items.length : start + limit;
  const page = items.slice(start, end);
  const nextCursor = end < items.length ? String(end) : undefined;
  return { items: page, ...(nextCursor === undefined ? {} : { cursor: nextCursor }), totalCount: items.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HonuaReplicaSyncError("response-drift", `${label} must be a non-empty string.`, {
      details: { member: label },
    });
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Screen a string before it reaches a message or an error `details` payload. A
 * credential- or URL-shaped identifier is replaced by a fixed placeholder rather
 * than echoed, so a hostile or misconfigured id cannot smuggle a token into an
 * error report.
 */
function screened(value: string, label: string): string {
  return screenPersistedString(value, "identity") === undefined ? value : `<${label} withheld: credential-shaped>`;
}

/**
 * Refuse a drifted response. The message names the member and what was expected;
 * the observed value is included only when it is a short, screened scalar, so a
 * refusal never becomes an exfiltration channel.
 */
function drift(member: string, detail: string, observed?: unknown): HonuaReplicaSyncError {
  const described = observed === undefined ? undefined : describeObserved(observed);
  return new HonuaReplicaSyncError(
    "response-drift",
    `The GeoServices replica-sync response drifted at "${member}": ${detail}${described === undefined ? "" : ` (observed: ${described})`}.`,
    { details: { member, ...(described === undefined ? {} : { observed: described }) } },
  );
}

function describeObserved(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return typeof value;
  const truncated = value.length > 64 ? `${value.slice(0, 64)}…` : value;
  return screenPersistedString(truncated, "identity") === undefined ? truncated : "<withheld: credential-shaped>";
}
