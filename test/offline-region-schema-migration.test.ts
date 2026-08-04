import { describe, expect, it } from "vitest";
import { serializeHonuaError } from "../src/index.js";
import {
  HONUA_OFFLINE_REGION_SCHEMA_VERSION,
  type HonuaOfflineRegionError,
  OFFLINE_REGION_SCHEMA_MIGRATIONS,
  type OfflineRegionSchemaMigrationV1,
  applyOfflineRegionSchemaMigration,
  planOfflineRegionSchemaMigration,
  readableOfflineRegionSchemaVersions,
} from "../src/offline/index.js";

const REGION_ID = `sha256:${"a".repeat(64)}`;
const SCOPE_DIGEST = `sha256:${"b".repeat(64)}`;

/** A persisted region record shaped exactly as the IndexedDB store writes it. */
function storedRegion(): Record<string, unknown> {
  return {
    id: REGION_ID,
    manifest: {
      kind: "honua.offline-region",
      version: "1.0",
      id: REGION_ID,
      name: "North shore field area",
      source: {
        id: "incidents",
        endpoint: "https://example.test/FeatureServer/0",
        authorizationScopeDigest: SCOPE_DIGEST,
        sourceVersion: "source-v3",
        schemaVersion: "schema-v7",
        planVersion: "plan-v2",
        observation: { state: "live", observedAt: "2026-08-01T00:00:00.000Z" },
      },
      bounds: { minX: -158.3, minY: 21.4, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" },
      attribution: {},
      resources: [
        { id: "metadata", kind: "metadata", byteLength: 3, integrity: `sha256:${"c".repeat(64)}` },
        { id: "tile/0/0/0", kind: "tile", byteLength: 5, integrity: `sha256:${"d".repeat(64)}` },
      ],
      totalLogicalBytes: 8,
    },
    receipt: {
      regionId: REGION_ID,
      resourceCount: 2,
      logicalByteLength: 8,
      evictedRegionIds: [],
      integrity: "verified",
      quotaAccounting: "logical-payload-bytes",
      completedAt: "2026-08-01T00:00:00.000Z",
    },
    logicalByteLength: 8,
    lastAccessedAt: "2026-08-01T00:00:00.000Z",
  };
}

function step(
  fromVersion: number,
  toVersion: number,
  migrate: OfflineRegionSchemaMigrationV1["migrate"] = (record) => ({ ...record }),
): OfflineRegionSchemaMigrationV1 {
  return { fromVersion, toVersion, migrate };
}

describe("offline region schema migration ladder", () => {
  it("treats the current version as a no-op with an empty applied chain", () => {
    expect(planOfflineRegionSchemaMigration(HONUA_OFFLINE_REGION_SCHEMA_VERSION)).toEqual({
      applicable: true,
      steps: [],
      migrations: [],
    });
  });

  it("resolves the shipped ladder for a recognized older version", () => {
    const plan = planOfflineRegionSchemaMigration(2);
    expect(plan).toMatchObject({ applicable: true, steps: ["2->3"] });
    expect(plan.applicable && plan.migrations).toHaveLength(1);
    expect(readableOfflineRegionSchemaVersions()).toEqual([2, 3]);
  });

  it("refuses a version ahead of this build without touching anything", () => {
    expect(planOfflineRegionSchemaMigration(99)).toMatchObject({
      applicable: false,
      reason: "future-version",
    });
  });

  it("refuses a version the ladder has never heard of", () => {
    expect(planOfflineRegionSchemaMigration(1)).toMatchObject({ applicable: false, reason: "unknown-version" });
    for (const value of [undefined, null, "3", 3.5, -1, Number.NaN]) {
      expect(planOfflineRegionSchemaMigration(value)).toMatchObject({
        applicable: false,
        reason: "unknown-version",
      });
    }
  });

  it("refuses a chain that dead-ends before this build's layout", () => {
    expect(planOfflineRegionSchemaMigration(1, [step(1, 2)])).toMatchObject({
      applicable: false,
      reason: "unreachable-version",
    });
  });

  it("terminates on a cyclic registry instead of spinning", () => {
    expect(planOfflineRegionSchemaMigration(1, [step(1, 2), step(2, 1)])).toMatchObject({
      applicable: false,
      reason: "unreachable-version",
    });
  });

  it("bounds the walk so an over-long chain refuses rather than marching", () => {
    const chain = Array.from({ length: 40 }, (_, index) => step(index, index + 1));
    expect(planOfflineRegionSchemaMigration(0, chain, 40)).toMatchObject({
      applicable: false,
      reason: "unreachable-version",
    });
    // Inside the bound the same chain resolves, so the refusal is the ceiling
    // talking rather than a broken walk.
    expect(planOfflineRegionSchemaMigration(0, chain, 8)).toMatchObject({ applicable: true });
  });
});

describe("offline region schema migration application", () => {
  it("carries a record forward with its identity untouched", () => {
    const record = storedRegion();
    const plan = planOfflineRegionSchemaMigration(2);
    expect(plan.applicable).toBe(true);
    const migrated = applyOfflineRegionSchemaMigration(record, plan.applicable ? plan.migrations : []);
    // The shipped 2->3 step is deliberately the identity on region records: the
    // layout did not change, and the ladder exists so the next one can.
    expect(migrated).toEqual(record);
    expect(migrated.id).toBe(REGION_ID);
  });

  it("applies an older layout forward and preserves every identity", () => {
    const legacy = storedRegion();
    delete (legacy as { lastAccessedAt?: unknown }).lastAccessedAt;
    const migrated = applyOfflineRegionSchemaMigration(legacy, [
      step(2, 3, (record) => ({ ...record, lastAccessedAt: "2026-08-01T00:00:00.000Z" })),
    ]);
    expect(migrated.lastAccessedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(migrated.id).toBe(REGION_ID);
    const manifest = migrated.manifest as { source: { authorizationScopeDigest: string }; resources: { id: string }[] };
    expect(manifest.source.authorizationScopeDigest).toBe(SCOPE_DIGEST);
    expect(manifest.resources.map((resource) => resource.id)).toEqual(["metadata", "tile/0/0/0"]);
  });

  it("refuses a step that rewrites the region id", () => {
    expect(() =>
      applyOfflineRegionSchemaMigration(storedRegion(), [step(2, 3, (record) => ({ ...record, id: "rewritten" }))]),
    ).toThrowError(/rewrote a region id/);
  });

  it("refuses a step that re-derives the authorization-scope digest", () => {
    const rewrite = step(2, 3, (record) => {
      const manifest = record.manifest as { source: Record<string, unknown> };
      return {
        ...record,
        manifest: { ...manifest, source: { ...manifest.source, authorizationScopeDigest: `sha256:${"f".repeat(64)}` } },
      };
    });
    let caught: HonuaOfflineRegionError | undefined;
    try {
      applyOfflineRegionSchemaMigration(storedRegion(), [rewrite]);
    } catch (error) {
      caught = error as HonuaOfflineRegionError;
    }
    expect(caught).toMatchObject({ name: "HonuaOfflineRegionError", code: "store-failed" });
    expect(caught && serializeHonuaError(caught)).toMatchObject({ code: "offline.storage.failure" });
  });

  it("refuses a step that renames a resource id", () => {
    const rewrite = step(2, 3, (record) => {
      const manifest = record.manifest as { resources: Record<string, unknown>[] };
      return {
        ...record,
        manifest: {
          ...manifest,
          resources: manifest.resources.map((resource) => ({ ...resource, id: `${String(resource.id)}-v2` })),
        },
      };
    });
    expect(() => applyOfflineRegionSchemaMigration(storedRegion(), [rewrite])).toThrowError(/rewrote a resource id/);
  });

  it("refuses a step that does not return a record", () => {
    const broken = step(2, 3, () => undefined as unknown as Record<string, unknown>);
    expect(() => applyOfflineRegionSchemaMigration(storedRegion(), [broken])).toThrowError(/did not produce a record/);
  });

  it("never hands a step a mutable view of the record", () => {
    const mutating = step(2, 3, (record) => {
      expect(Object.isFrozen(record)).toBe(true);
      return { ...record };
    });
    expect(applyOfflineRegionSchemaMigration(storedRegion(), [mutating])).toEqual(storedRegion());
  });

  it("ships exactly one ordered, frozen step today", () => {
    expect(Object.isFrozen(OFFLINE_REGION_SCHEMA_MIGRATIONS)).toBe(true);
    expect(OFFLINE_REGION_SCHEMA_MIGRATIONS.map((entry) => [entry.fromVersion, entry.toVersion])).toEqual([[2, 3]]);
  });
});
