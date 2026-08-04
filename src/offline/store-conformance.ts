import { sha256 } from "./digest.js";
import { createOfflineRegionManifest, downloadOfflineRegion, planOfflineRegionAdmission } from "./region.js";
import {
  HonuaOfflineRegionError,
  type OfflineRegionManifestV1,
  type OfflineRegionResourceInput,
  type OfflineRegionStore,
} from "./types.js";

/**
 * One conformance suite every offline region store must pass.
 *
 * The IndexedDB adapter can only run in a browser and the in-memory adapter can
 * run anywhere, so the suite is written as plain async functions rather than
 * against a test framework: vitest runs it over the memory store, and the browser
 * evidence runs the identical cases over real IndexedDB. A store that passes here
 * is substitutable in the download coordinator and the read path.
 *
 * @experimental
 */

export const HONUA_OFFLINE_REGION_STORE_CONFORMANCE_KIND = "honua.offline-region-store-conformance" as const;
export const HONUA_OFFLINE_REGION_STORE_CONFORMANCE_VERSION = "1.0" as const;

export interface OfflineRegionStoreConformanceOptions {
  /** Must return a store with no committed regions. Called once per case. */
  readonly createStore: () => OfflineRegionStore | Promise<OfflineRegionStore>;
  /** Optional teardown for the store a case finished with. */
  readonly disposeStore?: (store: OfflineRegionStore) => void | Promise<void>;
  /** Human label recorded on the report (for example `indexeddb`). */
  readonly label?: string;
  /** Run a subset by name. Unknown names fail the report rather than passing silently. */
  readonly only?: readonly string[];
}

export interface OfflineRegionStoreConformanceCaseResultV1 {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly detail?: string;
}

export interface OfflineRegionStoreConformanceReportV1 {
  readonly kind: typeof HONUA_OFFLINE_REGION_STORE_CONFORMANCE_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_STORE_CONFORMANCE_VERSION;
  readonly label?: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly OfflineRegionStoreConformanceCaseResultV1[];
}

type ConformanceCase = (store: OfflineRegionStore) => Promise<void>;

const encoder = new TextEncoder();
const QUOTA = 1024 * 1024;

/** Names of every case in the suite, in execution order. */
export const OFFLINE_REGION_STORE_CONFORMANCE_CASES: readonly string[] = [
  "empty-store-reports-no-regions",
  "commit-publishes-region-and-resources",
  "read-returns-caller-owned-bytes",
  "absent-resource-reads-undefined",
  "commit-advances-inventory-revision",
  "stale-inventory-commit-is-refused",
  "rollback-discards-uncommitted-writes",
  "admission-evicts-to-fit-quota",
  "credential-bearing-identity-is-refused",
  "byte-length-mismatch-is-refused",
];

