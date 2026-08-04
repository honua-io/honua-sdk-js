/**
 * Bounded persistent cache for serialized GeoArrow batches (issue #940).
 *
 * Epic #394 requires batch identity to bind "plan hash, source/schema version,
 * authorization scope, ordering, and freshness". `ColumnarBatchIdentityV1`
 * carried that information but nothing turned it into a storage key, so a cache
 * built on top of the serialization envelope would have been free to key a
 * batch by source id alone — a cross-tenant read shape. This module lands the
 * key contract and the store together, with the same discipline the offline
 * region store and the realtime checkpoint store already use:
 *
 * 1. **Identity-bound keys.** {@link columnarBatchCacheKey} digests the source,
 *    plan, schema, ordering, and freshness *validators* together with a digest
 *    of the authorization scope. The raw scope never appears in the key or in a
 *    persisted record, and a change to any keyed component addresses a
 *    different entry rather than reusing this one.
 * 2. **Versioned envelope with a migration ladder.** Payloads are written
 *    through `serializeGeoArrowBatch` and read through
 *    `deserializeGeoArrowBatch`, so an entry written by an older layout is
 *    migrated forward on read and an unreadable one is discarded explicitly —
 *    never misread. The record additionally stamps its own
 *    `honua.columnar-batch-cache/…` format; a record with a foreign format is
 *    treated as corrupt and deleted.
 * 3. **Verified before served.** Every read recomputes the SHA-256 of the
 *    stored envelope bytes and compares it to the digest recorded at write
 *    time. A mismatch is a miss *and* a delete; a batch is never returned from
 *    bytes that were not proven intact.
 * 4. **Bounded with deterministic eviction.** A byte quota and a record cap are
 *    both enforced by {@link planColumnarBatchCacheAdmission}, a pure function
 *    that evicts oldest-first with a code-unit tie-break, and the write plus its
 *    evictions are handed to the backend as one atomic operation.
 *
 * **Persistence is opt-in and the default is no cache.** Nothing in the SDK
 * constructs one of these: a batch is cached only when an application creates a
 * store, chooses a backend, and calls {@link ColumnarBatchCacheHandle.write}.
 *
 * The store is backend-agnostic — it holds no IndexedDB, filesystem, or Node
 * reference — so it runs unchanged in a worker, on a server, and in a browser.
 * `batch-cache-indexeddb.ts` supplies the browser backend, and
 * {@link createMemoryColumnarBatchCacheStorage} supplies an in-process one with
 * identical semantics.
 *
 * @experimental
 */

import { type CredentialScreenReason, credentialScreenMessage, screenPersistedString } from "../connect-url-safety.js";
// The offline stores are this repo's canonical persistent-cache discipline;
// reusing their digest and quota-pressure primitives keeps one implementation
// of "canonical identity" and one classification of "the device is full".
import { canonicalJson, sha256 } from "../offline/digest.js";
import { isStorageQuotaPressureError } from "../offline/quota.js";
import {
  HONUA_GEOARROW_ENVELOPE_VERSION,
  deserializeGeoArrowBatch,
  serializeGeoArrowBatch,
} from "./geoarrow-serialization.js";
import type { GeoArrowSerializationMetrics, GeoArrowSerializationOptions } from "./geoarrow-types.js";
import { HonuaGeoArrowError } from "./geoarrow-types.js";
import type { ColumnarBatchIdentityV1, ColumnarBatchV1, ColumnarFreshnessV1 } from "./types.js";

/**
 * Versioned format string stamped on every persisted record. A record whose
 * format differs is corrupt to this build and is discarded on read, so a future
 * record layout can never be misinterpreted as this one.
 */
export const HONUA_COLUMNAR_BATCH_CACHE_FORMAT = "honua.columnar-batch-cache/1.0" as const;

/** Default byte quota across stored envelopes. Callers should size it explicitly. */
export const DEFAULT_COLUMNAR_BATCH_CACHE_QUOTA_BYTES = 64 * 1024 * 1024;

/** Absolute ceiling on `quotaBytes`. Callers may tighten it, never raise it. */
export const MAX_COLUMNAR_BATCH_CACHE_QUOTA_BYTES = 1024 * 1024 * 1024;

/** Default cap on retained entries; the oldest is evicted first. */
export const DEFAULT_COLUMNAR_BATCH_CACHE_MAX_RECORDS = 64;

/** Absolute ceiling on `maxRecords`. */
export const MAX_COLUMNAR_BATCH_CACHE_MAX_RECORDS = 4_096;

/**
 * Default maximum entry age. A batch older than this is reported stale even
 * when its identity still matches, because a source may change without changing
 * a validator the client can see.
 */
export const DEFAULT_COLUMNAR_BATCH_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

/** Absolute ceiling on `maxAgeMs`. */
export const MAX_COLUMNAR_BATCH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Freshness the producer observed, recorded so a read can refuse expired data. */
export interface ColumnarBatchCacheFreshnessV1 {
  readonly observedAt: string;
  readonly staleAfter?: string;
  readonly validator?: string;
  readonly generation?: string;
}

