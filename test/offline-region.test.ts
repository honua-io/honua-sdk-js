import { describe, expect, it, vi } from "vitest";
import { isHonuaError } from "../src/index.js";
import {
  type CreateOfflineRegionManifestInput,
  type HonuaOfflineRegionError,
  type OfflineRegionCommitGuard,
  type OfflineRegionDownloadProgress,
  type OfflineRegionDownloadReceipt,
  type OfflineRegionManifestV1,
  type OfflineRegionResourceV1,
  type OfflineRegionStore,
  type OfflineRegionStoredRegion,
  type OfflineRegionWriteTransaction,
  createOfflineRegionDiagnostic,
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

class CasRecordingStore implements OfflineRegionStore {
  public revision = 0;
  public regions: OfflineRegionStoredRegion[] = [];
  public readonly writes = new Map<string, Uint8Array>();
  public readonly evictions: string[] = [];
  public committed?: { manifest: OfflineRegionManifestV1; receipt: OfflineRegionDownloadReceipt };
  public rollbacks = 0;
  public failWrite = false;
  public onInventory?: () => void;

  public async inventory() {
    this.onInventory?.();
    return { revision: String(this.revision), regions: this.regions.map((region) => ({ ...region })) };
  }

  public async readResource(): Promise<undefined> {
    return undefined;
  }

  public async beginWrite(): Promise<OfflineRegionWriteTransaction> {
    const pendingWrites = new Map<string, Uint8Array>();
    const pendingEvictions: string[] = [];
    return {
      evict: async (id) => {
        pendingEvictions.push(id);
      },
      write: async (resource, bytes) => {
        if (this.failWrite) throw new Error("disk unavailable");
        pendingWrites.set(resource.id, Uint8Array.from(bytes));
      },
      commit: async (value, receipt, guard) => this.commit(value, receipt, guard, pendingWrites, pendingEvictions),
      rollback: async () => {
        this.rollbacks += 1;
      },
    };
  }

  private commit(
    value: OfflineRegionManifestV1,
    receipt: OfflineRegionDownloadReceipt,
    guard: OfflineRegionCommitGuard,
    pendingWrites: ReadonlyMap<string, Uint8Array>,
    pendingEvictions: readonly string[],
  ): "committed" | "inventory-changed" {
    if (guard.expectedInventoryRevision !== String(this.revision)) return "inventory-changed";
    const remaining = this.regions.filter((region) => region.id !== value.id && !pendingEvictions.includes(region.id));
    const logicalAfter =
      remaining.reduce((total, region) => total + region.logicalByteLength, 0) + value.totalLogicalBytes;
    if (logicalAfter > guard.logicalQuotaBytes || logicalAfter !== guard.admission.logicalBytesAfter) {
      throw new Error("store rejected inconsistent logical quota admission");
    }
    this.regions = [
      ...remaining,
      {
        id: value.id,
        logicalByteLength: value.totalLogicalBytes,
        lastAccessedAt: receipt.completedAt,
        ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
      },
    ];
    this.evictions.push(...pendingEvictions);
    for (const [id, bytes] of pendingWrites) this.writes.set(id, Uint8Array.from(bytes));
    this.committed = { manifest: value, receipt };
    this.revision += 1;
    return "committed";
  }
}

function bytesFor(resource: OfflineRegionResourceV1): Uint8Array {
  return encoder.encode(resource.id === "metadata/source" ? "two" : "one");
}

function expectCode(value: unknown, code: HonuaOfflineRegionError["code"], path?: string): void {
  expect(isHonuaError(value)).toBe(true);
  expect(value).toMatchObject({ name: "HonuaOfflineRegionError", code, ...(path ? { path } : {}) });
}

async function expectRejected(
  promise: Promise<unknown>,
  code: HonuaOfflineRegionError["code"],
  path?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isHonuaError(caught)).toBe(true);
  expect(caught).toMatchObject({
    name: "HonuaOfflineRegionError",
    code,
    ...(path ? { path } : {}),
  });
}

