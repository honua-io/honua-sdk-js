/**
 * Durable {@link RealtimeCheckpointStore} implementations for
 * `@honua/sdk-js/realtime` (issue #937).
 *
 * `resumable.ts` already owns the resume state machine: it loads a checkpoint,
 * validates it with {@link evaluateRealtimeCheckpoint}, and requires an explicit
 * replacement snapshot whenever the checkpoint no longer applies. What it never
 * had was a shipped store, so a reload always resnapshotted even when a valid
 * cursor was in hand a second earlier. This module supplies that durability
 * without redefining any cursor semantics:
 *
 * - {@link createIndexedDbRealtimeCheckpointStore} persists one record per
 *   resume scope in the browser, keyed by the authorization-scope digest,
 *   source identity, and query identity that already define checkpoint scope.
 * - {@link createMemoryRealtimeCheckpointStore} runs the identical
 *   normalization, screening, expiry, and eviction logic without IndexedDB, for
 *   tests and non-persistent hosts.
 * - {@link createRealtimeCheckpointStore} binds that same logic to any
 *   {@link RealtimeCheckpointRecordStorage}, for hosts this module ships no
 *   adapter for.
 *
 * Four properties are deliberate:
 *
 * 1. **Cursors only.** A record carries the resume position (sequence, cursor,
 *    watermark, timestamp, delta token), the scope identity it belongs to, and
 *    two observation times. It never carries features, snapshots, request URLs,
 *    headers, or credentials. The authorization scope is reduced to a SHA-256
 *    digest before it reaches storage, and every remaining persisted string is
 *    screened with the shared persisted-string screen in
 *    `src/connect-url-safety.ts` — the same discipline the offline region store
 *    applies through `assertCredentialFreeManifest`.
 * 2. **Fail-closed resume.** Load revalidates through
 *    {@link evaluateRealtimeCheckpoint} and discards the record outright when
 *    the source, query, source version, schema version, or authorization scope
 *    changed, when the record is corrupt, or when the checkpoint is older than
 *    the configured maximum age. A discarded checkpoint means the subscription
 *    resnapshots; it never means a partial delta stream is delivered as though
 *    it were complete.
 * 3. **Bounded and atomic.** Each scope holds exactly one record (last write
 *    wins), the store holds at most `maxRecords` scope records, and the
 *    IndexedDB write plus its eviction sweep share a single readwrite
 *    transaction.
 * 4. **Never throws into a subscription.** A storage failure, a refused
 *    credential-shaped value, or a corrupt record resolves and reports a
 *    {@link RealtimeCheckpointStoreDiagnosticV1} carrying a
 *    `HonuaRealtimeResumeError`, so the subscription degrades to a resnapshot
 *    instead of entering the gate's terminal `error` phase.
 *
 * The store stays opt-in: nothing here is wired into a subscription unless a
 * caller passes it as `checkpointStore`, so no existing subscription changes
 * behaviour by default.
 *
 * @module
 */

import { type CredentialScreenReason, credentialScreenMessage, screenPersistedString } from "../connect-url-safety.js";
import { canonicalStringify, sha256 } from "../query-planner/canonical.js";
import {
  HonuaRealtimeResumeError,
  REALTIME_DURABLE_CHECKPOINT_VERSION,
  type RealtimeCheckpointCompatibilityCode,
  type RealtimeCheckpointStore,
  type RealtimeDurableCheckpointV1,
  type RealtimeResumeContextV1,
  evaluateRealtimeCheckpoint,
} from "./resumable.js";
import type { RealtimeResumeCheckpoint } from "./types.js";

/**
 * Versioned format string stamped on every persisted record. A record whose
 * format string differs is treated as corrupt and discarded on load, the same
 * posture the offline stores take, so a future format can never be
 * misinterpreted as this one.
 */
export const HONUA_REALTIME_CHECKPOINT_STORE_FORMAT = "honua.realtime-checkpoint-store/1.0" as const;

