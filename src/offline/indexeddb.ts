import type {
  OfflineRegionCacheAdmin,
  OfflineRegionCacheInventory,
  OfflineRegionCommitGuard,
  OfflineRegionDownloadReceipt,
  OfflineRegionManifestV1,
  OfflineRegionResourceRead,
  OfflineRegionStore,
  OfflineRegionStoredRegion,
  OfflineRegionWriteTransaction,
} from "./types.js";

const DATABASE_VERSION = 2;
const INVENTORY_KEY = "current";
const INVENTORY_STORE = "inventory";
const REGION_STORE = "regions";
const RESOURCE_STORE = "resources";
const RESOURCE_SEPARATOR = "\u0000";
const STAGING_STORE = "staging";
const REGION_ID_INDEX = "regionId";
const TRANSACTION_ID_INDEX = "transactionId";
const DEFAULT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface InventoryRecord {
  readonly key: typeof INVENTORY_KEY;
  readonly revision: string;
}

interface RegionRecord {
  readonly id: string;
  readonly manifest: OfflineRegionManifestV1;
  readonly receipt: OfflineRegionDownloadReceipt;
  readonly logicalByteLength: number;
  readonly lastAccessedAt: string;
  readonly expiresAt?: string;
  readonly pinned?: boolean;
}

interface ResourceRecord {
  readonly key: string;
  readonly regionId: string;
  readonly resourceId: string;
  readonly bytes: Uint8Array;
}

interface StagedResourceRecord {
  readonly key: string;
  readonly transactionId: string;
  readonly regionId: string;
  readonly resourceId: string;
  readonly bytes: Uint8Array;
  readonly createdAt: number;
}

export interface IndexedDbOfflineRegionStoreOptions {
  /** Defaults to `honua-offline-regions`. Names are origin-scoped by IndexedDB. */
  readonly name?: string;
  /** Injectable for browser tests and hosts with an alternate IndexedDB factory. */
  readonly indexedDB?: IDBFactory;
  /** Maximum age of abandoned staged resources before a new store reclaims them. */
  readonly stagingMaxAgeMs?: number;
}

/**
 * Persistent browser store for the storage-neutral downloadable-region contract.
 *
 * Each commit uses one read/write IndexedDB transaction over inventory, region
 * metadata, and resource bytes. The inventory revision is checked inside that
 * transaction, so two concurrent downloads cannot both commit an admission plan
 * calculated from the same inventory. Credentials and request URLs are never
 * introduced by this adapter; callers provide only the already-normalized
 * manifest and resource bytes.
 */
export class IndexedDbOfflineRegionStore implements OfflineRegionStore, OfflineRegionCacheAdmin {
  readonly #database: Promise<IDBDatabase>;

