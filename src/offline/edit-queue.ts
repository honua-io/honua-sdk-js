import { type HonuaErrorCode, HonuaSdkError } from "../core/error-envelope.js";
import { credentialScreenMessage, screenPersistedString } from "./credential-screen.js";

export const HONUA_OFFLINE_EDIT_QUEUE_VERSION = "1.0" as const;
export const DEFAULT_OFFLINE_EDIT_QUEUE_MAX_EDITS = 10_000;
export const DEFAULT_OFFLINE_EDIT_QUEUE_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_OFFLINE_EDIT_QUEUE_MAX_AUDIT_EVENTS = 128;
export const DEFAULT_OFFLINE_EDIT_QUEUE_MAX_DEPENDENCIES = 256;
export const MAX_OFFLINE_EDIT_LEASE_DURATION_MS = 24 * 60 * 60 * 1000;

const EDIT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DATABASE_VERSION = 2;
const EDIT_STORE = "edits";
const METADATA_STORE = "edit-metadata";
const TOMBSTONE_STORE = "edit-tombstones";
const PARTITION_ORDER_INDEX = "partition-order";
const PARTITION_STATE_ORDER_INDEX = "partition-state-order";
const DEPENDENCY_INDEX = "dependency";
const encoder = new TextEncoder();
const ENQUEUE_KEYS = new Set(["authorizationScopeDigest", "sourceId", "idempotencyKey", "edit", "dependencyIds"]);
const FEATURE_EDIT_KEYS = new Set(["operation", "featureId", "attributes", "geometry"]);
const PARTITION_KEYS = ["authorizationScopeDigest", "sourceId"] as const;
const CLAIM_KEYS = new Set([...PARTITION_KEYS, "workerId", "limit", "leaseDurationMs"]);
const LIST_KEYS = new Set([...PARTITION_KEYS, "limit"]);
const PRUNE_KEYS = new Set([...PARTITION_KEYS, "terminalBefore", "limit"]);
const APPLIED_KEYS = new Set(["serverOperationId", "serverGeneration"]);
const RETRY_KEYS = new Set(["retryAt", "reasonCode"]);
const CONFLICT_KEYS = new Set(["conflictId", "serverGeneration"]);
const CANCEL_KEYS = new Set(["reasonCode"]);
const RESOLVE_CONFLICT_KEYS = new Set(["conflictId", "choice", "resolvedBy", "note"]);

export type OfflineEditJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OfflineEditJsonValue[]
  | { readonly [key: string]: OfflineEditJsonValue };

export type OfflineEditOperation = "add" | "update" | "delete";
export type OfflineQueuedEditState = "pending" | "leased" | "retryable" | "applied" | "conflicted" | "cancelled";

const QUEUE_STATES = [
  "pending",
  "leased",
  "retryable",
  "applied",
  "conflicted",
  "cancelled",
] as const satisfies readonly OfflineQueuedEditState[];

function emptyStateCounts(): Record<OfflineQueuedEditState, number> {
  return { pending: 0, leased: 0, retryable: 0, applied: 0, conflicted: 0, cancelled: 0 };
}

export interface OfflineFeatureEdit {
  readonly operation: OfflineEditOperation;
  readonly featureId?: string | number;
  readonly attributes?: Readonly<Record<string, OfflineEditJsonValue>>;
  readonly geometry?: OfflineEditJsonValue;
}

export interface EnqueueOfflineEditInput {
  /** Precomputed authorization partition digest. Raw credentials are not accepted. */
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly sourceId: string;
  /** Opaque non-secret identity sent unchanged to the replay transport. */
  readonly idempotencyKey: string;
  readonly edit: OfflineFeatureEdit;
  /** Queue edit IDs returned by earlier enqueue operations. */
  readonly dependencyIds?: readonly `sha256:${string}`[];
}

export interface OfflineEditLease {
  readonly token: string;
  readonly workerId: string;
  readonly expiresAt: string;
}

export interface OfflineEditRetry {
  readonly retryAt: string;
  readonly reasonCode: string;
}

export interface OfflineEditAppliedOutcome {
  readonly appliedAt: string;
  readonly serverOperationId?: string;
  readonly serverGeneration?: string;
}

export interface OfflineEditConflictOutcome {
  readonly conflictId: string;
  readonly detectedAt: string;
  readonly serverGeneration?: string;
}

export interface OfflineEditCancellationOutcome {
  readonly cancelledAt: string;
  readonly reasonCode: string;
}

/**
 * How a reviewer closed a conflict, in the queue's own spelling.
 *
 * The three members are exactly the members of the shipped
 * `ConflictResolutionChoice` the queue can act on without a server. `merge` is
 * absent on purpose: a merged value would have to replace the edit's payload,
 * and the edit's identity is a digest of that payload, so recording a merge
 * here would silently rewrite an idempotency identity the transport has
 * already used. The offline conflict-resolution surface refuses `merge` rather
 * than accepting one it cannot honour.
 */
export type OfflineEditConflictResolutionChoice = "accept-client" | "accept-server" | "discard";

/** What the resolution did to the durable edit. */
export type OfflineEditConflictResolutionDisposition =
  /** The local edit stands and returns to `pending` for another delivery attempt. */
  | "requeued"
  /** The local edit is abandoned; the record is terminal. */
  | "discarded";

/**
 * Delivery status of a locally recorded resolution.
 *
 * The single member is the honest one: a resolution recorded through this queue
 * is durable *local* state, and only a server can acknowledge it. No code path
 * in this build produces any other value, and none may until a transport exists
 * that can carry a resolution to a server and read its answer back.
 */
export type OfflineEditConflictResolutionAcknowledgement = "unacknowledged-by-server";

/**
 * The closure of one conflict, recorded against the edit that raised it.
 *
 * It carries the closed conflict's identity and timing — `conflictId`,
 * `detectedAt`, `serverGeneration` — because the `conflict` outcome itself is
 * cleared by the transition: a record must not claim to be both conflicted and
 * resolved. The audit history keeps the ordered account; this member is the
 * current outcome slot, exactly as `applied` and `cancellation` are.
 */
export interface OfflineEditConflictResolutionOutcome {
  readonly conflictId: string;
  /** Carried from the conflict this resolution closed. */
  readonly detectedAt: string;
  /** Carried from the conflict this resolution closed, when it named one. */
  readonly serverGeneration?: string;
  readonly choice: OfflineEditConflictResolutionChoice;
  readonly disposition: OfflineEditConflictResolutionDisposition;
  readonly acknowledgement: OfflineEditConflictResolutionAcknowledgement;
  readonly resolvedAt: string;
  /** Opaque non-secret reviewer identity; screened before it is persisted. */
  readonly resolvedBy?: string;
  /** Reviewer note; screened before it is persisted. */
  readonly note?: string;
}

export type OfflineEditAuditEventKind =
  | "enqueued"
  | "claimed"
  | "lease-reclaimed"
  | "retry-scheduled"
  | "applied"
  | "conflicted"
  | "conflict-resolved"
  | "cancelled";

export interface OfflineEditAuditEvent {
  readonly sequence: number;
  readonly kind: OfflineEditAuditEventKind;
  readonly at: string;
  readonly attempt: number;
  readonly workerId?: string;
  readonly reasonCode?: string;
  readonly conflictId?: string;
  readonly serverOperationId?: string;
  readonly serverGeneration?: string;
  /** Present on `conflict-resolved`: how the reviewer closed the conflict. */
  readonly resolutionChoice?: OfflineEditConflictResolutionChoice;
}

export interface OfflineQueuedEdit {
  readonly version: typeof HONUA_OFFLINE_EDIT_QUEUE_VERSION;
  readonly id: `sha256:${string}`;
  readonly requestFingerprint: `sha256:${string}`;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly edit: OfflineFeatureEdit;
  readonly dependencyIds: readonly `sha256:${string}`[];
  readonly state: OfflineQueuedEditState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attemptCount: number;
  readonly lease?: OfflineEditLease;
  readonly retry?: OfflineEditRetry;
  readonly applied?: OfflineEditAppliedOutcome;
  readonly conflict?: OfflineEditConflictOutcome;
  /**
   * The closure of the record's most recent conflict. Never present together
   * with `conflict`: opening a new conflict clears it, and closing a conflict
   * clears `conflict`, so the record always says exactly one of "conflicted"
   * and "resolved". The ordered account of both lives in `audit`.
   */
  readonly conflictResolution?: OfflineEditConflictResolutionOutcome;
  readonly cancellation?: OfflineEditCancellationOutcome;
  readonly audit: readonly OfflineEditAuditEvent[];
}

export interface OfflineEditEnqueueResult {
  readonly status: "enqueued" | "duplicate";
  readonly edit: OfflineQueuedEdit;
}

export interface OfflineEditQueuePartition {
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly sourceId: string;
}

/** Complete, unbounded partition totals for every queue state. */
export type OfflineEditQueueStateCounts = Readonly<Record<OfflineQueuedEditState, number>>;

export interface ClaimOfflineEditsOptions extends OfflineEditQueuePartition {
  readonly workerId: string;
  readonly limit: number;
  readonly leaseDurationMs: number;
}

export interface ListOfflineEditsOptions extends OfflineEditQueuePartition {
  /** Defaults to 100 and cannot exceed 100. */
  readonly limit?: number;
}

export interface PruneTerminalOfflineEditsOptions extends OfflineEditQueuePartition {
  /** Remove terminal records updated at or before this normalized timestamp. */
  readonly terminalBefore: string;
  /** Defaults to 100 and cannot exceed 100. */
  readonly limit?: number;
}

export interface MarkOfflineEditAppliedInput {
  readonly serverOperationId?: string;
  readonly serverGeneration?: string;
}

export interface MarkOfflineEditRetryInput {
  readonly retryAt: string;
  readonly reasonCode: string;
}

export interface MarkOfflineEditConflictedInput {
  readonly conflictId: string;
  readonly serverGeneration?: string;
}

export interface CancelOfflineEditInput {
  readonly reasonCode: string;
}

export interface ResolveOfflineEditConflictInput {
  /**
   * The conflict being closed. It must equal the conflict the record actually
   * carries, so a stale review cannot close a conflict the queue has since
   * replaced with a newer one.
   */
  readonly conflictId: string;
  readonly choice: OfflineEditConflictResolutionChoice;
  /** Opaque non-secret reviewer identity. Screened before it is persisted. */
  readonly resolvedBy?: string;
  /** Reviewer note. Screened before it is persisted. */
  readonly note?: string;
}

export interface OfflineEditQueue {
  enqueue(input: EnqueueOfflineEditInput): Promise<OfflineEditEnqueueResult>;
  get(editId: string, partition: OfflineEditQueuePartition): Promise<OfflineQueuedEdit | undefined>;
  list(options: ListOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]>;
  /**
   * Exact partition totals for every state. `list` is bounded to 100 records
   * and has no cursor, so it cannot be counted; anything that must be truthful
   * about how much work exists has to read these totals instead.
   */
  countByState(partition: OfflineEditQueuePartition): Promise<OfflineEditQueueStateCounts>;
  claimReady(options: ClaimOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]>;
  markApplied(editId: string, leaseToken: string, outcome?: MarkOfflineEditAppliedInput): Promise<OfflineQueuedEdit>;
  markRetry(editId: string, leaseToken: string, outcome: MarkOfflineEditRetryInput): Promise<OfflineQueuedEdit>;
  markConflicted(
    editId: string,
    leaseToken: string,
    outcome: MarkOfflineEditConflictedInput,
  ): Promise<OfflineQueuedEdit>;
  /** Retire unleased work that cannot proceed, such as a dependent of a conflicted edit. */
  cancel(
    editId: string,
    partition: OfflineEditQueuePartition,
    outcome: CancelOfflineEditInput,
  ): Promise<OfflineQueuedEdit>;
  /**
   * Close a conflicted edit's conflict with a reviewed choice.
   *
   * Unleased, like `cancel`: the conflict transition already released the
   * lease, and the reviewer is not the replay worker. `accept-client` requeues
   * the edit as `pending`; `accept-server` and `discard` abandon it as
   * `cancelled`. Either way the conflict leaves the record, so no later pass
   * re-surfaces it, and the resolution is recorded as unacknowledged by any
   * server.
   */
  resolveConflict(
    editId: string,
    partition: OfflineEditQueuePartition,
    resolution: ResolveOfflineEditConflictInput,
  ): Promise<OfflineQueuedEdit>;
  pruneTerminal(options: PruneTerminalOfflineEditsOptions): Promise<readonly `sha256:${string}`[]>;
}