describe("offline region manifest trust boundary", () => {
  it("creates deterministic, immutable, credential-free manifests", async () => {
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
    expect(third.totalLogicalBytes).toBe(6);
    expect(Object.isFrozen(third.resources)).toBe(true);
    const serialized = JSON.stringify(first);
    expect(first.source.endpoint).toBe("https://example.test/FeatureServer/0?f=json");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("signed");
    expect(serialized).not.toContain("tenant:a/role:field");
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("pass");
  });

  it("uses deterministic code-unit ordering without localeCompare", async () => {
    const locale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-sensitive ordering is forbidden");
    });
    const value = await manifest({
      attribution: {},
      resources: [
        { id: "ä", kind: "asset", byteLength: 0, integrity: await integrity("") },
        { id: "z", kind: "asset", byteLength: 0, integrity: await integrity("") },
      ],
    });
    expect(value.resources.map((resource) => resource.id)).toEqual(["z", "ä"]);
    locale.mockRestore();
  });

  it("rejects malformed, sparse, non-plain, and oversized inputs with structured paths", async () => {
    const sparse = new Array<NonNullable<CreateOfflineRegionManifestInput["resources"]>[number]>(2);
    sparse[0] = { id: "one", kind: "asset", byteLength: 0, integrity: await integrity("") };
    await expectRejected(manifest({ resources: sparse }), "invalid-manifest", "resources[1]");
    await expectRejected(
      manifest({ bounds: [] as unknown as CreateOfflineRegionManifestInput["bounds"] }),
      "invalid-manifest",
      "bounds",
    );
    await expectRejected(
      manifest({ name: "0123456789", limits: { maxStringBytes: 8 } }),
      "resource-limit-exceeded",
      "name",
    );

    const accessorAttribution: Record<string, string> = { first: "ok" };
    let accessorInvoked = false;
    Object.defineProperty(accessorAttribution, "second", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return "forbidden";
      },
    });
    await expectRejected(manifest({ attribution: accessorAttribution }), "invalid-manifest", "attribution.second");
    expect(accessorInvoked).toBe(false);
    await expectRejected(
      manifest({ attribution: { first: "ok", second: "too many" }, limits: { maxAttributions: 1 } }),
      "resource-limit-exceeded",
      "attribution",
    );

    let laterDescriptorRead = false;
    const laterResource = { kind: "asset", byteLength: 0, integrity: await integrity("") } as Record<string, unknown>;
    Object.defineProperty(laterResource, "id", {
      enumerable: true,
      get() {
        laterDescriptorRead = true;
        return "later";
      },
    });
    await expectRejected(
      manifest({
        resources: [
          { id: "oversized", kind: "asset", byteLength: 2, integrity: await integrity("xx") },
          laterResource as unknown as CreateOfflineRegionManifestInput["resources"][number],
        ],
        limits: { maxLogicalBytes: 1 },
      }),
      "resource-limit-exceeded",
      "resources[0].byteLength",
    );
    expect(laterDescriptorRead).toBe(false);
  });

  it("rejects unknown properties, duplicate ids, bad integrity, and metadata ceilings", async () => {
    const duplicate = await integrity("one");
    await expectRejected(
      manifest({
        resources: [
          { id: "same", kind: "tile", byteLength: 3, integrity: duplicate },
          { id: "same", kind: "tile", byteLength: 3, integrity: duplicate },
        ],
      }),
      "invalid-manifest",
      "resources[1].id",
    );
    await expectRejected(
      manifest({
        resources: [{ id: "bad", kind: "tile", byteLength: 3, integrity: "sha256:NO" as `sha256:${string}` }],
      }),
      "invalid-manifest",
      "resources[0].integrity",
    );
    await expectRejected(manifest({ limits: { maxMetadataEntries: 1 } }), "resource-limit-exceeded");
    await expectRejected(
      createOfflineRegionManifest({
        ...(await creationInput()),
        extra: true,
      } as CreateOfflineRegionManifestInput),
      "invalid-manifest",
      "input.extra",
    );
  });
});

async function creationInput(): Promise<CreateOfflineRegionManifestInput> {
  const value = await manifest();
  return {
    name: value.name,
    sourceId: value.source.id,
    endpoint: value.source.endpoint,
    authorizationScopeFingerprint: "scope",
    bounds: value.bounds,
    sourceVersion: value.source.sourceVersion,
    schemaVersion: value.source.schemaVersion,
    planVersion: value.source.planVersion,
    observation: value.source.observation,
    resources: value.resources,
  };
}