  public constructor(options: IndexedDbOfflineRegionStoreOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available in this runtime.");
    const name = options.name ?? "honua-offline-regions";
    if (name.trim().length === 0) throw new Error("IndexedDB database name must be non-empty.");
    const stagingMaxAgeMs = options.stagingMaxAgeMs ?? DEFAULT_STAGING_MAX_AGE_MS;
    if (!Number.isFinite(stagingMaxAgeMs) || stagingMaxAgeMs < 0)
      throw new Error("stagingMaxAgeMs must be a non-negative finite number.");
    this.#database = openDatabase(factory, name).then(async (database) => {
      await cleanupAbandonedStaging(database, stagingMaxAgeMs);
      return database;
    });
  }

  public async inventory(): Promise<OfflineRegionCacheInventory> {
    const database = await this.#database;
    return runTransaction(database, "readonly", async (transaction) => {
      const inventory = await request<InventoryRecord | undefined>(
        transaction.objectStore(INVENTORY_STORE).get(INVENTORY_KEY),
      );
      const records = await request<RegionRecord[]>(transaction.objectStore(REGION_STORE).getAll());
      return {
        revision: inventory?.revision ?? "0",
        regions: records
          .map(toStoredRegion)
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      };
    });
  }

  public async readResource(regionId: string, resourceId: string): Promise<OfflineRegionResourceRead | undefined> {
    if (typeof regionId !== "string" || regionId.length === 0) throw new Error("regionId must be non-empty.");
    if (typeof resourceId !== "string" || resourceId.length === 0) throw new Error("resourceId must be non-empty.");
    const database = await this.#database;
    return runTransaction(database, "readwrite", async (transaction) => {
      const inventoryStore = transaction.objectStore(INVENTORY_STORE);
      const region = await request<RegionRecord | undefined>(transaction.objectStore(REGION_STORE).get(regionId));
      if (!region) return undefined;
      const resource = region.manifest.resources.find((candidate) => candidate.id === resourceId);
      if (!resource) return undefined;
      const stored = await request<ResourceRecord | undefined>(
        transaction.objectStore(RESOURCE_STORE).get(resourceKey(regionId, resourceId)),
      );
      if (!stored) return undefined;
      if (stored.bytes.byteLength !== resource.byteLength) {
        throw new Error(`Offline resource ${resourceId} failed its stored byte-length check.`);
      }
      const inventory = await request<InventoryRecord | undefined>(inventoryStore.get(INVENTORY_KEY));
      transaction.objectStore(REGION_STORE).put({
        ...region,
        lastAccessedAt: new Date().toISOString(),
      } satisfies RegionRecord);
      inventoryStore.put({
        key: INVENTORY_KEY,
        revision: nextRevision(inventory?.revision),
      } satisfies InventoryRecord);
      return {
        regionId,
        manifest: region.manifest,
        resource,
        bytes: Uint8Array.from(stored.bytes),
      } satisfies OfflineRegionResourceRead;
    });
  }

  public async removeRegion(regionId: string): Promise<boolean> {
    requireId(regionId, "regionId");
    const database = await this.#database;
    return runTransaction(database, "readwrite", async (transaction) => {
      const inventoryStore = transaction.objectStore(INVENTORY_STORE);
      const regionStore = transaction.objectStore(REGION_STORE);
      const region = await request<RegionRecord | undefined>(regionStore.get(regionId));
      if (!region) return false;
      await deleteResourcesByRegion(transaction, regionId);
      regionStore.delete(regionId);
      const inventory = await request<InventoryRecord | undefined>(inventoryStore.get(INVENTORY_KEY));
      inventoryStore.put({ key: INVENTORY_KEY, revision: nextRevision(inventory?.revision) } satisfies InventoryRecord);
      return true;
    });
  }

  public async setRegionPinned(regionId: string, pinned: boolean): Promise<boolean> {
    requireId(regionId, "regionId");
    if (typeof pinned !== "boolean") throw new TypeError("pinned must be a boolean.");
    const database = await this.#database;
    return runTransaction(database, "readwrite", async (transaction) => {
      const inventoryStore = transaction.objectStore(INVENTORY_STORE);
      const regionStore = transaction.objectStore(REGION_STORE);
      const region = await request<RegionRecord | undefined>(regionStore.get(regionId));
      if (!region || Boolean(region.pinned) === pinned) return false;
      regionStore.put({ ...region, ...(pinned ? { pinned: true } : { pinned: undefined }) } satisfies RegionRecord);
      const inventory = await request<InventoryRecord | undefined>(inventoryStore.get(INVENTORY_KEY));
      inventoryStore.put({ key: INVENTORY_KEY, revision: nextRevision(inventory?.revision) } satisfies InventoryRecord);
      return true;
    });
  }

  public async pruneExpired(now: Date = new Date()): Promise<readonly string[]> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date.");
    const cutoff = now.getTime();
    const database = await this.#database;
    return runTransaction(database, "readwrite", async (transaction) => {
      const regionStore = transaction.objectStore(REGION_STORE);
      const records = await request<RegionRecord[]>(regionStore.getAll());
      const expired = records
        .filter((record) => record.expiresAt !== undefined && Date.parse(record.expiresAt) <= cutoff)
        .map((record) => record.id)
        .sort();
      if (expired.length === 0) return expired;
      for (const regionId of expired) {
        await deleteResourcesByRegion(transaction, regionId);
        regionStore.delete(regionId);
      }
      const inventoryStore = transaction.objectStore(INVENTORY_STORE);
      const inventory = await request<InventoryRecord | undefined>(inventoryStore.get(INVENTORY_KEY));
      inventoryStore.put({ key: INVENTORY_KEY, revision: nextRevision(inventory?.revision) } satisfies InventoryRecord);
      return expired;
    });
  }

  public async beginWrite(regionId: string): Promise<OfflineRegionWriteTransaction> {
    if (typeof regionId !== "string" || regionId.length === 0) throw new Error("regionId must be non-empty.");
    const database = await this.#database;
    const transactionId = createTransactionId();
    const evictions: string[] = [];
    return {
      evict: async (id) => {
        if (!evictions.includes(id)) evictions.push(id);
      },
      write: async (resource, bytes) => {
        const copy = Uint8Array.from(bytes);
        if (copy.byteLength !== resource.byteLength) {
          throw new Error(`Resource ${resource.id} byte length does not match its descriptor.`);
        }
        await runTransaction(database, "readwrite", async (transaction) => {
          transaction.objectStore(STAGING_STORE).put({
            key: resourceKey(transactionId, resource.id),
            transactionId,
            regionId,
            resourceId: resource.id,
            bytes: copy,
            createdAt: Date.now(),
          } satisfies StagedResourceRecord);
        });
      },
      commit: async (manifest, receipt, guard) => {
        return runTransaction(database, "readwrite", async (transaction) => {
          const inventoryStore = transaction.objectStore(INVENTORY_STORE);
          const regionStore = transaction.objectStore(REGION_STORE);
          const currentInventory = await request<InventoryRecord | undefined>(inventoryStore.get(INVENTORY_KEY));
          if ((currentInventory?.revision ?? "0") !== guard.expectedInventoryRevision) return "inventory-changed";

          const records = await request<RegionRecord[]>(regionStore.getAll());
          const existing = records.find((record) => record.id === manifest.id);
          const evicted = new Set(evictions);
          const remaining = records.filter((record) => record.id !== manifest.id && !evicted.has(record.id));
          const logicalBytesAfter =
            remaining.reduce((total, record) => total + record.logicalByteLength, 0) + manifest.totalLogicalBytes;
          if (
            logicalBytesAfter > guard.logicalQuotaBytes ||
            logicalBytesAfter !== guard.admission.logicalBytesAfter ||
            guard.admission.requiredLogicalBytes !== manifest.totalLogicalBytes ||
            guard.admission.replacementLogicalBytes !== (existing?.logicalByteLength ?? 0) ||
            !sameIds(guard.admission.evictRegionIds, evictions)
          ) {
            throw new Error("IndexedDB store rejected inconsistent offline-region admission.");
          }
          await deleteResourcesByRegion(transaction, manifest.id);
          for (const id of evictions) await deleteResourcesByRegion(transaction, id);
          for (const id of evictions) regionStore.delete(id);
          regionStore.put({
            id: manifest.id,
            manifest,
            receipt,
            logicalByteLength: manifest.totalLogicalBytes,
            lastAccessedAt: receipt.completedAt,
            ...(manifest.expiresAt ? { expiresAt: manifest.expiresAt } : {}),
            ...(existing?.pinned ? { pinned: true } : {}),
          } satisfies RegionRecord);
          await moveStagedResources(
            transaction,
            transactionId,
            manifest.id,
            new Set(manifest.resources.map((resource) => resource.id)),
          );
          inventoryStore.put({
            key: INVENTORY_KEY,
            revision: nextRevision(currentInventory?.revision),
          } satisfies InventoryRecord);
          return "committed";
        });
      },
      rollback: async () => {
        await clearStagedResources(database, transactionId);
        evictions.length = 0;
      },
    };
  }
}

