import { assertCredentialFreeManifest, credentialScreenMessage, screenPersistedString } from "./credential-screen.js";
import {
  HonuaOfflineRegionError,
  type OfflineRegionCacheAdmin,
  type OfflineRegionCacheInventory,
  type OfflineRegionCommitGuard,
  type OfflineRegionDownloadReceipt,
  type OfflineRegionManifestV1,
  type OfflineRegionResourceRead,
  type OfflineRegionStore,
  type OfflineRegionStoredRegion,
  type OfflineRegionWriteTransaction,
} from "./types.js";

const DATABASE_VERSION = 3;

/**
 * Persisted record-layout version written into {@link SCHEMA_STORE} and, since
 * issue #1046, read back on every open.
 *
 * It is not the IndexedDB database version. The database version governs object
 * stores and indexes; this one governs the shape of the values inside them, and
 * it is the input to the forward migration ladder below.
 */
export const HONUA_OFFLINE_REGION_SCHEMA_VERSION = 3 as const;

const CURRENT_SCHEMA_VERSION = HONUA_OFFLINE_REGION_SCHEMA_VERSION;
const MAX_RECOVERY_RECORDS = 100_000;
const MAX_RECOVERY_BYTES = 64 * 1024 * 1024;
/** Bound on ladder walks so a malformed or cyclic registry cannot spin. */
const MAX_SCHEMA_MIGRATION_STEPS = 16;
const INVENTORY_KEY = "current";
const SCHEMA_STORE = "schema";
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

interface SchemaRecord {
  readonly key: typeof INVENTORY_KEY;
  readonly version: number;
}

/**
 * One ordered step of the persisted region-record ladder.
 *
 * A step is a pure structural rewrite of one stored record. It receives only
 * the record — never a caller's options, never the store — so a migration can
 * neither widen a bound nor reach the network, and it must return a record
 * carrying `toVersion`'s layout.
 */