export type OfflineEditQueueErrorCode =
  | "invalid-edit"
  | "idempotency-conflict"
  | "edit-pruned"
  | "dependency-not-found"
  | "edit-not-found"
  | "invalid-transition"
  | "lease-mismatch"
  | "lease-expired"
  | "queue-limit-exceeded"
  /** A persisted record failed validation on read and was not trusted into a replay. */
  | "record-unreadable"
  | "store-failed";

export class HonuaOfflineEditQueueError extends HonuaSdkError {
  public readonly name = "HonuaOfflineEditQueueError";

  public constructor(
    public readonly code: OfflineEditQueueErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly editId?: string; readonly path?: string } = {},
  ) {
    super(editQueueSdkCode(code), message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      context: { reasonCode: code },
    });
    this.editId = options.editId;
    this.path = options.path;
  }

  public readonly editId?: string;
  public readonly path?: string;
}

/** Stable discriminator and version for edit-queue recovery reports. */
export const HONUA_OFFLINE_EDIT_QUEUE_RECOVERY_KIND = "honua.offline-edit-queue-recovery" as const;
export const HONUA_OFFLINE_EDIT_QUEUE_RECOVERY_VERSION = 1 as const;

/** Ceilings on one recovery pass. Callers may tighten them, never raise them. */
export const DEFAULT_OFFLINE_EDIT_QUEUE_MAX_RECOVERY_RECORDS = 100_000;
export const DEFAULT_OFFLINE_EDIT_QUEUE_MAX_RECOVERY_BYTES = 64 * 1024 * 1024;

/**
 * Why a persisted record was refused. `foreign-version` is a record this build
 * cannot interpret; `corrupt-record` is one whose identity, state, or timing
 * fields do not hold together; `credential-screened` is one whose persisted
 * partition identity is shaped like a secret or a request reference;
 * `orphaned-metadata` is an index row whose edit no longer exists.
 */
export type OfflineEditQueueDiscardReason =
  | "foreign-version"
  | "corrupt-record"
  | "credential-screened"
  | "orphaned-metadata";

/** A record that was repaired rather than lost. */
export type OfflineEditQueueRepairReason = "restored-metadata";

/**
 * Structured, payload-free account of one recovery pass.
 *
 * Counts and reason codes only: identities are digests, and no `edit.attributes`
 * or `edit.geometry` value is read, copied, or reported. `error` carries the
 * same envelope every other queue failure uses, so a host routes a discard
 * through its existing offline error path.
 */
export interface OfflineEditQueueRecoveryV1 {
  readonly kind: typeof HONUA_OFFLINE_EDIT_QUEUE_RECOVERY_KIND;
  readonly version: typeof HONUA_OFFLINE_EDIT_QUEUE_RECOVERY_VERSION;
  /** `open` is the startup pass; `read` is a record refused between passes. */
  readonly operation: "open" | "read";
  readonly inspectedRecords: number;
  readonly discardedRecords: number;
  readonly repairedRecords: number;
  readonly discardedByReason: Readonly<Record<OfflineEditQueueDiscardReason, number>>;
  readonly repairedByReason: Readonly<Record<OfflineEditQueueRepairReason, number>>;
  readonly error: HonuaOfflineEditQueueError;
}

/** One persisted row paired with the key it is stored under. */
export interface OfflineEditQueueStoredRecord {
  readonly key: string;
  readonly value: unknown;
}

export interface OfflineEditQueueRecoveryRowsV1 {
  readonly edits: readonly OfflineEditQueueStoredRecord[];
  readonly metadata: readonly OfflineEditQueueStoredRecord[];
  readonly tombstones: readonly OfflineEditQueueStoredRecord[];
}

export interface OfflineEditQueueRecoveryLimits {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

/** Deterministic mutation set a recovery pass applies in one transaction. */
export interface OfflineEditQueueRecoveryPlanV1 {
  readonly report: OfflineEditQueueRecoveryV1;
  readonly deleteEditKeys: readonly string[];
  readonly deleteMetadataKeys: readonly string[];
  readonly deleteTombstoneKeys: readonly string[];
  readonly putMetadata: readonly OfflineEditQueueMetadata[];
}

/** Result of validating one persisted row before it is trusted. */
export type OfflineEditQueueInspection<T> =
  | { readonly status: "valid"; readonly record: T }
  | { readonly status: "invalid"; readonly reason: OfflineEditQueueDiscardReason };

export interface OfflineEditQueueOptions {
  readonly now?: () => Date;
  readonly createLeaseToken?: () => string;
  readonly maxEdits?: number;
  readonly maxPayloadBytes?: number;
  readonly maxAuditEvents?: number;
  readonly maxDependencies?: number;
}

export interface IndexedDbOfflineEditQueueOptions extends OfflineEditQueueOptions {
  /** Defaults to `honua-offline-edit-queue`. Names are origin-scoped. */
  readonly name?: string;
  readonly indexedDB?: IDBFactory;
  /** Ceilings on the startup recovery pass. */
  readonly recovery?: OfflineEditQueueRecoveryLimits;
  /** Receives every discard and repair. Must not throw. */
  readonly onRecovery?: (report: OfflineEditQueueRecoveryV1) => void;
}

interface PreparedEdit {
  readonly id: `sha256:${string}`;
  readonly requestFingerprint: `sha256:${string}`;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly edit: OfflineFeatureEdit;
  readonly dependencyIds: readonly `sha256:${string}`[];
}

/** Compact index row projected from an edit; carries no payload. */
export interface OfflineEditQueueMetadata extends OfflineEditQueuePartition {
  readonly id: `sha256:${string}`;
  readonly state: OfflineQueuedEditState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependencyIds: readonly `sha256:${string}`[];
  readonly retryAt?: string;
  readonly leaseExpiresAt?: string;
}

/** Identity-only record of a pruned edit; exists so it cannot be re-enqueued. */
export interface OfflineEditQueueTombstone extends OfflineEditQueuePartition {
  readonly id: `sha256:${string}`;
  readonly requestFingerprint: `sha256:${string}`;
  readonly prunedAt: string;
  readonly terminalState: "applied" | "conflicted" | "cancelled";
}

type OfflineEditDependencyEvidence =
  | Pick<OfflineQueuedEdit, "id" | "authorizationScopeDigest" | "sourceId" | "state">
  | OfflineEditQueueMetadata
  | OfflineEditQueueTombstone;

interface QueueStores {
  readonly edits: IDBObjectStore;
  readonly metadata: IDBObjectStore;
  readonly tombstones: IDBObjectStore;
}

interface NormalizedQueueOptions {
  readonly now: () => Date;
  readonly createLeaseToken: () => string;
  readonly maxEdits: number;
  readonly maxPayloadBytes: number;
  readonly maxAuditEvents: number;
  readonly maxDependencies: number;
}

interface NormalizedClaimOptions extends OfflineEditQueuePartition {
  readonly workerId: string;
  readonly limit: number;
  readonly leaseDurationMs: number;
  readonly now: Date;
}

interface NormalizedPruneOptions extends OfflineEditQueuePartition {
  readonly terminalBefore: string;
  readonly terminalBeforeMs: number;
  readonly limit: number;
}

interface JsonCaptureBudget {
  nodes: number;
  bytes: number;
  readonly maxBytes: number;
}

/** Deterministic in-memory implementation for tests and non-persistent hosts. */
export class MemoryOfflineEditQueue implements OfflineEditQueue {
  readonly #records = new Map<string, OfflineQueuedEdit>();
  readonly #tombstones = new Map<string, OfflineEditQueueTombstone>();
  readonly #options: NormalizedQueueOptions;

  public constructor(options: OfflineEditQueueOptions = {}) {
    this.#options = normalizeOptions(options);
  }