/**
 * Default maximum checkpoint age. A cursor older than this forces a resnapshot
 * even when its scope still matches, because a server may retire a cursor
 * window without telling the client; a silent gap is worse than an honest
 * resnapshot.
 */
export const DEFAULT_REALTIME_CHECKPOINT_MAX_AGE_MS = 15 * 60 * 1000;

/** Absolute ceiling on `maxAgeMs`. Callers may tighten it, never raise it. */
export const MAX_REALTIME_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Default cap on distinct resume scopes retained per store. Each scope holds at
 * most one record, so this is also the record cap; the least recently written
 * record is evicted first.
 */
export const DEFAULT_REALTIME_CHECKPOINT_MAX_RECORDS = 64;

/** Absolute ceiling on `maxRecords`. Callers may tighten it, never raise it. */
export const MAX_REALTIME_CHECKPOINT_RECORDS = 512;

/** Resume position persisted with a checkpoint record. Never a payload. */
export interface RealtimeStoredResumePosition {
  readonly sequence: number;
  readonly cursor?: string;
  readonly watermark?: string;
  readonly timestamp?: string;
  readonly deltaToken?: string;
}

/**
 * One persisted checkpoint record.
 *
 * `savedAt` is the checkpoint's own observation time and drives expiry;
 * `observedAt` is when this store wrote the record and drives eviction order.
 * Recent event ids are deliberately absent: they are bounded delivery history,
 * not resume state, so a restored checkpoint starts with an empty id window
 * while its ordering guarantees are unchanged.
 */
export interface RealtimeCheckpointRecordV1 {
  readonly key: `sha256:${string}`;
  readonly format: typeof HONUA_REALTIME_CHECKPOINT_STORE_FORMAT;
  readonly sourceId: string;
  readonly queryFingerprint: string;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  /** Digest of the resume context's authorization-scope fingerprint, never the fingerprint itself. */
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly resume: RealtimeStoredResumePosition;
  readonly savedAt: string;
  readonly observedAt: string;
}

/**
 * Why a checkpoint was not returned or not persisted. The first six values are
 * exactly the incompatible {@link RealtimeCheckpointCompatibilityCode} results,
 * so a discard reason reads in the same vocabulary the delivery gate uses.
 */
export type RealtimeCheckpointStoreReason =
  | Exclude<RealtimeCheckpointCompatibilityCode, "compatible">
  | "checkpoint-expired"
  | "credential-screened"
  | "storage-failed";

/**
 * Structured report of a load or save that did not produce a durable resume.
 *
 * `error` is a `HonuaRealtimeResumeError`, so a host routes it through the same
 * envelope as every other realtime failure. Messages never echo a stored cursor,
 * scope fingerprint, or offending value.
 */
export interface RealtimeCheckpointStoreDiagnosticV1 {
  readonly kind: "honua.realtime-checkpoint-store-diagnostic";
  readonly version: 1;
  readonly operation: "load" | "save";
  readonly reason: RealtimeCheckpointStoreReason;
  /** Scope key the operation addressed; a digest, never a raw identity. */
  readonly scopeKey: `sha256:${string}`;
  readonly error: HonuaRealtimeResumeError;
}

export interface RealtimeCheckpointStoreOptions {
  /** Maximum checkpoint age before a resnapshot is forced. @default 900000 */
  readonly maxAgeMs?: number;
  /** Maximum distinct resume scopes retained; least recently written is evicted. @default 64 */
  readonly maxRecords?: number;
  readonly now?: () => number;
  /** Receives every discard, refusal, and storage failure. Must not throw. */
  readonly onDiagnostic?: (diagnostic: RealtimeCheckpointStoreDiagnosticV1) => void;
}

export interface IndexedDbRealtimeCheckpointStoreOptions extends RealtimeCheckpointStoreOptions {
  /** Defaults to `honua-realtime-checkpoints`. Names are origin-scoped by IndexedDB. */
  readonly name?: string;
  /** Injectable for browser tests and hosts with an alternate IndexedDB factory. */
  readonly indexedDB?: IDBFactory;
}