export interface OfflineRegionSchemaMigrationV1 {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (record: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

/** Why a stored schema version cannot be carried to this build's layout. */
export type OfflineRegionSchemaMigrationRefusal = "unknown-version" | "future-version" | "unreachable-version";

export type OfflineRegionSchemaMigrationPlanV1 =
  | {
      readonly applicable: true;
      /** `from->to` labels, oldest first; empty when the store is already current. */
      readonly steps: readonly string[];
      readonly migrations: readonly OfflineRegionSchemaMigrationV1[];
    }
  | {
      readonly applicable: false;
      readonly reason: OfflineRegionSchemaMigrationRefusal;
      readonly detail: string;
    };

/** Stable discriminator and version for region-store recovery reports. */
export const HONUA_OFFLINE_REGION_STORE_RECOVERY_KIND = "honua.offline-region-store-recovery" as const;
export const HONUA_OFFLINE_REGION_STORE_RECOVERY_VERSION = 1 as const;

/**
 * Payload-free account of one store open.
 *
 * Corrupt-record discards and schema-version refusals are separate counts on
 * purpose: the first is damage this build can prove and repair, the second is a
 * layout it declines to guess at. Conflating them is how an application learns
 * its expensive cached bytes are gone only by noticing they are missing.
 */
export interface OfflineRegionStoreRecoveryV1 {
  readonly kind: typeof HONUA_OFFLINE_REGION_STORE_RECOVERY_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_STORE_RECOVERY_VERSION;
  readonly outcome: "ready" | "unreadable";
  readonly storedSchemaVersion: number;
  readonly expectedSchemaVersion: number;
  readonly appliedMigrations: readonly string[];
  readonly migratedRegions: number;
  /** Records this build proved unusable and removed. */
  readonly discardedCorruptRecords: number;
  /** Regions left untouched because their schema version has no migration path. */
  readonly unsupportedRegions: number;
  /** Present only when `outcome` is `unreadable`. */
  readonly error?: HonuaOfflineRegionError;
}

/**
 * Ordered forward migration ladder for persisted region records, oldest first.
 *
 * Schema 2 and schema 3 describe the same `RegionRecord` layout — database
 * version 3 changed only the staging rows, which
 * {@link migrateLegacyStaging} already backfills — so this step is deliberately
 * the identity on region records. It exists because the machinery has to be
 * real and exercised before the first layout change, not written under the
 * pressure of one: the ladder, its bounds, its identity invariants, and its
 * fail-closed refusal are all proven by a step that provably changes nothing.
 */
export const OFFLINE_REGION_SCHEMA_MIGRATIONS: readonly OfflineRegionSchemaMigrationV1[] = Object.freeze([
  Object.freeze({
    fromVersion: 2,
    toVersion: 3,
    migrate: (record: Readonly<Record<string, unknown>>): Record<string, unknown> => ({ ...record }),
  }),
]) as readonly OfflineRegionSchemaMigrationV1[];

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
  /** Ladder applied to persisted region records on open. Defaults to {@link OFFLINE_REGION_SCHEMA_MIGRATIONS}. */
  readonly migrations?: readonly OfflineRegionSchemaMigrationV1[];
  /** Receives the schema and recovery outcome of every open. Must not throw. */
  readonly onRecovery?: (report: OfflineRegionStoreRecoveryV1) => void;
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
 *
 * That is enforced rather than assumed. `beginWrite`, `write`, and `commit` are
 * public exports, so each re-screens the identities it is about to persist and
 * `commit` re-checks the whole manifest. A caller that bypasses
 * `downloadOfflineRegion` cannot persist a credential-bearing endpoint, region
 * id, or resource id.
 */
export class IndexedDbOfflineRegionStore implements OfflineRegionStore, OfflineRegionCacheAdmin {
  readonly #database: Promise<IDBDatabase>;
  readonly #stagingMaxAgeMs: number;

  public constructor(options: IndexedDbOfflineRegionStoreOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available in this runtime.");
    const name = options.name ?? "honua-offline-regions";
    if (name.trim().length === 0) throw new Error("IndexedDB database name must be non-empty.");
    const stagingMaxAgeMs = options.stagingMaxAgeMs ?? DEFAULT_STAGING_MAX_AGE_MS;
    if (!Number.isFinite(stagingMaxAgeMs) || stagingMaxAgeMs < 0)
      throw new Error("stagingMaxAgeMs must be a non-negative finite number.");
    this.#stagingMaxAgeMs = stagingMaxAgeMs;
    const migrations = options.migrations ?? OFFLINE_REGION_SCHEMA_MIGRATIONS;
    const onRecovery = options.onRecovery;
    const opened = openDatabase(factory, name).then(async (database) => {
      // Version resolution precedes every mutating pass. A layout this build
      // cannot carry forward refuses here, before `recoverDatabase` could
      // mistake an unrecognized record shape for corruption and delete it.
      const schema = await migrateRegionSchema(database, migrations);
      if (schema.outcome === "unreadable") {
        onRecovery?.(schema.report);
        throw (
          schema.report.error ?? new HonuaOfflineRegionError("store-unreadable", "Offline region store is unreadable.")
        );
      }
      const discarded = await recoverDatabase(database);
      await cleanupAbandonedStaging(database, stagingMaxAgeMs);
      onRecovery?.(
        Object.freeze({
          ...schema.report,
          discardedCorruptRecords: discarded,
        }) satisfies OfflineRegionStoreRecoveryV1,
      );
      return database;
    });
    // A store that refuses to open reports through every method that awaits it.
    // Swallowing the copy here keeps a refusal from also surfacing as an
    // unhandled rejection in a host that has not called anything yet.
    opened.catch(() => undefined);
    this.#database = opened;
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
    // Staged rows are keyed by this value, so it is screened before any write
    // rather than only at commit.
    assertCredentialFreeIdentity(regionId, "regionId");
    const database = await this.#database;
    // The manifest id is the resume checkpoint identity. It is deterministic,
    // credential-free, and cannot collide across different snapshots.
    const transactionId = regionId;
    const evictions: string[] = [];
    return {
      evict: async (id) => {
        if (!evictions.includes(id)) evictions.push(id);
      },
      readStaged: async (resource) => {
        const staged = await runTransaction(database, "readwrite", async (transaction) => {
          const store = transaction.objectStore(STAGING_STORE);
          const key = resourceKey(transactionId, resource.id);
          const value = await request<StagedResourceRecord | undefined>(store.get(key));
          if (
            value &&
            (value.regionId !== regionId ||
              value.bytes.byteLength !== resource.byteLength ||
              !Number.isFinite(value.createdAt) ||
              Date.now() - value.createdAt > this.#stagingMaxAgeMs)
          ) {
            store.delete(key);
            return undefined;
          }
          return value;
        });
        if (!staged) return undefined;
        return Uint8Array.from(staged.bytes);
      },
      discardStaged: async (resource) => {
        await runTransaction(database, "readwrite", async (transaction) => {
          transaction.objectStore(STAGING_STORE).delete(resourceKey(transactionId, resource.id));
        });
      },
      write: async (resource, bytes) => {
        assertCredentialFreeIdentity(resource.id, "resource.id");
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
        // `commit` is a public export. Re-enforce the credential-free manifest
        // invariant here so a caller that bypassed `downloadOfflineRegion`
        // cannot persist a credential-bearing endpoint or identity.
        assertCredentialFreeManifest(manifest);
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
      rollback: async (options) => {
        if (!options?.preserveStaged) await clearStagedResources(database, transactionId);
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
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INVENTORY_STORE))
        database.createObjectStore(INVENTORY_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(REGION_STORE))
        database.createObjectStore(REGION_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(RESOURCE_STORE))
        database.createObjectStore(RESOURCE_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(STAGING_STORE))
        database.createObjectStore(STAGING_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(SCHEMA_STORE))
        database.createObjectStore(SCHEMA_STORE, { keyPath: "key" });
      const resources = request.transaction?.objectStore(RESOURCE_STORE);
      if (resources && !resources.indexNames.contains(REGION_ID_INDEX))
        resources.createIndex(REGION_ID_INDEX, "regionId");
      const staging = request.transaction?.objectStore(STAGING_STORE);
      if (staging && !staging.indexNames.contains(TRANSACTION_ID_INDEX))
        staging.createIndex(TRANSACTION_ID_INDEX, "transactionId");
      request.transaction
        ?.objectStore(SCHEMA_STORE)
        .put({ key: INVENTORY_KEY, version: CURRENT_SCHEMA_VERSION } satisfies SchemaRecord);
      migrateLegacyStaging(request.transaction, event.oldVersion);
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
    const transaction = database.transaction(
      [INVENTORY_STORE, REGION_STORE, RESOURCE_STORE, STAGING_STORE, SCHEMA_STORE],
      mode,
    );
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

function migrateLegacyStaging(transaction: IDBTransaction | null, oldVersion: number): void {
  if (!transaction || oldVersion >= DATABASE_VERSION) return;
  const store = transaction.objectStore(STAGING_STORE);
  const cursorRequest = store.openCursor();
  let inspected = 0;
  let bytes = 0;
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    inspected += 1;
    if (inspected > MAX_RECOVERY_RECORDS) throw new Error("IndexedDB migration record limit exceeded.");
    const value = cursor.value as Partial<StagedResourceRecord>;
    bytes += value.bytes instanceof Uint8Array ? value.bytes.byteLength : 0;
    if (bytes > MAX_RECOVERY_BYTES) throw new Error("IndexedDB migration byte limit exceeded.");
    if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
      cursor.update({ ...value, createdAt: Date.now() });
    }
    cursor.continue();
  };
}

// --- Persisted schema version and forward migration (issue #1046) ------------
//
// `CURRENT_SCHEMA_VERSION` used to be written and never read, which left exactly
// one response to a record shape this build did not recognize: `isValidRegion`
// returning false and the cursor deleting it. A layout change would therefore
// have destroyed every cached region on the next open — bytes that are
// expensive to re-acquire, often over a metered or absent network — with no
// migration step, no typed outcome, and no count reported to the application
// that just lost its offline data.
//
// The ladder below closes that, following the shape #940 established for the
// `honua.geoarrow.batch` envelope: ordered `fromVersion` → `toVersion` steps
// resolved before any record is touched, applied inside one transaction that
// either completes or leaves the prior version intact, and a fail-closed
// refusal — never a silent bulk delete — when no path exists.

/**
 * Resolve the ordered steps that carry `version` forward to `targetVersion`.
 *
 * Exported because a host needs to answer "can this store still be read?"
 * without opening it, and because the unreachable case — a ladder whose chain
 * dead-ends before the target — has to be provable rather than assumed. The
 * walk is bounded and cycle-safe: at most {@link MAX_SCHEMA_MIGRATION_STEPS}
 * steps, and no version is visited twice.
 */
export function planOfflineRegionSchemaMigration(
  version: unknown,
  migrations: readonly OfflineRegionSchemaMigrationV1[] = OFFLINE_REGION_SCHEMA_MIGRATIONS,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): OfflineRegionSchemaMigrationPlanV1 {
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    return { applicable: false, reason: "unknown-version", detail: `"${String(version)}" is not a schema version.` };
  }
  if (version === targetVersion) return { applicable: true, steps: Object.freeze([]), migrations: Object.freeze([]) };
  const steps: string[] = [];
  const applied: OfflineRegionSchemaMigrationV1[] = [];
  const visited = new Set<number>([version]);
  let cursor = version;
  while (steps.length < MAX_SCHEMA_MIGRATION_STEPS) {
    const step = migrations.find((candidate) => candidate.fromVersion === cursor);
    if (!step) break;
    if (visited.has(step.toVersion)) break;
    visited.add(step.toVersion);
    steps.push(`${step.fromVersion}->${step.toVersion}`);
    applied.push(step);
    cursor = step.toVersion;
    if (cursor === targetVersion) {
      return { applicable: true, steps: Object.freeze(steps), migrations: Object.freeze(applied) };
    }
  }
  // The walk stalled. A version the ladder has never heard of is unknown (or
  // ahead of this build); one it knows but cannot carry home is an unreachable
  // path. Both refuse rather than guess at a layout.
  const known = migrations.some((step) => step.fromVersion === version || step.toVersion === version);
  if (steps.length > 0 || known) {
    return {
      applicable: false,
      reason: "unreachable-version",
      detail: `No migration path carries offline region schema version ${version} to ${targetVersion}.`,
    };
  }
  return {
    applicable: false,
    reason: version > targetVersion ? "future-version" : "unknown-version",
    detail: `Offline region schema version ${version} has no migration to ${targetVersion}.`,
  };
}

/** Report which persisted schema versions this build can still read. */
export function readableOfflineRegionSchemaVersions(
  migrations: readonly OfflineRegionSchemaMigrationV1[] = OFFLINE_REGION_SCHEMA_MIGRATIONS,
): readonly number[] {
  const versions = new Set<number>([CURRENT_SCHEMA_VERSION]);
  for (const step of migrations) {
    if (planOfflineRegionSchemaMigration(step.fromVersion, migrations).applicable) versions.add(step.fromVersion);
  }
  return Object.freeze([...versions].sort((left, right) => left - right));
}

/**
 * Read the persisted schema version and, when the ladder can reach this build's
 * layout, migrate every region record forward inside one transaction.
 */
function migrateRegionSchema(
  database: IDBDatabase,
  migrations: readonly OfflineRegionSchemaMigrationV1[],
): Promise<{ readonly outcome: "ready" | "unreadable"; readonly report: OfflineRegionStoreRecoveryV1 }> {
  return runTransaction(database, "readwrite", async (transaction) => {
    const schemaStore = transaction.objectStore(SCHEMA_STORE);
    const regionStore = transaction.objectStore(REGION_STORE);
    const stored = await request<unknown>(schemaStore.get(INVENTORY_KEY));
    // Every database whose stores exist went through an upgrade that stamped
    // this row, so an absent one carries no evidence of an older layout. It is
    // restored to the current version rather than guessed at.
    const storedVersion =
      isRecord(stored) && typeof stored.version === "number" ? stored.version : CURRENT_SCHEMA_VERSION;
    const plan = planOfflineRegionSchemaMigration(storedVersion, migrations);
    if (!plan.applicable) {
      const unsupportedRegions = await request<number>(regionStore.count());
      return {
        outcome: "unreadable" as const,
        report: Object.freeze({
          kind: HONUA_OFFLINE_REGION_STORE_RECOVERY_KIND,
          version: HONUA_OFFLINE_REGION_STORE_RECOVERY_VERSION,
          outcome: "unreadable" as const,
          storedSchemaVersion: storedVersion,
          expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
          appliedMigrations: Object.freeze([]),
          migratedRegions: 0,
          discardedCorruptRecords: 0,
          unsupportedRegions,
          error: new HonuaOfflineRegionError(
            "store-unreadable",
            `Offline region store is at schema version ${storedVersion}; this build reads ${CURRENT_SCHEMA_VERSION}. ${plan.detail} ${unsupportedRegions} region(s) were left intact.`,
          ),
        }),
      };
    }
    const migratedRegions = plan.steps.length === 0 ? 0 : await migrateRegionRecords(regionStore, plan.migrations);
    schemaStore.put({ key: INVENTORY_KEY, version: CURRENT_SCHEMA_VERSION } satisfies SchemaRecord);
    return {
      outcome: "ready" as const,
      report: Object.freeze({
        kind: HONUA_OFFLINE_REGION_STORE_RECOVERY_KIND,
        version: HONUA_OFFLINE_REGION_STORE_RECOVERY_VERSION,
        outcome: "ready" as const,
        storedSchemaVersion: storedVersion,
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
        appliedMigrations: plan.steps,
        migratedRegions,
        discardedCorruptRecords: 0,
        unsupportedRegions: 0,
      }),
    };
  });
}

/**
 * Apply the resolved steps to every region record under the existing recovery
 * ceilings. A step that rewrites an identity aborts the whole transaction, so
 * the prior database version stays readable.
 */
function migrateRegionRecords(
  store: IDBObjectStore,
  steps: readonly OfflineRegionSchemaMigrationV1[],
): Promise<number> {
  let inspected = 0;
  let bytes = 0;
  let migrated = 0;
  return iterateCursor(store, (cursor) => {
    inspected += 1;
    if (inspected > MAX_RECOVERY_RECORDS) {
      throw new HonuaOfflineRegionError("store-failed", "IndexedDB migration record limit exceeded.");
    }
    const before = cursor.value as Record<string, unknown>;
    bytes += typeof before.logicalByteLength === "number" ? before.logicalByteLength : 0;
    if (bytes > MAX_RECOVERY_BYTES) {
      throw new HonuaOfflineRegionError("store-failed", "IndexedDB migration byte limit exceeded.");
    }
    cursor.update(applyOfflineRegionSchemaMigration(before, steps));
    migrated += 1;
    cursor.continue();
  }).then(() => migrated);
}

/**
 * Carry one persisted region record through an ordered chain of steps.
 *
 * Each step sees only a frozen copy of the record — never the store, never a
 * caller's options — and its output is checked before the next step runs, so a
 * migration that rewrites an identity fails the record instead of quietly
 * repartitioning it. Exported so a host can rehearse a ladder against a record
 * without an IndexedDB transaction.
 */
export function applyOfflineRegionSchemaMigration(
  record: Readonly<Record<string, unknown>>,
  steps: readonly OfflineRegionSchemaMigrationV1[],
): Record<string, unknown> {
  let migrated: Record<string, unknown> = { ...record };
  for (const step of steps) {
    const next = step.migrate(Object.freeze({ ...migrated }));
    if (!isRecord(next)) {
      throw new HonuaOfflineRegionError(
        "store-failed",
        `Offline region migration ${step.fromVersion}->${step.toVersion} did not produce a record.`,
      );
    }
    assertStableRegionIdentity(record, next, step);
    migrated = next;
  }
  return migrated;
}

/**
 * A migrated record keeps exactly the identity it was stored under. The
 * authorization-scope digest partitions every stored key, so re-deriving it
 * would silently repartition another principal's cached bytes.
 */
function assertStableRegionIdentity(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  step: OfflineRegionSchemaMigrationV1,
): void {
  const label = `${step.fromVersion}->${step.toVersion}`;
  if (after.id !== before.id) {
    throw new HonuaOfflineRegionError("store-failed", `Offline region migration ${label} rewrote a region id.`);
  }
  if (regionScopeDigest(before) !== regionScopeDigest(after)) {
    throw new HonuaOfflineRegionError(
      "store-failed",
      `Offline region migration ${label} rewrote an authorization-scope digest.`,
    );
  }
  if (!sameIds(regionResourceIds(before), regionResourceIds(after))) {
    throw new HonuaOfflineRegionError("store-failed", `Offline region migration ${label} rewrote a resource id.`);
  }
}

function regionScopeDigest(record: Record<string, unknown>): string | undefined {
  const manifest = isRecord(record.manifest) ? record.manifest : undefined;
  const source = manifest && isRecord(manifest.source) ? manifest.source : undefined;
  return typeof source?.authorizationScopeDigest === "string" ? source.authorizationScopeDigest : undefined;
}

function regionResourceIds(record: Record<string, unknown>): readonly string[] {
  const manifest = isRecord(record.manifest) ? record.manifest : undefined;
  const resources = manifest && Array.isArray(manifest.resources) ? manifest.resources : [];
  return resources.map((resource) => (isRecord(resource) && typeof resource.id === "string" ? resource.id : ""));
}

/** One bounded pass that discards records this build can prove are unusable. */
function recoverDatabase(database: IDBDatabase): Promise<number> {
  return runTransaction(database, "readwrite", async (transaction) => {
    let discarded = 0;
    const inventoryStore = transaction.objectStore(INVENTORY_STORE);
    const inventory = await request<InventoryRecord | undefined>(inventoryStore.get(INVENTORY_KEY));
    if (inventory !== undefined && !isValidInventory(inventory)) {
      inventoryStore.put({ key: INVENTORY_KEY, revision: "0" } satisfies InventoryRecord);
      discarded += 1;
    }

    const regionStore = transaction.objectStore(REGION_STORE);
    const resourceStore = transaction.objectStore(RESOURCE_STORE);
    const regions = new Map<string, { expected: Map<string, number>; seen: Set<string> }>();
    let inspected = 0;
    let bytes = 0;
    await iterateCursor(regionStore, (cursor) => {
      inspected += 1;
      if (inspected > MAX_RECOVERY_RECORDS) throw new Error("IndexedDB recovery record limit exceeded.");
      const region = cursor.value as Partial<RegionRecord>;
      if (!isValidRegion(region)) {
        cursor.delete();
        discarded += 1;
        cursor.continue();
        return;
      }
      const expected = new Map(region.manifest.resources.map((resource) => [resource.id, resource.byteLength]));
      if (expected.size !== region.manifest.resources.length) {
        cursor.delete();
        discarded += 1;
        cursor.continue();
        return;
      }
      bytes += region.logicalByteLength;
      if (bytes > MAX_RECOVERY_BYTES) throw new Error("IndexedDB recovery byte limit exceeded.");
      regions.set(region.id, { expected, seen: new Set() });
      cursor.continue();
    });

    await iterateCursor(resourceStore, (cursor) => {
      inspected += 1;
      if (inspected > MAX_RECOVERY_RECORDS) throw new Error("IndexedDB recovery record limit exceeded.");
      const resource = cursor.value as Partial<ResourceRecord>;
      const region = typeof resource.regionId === "string" ? regions.get(resource.regionId) : undefined;
      const expectedByteLength = region?.expected.get(resource.resourceId ?? "");
      if (
        !isValidResource(resource) ||
        !region ||
        region.seen.has(resource.resourceId) ||
        expectedByteLength === undefined ||
        resource.key !== resourceKey(resource.regionId, resource.resourceId) ||
        resource.bytes.byteLength !== expectedByteLength
      ) {
        cursor.delete();
        discarded += 1;
        cursor.continue();
        return;
      }
      region.seen.add(resource.resourceId);
      cursor.continue();
    });

    for (const [regionId, region] of regions) {
      if (region.seen.size !== region.expected.size) {
        regionStore.delete(regionId);
        await deleteResourcesByRegion(transaction, regionId);
        discarded += 1;
      }
    }

    const stagingStore = transaction.objectStore(STAGING_STORE);
    await iterateCursor(stagingStore, (cursor) => {
      inspected += 1;
      if (inspected > MAX_RECOVERY_RECORDS) throw new Error("IndexedDB recovery record limit exceeded.");
      const staged = cursor.value as Partial<StagedResourceRecord>;
      if (!isValidStagedResource(staged)) {
        cursor.delete();
        discarded += 1;
      }
      cursor.continue();
    });
    return discarded;
  });
}

function iterateCursor(source: IDBObjectStore, visit: (cursor: IDBCursorWithValue) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cursorRequest = source.openCursor();
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("Failed to enumerate IndexedDB records."));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        visit(cursor);
      } catch (error) {
        reject(error);
      }
    };
  });
}