  public async enqueue(input: EnqueueOfflineEditInput): Promise<OfflineEditEnqueueResult> {
    const prepared = await prepareEdit(input, this.#options);
    rejectPrunedIdentity(this.#tombstones.get(prepared.id), prepared);
    const result = enqueueRecord(
      [...this.#records.values()],
      this.#tombstones,
      prepared,
      timestamp(this.#options.now),
      this.#options,
    );
    if (result.record) this.#records.set(result.record.id, result.record);
    return copy(result.result);
  }

  public async get(editId: string, partition: OfflineEditQueuePartition): Promise<OfflineQueuedEdit | undefined> {
    const record = this.#records.get(requiredId(editId, "editId"));
    const normalized = capturePartition(partition, "partition");
    return record && matchesPartition(record, normalized) ? copy(record) : undefined;
  }

  public async list(options: ListOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]> {
    const { partition, limit } = captureListOptions(options);
    return copy(
      sortedRecords([...this.#records.values()].filter((record) => matchesPartition(record, partition))).slice(
        0,
        limit,
      ),
    );
  }

  public async countByState(partition: OfflineEditQueuePartition): Promise<OfflineEditQueueStateCounts> {
    const normalized = capturePartition(partition, "partition");
    const counts = emptyStateCounts();
    for (const record of this.#records.values()) {
      if (matchesPartition(record, normalized)) counts[record.state] += 1;
    }
    return Object.freeze(counts);
  }

  public async claimReady(options: ClaimOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]> {
    const result = claimRecords([...this.#records.values()], this.#tombstones, options, this.#options);
    for (const record of result.changed) this.#records.set(record.id, record);
    return copy(result.claimed);
  }

  public async markApplied(
    editId: string,
    leaseToken: string,
    outcome: MarkOfflineEditAppliedInput = {},
  ): Promise<OfflineQueuedEdit> {
    return this.#transition(editId, leaseToken, "applied", outcome);
  }

  public async markRetry(
    editId: string,
    leaseToken: string,
    outcome: MarkOfflineEditRetryInput,
  ): Promise<OfflineQueuedEdit> {
    return this.#transition(editId, leaseToken, "retryable", outcome);
  }

  public async markConflicted(
    editId: string,
    leaseToken: string,
    outcome: MarkOfflineEditConflictedInput,
  ): Promise<OfflineQueuedEdit> {
    return this.#transition(editId, leaseToken, "conflicted", outcome);
  }

  public async cancel(
    editId: string,
    partition: OfflineEditQueuePartition,
    outcome: CancelOfflineEditInput,
  ): Promise<OfflineQueuedEdit> {
    const id = requiredId(editId, "editId");
    const normalized = capturePartition(partition, "partition");
    const current = this.#records.get(id);
    if (!current || !matchesPartition(current, normalized)) {
      fail("edit-not-found", `Offline edit "${id}" was not found.`, { editId: id });
    }
    const updated = cancelRecord(current, outcome, this.#options);
    this.#records.set(id, updated);
    return copy(updated);
  }

  public async resolveConflict(
    editId: string,
    partition: OfflineEditQueuePartition,
    resolution: ResolveOfflineEditConflictInput,
  ): Promise<OfflineQueuedEdit> {
    const id = requiredId(editId, "editId");
    const normalized = capturePartition(partition, "partition");
    const current = this.#records.get(id);
    if (!current || !matchesPartition(current, normalized)) {
      fail("edit-not-found", `Offline edit "${id}" was not found.`, { editId: id });
    }
    const updated = resolveConflictRecord(current, resolution, this.#options);
    this.#records.set(id, updated);
    return copy(updated);
  }

  public async pruneTerminal(options: PruneTerminalOfflineEditsOptions): Promise<readonly `sha256:${string}`[]> {
    const normalized = capturePruneOptions(options);
    const prunedAt = timestamp(this.#options.now);
    const records = [...this.#records.values()];
    const removed: `sha256:${string}`[] = [];
    for (const record of terminalPruneCandidates(records, normalized)) {
      if (hasActiveDependent(records, record.id)) continue;
      this.#tombstones.set(record.id, tombstoneFor(record, prunedAt));
      this.#records.delete(record.id);
      removed.push(record.id);
      if (removed.length === normalized.limit) break;
    }
    return deepFreeze(removed);
  }

  #transition(
    editId: string,
    leaseToken: string,
    state: "applied" | "retryable" | "conflicted",
    outcome: MarkOfflineEditAppliedInput | MarkOfflineEditRetryInput | MarkOfflineEditConflictedInput,
  ): OfflineQueuedEdit {
    const id = requiredId(editId, "editId");
    const current = this.#records.get(id);
    if (!current) fail("edit-not-found", `Offline edit "${id}" was not found.`, { editId: id });
    const updated = transitionRecord(current, leaseToken, state, outcome, this.#options);
    this.#records.set(id, updated);
    return copy(updated);
  }
}

/** Persistent browser implementation with atomic IndexedDB claims and transitions. */
export class IndexedDbOfflineEditQueue implements OfflineEditQueue {
  readonly #database: Promise<IDBDatabase>;
  readonly #options: NormalizedQueueOptions;
  readonly #onRecovery?: (report: OfflineEditQueueRecoveryV1) => void;

  public constructor(options: IndexedDbOfflineEditQueueOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available in this runtime.");
    const name = options.name ?? "honua-offline-edit-queue";
    if (name.trim().length === 0) throw new Error("IndexedDB database name must be non-empty.");
    this.#options = normalizeOptions(options);
    if (options.onRecovery) this.#onRecovery = options.onRecovery;
    const limits = options.recovery ?? {};
    const onRecovery = options.onRecovery;
    // Recovery runs once, before any caller can read, so an unreadable record
    // is gone before it can be leased and replayed as though it were a write.
    const opened = openDatabase(factory, name).then(async (database) => {
      await recoverQueueDatabase(database, limits, onRecovery);
      return database;
    });
    // A queue that refuses to open reports through every method that awaits it;
    // swallowing the copy keeps that from also being an unhandled rejection.
    opened.catch(() => undefined);
    this.#database = opened;
  }

  public async enqueue(input: EnqueueOfflineEditInput): Promise<OfflineEditEnqueueResult> {
    const prepared = await prepareEdit(input, this.#options);
    return this.#run("readwrite", async ({ edits, metadata, tombstones }, tally) => {
      const existing = readStoredEdit(await request<unknown>(edits.get(prepared.id)), prepared.id, tally);
      const tombstone = readStoredTombstone(await request<unknown>(tombstones.get(prepared.id)), tally);
      rejectPrunedIdentity(tombstone, prepared);
      const dependencies = await Promise.all(
        prepared.dependencyIds.map(async (id) => {
          const live = readStoredMetadata(await request<unknown>(metadata.get(id)), tally);
          return live ?? readStoredTombstone(await request<unknown>(tombstones.get(id)), tally);
        }),
      );
      const queueSize = await request<number>(metadata.count());
      const result = enqueuePreparedRecord(
        existing,
        dependencies,
        queueSize,
        prepared,
        timestamp(this.#options.now),
        this.#options,
      );
      if (result.record) {
        edits.put(result.record);
        metadata.put(metadataFor(result.record));
      }
      return copy(result.result);
    });
  }

  public async get(editId: string, partition: OfflineEditQueuePartition): Promise<OfflineQueuedEdit | undefined> {
    const id = requiredId(editId, "editId");
    const normalized = capturePartition(partition, "partition");
    return this.#run("readonly", async ({ edits }, tally) => {
      const record = readStoredEdit(await request<unknown>(edits.get(id)), id, tally);
      return record && matchesPartition(record, normalized) ? copy(record) : undefined;
    });
  }

  public async list(options: ListOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]> {
    const { partition, limit } = captureListOptions(options);
    return this.#run("readonly", async ({ edits, metadata }, tally) => {
      const ids = await scanPartitionIds(metadata, partition, limit, tally);
      const records = await Promise.all(
        ids.map(async (id) => readStoredEdit(await request<unknown>(edits.get(id)), id, tally)),
      );
      return copy(records.filter((record): record is OfflineQueuedEdit => record !== undefined));
    });
  }

  public async countByState(partition: OfflineEditQueuePartition): Promise<OfflineEditQueueStateCounts> {
    const normalized = capturePartition(partition, "partition");
    return this.#run("readonly", async ({ metadata }) => {
      const index = metadata.index(PARTITION_STATE_ORDER_INDEX);
      // Counts read index keys only; the startup pass has already reconciled the
      // index against the edits it projects.
      const counts = emptyStateCounts();
      // The compound partition/state index counts without materializing or
      // reading any edit payload.
      for (const state of QUEUE_STATES) {
        counts[state] = await request<number>(index.count(partitionStateRange(normalized, state)));
      }
      return Object.freeze(counts);
    });
  }

  public async claimReady(options: ClaimOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]> {
    const normalized = captureClaimOptions(options, this.#options);
    return this.#run("readwrite", async ({ edits, metadata, tombstones }, tally) => {
      const candidates = await scanReadyMetadata(metadata, tombstones, normalized, tally);
      const claimed: OfflineQueuedEdit[] = [];
      for (const candidate of candidates) {
        const record = readStoredEdit(await request<unknown>(edits.get(candidate.id)), candidate.id, tally);
        if (!record) {
          // An index row whose edit is gone or unreadable is retired here rather
          // than thrown, so one damaged record cannot stall every other claim.
          edits.delete(candidate.id);
          metadata.delete(candidate.id);
          continue;
        }
        const updated = claimRecord(record, normalized, this.#options);
        edits.put(updated);
        metadata.put(metadataFor(updated));
        claimed.push(updated);
      }
      return copy(claimed);
    });
  }

  public async markApplied(
    editId: string,
    leaseToken: string,
    outcome: MarkOfflineEditAppliedInput = {},
  ): Promise<OfflineQueuedEdit> {
    return this.#transition(editId, leaseToken, "applied", outcome);
  }

  public async markRetry(
    editId: string,
    leaseToken: string,
    outcome: MarkOfflineEditRetryInput,
  ): Promise<OfflineQueuedEdit> {
    return this.#transition(editId, leaseToken, "retryable", outcome);
  }

  public async markConflicted(
    editId: string,
    leaseToken: string,
    outcome: MarkOfflineEditConflictedInput,
  ): Promise<OfflineQueuedEdit> {
    return this.#transition(editId, leaseToken, "conflicted", outcome);
  }

  public async cancel(
    editId: string,
    partition: OfflineEditQueuePartition,
    outcome: CancelOfflineEditInput,
  ): Promise<OfflineQueuedEdit> {
    const id = requiredId(editId, "editId");
    const normalized = capturePartition(partition, "partition");
    return this.#run("readwrite", async ({ edits, metadata }, tally) => {
      const stored = await request<unknown>(edits.get(id));
      const current = readStoredEdit(stored, id, tally);
      if (stored !== undefined && !current) {
        fail("record-unreadable", `Offline edit "${id}" is stored in a form this build cannot read.`, { editId: id });
      }
      if (!current || !matchesPartition(current, normalized)) {
        fail("edit-not-found", `Offline edit "${id}" was not found.`, { editId: id });
      }
      const updated = cancelRecord(current, outcome, this.#options);
      edits.put(updated);
      metadata.put(metadataFor(updated));
      return copy(updated);
    });
  }

  public async resolveConflict(
    editId: string,
    partition: OfflineEditQueuePartition,
    resolution: ResolveOfflineEditConflictInput,
  ): Promise<OfflineQueuedEdit> {
    const id = requiredId(editId, "editId");
    const normalized = capturePartition(partition, "partition");
    return this.#run("readwrite", async ({ edits, metadata }, tally) => {
      const stored = await request<unknown>(edits.get(id));
      const current = readStoredEdit(stored, id, tally);
      if (stored !== undefined && !current) {
        fail("record-unreadable", `Offline edit "${id}" is stored in a form this build cannot read.`, { editId: id });
      }
      if (!current || !matchesPartition(current, normalized)) {
        fail("edit-not-found", `Offline edit "${id}" was not found.`, { editId: id });
      }
      const updated = resolveConflictRecord(current, resolution, this.#options);
      edits.put(updated);
      metadata.put(metadataFor(updated));
      return copy(updated);
    });
  }

  public async pruneTerminal(options: PruneTerminalOfflineEditsOptions): Promise<readonly `sha256:${string}`[]> {
    const normalized = capturePruneOptions(options);
    const prunedAt = timestamp(this.#options.now);
    return this.#run("readwrite", async ({ edits, metadata, tombstones }, tally) => {
      const candidates = await scanTerminalMetadata(metadata, normalized, tally);
      const removed: `sha256:${string}`[] = [];
      for (const candidate of candidates) {
        if (await hasActiveMetadataDependent(metadata, candidate.id)) continue;
        const record = readStoredEdit(await request<unknown>(edits.get(candidate.id)), candidate.id, tally);
        if (!record) {
          // Nothing readable to tombstone: retire the rows without inventing an
          // identity claim the queue cannot substantiate.
          edits.delete(candidate.id);
          metadata.delete(candidate.id);
          continue;
        }
        tombstones.put(tombstoneFor(record, prunedAt));
        edits.delete(candidate.id);
        metadata.delete(candidate.id);
        removed.push(candidate.id);
        if (removed.length === normalized.limit) break;
      }
      return deepFreeze(removed);
    });
  }

  async #transition(
    editId: string,
    leaseToken: string,
    state: "applied" | "retryable" | "conflicted",
    outcome: MarkOfflineEditAppliedInput | MarkOfflineEditRetryInput | MarkOfflineEditConflictedInput,
  ): Promise<OfflineQueuedEdit> {
    const id = requiredId(editId, "editId");
    return this.#run("readwrite", async ({ edits, metadata }, tally) => {
      const stored = await request<unknown>(edits.get(id));
      const current = readStoredEdit(stored, id, tally);
      if (stored !== undefined && !current) {
        fail("record-unreadable", `Offline edit "${id}" is stored in a form this build cannot read.`, { editId: id });
      }
      if (!current) fail("edit-not-found", `Offline edit "${id}" was not found.`, { editId: id });
      const updated = transitionRecord(current, leaseToken, state, outcome, this.#options);
      edits.put(updated);
      metadata.put(metadataFor(updated));
      return copy(updated);
    });
  }

