/**
 * Browser backend for the columnar batch cache (issue #940).
 *
 * The store itself is backend-agnostic; this module is the only place that
 * knows about IndexedDB, and it touches nothing at module scope, so importing
 * `@honua/sdk-js/query-planner` on a server or in a worker without IndexedDB
 * stays safe. `createIndexedDbColumnarBatchCacheStorage()` is the first line
 * that can fail, and only when a host really has no IndexedDB factory.
 *
 * Two object stores are deliberate. `records` holds metadata only, so admission
 * can enumerate every entry without deserializing megabytes of payload, and
 * `payloads` holds the envelope bytes keyed identically. A write puts both and
 * deletes every evicted key inside a **single** readwrite transaction, so the
 * store is never observably over quota and an aborted transaction leaves the
 * previous contents intact.
 *
 * @experimental
 */

import type { ColumnarBatchCacheEntryV1, ColumnarBatchCacheStorage } from "./batch-cache.js";

const DATABASE_VERSION = 1;
const RECORD_STORE = "records";
const PAYLOAD_STORE = "payloads";
const STORES = [RECORD_STORE, PAYLOAD_STORE] as const;

export interface IndexedDbColumnarBatchCacheStorageOptions {
  /** Defaults to `honua-columnar-batch-cache`. Names are origin-scoped by IndexedDB. */
  readonly name?: string;
  /** Injectable for browser tests and hosts with an alternate IndexedDB factory. */
  readonly indexedDB?: IDBFactory;
}

/**
 * Persistent browser storage for serialized batches: metadata and payload
 * written, and evictions applied, in one transaction.
 */
export function createIndexedDbColumnarBatchCacheStorage(
  options: IndexedDbColumnarBatchCacheStorageOptions = {},
): ColumnarBatchCacheStorage {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB is not available in this runtime.");
  const name = options.name ?? "honua-columnar-batch-cache";
  if (name.trim().length === 0) throw new Error("IndexedDB database name must be non-empty.");
  let database: Promise<IDBDatabase> | undefined = openDatabase(factory, name);
  const connection = (): Promise<IDBDatabase> => {
    if (!database) return Promise.reject(new Error("This columnar batch cache storage was disposed."));
    return database;
  };
  return {
    summaries: async () =>
      runTransaction(await connection(), "readonly", async (transaction) =>
        request<unknown[]>(transaction.objectStore(RECORD_STORE).getAll()),
      ),
    read: async (key) =>
      runTransaction(await connection(), "readonly", async (transaction) => {
        const record = await request<unknown>(transaction.objectStore(RECORD_STORE).get(key));
        if (record === undefined) return undefined;
        const payload = await request<unknown>(transaction.objectStore(PAYLOAD_STORE).get(key));
        if (payload === undefined) return undefined;
        const envelope = toEnvelope((payload as { envelope?: unknown })?.envelope);
        return envelope === undefined ? undefined : { record, envelope };
      }),
    write: async (entry: ColumnarBatchCacheEntryV1, evictKeys) =>
      runTransaction(await connection(), "readwrite", async (transaction) => {
        const records = transaction.objectStore(RECORD_STORE);
        const payloads = transaction.objectStore(PAYLOAD_STORE);
        for (const key of evictKeys) {
          records.delete(key);
          payloads.delete(key);
        }
        records.put(entry.record);
        // A fresh copy: the caller keeps ownership of its own bytes, and a
        // structured clone of a subarray would otherwise carry the whole
        // backing buffer into storage.
        payloads.put({ key: entry.record.key, envelope: entry.envelope.slice() });
      }),
    remove: async (key) =>
      runTransaction(await connection(), "readwrite", async (transaction) => {
        transaction.objectStore(RECORD_STORE).delete(key);
        transaction.objectStore(PAYLOAD_STORE).delete(key);
      }),
    clear: async () =>
      runTransaction(await connection(), "readwrite", async (transaction) => {
        transaction.objectStore(RECORD_STORE).clear();
        transaction.objectStore(PAYLOAD_STORE).clear();
      }),
    dispose: () => {
      const pending = database;
      database = undefined;
      // Closing releases the connection and every buffer it retained; a
      // rejected open must not leave an unhandled rejection behind.
      void pending?.then(
        (open) => open.close(),
        () => undefined,
      );
    },
  };
}

function toEnvelope(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      for (const store of STORES) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: "key" });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Failed to open the columnar batch cache database."));
    open.onblocked = () => reject(new Error("Columnar batch cache database upgrade is blocked by another connection."));
  });
}

function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([...STORES], mode);
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
      reject(transaction.error ?? new Error("Columnar batch cache transaction failed."));
    };
    transaction.onabort = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? new Error("Columnar batch cache transaction aborted."));
    };
  });
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("Columnar batch cache request failed."));
  });
}
