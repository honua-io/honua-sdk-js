import { type HonuaErrorCode, HonuaSdkError } from "../core/error-envelope.js";

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

export type OfflineEditJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OfflineEditJsonValue[]
  | { readonly [key: string]: OfflineEditJsonValue };

export type OfflineEditOperation = "add" | "update" | "delete";
export type OfflineQueuedEditState = "pending" | "leased" | "retryable" | "applied" | "conflicted" | "cancelled";

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

export type OfflineEditAuditEventKind =
  | "enqueued"
  | "claimed"
  | "lease-reclaimed"
  | "retry-scheduled"
  | "applied"
  | "conflicted"
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

export interface OfflineEditQueue {
  enqueue(input: EnqueueOfflineEditInput): Promise<OfflineEditEnqueueResult>;
  get(editId: string, partition: OfflineEditQueuePartition): Promise<OfflineQueuedEdit | undefined>;
  list(options: ListOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]>;
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

interface OfflineEditQueueMetadata extends OfflineEditQueuePartition {
  readonly id: `sha256:${string}`;
  readonly state: OfflineQueuedEditState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependencyIds: readonly `sha256:${string}`[];
  readonly retryAt?: string;
  readonly leaseExpiresAt?: string;
}

interface OfflineEditQueueTombstone extends OfflineEditQueuePartition {
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

  public constructor(options: IndexedDbOfflineEditQueueOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available in this runtime.");
    const name = options.name ?? "honua-offline-edit-queue";
    if (name.trim().length === 0) throw new Error("IndexedDB database name must be non-empty.");
    this.#options = normalizeOptions(options);
    this.#database = openDatabase(factory, name);
  }

  public async enqueue(input: EnqueueOfflineEditInput): Promise<OfflineEditEnqueueResult> {
    const prepared = await prepareEdit(input, this.#options);
    return this.#run("readwrite", async ({ edits, metadata, tombstones }) => {
      const existing = await request<OfflineQueuedEdit | undefined>(edits.get(prepared.id));
      const tombstone = await request<OfflineEditQueueTombstone | undefined>(tombstones.get(prepared.id));
      rejectPrunedIdentity(tombstone, prepared);
      const dependencies = await Promise.all(
        prepared.dependencyIds.map(async (id) => {
          const live = await request<OfflineEditQueueMetadata | undefined>(metadata.get(id));
          return live ?? request<OfflineEditQueueTombstone | undefined>(tombstones.get(id));
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
    return this.#run("readonly", async ({ edits }) => {
      const record = await request<OfflineQueuedEdit | undefined>(edits.get(id));
      return record && matchesPartition(record, normalized) ? copy(record) : undefined;
    });
  }

  public async list(options: ListOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]> {
    const { partition, limit } = captureListOptions(options);
    return this.#run("readonly", async ({ edits, metadata }) => {
      const ids = await scanPartitionIds(metadata, partition, limit);
      const records = await Promise.all(ids.map((id) => request<OfflineQueuedEdit | undefined>(edits.get(id))));
      return copy(records.filter((record): record is OfflineQueuedEdit => record !== undefined));
    });
  }