  async #run<T>(mode: IDBTransactionMode, body: (stores: QueueStores, tally: RecoveryTally) => Promise<T>): Promise<T> {
    const tally = emptyTally();
    try {
      const result = await runTransaction(await this.#database, mode, (stores) => body(stores, tally));
      emitRecovery(this.#onRecovery, tally, "read");
      return result;
    } catch (cause) {
      if (cause instanceof HonuaOfflineEditQueueError) throw cause;
      throw new HonuaOfflineEditQueueError("store-failed", "Offline edit queue storage failed.", { cause });
    }
  }
}

export function createMemoryOfflineEditQueue(options: OfflineEditQueueOptions = {}): MemoryOfflineEditQueue {
  return new MemoryOfflineEditQueue(options);
}

export function createIndexedDbOfflineEditQueue(
  options: IndexedDbOfflineEditQueueOptions = {},
): IndexedDbOfflineEditQueue {
  return new IndexedDbOfflineEditQueue(options);
}

function normalizeOptions(options: OfflineEditQueueOptions): NormalizedQueueOptions {
  return {
    now: options.now ?? (() => new Date()),
    createLeaseToken: options.createLeaseToken ?? defaultLeaseToken,
    maxEdits: tightenedPositive(options.maxEdits, DEFAULT_OFFLINE_EDIT_QUEUE_MAX_EDITS, "maxEdits"),
    maxPayloadBytes: tightenedPositive(
      options.maxPayloadBytes,
      DEFAULT_OFFLINE_EDIT_QUEUE_MAX_PAYLOAD_BYTES,
      "maxPayloadBytes",
    ),
    maxAuditEvents: tightenedPositive(
      options.maxAuditEvents,
      DEFAULT_OFFLINE_EDIT_QUEUE_MAX_AUDIT_EVENTS,
      "maxAuditEvents",
    ),
    maxDependencies: tightenedPositive(
      options.maxDependencies,
      DEFAULT_OFFLINE_EDIT_QUEUE_MAX_DEPENDENCIES,
      "maxDependencies",
    ),
  };
}

async function prepareEdit(input: EnqueueOfflineEditInput, options: NormalizedQueueOptions): Promise<PreparedEdit> {
  const record = plainRecord(input, "input");
  allowedKeys(record, ENQUEUE_KEYS, "input");
  const authorizationScopeDigest = requiredDigest(record.authorizationScopeDigest, "authorizationScopeDigest");
  const sourceId = requiredPersistedIdentity(record.sourceId, "sourceId");
  const idempotencyKey = requiredPersistedIdentity(record.idempotencyKey, "idempotencyKey");
  const edit = captureFeatureEdit(record.edit, options.maxPayloadBytes);
  const dependencyIds = captureDependencies(record.dependencyIds, options.maxDependencies);
  const identity = { authorizationScopeDigest, sourceId, idempotencyKey };
  const request = { ...identity, edit, dependencyIds };
  const [id, requestFingerprint] = await Promise.all([
    sha256(`honua-offline-edit:v1:${canonicalJson(identity)}`),
    sha256(`honua-offline-edit-request:v1:${canonicalJson(request)}`),
  ]);
  if (dependencyIds.includes(id))
    fail("invalid-edit", "Offline edit cannot depend on itself.", { path: "dependencyIds" });
  return { id, requestFingerprint, ...request };
}

function enqueueRecord(
  records: readonly OfflineQueuedEdit[],
  tombstones: ReadonlyMap<string, OfflineEditQueueTombstone>,
  prepared: PreparedEdit,
  now: string,
  options: NormalizedQueueOptions,
): { readonly result: OfflineEditEnqueueResult; readonly record?: OfflineQueuedEdit } {
  const existing = records.find((record) => record.id === prepared.id);
  const byId = new Map(records.map((record) => [record.id, record]));
  return enqueuePreparedRecord(
    existing,
    prepared.dependencyIds.map((id) => byId.get(id) ?? tombstones.get(id)),
    records.length,
    prepared,
    now,
    options,
  );
}

function enqueuePreparedRecord(
  existing: OfflineQueuedEdit | undefined,
  dependencies: readonly (OfflineEditDependencyEvidence | undefined)[],
  queueSize: number,
  prepared: PreparedEdit,
  now: string,
  options: NormalizedQueueOptions,
): { readonly result: OfflineEditEnqueueResult; readonly record?: OfflineQueuedEdit } {
  if (existing) {
    if (existing.requestFingerprint !== prepared.requestFingerprint) {
      fail("idempotency-conflict", "Idempotency key was reused for a different offline edit.", {
        editId: prepared.id,
      });
    }
    return { result: { status: "duplicate", edit: existing } };
  }
  if (queueSize >= options.maxEdits) fail("queue-limit-exceeded", "Offline edit queue limit exceeded.");
  for (let index = 0; index < prepared.dependencyIds.length; index += 1) {
    const dependencyId = prepared.dependencyIds[index];
    const dependency = dependencies[index];
    if (dependency?.id !== dependencyId) {
      fail("dependency-not-found", `Offline edit dependency "${dependencyId}" was not found.`, {
        editId: prepared.id,
      });
    }
    if (!matchesPartition(dependency, prepared)) {
      fail("invalid-edit", `Offline edit dependency "${dependencyId}" belongs to another partition.`, {
        editId: prepared.id,
        path: `dependencyIds[${index}]`,
      });
    }
    const state = dependencyState(dependency);
    if (state === "conflicted" || state === "cancelled") {
      fail("invalid-edit", `Offline edit dependency "${dependencyId}" did not complete successfully.`, {
        editId: prepared.id,
        path: `dependencyIds[${index}]`,
      });
    }
  }
  const record: OfflineQueuedEdit = deepFreeze({
    version: HONUA_OFFLINE_EDIT_QUEUE_VERSION,
    ...prepared,
    state: "pending",
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    audit: [{ sequence: 1, kind: "enqueued", at: now, attempt: 0 }],
  });
  return { result: { status: "enqueued", edit: record }, record };
}

function claimRecords(
  records: readonly OfflineQueuedEdit[],
  tombstones: ReadonlyMap<string, OfflineEditQueueTombstone>,
  input: ClaimOfflineEditsOptions,
  options: NormalizedQueueOptions,
): { readonly claimed: readonly OfflineQueuedEdit[]; readonly changed: readonly OfflineQueuedEdit[] } {
  const normalized = captureClaimOptions(input, options);
  const nowMs = normalized.now.getTime();
  const byId = new Map(records.map((record) => [record.id, record]));
  const eligible = sortedRecords(records).filter((record) => {
    if (!matchesPartition(record, normalized)) return false;
    if (
      !record.dependencyIds.every(
        (id) => byId.get(id)?.state === "applied" || tombstones.get(id)?.terminalState === "applied",
      )
    )
      return false;
    if (record.state === "pending") return true;
    if (record.state === "retryable") return Date.parse(record.retry?.retryAt ?? "") <= nowMs;
    return record.state === "leased" && Date.parse(record.lease?.expiresAt ?? "") <= nowMs;
  });
  const claimed: OfflineQueuedEdit[] = [];
  for (const record of eligible.slice(0, normalized.limit)) claimed.push(claimRecord(record, normalized, options));
  return { claimed, changed: claimed };
}

function claimRecord(
  record: OfflineQueuedEdit,
  claim: NormalizedClaimOptions,
  options: NormalizedQueueOptions,
): OfflineQueuedEdit {
  const reclaimed = record.state === "leased";
  const token = requiredString(options.createLeaseToken(), "leaseToken");
  const at = claim.now.toISOString();
  const expiresAt = new Date(claim.now.getTime() + claim.leaseDurationMs).toISOString();
  const attemptCount = record.attemptCount + 1;
  return deepFreeze({
    ...record,
    state: "leased" as const,
    updatedAt: at,
    attemptCount,
    lease: { token, workerId: claim.workerId, expiresAt },
    retry: undefined,
    audit: appendAudit(
      record,
      {
        kind: reclaimed ? "lease-reclaimed" : "claimed",
        at,
        attempt: attemptCount,
        workerId: claim.workerId,
      },
      options,
    ),
  });
}

function transitionRecord(
  record: OfflineQueuedEdit,
  leaseToken: string,
  state: "applied" | "retryable" | "conflicted",
  input: MarkOfflineEditAppliedInput | MarkOfflineEditRetryInput | MarkOfflineEditConflictedInput,
  options: NormalizedQueueOptions,
): OfflineQueuedEdit {
  const token = requiredString(leaseToken, "leaseToken");
  const now = validNow(options.now);
  if (record.state !== "leased" || !record.lease) {
    fail("invalid-transition", "Offline edit is not currently leased.", { editId: record.id });
  }
  if (record.lease.token !== token)
    fail("lease-mismatch", "Offline edit lease token does not match.", { editId: record.id });
  if (Date.parse(record.lease.expiresAt) <= now.getTime()) {
    fail("lease-expired", "Offline edit lease has expired.", { editId: record.id });
  }
  const at = now.toISOString();
  if (state === "applied") {
    const outcome = captureApplied(input as MarkOfflineEditAppliedInput, at);
    return deepFreeze({
      ...record,
      state,
      updatedAt: at,
      lease: undefined,
      retry: undefined,
      applied: outcome,
      audit: appendAudit(
        record,
        {
          kind: "applied",
          at,
          attempt: record.attemptCount,
          ...(outcome.serverOperationId ? { serverOperationId: outcome.serverOperationId } : {}),
          ...(outcome.serverGeneration ? { serverGeneration: outcome.serverGeneration } : {}),
        },
        options,
      ),
    });
  }
  if (state === "retryable") {
    const outcome = captureRetry(input as MarkOfflineEditRetryInput, now);
    return deepFreeze({
      ...record,
      state,
      updatedAt: at,
      lease: undefined,
      retry: outcome,
      audit: appendAudit(
        record,
        { kind: "retry-scheduled", at, attempt: record.attemptCount, reasonCode: outcome.reasonCode },
        options,
      ),
    });
  }
  const outcome = captureConflict(input as MarkOfflineEditConflictedInput, at);
  return deepFreeze({
    ...record,
    state,
    updatedAt: at,
    lease: undefined,
    retry: undefined,
    conflict: outcome,
    // A record is conflicted or resolved, never both: a requeued edit that
    // conflicts again opens a new conflict, and the closure of the previous one
    // stays where the history belongs, in `audit`.
    conflictResolution: undefined,
    audit: appendAudit(
      record,
      {
        kind: "conflicted",
        at,
        attempt: record.attemptCount,
        conflictId: outcome.conflictId,
        ...(outcome.serverGeneration ? { serverGeneration: outcome.serverGeneration } : {}),
      },
      options,
    ),
  });
}

function cancelRecord(
  record: OfflineQueuedEdit,
  input: CancelOfflineEditInput,
  options: NormalizedQueueOptions,
): OfflineQueuedEdit {
  if (record.state !== "pending" && record.state !== "retryable") {
    fail("invalid-transition", "Only pending or retryable offline edits can be cancelled.", { editId: record.id });
  }
  const value = plainRecord(input, "outcome");
  allowedKeys(value, CANCEL_KEYS, "outcome");
  const reasonCode = requiredString(value.reasonCode, "reasonCode");
  const at = timestamp(options.now);
  return deepFreeze({
    ...record,
    state: "cancelled" as const,
    updatedAt: at,
    retry: undefined,
    cancellation: { cancelledAt: at, reasonCode },
    audit: appendAudit(record, { kind: "cancelled", at, attempt: record.attemptCount, reasonCode }, options),
  });
}

/**
 * Close a conflicted record's conflict with a reviewed choice.
 *
 * Three properties make the transition safe to trust:
 *
 * - **It is bound to the conflict it claims to close.** A resolution naming a
 *   different `conflictId` than the record carries is refused, so a review of a
 *   conflict the queue has already replaced cannot land on the newer one.
 * - **It leaves no conflicted state behind.** `conflict` is cleared and its
 *   identity, detection time, and server generation move into the resolution,
 *   so nothing that reads conflicted records — a replay pass, the local-first
 *   status, the sync-conflict projection — can re-surface a closed conflict.
 * - **It is honest about delivery.** The resolution is recorded as
 *   `unacknowledged-by-server`, because nothing here reaches a server. A
 *   requeued edit is re-delivered by an ordinary replay pass; a discarded one
 *   is terminal and was never delivered at all.
 */
function resolveConflictRecord(
  record: OfflineQueuedEdit,
  input: ResolveOfflineEditConflictInput,
  options: NormalizedQueueOptions,
): OfflineQueuedEdit {
  if (record.state !== "conflicted" || !record.conflict) {
    fail("invalid-transition", "Only a conflicted offline edit can have its conflict resolved.", { editId: record.id });
  }
  const value = plainRecord(input, "resolution");
  allowedKeys(value, RESOLVE_CONFLICT_KEYS, "resolution");
  const conflictId = requiredString(value.conflictId, "resolution.conflictId");
  if (conflictId !== record.conflict.conflictId) {
    fail("invalid-edit", "resolution.conflictId does not match the conflict this edit carries.", {
      editId: record.id,
      path: "resolution.conflictId",
    });
  }
  const choice = value.choice;
  if (choice !== "accept-client" && choice !== "accept-server" && choice !== "discard") {
    fail("invalid-edit", "resolution.choice must be accept-client, accept-server, or discard.", {
      editId: record.id,
      path: "resolution.choice",
    });
  }
  const resolvedBy =
    value.resolvedBy === undefined ? undefined : requiredPersistedIdentity(value.resolvedBy, "resolution.resolvedBy");
  const note = value.note === undefined ? undefined : requiredPersistedLabel(value.note, "resolution.note");

  const at = timestamp(options.now);
  const requeued = choice === "accept-client";
  const resolution: OfflineEditConflictResolutionOutcome = {
    conflictId,
    detectedAt: record.conflict.detectedAt,
    ...(record.conflict.serverGeneration === undefined ? {} : { serverGeneration: record.conflict.serverGeneration }),
    choice,
    disposition: requeued ? "requeued" : "discarded",
    acknowledgement: "unacknowledged-by-server",
    resolvedAt: at,
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
    ...(note === undefined ? {} : { note }),
  };
  const audit = appendAudit(
    record,
    { kind: "conflict-resolved", at, attempt: record.attemptCount, conflictId, resolutionChoice: choice },
    options,
  );
  if (requeued) {
    return deepFreeze({
      ...record,
      state: "pending" as const,
      updatedAt: at,
      lease: undefined,
      retry: undefined,
      conflict: undefined,
      conflictResolution: resolution,
      audit,
    });
  }
  return deepFreeze({
    ...record,
    state: "cancelled" as const,
    updatedAt: at,
    lease: undefined,
    retry: undefined,
    conflict: undefined,
    conflictResolution: resolution,
    cancellation: { cancelledAt: at, reasonCode: `conflict-resolved:${choice}` },
    audit,
  });
}

function captureFeatureEdit(value: unknown, maxPayloadBytes: number): OfflineFeatureEdit {
  const record = plainRecord(value, "edit");
  allowedKeys(record, FEATURE_EDIT_KEYS, "edit");
  const operation = record.operation;
  if (operation !== "add" && operation !== "update" && operation !== "delete") {
    fail("invalid-edit", "edit.operation is invalid.", { path: "edit.operation" });
  }
  const featureId = captureFeatureId(record.featureId, operation);
  const budget: JsonCaptureBudget = { nodes: 0, bytes: 0, maxBytes: maxPayloadBytes };
  const capturedAttributes =
    record.attributes === undefined ? undefined : cloneJson(record.attributes, "edit.attributes", 0, budget);
  const attributes =
    capturedAttributes === undefined
      ? undefined
      : (plainRecord(capturedAttributes, "edit.attributes") as Readonly<Record<string, OfflineEditJsonValue>>);
  const geometry = record.geometry === undefined ? undefined : cloneJson(record.geometry, "edit.geometry", 0, budget);
  if (operation === "delete" && (attributes !== undefined || geometry !== undefined)) {
    fail("invalid-edit", "Delete edits cannot contain attributes or geometry.", { path: "edit" });
  }
  if (operation !== "delete" && attributes === undefined && geometry === undefined) {
    fail("invalid-edit", "Add and update edits require attributes and/or geometry.", { path: "edit" });
  }
  const edit = {
    operation,
    ...(featureId !== undefined ? { featureId } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(geometry !== undefined ? { geometry } : {}),
  } satisfies OfflineFeatureEdit;
  if (encoder.encode(canonicalJson(edit)).byteLength > maxPayloadBytes) {
    fail("invalid-edit", "Offline edit payload exceeds maxPayloadBytes.", { path: "edit" });
  }
  return deepFreeze(edit);
}

function captureFeatureId(value: unknown, operation: OfflineEditOperation): string | number | undefined {
  if (value === undefined) {
    if (operation !== "add") fail("invalid-edit", `${operation} edits require featureId.`, { path: "edit.featureId" });
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") return requiredString(value, "edit.featureId");
  fail("invalid-edit", "edit.featureId must be a string or safe integer.", { path: "edit.featureId" });
}

function captureDependencies(value: unknown, maximum: number): readonly `sha256:${string}`[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("invalid-edit", "dependencyIds must be an array.", { path: "dependencyIds" });
  }
  if (value.length > maximum) {
    fail("invalid-edit", `dependencyIds must contain at most ${maximum} entries.`, { path: "dependencyIds" });
  }
  const dependencies = denseArray(value, "dependencyIds");
  const ids = dependencies.map((id, index) => requiredDigest(id, `dependencyIds[${index}]`));
  const unique = [...new Set(ids)].sort(compareCodeUnits);
  if (unique.length !== ids.length)
    fail("invalid-edit", "dependencyIds cannot contain duplicates.", { path: "dependencyIds" });
  return deepFreeze(unique);
}

function captureApplied(value: MarkOfflineEditAppliedInput, appliedAt: string): OfflineEditAppliedOutcome {
  const record = plainRecord(value, "outcome");
  allowedKeys(record, APPLIED_KEYS, "outcome");
  return {
    appliedAt,
    ...(record.serverOperationId === undefined
      ? {}
      : { serverOperationId: requiredString(record.serverOperationId, "serverOperationId") }),
    ...(record.serverGeneration === undefined
      ? {}
      : { serverGeneration: requiredString(record.serverGeneration, "serverGeneration") }),
  };
}

function captureRetry(value: MarkOfflineEditRetryInput, now: Date): OfflineEditRetry {
  const record = plainRecord(value, "outcome");
  allowedKeys(record, RETRY_KEYS, "outcome");
  const retryAt = normalizedTimestamp(record.retryAt, "retryAt");
  if (Date.parse(retryAt) < now.getTime()) fail("invalid-edit", "retryAt cannot be in the past.", { path: "retryAt" });
  return { retryAt, reasonCode: requiredString(record.reasonCode, "reasonCode") };
}

function captureConflict(value: MarkOfflineEditConflictedInput, detectedAt: string): OfflineEditConflictOutcome {
  const record = plainRecord(value, "outcome");
  allowedKeys(record, CONFLICT_KEYS, "outcome");
  return {
    conflictId: requiredString(record.conflictId, "conflictId"),
    detectedAt,
    ...(record.serverGeneration === undefined
      ? {}
      : { serverGeneration: requiredString(record.serverGeneration, "serverGeneration") }),
  };
}

function appendAudit(
  record: OfflineQueuedEdit,
  event: Omit<OfflineEditAuditEvent, "sequence">,
  options: NormalizedQueueOptions,
): readonly OfflineEditAuditEvent[] {
  const sequence = (record.audit.at(-1)?.sequence ?? 0) + 1;
  const history = [...record.audit, { sequence, ...event }];
  return history.slice(-options.maxAuditEvents);
}

function sortedRecords(records: readonly OfflineQueuedEdit[]): readonly OfflineQueuedEdit[] {
  return [...records].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || compareCodeUnits(left.id, right.id),
  );
}

function captureClaimOptions(value: ClaimOfflineEditsOptions, options: NormalizedQueueOptions): NormalizedClaimOptions {
  const record = plainRecord(value, "options");
  allowedKeys(record, CLAIM_KEYS, "options");
  const partition = partitionFromRecord(record, "options");
  const limit = boundedOperationLimit(record.limit, "limit", false);
  const leaseDurationMs = positiveInteger(record.leaseDurationMs, "leaseDurationMs");
  if (leaseDurationMs > MAX_OFFLINE_EDIT_LEASE_DURATION_MS) {
    fail("invalid-edit", "leaseDurationMs cannot exceed 24 hours.", { path: "leaseDurationMs" });
  }
  return {
    ...partition,
    workerId: requiredString(record.workerId, "workerId"),
    limit,
    leaseDurationMs,
    now: validNow(options.now),
  };
}

function captureListOptions(value: ListOfflineEditsOptions): {
  readonly partition: OfflineEditQueuePartition;
  readonly limit: number;
} {
  const record = plainRecord(value, "options");
  allowedKeys(record, LIST_KEYS, "options");
  return {
    partition: partitionFromRecord(record, "options"),
    limit: boundedOperationLimit(record.limit, "limit", true),
  };
}

function capturePruneOptions(value: PruneTerminalOfflineEditsOptions): NormalizedPruneOptions {
  const record = plainRecord(value, "options");
  allowedKeys(record, PRUNE_KEYS, "options");
  const terminalBefore = normalizedTimestamp(record.terminalBefore, "terminalBefore");
  return {
    ...partitionFromRecord(record, "options"),
    terminalBefore,
    terminalBeforeMs: Date.parse(terminalBefore),
    limit: boundedOperationLimit(record.limit, "limit", true),
  };
}

function capturePartition(value: OfflineEditQueuePartition, path: string): OfflineEditQueuePartition {
  const record = plainRecord(value, path);
  allowedKeys(record, new Set(PARTITION_KEYS), path);
  return partitionFromRecord(record, path);
}

function partitionFromRecord(record: Record<string, unknown>, path: string): OfflineEditQueuePartition {
  return {
    authorizationScopeDigest: requiredDigest(record.authorizationScopeDigest, `${path}.authorizationScopeDigest`),
    sourceId: requiredPersistedIdentity(record.sourceId, `${path}.sourceId`),
  };
}

function boundedOperationLimit(value: unknown, path: string, optional: boolean): number {
  const limit = value === undefined && optional ? 100 : positiveInteger(value, path);
  if (limit > 100) fail("invalid-edit", `${path} cannot exceed 100.`, { path });
  return limit;
}

function matchesPartition(
  record: Pick<OfflineQueuedEdit, "authorizationScopeDigest" | "sourceId">,
  partition: OfflineEditQueuePartition,
): boolean {
  return (
    record.authorizationScopeDigest === partition.authorizationScopeDigest && record.sourceId === partition.sourceId
  );
}

function metadataFor(record: OfflineQueuedEdit): OfflineEditQueueMetadata {
  return {
    id: record.id,
    authorizationScopeDigest: record.authorizationScopeDigest,
    sourceId: record.sourceId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    dependencyIds: record.dependencyIds,
    ...(record.retry ? { retryAt: record.retry.retryAt } : {}),
    ...(record.lease ? { leaseExpiresAt: record.lease.expiresAt } : {}),
  };
}

function tombstoneFor(record: OfflineQueuedEdit, prunedAt: string): OfflineEditQueueTombstone {
  if (!isTerminal(record.state)) {
    fail("invalid-transition", "Only terminal offline edits can be pruned.", { editId: record.id });
  }
  return {
    id: record.id,
    requestFingerprint: record.requestFingerprint,
    authorizationScopeDigest: record.authorizationScopeDigest,
    sourceId: record.sourceId,
    prunedAt,
    terminalState: record.state,
  };
}

function rejectPrunedIdentity(tombstone: OfflineEditQueueTombstone | undefined, prepared: PreparedEdit): void {
  if (!tombstone) return;
  if (tombstone.requestFingerprint !== prepared.requestFingerprint) {
    fail("idempotency-conflict", "Idempotency key was reused for a different pruned offline edit.", {
      editId: prepared.id,
    });
  }
  fail("edit-pruned", "Offline edit identity was already completed and pruned; it cannot be enqueued again.", {
    editId: prepared.id,
  });
}

function dependencyState(evidence: OfflineEditDependencyEvidence): OfflineQueuedEditState {
  return "terminalState" in evidence ? evidence.terminalState : evidence.state;
}

async function scanPartitionIds(
  store: IDBObjectStore,
  partition: OfflineEditQueuePartition,
  limit: number,
  tally: RecoveryTally,
): Promise<readonly `sha256:${string}`[]> {
  const index = store.index(PARTITION_ORDER_INDEX);
  let cursor = await request<IDBCursorWithValue | null>(index.openCursor(partitionRange(partition)));
  const ids: `sha256:${string}`[] = [];
  while (cursor && ids.length < limit) {
    const metadata = readStoredMetadata(cursor.value, tally);
    if (metadata) ids.push(metadata.id);
    cursor = await continueCursor(cursor);
  }
  return ids;
}

async function scanReadyMetadata(
  metadataStore: IDBObjectStore,
  tombstoneStore: IDBObjectStore,
  options: NormalizedClaimOptions,
  tally: RecoveryTally,
): Promise<readonly OfflineEditQueueMetadata[]> {
  const states = ["pending", "retryable", "leased"] as const;
  const cache = new Map<string, OfflineEditDependencyEvidence | undefined>();
  const candidates = (
    await Promise.all(
      states.map((state) => scanReadyState(metadataStore, tombstoneStore, state, options, cache, tally)),
    )
  ).flat();
  return candidates.sort(compareMetadataCreated).slice(0, options.limit);
}

async function scanReadyState(
  metadataStore: IDBObjectStore,
  tombstoneStore: IDBObjectStore,
  state: "pending" | "retryable" | "leased",
  options: NormalizedClaimOptions,
  cache: Map<string, OfflineEditDependencyEvidence | undefined>,
  tally: RecoveryTally,
): Promise<readonly OfflineEditQueueMetadata[]> {
  const index = metadataStore.index(PARTITION_STATE_ORDER_INDEX);
  let cursor = await request<IDBCursorWithValue | null>(index.openCursor(partitionStateRange(options, state)));
  const candidates: OfflineEditQueueMetadata[] = [];
  while (cursor && candidates.length < options.limit) {
    const metadata = readStoredMetadata(cursor.value, tally);
    const eligibleAt =
      metadata !== undefined &&
      (state === "pending"
        ? true
        : Date.parse(state === "retryable" ? (metadata.retryAt ?? "") : (metadata.leaseExpiresAt ?? "")) <=
          options.now.getTime());
    if (
      metadata &&
      eligibleAt &&
      (await dependenciesAreApplied(metadataStore, tombstoneStore, metadata.dependencyIds, cache, tally))
    ) {
      candidates.push(metadata);
    }
    cursor = await continueCursor(cursor);
  }
  return candidates;
}

async function dependenciesAreApplied(
  metadataStore: IDBObjectStore,
  tombstoneStore: IDBObjectStore,
  dependencyIds: readonly `sha256:${string}`[],
  cache: Map<string, OfflineEditDependencyEvidence | undefined>,
  tally: RecoveryTally,
): Promise<boolean> {
  for (const id of dependencyIds) {
    let dependency = cache.get(id);
    if (!cache.has(id)) {
      dependency = readStoredMetadata(await request<unknown>(metadataStore.get(id)), tally);
      dependency ??= readStoredTombstone(await request<unknown>(tombstoneStore.get(id)), tally);
      cache.set(id, dependency);
    }
    if (!dependency || dependencyState(dependency) !== "applied") return false;
  }
  return true;
}

function terminalPruneCandidates(
  records: readonly OfflineQueuedEdit[],
  options: NormalizedPruneOptions,
): readonly OfflineQueuedEdit[] {
  return records
    .filter(
      (record) =>
        matchesPartition(record, options) &&
        isTerminal(record.state) &&
        Date.parse(record.updatedAt) <= options.terminalBeforeMs,
    )
    .sort(compareUpdated);
}

function hasActiveDependent(records: readonly OfflineQueuedEdit[], editId: `sha256:${string}`): boolean {
  return records.some((record) => !isTerminal(record.state) && record.dependencyIds.includes(editId));
}

async function scanTerminalMetadata(
  store: IDBObjectStore,
  options: NormalizedPruneOptions,
  tally: RecoveryTally,
): Promise<readonly OfflineEditQueueMetadata[]> {
  const candidates: OfflineEditQueueMetadata[] = [];
  for (const state of ["applied", "conflicted", "cancelled"] as const) {
    const index = store.index(PARTITION_STATE_ORDER_INDEX);
    let cursor = await request<IDBCursorWithValue | null>(index.openCursor(partitionStateRange(options, state)));
    while (cursor) {
      const metadata = readStoredMetadata(cursor.value, tally);
      if (metadata && Date.parse(metadata.updatedAt) <= options.terminalBeforeMs) {
        candidates.push(metadata);
      }
      cursor = await continueCursor(cursor);
    }
  }
  return candidates.sort(compareMetadataUpdated);
}

async function hasActiveMetadataDependent(store: IDBObjectStore, editId: string): Promise<boolean> {
  let cursor = await request<IDBCursorWithValue | null>(
    store.index(DEPENDENCY_INDEX).openCursor(IDBKeyRange.only(editId)),
  );
  while (cursor) {
    if (!isTerminal((cursor.value as OfflineEditQueueMetadata).state)) return true;
    cursor = await continueCursor(cursor);
  }
  return false;
}

function partitionRange(partition: OfflineEditQueuePartition): IDBKeyRange {
  return compoundPrefixRange([partition.authorizationScopeDigest, partition.sourceId]);
}

function partitionStateRange(partition: OfflineEditQueuePartition, state: OfflineQueuedEditState): IDBKeyRange {
  return compoundPrefixRange([partition.authorizationScopeDigest, partition.sourceId, state]);
}

function compoundPrefixRange(prefix: readonly IDBValidKey[]): IDBKeyRange {
  return IDBKeyRange.bound([...prefix], [...prefix, []]);
}

function continueCursor(cursor: IDBCursorWithValue): Promise<IDBCursorWithValue | null> {
  const cursorRequest = cursor.request as IDBRequest<IDBCursorWithValue | null>;
  return new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => resolve(cursorRequest.result);
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("Offline edit queue cursor failed."));
    cursor.continue();
  });
}