const DATABASE_VERSION = 1;
const CHECKPOINT_STORE = "checkpoints";
const OBSERVED_AT_INDEX = "observedAt";

/** Reason codes mapped onto the delivery gate's existing failure taxonomy. */
const DIAGNOSTIC_ERROR_CODES = {
  "invalid-checkpoint": "invalid-checkpoint",
  "source-changed": "source-changed",
  "query-changed": "query-changed",
  "source-version-changed": "source-version-changed",
  "schema-version-changed": "schema-version-changed",
  "authorization-scope-changed": "authorization-scope-changed",
  "checkpoint-expired": "cursor-expired",
  "credential-screened": "checkpoint-save-failed",
  "storage-failed": "checkpoint-load-failed",
} as const;

interface NormalizedStoreOptions {
  readonly maxAgeMs: number;
  readonly maxRecords: number;
  readonly now: () => number;
  readonly onDiagnostic?: (diagnostic: RealtimeCheckpointStoreDiagnosticV1) => void;
}

/**
 * Storage primitives the scope, screening, expiry, and eviction logic is built
 * on. Implement it to persist checkpoints somewhere this module does not ship an
 * adapter for (a Node filesystem, SQLite, an extension store). Reads may return
 * anything at all — every value is revalidated before it can resume a
 * subscription — and every method may reject, which degrades to a resnapshot.
 */
export interface RealtimeCheckpointRecordStorage {
  read(key: string): Promise<unknown>;
  /** Atomically write `record` and evict the oldest records beyond `maxRecords`. */
  write(record: RealtimeCheckpointRecordV1, maxRecords: number): Promise<void>;
  remove(key: string): Promise<void>;
  list(): Promise<readonly unknown[]>;
  clear(): Promise<void>;
}

/** A checkpoint store plus the record administration a host needs to audit or reset it. */
export interface RealtimeCheckpointStoreHandle extends RealtimeCheckpointStore {
  /** Every valid persisted record, for enumeration in tests and diagnostics. */
  records(): Promise<readonly RealtimeCheckpointRecordV1[]>;
  /** Drop every stored checkpoint, for sign-out and scope teardown. */
  clear(): Promise<void>;
}

/**
 * Deterministic scope key for a resume context: a digest over the
 * authorization-scope digest, source identity, and query identity — exactly the
 * identities checkpoint scope validation is defined against. Source and schema
 * versions are intentionally excluded so a version bump replaces the record in
 * place and is discarded explicitly on load, instead of orphaning it under a
 * key nothing will read again.
 */
export function realtimeCheckpointScopeKey(context: RealtimeResumeContextV1): `sha256:${string}` {
  return sha256(
    `honua-realtime-checkpoint-scope:v1:${canonicalStringify({
      authorizationScopeDigest: realtimeAuthorizationScopeDigest(context.authorizationScopeFingerprint),
      queryFingerprint: String(context.queryFingerprint),
      sourceId: String(context.sourceId),
    })}`,
  );
}

/**
 * Opaque digest of an authorization-scope fingerprint. The fingerprint is
 * already documented as a non-secret opaque identity; persisting only its
 * digest keeps that promise enforceable rather than assumed.
 */
export function realtimeAuthorizationScopeDigest(fingerprint: string): `sha256:${string}` {
  return sha256(`honua-realtime-checkpoint-scope-digest:v1:${fingerprint}`);
}

/**
 * Bind the shared scope, screening, expiry, and eviction logic to any
 * {@link RealtimeCheckpointRecordStorage}. The returned store never throws into
 * a subscription: a rejected storage call, a refused value, or a corrupt record
 * resolves and reports a diagnostic, so the subscription resnapshots.
 */
