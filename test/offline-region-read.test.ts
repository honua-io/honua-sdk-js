import { describe, expect, it } from "vitest";
import { type Query, type SourceDescriptor, capabilities } from "../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import {
  type HonuaOfflineRegionError,
  type OfflineRegionSnapshotSelectionV1,
  type OfflineRegionSnapshotV1,
  createMemoryOfflineRegionStore,
  createOfflineRegionFeatureBatch,
  createOfflineRegionQueryPlanCache,
  createOfflineRegionSnapshotLoader,
  decodeOfflineRegionFeatureBatch,
  downloadOfflineRegion,
  encodeOfflineRegionFeatureBatch,
  planOfflineRegionSnapshot,
  readOfflineRegionQuery,
} from "../src/offline/index.js";
import { explainQuery, hashQueryPlan } from "../src/query-planner/index.js";

const SCOPE = "tenant:a/role:field";
const OBSERVED_AT = "2026-07-10T10:00:00.000Z";
const QUOTA = 4 * 1024 * 1024;

const BOUNDS = { minX: -158.3, minY: 21.4, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" } as const;

const FEATURES = [
  { attributes: { id: "incident-1", status: "open" }, geometry: { type: "Point", coordinates: [-158, 21.5] } },
  { attributes: { id: "incident-2", status: "closed" }, geometry: { type: "Point", coordinates: [-157.9, 21.6] } },
  { attributes: { id: "incident-3", status: "open" }, geometry: { type: "Point", coordinates: [-157.8, 21.7] } },
];

const QUERY: Query = { outFields: ["id", "status"], returnGeometry: true };

function selection(overrides: Partial<OfflineRegionSnapshotSelectionV1> = {}): OfflineRegionSnapshotSelectionV1 {
  const batch = createOfflineRegionFeatureBatch(
    { features: FEATURES, exceededTransferLimit: false, totalCount: FEATURES.length },
    { pagination: { offset: 0 } },
  );
  return {
    name: "North shore field area",
    sourceId: "incidents",
    endpoint: "https://example.test/ogc/features",
    authorizationScopeFingerprint: SCOPE,
    bounds: BOUNDS,
    minZoom: 8,
    maxZoom: 14,
    sourceVersion: "source-v3",
    schemaVersion: "schema-v7",
    planVersion: "plan-v2",
    observation: { state: "cached", observedAt: OBSERVED_AT },
    validator: { etag: 'W/"incidents-42"' },
    attribution: { fixture: "Honua deterministic incident fixture" },
    query: QUERY,
    contents: [
      {
        kind: "features",
        bytes: encodeOfflineRegionFeatureBatch(batch),
        contentType: "application/json",
        attributionIds: ["fixture"],
      },
    ],
    ...overrides,
  };
}

async function persisted(overrides: Partial<OfflineRegionSnapshotSelectionV1> = {}): Promise<{
  snapshot: OfflineRegionSnapshotV1;
  store: ReturnType<typeof createMemoryOfflineRegionStore>;
}> {
  const snapshot = await planOfflineRegionSnapshot(selection(overrides));
  const store = createMemoryOfflineRegionStore();
  await downloadOfflineRegion(snapshot.manifest, {
    store,
    load: createOfflineRegionSnapshotLoader(snapshot),
    logicalQuotaBytes: QUOTA,
  });
  return { snapshot, store };
}

/** Capture the rejection of `body`, failing when it resolves instead. */
async function rejection(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error) {
    return error;
  }
  throw new Error("expected the offline read to fail closed");
}