function isTerminal(state: OfflineQueuedEditState): state is "applied" | "conflicted" | "cancelled" {
  return state === "applied" || state === "conflicted" || state === "cancelled";
}

function compareMetadataCreated(left: OfflineEditQueueMetadata, right: OfflineEditQueueMetadata): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || compareCodeUnits(left.id, right.id);
}

function compareMetadataUpdated(left: OfflineEditQueueMetadata, right: OfflineEditQueueMetadata): number {
  return Date.parse(left.updatedAt) - Date.parse(right.updatedAt) || compareCodeUnits(left.id, right.id);
}

function compareUpdated(left: OfflineQueuedEdit, right: OfflineQueuedEdit): number {
  return Date.parse(left.updatedAt) - Date.parse(right.updatedAt) || compareCodeUnits(left.id, right.id);
}

// --- Persisted-record validation and recovery (issue #1045) ------------------
//
// The queue is the durable source of retry, lease, dependency, conflict, and
// audit state for the whole local-first write path. It is therefore the one
// store where a silently accepted malformed record becomes a *wrong write*
// rather than a lost read, so nothing persisted is trusted on the way back in:
// every read path validates the record's version, identity, state, and timing
// fields before the record can be leased, transitioned, or replayed.
//
// Two rules bound what validation may look at. It never reads an
// `edit.attributes` or `edit.geometry` *value* — only whether the key is
// present, which is what the delete-shape rule needs — and no message, count, or
// report ever echoes a payload. That is the same secret-safe projection the
// local-first status contract already relies on.