  public async claimReady(options: ClaimOfflineEditsOptions): Promise<readonly OfflineQueuedEdit[]> {
    const normalized = captureClaimOptions(options, this.#options);
    return this.#run("readwrite", async ({ edits, metadata, tombstones }) => {
      const candidates = await scanReadyMetadata(metadata, tombstones, normalized);
      const claimed: OfflineQueuedEdit[] = [];
      for (const candidate of candidates) {
        const record = await request<OfflineQueuedEdit | undefined>(edits.get(candidate.id));
        if (!record) throw new Error(`Offline edit metadata references missing edit "${candidate.id}".`);
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
    return this.#run("readwrite", async ({ edits, metadata }) => {
      const current = await request<OfflineQueuedEdit | undefined>(edits.get(id));
      if (!current || !matchesPartition(current, normalized)) {
        fail("edit-not-found", `Offline edit "${id}" was not found.`, { editId: id });
      }
      const updated = cancelRecord(current, outcome, this.#options);
      edits.put(updated);
      metadata.put(metadataFor(updated));
      return copy(updated);
    });
  }

  public async pruneTerminal(options: PruneTerminalOfflineEditsOptions): Promise<readonly `sha256:${string}`[]> {
    const normalized = capturePruneOptions(options);
    const prunedAt = timestamp(this.#options.now);
    return this.#run("readwrite", async ({ edits, metadata, tombstones }) => {
      const candidates = await scanTerminalMetadata(metadata, normalized);
      const removed: `sha256:${string}`[] = [];
      for (const candidate of candidates) {
        if (await hasActiveMetadataDependent(metadata, candidate.id)) continue;
        const record = await request<OfflineQueuedEdit | undefined>(edits.get(candidate.id));
        if (!record) throw new Error(`Offline edit metadata references missing edit "${candidate.id}".`);
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
    return this.#run("readwrite", async ({ edits, metadata }) => {
      const current = await request<OfflineQueuedEdit | undefined>(edits.get(id));
      if (!current) fail("edit-not-found", `Offline edit "${id}" was not found.`, { editId: id });
      const updated = transitionRecord(current, leaseToken, state, outcome, this.#options);
      edits.put(updated);
      metadata.put(metadataFor(updated));
      return copy(updated);
    });
  }

  async #run<T>(mode: IDBTransactionMode, body: (stores: QueueStores) => Promise<T>): Promise<T> {
    try {
      return await runTransaction(await this.#database, mode, body);
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
  const sourceId = requiredString(record.sourceId, "sourceId");
  const idempotencyKey = requiredString(record.idempotencyKey, "idempotencyKey");
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
    sourceId: requiredString(record.sourceId, `${path}.sourceId`),
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
): Promise<readonly `sha256:${string}`[]> {
  const index = store.index(PARTITION_ORDER_INDEX);
  let cursor = await request<IDBCursorWithValue | null>(index.openCursor(partitionRange(partition)));
  const ids: `sha256:${string}`[] = [];
  while (cursor && ids.length < limit) {
    ids.push((cursor.value as OfflineEditQueueMetadata).id);
    cursor = await continueCursor(cursor);
  }
  return ids;
}

async function scanReadyMetadata(
  metadataStore: IDBObjectStore,
  tombstoneStore: IDBObjectStore,
  options: NormalizedClaimOptions,
): Promise<readonly OfflineEditQueueMetadata[]> {
  const states = ["pending", "retryable", "leased"] as const;
  const cache = new Map<string, OfflineEditDependencyEvidence | undefined>();
  const candidates = (
    await Promise.all(states.map((state) => scanReadyState(metadataStore, tombstoneStore, state, options, cache)))
  ).flat();
  return candidates.sort(compareMetadataCreated).slice(0, options.limit);
}

async function scanReadyState(
  metadataStore: IDBObjectStore,
  tombstoneStore: IDBObjectStore,
  state: "pending" | "retryable" | "leased",
  options: NormalizedClaimOptions,
  cache: Map<string, OfflineEditDependencyEvidence | undefined>,
): Promise<readonly OfflineEditQueueMetadata[]> {
  const index = metadataStore.index(PARTITION_STATE_ORDER_INDEX);
  let cursor = await request<IDBCursorWithValue | null>(index.openCursor(partitionStateRange(options, state)));
  const candidates: OfflineEditQueueMetadata[] = [];
  while (cursor && candidates.length < options.limit) {
    const metadata = cursor.value as OfflineEditQueueMetadata;
    const eligibleAt =
      state === "pending"
        ? true
        : Date.parse(state === "retryable" ? (metadata.retryAt ?? "") : (metadata.leaseExpiresAt ?? "")) <=
          options.now.getTime();
    if (eligibleAt && (await dependenciesAreApplied(metadataStore, tombstoneStore, metadata.dependencyIds, cache))) {
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
): Promise<boolean> {
  for (const id of dependencyIds) {
    let dependency = cache.get(id);
    if (!cache.has(id)) {
      dependency = await request<OfflineEditQueueMetadata | undefined>(metadataStore.get(id));
      dependency ??= await request<OfflineEditQueueTombstone | undefined>(tombstoneStore.get(id));
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
): Promise<readonly OfflineEditQueueMetadata[]> {
  const candidates: OfflineEditQueueMetadata[] = [];
  for (const state of ["applied", "conflicted", "cancelled"] as const) {
    const index = store.index(PARTITION_STATE_ORDER_INDEX);
    let cursor = await request<IDBCursorWithValue | null>(index.openCursor(partitionStateRange(options, state)));
    while (cursor) {
      const metadata = cursor.value as OfflineEditQueueMetadata;
      if (Date.parse(metadata.updatedAt) <= options.terminalBeforeMs) {
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