function isValidInventory(value: InventoryRecord): boolean {
  return isRecord(value) && value.key === INVENTORY_KEY && typeof value.revision === "string";
}

function isValidRegion(value: Partial<RegionRecord>): value is RegionRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isRecord(value.manifest) &&
    Array.isArray(value.manifest.resources) &&
    Number.isSafeInteger(value.logicalByteLength) &&
    (value.logicalByteLength ?? -1) >= 0 &&
    value.logicalByteLength === value.manifest.totalLogicalBytes &&
    typeof value.lastAccessedAt === "string" &&
    Number.isFinite(Date.parse(value.lastAccessedAt))
  );
}

function isValidResource(value: Partial<ResourceRecord>): value is ResourceRecord {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.regionId === "string" &&
    typeof value.resourceId === "string" &&
    value.bytes instanceof Uint8Array
  );
}

function isValidStagedResource(value: Partial<StagedResourceRecord>): value is StagedResourceRecord {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.regionId === "string" &&
    typeof value.resourceId === "string" &&
    value.bytes instanceof Uint8Array &&
    typeof value.transactionId === "string" &&
    Number.isFinite(value.createdAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

/** Refuse a persisted key that carries credential or request-URL shape, without echoing it. */
function assertCredentialFreeIdentity(value: string, path: string): void {
  if (typeof value !== "string") {
    throw new HonuaOfflineRegionError("invalid-manifest", `${path} must be a string.`, { path });
  }
  const reason = screenPersistedString(value, "identity");
  if (reason) {
    throw new HonuaOfflineRegionError("invalid-manifest", credentialScreenMessage(path, reason), { path });
  }
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
