import { assertCredentialFreeManifest, credentialScreenMessage, screenPersistedString } from "./credential-screen.js";
import { compareCodeUnits } from "./digest.js";
import {
  HonuaOfflineRegionError,
  type OfflineRegionCacheAdmin,
  type OfflineRegionCacheInventory,
  type OfflineRegionDownloadReceipt,
  type OfflineRegionManifestV1,
  type OfflineRegionResourceRead,
  type OfflineRegionStore,
  type OfflineRegionStoredRegion,
  type OfflineRegionWriteTransaction,
} from "./types.js";

/**
 * In-memory twin of the persistent region store.
 *
 * It exists so the download coordinator, the read path, and application code can
 * be exercised anywhere IndexedDB is not — Node, workers, SSR, tests — against
 * exactly the same contract. It enforces the same invariants the IndexedDB
 * adapter does: one revision advance per committed mutation, compare-and-set
 * admission at commit, caller-owned byte copies in and out, and credential
 * screening of every identity it is asked to persist. It is not durable; process
 * exit is data loss, by design.
 *
 * @experimental
 */

interface MemoryRegionRecord {
  readonly manifest: OfflineRegionManifestV1;
  readonly receipt: OfflineRegionDownloadReceipt;
  readonly logicalByteLength: number;
  lastAccessedAt: string;
  readonly expiresAt?: string;
  pinned?: boolean;
  readonly resources: Map<string, Uint8Array>;
}

export interface MemoryOfflineRegionStoreOptions {
  /** Injectable clock so tests can observe deterministic access timestamps. */
  readonly now?: () => Date;
}

export class MemoryOfflineRegionStore implements OfflineRegionStore, OfflineRegionCacheAdmin {
  readonly #regions = new Map<string, MemoryRegionRecord>();
  readonly #staging = new Map<string, Map<string, Uint8Array>>();
  readonly #now: () => Date;
  #revision = "0";
  #sequence = 0;