/**
 * One persisted cache record. Metadata only: the serialized envelope travels
 * beside it so a backend can enumerate and evict without loading payloads.
 *
 * `observedAt` is when this store wrote the record and drives eviction order;
 * `freshness.observedAt` is when the producer observed the source and drives
 * expiry.
 */
export interface ColumnarBatchCacheRecordV1 {
  readonly key: `sha256:${string}`;
  readonly format: typeof HONUA_COLUMNAR_BATCH_CACHE_FORMAT;
  /** Envelope layout the payload was written at. */
  readonly envelopeVersion: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly planId: string;
  /** Digest of the identity's authorization scope, never the scope itself. */
  readonly authorizationScopeDigest: `sha256:${string}`;
  /** Digest of the ordering contract the batch was produced under. */
  readonly orderingDigest: `sha256:${string}`;
  readonly freshness: ColumnarBatchCacheFreshnessV1;
  readonly rowCount: number;
  readonly byteLength: number;
  /** SHA-256 over the stored envelope bytes, verified on every read. */
  readonly integrity: `sha256:${string}`;
  readonly observedAt: string;
}

/** A record plus the envelope bytes it accounts for. */
export interface ColumnarBatchCacheEntryV1 {
  readonly record: ColumnarBatchCacheRecordV1;
  readonly envelope: Uint8Array;
}

/**
 * Storage primitives the key, screening, integrity, freshness, and eviction
 * logic is built on.
 *
 * Reads may return anything at all — every value is revalidated before it can
 * become a batch — and every method may reject, which degrades to a miss or a
 * refusal rather than an exception in a caller's data path. `write` must apply
 * the entry and its evictions atomically: a partial application would leave the
 * store over quota with no record of why.
 */
export interface ColumnarBatchCacheStorage {
  /** Metadata for every stored entry, without loading payload bytes. */
  summaries(): Promise<readonly unknown[]>;
  /** One entry, or `undefined`. Returned bytes must be caller-owned. */
  read(key: string): Promise<unknown>;
  /** Atomically write `entry` and delete every key in `evictKeys`. */
  write(entry: ColumnarBatchCacheEntryV1, evictKeys: readonly string[]): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Release any retained connection or buffer. Optional for simple backends. */
  dispose?(): void;
}

/** Why a read did not return a batch. */
export type ColumnarBatchCacheMissReason =
  | "absent"
  | "aborted"
  | "disposed"
  | "corrupt-record"
  | "foreign-format"
  | "identity-mismatch"
  | "authorization-scope-mismatch"
  | "integrity-mismatch"
  | "digest-unavailable"
  | "unsupported-serialization"
  | "storage-failed";

/** Why a read found a matching entry that must not be served as fresh. */
export type ColumnarBatchCacheStaleReason = "freshness-expired" | "max-age-exceeded";

/** Why a write did not persist. */
export type ColumnarBatchCacheRefusalReason =
  | "aborted"
  | "disposed"
  | "invalid-batch"
  | "credential-screened"
  | "quota-exceeded"
  | "quota-pressure"
  | "serialization-limit-exceeded"
  | "digest-unavailable"
  | "storage-failed";

/** Outcome of {@link ColumnarBatchCacheHandle.read}. */
export type ColumnarBatchCacheReadV1 =
  | {
      readonly outcome: "hit";
      readonly key: `sha256:${string}`;
      readonly batch: ColumnarBatchV1;
      readonly metrics: GeoArrowSerializationMetrics;
      readonly record: ColumnarBatchCacheRecordV1;
    }
  | {
      readonly outcome: "stale";
      readonly key: `sha256:${string}`;
      readonly reason: ColumnarBatchCacheStaleReason;
      /** Kept so the caller can revalidate instead of refetching blind. */
      readonly record: ColumnarBatchCacheRecordV1;
    }
  | {
      readonly outcome: "miss";
      readonly key: `sha256:${string}`;
      readonly reason: ColumnarBatchCacheMissReason;
    };

/** Outcome of {@link ColumnarBatchCacheHandle.write}. */
export type ColumnarBatchCacheWriteV1 =
  | {
      readonly outcome: "stored";
      readonly key: `sha256:${string}`;
      readonly record: ColumnarBatchCacheRecordV1;
      readonly admission: ColumnarBatchCacheAdmissionV1;
    }
  | {
      readonly outcome: "refused";
      readonly key: `sha256:${string}`;
      readonly reason: ColumnarBatchCacheRefusalReason;
      readonly detail: string;
    };

/** Deterministic eviction plan for one candidate write. */
export interface ColumnarBatchCacheAdmissionV1 {
  readonly quotaBytes: number;
  readonly maxRecords: number;
  readonly incomingBytes: number;
  readonly bytesBefore: number;
  /** Bytes reclaimed by replacing an existing entry under the same key. */
  readonly replacedBytes: number;
  readonly evictKeys: readonly string[];
  readonly evictedBytes: number;
  readonly bytesAfter: number;
  readonly recordsAfter: number;
  readonly admitted: boolean;
}

