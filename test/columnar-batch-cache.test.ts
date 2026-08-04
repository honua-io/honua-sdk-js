import { describe, expect, it } from "vitest";
import { sha256 } from "../src/offline/digest.js";
import {
  COLUMNAR_BATCH_CACHE_CONFORMANCE_CASES,
  GEOARROW_ENVELOPE_MIGRATIONS,
  HONUA_COLUMNAR_BATCH_CACHE_FORMAT,
  HONUA_GEOARROW_ENVELOPE_VERSION,
  columnarAuthorizationScopeDigest,
  columnarBatchCacheFixtureBatch,
  columnarBatchCacheFixtureIdentity,
  columnarBatchCacheKey,
  columnarBatchCacheLegacyEntry,
  createColumnarBatchCache,
  createGeoArrowBatch,
  createMemoryColumnarBatchCacheStorage,
  deserializeGeoArrowBatch,
  planColumnarBatchCacheAdmission,
  planGeoArrowEnvelopeMigration,
  readableGeoArrowEnvelopeVersions,
  runColumnarBatchCacheConformance,
  serializeGeoArrowBatch,
} from "../src/query-planner/index.js";
import type {
  ColumnarBatchCacheDiagnosticV1,
  ColumnarBatchCacheRecordV1,
  ColumnarBatchCacheStorage,
  ColumnarBatchIdentityV1,
  ColumnarBatchV1,
  GeoArrowEnvelopeMigrationV1,
} from "../src/query-planner/index.js";

const OBSERVED_AT = "2026-07-30T00:00:00.000Z";
const NOW = Date.parse(OBSERVED_AT) + 1_000;

const identity = columnarBatchCacheFixtureIdentity;
const batchFor = columnarBatchCacheFixtureBatch;

describe("columnar batch cache keys", () => {
  it("is stable across runs and across two independent derivations", async () => {
    const first = await columnarBatchCacheKey(identity());
    const second = await columnarBatchCacheKey(identity());
    expect(first).toBe(second);
    // Pinned so a key-model change is a deliberate, visible break rather than a
    // silent cache-wide invalidation.
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).toBe("sha256:e521c42bf25d845100fcaa37ad213a267050b40bab253ac299bb6014f6c2f9a3");
  });

  it("differs for every keyed identity component", async () => {
    const base = await columnarBatchCacheKey(identity());
    const variants: ReadonlyArray<readonly [string, Partial<ColumnarBatchIdentityV1>]> = [
      ["sourceId", { sourceId: "other-source" }],
      ["sourceVersion", { sourceVersion: "source-2" }],
      ["schemaVersion", { schemaVersion: "parcels-v2" }],
      ["planId", { planId: "plan-2" }],
      ["authorizationScope", { authorizationScope: "tenant-b" }],
      ["ordering.stable", { ordering: { stable: false, keys: identity().ordering.keys } }],
      [
        "ordering.keys.field",
        { ordering: { stable: true, keys: [{ field: "parcel_id", direction: "ascending", nulls: "last" }] } },
      ],
      [
        "ordering.keys.direction",
        { ordering: { stable: true, keys: [{ field: "feature_id", direction: "descending", nulls: "last" }] } },
      ],
      [
        "ordering.keys.nulls",
        { ordering: { stable: true, keys: [{ field: "feature_id", direction: "ascending", nulls: "first" }] } },
      ],
      ["freshness.validator", { freshness: { observedAt: OBSERVED_AT, validator: 'W/"7"' } }],
      ["freshness.generation", { freshness: { observedAt: OBSERVED_AT, generation: "42" } }],
    ];
    const keys = new Map<string, string>();
    for (const [name, overrides] of variants) {
      const key = await columnarBatchCacheKey(identity(overrides));
      expect(key, `${name} must change the key`).not.toBe(base);
      expect(keys.has(key), `${name} must not collide with ${keys.get(key)}`).toBe(false);
      keys.set(key, name);
    }
  });

  it("never embeds the raw authorization scope", async () => {
    const scope = "tenant-a-secret-scope";
    const key = await columnarBatchCacheKey(identity({ authorizationScope: scope }));
    expect(key).not.toContain(scope);
    expect(key).toBe(`sha256:${key.slice(7)}`);
    expect(await columnarAuthorizationScopeDigest(scope)).not.toContain(scope);
  });

  it("keys the request, not the observation instant", async () => {
    // `observedAt`/`staleAfter` describe when a producer looked, so keying on
    // them would mint a new entry per fetch and leave a reader unable to
    // address anything. Expiry is enforced on read instead.
    const base = await columnarBatchCacheKey(identity());
    expect(await columnarBatchCacheKey(identity({ freshness: { observedAt: "2027-01-01T00:00:00.000Z" } }))).toBe(base);
    expect(
      await columnarBatchCacheKey(identity({ freshness: { observedAt: OBSERVED_AT, staleAfter: OBSERVED_AT } })),
    ).toBe(base);
  });
});