  public constructor(options: MemoryOfflineRegionStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public async inventory(): Promise<OfflineRegionCacheInventory> {
    const regions: OfflineRegionStoredRegion[] = [];
    for (const [id, record] of this.#regions) {
      regions.push({
        id,
        logicalByteLength: record.logicalByteLength,
        lastAccessedAt: record.lastAccessedAt,
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
        ...(record.pinned ? { pinned: true } : {}),
      });
    }
    regions.sort((left, right) => compareCodeUnits(left.id, right.id));
    return { revision: this.#revision, regions };
  }

  public async readResource(regionId: string, resourceId: string): Promise<OfflineRegionResourceRead | undefined> {
    requireId(regionId, "regionId");
    requireId(resourceId, "resourceId");
    const record = this.#regions.get(regionId);
    if (!record) return undefined;
    const resource = record.manifest.resources.find((candidate) => candidate.id === resourceId);
    if (!resource) return undefined;
    const bytes = record.resources.get(resourceId);
    if (!bytes) return undefined;
    if (bytes.byteLength !== resource.byteLength) {
      throw new HonuaOfflineRegionError(
        "integrity-mismatch",
        `Offline resource ${resourceId} failed its stored byte-length check.`,
        { resourceId },
      );
    }
    record.lastAccessedAt = this.#now().toISOString();
    this.#advance();
    return { regionId, manifest: record.manifest, resource, bytes: Uint8Array.from(bytes) };
  }

  public async removeRegion(regionId: string): Promise<boolean> {
    requireId(regionId, "regionId");
    if (!this.#regions.delete(regionId)) return false;
    this.#advance();
    return true;
  }

  public async setRegionPinned(regionId: string, pinned: boolean): Promise<boolean> {
    requireId(regionId, "regionId");
    if (typeof pinned !== "boolean") throw new TypeError("pinned must be a boolean.");
    const record = this.#regions.get(regionId);
    if (!record || Boolean(record.pinned) === pinned) return false;
    record.pinned = pinned || undefined;
    this.#advance();
    return true;
  }

  public async pruneExpired(now: Date = this.#now()): Promise<readonly string[]> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date.");
    const cutoff = now.getTime();
    const expired = [...this.#regions.entries()]
      .filter(([, record]) => record.expiresAt !== undefined && Date.parse(record.expiresAt) <= cutoff)
      .map(([id]) => id)
      .sort(compareCodeUnits);
    if (expired.length === 0) return expired;
    for (const id of expired) this.#regions.delete(id);
    this.#advance();
    return expired;
  }

  public async beginWrite(regionId: string): Promise<OfflineRegionWriteTransaction> {
    requireId(regionId, "regionId");
    assertCredentialFreeIdentity(regionId, "regionId");
    const evictions: string[] = [];
    const staged = this.#staging.get(regionId) ?? new Map<string, Uint8Array>();
    this.#staging.set(regionId, staged);
    return {
      evict: async (id) => {
        if (!evictions.includes(id)) evictions.push(id);
      },
      readStaged: async (resource) => {
        const bytes = staged.get(resource.id);
        if (!bytes || bytes.byteLength !== resource.byteLength) return undefined;
        return Uint8Array.from(bytes);
      },
      discardStaged: async (resource) => {
        staged.delete(resource.id);
      },
      write: async (resource, bytes) => {
        assertCredentialFreeIdentity(resource.id, "resource.id");
        const copy = Uint8Array.from(bytes);
        if (copy.byteLength !== resource.byteLength) {
          throw new HonuaOfflineRegionError(
            "integrity-mismatch",
            `Resource ${resource.id} byte length does not match its descriptor.`,
            { resourceId: resource.id },
          );
        }
        staged.set(resource.id, copy);
      },
      commit: async (manifest, receipt, guard) => {
        // `commit` is public, so the credential-free manifest invariant is
        // re-enforced here rather than trusted from the coordinator.
        assertCredentialFreeManifest(manifest);
        if (this.#revision !== guard.expectedInventoryRevision) return "inventory-changed";
        const existing = this.#regions.get(manifest.id);
        const evicted = new Set(evictions);
        let logicalBytesAfter = manifest.totalLogicalBytes;
        for (const [id, record] of this.#regions) {
          if (id === manifest.id || evicted.has(id)) continue;
          logicalBytesAfter += record.logicalByteLength;
        }
        if (
          logicalBytesAfter > guard.logicalQuotaBytes ||
          logicalBytesAfter !== guard.admission.logicalBytesAfter ||
          guard.admission.requiredLogicalBytes !== manifest.totalLogicalBytes ||
          guard.admission.replacementLogicalBytes !== (existing?.logicalByteLength ?? 0) ||
          !sameIds(guard.admission.evictRegionIds, evictions)
        ) {
          throw new HonuaOfflineRegionError(
            "store-failed",
            "Memory store rejected inconsistent offline-region admission.",
          );
        }
        const expected = new Set(manifest.resources.map((resource) => resource.id));
        for (const resource of manifest.resources) {
          const bytes = staged.get(resource.id);
          if (!bytes || bytes.byteLength !== resource.byteLength) {
            throw new HonuaOfflineRegionError(
              "store-failed",
              "Memory store requires every manifest resource to be written before commit.",
              { resourceId: resource.id },
            );
          }
        }
        for (const id of staged.keys()) {
          if (!expected.has(id)) {
            throw new HonuaOfflineRegionError("store-failed", "Memory store found an unexpected staged resource.", {
              resourceId: id,
            });
          }
        }
        for (const id of evictions) this.#regions.delete(id);
        this.#regions.set(manifest.id, {
          manifest,
          receipt,
          logicalByteLength: manifest.totalLogicalBytes,
          lastAccessedAt: receipt.completedAt,
          ...(manifest.expiresAt ? { expiresAt: manifest.expiresAt } : {}),
          ...(existing?.pinned ? { pinned: true } : {}),
          resources: new Map(staged),
        });
        this.#staging.delete(manifest.id);
        this.#advance();
        return "committed";
      },
      rollback: async (options) => {
        if (!options?.preserveStaged) this.#staging.delete(regionId);
        evictions.length = 0;
      },
    };
  }

  #advance(): void {
    this.#sequence += 1;
    this.#revision = `${this.#sequence}`;
  }
}

export function createMemoryOfflineRegionStore(
  options: MemoryOfflineRegionStoreOptions = {},
): MemoryOfflineRegionStore {
  return new MemoryOfflineRegionStore(options);
}

function requireId(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be non-empty.`);
}

function assertCredentialFreeIdentity(value: string, path: string): void {
  const reason = screenPersistedString(value, "identity");
  if (reason) throw new HonuaOfflineRegionError("invalid-manifest", credentialScreenMessage(path, reason), { path });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
