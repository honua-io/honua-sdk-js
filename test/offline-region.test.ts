import { describe, expect, it, vi } from "vitest";
import {
  type CreateOfflineRegionManifestInput,
  type HonuaOfflineRegionError,
  type OfflineRegionDownloadProgress,
  type OfflineRegionDownloadReceipt,
  type OfflineRegionManifestV1,
  type OfflineRegionResourceV1,
  type OfflineRegionStore,
  type OfflineRegionWriteTransaction,
  createOfflineRegionManifest,
  downloadOfflineRegion,
  planOfflineRegionAdmission,
} from "../src/offline/index.js";

const encoder = new TextEncoder();

async function integrity(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function manifest(overrides: Partial<CreateOfflineRegionManifestInput> = {}): Promise<OfflineRegionManifestV1> {
  const resources = [
    { id: "tile/1/0/0", kind: "tile" as const, byteLength: 3, integrity: await integrity("one") },
    { id: "metadata/source", kind: "metadata" as const, byteLength: 3, integrity: await integrity("two") },
  ];
  return createOfflineRegionManifest({
    name: "North shore field area",
    sourceId: "incidents",
    endpoint: "https://user:pass@example.test/FeatureServer/0?token=secret&f=json&sig=signed",
    authorizationScopeFingerprint: "tenant:a/role:field",
    bounds: { minX: -158.3, minY: 21.4, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" },
    minZoom: 8,
    maxZoom: 14,
    sourceVersion: "source-v3",
    schemaVersion: "schema-v7",
    planVersion: "plan-v2",
    observation: { state: "live", observedAt: "2026-07-10T10:00:00Z", validAt: "2026-07-10T09:59:00Z" },
    validator: { etag: '"snapshot-7"' },
    expiresAt: "2099-07-12T00:00:00Z",
    attribution: { osm: "© OpenStreetMap contributors" },
    resources,
    ...overrides,
  });
}

class RecordingStore implements OfflineRegionStore {
  public regions: Array<{
    id: string;
    byteLength: number;
    lastAccessedAt: string;
    pinned?: boolean;
    expiresAt?: string;
  }> = [];
  public readonly writes: Array<{ resource: OfflineRegionResourceV1; bytes: Uint8Array }> = [];
  public readonly evictions: string[] = [];
  public committed?: { manifest: OfflineRegionManifestV1; receipt: OfflineRegionDownloadReceipt };
  public rollbacks = 0;
  public failWrite = false;

  public async inventory() {
    return { regions: this.regions };
  }

  public async beginWrite(): Promise<OfflineRegionWriteTransaction> {
    const pendingWrites: RecordingStore["writes"] = [];
    const pendingEvictions: string[] = [];
    return {
      evict: async (id) => {
        pendingEvictions.push(id);
      },
      write: async (resource, bytes) => {
        if (this.failWrite) throw new Error("disk unavailable");
        pendingWrites.push({ resource, bytes });
      },
      commit: async (value, receipt) => {
        this.evictions.push(...pendingEvictions);
        this.writes.push(...pendingWrites);
        this.committed = { manifest: value, receipt };
      },
      rollback: async () => {
        this.rollbacks += 1;
      },
    };
  }
}

function expectCode(value: unknown, code: HonuaOfflineRegionError["code"]): void {
  expect(value).toMatchObject({ name: "HonuaOfflineRegionError", code });
}

describe("offline region manifest", () => {
  it("produces deterministic identity independent of resource and attribution insertion order", async () => {
    const first = await manifest();
    const second = await manifest({
      attribution: { second: "Second provider", osm: "© OpenStreetMap contributors" },
      resources: [
        { id: "metadata/source", kind: "metadata", byteLength: 3, integrity: await integrity("two") },
        { id: "tile/1/0/0", kind: "tile", byteLength: 3, integrity: await integrity("one") },
      ],
    });
    const third = await manifest({
      attribution: { osm: "© OpenStreetMap contributors", second: "Second provider" },
      resources: [...second.resources].reverse(),
    });

    expect(first.id).not.toBe(second.id);
    expect(second.id).toBe(third.id);
    expect(third.resources.map((resource) => resource.id)).toEqual(["metadata/source", "tile/1/0/0"]);
    expect(Object.isFrozen(third.resources)).toBe(true);
  });

  it("persists a sanitized endpoint and only a digest of authorization scope", async () => {
    const value = await manifest();
    const serialized = JSON.stringify(value);

    expect(value.source.endpoint).toBe("https://example.test/FeatureServer/0?f=json");
    expect(value.source.authorizationScopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(value.source.observation).toEqual({
      state: "live",
      observedAt: "2026-07-10T10:00:00.000Z",
      validAt: "2026-07-10T09:59:00.000Z",
    });
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("signed");
    expect(serialized).not.toContain("tenant:a/role:field");
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("pass");
  });

  it("rejects duplicate resources, malformed integrity, invalid bounds, and explicit limits", async () => {
    const digest = await integrity("one");
    await expect(
      manifest({
        resources: [
          { id: "same", kind: "tile", byteLength: 3, integrity: digest },
          { id: "same", kind: "tile", byteLength: 3, integrity: digest },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-manifest" });
    await expect(
      manifest({
        resources: [{ id: "bad", kind: "tile", byteLength: 3, integrity: "sha256:NO" as `sha256:${string}` }],
      }),
    ).rejects.toMatchObject({ code: "invalid-manifest" });
    await expect(manifest({ bounds: { minX: 1, minY: 0, maxX: -1, maxY: 1, crs: "EPSG:4326" } })).rejects.toMatchObject(
      { code: "invalid-manifest" },
    );
    await expect(manifest({ limits: { maxBytes: 5 } })).rejects.toMatchObject({
      code: "resource-limit-exceeded",
    });
  });
});

describe("offline region quota admission", () => {
  it("replaces an existing region without double counting it", async () => {
    const value = await manifest();
    expect(
      planOfflineRegionAdmission(
        value,
        { regions: [{ id: value.id, byteLength: 10, lastAccessedAt: "2026-07-01T00:00:00Z" }] },
        { quotaBytes: 6, now: new Date("2026-07-10T00:00:00Z") },
      ),
    ).toMatchObject({ replacementBytes: 10, usedBytesAfter: 6, evictRegionIds: [] });
  });

  it("evicts expired regions before deterministic LRU candidates", async () => {
    const value = await manifest();
    const plan = planOfflineRegionAdmission(
      value,
      {
        regions: [
          { id: "recent", byteLength: 4, lastAccessedAt: "2026-07-09T00:00:00Z" },
          { id: "expired", byteLength: 2, lastAccessedAt: "2026-07-10T00:00:00Z", expiresAt: "2026-07-01Z" },
          { id: "old", byteLength: 3, lastAccessedAt: "2026-07-01T00:00:00Z" },
        ],
      },
      { quotaBytes: 10, now: new Date("2026-07-10T00:00:00Z") },
    );

    expect(plan.evictRegionIds).toEqual(["expired", "old"]);
    expect(plan.usedBytesAfter).toBe(10);
  });

  it("never evicts pinned data and reports an explicit quota failure", async () => {
    const value = await manifest();
    expect(() =>
      planOfflineRegionAdmission(
        value,
        { regions: [{ id: "pinned", byteLength: 5, lastAccessedAt: "2026-01-01Z", pinned: true }] },
        { quotaBytes: 8 },
      ),
    ).toThrowError(expect.objectContaining({ code: "quota-exceeded" }));
  });

  it("does not admit an already expired manifest", async () => {
    const value = await manifest({ expiresAt: "2026-07-01T00:00:00Z" });
    expect(() =>
      planOfflineRegionAdmission(value, { regions: [] }, { quotaBytes: 10, now: new Date("2026-07-10Z") }),
    ).toThrowError(expect.objectContaining({ code: "expired" }));
  });
});

describe("offline region download", () => {
  it("verifies every resource and atomically commits staged eviction and writes", async () => {
    const value = await manifest();
    const store = new RecordingStore();
    store.regions = [{ id: "old", byteLength: 4, lastAccessedAt: "2026-01-01Z" }];
    let progressThrows = true;
    const progress = vi.fn((_progress: OfflineRegionDownloadProgress) => {
      if (progressThrows) {
        progressThrows = false;
        throw new Error("view was disposed");
      }
    });
    const receipt = await downloadOfflineRegion(value, {
      store,
      quotaBytes: 6,
      now: () => new Date("2026-07-10T12:00:00Z"),
      load: async (resource) => encoder.encode(resource.id === "metadata/source" ? "two" : "one"),
      onProgress: progress,
    });

    expect(receipt).toEqual({
      regionId: value.id,
      resourceCount: 2,
      byteLength: 6,
      evictedRegionIds: ["old"],
      integrity: "verified",
      completedAt: "2026-07-10T12:00:00.000Z",
    });
    expect(store.evictions).toEqual(["old"]);
    expect(store.writes.map(({ resource }) => resource.id)).toEqual(["metadata/source", "tile/1/0/0"]);
    expect(store.rollbacks).toBe(0);
    expect(progress.mock.calls.map(([event]) => event.phase)).toEqual([
      "planned",
      "downloading",
      "writing",
      "downloading",
      "writing",
      "committing",
      "complete",
    ]);
  });

  it("rejects a tampered manifest before opening a store transaction", async () => {
    const value = await manifest();
    const store = new RecordingStore();

    await downloadOfflineRegion(
      { ...value, totalBytes: value.totalBytes + 1 },
      {
        store,
        quotaBytes: 10,
        load: async () => encoder.encode("unused"),
      },
    ).catch((error: unknown) => expectCode(error, "invalid-manifest"));

    expect(store.rollbacks).toBe(0);
    expect(store.committed).toBeUndefined();
  });

  it("rolls back on integrity mismatch without publishing staged writes", async () => {
    const value = await manifest();
    const store = new RecordingStore();

    await downloadOfflineRegion(value, {
      store,
      quotaBytes: 10,
      load: async () => encoder.encode("bad"),
    }).catch((error: unknown) => expectCode(error, "integrity-mismatch"));

    expect(store.rollbacks).toBe(1);
    expect(store.writes).toEqual([]);
    expect(store.committed).toBeUndefined();
  });

  it("cooperatively cancels between resources and rolls back", async () => {
    const value = await manifest();
    const store = new RecordingStore();
    const abort = new AbortController();
    let calls = 0;

    await downloadOfflineRegion(value, {
      store,
      quotaBytes: 10,
      signal: abort.signal,
      load: async (resource) => {
        calls += 1;
        abort.abort("operator cancelled");
        return encoder.encode(resource.id === "metadata/source" ? "two" : "one");
      },
    }).catch((error: unknown) => expectCode(error, "aborted"));

    expect(calls).toBe(1);
    expect(store.rollbacks).toBe(1);
    expect(store.committed).toBeUndefined();
  });

  it("wraps loader and store failures in typed errors and rolls back", async () => {
    const value = await manifest();
    const loaderStore = new RecordingStore();
    await downloadOfflineRegion(value, {
      store: loaderStore,
      quotaBytes: 10,
      load: async () => {
        throw new Error("network down");
      },
    }).catch((error: unknown) => expectCode(error, "resource-load-failed"));
    expect(loaderStore.rollbacks).toBe(1);

    const writeStore = new RecordingStore();
    writeStore.failWrite = true;
    await downloadOfflineRegion(value, {
      store: writeStore,
      quotaBytes: 10,
      load: async (resource) => encoder.encode(resource.id === "metadata/source" ? "two" : "one"),
    }).catch((error: unknown) => expectCode(error, "store-failed"));
    expect(writeStore.rollbacks).toBe(1);
  });
});
