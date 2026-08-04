/**
 * One conformance suite every columnar batch cache backend must pass (issue
 * #940).
 *
 * The IndexedDB backend can only run in a browser and the in-memory backend can
 * run anywhere, so the suite is written as plain async functions rather than
 * against a test framework: vitest runs it over memory storage, and the browser
 * evidence runs the identical cases over real IndexedDB. A backend that passes
 * here is substitutable in {@link createColumnarBatchCache}.
 *
 * The cases are the security-relevant ones, not a smoke test: identity keying,
 * scope isolation, freshness, integrity, envelope migration, quota eviction,
 * credential screening, and abort.
 *
 * @experimental
 */

import { sha256 } from "../offline/digest.js";
import {
  type ColumnarBatchCacheRecordV1,
  type ColumnarBatchCacheStorage,
  HONUA_COLUMNAR_BATCH_CACHE_FORMAT,
  columnarAuthorizationScopeDigest,
  columnarBatchCacheKey,
  columnarBatchCacheOrderingDigest,
  createColumnarBatchCache,
} from "./batch-cache.js";
import { HONUA_GEOARROW_ENVELOPE_VERSION, serializeGeoArrowBatch } from "./geoarrow-serialization.js";
import { createGeoArrowBatch } from "./geoarrow.js";
import type { ColumnarBatchIdentityV1, ColumnarBatchV1 } from "./types.js";

export const HONUA_COLUMNAR_BATCH_CACHE_CONFORMANCE_KIND = "honua.columnar-batch-cache-conformance" as const;
export const HONUA_COLUMNAR_BATCH_CACHE_CONFORMANCE_VERSION = "1.0" as const;

export interface ColumnarBatchCacheConformanceOptions {
  /** Must return storage with no entries. Called once per case. */
  readonly createStorage: () => ColumnarBatchCacheStorage | Promise<ColumnarBatchCacheStorage>;
  /** Optional teardown for the storage a case finished with. */
  readonly disposeStorage?: (storage: ColumnarBatchCacheStorage) => void | Promise<void>;
  /** Human label recorded on the report (for example `indexeddb`). */
  readonly label?: string;
  /** Run a subset by name. Unknown names fail the report rather than passing silently. */
  readonly only?: readonly string[];
}

export interface ColumnarBatchCacheConformanceCaseResultV1 {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly detail?: string;
}

export interface ColumnarBatchCacheConformanceReportV1 {
  readonly kind: typeof HONUA_COLUMNAR_BATCH_CACHE_CONFORMANCE_KIND;
  readonly version: typeof HONUA_COLUMNAR_BATCH_CACHE_CONFORMANCE_VERSION;
  readonly label?: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly ColumnarBatchCacheConformanceCaseResultV1[];
}

type ConformanceCase = (storage: ColumnarBatchCacheStorage) => Promise<void>;

const OBSERVED_AT = "2026-07-30T00:00:00.000Z";
const NOW = Date.parse(OBSERVED_AT) + 1_000;
const QUOTA = 1024 * 1024;

// Short aliases for the exported fixtures the cases share.
const identity = columnarBatchCacheFixtureIdentity;
const fixtureBatch = columnarBatchCacheFixtureBatch;
const legacyEntry = columnarBatchCacheLegacyEntry;

/** Names of every case in the suite, in execution order. */
export const COLUMNAR_BATCH_CACHE_CONFORMANCE_CASES: readonly string[] = [
  "empty-cache-reports-no-records",
  "write-then-read-returns-the-batch",
  "read-returns-caller-owned-buffers",
  "another-authorization-scope-never-reads-the-batch",
  "expired-freshness-returns-an-explicit-stale-outcome",
  "quota-overflow-evicts-oldest-first",
  "tampered-payload-is-a-miss-and-is-deleted",
  "foreign-record-format-is-discarded",
  "legacy-envelope-is-migrated-forward",
  "credential-bearing-identity-is-refused",
  "aborted-read-settles-as-a-miss",
];