describe("offline region snapshot planning", () => {
  it("derives deterministic, credential-free resource identities across runs", async () => {
    const first = await planOfflineRegionSnapshot(selection());
    const second = await planOfflineRegionSnapshot(selection());
    expect(second.manifest.id).toBe(first.manifest.id);
    expect(second.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
    expect(second.queryFingerprint).toBe(first.queryFingerprint);
    for (const entry of first.entries) {
      expect(entry.id).toMatch(/^features\/[0-9a-f]{64}$/);
      expect(entry.id).not.toContain("://");
      expect(entry.id).not.toContain("?");
      expect(entry.id).not.toContain("token");
    }
  });

  it("strips credentials from the endpoint before identity is derived", async () => {
    const signed = await planOfflineRegionSnapshot(
      selection({ endpoint: "https://user:pass@example.test/ogc/features?token=secret&sig=signed" }),
    );
    const clean = await planOfflineRegionSnapshot(selection());
    expect(signed.selection.endpoint).toBe("https://example.test/ogc/features");
    expect(signed.entries.map((entry) => entry.id)).toEqual(clean.entries.map((entry) => entry.id));
    expect(JSON.stringify(signed.manifest)).not.toContain("secret");
    expect(JSON.stringify(signed.manifest)).not.toContain("pass@");
  });

  it("partitions identity by authorization scope", async () => {
    const first = await planOfflineRegionSnapshot(selection());
    const other = await planOfflineRegionSnapshot(selection({ authorizationScopeFingerprint: "tenant:b/role:field" }));
    expect(other.manifest.source.authorizationScopeDigest).not.toBe(first.manifest.source.authorizationScopeDigest);
    expect(other.entries[0]?.id).not.toBe(first.entries[0]?.id);
  });

  it("separates identity by query, versions, and extent", async () => {
    const base = await planOfflineRegionSnapshot(selection());
    const byQuery = await planOfflineRegionSnapshot(selection({ query: { outFields: ["id"] } }));
    const byVersion = await planOfflineRegionSnapshot(selection({ schemaVersion: "schema-v8" }));
    const byBounds = await planOfflineRegionSnapshot(selection({ bounds: { ...BOUNDS, maxX: -157.5 } }));
    const ids = new Set([
      base.entries[0]?.id,
      byQuery.entries[0]?.id,
      byVersion.entries[0]?.id,
      byBounds.entries[0]?.id,
    ]);
    expect(ids.size).toBe(4);
  });

  it("round-trips a captured feature batch through its canonical encoding", () => {
    const batch = createOfflineRegionFeatureBatch(
      { features: FEATURES, exceededTransferLimit: true },
      { pagination: { offset: 0, limit: 3 } },
    );
    const decoded = decodeOfflineRegionFeatureBatch(encodeOfflineRegionFeatureBatch(batch));
    expect(decoded).toEqual(batch);
    expect(encodeOfflineRegionFeatureBatch(decoded)).toEqual(encodeOfflineRegionFeatureBatch(batch));
  });
});

describe("offline region reads", () => {
  it("answers the captured query entirely from storage with provenance and attribution", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionQuery(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      query: QUERY,
      bounds: BOUNDS,
      now: () => new Date("2026-07-10T10:01:00.000Z"),
    });

    expect(read.result.features).toEqual(FEATURES);
    expect(read.result.exceededTransferLimit).toBe(false);
    expect(read.result.totalCount).toBe(3);
    expect(read.regionId).toBe(snapshot.manifest.id);
    expect(read.provenance).toMatchObject({
      sourceId: "incidents",
      endpoint: "https://example.test/ogc/features",
      sourceVersion: "source-v3",
      schemaVersion: "schema-v7",
      planVersion: "plan-v2",
      observation: { state: "cached", observedAt: OBSERVED_AT },
      validator: { etag: 'W/"incidents-42"' },
    });
    expect(read.attribution).toEqual({ fixture: "Honua deterministic incident fixture" });
    expect(read.cache).toMatchObject({
      policy: "prefer-cache",
      action: "reuse",
      state: "offline",
      freshness: "fresh",
      completeness: "complete",
      reason: "offline-entry",
      regionId: snapshot.manifest.id,
      observedAt: OBSERVED_AT,
    });
    expect(read.cache.resources).toEqual([
      {
        id: snapshot.entries[0]?.id,
        kind: "features",
        byteLength: snapshot.entries[0]?.byteLength,
        integrity: snapshot.entries[0]?.integrity,
      },
    ]);
  });

  it("never presents a cached snapshot as a live read", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionQuery(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      query: QUERY,
      now: () => new Date("2026-07-10T10:01:00.000Z"),
    });
    expect(read.result.degraded).toHaveLength(1);
    expect(read.result.degraded?.[0]).toMatchObject({ capability: "query", sourceId: "incidents" });
    expect(read.result.degraded?.[0]?.reason).toContain("cached snapshot, not a live read");
    expect(read.result.degraded?.[0]?.reason).toContain(snapshot.manifest.id);
  });

  it("reports staleness without repairing it", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionQuery(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      query: QUERY,
      staleAfterMs: 60_000,
      now: () => new Date("2026-07-10T11:00:00.000Z"),
    });
    expect(read.cache.freshness).toBe("stale");
    expect(read.cache.reason).toBe("stale-entry");
    expect(read.cache.ageMs).toBe(60 * 60 * 1000);
    expect(read.result.features).toHaveLength(3);
    expect(read.planCache).toEqual({ policy: "prefer-cache", freshness: "stale" });
  });

  it("refines pagination over a complete stored batch without widening it", async () => {
    const { snapshot, store } = await persisted();
    const page = await readOfflineRegionQuery(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      query: { ...QUERY, pagination: { offset: 1, limit: 1 } },
      now: () => new Date("2026-07-10T10:01:00.000Z"),
    });
    expect(page.result.features).toEqual([FEATURES[1]]);
    expect(page.result.exceededTransferLimit).toBe(true);

    const tail = await readOfflineRegionQuery(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      query: { ...QUERY, pagination: { offset: 2 } },
      now: () => new Date("2026-07-10T10:01:00.000Z"),
    });
    expect(tail.result.features).toEqual([FEATURES[2]]);
    expect(tail.result.exceededTransferLimit).toBe(false);
  });

  it("refuses a page the captured window does not cover", async () => {
    const partial = createOfflineRegionFeatureBatch(
      { features: FEATURES.slice(0, 2), exceededTransferLimit: true },
      { pagination: { offset: 0, limit: 2 } },
    );
    const { snapshot, store } = await persisted({
      contents: [
        {
          kind: "features",
          bytes: encodeOfflineRegionFeatureBatch(partial),
          contentType: "application/json",
          attributionIds: ["fixture"],
        },
      ],
    });
    const covered = await readOfflineRegionQuery(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      query: { ...QUERY, pagination: { offset: 0, limit: 2 } },
      now: () => new Date("2026-07-10T10:01:00.000Z"),
    });
    expect(covered.result.features).toHaveLength(2);
    expect(covered.result.exceededTransferLimit).toBe(true);
    expect(covered.cache.completeness).toBe("partial");

    await expect(
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: { ...QUERY, pagination: { offset: 2, limit: 2 } },
        now: () => new Date("2026-07-10T10:01:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "cache-miss", sdkCode: "offline.region.miss" });
  });
});

