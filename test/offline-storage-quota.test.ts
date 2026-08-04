import { describe, expect, it, vi } from "vitest";
import {
  type CreateOfflineRegionManifestInput,
  DEFAULT_OFFLINE_STORAGE_HEADROOM_RATIO,
  DEFAULT_OFFLINE_STORAGE_MIN_RESERVE_BYTES,
  HONUA_OFFLINE_STORAGE_BUDGET_KIND,
  HONUA_OFFLINE_STORAGE_PERSISTENCE_KIND,
  type HonuaOfflineRegionError,
  type OfflineRegionCacheInventory,
  type OfflineRegionDownloadOptions,
  type OfflineRegionManifestV1,
  type OfflineRegionStore,
  type OfflineRegionWriteTransaction,
  type OfflineStorageBudgetV1,
  type OfflineStorageManagerLike,
  createLocalFirstStatus,
  createOfflineRegionDiagnostic,
  createOfflineRegionManifest,
  downloadOfflineRegion,
  isStorageQuotaPressureError,
  planOfflineRegionAdmission,
  probeOfflineStorageBudget,
  requestOfflinePersistentStorage,
} from "../src/offline/index.js";

const encoder = new TextEncoder();
const MIB = 1024 * 1024;

async function integrity(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function manifest(overrides: Partial<CreateOfflineRegionManifestInput> = {}): Promise<OfflineRegionManifestV1> {
  return createOfflineRegionManifest({
    name: "Quota fixture",
    sourceId: "incidents",
    endpoint: "https://example.test/FeatureServer/0",
    authorizationScopeFingerprint: "tenant:a/role:field",
    bounds: { minX: -158.3, minY: 21.4, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" },
    sourceVersion: "source-v3",
    schemaVersion: "schema-v7",
    planVersion: "plan-v2",
    observation: { state: "live", observedAt: "2026-07-10T10:00:00Z" },
    resources: [{ id: "tile/1/0/0", kind: "tile", byteLength: 3, integrity: await integrity("one") }],
    ...overrides,
  });
}

/** Minimal store whose failure injection points mirror the real adapter phases. */
class FailingStore implements OfflineRegionStore {
  public beginWrites = 0;
  public rollbacks = 0;
  public failInventory?: unknown;
  public failBeginWrite?: unknown;
  public failWrite?: unknown;
  public failCommit?: unknown;
  public failRollback?: unknown;
  public regions: OfflineRegionCacheInventory["regions"] = [];

  public async inventory(): Promise<OfflineRegionCacheInventory> {
    if (this.failInventory) throw this.failInventory;
    return { revision: "1", regions: this.regions.map((region) => ({ ...region })) };
  }

  public async readResource(): Promise<undefined> {
    return undefined;
  }

  public async beginWrite(): Promise<OfflineRegionWriteTransaction> {
    this.beginWrites += 1;
    if (this.failBeginWrite) throw this.failBeginWrite;
    return {
      evict: async () => undefined,
      write: async () => {
        if (this.failWrite) throw this.failWrite;
      },
      commit: async () => {
        if (this.failCommit) throw this.failCommit;
        return "committed";
      },
      rollback: async () => {
        this.rollbacks += 1;
        if (this.failRollback) throw this.failRollback;
      },
    };
  }
}

function quotaExceeded(): DOMException {
  return new DOMException("The quota has been exceeded.", "QuotaExceededError");
}

function downloadOptions(store: OfflineRegionStore, logicalQuotaBytes = 3): OfflineRegionDownloadOptions {
  return { store, logicalQuotaBytes, load: async () => encoder.encode("one") };
}

async function caught(run: () => Promise<unknown>): Promise<HonuaOfflineRegionError> {
  try {
    await run();
  } catch (error) {
    return error as HonuaOfflineRegionError;
  }
  throw new Error("Expected the operation to reject.");
}

describe("offline storage budget probe", () => {
  const now = new Date("2026-08-03T12:00:00Z");

  it("derives a conservative logical budget from the platform estimate", async () => {
    const budget = await probeOfflineStorageBudget({
      storage: { estimate: async () => ({ quota: 1000 * MIB, usage: 200 * MIB }), persisted: async () => true },
      now,
    });

    expect(budget).toEqual({
      kind: HONUA_OFFLINE_STORAGE_BUDGET_KIND,
      version: "1.0",
      status: "available",
      observedAt: "2026-08-03T12:00:00.000Z",
      quotaBytes: 1000 * MIB,
      usageBytes: 200 * MIB,
      remainingBytes: 800 * MIB,
      reserveBytes: 160 * MIB,
      headroomRatio: DEFAULT_OFFLINE_STORAGE_HEADROOM_RATIO,
      logicalBudgetBytes: 640 * MIB,
      persistence: "persisted",
    });
    expect(Object.isFrozen(budget)).toBe(true);
  });

  it("never derives a budget larger than the platform-reported remaining quota", async () => {
    const cases = [
      { quota: 0, usage: 0 },
      { quota: 10, usage: 40 },
      { quota: 32 * MIB, usage: 31 * MIB },
      { quota: 5_000 * MIB, usage: 4_999 * MIB },
      { quota: Number.MAX_SAFE_INTEGER, usage: 0 },
    ];
    for (const estimate of cases) {
      const budget = await probeOfflineStorageBudget({ storage: { estimate: async () => estimate }, now });
      if (budget.status !== "available") throw new Error("Expected an available budget.");
      expect(budget.remainingBytes).toBe(Math.max(0, estimate.quota - estimate.usage));
      expect(budget.logicalBudgetBytes).toBeLessThanOrEqual(budget.remainingBytes);
      expect(budget.reserveBytes + budget.logicalBudgetBytes).toBe(budget.remainingBytes);
      expect(Number.isSafeInteger(budget.logicalBudgetBytes)).toBe(true);
    }
  });

  it("holds back the minimum reserve and refuses to promise a nearly full origin any space", async () => {
    const budget = await probeOfflineStorageBudget({
      storage: { estimate: async () => ({ quota: 20 * MIB, usage: 12 * MIB }) },
      now,
    });
    // Remaining (8 MiB) is under the 16 MiB reserve floor, so the reserve is
    // clamped to everything that is left rather than going negative.
    expect(budget).toMatchObject({ remainingBytes: 8 * MIB, reserveBytes: 8 * MIB, logicalBudgetBytes: 0 });
    expect(DEFAULT_OFFLINE_STORAGE_MIN_RESERVE_BYTES).toBe(16 * MIB);
  });

  it("honours explicit headroom and reserve inputs", async () => {
    const storage = { estimate: async () => ({ quota: 1000, usage: 0 }) };
    expect(await probeOfflineStorageBudget({ storage, now, headroomRatio: 0.5, minimumReserveBytes: 0 })).toMatchObject(
      { reserveBytes: 500, logicalBudgetBytes: 500 },
    );
    expect(await probeOfflineStorageBudget({ storage, now, headroomRatio: 0, minimumReserveBytes: 0 })).toMatchObject({
      reserveBytes: 0,
      logicalBudgetBytes: 1000,
    });
    expect(await probeOfflineStorageBudget({ storage, now, headroomRatio: 1, minimumReserveBytes: 0 })).toMatchObject({
      reserveBytes: 1000,
      logicalBudgetBytes: 0,
    });
  });

  it("is deterministic for identical inputs", async () => {
    const options = {
      storage: { estimate: async () => ({ quota: 987_654_321, usage: 123_456_789 }), persisted: async () => false },
      now,
    };
    const first = await probeOfflineStorageBudget(options);
    const second = await probeOfflineStorageBudget(options);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("floors fractional platform numbers instead of admitting a fractional budget", async () => {
    const budget = await probeOfflineStorageBudget({
      storage: { estimate: async () => ({ quota: 1000.9, usage: 100.9 }) },
      now,
      minimumReserveBytes: 0,
      headroomRatio: 0,
    });
    expect(budget).toMatchObject({ quotaBytes: 1000, usageBytes: 100, logicalBudgetBytes: 900 });
  });

  it("reports an explicit unavailable result on platforms that cannot estimate", async () => {
    // Node has no `navigator.storage`, which is exactly the platform this
    // clause exists for; nothing here fabricates a budget.
    expect(await probeOfflineStorageBudget({ now })).toEqual({
      kind: HONUA_OFFLINE_STORAGE_BUDGET_KIND,
      version: "1.0",
      status: "unavailable",
      observedAt: "2026-08-03T12:00:00.000Z",
      reason: "storage-manager-unavailable",
      persistence: "unknown",
    });

    expect(await probeOfflineStorageBudget({ storage: { persisted: async () => true }, now })).toMatchObject({
      status: "unavailable",
      reason: "estimate-unsupported",
      persistence: "persisted",
    });

    expect(
      await probeOfflineStorageBudget({
        storage: {
          estimate: async () => {
            throw new Error("estimate blocked");
          },
        },
        now,
      }),
    ).toMatchObject({ status: "unavailable", reason: "estimate-failed", persistence: "unknown" });

    for (const estimate of [{}, { quota: 100 }, { usage: 100 }, { quota: Number.NaN, usage: 0 }, undefined]) {
      expect(await probeOfflineStorageBudget({ storage: { estimate: async () => estimate }, now })).toMatchObject({
        status: "unavailable",
        reason: "estimate-incomplete",
      });
    }
  });

  it("reports persisted state without assuming it", async () => {
    const persistence = async (storage: OfflineStorageManagerLike) =>
      (await probeOfflineStorageBudget({ storage, now })).persistence;
    const estimate = async () => ({ quota: 100, usage: 0 });
    expect(await persistence({ estimate, persisted: async () => true })).toBe("persisted");
    expect(await persistence({ estimate, persisted: async () => false })).toBe("best-effort");
    expect(await persistence({ estimate })).toBe("unknown");
    expect(
      await persistence({
        estimate,
        persisted: async () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("unknown");
  });

  it("never requests persistence while probing", async () => {
    const persist = vi.fn(async () => true);
    await probeOfflineStorageBudget({
      storage: { estimate: async () => ({ quota: 100, usage: 0 }), persisted: async () => false, persist },
      now,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects unsupported or out-of-range options", async () => {
    await expect(probeOfflineStorageBudget({ headroomRatio: 1.5 })).rejects.toMatchObject({
      code: "invalid-manifest",
      path: "options.headroomRatio",
    });
    await expect(probeOfflineStorageBudget({ headroomRatio: -0.1 })).rejects.toMatchObject({
      path: "options.headroomRatio",
    });
    await expect(probeOfflineStorageBudget({ minimumReserveBytes: 1.5 })).rejects.toMatchObject({
      path: "options.minimumReserveBytes",
    });
    await expect(probeOfflineStorageBudget({ now: new Date(Number.NaN) })).rejects.toMatchObject({
      path: "options.now",
    });
    await expect(
      probeOfflineStorageBudget({ headroom: 0.5 } as unknown as { headroomRatio?: number }),
    ).rejects.toMatchObject({ path: "options.headroom" });
    await expect(
      probeOfflineStorageBudget({ storage: "navigator" as unknown as OfflineStorageManagerLike }),
    ).rejects.toMatchObject({ path: "options.storage" });
  });
});

describe("explicit persistent-storage requests", () => {
  it("reports the platform verdict only when the caller asks", async () => {
    const persist = vi.fn(async () => true);
    expect(await requestOfflinePersistentStorage({ storage: { persist } })).toEqual({
      kind: HONUA_OFFLINE_STORAGE_PERSISTENCE_KIND,
      version: "1.0",
      status: "granted",
      persistence: "persisted",
    });
    expect(persist).toHaveBeenCalledTimes(1);

    expect(
      await requestOfflinePersistentStorage({ storage: { persist: async () => false, persisted: async () => false } }),
    ).toMatchObject({ status: "denied", persistence: "best-effort" });
  });

  it("reports unavailable platforms without claiming a verdict", async () => {
    expect(await requestOfflinePersistentStorage()).toEqual({
      kind: HONUA_OFFLINE_STORAGE_PERSISTENCE_KIND,
      version: "1.0",
      status: "unavailable",
      persistence: "unknown",
      reason: "storage-manager-unavailable",
    });
    expect(await requestOfflinePersistentStorage({ storage: { persisted: async () => true } })).toMatchObject({
      status: "unavailable",
      reason: "persist-unsupported",
      persistence: "persisted",
    });
    expect(
      await requestOfflinePersistentStorage({
        storage: {
          persist: async () => {
            throw new Error("prompt dismissed");
          },
        },
      }),
    ).toMatchObject({ status: "unavailable", reason: "persist-failed", persistence: "unknown" });
  });

  it("is never invoked by a download", async () => {
    const persist = vi.fn(async () => true);
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { storage: { persist, estimate: async () => ({ quota: 0, usage: 0 }) } },
    });
    try {
      await downloadOfflineRegion(await manifest(), downloadOptions(new FailingStore()));
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("storage-pressure classification", () => {
  it("recognizes platform quota failures and their wrappers", () => {
    expect(isStorageQuotaPressureError(quotaExceeded())).toBe(true);
    expect(isStorageQuotaPressureError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isStorageQuotaPressureError({ name: "QuotaExceededError", code: 22 })).toBe(true);
    expect(isStorageQuotaPressureError({ name: "SomethingElse", code: 1014 })).toBe(true);
    expect(isStorageQuotaPressureError(new Error("wrapped", { cause: quotaExceeded() }))).toBe(true);
    expect(isStorageQuotaPressureError(new AggregateError([new Error("rollback"), quotaExceeded()]))).toBe(true);
    expect(
      isStorageQuotaPressureError(new Error("outer", { cause: new Error("inner", { cause: quotaExceeded() }) })),
    ).toBe(true);
  });

  it("does not classify unrelated failures as storage pressure", () => {
    expect(isStorageQuotaPressureError(new Error("disk unavailable"))).toBe(false);
    expect(isStorageQuotaPressureError({ code: 22 })).toBe(false);
    expect(isStorageQuotaPressureError("QuotaExceededError")).toBe(false);
    expect(isStorageQuotaPressureError(undefined)).toBe(false);
    expect(isStorageQuotaPressureError(new DOMException("aborted", "AbortError"))).toBe(false);
  });

  it("stays bounded on cyclic and hostile causes", () => {
    const cyclic: { name: string; cause?: unknown } = { name: "OuterError" };
    cyclic.cause = cyclic;
    expect(isStorageQuotaPressureError(cyclic)).toBe(false);

    let depth = 0;
    let deep: unknown = quotaExceeded();
    while (depth < 100) {
      deep = new Error(`layer-${depth}`, { cause: deep });
      depth += 1;
    }
    // Deliberately not found: the walk is bounded, so classification cannot be
    // turned into unbounded work by a deeply nested cause chain.
    expect(isStorageQuotaPressureError(deep)).toBe(false);

    const hostile = {
      get name(): string {
        throw new Error("hostile getter");
      },
      cause: quotaExceeded(),
    };
    expect(isStorageQuotaPressureError(hostile)).toBe(true);
  });
});

describe("download admission against storage pressure", () => {
  it("classifies a write-phase QuotaExceededError and carries the attempted plan", async () => {
    const store = new FailingStore();
    store.failWrite = quotaExceeded();
    const error = await caught(async () => downloadOfflineRegion(await manifest(), downloadOptions(store)));

    expect(error.code).toBe("quota-exceeded");
    expect(error.sdkCode).toBe("offline.region.quota");
    expect(error.category).toBe("validation");
    expect(error.admission).toEqual({
      logicalQuotaBytes: 3,
      logicalBytesBefore: 0,
      replacementLogicalBytes: 0,
      requiredLogicalBytes: 3,
      evictRegionIds: [],
      evictedLogicalBytes: 0,
      logicalBytesAfter: 3,
    });
    expect(store.rollbacks).toBe(1);
  });

  it("classifies commit, begin-write, and rollback-phase storage pressure", async () => {
    const fixture = await manifest();

    const commitStore = new FailingStore();
    commitStore.failCommit = quotaExceeded();
    expect((await caught(() => downloadOfflineRegion(fixture, downloadOptions(commitStore)))).code).toBe(
      "quota-exceeded",
    );

    const beginStore = new FailingStore();
    beginStore.failBeginWrite = quotaExceeded();
    const beginError = await caught(() => downloadOfflineRegion(fixture, downloadOptions(beginStore)));
    expect(beginError.code).toBe("quota-exceeded");
    expect(beginError.admission?.requiredLogicalBytes).toBe(3);

    // A rollback that also fails must still name the condition the caller can act on.
    const rollbackStore = new FailingStore();
    rollbackStore.failWrite = quotaExceeded();
    rollbackStore.failRollback = new Error("rollback failed");
    const rollbackError = await caught(() => downloadOfflineRegion(fixture, downloadOptions(rollbackStore)));
    expect(rollbackError.code).toBe("quota-exceeded");
    expect(rollbackError.admission?.requiredLogicalBytes).toBe(3);
  });

  it("upgrades an adapter that wrapped storage pressure in its own untyped store failure", async () => {
    const { HonuaOfflineRegionError: RegionError } = await import("../src/offline/types.js");
    const store = new FailingStore();
    store.failWrite = new RegionError("store-failed", "IndexedDB transaction failed.", { cause: quotaExceeded() });
    const error = await caught(async () => downloadOfflineRegion(await manifest(), downloadOptions(store)));
    expect(error.code).toBe("quota-exceeded");
    expect(error.sdkCode).toBe("offline.region.quota");
  });

  it("leaves unrelated store failures in the internal store-failed class", async () => {
    const store = new FailingStore();
    store.failWrite = new Error("disk unavailable");
    const error = await caught(async () => downloadOfflineRegion(await manifest(), downloadOptions(store)));
    expect(error.code).toBe("store-failed");
    expect(error.sdkCode).toBe("offline.storage.failure");
    expect(error.admission).toBeUndefined();
  });

  it("refuses a download over the derived budget before any resource is fetched", async () => {
    const budget = await probeOfflineStorageBudget({
      storage: { estimate: async () => ({ quota: 2, usage: 0 }) },
      minimumReserveBytes: 0,
      headroomRatio: 0,
    });
    if (budget.status !== "available") throw new Error("Expected an available budget.");
    expect(budget.logicalBudgetBytes).toBe(2);

    const store = new FailingStore();
    const load = vi.fn(async () => encoder.encode("one"));
    const error = await caught(async () =>
      downloadOfflineRegion(await manifest(), {
        store,
        load,
        logicalQuotaBytes: budget.logicalBudgetBytes,
      }),
    );

    expect(error.code).toBe("quota-exceeded");
    expect(load).not.toHaveBeenCalled();
    expect(store.beginWrites).toBe(0);
    expect(error.admission).toMatchObject({ requiredLogicalBytes: 3, logicalQuotaBytes: 2, evictRegionIds: [] });
  });

  it("reports the attempted plan without evicting anything outside it", async () => {
    const fixture = await manifest();
    const inventory: OfflineRegionCacheInventory = {
      revision: "1",
      regions: [
        { id: "pinned", logicalByteLength: 10, lastAccessedAt: "2026-07-01T00:00:00.000Z", pinned: true },
        { id: "cold", logicalByteLength: 4, lastAccessedAt: "2026-07-02T00:00:00.000Z" },
      ],
    };
    const error = await caught(async () =>
      planOfflineRegionAdmission(fixture, inventory, { logicalQuotaBytes: 5, now: new Date("2026-07-10T10:00:00Z") }),
    );

    expect(error.code).toBe("quota-exceeded");
    // `cold` was the only unpinned candidate the deterministic policy selected,
    // and even evicting it leaves the region over quota. The pinned region is
    // never proposed.
    expect(error.admission).toEqual({
      logicalQuotaBytes: 5,
      logicalBytesBefore: 14,
      replacementLogicalBytes: 0,
      requiredLogicalBytes: 3,
      evictRegionIds: ["cold"],
      evictedLogicalBytes: 4,
      logicalBytesAfter: 13,
    });
  });
});

describe("storage budget in cache diagnostics", () => {
  const now = new Date("2026-07-10T10:05:00Z");

  async function budgetFixture(): Promise<OfflineStorageBudgetV1> {
    return probeOfflineStorageBudget({
      storage: { estimate: async () => ({ quota: 1000 * MIB, usage: 100 * MIB }), persisted: async () => true },
      now,
    });
  }

  it("reports observed persisted state instead of inferring it", async () => {
    const fixture = await manifest();
    const storage = await budgetFixture();
    const diagnostic = await createOfflineRegionDiagnostic(
      fixture,
      { revision: "1", regions: [] },
      { logicalQuotaBytes: 1024, now, staleAfterMs: 60_000, storage },
    );

    expect(diagnostic.storage).toEqual(storage);
    expect(diagnostic.storage?.persistence).toBe("persisted");
    // Absent unless the caller supplied an observation; the diagnostic never probes.
    const withoutStorage = await createOfflineRegionDiagnostic(
      fixture,
      { revision: "1", regions: [] },
      { logicalQuotaBytes: 1024, now, staleAfterMs: 60_000 },
    );
    expect(withoutStorage.storage).toBeUndefined();
    expect("storage" in withoutStorage).toBe(false);
  });

  it("explains a rejected admission with the plan that was attempted", async () => {
    const diagnostic = await createOfflineRegionDiagnostic(
      await manifest(),
      { revision: "1", regions: [] },
      { logicalQuotaBytes: 1, now, staleAfterMs: 60_000, storage: await budgetFixture() },
    );

    expect(diagnostic.admission).toEqual({
      status: "rejected",
      reason: "quota-exceeded",
      logicalQuotaBytes: 1,
      attempted: {
        logicalQuotaBytes: 1,
        logicalBytesBefore: 0,
        replacementLogicalBytes: 0,
        requiredLogicalBytes: 3,
        evictRegionIds: [],
        evictedLogicalBytes: 0,
        logicalBytesAfter: 3,
      },
    });
  });

  it("refuses a forged budget envelope rather than publishing it", async () => {
    const fixture = await manifest();
    const forge = (storage: unknown) =>
      createOfflineRegionDiagnostic(
        fixture,
        { revision: "1", regions: [] },
        { logicalQuotaBytes: 1024, now, staleAfterMs: 60_000, storage: storage as OfflineStorageBudgetV1 },
      );
    const base = {
      kind: HONUA_OFFLINE_STORAGE_BUDGET_KIND,
      version: "1.0" as const,
      status: "available" as const,
      observedAt: "2026-07-10T10:05:00.000Z",
      quotaBytes: 1000,
      usageBytes: 900,
      remainingBytes: 100,
      reserveBytes: 20,
      headroomRatio: 0.2,
      logicalBudgetBytes: 80,
      persistence: "best-effort" as const,
    };

    await expect(forge({ ...base, logicalBudgetBytes: 100 })).rejects.toMatchObject({
      path: "storage.logicalBudgetBytes",
    });
    await expect(forge({ ...base, remainingBytes: 900 })).rejects.toMatchObject({ path: "storage.remainingBytes" });
    await expect(forge({ ...base, kind: "honua.other" })).rejects.toMatchObject({ path: "storage.kind" });
    await expect(forge({ ...base, persistence: "maybe" })).rejects.toMatchObject({ path: "storage.persistence" });
    await expect(forge({ ...base, observedAt: "2026-07-10" })).rejects.toMatchObject({ path: "storage.observedAt" });
    await expect(forge({ ...base, extra: 1 })).rejects.toMatchObject({ path: "storage.extra" });
    await expect(forge({ ...base, status: "unavailable", reason: "not-a-reason" })).rejects.toMatchObject({
      path: "storage.reason",
    });
  });

  it("stays composable with the local-first status projection", async () => {
    const diagnostic = await createOfflineRegionDiagnostic(
      await manifest(),
      { revision: "1", regions: [] },
      { logicalQuotaBytes: 1024, now, staleAfterMs: 60_000, storage: await budgetFixture() },
    );
    const status = createLocalFirstStatus({ connectivity: "offline", now, regions: [diagnostic] });

    expect(status.state).toBe("partial");
    expect(status.reads.regionCount).toBe(1);
    // The status projection never republishes the storage estimate.
    expect(JSON.stringify(status)).not.toContain("logicalBudgetBytes");
  });
});