const CASES: Readonly<Record<string, ConformanceCase>> = {
  "empty-cache-reports-no-records": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    assert((await cache.records()).length === 0, "a fresh cache must report no records");
    const read = await cache.read(identity());
    assert(read.outcome === "miss", "a fresh cache must miss");
    assert(read.outcome === "miss" && read.reason === "absent", "an empty cache must report an absent miss");
  },

  "write-then-read-returns-the-batch": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    const batch = fixtureBatch(identity());
    const written = await cache.write(batch);
    assert(written.outcome === "stored", `write must store the batch (${describeWrite(written)})`);
    const read = await cache.read(identity());
    assert(read.outcome === "hit", `a written batch must read back (${describeRead(read)})`);
    if (read.outcome !== "hit") return;
    assert(read.batch.rowCount === batch.rowCount, "a hit must preserve the row count");
    assert(read.metrics.envelopeVersion === HONUA_GEOARROW_ENVELOPE_VERSION, "a hit must report its envelope version");
    assert(read.metrics.migrations.length === 0, "a current envelope must report no migrations");
    // The raw authorization scope is never persisted; the caller's own scope is
    // restored onto the returned batch.
    assert(
      read.batch.identity?.authorizationScope === identity().authorizationScope,
      "a hit must restore the caller's authorization scope",
    );
    const records = await cache.records();
    assert(records.length === 1, "one write must produce one record");
    assert(
      records.every((record) => !JSON.stringify(record).includes(identity().authorizationScope)),
      "no record may contain the raw authorization scope",
    );
  },

  "read-returns-caller-owned-buffers": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(fixtureBatch(identity()));
    const first = await cache.read(identity());
    assert(first.outcome === "hit", "a written batch must read back");
    if (first.outcome !== "hit") return;
    for (const buffer of first.batch.buffers) new Uint8Array(buffer.data).fill(0);
    const second = await cache.read(identity());
    assert(second.outcome === "hit", "mutating a returned batch must not corrupt the cache");
    if (second.outcome !== "hit") return;
    assert(
      second.batch.buffers.some((buffer) => new Uint8Array(buffer.data).some((byte) => byte !== 0)),
      "a second read must return unmutated bytes",
    );
  },

  "another-authorization-scope-never-reads-the-batch": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(fixtureBatch(identity()));
    const foreign = await cache.read(identity({ authorizationScope: "tenant-b" }));
    assert(foreign.outcome === "miss", "a foreign authorization scope must never hit");
    // Cross-scope isolation also holds when a record is planted under the
    // reader's own key: the recorded scope digest, not the key, decides.
    const readerKey = await columnarBatchCacheKey(identity({ authorizationScope: "tenant-b" }));
    const planted = await storage.read(await columnarBatchCacheKey(identity()));
    if (isEntry(planted)) {
      await storage.write(
        {
          record: { ...planted.record, key: readerKey } as ColumnarBatchCacheRecordV1,
          envelope: planted.envelope,
        },
        [],
      );
      const rewritten = await cache.read(identity({ authorizationScope: "tenant-b" }));
      assert(
        rewritten.outcome === "miss" && rewritten.reason === "authorization-scope-mismatch",
        "a record rewritten under another scope's key must be refused",
      );
      assert(
        (await storage.read(readerKey)) === undefined,
        "a scope-mismatched record must be deleted, not left readable",
      );
    }
  },

  "expired-freshness-returns-an-explicit-stale-outcome": async (storage) => {
    const staleAfter = new Date(NOW + 60_000).toISOString();
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(fixtureBatch(identity({ freshness: { observedAt: OBSERVED_AT, staleAfter } })));
    const fresh = await cache.read(identity({ freshness: { observedAt: OBSERVED_AT, staleAfter } }));
    assert(fresh.outcome === "hit", "a batch inside its freshness horizon must hit");
    const expired = createColumnarBatchCache(storage, { now: () => NOW + 120_000 });
    const read = await expired.read(identity({ freshness: { observedAt: OBSERVED_AT, staleAfter } }));
    assert(read.outcome === "stale", `a batch past its horizon must be stale (${describeRead(read)})`);
    assert(read.outcome === "stale" && read.reason === "freshness-expired", "stale must name the freshness horizon");
  },

  "quota-overflow-evicts-oldest-first": async (storage) => {
    const first = identity({ planId: "plan-1" });
    const second = identity({ planId: "plan-2" });
    const cache = createColumnarBatchCache(storage, { now: () => NOW, maxRecords: 1, quotaBytes: QUOTA });
    await cache.write(fixtureBatch(first));
    const written = await createColumnarBatchCache(storage, {
      now: () => NOW + 1_000,
      maxRecords: 1,
      quotaBytes: QUOTA,
    }).write(fixtureBatch(second));
    assert(written.outcome === "stored", "the second batch must be admitted");
    assert(
      written.outcome === "stored" && written.admission.evictKeys.length === 1,
      "admitting past the record cap must evict exactly one entry",
    );
    const records = await cache.records();
    assert(records.length === 1, "the record cap must hold after eviction");
    assert((await cache.read(first)).outcome === "miss", "the evicted entry must be gone");
    assert((await cache.read(second)).outcome === "hit", "the newest entry must survive eviction");
  },

  "tampered-payload-is-a-miss-and-is-deleted": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(fixtureBatch(identity()));
    const key = await columnarBatchCacheKey(identity());
    const stored = await storage.read(key);
    assert(isEntry(stored), "the written entry must be readable from storage");
    if (!isEntry(stored)) return;
    const tampered = stored.envelope.slice();
    // Flip one byte deep inside the base64 payload: the record's byte length
    // still matches, so only the digest can catch it.
    tampered[tampered.length - 8] = tampered[tampered.length - 8] === 65 ? 66 : 65;
    await storage.write({ record: stored.record, envelope: tampered }, []);
    const read = await cache.read(identity());
    assert(
      read.outcome === "miss" && read.reason === "integrity-mismatch",
      `a tampered payload must miss on integrity (${describeRead(read)})`,
    );
    assert((await storage.read(key)) === undefined, "a tampered entry must be deleted, not left readable");
  },

  "foreign-record-format-is-discarded": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(fixtureBatch(identity()));
    const key = await columnarBatchCacheKey(identity());
    const stored = await storage.read(key);
    assert(isEntry(stored), "the written entry must be readable from storage");
    if (!isEntry(stored)) return;
    await storage.write(
      {
        record: { ...stored.record, format: "honua.columnar-batch-cache/9.9" } as unknown as ColumnarBatchCacheRecordV1,
        envelope: stored.envelope,
      },
      [],
    );
    const read = await cache.read(identity());
    assert(
      read.outcome === "miss" && read.reason === "foreign-format",
      `a foreign record format must be refused (${describeRead(read)})`,
    );
    assert((await storage.read(key)) === undefined, "a foreign-format record must be deleted");
  },

  "legacy-envelope-is-migrated-forward": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    const entry = await legacyEntry(identity(), NOW);
    await storage.write(entry, []);
    const read = await cache.read(identity());
    assert(read.outcome === "hit", `a 1.0 envelope must migrate forward (${describeRead(read)})`);
    if (read.outcome !== "hit") return;
    assert(
      read.metrics.migrations.join(",") === "1.0->1.1",
      `the applied migration chain must be reported (${read.metrics.migrations.join(",")})`,
    );
    assert(read.batch.rowCount === 2, "a migrated batch must revalidate with its original rows");
  },

  "credential-bearing-identity-is-refused": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    const written = await cache.write(
      fixtureBatch(identity({ sourceId: "https://user:secret@example.test/a?token=1" })),
    );
    assert(
      written.outcome === "refused" && written.reason === "credential-screened",
      `a credential-bearing identity must be refused (${describeWrite(written)})`,
    );
    assert((await cache.records()).length === 0, "a refused write must persist nothing");
  },

  "aborted-read-settles-as-a-miss": async (storage) => {
    const cache = createColumnarBatchCache(storage, { now: () => NOW });
    await cache.write(fixtureBatch(identity()));
    const controller = new AbortController();
    controller.abort();
    const read = await cache.read(identity(), { signal: controller.signal });
    assert(
      read.outcome === "miss" && read.reason === "aborted",
      `an aborted read must settle as an aborted miss (${describeRead(read)})`,
    );
  },
};