export function createRealtimeCheckpointStore(
  storage: RealtimeCheckpointRecordStorage,
  options: RealtimeCheckpointStoreOptions = {},
): RealtimeCheckpointStoreHandle {
  const normalized = normalizeOptions(options);
  return {
    load: (context, signal) => loadCheckpoint(storage, normalized, context, signal),
    save: (checkpoint, signal) => saveCheckpoint(storage, normalized, checkpoint, signal),
    records: async () => (await storage.list()).filter((record) => isCheckpointRecord(record)),
    clear: () => storage.clear(),
  };
}

/** In-memory store with the persistent store's exact semantics, for tests and non-persistent hosts. */
export function createMemoryRealtimeCheckpointStore(
  options: RealtimeCheckpointStoreOptions = {},
): RealtimeCheckpointStoreHandle {
  return createRealtimeCheckpointStore(createMemoryCheckpointStorage(), options);
}

/** Map-backed storage with the same one-record-per-scope, oldest-first eviction contract. */
export function createMemoryCheckpointStorage(): RealtimeCheckpointRecordStorage {
  const records = new Map<string, RealtimeCheckpointRecordV1>();
  return {
    read: async (key) => records.get(key),
    write: async (record, maxRecords) => {
      // Delete first so the re-inserted key moves to the tail of the insertion
      // order, which is the eviction order.
      records.delete(record.key);
      records.set(record.key, record);
      for (const key of [...records.keys()].slice(0, Math.max(0, records.size - maxRecords))) records.delete(key);
    },
    remove: async (key) => {
      records.delete(key);
    },
    list: async () => [...records.values()],
    clear: async () => records.clear(),
  };
}

/** Persistent browser store: one bounded, atomically written record per resume scope. */
export function createIndexedDbRealtimeCheckpointStore(
  options: IndexedDbRealtimeCheckpointStoreOptions = {},
): RealtimeCheckpointStoreHandle {
  return createRealtimeCheckpointStore(createIndexedDbCheckpointStorage(options), options);
}

/** IndexedDB storage; each method runs in exactly one transaction. */
export function createIndexedDbCheckpointStorage(
  options: IndexedDbRealtimeCheckpointStoreOptions = {},
): RealtimeCheckpointRecordStorage {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB is not available in this runtime.");
  const name = options.name ?? "honua-realtime-checkpoints";
  if (name.trim().length === 0) throw new Error("IndexedDB database name must be non-empty.");
  const database = openDatabase(factory, name);
  return {
    read: async (key) =>
      runTransaction(await database, "readonly", async (transaction) =>
        request<unknown>(transaction.objectStore(CHECKPOINT_STORE).get(key)),
      ),
    write: async (record, maxRecords) =>
      runTransaction(await database, "readwrite", async (transaction) => {
        const store = transaction.objectStore(CHECKPOINT_STORE);
        store.put(record);
        const total = await request<number>(store.count());
        if (total > maxRecords) await evictOldest(store, total - maxRecords, record.key);
      }),
    remove: async (key) =>
      runTransaction(await database, "readwrite", async (transaction) => {
        transaction.objectStore(CHECKPOINT_STORE).delete(key);
      }),
    list: async () =>
      runTransaction(await database, "readonly", async (transaction) =>
        request<unknown[]>(transaction.objectStore(CHECKPOINT_STORE).getAll()),
      ),
    clear: async () =>
      runTransaction(await database, "readwrite", async (transaction) => {
        transaction.objectStore(CHECKPOINT_STORE).clear();
      }),
  };
}