/** Structured report of every miss, stale read, refusal, and storage failure. */
export interface ColumnarBatchCacheDiagnosticV1 {
  readonly kind: "honua.columnar-batch-cache-diagnostic";
  readonly version: 1;
  readonly operation: "read" | "write" | "delete";
  readonly reason: ColumnarBatchCacheMissReason | ColumnarBatchCacheStaleReason | ColumnarBatchCacheRefusalReason;
  /** Key the operation addressed; a digest, never a raw identity. */
  readonly key: `sha256:${string}`;
  readonly detail: string;
}

export interface ColumnarBatchCacheOptions {
  /** Byte quota across stored envelopes. @default 67108864 */
  readonly quotaBytes?: number;
  /** Maximum retained entries; the oldest is evicted first. @default 64 */
  readonly maxRecords?: number;
  /** Maximum entry age before a read reports stale. @default 3600000 */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  /** Bounds applied to every serialize and deserialize this store performs. */
  readonly serialization?: GeoArrowSerializationOptions;
  /** Receives every miss, stale read, refusal, and storage failure. Must not throw. */
  readonly onDiagnostic?: (diagnostic: ColumnarBatchCacheDiagnosticV1) => void;
}

export interface ColumnarBatchCacheReadOptions {
  /** Settles the read as an `aborted` miss without waiting for the backend. */
  readonly signal?: AbortSignal;
}

export interface ColumnarBatchCacheWriteOptions {
  /** Settles the write as an `aborted` refusal without waiting for the backend. */
  readonly signal?: AbortSignal;
}

/** An identity-keyed batch cache plus the administration a host needs to audit it. */
export interface ColumnarBatchCacheHandle {
  /** Derive the key this identity addresses, without touching storage. */
  key(identity: ColumnarBatchIdentityV1): Promise<`sha256:${string}`>;
  /**
   * Look one batch up by identity.
   *
   * Only the keyed components matter: the passed `freshness.observedAt` and
   * `freshness.staleAfter` are never compared, because expiry is evaluated
   * against what the *producer* recorded, not against what the reader guessed.
   */
  read(identity: ColumnarBatchIdentityV1, options?: ColumnarBatchCacheReadOptions): Promise<ColumnarBatchCacheReadV1>;
  write(batch: ColumnarBatchV1, options?: ColumnarBatchCacheWriteOptions): Promise<ColumnarBatchCacheWriteV1>;
  /** Drop the entry this identity addresses, if any. */
  delete(identity: ColumnarBatchIdentityV1): Promise<void>;
  /** Every valid persisted record, for enumeration in tests and diagnostics. */
  records(): Promise<readonly ColumnarBatchCacheRecordV1[]>;
  /** Drop every entry, for sign-out and scope teardown. */
  clear(): Promise<void>;
  /** Release retained buffers and connections; later calls settle as `disposed`. */
  dispose(): void;
}

const INVALID_KEY = `sha256:${"0".repeat(64)}` as const;

interface NormalizedCacheOptions {
  readonly quotaBytes: number;
  readonly maxRecords: number;
  readonly maxAgeMs: number;
  readonly now: () => number;
  readonly serialization: GeoArrowSerializationOptions;
  readonly onDiagnostic?: (diagnostic: ColumnarBatchCacheDiagnosticV1) => void;
}

/**
 * Opaque digest of an authorization scope.
 *
 * The scope is documented as a non-secret opaque fingerprint; persisting only
 * its digest keeps that promise enforceable rather than assumed, and keeps the
 * raw value out of the cache key.
 */
export async function columnarAuthorizationScopeDigest(scope: string): Promise<`sha256:${string}`> {
  return sha256(`honua-columnar-batch-cache-scope:v1:${scope}`);
}

/**
 * Deterministic cache key for one batch identity.
 *
 * The key digests source id, source version, schema version, plan id, the
 * ordering contract, the freshness *validators*, and the authorization-scope
 * digest. Two identities that differ in any of those address different entries,
 * and the output is a hex digest, so the raw authorization scope can never
 * appear in it.
 *
 * `freshness.observedAt` and `freshness.staleAfter` are deliberately excluded:
 * they describe *when* a producer observed the source, not *what* was asked
 * for. Keying on them would mint a new entry for every fetch and make the cache
 * unreadable by a caller that does not already hold the answer. Expiry is
 * enforced on read instead, against the record's own recorded freshness.
 */
export async function columnarBatchCacheKey(identity: ColumnarBatchIdentityV1): Promise<`sha256:${string}`> {
  const identityRecord = assertIdentity(identity);
  return sha256(
    `honua-columnar-batch-cache-key:v1:${canonicalJson({
      authorizationScopeDigest: await columnarAuthorizationScopeDigest(identityRecord.authorizationScope),
      freshness: freshnessValidators(identityRecord.freshness),
      ordering: orderingIdentity(identityRecord),
      planId: identityRecord.planId,
      schemaVersion: identityRecord.schemaVersion,
      sourceId: identityRecord.sourceId,
      sourceVersion: identityRecord.sourceVersion,
    })}`,
  );
}

/**
 * Digest of the ordering contract a batch was produced under.
 *
 * Recorded beside the batch so a reader can tell "same rows, different sort"
 * apart from "same batch" without trusting the key alone.
 */