/**
 * Run the suite and report per-case outcomes.
 *
 * Cases never share storage: each one is handed a fresh backend from
 * `createStorage`, so a failure cannot cascade into a false failure downstream.
 */
export async function runColumnarBatchCacheConformance(
  options: ColumnarBatchCacheConformanceOptions,
): Promise<ColumnarBatchCacheConformanceReportV1> {
  const selected = options.only ?? COLUMNAR_BATCH_CACHE_CONFORMANCE_CASES;
  const cases: ColumnarBatchCacheConformanceCaseResultV1[] = [];
  for (const name of selected) {
    const body = CASES[name];
    if (!body) {
      cases.push({ name, status: "failed", detail: "unknown conformance case" });
      continue;
    }
    let storage: ColumnarBatchCacheStorage | undefined;
    try {
      storage = await options.createStorage();
      await body(storage);
      cases.push({ name, status: "passed" });
    } catch (error) {
      cases.push({ name, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      if (storage && options.disposeStorage) {
        try {
          await options.disposeStorage(storage);
        } catch {
          // Teardown failures must not rewrite a case's own verdict.
        }
      }
    }
  }
  const failed = cases.filter((entry) => entry.status === "failed").length;
  return {
    kind: HONUA_COLUMNAR_BATCH_CACHE_CONFORMANCE_KIND,
    version: HONUA_COLUMNAR_BATCH_CACHE_CONFORMANCE_VERSION,
    ...(options.label ? { label: options.label } : {}),
    total: cases.length,
    passed: cases.length - failed,
    failed,
    cases,
  };
}

/** Deterministic fixture identity; overrides replace one component at a time. */
export function columnarBatchCacheFixtureIdentity(
  overrides: Partial<ColumnarBatchIdentityV1> = {},
): ColumnarBatchIdentityV1 {
  return {
    sourceId: "parcels",
    sourceVersion: "source-1",
    schemaVersion: "parcels-v1",
    planId: "plan-1",
    authorizationScope: "tenant-a",
    ordering: { stable: true, keys: [{ field: "feature_id", direction: "ascending", nulls: "last" }] },
    freshness: { observedAt: OBSERVED_AT },
    ...overrides,
  };
}

/** Deterministic two-row GeoArrow batch bound to `identity`. */
export function columnarBatchCacheFixtureBatch(identity: ColumnarBatchIdentityV1): ColumnarBatchV1 {
  return createGeoArrowBatch({
    id: `parcels:${identity.planId}`,
    sequence: 0,
    schemaId: identity.schemaVersion,
    identity,
    geometry: { kind: "point", crs: "EPSG:4326", values: [[-157.86, 21.31], null] },
    featureIds: { field: "feature_id", values: [7, 8] },
  }).batch;
}

/**
 * Build the entry an older SDK would have written: an envelope at layout
 * version 1.0, with its record digest taken over those exact legacy bytes.
 */
export async function columnarBatchCacheLegacyEntry(
  identity: ColumnarBatchIdentityV1,
  now: number,
): Promise<{ record: ColumnarBatchCacheRecordV1; envelope: Uint8Array }> {
  const scopeDigest = await columnarAuthorizationScopeDigest(identity.authorizationScope);
  const batch = columnarBatchCacheFixtureBatch({ ...identity, authorizationScope: scopeDigest });
  const current = JSON.parse(new TextDecoder().decode(serializeGeoArrowBatch(batch))) as Record<string, unknown> & {
    backings: Array<{ id: string; byteLength?: number; data: string }>;
  };
  const legacy: Record<string, unknown> = {
    ...current,
    version: "1.0",
    // Envelope 1.0 declared neither the layout stamp nor decoded lengths; the
    // migration has to reconstruct both.
    backings: current.backings.map(({ id, data }) => ({ id, data })),
  };
  delete legacy.layout;
  const envelope = new TextEncoder().encode(JSON.stringify(legacy));
  const key = await columnarBatchCacheKey(identity);
  return {
    record: {
      key,
      format: HONUA_COLUMNAR_BATCH_CACHE_FORMAT,
      envelopeVersion: "1.0",
      sourceId: identity.sourceId,
      sourceVersion: identity.sourceVersion,
      schemaVersion: identity.schemaVersion,
      planId: identity.planId,
      authorizationScopeDigest: scopeDigest,
      orderingDigest: await columnarBatchCacheOrderingDigest(identity),
      freshness: { observedAt: identity.freshness.observedAt },
      rowCount: batch.rowCount,
      byteLength: envelope.byteLength,
      integrity: await sha256(envelope),
      observedAt: new Date(now).toISOString(),
    },
    envelope,
  };
}

// The null test precedes the `typeof` test because `typeof null === "object"`.
function isEntry(value: unknown): value is { record: ColumnarBatchCacheRecordV1; envelope: Uint8Array } {
  if (value === null || typeof value !== "object") return false;
  const entry = value as { record?: unknown; envelope?: unknown };
  return entry.envelope instanceof Uint8Array && entry.record !== null && typeof entry.record === "object";
}

function describeRead(read: { outcome: string; reason?: string }): string {
  return `${read.outcome}${read.reason ? `: ${read.reason}` : ""}`;
}

function describeWrite(write: { outcome: string; reason?: string }): string {
  return `${write.outcome}${write.reason ? `: ${write.reason}` : ""}`;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