async function loadCheckpoint(
  backend: RealtimeCheckpointRecordStorage,
  options: NormalizedStoreOptions,
  context: RealtimeResumeContextV1,
  signal: AbortSignal,
): Promise<RealtimeDurableCheckpointV1 | undefined> {
  if (signal?.aborted) return undefined;
  let scopeKey: `sha256:${string}`;
  try {
    scopeKey = realtimeCheckpointScopeKey(context);
  } catch (cause) {
    // A context this store cannot even key is not a resumable context.
    report(options, "load", "invalid-checkpoint", INVALID_SCOPE_KEY, "Resume context could not be keyed.", cause);
    return undefined;
  }

  let stored: unknown;
  try {
    stored = await backend.read(scopeKey);
  } catch (cause) {
    report(options, "load", "storage-failed", scopeKey, "Unable to read the stored realtime checkpoint.", cause);
    return undefined;
  }
  if (stored === undefined || signal?.aborted) return undefined;

  const projection = projectStoredCheckpoint(stored, context, options);
  if ("reason" in projection) {
    await discard(backend, options, scopeKey, projection.reason, projection.detail);
    return undefined;
  }
  return projection.checkpoint;
}

async function saveCheckpoint(
  backend: RealtimeCheckpointRecordStorage,
  options: NormalizedStoreOptions,
  checkpoint: RealtimeDurableCheckpointV1,
  signal: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  let scopeKey: `sha256:${string}` = INVALID_SCOPE_KEY;
  try {
    const compatibility = evaluateRealtimeCheckpoint(checkpoint?.context, checkpoint);
    if (!compatibility.compatible) {
      report(options, "save", "invalid-checkpoint", scopeKey, compatibility.reason);
      return;
    }
    scopeKey = realtimeCheckpointScopeKey(checkpoint.context);
  } catch (cause) {
    report(options, "save", "invalid-checkpoint", scopeKey, "Checkpoint could not be projected for storage.", cause);
    return;
  }

  const record = projectRecord(checkpoint, scopeKey, options.now());
  if ("path" in record) {
    // Refusing to persist is deliberate: the in-memory checkpoint still drives
    // this connection, and the next load simply resnapshots.
    report(options, "save", "credential-screened", scopeKey, credentialScreenMessage(record.path, record.reason));
    return;
  }
  try {
    await backend.write(record.record, options.maxRecords);
  } catch (cause) {
    report(options, "save", "storage-failed", scopeKey, "Unable to persist the realtime checkpoint.", cause);
  }
}

async function discard(
  backend: RealtimeCheckpointRecordStorage,
  options: NormalizedStoreOptions,
  scopeKey: `sha256:${string}`,
  reason: RealtimeCheckpointStoreReason,
  detail: string,
): Promise<void> {
  try {
    await backend.remove(scopeKey);
  } catch {
    // The record is already unusable; failing to delete it must not change the
    // outcome, which is an explicit resnapshot either way.
  }
  report(options, "load", reason, scopeKey, detail);
}

function projectStoredCheckpoint(
  stored: unknown,
  context: RealtimeResumeContextV1,
  options: NormalizedStoreOptions,
):
  | { readonly checkpoint: RealtimeDurableCheckpointV1 }
  | { readonly reason: RealtimeCheckpointStoreReason; readonly detail: string } {
  if (!isCheckpointRecord(stored)) {
    return { reason: "invalid-checkpoint", detail: "Stored realtime checkpoint record is corrupt or unreadable." };
  }
  if (stored.authorizationScopeDigest !== realtimeAuthorizationScopeDigest(context.authorizationScopeFingerprint)) {
    return {
      reason: "authorization-scope-changed",
      detail: "Stored checkpoint authorization scope does not match the current grants.",
    };
  }
  const ageMs = options.now() - Date.parse(stored.savedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > options.maxAgeMs) {
    return {
      reason: "checkpoint-expired",
      detail: `Stored checkpoint is outside the ${options.maxAgeMs}ms maximum resume age.`,
    };
  }
  const checkpoint: RealtimeDurableCheckpointV1 = Object.freeze({
    kind: "honua.realtime-checkpoint",
    version: REALTIME_DURABLE_CHECKPOINT_VERSION,
    context: Object.freeze({
      kind: "honua.realtime-resume-context",
      version: 1,
      sourceId: stored.sourceId,
      queryFingerprint: stored.queryFingerprint,
      sourceVersion: stored.sourceVersion,
      schemaVersion: stored.schemaVersion,
      // Safe only because the digest above already matched this exact scope.
      authorizationScopeFingerprint: context.authorizationScopeFingerprint,
    }) as RealtimeResumeContextV1,
    resume: Object.freeze({ ...stored.resume }),
    recentEventIds: Object.freeze([]),
    savedAt: stored.savedAt,
  });
  const compatibility = evaluateRealtimeCheckpoint(context, checkpoint);
  if (!compatibility.compatible) {
    // `compatible` is only reported alongside `compatible: true`; an
    // incompatible result that still carried it would be a contract break, so
    // it degrades to the shape-level rejection rather than resuming.
    const reason = compatibility.code === "compatible" ? "invalid-checkpoint" : compatibility.code;
    return { reason, detail: compatibility.reason };
  }
  return { checkpoint };
}