export function createIndexedDbOfflineRegionStore(
  options: IndexedDbOfflineRegionStoreOptions = {},
): IndexedDbOfflineRegionStore {
  return new IndexedDbOfflineRegionStore(options);
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INVENTORY_STORE))
        database.createObjectStore(INVENTORY_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(REGION_STORE))
        database.createObjectStore(REGION_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(RESOURCE_STORE))
        database.createObjectStore(RESOURCE_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(STAGING_STORE))
        database.createObjectStore(STAGING_STORE, { keyPath: "key" });
      const resources = request.transaction?.objectStore(RESOURCE_STORE);
      if (resources && !resources.indexNames.contains(REGION_ID_INDEX))
        resources.createIndex(REGION_ID_INDEX, "regionId");
      const staging = request.transaction?.objectStore(STAGING_STORE);
      if (staging && !staging.indexNames.contains(TRANSACTION_ID_INDEX))
        staging.createIndex(TRANSACTION_ID_INDEX, "transactionId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB database."));
    request.onblocked = () => reject(new Error("IndexedDB database upgrade is blocked by another open connection."));
  });
}

function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([INVENTORY_STORE, REGION_STORE, RESOURCE_STORE, STAGING_STORE], mode);
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
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      }
    };
  });
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function toStoredRegion(record: RegionRecord): OfflineRegionStoredRegion {
  return {
    id: record.id,
    logicalByteLength: record.logicalByteLength,
    lastAccessedAt: record.lastAccessedAt,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.pinned ? { pinned: true } : {}),
  };
}