describe("offline region reads fail closed", () => {
  it("refuses a read from another authorization scope", async () => {
    const { snapshot, store } = await persisted();
    const error = (await rejection(() =>
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: "tenant:b/role:field",
        query: QUERY,
      }),
    )) as HonuaOfflineRegionError;
    expect(error.code).toBe("scope-mismatch");
    expect(error.sdkCode).toBe("offline.region.miss");
    expect(error.message).not.toContain("tenant:b");
  });

  it("refuses an extent the region does not cover", async () => {
    const { snapshot, store } = await persisted();
    await expect(
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: QUERY,
        bounds: { minX: -160, minY: 20, maxX: -159, maxY: 21, crs: "EPSG:4326" },
      }),
    ).rejects.toMatchObject({ code: "out-of-region" });
  });

  it("refuses to narrow to a sub-extent instead of approximating it", async () => {
    const { snapshot, store } = await persisted();
    const error = await rejection(() =>
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: QUERY,
        bounds: { minX: -158, minY: 21.5, maxX: -157.7, maxY: 21.7, crs: "EPSG:4326" },
      }),
    );
    expect(error).toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("refuses a version the region was not captured at", async () => {
    const { snapshot, store } = await persisted();
    await expect(
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: QUERY,
        expect: { schemaVersion: "schema-v8" },
      }),
    ).rejects.toMatchObject({ code: "out-of-region" });
  });

  it("refuses an aggregation a stored feature batch cannot answer", async () => {
    const { snapshot, store } = await persisted();
    const error = await rejection(() =>
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: { ...QUERY, aggregation: { metrics: [{ fn: "count", field: "id" }] } },
      }),
    );
    expect(error).toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect((error as HonuaCapabilityNotSupportedError).capability).toBe("queryAggregate");
    expect((error as HonuaCapabilityNotSupportedError).protocol).toBe("offline-region");
  });

  it("refuses a query member it does not understand instead of dropping it", async () => {
    const { snapshot, store } = await persisted();
    const error = await rejection(() =>
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: { ...QUERY, distinct: true } as unknown as Query,
      }),
    );
    expect(error).toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect((error as HonuaCapabilityNotSupportedError).capability).toBe("query.distinct");
  });

  it("misses rather than answering a different query from a stored snapshot", async () => {
    const { snapshot, store } = await persisted();
    await expect(
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: { ...QUERY, where: "status = 'open'" },
      }),
    ).rejects.toMatchObject({ code: "cache-miss", sdkCode: "offline.region.miss" });
  });

  it("refuses an expired region rather than serving it", async () => {
    const { snapshot, store } = await persisted({ expiresAt: "2027-01-01T00:00:00.000Z" });
    await expect(
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: QUERY,
        now: () => new Date("2027-01-02T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("misses when the region was never downloaded", async () => {
    const snapshot = await planOfflineRegionSnapshot(selection());
    const store = createMemoryOfflineRegionStore();
    await expect(
      readOfflineRegionQuery(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        query: QUERY,
      }),
    ).rejects.toMatchObject({ code: "cache-miss" });
  });
});