const CASES: Readonly<Record<string, ConformanceCase>> = {
  "empty-store-reports-no-regions": async (store) => {
    const inventory = await store.inventory();
    assert(
      typeof inventory.revision === "string" && inventory.revision.length > 0,
      "revision must be a non-empty string",
    );
    assert(inventory.regions.length === 0, "a fresh store must report no regions");
    assert(
      (await store.readResource("missing-region", "missing-resource")) === undefined,
      "absent region must read undefined",
    );
  },

  "commit-publishes-region-and-resources": async (store) => {
    const fixture = await downloadFixture(store, "alpha");
    const inventory = await store.inventory();
    assert(inventory.regions.length === 1, "one committed region must appear in the inventory");
    assert(inventory.regions[0]?.id === fixture.manifest.id, "the inventory must key the region by its manifest id");
    assert(
      inventory.regions[0]?.logicalByteLength === fixture.manifest.totalLogicalBytes,
      "the inventory must charge the manifest's logical bytes",
    );
    const read = await store.readResource(fixture.manifest.id, fixture.resourceId);
    assert(read !== undefined, "a committed resource must be readable");
    assert(decode(read.bytes) === fixture.payload, "a committed resource must read back its exact bytes");
    assert(read.manifest.id === fixture.manifest.id, "a read must carry the region's manifest");
    assert(read.resource.id === fixture.resourceId, "a read must carry the resource descriptor");
  },

  "read-returns-caller-owned-bytes": async (store) => {
    const fixture = await downloadFixture(store, "alpha");
    const first = await store.readResource(fixture.manifest.id, fixture.resourceId);
    assert(first !== undefined, "a committed resource must be readable");
    first.bytes[0] = 0;
    const second = await store.readResource(fixture.manifest.id, fixture.resourceId);
    assert(second !== undefined, "a committed resource must stay readable");
    assert(decode(second.bytes) === fixture.payload, "mutating returned bytes must not mutate the store");
  },

  "absent-resource-reads-undefined": async (store) => {
    const fixture = await downloadFixture(store, "alpha");
    assert(
      (await store.readResource(fixture.manifest.id, "features/absent")) === undefined,
      "an unknown resource id must read undefined",
    );
    assert(
      (await store.readResource("sha256:0", fixture.resourceId)) === undefined,
      "an unknown region must read undefined",
    );
  },

  "commit-advances-inventory-revision": async (store) => {
    const before = (await store.inventory()).revision;
    await downloadFixture(store, "alpha");
    const after = (await store.inventory()).revision;
    assert(before !== after, "a committed mutation must advance the inventory revision");
  },

  "stale-inventory-commit-is-refused": async (store) => {
    const stale = await store.inventory();
    const first = await downloadFixture(store, "alpha");
    const second = await fixtureManifest("beta");
    const transaction = await store.beginWrite(second.manifest.id);
    await transaction.write(second.manifest.resources[0], encoder.encode(second.payload));
    const outcome = await transaction.commit(second.manifest, receiptFor(second.manifest), {
      expectedInventoryRevision: stale.revision,
      logicalQuotaBytes: QUOTA,
      admission: planOfflineRegionAdmission(second.manifest, stale, { logicalQuotaBytes: QUOTA }),
    });
    assert(outcome === "inventory-changed", "a commit against a stale inventory revision must be refused");
    await transaction.rollback();
    const inventory = await store.inventory();
    assert(inventory.regions.length === 1, "a refused commit must not publish a region");
    assert(inventory.regions[0]?.id === first.manifest.id, "a refused commit must leave the prior region intact");
  },

  "rollback-discards-uncommitted-writes": async (store) => {
    const fixture = await fixtureManifest("alpha");
    const transaction = await store.beginWrite(fixture.manifest.id);
    await transaction.write(fixture.manifest.resources[0], encoder.encode(fixture.payload));
    await transaction.rollback();
    const inventory = await store.inventory();
    assert(inventory.regions.length === 0, "a rolled back transaction must publish nothing");
    assert(
      (await store.readResource(fixture.manifest.id, fixture.resourceId)) === undefined,
      "a rolled back resource must not be readable",
    );
  },

  "admission-evicts-to-fit-quota": async (store) => {
    const first = await downloadFixture(store, "alpha");
    const second = await fixtureManifest("beta");
    // A quota that fits exactly one region forces the older one out.
    await downloadOfflineRegion(second.manifest, {
      store,
      load: async () => encoder.encode(second.payload),
      logicalQuotaBytes: second.manifest.totalLogicalBytes,
    });
    const inventory = await store.inventory();
    assert(inventory.regions.length === 1, "eviction must leave exactly the admitted region");
    assert(inventory.regions[0]?.id === second.manifest.id, "eviction must retain the newly admitted region");
    assert(
      (await store.readResource(first.manifest.id, first.resourceId)) === undefined,
      "eviction must remove the evicted region's resources",
    );
  },

  "credential-bearing-identity-is-refused": async (store) => {
    await expectRejection(
      () => store.beginWrite("https://user:secret@example.test/region?token=abc"),
      "a credential-bearing region id must be refused",
    );
  },

  "byte-length-mismatch-is-refused": async (store) => {
    const fixture = await fixtureManifest("alpha");
    const transaction = await store.beginWrite(fixture.manifest.id);
    await expectRejection(
      () => transaction.write(fixture.manifest.resources[0], encoder.encode(`${fixture.payload}-extra`)),
      "a byte length that disagrees with the descriptor must be refused",
    );
    await transaction.rollback();
  },
};