function requireId(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be non-empty.`);
}

function resourceKey(regionId: string, resourceId: string): string {
  return `${regionId}${RESOURCE_SEPARATOR}${resourceId}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function createTransactionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function nextRevision(previous: string | undefined): string {
  return `${previous ?? "0"}-${createTransactionId()}`;
}

function deleteResourcesByRegion(transaction: IDBTransaction, regionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cursorRequest = transaction
      .objectStore(RESOURCE_STORE)
      .index(REGION_ID_INDEX)
      .openCursor(IDBKeyRange.only(regionId));
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error("Failed to enumerate offline-region resources."));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}

function moveStagedResources(
  transaction: IDBTransaction,
  transactionId: string,
  regionId: string,
  expectedResourceIds: ReadonlySet<string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const resourceStore = transaction.objectStore(RESOURCE_STORE);
    const cursorRequest = transaction
      .objectStore(STAGING_STORE)
      .index(TRANSACTION_ID_INDEX)
      .openCursor(IDBKeyRange.only(transactionId));
    const seen = new Set<string>();
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error("Failed to enumerate staged offline-region resources."));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        if (seen.size !== expectedResourceIds.size || [...expectedResourceIds].some((id) => !seen.has(id))) {
          reject(new Error("IndexedDB store requires every manifest resource to be written before commit."));
        } else {
          resolve();
        }
        return;
      }
      const staged = cursor.value as StagedResourceRecord;
      if (staged.regionId !== regionId || !expectedResourceIds.has(staged.resourceId) || seen.has(staged.resourceId)) {
        reject(new Error("IndexedDB store found an unexpected staged offline-region resource."));
        return;
      }
      seen.add(staged.resourceId);
      resourceStore.put({
        key: resourceKey(regionId, staged.resourceId),
        regionId,
        resourceId: staged.resourceId,
        bytes: staged.bytes,
      } satisfies ResourceRecord);
      cursor.delete();
      cursor.continue();
    };
  });
}

function clearStagedResources(database: IDBDatabase, transactionId: string): Promise<void> {
  return runTransaction(database, "readwrite", async (transaction) => {
    await deleteStagedResources(transaction, transactionId);
  });
}

function cleanupAbandonedStaging(database: IDBDatabase, maxAgeMs: number): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  return runTransaction(database, "readwrite", async (transaction) => {
    await deleteStagedResourcesOlderThan(transaction, cutoff);
  });
}

function deleteStagedResourcesOlderThan(transaction: IDBTransaction, cutoff: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cursorRequest = transaction.objectStore(STAGING_STORE).openCursor();
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error("Failed to reclaim abandoned staged offline-region resources."));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      const staged = cursor.value as Partial<StagedResourceRecord>;
      if (typeof staged.createdAt !== "number" || staged.createdAt < cutoff) cursor.delete();
      cursor.continue();
    };
  });
}

function deleteStagedResources(transaction: IDBTransaction, transactionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cursorRequest = transaction
      .objectStore(STAGING_STORE)
      .index(TRANSACTION_ID_INDEX)
      .openCursor(IDBKeyRange.only(transactionId));
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error("Failed to clear staged offline-region resources."));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}