export async function columnarBatchCacheOrderingDigest(identity: ColumnarBatchIdentityV1): Promise<`sha256:${string}`> {
  return sha256(`honua-columnar-batch-cache-ordering:v1:${canonicalJson(orderingIdentity(identity))}`);
}

/**
 * Plan the evictions that admit `incoming` under `limits`.
 *
 * Pure and deterministic: candidates are ordered by write time and then by key
 * in code-unit order, so two hosts with the same records always evict the same
 * entries. An entry larger than the whole quota is refused outright rather than
 * emptying the store for something that still would not fit.
 */
export function planColumnarBatchCacheAdmission(
  records: readonly ColumnarBatchCacheRecordV1[],
  incoming: { readonly key: string; readonly byteLength: number },
  limits: { readonly quotaBytes: number; readonly maxRecords: number },
): ColumnarBatchCacheAdmissionV1 {
  const others = records.filter((record) => record.key !== incoming.key);
  const replacedBytes = records
    .filter((record) => record.key === incoming.key)
    .reduce((total, record) => total + record.byteLength, 0);
  const bytesBefore = records.reduce((total, record) => total + record.byteLength, 0);
  const base = {
    quotaBytes: limits.quotaBytes,
    maxRecords: limits.maxRecords,
    incomingBytes: incoming.byteLength,
    bytesBefore,
    replacedBytes,
  };
  if (incoming.byteLength > limits.quotaBytes) {
    return Object.freeze({
      ...base,
      evictKeys: Object.freeze([]),
      evictedBytes: 0,
      bytesAfter: bytesBefore,
      recordsAfter: records.length,
      admitted: false,
    });
  }
  const ordered = [...others].sort(
    (left, right) => compareCodeUnits(left.observedAt, right.observedAt) || compareCodeUnits(left.key, right.key),
  );
  const evictKeys: string[] = [];
  let evictedBytes = 0;
  let bytes = others.reduce((total, record) => total + record.byteLength, 0) + incoming.byteLength;
  let count = others.length + 1;
  for (const record of ordered) {
    if (bytes <= limits.quotaBytes && count <= limits.maxRecords) break;
    evictKeys.push(record.key);
    evictedBytes += record.byteLength;
    bytes -= record.byteLength;
    count -= 1;
  }
  return Object.freeze({
    ...base,
    evictKeys: Object.freeze(evictKeys),
    evictedBytes,
    bytesAfter: bytes,
    recordsAfter: count,
    admitted: bytes <= limits.quotaBytes && count <= limits.maxRecords,
  });
}

/**
 * Bind the key, screening, integrity, freshness, and eviction logic to any
 * {@link ColumnarBatchCacheStorage}.
 *
 * The returned handle never throws into a data path: a rejected backend call, a
 * refused value, or a corrupt record settles as a miss or a refusal and reports
 * a {@link ColumnarBatchCacheDiagnosticV1}, so a caller falls back to fetching
 * rather than failing.
 */