describe("GeoArrow envelope migration ladder", () => {
  it("migrates a 1.0 envelope forward and reports the applied chain", async () => {
    const legacy = await columnarBatchCacheLegacyEntry(identity(), NOW);
    const restored = deserializeGeoArrowBatch(legacy.envelope);
    expect(restored.metrics.migrations).toEqual(["1.0->1.1"]);
    expect(restored.metrics.envelopeVersion).toBe(HONUA_GEOARROW_ENVELOPE_VERSION);
    expect(restored.batch.rowCount).toBe(2);
  });

  it("reports no migrations for an envelope written at the current version", () => {
    const restored = deserializeGeoArrowBatch(serializeGeoArrowBatch(batchFor(identity())));
    expect(restored.metrics.migrations).toEqual([]);
    expect(restored.metrics.envelopeVersion).toBe(HONUA_GEOARROW_ENVELOPE_VERSION);
  });

  it("fails closed for unknown, future, and unreachable versions", async () => {
    const legacy = await columnarBatchCacheLegacyEntry(identity(), NOW);
    const at = (version: string): Uint8Array =>
      new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(legacy.envelope)), version }));
    for (const version of ["0.9", "2.0", "9.9"]) {
      expect(() => deserializeGeoArrowBatch(at(version))).toThrowError(
        new RegExp(`Unsupported GeoArrow serialization version "${version}"`),
      );
    }
    // An injected ladder whose chain dead-ends before the current version is
    // unreachable, not silently applied.
    const stranded: readonly GeoArrowEnvelopeMigrationV1[] = [
      { fromVersion: "1.0", toVersion: "1.05", migrate: (envelope) => ({ ...envelope, version: "1.05" }) },
    ];
    expect(() => deserializeGeoArrowBatch(legacy.envelope, { migrations: stranded })).toThrowError(
      /No migration path carries envelope version "1.0"/,
    );
  });

  it("plans, refuses, and reports readable versions deterministically", () => {
    expect(planGeoArrowEnvelopeMigration(HONUA_GEOARROW_ENVELOPE_VERSION)).toEqual({
      applicable: true,
      steps: [],
      migrations: [],
    });
    const plan = planGeoArrowEnvelopeMigration("1.0");
    expect(plan.applicable && plan.steps).toEqual(["1.0->1.1"]);
    expect(planGeoArrowEnvelopeMigration("0.1")).toMatchObject({ applicable: false, reason: "unknown-version" });
    expect(planGeoArrowEnvelopeMigration("2.0")).toMatchObject({ applicable: false, reason: "future-version" });
    expect(planGeoArrowEnvelopeMigration("not-a-version")).toMatchObject({
      applicable: false,
      reason: "unknown-version",
    });
    // A cyclic ladder is bounded rather than spun.
    const cyclic: readonly GeoArrowEnvelopeMigrationV1[] = [
      { fromVersion: "1.0", toVersion: "0.9", migrate: (envelope) => ({ ...envelope, version: "0.9" }) },
      { fromVersion: "0.9", toVersion: "1.0", migrate: (envelope) => ({ ...envelope, version: "1.0" }) },
    ];
    expect(planGeoArrowEnvelopeMigration("1.0", cyclic)).toMatchObject({
      applicable: false,
      reason: "unreachable-version",
    });
    expect(readableGeoArrowEnvelopeVersions()).toEqual(["1.0", "1.1"]);
    expect(GEOARROW_ENVELOPE_MIGRATIONS.map((step) => `${step.fromVersion}->${step.toVersion}`)).toEqual(["1.0->1.1"]);
  });

  it("never widens the bounds the caller supplied", async () => {
    const legacy = await columnarBatchCacheLegacyEntry(identity(), NOW);
    // The migrated envelope is measured against the caller's ceiling, and the
    // declared backing length is checked before a single byte is decoded.
    expect(() => deserializeGeoArrowBatch(legacy.envelope, { maxBackingBytes: 8 })).toThrowError(
      /GeoArrow backings exceed the 8-byte limit/,
    );
    expect(() => deserializeGeoArrowBatch(legacy.envelope, { maxSerializedBytes: 64 })).toThrowError(/the limit is 64/);
    // A migration that tried to inflate a payload is caught by the declared
    // length it produced, not trusted.
    const inflating: readonly GeoArrowEnvelopeMigrationV1[] = [
      {
        fromVersion: "1.0",
        toVersion: "1.1",
        migrate: (envelope) => ({
          ...envelope,
          version: "1.1",
          layout: "1.0",
          backings: (envelope.backings as Array<Record<string, unknown>>).map((backing) => ({
            ...backing,
            byteLength: 1,
          })),
        }),
      },
    ];
    expect(() => deserializeGeoArrowBatch(legacy.envelope, { migrations: inflating })).toThrowError(
      /decoded to \d+ bytes, not 1/,
    );
  });

  it("rejects a foreign layout stamp before decoding a payload", () => {
    const envelope = JSON.parse(new TextDecoder().decode(serializeGeoArrowBatch(batchFor(identity())))) as Record<
      string,
      unknown
    >;
    const foreign = new TextEncoder().encode(JSON.stringify({ ...envelope, layout: "9.9" }));
    expect(() => deserializeGeoArrowBatch(foreign)).toThrowError(/Unsupported GeoArrow layout version "9.9"/);
  });
});