describe("offline region reads bind to the query plan", () => {
  const descriptor: SourceDescriptor = {
    id: "incidents",
    protocol: "ogc-features",
    locator: { url: "https://example.test/ogc/features", collectionId: "incidents" },
    capabilities: capabilities(["query"]),
  };

  it("reports the persistent-cache decision and the region identity in the plan", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionQuery(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      query: QUERY,
      now: () => new Date("2026-07-10T10:01:00.000Z"),
    });
    const plan = explainQuery({ descriptor, query: QUERY, cache: read.planCache });
    expect(plan.cache).toMatchObject({
      policy: "prefer-cache",
      action: "reuse",
      freshness: "fresh",
      reason: "fresh-entry",
    });
    expect(plan.cache.validator).toEqual({ kind: "fingerprint", fingerprint: snapshot.manifest.id });
    expect(hashQueryPlan(plan)).toBe(plan.fingerprint);
  });

  it("changes the plan fingerprint when the region identity changes", async () => {
    const first = await persisted();
    const second = await persisted({ sourceVersion: "source-v4" });
    const planFor = async (fixture: typeof first) => {
      const read = await readOfflineRegionQuery(fixture.snapshot.manifest, {
        store: fixture.store,
        authorizationScopeFingerprint: SCOPE,
        query: QUERY,
        now: () => new Date("2026-07-10T10:01:00.000Z"),
      });
      return explainQuery({ descriptor, query: QUERY, cache: read.planCache }).fingerprint;
    };
    expect(await planFor(second)).not.toBe(await planFor(first));
  });

  it("never claims a revalidation an offline read cannot perform", async () => {
    const snapshot = await planOfflineRegionSnapshot(selection());
    const stale = createOfflineRegionQueryPlanCache(snapshot.manifest, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      staleAfterMs: 60_000,
    });
    expect(stale).toEqual({ policy: "prefer-cache", freshness: "stale" });
    const plan = explainQuery({ descriptor, query: QUERY, cache: stale });
    expect(plan.cache.action).toBe("refresh");
    expect(plan.cache.validator).toBeUndefined();
  });
});