interface RecoveryBudget {
  records: number;
  bytes: number;
  readonly maxRecords: number;
  readonly maxBytes: number;
}

interface RecoveryTally {
  inspected: number;
  discarded: number;
  repaired: number;
  readonly discardedByReason: Record<OfflineEditQueueDiscardReason, number>;
  readonly repairedByReason: Record<OfflineEditQueueRepairReason, number>;
}

const AUDIT_KINDS = new Set<string>([
  "enqueued",
  "claimed",
  "lease-reclaimed",
  "retry-scheduled",
  "applied",
  "conflicted",
  "conflict-resolved",
  "cancelled",
]);
const RESOLUTION_CHOICES = new Set<string>(["accept-client", "accept-server", "discard"]);
const RESOLUTION_DISPOSITIONS = new Set<string>(["requeued", "discarded"]);
const STORED_STATES = new Set<string>(QUEUE_STATES);
const TERMINAL_STATES = new Set<string>(["applied", "conflicted", "cancelled"]);
/** Depth ceiling for byte accounting only; validation never descends a payload. */
const RECOVERY_MEASURE_DEPTH = 64;

/**
 * Validate one persisted edit record before anything may act on it.
 *
 * The version gate runs first: a record written by another SDK build is
 * `foreign-version` and is never returned as though it were current, because a
 * field this build reads may mean something else in the layout that wrote it.
 */
export function inspectStoredOfflineEdit(value: unknown): OfflineEditQueueInspection<OfflineQueuedEdit> {
  if (!isStoredRecord(value)) return invalidRecord("corrupt-record");
  if (value.version !== HONUA_OFFLINE_EDIT_QUEUE_VERSION) return invalidRecord("foreign-version");
  if (!isDigest(value.id) || !isDigest(value.requestFingerprint) || !isDigest(value.authorizationScopeDigest)) {
    return invalidRecord("corrupt-record");
  }
  if (!isPersistedText(value.sourceId) || !isPersistedText(value.idempotencyKey))
    return invalidRecord("corrupt-record");
  if (screenPersistedString(value.sourceId, "identity") || screenPersistedString(value.idempotencyKey, "identity")) {
    return invalidRecord("credential-screened");
  }
  if (typeof value.state !== "string" || !STORED_STATES.has(value.state)) return invalidRecord("corrupt-record");
  if (!isNormalizedTimestamp(value.createdAt) || !isNormalizedTimestamp(value.updatedAt)) {
    return invalidRecord("corrupt-record");
  }
  if (!Number.isSafeInteger(value.attemptCount) || (value.attemptCount as number) < 0) {
    return invalidRecord("corrupt-record");
  }
  if (!isStoredDependencyIds(value.dependencyIds, value.id)) return invalidRecord("corrupt-record");
  if (!isStoredFeatureEdit(value.edit)) return invalidRecord("corrupt-record");
  if (!isStoredOutcome(value)) return invalidRecord("corrupt-record");
  // The reviewer-authored members of a resolution are the only free text the
  // queue persists, so they are screened on the way back in as well as on the
  // way out: a database another tab or build wrote is not trusted here either.
  if (isCredentialShapedResolution(value.conflictResolution)) return invalidRecord("credential-screened");
  if (!isStoredAudit(value.audit)) return invalidRecord("corrupt-record");
  return { status: "valid", record: value as unknown as OfflineQueuedEdit };
}

/** Validate one persisted metadata index row. */
export function inspectStoredOfflineEditMetadata(value: unknown): OfflineEditQueueInspection<OfflineEditQueueMetadata> {
  if (!isStoredRecord(value)) return invalidRecord("corrupt-record");
  if (!isDigest(value.id) || !isDigest(value.authorizationScopeDigest)) return invalidRecord("corrupt-record");
  if (!isPersistedText(value.sourceId)) return invalidRecord("corrupt-record");
  if (screenPersistedString(value.sourceId, "identity")) return invalidRecord("credential-screened");
  if (typeof value.state !== "string" || !STORED_STATES.has(value.state)) return invalidRecord("corrupt-record");
  if (!isNormalizedTimestamp(value.createdAt) || !isNormalizedTimestamp(value.updatedAt)) {
    return invalidRecord("corrupt-record");
  }
  if (!isStoredDependencyIds(value.dependencyIds, value.id)) return invalidRecord("corrupt-record");
  if (!isOptionalTimestamp(value.retryAt) || !isOptionalTimestamp(value.leaseExpiresAt)) {
    return invalidRecord("corrupt-record");
  }
  return { status: "valid", record: value as unknown as OfflineEditQueueMetadata };
}

/**
 * Validate one persisted tombstone.
 *
 * Tombstones exist precisely so a pruned identity cannot be re-enqueued, so a
 * valid one is always preserved by recovery rather than treated as an orphan.
 */
export function inspectStoredOfflineEditTombstone(
  value: unknown,
): OfflineEditQueueInspection<OfflineEditQueueTombstone> {
  if (!isStoredRecord(value)) return invalidRecord("corrupt-record");
  if (!isDigest(value.id) || !isDigest(value.requestFingerprint) || !isDigest(value.authorizationScopeDigest)) {
    return invalidRecord("corrupt-record");
  }
  if (!isPersistedText(value.sourceId)) return invalidRecord("corrupt-record");
  if (screenPersistedString(value.sourceId, "identity")) return invalidRecord("credential-screened");
  if (!isNormalizedTimestamp(value.prunedAt)) return invalidRecord("corrupt-record");
  if (typeof value.terminalState !== "string" || !TERMINAL_STATES.has(value.terminalState)) {
    return invalidRecord("corrupt-record");
  }
  return { status: "valid", record: value as unknown as OfflineEditQueueTombstone };
}

/**
 * Plan one bounded recovery pass over every persisted row.
 *
 * Pure and deterministic, so the same rows always produce the same mutation
 * set, and so a healthy database plans nothing at all. The edit/metadata
 * relationship is repaired rather than abandoned in both directions: a metadata
 * row whose edit is gone is deleted, and an edit whose metadata row is missing
 * or disagrees has its index row re-derived from the edit itself. That is what
 * keeps a claim from throwing `Offline edit metadata references missing edit`
 * halfway through a replay pass.
 */