function projectRecord(
  checkpoint: RealtimeDurableCheckpointV1,
  scopeKey: `sha256:${string}`,
  now: number,
):
  | { readonly record: RealtimeCheckpointRecordV1 }
  | { readonly path: string; readonly reason: CredentialScreenReason } {
  const context = checkpoint.context;
  const resume: RealtimeStoredResumePosition = {
    sequence: checkpoint.resume.sequence,
    ...optionalText("cursor", checkpoint.resume),
    ...optionalText("watermark", checkpoint.resume),
    ...optionalText("timestamp", checkpoint.resume),
    ...optionalText("deltaToken", checkpoint.resume),
  };
  const screened: ReadonlyArray<readonly [string, string]> = [
    ["sourceId", String(context.sourceId)],
    ["queryFingerprint", context.queryFingerprint],
    ["sourceVersion", context.sourceVersion],
    ["schemaVersion", context.schemaVersion],
    ...(resume.cursor === undefined ? [] : ([["resume.cursor", resume.cursor]] as const)),
    ...(resume.watermark === undefined ? [] : ([["resume.watermark", resume.watermark]] as const)),
    ...(resume.timestamp === undefined ? [] : ([["resume.timestamp", resume.timestamp]] as const)),
    ...(resume.deltaToken === undefined ? [] : ([["resume.deltaToken", resume.deltaToken]] as const)),
  ];
  for (const [path, value] of screened) {
    const reason = screenPersistedString(value, "identity");
    if (reason) return { path, reason };
  }
  const observedAt = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  return {
    record: {
      key: scopeKey,
      format: HONUA_REALTIME_CHECKPOINT_STORE_FORMAT,
      sourceId: String(context.sourceId),
      queryFingerprint: context.queryFingerprint,
      sourceVersion: context.sourceVersion,
      schemaVersion: context.schemaVersion,
      authorizationScopeDigest: realtimeAuthorizationScopeDigest(context.authorizationScopeFingerprint),
      resume,
      savedAt: checkpoint.savedAt,
      observedAt,
    },
  };
}

function optionalText(
  name: "cursor" | "watermark" | "timestamp" | "deltaToken",
  resume: RealtimeResumeCheckpoint,
): Partial<Record<typeof name, string>> {
  const value = resume[name];
  return typeof value === "string" ? ({ [name]: value } as Partial<Record<typeof name, string>>) : {};
}

function report(
  options: NormalizedStoreOptions,
  operation: "load" | "save",
  reason: RealtimeCheckpointStoreReason,
  scopeKey: `sha256:${string}`,
  detail: string,
  cause?: unknown,
): void {
  if (!options.onDiagnostic) return;
  const error = new HonuaRealtimeResumeError(
    DIAGNOSTIC_ERROR_CODES[reason],
    detail,
    cause === undefined ? undefined : { cause },
  );
  options.onDiagnostic(
    Object.freeze({
      kind: "honua.realtime-checkpoint-store-diagnostic",
      version: 1,
      operation,
      reason,
      scopeKey,
      error,
    }),
  );
}