describe("logical-byte quota admission", () => {
  it("replaces existing logical bytes and evicts expired then LRU entries", async () => {
    const value = await manifest();
    expect(
      planOfflineRegionAdmission(
        value,
        {
          revision: "1",
          regions: [
            {
              id: value.id,
              logicalByteLength: 10,
              lastAccessedAt: "2026-07-01T00:00:00.000Z",
            },
          ],
        },
        { logicalQuotaBytes: 6, now: new Date("2026-07-10T00:00:00Z") },
      ),
    ).toMatchObject({ replacementLogicalBytes: 10, logicalBytesAfter: 6, evictRegionIds: [] });

    const plan = planOfflineRegionAdmission(
      value,
      {
        revision: "2",
        regions: [
          { id: "recent", logicalByteLength: 4, lastAccessedAt: "2026-07-09T00:00:00.000Z" },
          {
            id: "expired",
            logicalByteLength: 2,
            lastAccessedAt: "2026-07-10T00:00:00.000Z",
            expiresAt: "2026-07-01T00:00:00.000Z",
          },
          { id: "old", logicalByteLength: 3, lastAccessedAt: "2026-07-01T00:00:00.000Z" },
        ],
      },
      { logicalQuotaBytes: 10, now: new Date("2026-07-10T00:00:00Z") },
    );
    expect(plan.evictRegionIds).toEqual(["expired", "old"]);
    expect(plan.logicalBytesAfter).toBe(10);
  });

  it("protects pinned regions and rejects expired manifests", async () => {
    const value = await manifest();
    expect(() =>
      planOfflineRegionAdmission(
        value,
        {
          revision: "1",
          regions: [{ id: "pinned", logicalByteLength: 5, lastAccessedAt: "2026-01-01T00:00:00.000Z", pinned: true }],
        },
        { logicalQuotaBytes: 8 },
      ),
    ).toThrowError(expect.objectContaining({ code: "quota-exceeded" }));
    const expired = await manifest({ expiresAt: "2026-07-01T00:00:00Z" });
    expect(() =>
      planOfflineRegionAdmission(
        expired,
        { revision: "1", regions: [] },
        { logicalQuotaBytes: 10, now: new Date("2026-07-10Z") },
      ),
    ).toThrowError(expect.objectContaining({ code: "expired" }));
  });
});