export function planOfflineEditQueueRecovery(
  rows: OfflineEditQueueRecoveryRowsV1,
  limits: OfflineEditQueueRecoveryLimits = {},
): OfflineEditQueueRecoveryPlanV1 {
  const budget: RecoveryBudget = {
    records: 0,
    bytes: 0,
    maxRecords: tightenedPositive(
      limits.maxRecords,
      DEFAULT_OFFLINE_EDIT_QUEUE_MAX_RECOVERY_RECORDS,
      "recovery.maxRecords",
    ),
    maxBytes: tightenedPositive(limits.maxBytes, DEFAULT_OFFLINE_EDIT_QUEUE_MAX_RECOVERY_BYTES, "recovery.maxBytes"),
  };
  const tally = emptyTally();
  const deleteEditKeys: string[] = [];
  const deleteMetadataKeys: string[] = [];
  const deleteTombstoneKeys: string[] = [];
  const putMetadata: OfflineEditQueueMetadata[] = [];
  const live = new Map<string, OfflineQueuedEdit>();

  for (const row of rows.edits) {
    charge(row, budget, tally);
    const inspection = inspectStoredOfflineEdit(row.value);
    // A record stored under a key other than its own id cannot be addressed by
    // the id it claims, so it is unusable however well-formed it looks.
    if (inspection.status === "invalid" || inspection.record.id !== row.key) {
      deleteEditKeys.push(row.key);
      discard(tally, inspection.status === "invalid" ? inspection.reason : "corrupt-record");
      continue;
    }
    live.set(inspection.record.id, inspection.record);
  }

  const indexed = new Set<string>();
  for (const row of rows.metadata) {
    charge(row, budget, tally);
    const inspection = inspectStoredOfflineEditMetadata(row.value);
    if (inspection.status === "invalid" || inspection.record.id !== row.key) {
      deleteMetadataKeys.push(row.key);
      discard(tally, inspection.status === "invalid" ? inspection.reason : "corrupt-record");
      continue;
    }
    const edit = live.get(inspection.record.id);
    if (!edit) {
      deleteMetadataKeys.push(row.key);
      discard(tally, "orphaned-metadata");
      continue;
    }
    indexed.add(edit.id);
    if (!sameMetadata(inspection.record, metadataFor(edit))) repairMetadata(putMetadata, tally, edit);
  }
  for (const edit of live.values()) {
    if (!indexed.has(edit.id)) repairMetadata(putMetadata, tally, edit);
  }

  for (const row of rows.tombstones) {
    charge(row, budget, tally);
    const inspection = inspectStoredOfflineEditTombstone(row.value);
    if (inspection.status === "invalid" || inspection.record.id !== row.key) {
      deleteTombstoneKeys.push(row.key);
      discard(tally, inspection.status === "invalid" ? inspection.reason : "corrupt-record");
    }
  }

  return {
    report: recoveryReport(tally, "open"),
    deleteEditKeys,
    deleteMetadataKeys,
    deleteTombstoneKeys,
    putMetadata,
  };
}

function repairMetadata(target: OfflineEditQueueMetadata[], tally: RecoveryTally, edit: OfflineQueuedEdit): void {
  target.push(metadataFor(edit));
  tally.repaired += 1;
  tally.repairedByReason["restored-metadata"] += 1;
}

function emptyTally(): RecoveryTally {
  return {
    inspected: 0,
    discarded: 0,
    repaired: 0,
    discardedByReason: {
      "foreign-version": 0,
      "corrupt-record": 0,
      "credential-screened": 0,
      "orphaned-metadata": 0,
    },
    repairedByReason: { "restored-metadata": 0 },
  };
}

function discard(tally: RecoveryTally, reason: OfflineEditQueueDiscardReason): void {
  tally.discarded += 1;
  tally.discardedByReason[reason] += 1;
}

function charge(row: OfflineEditQueueStoredRecord, budget: RecoveryBudget, tally: RecoveryTally): void {
  budget.records += 1;
  tally.inspected += 1;
  if (budget.records > budget.maxRecords) {
    fail("queue-limit-exceeded", `Offline edit queue recovery exceeded ${budget.maxRecords} records.`);
  }
  measureBytes(row.value, budget, 0);
  if (budget.bytes > budget.maxBytes) {
    fail("queue-limit-exceeded", `Offline edit queue recovery exceeded ${budget.maxBytes} bytes.`);
  }
}

/**
 * Accumulate an approximate persisted size with an explicit ceiling, so a
 * damaged or hostile database cannot make recovery scan unboundedly. It reads
 * sizes only — nothing is copied, decoded, or reported — and it stops as soon as
 * the budget is spent, so no oversized string is ever materialized.
 */
function measureBytes(value: unknown, budget: RecoveryBudget, depth: number): void {
  if (budget.bytes > budget.maxBytes || depth > RECOVERY_MEASURE_DEPTH) return;
  if (typeof value === "string") {
    budget.bytes += value.length * 2 + 2;
    return;
  }
  if (value === null || typeof value !== "object") {
    budget.bytes += 8;
    return;
  }
  if (ArrayBuffer.isView(value)) {
    budget.bytes += value.byteLength;
    return;
  }
  budget.bytes += 2;
  if (Array.isArray(value)) {
    for (const entry of value) {
      measureBytes(entry, budget, depth + 1);
      if (budget.bytes > budget.maxBytes) return;
    }
    return;
  }
  for (const key of Object.keys(value)) {
    budget.bytes += key.length * 2 + 3;
    measureBytes((value as Record<string, unknown>)[key], budget, depth + 1);
    if (budget.bytes > budget.maxBytes) return;
  }
}

function recoveryReport(tally: RecoveryTally, operation: "open" | "read"): OfflineEditQueueRecoveryV1 {
  return deepFreeze({
    kind: HONUA_OFFLINE_EDIT_QUEUE_RECOVERY_KIND,
    version: HONUA_OFFLINE_EDIT_QUEUE_RECOVERY_VERSION,
    operation,
    inspectedRecords: tally.inspected,
    discardedRecords: tally.discarded,
    repairedRecords: tally.repaired,
    discardedByReason: { ...tally.discardedByReason },
    repairedByReason: { ...tally.repairedByReason },
    error: new HonuaOfflineEditQueueError(
      "record-unreadable",
      `Offline edit queue recovery discarded ${tally.discarded} unreadable record(s) and repaired ${tally.repaired}.`,
    ),
  });
}

function emitRecovery(
  onRecovery: ((report: OfflineEditQueueRecoveryV1) => void) | undefined,
  tally: RecoveryTally,
  operation: "open" | "read",
): void {
  if (!onRecovery || tally.discarded + tally.repaired === 0) return;
  onRecovery(recoveryReport(tally, operation));
}

function invalidRecord(reason: OfflineEditQueueDiscardReason): OfflineEditQueueInspection<never> {
  return { status: "invalid", reason };
}

function isStoredRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && EDIT_ID_PATTERN.test(value);
}

/** Same shape `requiredString` enforces on write, without throwing. */
function isPersistedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    encoder.encode(value).byteLength <= 1024
  );
}

function isNormalizedTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isNormalizedTimestamp(value);
}

function isStoredDependencyIds(value: unknown, id: unknown): boolean {
  if (!Array.isArray(value) || value.length > DEFAULT_OFFLINE_EDIT_QUEUE_MAX_DEPENDENCIES) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isDigest(entry) || entry === id || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

/**
 * Validate the edit envelope without reading a payload value. Only the presence
 * of `attributes`/`geometry` is consulted, because the delete-shape rule is
 * defined over presence; their contents are never inspected.
 */
function isStoredFeatureEdit(value: unknown): boolean {
  if (!isStoredRecord(value)) return false;
  const operation = value.operation;
  if (operation !== "add" && operation !== "update" && operation !== "delete") return false;
  const featureId = value.featureId;
  if (featureId === undefined) {
    if (operation !== "add") return false;
  } else if (!isPersistedText(featureId) && !Number.isSafeInteger(featureId)) {
    return false;
  }
  const hasAttributes = value.attributes !== undefined;
  const hasGeometry = value.geometry !== undefined;
  if (operation === "delete") return !hasAttributes && !hasGeometry;
  return hasAttributes || hasGeometry;
}

/** A state must carry exactly the outcome its transition wrote, and no other. */
function isStoredOutcome(value: Record<string, unknown>): boolean {
  const state = value.state;
  const lease = value.lease;
  if (state === "leased") {
    if (!isStoredRecord(lease) || !isPersistedText(lease.token) || !isPersistedText(lease.workerId)) return false;
    if (!isNormalizedTimestamp(lease.expiresAt)) return false;
  } else if (lease !== undefined) {
    return false;
  }
  const retry = value.retry;
  if (state === "retryable") {
    if (!isStoredRecord(retry) || !isNormalizedTimestamp(retry.retryAt) || !isPersistedText(retry.reasonCode)) {
      return false;
    }
  } else if (retry !== undefined) {
    return false;
  }
  const applied = value.applied;
  if (state === "applied") {
    if (!isStoredRecord(applied) || !isNormalizedTimestamp(applied.appliedAt)) return false;
  } else if (applied !== undefined) {
    return false;
  }
  const conflict = value.conflict;
  if (state === "conflicted") {
    if (!isStoredRecord(conflict) || !isPersistedText(conflict.conflictId)) return false;
    if (!isNormalizedTimestamp(conflict.detectedAt)) return false;
  } else if (conflict !== undefined) {
    return false;
  }
  const cancellation = value.cancellation;
  if (state === "cancelled") {
    if (!isStoredRecord(cancellation) || !isNormalizedTimestamp(cancellation.cancelledAt)) return false;
    if (!isPersistedText(cancellation.reasonCode)) return false;
  } else if (cancellation !== undefined) {
    return false;
  }
  // A resolution is not gated on one state — a requeued edit carries it while it
  // is delivered again — but it is gated against `conflicted`, because a record
  // that is both conflicted and resolved contradicts itself and would let a
  // closed conflict be surfaced as open.
  return isStoredConflictResolution(value.conflictResolution, state);
}

/** Screens an already shape-validated resolution's reviewer-authored strings. */
function isCredentialShapedResolution(value: unknown): boolean {
  if (!isStoredRecord(value)) return false;
  const resolvedBy = value.resolvedBy;
  if (typeof resolvedBy === "string" && screenPersistedString(resolvedBy, "identity")) return true;
  const note = value.note;
  return typeof note === "string" && screenPersistedString(note, "label") !== undefined;
}

function isStoredConflictResolution(value: unknown, state: unknown): boolean {
  if (value === undefined) return true;
  if (state === "conflicted") return false;
  if (!isStoredRecord(value)) return false;
  if (!isPersistedText(value.conflictId) || !isNormalizedTimestamp(value.detectedAt)) return false;
  if (value.serverGeneration !== undefined && !isPersistedText(value.serverGeneration)) return false;
  if (typeof value.choice !== "string" || !RESOLUTION_CHOICES.has(value.choice)) return false;
  if (typeof value.disposition !== "string" || !RESOLUTION_DISPOSITIONS.has(value.disposition)) return false;
  if (value.acknowledgement !== "unacknowledged-by-server") return false;
  if (!isNormalizedTimestamp(value.resolvedAt)) return false;
  if (value.resolvedBy !== undefined && !isPersistedText(value.resolvedBy)) return false;
  if (value.note !== undefined && !isPersistedText(value.note)) return false;
  // `accept-client` is the only choice that keeps the edit deliverable; the
  // other two abandon it. A record whose disposition disagrees with its choice
  // cannot be trusted to describe what the queue actually did.
  return value.disposition === (value.choice === "accept-client" ? "requeued" : "discarded");
}

function isStoredAudit(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > DEFAULT_OFFLINE_EDIT_QUEUE_MAX_AUDIT_EVENTS) {
    return false;
  }
  let previous = 0;
  for (const entry of value) {
    if (!isStoredRecord(entry)) return false;
    if (!Number.isSafeInteger(entry.sequence) || (entry.sequence as number) <= previous) return false;
    previous = entry.sequence as number;
    if (typeof entry.kind !== "string" || !AUDIT_KINDS.has(entry.kind)) return false;
    if (!isNormalizedTimestamp(entry.at)) return false;
    if (!Number.isSafeInteger(entry.attempt) || (entry.attempt as number) < 0) return false;
  }
  return true;
}

function sameMetadata(left: OfflineEditQueueMetadata, right: OfflineEditQueueMetadata): boolean {
  return (
    left.id === right.id &&
    left.authorizationScopeDigest === right.authorizationScopeDigest &&
    left.sourceId === right.sourceId &&
    left.state === right.state &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.retryAt === right.retryAt &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    left.dependencyIds.length === right.dependencyIds.length &&
    left.dependencyIds.every((id, index) => id === right.dependencyIds[index])
  );
}