/**
 * Run the suite and report per-case outcomes.
 *
 * Cases never share a store: each one is handed a fresh store from
 * `createStore`, so a failure cannot cascade into a false failure downstream.
 */
export async function runOfflineRegionStoreConformance(
  options: OfflineRegionStoreConformanceOptions,
): Promise<OfflineRegionStoreConformanceReportV1> {
  const selected = options.only ?? OFFLINE_REGION_STORE_CONFORMANCE_CASES;
  const cases: OfflineRegionStoreConformanceCaseResultV1[] = [];
  for (const name of selected) {
    const body = CASES[name];
    if (!body) {
      cases.push({ name, status: "failed", detail: "unknown conformance case" });
      continue;
    }
    let store: OfflineRegionStore | undefined;
    try {
      store = await options.createStore();
      await body(store);
      cases.push({ name, status: "passed" });
    } catch (error) {
      cases.push({ name, status: "failed", detail: describe(error) });
    } finally {
      if (store && options.disposeStore) {
        try {
          await options.disposeStore(store);
        } catch {
          // Teardown failures must not rewrite a case's own verdict.
        }
      }
    }
  }
  const failed = cases.filter((entry) => entry.status === "failed").length;
  return {
    kind: HONUA_OFFLINE_REGION_STORE_CONFORMANCE_KIND,
    version: HONUA_OFFLINE_REGION_STORE_CONFORMANCE_VERSION,
    ...(options.label ? { label: options.label } : {}),
    total: cases.length,
    passed: cases.length - failed,
    failed,
    cases,
  };
}

interface Fixture {
  readonly manifest: OfflineRegionManifestV1;
  readonly resourceId: string;
  readonly payload: string;
}

async function fixtureManifest(name: string): Promise<Fixture> {
  const payload = `{"region":"${name}"}`;
  const resourceId = `features/${name}`;
  const resource: OfflineRegionResourceInput = {
    id: resourceId,
    kind: "features",
    byteLength: encoder.encode(payload).byteLength,
    integrity: await sha256(encoder.encode(payload)),
    contentType: "application/json",
  };
  const manifest = await createOfflineRegionManifest({
    name: `Conformance region ${name}`,
    sourceId: "conformance-source",
    endpoint: "https://example.test/FeatureServer/0",
    authorizationScopeFingerprint: `conformance-scope-${name}`,
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1, crs: "EPSG:4326" },
    sourceVersion: "source-v1",
    schemaVersion: "schema-v1",
    planVersion: "plan-v1",
    observation: { state: "live", observedAt: "2026-01-01T00:00:00.000Z" },
    attribution: { fixture: "Honua conformance fixture" },
    resources: [resource],
  });
  return { manifest, resourceId, payload };
}

async function downloadFixture(store: OfflineRegionStore, name: string): Promise<Fixture> {
  const fixture = await fixtureManifest(name);
  await downloadOfflineRegion(fixture.manifest, {
    store,
    load: async () => encoder.encode(fixture.payload),
    logicalQuotaBytes: QUOTA,
  });
  return fixture;
}

function receiptFor(manifest: OfflineRegionManifestV1) {
  return {
    regionId: manifest.id,
    resourceCount: manifest.resources.length,
    logicalByteLength: manifest.totalLogicalBytes,
    evictedRegionIds: [],
    integrity: "verified",
    quotaAccounting: "logical-payload-bytes",
    completedAt: "2026-01-01T00:00:00.000Z",
  } as const;
}

async function expectRejection(body: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await body();
  } catch (error) {
    assert(error instanceof Error, `${message} (a typed error is required)`);
    return;
  }
  throw new Error(message);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function describe(error: unknown): string {
  if (error instanceof HonuaOfflineRegionError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