describe("offline region diagnostics", () => {
  it("reports a complete reusable hit, replacement plan, and secret-safe provenance", async () => {
    const value = await manifest({ validator: { etag: '"diagnostic-secret-etag"' } });
    const diagnostic = await createOfflineRegionDiagnostic(
      value,
      {
        revision: "7",
        regions: [
          {
            id: value.id,
            logicalByteLength: value.totalLogicalBytes,
            lastAccessedAt: "2026-07-10T10:01:00.000Z",
            expiresAt: value.expiresAt,
            pinned: true,
          },
        ],
      },
      { logicalQuotaBytes: 32, now: new Date("2026-07-10T10:05:00.000Z"), staleAfterMs: 10 * 60 * 1000 },
    );

    expect(diagnostic).toMatchObject({
      kind: "honua.offline-region-diagnostic",
      version: "1.0",
      generatedAt: "2026-07-10T10:05:00.000Z",
      inventoryRevision: "7",
      cache: {
        state: "offline",
        freshness: "fresh",
        completeness: "complete",
        reason: "offline-entry",
        readable: true,
        pinned: true,
      },
      provenance: {
        sourceId: "incidents",
        endpointFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        authorizationScopeDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sourceVersion: "source-v3",
        schemaVersion: "schema-v7",
        planVersion: "plan-v2",
        validator: { etagFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      },
      contents: {
        resourceCount: 2,
        logicalBytes: 6,
        resourceKinds: { metadata: 1, features: 0, tile: 1, asset: 0, attribution: 0 },
        attributionIds: ["osm"],
      },
      admission: { status: "accepted", plan: { replacementLogicalBytes: 6, evictRegionIds: [] } },
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("diagnostic-secret-etag");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("tenant:a/role:field");
    expect(Object.isFrozen(diagnostic.cache)).toBe(true);
  });

  it("reports a stale miss and exposes deterministic eviction admission", async () => {
    const value = await manifest();
    const diagnostic = await createOfflineRegionDiagnostic(
      value,
      {
        revision: "8",
        regions: [{ id: "older", logicalByteLength: 4, lastAccessedAt: "2026-07-01T00:00:00.000Z" }],
      },
      { logicalQuotaBytes: 6, now: new Date("2026-07-11T10:00:00.000Z"), staleAfterMs: 60 * 60 * 1000 },
    );

    expect(diagnostic.cache).toMatchObject({
      state: "missing",
      freshness: "stale",
      completeness: "missing",
      reason: "cache-miss",
      readable: false,
    });
    expect(diagnostic.admission).toMatchObject({
      status: "accepted",
      plan: { evictRegionIds: ["older"], logicalBytesAfter: 6 },
    });
  });

  it("reports partial expired storage and rejects the expired manifest", async () => {
    const value = await manifest({ expiresAt: "2026-07-10T09:00:00.000Z" });
    const diagnostic = await createOfflineRegionDiagnostic(
      value,
      {
        revision: "9",
        regions: [
          {
            id: value.id,
            logicalByteLength: 3,
            lastAccessedAt: "2026-07-10T08:00:00.000Z",
            expiresAt: value.expiresAt,
          },
        ],
      },
      { logicalQuotaBytes: 6, now: new Date("2026-07-10T10:00:00.000Z"), staleAfterMs: 60 * 60 * 1000 },
    );

    expect(diagnostic.cache).toMatchObject({
      state: "offline",
      freshness: "expired",
      completeness: "partial",
      reason: "expired-entry",
      readable: false,
      storedLogicalBytes: 3,
      expectedLogicalBytes: 6,
    });
    expect(diagnostic.admission).toEqual({ status: "rejected", reason: "expired", logicalQuotaBytes: 6 });
  });

  it("reports quota rejection without throwing or mutating inventory", async () => {
    const value = await manifest();
    const inventory = {
      revision: "10",
      regions: [{ id: "pinned", logicalByteLength: 5, lastAccessedAt: "2026-07-10T00:00:00.000Z", pinned: true }],
    } as const;
    const before = JSON.stringify(inventory);
    const diagnostic = await createOfflineRegionDiagnostic(value, inventory, {
      logicalQuotaBytes: 8,
      now: new Date("2026-07-10T10:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });

    // The rejection explains the plan that was attempted: the pinned region is
    // never proposed for eviction, so the projection still exceeds quota.
    expect(diagnostic.admission).toEqual({
      status: "rejected",
      reason: "quota-exceeded",
      logicalQuotaBytes: 8,
      attempted: {
        logicalQuotaBytes: 8,
        logicalBytesBefore: 5,
        replacementLogicalBytes: 0,
        requiredLogicalBytes: 6,
        evictRegionIds: [],
        evictedLogicalBytes: 0,
        logicalBytesAfter: 11,
      },
    });
    expect(JSON.stringify(inventory)).toBe(before);
  });

  it("rejects a well-shaped manifest whose identity no longer matches its contents", async () => {
    const value = await manifest();
    const tampered = {
      ...value,
      source: { ...value.source, sourceVersion: "tampered-source-version" },
    };

    await expect(
      createOfflineRegionDiagnostic(
        tampered,
        { revision: "11", regions: [] },
        {
          logicalQuotaBytes: 6,
          now: new Date("2026-07-10T10:00:00.000Z"),
          staleAfterMs: 60 * 60 * 1000,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-manifest", path: "id" });
  });
});

describe("offline region download isolation and atomicity", () => {
  it("commits verified coordinator-owned bytes with explicit logical quota accounting", async () => {
    const value = await manifest();
    const store = new CasRecordingStore();
    store.regions = [{ id: "old", logicalByteLength: 4, lastAccessedAt: "2026-01-01T00:00:00.000Z" }];
    const loaderBytes = new Map<string, Uint8Array>();
    let progressThrows = true;
    const progress = vi.fn((event: OfflineRegionDownloadProgress) => {
      if (event.phase === "writing") loaderBytes.get(event.resourceId)?.fill(0);
      if (progressThrows) {
        progressThrows = false;
        throw new Error("view disposed");
      }
    });
    const receipt = await downloadOfflineRegion(value, {
      store,
      logicalQuotaBytes: 6,
      now: () => new Date("2026-07-10T12:00:00Z"),
      load: async (resource) => {
        const bytes = bytesFor(resource);
        loaderBytes.set(resource.id, bytes);
        return bytes;
      },
      onProgress: progress,
    });

    expect(receipt).toEqual({
      regionId: value.id,
      resourceCount: 2,
      logicalByteLength: 6,
      evictedRegionIds: ["old"],
      integrity: "verified",
      quotaAccounting: "logical-payload-bytes",
      completedAt: "2026-07-10T12:00:00.000Z",
    });
    expect([...loaderBytes.values()].every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(new TextDecoder().decode(store.writes.get("metadata/source"))).toBe("two");
    expect(new TextDecoder().decode(store.writes.get("tile/1/0/0"))).toBe("one");
    expect(store.evictions).toEqual(["old"]);
    expect(store.rollbacks).toBe(0);
  });

  it("captures an owned manifest synchronously before any store await can mutate input", async () => {
    const value = await manifest();
    const mutable = JSON.parse(JSON.stringify(value)) as OfflineRegionManifestV1;
    const store = new CasRecordingStore();
    store.onInventory = () => {
      (mutable.resources as Array<OfflineRegionResourceV1>)[0] = {
        ...mutable.resources[0]!,
        id: "mutated-after-snapshot",
      };
      (mutable.source as { endpoint: string }).endpoint = "https://evil.test/?token=leak";
    };
    const seen: string[] = [];
    await downloadOfflineRegion(mutable, {
      store,
      logicalQuotaBytes: 10,
      load: async (resource) => {
        seen.push(resource.id);
        return bytesFor(resource);
      },
    });
    expect(seen).toEqual(["metadata/source", "tile/1/0/0"]);
    expect(store.committed?.manifest.source.endpoint).toBe("https://example.test/FeatureServer/0?f=json");
  });

  it("uses inventory revision CAS so concurrent downloads cannot over-admit", async () => {
    const first = await manifest({ name: "first" });
    const second = await manifest({ name: "second" });
    const store = new CasRecordingStore();
    let waiting = 0;
    let release!: () => void;
    let bothStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const load = async (resource: OfflineRegionResourceV1) => {
      waiting += 1;
      if (waiting === 2) bothStarted();
      await gate;
      return bytesFor(resource);
    };
    const downloads = [
      downloadOfflineRegion(first, { store, logicalQuotaBytes: 6, load }),
      downloadOfflineRegion(second, { store, logicalQuotaBytes: 6, load }),
    ];
    await started;
    release();
    const results = await Promise.allSettled(downloads);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expectCode(rejected?.reason, "inventory-changed");
    expect(store.regions.reduce((total, region) => total + region.logicalByteLength, 0)).toBe(6);
    expect(store.rollbacks).toBe(1);
  });

  it("binds commit to the planned quota and fails closed on unknown commit results", async () => {
    const value = await manifest();
    const store = new CasRecordingStore();
    let quotaReads = 0;
    const options = {
      store,
      get logicalQuotaBytes() {
        quotaReads += 1;
        return quotaReads === 1 ? 6 : 1000;
      },
      load: async (resource: OfflineRegionResourceV1) => bytesFor(resource),
    };
    await downloadOfflineRegion(value, options);
    expect(quotaReads).toBe(1);

    const invalidStore = new CasRecordingStore();
    const begin = invalidStore.beginWrite.bind(invalidStore);
    vi.spyOn(invalidStore, "beginWrite").mockImplementation(async () => {
      const transaction = await begin();
      return {
        ...transaction,
        commit: async () => undefined as unknown as "committed",
      };
    });
    await expectRejected(
      downloadOfflineRegion(value, {
        store: invalidStore,
        logicalQuotaBytes: 6,
        load: async (resource) => bytesFor(resource),
      }),
      "store-failed",
    );
    expect(invalidStore.rollbacks).toBe(1);
  });

  it("rejects tampering before store access and preserves integrity/cancel/rollback paths", async () => {
    const value = await manifest();
    const tampered = JSON.parse(JSON.stringify(value)) as OfflineRegionManifestV1;
    (tampered as { totalLogicalBytes: number }).totalLogicalBytes += 1;
    const untouched = new CasRecordingStore();
    const inventory = vi.spyOn(untouched, "inventory");
    await expectRejected(
      downloadOfflineRegion(tampered, {
        store: untouched,
        logicalQuotaBytes: 10,
        load: async () => encoder.encode("unused"),
      }),
      "invalid-manifest",
      "totalLogicalBytes",
    );
    expect(inventory).not.toHaveBeenCalled();

    const mismatch = new CasRecordingStore();
    await expectRejected(
      downloadOfflineRegion(value, {
        store: mismatch,
        logicalQuotaBytes: 10,
        load: async () => encoder.encode("bad"),
      }),
      "integrity-mismatch",
    );
    expect(mismatch.rollbacks).toBe(1);

    const cancelled = new CasRecordingStore();
    const abort = new AbortController();
    await expectRejected(
      downloadOfflineRegion(value, {
        store: cancelled,
        logicalQuotaBytes: 10,
        signal: abort.signal,
        load: async (resource) => {
          abort.abort("operator cancelled");
          return bytesFor(resource);
        },
      }),
      "aborted",
    );
    expect(cancelled.rollbacks).toBe(1);

    const failed = new CasRecordingStore();
    failed.failWrite = true;
    await expectRejected(
      downloadOfflineRegion(value, {
        store: failed,
        logicalQuotaBytes: 10,
        load: async (resource) => bytesFor(resource),
      }),
      "store-failed",
    );
    expect(failed.rollbacks).toBe(1);
  });
});