export function createColumnarBatchCache(
  storage: ColumnarBatchCacheStorage,
  options: ColumnarBatchCacheOptions = {},
): ColumnarBatchCacheHandle {
  const normalized = normalizeOptions(options);
  let disposed = false;
  const handle: ColumnarBatchCacheHandle = {
    key: (identity) => columnarBatchCacheKey(identity),
    read: async (identity, readOptions = {}) => {
      if (disposed) return miss(normalized, INVALID_KEY, "disposed", "This columnar batch cache was disposed.");
      return readEntry(storage, normalized, identity, readOptions.signal);
    },
    write: async (batch, writeOptions = {}) => {
      if (disposed) {
        return refuse(normalized, INVALID_KEY, "disposed", "This columnar batch cache was disposed.");
      }
      return writeEntry(storage, normalized, batch, writeOptions.signal);
    },
    delete: async (identity) => {
      if (disposed) return;
      let key: `sha256:${string}`;
      try {
        key = await columnarBatchCacheKey(identity);
      } catch {
        return;
      }
      try {
        await storage.remove(key);
      } catch (cause) {
        report(normalized, "delete", "storage-failed", key, describe("Unable to delete the cached batch.", cause));
      }
    },
    records: async () => {
      if (disposed) return Object.freeze([]);
      try {
        return (await storage.summaries()).filter((value): value is ColumnarBatchCacheRecordV1 => isCacheRecord(value));
      } catch (cause) {
        report(
          normalized,
          "read",
          "storage-failed",
          INVALID_KEY,
          describe("Unable to enumerate cached batches.", cause),
        );
        return Object.freeze([]);
      }
    },
    clear: async () => {
      if (disposed) return;
      try {
        await storage.clear();
      } catch (cause) {
        report(normalized, "delete", "storage-failed", INVALID_KEY, describe("Unable to clear the cache.", cause));
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      storage.dispose?.();
    },
  };
  return handle;
}

/**
 * In-process storage with the persistent backend's exact semantics: atomic
 * write-plus-eviction, caller-owned reads, and no aliasing of a caller's bytes.
 */
export function createMemoryColumnarBatchCacheStorage(): ColumnarBatchCacheStorage {
  const entries = new Map<string, ColumnarBatchCacheEntryV1>();
  return {
    summaries: async () => [...entries.values()].map((entry) => entry.record),
    read: async (key) => {
      const entry = entries.get(key);
      return entry ? { record: entry.record, envelope: entry.envelope.slice() } : undefined;
    },
    write: async (entry, evictKeys) => {
      for (const key of evictKeys) entries.delete(key);
      entries.set(entry.record.key, { record: entry.record, envelope: entry.envelope.slice() });
    },
    remove: async (key) => {
      entries.delete(key);
    },
    clear: async () => entries.clear(),
    dispose: () => entries.clear(),
  };
}

async function readEntry(
  storage: ColumnarBatchCacheStorage,
  options: NormalizedCacheOptions,
  identity: ColumnarBatchIdentityV1,
  signal: AbortSignal | undefined,
): Promise<ColumnarBatchCacheReadV1> {
  if (signal?.aborted) return miss(options, INVALID_KEY, "aborted", "The read was aborted before it started.");
  let key: `sha256:${string}`;
  let scopeDigest: `sha256:${string}`;
  try {
    key = await columnarBatchCacheKey(identity);
    scopeDigest = await columnarAuthorizationScopeDigest(identity.authorizationScope);
  } catch (cause) {
    return miss(options, INVALID_KEY, "corrupt-record", describe("The identity could not be keyed.", cause));
  }
  const settled = await settle(storage.read(key), signal);
  if (settled.status === "aborted") return miss(options, key, "aborted", "The read was aborted.");
  if (settled.status === "failed") {
    return miss(options, key, "storage-failed", describe("Unable to read the cached batch.", settled.error));
  }
  const entry = settled.value;
  if (entry === undefined || entry === null) {
    return { outcome: "miss", key, reason: "absent" };
  }
  if (!isStoredEntry(entry)) {
    return discard(storage, options, key, "corrupt-record", "The stored cache entry is unreadable.");
  }
  const record = entry.record;
  if (record.format !== HONUA_COLUMNAR_BATCH_CACHE_FORMAT) {
    return discard(storage, options, key, "foreign-format", "The stored record was written in another format.");
  }
  if (!isCacheRecord(record) || record.key !== key) {
    return discard(storage, options, key, "corrupt-record", "The stored record is corrupt.");
  }
  if (record.authorizationScopeDigest !== scopeDigest) {
    // The key already binds the scope digest, so a mismatch here means the
    // stored bytes were rewritten under this key. Serving them would be exactly
    // the cross-scope read the key model exists to prevent.
    return discard(
      storage,
      options,
      key,
      "authorization-scope-mismatch",
      "The stored batch was produced under a different authorization scope.",
    );
  }
  const mismatch = identityMismatch(record, identity);
  if (mismatch) return discard(storage, options, key, "identity-mismatch", mismatch);
  if (entry.envelope.byteLength !== record.byteLength) {
    return discard(storage, options, key, "integrity-mismatch", "The stored payload length does not match the record.");
  }
  let integrity: `sha256:${string}`;
  try {
    integrity = await sha256(entry.envelope);
  } catch (cause) {
    // Without a digest the payload cannot be proven intact, and unverified
    // bytes are never served.
    return miss(options, key, "digest-unavailable", describe("Cache integrity requires Web Crypto SHA-256.", cause));
  }
  if (integrity !== record.integrity) {
    return discard(storage, options, key, "integrity-mismatch", "The stored payload failed its integrity check.");
  }
  if (signal?.aborted) return miss(options, key, "aborted", "The read was aborted.");
  const stale = staleness(record, options);
  if (stale) {
    report(options, "read", stale, key, `The cached batch is ${stale.replace("-", " ")}.`);
    return { outcome: "stale", key, reason: stale, record };
  }
  let restored: { batch: ColumnarBatchV1; metrics: GeoArrowSerializationMetrics };
  try {
    restored = deserializeGeoArrowBatch(entry.envelope, options.serialization);
  } catch (cause) {
    const reason: ColumnarBatchCacheMissReason =
      cause instanceof HonuaGeoArrowError && cause.code === "unsupported-serialization"
        ? "unsupported-serialization"
        : "corrupt-record";
    return discard(storage, options, key, reason, describe("The stored envelope could not be materialized.", cause));
  }
  const restoredIdentity = restored.batch.identity;
  if (!restoredIdentity || restoredIdentity.authorizationScope !== record.authorizationScopeDigest) {
    return discard(
      storage,
      options,
      key,
      "authorization-scope-mismatch",
      "The stored envelope identity does not match its record.",
    );
  }
  if (restored.batch.rowCount !== record.rowCount) {
    return discard(storage, options, key, "corrupt-record", "The stored envelope row count does not match its record.");
  }
  // Safe only because the scope digest above already matched this exact scope:
  // the caller gets its own scope back, never a value read out of storage.
  const batch = Object.freeze({
    ...restored.batch,
    identity: Object.freeze({ ...restoredIdentity, authorizationScope: identity.authorizationScope }),
  }) as ColumnarBatchV1;
  return { outcome: "hit", key, batch, metrics: restored.metrics, record };
}

async function writeEntry(
  storage: ColumnarBatchCacheStorage,
  options: NormalizedCacheOptions,
  batch: ColumnarBatchV1,
  signal: AbortSignal | undefined,
): Promise<ColumnarBatchCacheWriteV1> {
  if (signal?.aborted) return refuse(options, INVALID_KEY, "aborted", "The write was aborted before it started.");
  let identity: ColumnarBatchIdentityV1;
  try {
    identity = assertIdentity(batch?.identity);
  } catch (cause) {
    return refuse(options, INVALID_KEY, "invalid-batch", describe("The batch carries no cacheable identity.", cause));
  }
  const leak = findIdentityCredentialLeak(batch, identity);
  if (leak) {
    // Refusing to persist is deliberate: the in-memory batch is unaffected and
    // the next read simply refetches.
    return refuse(options, INVALID_KEY, "credential-screened", credentialScreenMessage(leak.path, leak.reason));
  }
  let key: `sha256:${string}`;
  let scopeDigest: `sha256:${string}`;
  try {
    key = await columnarBatchCacheKey(identity);
    scopeDigest = await columnarAuthorizationScopeDigest(identity.authorizationScope);
  } catch (cause) {
    return refuse(options, INVALID_KEY, "digest-unavailable", describe("The identity could not be keyed.", cause));
  }

  let envelope: Uint8Array;
  try {
    // The raw authorization scope is replaced by its digest before anything is
    // serialized, so no persisted byte carries the caller's scope value.
    const persisted = {
      ...batch,
      identity: { ...identity, authorizationScope: scopeDigest },
    } as ColumnarBatchV1;
    envelope = serializeGeoArrowBatch(persisted, options.serialization);
  } catch (cause) {
    const reason: ColumnarBatchCacheRefusalReason =
      cause instanceof HonuaGeoArrowError && cause.code === "serialization-limit-exceeded"
        ? "serialization-limit-exceeded"
        : "invalid-batch";
    return refuse(options, key, reason, describe("The batch could not be serialized for the cache.", cause));
  }
  let integrity: `sha256:${string}`;
  try {
    integrity = await sha256(envelope);
  } catch (cause) {
    return refuse(options, key, "digest-unavailable", describe("Cache integrity requires Web Crypto SHA-256.", cause));
  }
  if (signal?.aborted) return refuse(options, key, "aborted", "The write was aborted.");

  const summaries = await settle(storage.summaries(), signal);
  if (summaries.status === "aborted") return refuse(options, key, "aborted", "The write was aborted.");
  if (summaries.status === "failed") {
    return refuse(options, key, "storage-failed", describe("Unable to enumerate the cache.", summaries.error));
  }
  const existing = summaries.value.filter((value): value is ColumnarBatchCacheRecordV1 => isCacheRecord(value));
  const admission = planColumnarBatchCacheAdmission(
    existing,
    { key, byteLength: envelope.byteLength },
    { quotaBytes: options.quotaBytes, maxRecords: options.maxRecords },
  );
  if (!admission.admitted) {
    return refuse(
      options,
      key,
      "quota-exceeded",
      `The batch needs ${envelope.byteLength} bytes; the cache quota is ${options.quotaBytes}.`,
    );
  }
  const record: ColumnarBatchCacheRecordV1 = Object.freeze({
    key,
    format: HONUA_COLUMNAR_BATCH_CACHE_FORMAT,
    envelopeVersion: HONUA_GEOARROW_ENVELOPE_VERSION,
    sourceId: identity.sourceId,
    sourceVersion: identity.sourceVersion,
    schemaVersion: identity.schemaVersion,
    planId: identity.planId,
    authorizationScopeDigest: scopeDigest,
    orderingDigest: await columnarBatchCacheOrderingDigest(identity),
    freshness: Object.freeze(cacheFreshness(identity.freshness)),
    rowCount: batch.rowCount,
    byteLength: envelope.byteLength,
    integrity,
    observedAt: new Date(options.now()).toISOString(),
  });
  const written = await settle(storage.write({ record, envelope }, admission.evictKeys), signal);
  if (written.status === "aborted") return refuse(options, key, "aborted", "The write was aborted.");
  if (written.status === "failed") {
    const reason: ColumnarBatchCacheRefusalReason = isStorageQuotaPressureError(written.error)
      ? "quota-pressure"
      : "storage-failed";
    return refuse(options, key, reason, describe("Unable to persist the batch.", written.error));
  }
  return { outcome: "stored", key, record, admission };
}

/** Delete an unusable entry and report the miss it produced. */
async function discard(
  storage: ColumnarBatchCacheStorage,
  options: NormalizedCacheOptions,
  key: `sha256:${string}`,
  reason: ColumnarBatchCacheMissReason,
  detail: string,
): Promise<ColumnarBatchCacheReadV1> {
  try {
    await storage.remove(key);
  } catch {
    // The entry is already unusable; failing to delete it must not change the
    // outcome, which is a miss either way.
  }
  return miss(options, key, reason, detail);
}

function miss(
  options: NormalizedCacheOptions,
  key: `sha256:${string}`,
  reason: ColumnarBatchCacheMissReason,
  detail: string,
): ColumnarBatchCacheReadV1 {
  report(options, "read", reason, key, detail);
  return { outcome: "miss", key, reason };
}

function refuse(
  options: NormalizedCacheOptions,
  key: `sha256:${string}`,
  reason: ColumnarBatchCacheRefusalReason,
  detail: string,
): ColumnarBatchCacheWriteV1 {
  report(options, "write", reason, key, detail);
  return { outcome: "refused", key, reason, detail };
}

function report(
  options: NormalizedCacheOptions,
  operation: ColumnarBatchCacheDiagnosticV1["operation"],
  reason: ColumnarBatchCacheDiagnosticV1["reason"],
  key: `sha256:${string}`,
  detail: string,
): void {
  if (!options.onDiagnostic) return;
  options.onDiagnostic(
    Object.freeze({
      kind: "honua.columnar-batch-cache-diagnostic",
      version: 1,
      operation,
      reason,
      key,
      detail,
    }),
  );
}

function staleness(
  record: ColumnarBatchCacheRecordV1,
  options: NormalizedCacheOptions,
): ColumnarBatchCacheStaleReason | undefined {
  const now = options.now();
  const staleAfter = record.freshness.staleAfter;
  if (staleAfter !== undefined) {
    const horizon = Date.parse(staleAfter);
    if (!Number.isFinite(horizon) || now > horizon) return "freshness-expired";
  }
  const observed = Date.parse(record.freshness.observedAt);
  if (!Number.isFinite(observed) || now - observed > options.maxAgeMs) return "max-age-exceeded";
  return undefined;
}

function identityMismatch(record: ColumnarBatchCacheRecordV1, identity: ColumnarBatchIdentityV1): string | undefined {
  // The key already binds each of these; re-checking them makes a rewritten or
  // colliding record a miss rather than a silent substitution.
  if (record.sourceId !== identity.sourceId) return "The stored batch belongs to another source.";
  if (record.sourceVersion !== identity.sourceVersion) return "The stored batch belongs to another source version.";
  if (record.schemaVersion !== identity.schemaVersion) return "The stored batch belongs to another schema version.";
  if (record.planId !== identity.planId) return "The stored batch belongs to another plan.";
  const validators = freshnessValidators(identity.freshness);
  if ((record.freshness.validator ?? null) !== (validators.validator ?? null)) {
    return "The stored batch carries another source validator.";
  }
  if ((record.freshness.generation ?? null) !== (validators.generation ?? null)) {
    return "The stored batch carries another source generation.";
  }
  return undefined;
}

function findIdentityCredentialLeak(
  batch: ColumnarBatchV1,
  identity: ColumnarBatchIdentityV1,
): { readonly path: string; readonly reason: CredentialScreenReason } | undefined {
  const screened: Array<readonly [string, unknown]> = [
    ["batch.id", batch.id],
    ["batch.schema.id", batch.schema?.id],
    ["identity.sourceId", identity.sourceId],
    ["identity.sourceVersion", identity.sourceVersion],
    ["identity.schemaVersion", identity.schemaVersion],
    ["identity.planId", identity.planId],
    ["identity.freshness.validator", identity.freshness.validator],
    ["identity.freshness.generation", identity.freshness.generation],
  ];
  for (const [index, key] of (identity.ordering?.keys ?? []).entries()) {
    screened.push([`identity.ordering.keys[${index}].field`, key?.field]);
  }
  for (const [path, value] of screened) {
    if (typeof value !== "string") continue;
    const reason = screenPersistedString(value, "identity");
    if (reason) return { path, reason };
  }
  return undefined;
}

function cacheFreshness(freshness: ColumnarFreshnessV1): ColumnarBatchCacheFreshnessV1 {
  return {
    observedAt: freshness.observedAt,
    ...(freshness.staleAfter === undefined ? {} : { staleAfter: freshness.staleAfter }),
    ...freshnessValidators(freshness),
  };
}

function freshnessValidators(freshness: ColumnarFreshnessV1): {
  readonly validator?: string;
  readonly generation?: string;
} {
  return {
    ...(freshness.validator === undefined ? {} : { validator: freshness.validator }),
    ...(freshness.generation === undefined ? {} : { generation: freshness.generation }),
  };
}

function orderingIdentity(identity: ColumnarBatchIdentityV1): {
  readonly stable: boolean;
  readonly keys: ReadonlyArray<{ field: string; direction: string; nulls: string }>;
} {
  return {
    stable: identity.ordering.stable === true,
    keys: identity.ordering.keys.map((key) => ({
      field: String(key.field),
      direction: String(key.direction),
      nulls: String(key.nulls),
    })),
  };
}

/**
 * Plain-object gate for every value a caller or backend hands in.
 *
 * The null test comes first on purpose. `typeof null === "object"` in
 * JavaScript, so a `typeof` test alone admits `null`; writing the null test
 * *after* the `typeof` refinement instead reads — to a reader and to static
 * analysis alike — as a comparison against a case the refinement already
 * excluded. Ordering it first keeps every shape gate below fail-closed and
 * says exactly what it rejects.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function assertIdentity(identity: ColumnarBatchIdentityV1 | undefined): ColumnarBatchIdentityV1 {
  const strings = ["sourceId", "sourceVersion", "schemaVersion", "planId", "authorizationScope"] as const;
  if (!isPlainRecord(identity)) {
    throw new HonuaGeoArrowError("invalid-input", "A cacheable batch requires a ColumnarBatchIdentityV1.");
  }
  for (const name of strings) {
    if (typeof identity[name] !== "string" || identity[name].length === 0) {
      throw new HonuaGeoArrowError("invalid-input", `Batch identity ${name} must be a non-empty string.`);
    }
  }
  if (!isPlainRecord(identity.ordering) || !Array.isArray(identity.ordering.keys)) {
    throw new HonuaGeoArrowError("invalid-input", "Batch identity ordering must declare its keys.");
  }
  if (!isPlainRecord(identity.freshness)) {
    throw new HonuaGeoArrowError("invalid-input", "Batch identity freshness must be an object.");
  }
  if (
    typeof identity.freshness.observedAt !== "string" ||
    !Number.isFinite(Date.parse(identity.freshness.observedAt))
  ) {
    throw new HonuaGeoArrowError("invalid-input", "Batch identity freshness.observedAt must be an RFC 3339 instant.");
  }
  return identity;
}

function isStoredEntry(value: unknown): value is { record: ColumnarBatchCacheRecordV1; envelope: Uint8Array } {
  if (!isPlainRecord(value)) return false;
  return isPlainRecord(value.record) && ArrayBuffer.isView(value.envelope);
}

/** Shape gate for anything a backend hands back as a record. */
export function isCacheRecord(value: unknown): value is ColumnarBatchCacheRecordV1 {
  if (!isPlainRecord(value)) return false;
  const record = value as Partial<ColumnarBatchCacheRecordV1>;
  if (record.format !== HONUA_COLUMNAR_BATCH_CACHE_FORMAT) return false;
  for (const name of ["key", "envelopeVersion", "sourceId", "sourceVersion", "schemaVersion", "planId"] as const) {
    if (typeof record[name] !== "string" || record[name].length === 0) return false;
  }
  for (const name of ["authorizationScopeDigest", "orderingDigest", "integrity", "key"] as const) {
    const digest = record[name];
    if (typeof digest !== "string" || !digest.startsWith("sha256:")) return false;
  }
  if (!Number.isSafeInteger(record.rowCount) || (record.rowCount as number) < 0) return false;
  if (!Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0) return false;
  if (typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt))) return false;
  const freshness = record.freshness;
  if (!isPlainRecord(freshness)) return false;
  if (typeof freshness.observedAt !== "string") return false;
  for (const name of ["staleAfter", "validator", "generation"] as const) {
    if (freshness[name] !== undefined && typeof freshness[name] !== "string") return false;
  }
  return true;
}