function normalizeOptions(options: RealtimeCheckpointStoreOptions): NormalizedStoreOptions {
  return {
    maxAgeMs: tightenedPositive(
      options.maxAgeMs,
      DEFAULT_REALTIME_CHECKPOINT_MAX_AGE_MS,
      MAX_REALTIME_CHECKPOINT_MAX_AGE_MS,
      "maxAgeMs",
    ),
    maxRecords: tightenedPositive(
      options.maxRecords,
      DEFAULT_REALTIME_CHECKPOINT_MAX_RECORDS,
      MAX_REALTIME_CHECKPOINT_RECORDS,
      "maxRecords",
    ),
    now: options.now ?? Date.now,
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  };
}

function tightenedPositive(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HonuaRealtimeResumeError("invalid-checkpoint", `${name} must be a safe integer greater than zero.`);
  }
  if (value > ceiling) {
    throw new HonuaRealtimeResumeError("invalid-checkpoint", `${name} cannot exceed the ${ceiling} safety ceiling.`);
  }
  return value;
}

const INVALID_SCOPE_KEY = `sha256:${"0".repeat(64)}` as const;

function isCheckpointRecord(value: unknown): value is RealtimeCheckpointRecordV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<RealtimeCheckpointRecordV1>;
  if (record.format !== HONUA_REALTIME_CHECKPOINT_STORE_FORMAT) return false;
  for (const name of ["key", "sourceId", "queryFingerprint", "sourceVersion", "schemaVersion"] as const) {
    if (typeof record[name] !== "string" || record[name].length === 0) return false;
  }
  if (typeof record.authorizationScopeDigest !== "string" || !record.authorizationScopeDigest.startsWith("sha256:")) {
    return false;
  }
  if (typeof record.savedAt !== "string" || !Number.isFinite(Date.parse(record.savedAt))) return false;
  if (typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt))) return false;
  if (typeof record.resume !== "object" || record.resume === null) return false;
  const resume = record.resume as Partial<RealtimeStoredResumePosition>;
  if (!Number.isSafeInteger(resume.sequence) || (resume.sequence as number) < 0) return false;
  for (const name of ["cursor", "watermark", "timestamp", "deltaToken"] as const) {
    if (resume[name] !== undefined && typeof resume[name] !== "string") return false;
  }
  return true;
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      const store = database.objectStoreNames.contains(CHECKPOINT_STORE)
        ? open.transaction?.objectStore(CHECKPOINT_STORE)
        : database.createObjectStore(CHECKPOINT_STORE, { keyPath: "key" });
      if (store && !store.indexNames.contains(OBSERVED_AT_INDEX)) store.createIndex(OBSERVED_AT_INDEX, "observedAt");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Failed to open the realtime checkpoint database."));
    open.onblocked = () => reject(new Error("Realtime checkpoint database upgrade is blocked by another connection."));
  });
}

function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([CHECKPOINT_STORE], mode);
    let result: T;
    let settled = false;
    void body(transaction).then(
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
      if (settled) return;
      settled = true;
      resolve(result);
    };
    transaction.onerror = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? new Error("Realtime checkpoint transaction failed."));
    };
    transaction.onabort = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? new Error("Realtime checkpoint transaction aborted."));
    };
  });
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("Realtime checkpoint request failed."));
  });
}

/** Delete `count` least recently written records inside the caller's transaction. */
function evictOldest(store: IDBObjectStore, count: number, protectedKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = count;
    if (remaining <= 0) {
      resolve();
      return;
    }
    const cursorRequest = store.index(OBSERVED_AT_INDEX).openCursor();
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error("Failed to enumerate realtime checkpoint records."));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || remaining <= 0) {
        resolve();
        return;
      }
      if (cursor.primaryKey !== protectedKey) {
        cursor.delete();
        remaining -= 1;
      }
      cursor.continue();
    };
  });
}