describe("columnar batch cache store", () => {
  it("passes every shared conformance case against memory storage", async () => {
    const report = await runColumnarBatchCacheConformance({
      createStorage: () => createMemoryColumnarBatchCacheStorage(),
      label: "memory",
    });
    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(report.total).toBe(COLUMNAR_BATCH_CACHE_CONFORMANCE_CASES.length);
    expect(report.passed).toBe(report.total);
    expect(report.label).toBe("memory");
  });

  it("reports an unknown conformance case as a failure rather than passing silently", async () => {
    const report = await runColumnarBatchCacheConformance({
      createStorage: () => createMemoryColumnarBatchCacheStorage(),
      only: ["not-a-case"],
    });
    expect(report.failed).toBe(1);
    expect(report.cases[0]).toEqual({ name: "not-a-case", status: "failed", detail: "unknown conformance case" });
  });

  it("never serves a batch written under another authorization scope", async () => {
    const diagnostics: ColumnarBatchCacheDiagnosticV1[] = [];
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(storage, {
      now: () => NOW,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    await cache.write(batchFor(identity()));
    const read = await cache.read(identity({ authorizationScope: "tenant-b" }));
    expect(read.outcome).toBe("miss");
    expect(read.outcome === "miss" && read.reason).toBe("absent");
    // The record that does exist stays addressable only by its own scope.
    expect((await cache.read(identity())).outcome).toBe("hit");
    // A cold read is the normal path and stays silent; only refusals report.
    expect(diagnostics).toEqual([]);
    expect(JSON.stringify(await cache.records())).not.toContain("tenant-a");
  });

  it("returns an explicit stale outcome past the freshness horizon and the age ceiling", async () => {
    const storage = createMemoryColumnarBatchCacheStorage();
    const staleAfter = new Date(NOW + 60_000).toISOString();
    const staleIdentity = identity({ freshness: { observedAt: OBSERVED_AT, staleAfter } });
    await createColumnarBatchCache(storage, { now: () => NOW }).write(batchFor(staleIdentity));

    const expired = await createColumnarBatchCache(storage, { now: () => NOW + 120_000 }).read(staleIdentity);
    expect(expired).toMatchObject({ outcome: "stale", reason: "freshness-expired" });
    // A stale entry is kept, not dropped: the record still carries the
    // validator a caller needs to revalidate.
    expect((await storage.summaries()).length).toBe(1);

    const aged = await createColumnarBatchCache(storage, { now: () => NOW, maxAgeMs: 1 }).read(staleIdentity);
    expect(aged).toMatchObject({ outcome: "stale", reason: "max-age-exceeded" });
  });

  it("honours its byte quota with deterministic eviction", async () => {
    const storage = createMemoryColumnarBatchCacheStorage();
    const first = await createColumnarBatchCache(storage, { now: () => NOW }).write(
      batchFor(identity({ planId: "plan-1" })),
    );
    expect(first.outcome).toBe("stored");
    // A quota that fits exactly two entries forces the oldest out on the third.
    const quotaBytes = (first.outcome === "stored" ? first.record.byteLength : 0) * 2;
    const keys: string[] = [first.key];
    for (const [index, plan] of ["plan-2", "plan-3"].entries()) {
      const cache = createColumnarBatchCache(storage, { now: () => NOW + (index + 1) * 1_000, quotaBytes });
      const written = await cache.write(batchFor(identity({ planId: plan })));
      expect(written.outcome).toBe("stored");
      keys.push(written.key);
      const records = (await storage.summaries()) as ColumnarBatchCacheRecordV1[];
      expect(records.reduce((total, record) => total + record.byteLength, 0)).toBeLessThanOrEqual(quotaBytes);
    }
    const cache = createColumnarBatchCache(storage, { now: () => NOW + 3_000, quotaBytes });
    expect((await cache.read(identity({ planId: "plan-1" }))).outcome).toBe("miss");
    expect((await cache.read(identity({ planId: "plan-2" }))).outcome).toBe("hit");
    expect((await cache.read(identity({ planId: "plan-3" }))).outcome).toBe("hit");
    expect(new Set(keys).size).toBe(3);
  });

  it("refuses an entry larger than the whole quota without emptying the cache", async () => {
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(storage, { now: () => NOW, quotaBytes: 1024 * 1024 });
    await cache.write(batchFor(identity()));
    const tiny = createColumnarBatchCache(storage, { now: () => NOW + 1_000, quotaBytes: 16 });
    const refused = await tiny.write(batchFor(identity({ planId: "plan-2" })));
    expect(refused).toMatchObject({ outcome: "refused", reason: "quota-exceeded" });
    expect((await storage.summaries()).length).toBe(1);
  });

  it("plans admission deterministically and oldest-first", () => {
    const record = (key: string, observedAt: string, byteLength: number): ColumnarBatchCacheRecordV1 =>
      ({ key, observedAt, byteLength }) as ColumnarBatchCacheRecordV1;
    const records = [
      record("sha256:c", "2026-07-30T00:00:02.000Z", 100),
      record("sha256:a", "2026-07-30T00:00:01.000Z", 100),
      record("sha256:b", "2026-07-30T00:00:01.000Z", 100),
    ];
    const plan = planColumnarBatchCacheAdmission(
      records,
      { key: "sha256:d", byteLength: 100 },
      {
        quotaBytes: 250,
        maxRecords: 8,
      },
    );
    // Oldest first, ties broken by key in code-unit order.
    expect(plan.evictKeys).toEqual(["sha256:a", "sha256:b"]);
    expect(plan.bytesAfter).toBeLessThanOrEqual(250);
    expect(plan.admitted).toBe(true);
    expect(
      planColumnarBatchCacheAdmission(
        records,
        { key: "sha256:d", byteLength: 4_096 },
        {
          quotaBytes: 250,
          maxRecords: 8,
        },
      ),
    ).toMatchObject({ admitted: false, evictKeys: [], evictedBytes: 0 });
    // Replacing an entry charges only the delta.
    expect(
      planColumnarBatchCacheAdmission(
        records,
        { key: "sha256:c", byteLength: 100 },
        {
          quotaBytes: 300,
          maxRecords: 8,
        },
      ),
    ).toMatchObject({ replacedBytes: 100, evictKeys: [], admitted: true });
  });

  it("treats a digest mismatch as a miss and deletes the entry", async () => {
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(batchFor(identity()));
    const key = await columnarBatchCacheKey(identity());
    const stored = (await storage.read(key)) as { record: ColumnarBatchCacheRecordV1; envelope: Uint8Array };
    await storage.write(
      { record: { ...stored.record, integrity: `sha256:${"0".repeat(64)}` }, envelope: stored.envelope },
      [],
    );
    const read = await cache.read(identity());
    expect(read).toMatchObject({ outcome: "miss", reason: "integrity-mismatch" });
    expect(await storage.read(key)).toBeUndefined();
  });

  it("treats a null stored entry, a null record, and a null identity member as fail-closed", async () => {
    // `typeof null === "object"`, so every shape gate has to reject null
    // explicitly; these three cases prove those branches are reachable rather
    // than decoration.
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(batchFor(identity()));
    const key = await columnarBatchCacheKey(identity());
    const stored = (await storage.read(key)) as { record: ColumnarBatchCacheRecordV1; envelope: Uint8Array };

    const nullReading: ColumnarBatchCacheStorage = { ...storage, read: async () => null };
    expect(await createColumnarBatchCache(nullReading, { now: () => NOW }).read(identity())).toMatchObject({
      outcome: "miss",
      reason: "absent",
    });

    const nullRecord: ColumnarBatchCacheStorage = {
      ...storage,
      read: async () => ({ record: null, envelope: stored.envelope }),
    };
    expect(await createColumnarBatchCache(nullRecord, { now: () => NOW }).read(identity())).toMatchObject({
      outcome: "miss",
      reason: "corrupt-record",
    });

    const nullFreshness = {
      ...batchFor(identity()),
      identity: { ...identity(), freshness: null },
    } as unknown as ColumnarBatchV1;
    expect(await cache.write(nullFreshness)).toMatchObject({ outcome: "refused", reason: "invalid-batch" });
  });

  it("discards a record whose envelope can no longer be read", async () => {
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(batchFor(identity()));
    const key = await columnarBatchCacheKey(identity());
    const stored = (await storage.read(key)) as { record: ColumnarBatchCacheRecordV1; envelope: Uint8Array };
    const foreign = new TextEncoder().encode(
      JSON.stringify({ ...JSON.parse(new TextDecoder().decode(stored.envelope)), version: "7.7" }),
    );
    await storage.write(
      {
        record: { ...stored.record, byteLength: foreign.byteLength, integrity: await sha256(foreign) },
        envelope: foreign,
      },
      [],
    );
    const read = await cache.read(identity());
    expect(read).toMatchObject({ outcome: "miss", reason: "unsupported-serialization" });
    expect(await storage.read(key)).toBeUndefined();
  });

  it("settles an aborted read and write without waiting for the backend", async () => {
    const pending = createMemoryColumnarBatchCacheStorage();
    const blocked: ColumnarBatchCacheStorage = {
      ...pending,
      summaries: () => new Promise(() => undefined),
      read: () => new Promise(() => undefined),
      write: () => new Promise(() => undefined),
    };
    const cache = createColumnarBatchCache(blocked, { now: () => NOW });
    const controller = new AbortController();
    const started = Date.now();
    const read = cache.read(identity(), { signal: controller.signal });
    const write = cache.write(batchFor(identity()), { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    expect(await read).toMatchObject({ outcome: "miss", reason: "aborted" });
    expect(await write).toMatchObject({ outcome: "refused", reason: "aborted" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("settles as disposed after dispose and releases the backend", async () => {
    let disposed = false;
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(
      {
        ...storage,
        dispose: () => {
          disposed = true;
          storage.dispose?.();
        },
      },
      { now: () => NOW },
    );
    await cache.write(batchFor(identity()));
    cache.dispose();
    expect(disposed).toBe(true);
    expect(await cache.read(identity())).toMatchObject({ outcome: "miss", reason: "disposed" });
    expect(await cache.write(batchFor(identity()))).toMatchObject({ outcome: "refused", reason: "disposed" });
    expect(await cache.records()).toEqual([]);
  });

  it("classifies a device-full backend failure as quota pressure", async () => {
    const storage = createMemoryColumnarBatchCacheStorage();
    const full: ColumnarBatchCacheStorage = {
      ...storage,
      write: async () => {
        throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
      },
    };
    const written = await createColumnarBatchCache(full, { now: () => NOW }).write(batchFor(identity()));
    expect(written).toMatchObject({ outcome: "refused", reason: "quota-pressure" });
  });

  it("stamps every persisted record with its versioned format", async () => {
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    const written = await cache.write(batchFor(identity()));
    expect(written.outcome === "stored" && written.record.format).toBe(HONUA_COLUMNAR_BATCH_CACHE_FORMAT);
    expect(written.outcome === "stored" && written.record.envelopeVersion).toBe(HONUA_GEOARROW_ENVELOPE_VERSION);
    expect(written.outcome === "stored" && written.record.observedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("columnar batch cache envelope efficiency", () => {
  it("keeps the 1,000,000-row packed fixture at or below 1.5x its backing bytes", () => {
    const batch = packedPointFixture(1_000_000);
    const backingBytes = new Set(batch.buffers.map((buffer) => buffer.data)).size
      ? [...new Set(batch.buffers.map((buffer) => buffer.data))].reduce((total, data) => total + data.byteLength, 0)
      : 0;
    expect(backingBytes).toBe(16_000_000);
    const envelope = serializeGeoArrowBatch(batch, { maxSerializedBytes: 32 * 1024 * 1024 });
    // base64 alone is 1.333x; the envelope's own JSON must not add another 12%.
    expect(envelope.byteLength / backingBytes).toBeLessThanOrEqual(1.5);
    const restored = deserializeGeoArrowBatch(envelope, { maxSerializedBytes: 32 * 1024 * 1024 });
    expect(restored.batch.rowCount).toBe(1_000_000);
    expect(restored.metrics.backingBytes).toBe(backingBytes);
  });
});

/**
 * A packed, non-null interleaved point column: one 16-byte-per-row backing and
 * no per-row objects, which is the shape the persistence NFRs are stated
 * against.
 */
function packedPointFixture(rows: number): ColumnarBatchV1 {
  const packedIdentity = identity({
    ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
  });
  const sample = createGeoArrowBatch({
    id: "packed:0",
    sequence: 0,
    schemaId: packedIdentity.schemaVersion,
    identity: packedIdentity,
    geometry: {
      kind: "point",
      coordinateLayout: "interleaved",
      crs: "OGC:CRS84",
      values: [
        [-157.86, 21.31],
        [-157.85, 21.32],
      ],
    },
  }).batch;
  const coordinates = new Float64Array(rows * 2);
  for (let row = 0; row < rows; row += 1) {
    coordinates[row * 2] = -157.8 + (row % 1_000) / 10_000;
    coordinates[row * 2 + 1] = 21.3 + (row % 997) / 10_000;
  }
  const template = sample.buffers.find((buffer) => buffer.role === "geometry");
  if (!template) throw new Error("the GeoArrow point fixture must carry a geometry buffer");
  return {
    ...sample,
    rowCount: rows,
    buffers: [
      {
        id: template.id,
        role: template.role,
        ...(template.field === undefined ? {} : { field: template.field }),
        data: coordinates.buffer,
        byteOffset: 0,
        byteLength: coordinates.byteLength,
      },
    ],
  };
}