type Settled<T> =
  | { readonly status: "settled"; readonly value: T }
  | { readonly status: "aborted" }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Settle as soon as `promise` resolves or `signal` aborts, whichever comes
 * first. An aborted operation never waits for a backend that may be blocked
 * behind another transaction.
 */
function settle<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<Settled<T>> {
  const resolved = promise.then(
    (value) => ({ status: "settled", value }) as Settled<T>,
    (error: unknown) => ({ status: "failed", error }) as Settled<T>,
  );
  if (!signal) return resolved;
  if (signal.aborted) return Promise.resolve({ status: "aborted" });
  return new Promise<Settled<T>>((resolve) => {
    const onAbort = (): void => resolve({ status: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    void resolved.then((outcome) => {
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    });
  });
}

function normalizeOptions(options: ColumnarBatchCacheOptions): NormalizedCacheOptions {
  return {
    quotaBytes: tightened(
      options.quotaBytes,
      DEFAULT_COLUMNAR_BATCH_CACHE_QUOTA_BYTES,
      MAX_COLUMNAR_BATCH_CACHE_QUOTA_BYTES,
      "quotaBytes",
    ),
    maxRecords: tightened(
      options.maxRecords,
      DEFAULT_COLUMNAR_BATCH_CACHE_MAX_RECORDS,
      MAX_COLUMNAR_BATCH_CACHE_MAX_RECORDS,
      "maxRecords",
    ),
    maxAgeMs: tightened(
      options.maxAgeMs,
      DEFAULT_COLUMNAR_BATCH_CACHE_MAX_AGE_MS,
      MAX_COLUMNAR_BATCH_CACHE_MAX_AGE_MS,
      "maxAgeMs",
    ),
    now: options.now ?? Date.now,
    serialization: options.serialization ?? {},
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  };
}

function tightened(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HonuaGeoArrowError("invalid-input", `${name} must be a safe integer greater than zero.`);
  }
  if (value > ceiling) {
    throw new HonuaGeoArrowError("invalid-input", `${name} cannot exceed the ${ceiling} safety ceiling.`);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describe(prefix: string, cause: unknown): string {
  if (cause instanceof HonuaGeoArrowError) return `${prefix} ${cause.code}: ${cause.message}`;
  return cause instanceof Error ? `${prefix} ${cause.message}` : prefix;
}