/**
 * Read one persisted edit, counting rather than trusting a record that fails
 * validation. Returns `undefined` for a record that must not be acted on, so a
 * record written between recovery passes — by another tab, or by a partially
 * applied write — can never be leased unvalidated.
 */
function readStoredEdit(value: unknown, id: string, tally: RecoveryTally): OfflineQueuedEdit | undefined {
  if (value === undefined) return undefined;
  tally.inspected += 1;
  const inspection = inspectStoredOfflineEdit(value);
  if (inspection.status === "invalid" || inspection.record.id !== id) {
    discard(tally, inspection.status === "invalid" ? inspection.reason : "corrupt-record");
    return undefined;
  }
  return inspection.record;
}

function readStoredTombstone(value: unknown, tally: RecoveryTally): OfflineEditQueueTombstone | undefined {
  if (value === undefined) return undefined;
  tally.inspected += 1;
  const inspection = inspectStoredOfflineEditTombstone(value);
  if (inspection.status === "invalid") {
    discard(tally, inspection.reason);
    return undefined;
  }
  return inspection.record;
}

function readStoredMetadata(value: unknown, tally: RecoveryTally): OfflineEditQueueMetadata | undefined {
  if (value === undefined) return undefined;
  tally.inspected += 1;
  const inspection = inspectStoredOfflineEditMetadata(value);
  if (inspection.status === "invalid") {
    discard(tally, inspection.reason);
    return undefined;
  }
  return inspection.record;
}

/**
 * One bounded startup pass over edits, metadata, and tombstones.
 *
 * Reads are capped at the record ceiling before anything is materialized, so a
 * database past its bounds fails with a typed `queue-limit-exceeded` rather
 * than being scanned. Everything the plan decides is applied inside the single
 * transaction that read it.
 */
async function recoverQueueDatabase(
  database: IDBDatabase,
  limits: OfflineEditQueueRecoveryLimits,
  onRecovery?: (report: OfflineEditQueueRecoveryV1) => void,
): Promise<void> {
  const ceiling =
    tightenedPositive(limits.maxRecords, DEFAULT_OFFLINE_EDIT_QUEUE_MAX_RECOVERY_RECORDS, "recovery.maxRecords") + 1;
  const report = await runTransaction(database, "readwrite", async ({ edits, metadata, tombstones }) => {
    const rows = {
      edits: await readRows(edits, ceiling),
      metadata: await readRows(metadata, ceiling),
      tombstones: await readRows(tombstones, ceiling),
    };
    const plan = planOfflineEditQueueRecovery(rows, limits);
    for (const key of plan.deleteEditKeys) edits.delete(key);
    for (const key of plan.deleteMetadataKeys) metadata.delete(key);
    for (const key of plan.deleteTombstoneKeys) tombstones.delete(key);
    for (const row of plan.putMetadata) metadata.put(row);
    return plan.report;
  });
  if (onRecovery && report.discardedRecords + report.repairedRecords > 0) onRecovery(report);
}

async function readRows(store: IDBObjectStore, ceiling: number): Promise<readonly OfflineEditQueueStoredRecord[]> {
  const [keys, values] = await Promise.all([
    request<IDBValidKey[]>(store.getAllKeys(null, ceiling)),
    request<unknown[]>(store.getAll(null, ceiling)),
  ]);
  if (keys.length !== values.length) {
    fail("store-failed", "Offline edit queue recovery read mismatched keys and records.");
  }
  return keys.map((key, index) => ({ key: String(key), value: values[index] }));
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(EDIT_STORE)) {
        open.result.createObjectStore(EDIT_STORE, { keyPath: "id" });
      }
      const metadata = open.result.objectStoreNames.contains(METADATA_STORE)
        ? open.transaction?.objectStore(METADATA_STORE)
        : open.result.createObjectStore(METADATA_STORE, { keyPath: "id" });
      if (metadata && !metadata.indexNames.contains(PARTITION_ORDER_INDEX)) {
        metadata.createIndex(PARTITION_ORDER_INDEX, ["authorizationScopeDigest", "sourceId", "createdAt", "id"]);
      }
      if (metadata && !metadata.indexNames.contains(PARTITION_STATE_ORDER_INDEX)) {
        metadata.createIndex(PARTITION_STATE_ORDER_INDEX, [
          "authorizationScopeDigest",
          "sourceId",
          "state",
          "createdAt",
          "id",
        ]);
      }
      if (metadata && !metadata.indexNames.contains(DEPENDENCY_INDEX)) {
        metadata.createIndex(DEPENDENCY_INDEX, "dependencyIds", { multiEntry: true });
      }
      if (!open.result.objectStoreNames.contains(TOMBSTONE_STORE)) {
        open.result.createObjectStore(TOMBSTONE_STORE, { keyPath: "id" });
      }
    };
    open.onsuccess = () => {
      open.result.onversionchange = () => open.result.close();
      resolve(open.result);
    };
    open.onerror = () => reject(open.error ?? new Error("Failed to open offline edit queue."));
    open.onblocked = () => reject(new Error("Offline edit queue database upgrade is blocked."));
  });
}

function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  body: (stores: QueueStores) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([EDIT_STORE, METADATA_STORE, TOMBSTONE_STORE], mode);
    const stores = {
      edits: transaction.objectStore(EDIT_STORE),
      metadata: transaction.objectStore(METADATA_STORE),
      tombstones: transaction.objectStore(TOMBSTONE_STORE),
    };
    let result: T;
    let settled = false;
    void body(stores).then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        settled = true;
        try {
          transaction.abort();
        } catch {
          // The transaction may already have completed or aborted.
        }
        reject(error);
      },
    );
    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("Offline edit queue transaction failed."));
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("Offline edit queue transaction aborted."));
      }
    };
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("Offline edit queue request failed."));
  });
}

function cloneJson(value: unknown, path: string, depth: number, budget: JsonCaptureBudget): OfflineEditJsonValue {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 64) fail("invalid-edit", `${path} exceeds JSON structure limits.`, { path });
  if (value === null) {
    addJsonBytes(budget, 4, path);
    return value;
  }
  if (typeof value === "boolean") {
    addJsonBytes(budget, value ? 4 : 5, path);
    return value;
  }
  if (typeof value === "string") {
    addJsonStringBytes(budget, value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid-edit", `${path} contains a non-finite number.`, { path });
    addJsonBytes(budget, String(value).length, path);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100_000 - budget.nodes) {
      fail("invalid-edit", `${path} exceeds JSON structure limits.`, { path });
    }
    const array = denseArray(value, path);
    addJsonBytes(budget, 2 + Math.max(0, array.length - 1), path);
    const out: OfflineEditJsonValue[] = [];
    for (let index = 0; index < array.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(array, index);
      if (!descriptor || !("value" in descriptor)) fail("invalid-edit", `${path} must be dense data.`, { path });
      out.push(cloneJson(descriptor.value, `${path}[${index}]`, depth + 1, budget));
    }
    return out;
  }
  const record = plainRecord(value, path);
  const keys = Object.keys(record).sort(compareCodeUnits);
  addJsonBytes(budget, 2 + Math.max(0, keys.length - 1) + keys.length, path);
  const out: Record<string, OfflineEditJsonValue> = Object.create(null);
  for (const key of keys) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      fail("invalid-edit", `${path}.${key} is not allowed.`, { path: `${path}.${key}` });
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail("invalid-edit", `${path}.${key} must be an enumerable data property.`, { path: `${path}.${key}` });
    }
    addJsonStringBytes(budget, key, `${path}.${key}`);
    out[key] = cloneJson(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail("invalid-edit", "Offline edit identity requires Web Crypto SHA-256.", { path: "crypto" });
  const digest = await subtle.digest("SHA-256", encoder.encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function defaultLeaseToken(): string {
  const token = globalThis.crypto?.randomUUID?.();
  if (!token) fail("invalid-edit", "Offline edit leases require crypto.randomUUID().", { path: "crypto" });
  return token;
}

function validNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("invalid-edit", "Queue clock is invalid.");
  return new Date(value.getTime());
}

function timestamp(now: () => Date): string {
  return validNow(now).toISOString();
}

function normalizedTimestamp(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw) {
    fail("invalid-edit", `${path} must be a normalized ISO-8601 timestamp.`, { path });
  }
  return raw;
}

function requiredString(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.trim() !== value ||
    encoder.encode(value).byteLength > 1024
  ) {
    fail("invalid-edit", `${path} must be a normalized non-empty string of at most 1024 UTF-8 bytes.`, { path });
  }
  return value;
}

/**
 * A durable partition key that is persisted verbatim and used as an index key.
 * Screened with the same denylist that governs endpoint normalization; the
 * message names the path and never echoes the rejected value.
 */
function requiredPersistedIdentity(value: unknown, path: string): string {
  const normalized = requiredString(value, path);
  const reason = screenPersistedString(normalized, "identity");
  if (reason) fail("invalid-edit", credentialScreenMessage(path, reason), { path });
  return normalized;
}

/**
 * Reviewer-authored prose that is persisted verbatim. Screened with the label
 * strictness — a note may contain punctuation a machine identity may not, but
 * it must still not be a request URL or carry credential-shaped material.
 */
function requiredPersistedLabel(value: unknown, path: string): string {
  const normalized = requiredString(value, path);
  const reason = screenPersistedString(normalized, "label");
  if (reason) fail("invalid-edit", credentialScreenMessage(path, reason), { path });
  return normalized;
}

function requiredDigest(value: unknown, path: string): `sha256:${string}` {
  if (typeof value !== "string" || !EDIT_ID_PATTERN.test(value)) {
    fail("invalid-edit", `${path} must be a lowercase SHA-256 digest.`, { path });
  }
  return value as `sha256:${string}`;
}

function requiredId(value: unknown, path: string): string {
  return requiredDigest(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("invalid-edit", `${path} must be a positive safe integer.`, { path });
  }
  return value;
}

function tightenedPositive(value: unknown, ceiling: number, path: string): number {
  return Math.min(value === undefined ? ceiling : positiveInteger(value, path), ceiling);
}

function addJsonStringBytes(budget: JsonCaptureBudget, value: string, path: string): void {
  if (value.length > budget.maxBytes - budget.bytes) {
    fail("invalid-edit", `${path} exceeds the offline edit payload byte limit.`, { path });
  }
  addJsonBytes(budget, encoder.encode(JSON.stringify(value)).byteLength, path);
}

function addJsonBytes(budget: JsonCaptureBudget, bytes: number, path: string): void {
  budget.bytes += bytes;
  if (budget.bytes > budget.maxBytes) {
    fail("invalid-edit", `${path} exceeds the offline edit payload byte limit.`, { path });
  }
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid-edit", `${path} must be a plain object.`, { path });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid-edit", `${path} must be a plain object.`, { path });
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("invalid-edit", `${path} must not contain symbol properties.`, { path });
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail("invalid-edit", `${path}.${key} must be a data property.`, { path: `${path}.${key}` });
    }
  }
  return value as Record<string, unknown>;
}

function allowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.has(key)) fail("invalid-edit", `${path}.${key} is not supported.`, { path: `${path}.${key}` });
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable) {
      fail("invalid-edit", `${path}.${key} must be enumerable.`, { path: `${path}.${key}` });
    }
  }
}

function denseArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail("invalid-edit", `${path} must be a plain array.`, { path });
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("invalid-edit", `${path} must not contain symbol properties.`, { path });
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      fail("invalid-edit", `${path} must not contain named properties.`, { path: `${path}.${key}` });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail("invalid-edit", `${path}[${key}] must be an enumerable data property.`, { path: `${path}[${key}]` });
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      fail("invalid-edit", `${path} must not contain sparse entries.`, { path: `${path}[${index}]` });
    }
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function editQueueSdkCode(code: OfflineEditQueueErrorCode): HonuaErrorCode {
  if (code === "store-failed") return "offline.storage.failure";
  if (code === "lease-mismatch" || code === "lease-expired") return "offline.storage.concurrent";
  return "offline.replica-sync.validation";
}

function fail(
  code: OfflineEditQueueErrorCode,
  message: string,
  options?: { readonly cause?: unknown; readonly editId?: string; readonly path?: string },
): never {
  throw new HonuaOfflineEditQueueError(code, message, options);
}
