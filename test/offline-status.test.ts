import { describe, expect, it } from "vitest";
import { isHonuaError } from "../src/index.js";
import {
  type CreateOfflineRegionManifestInput,
  HONUA_LOCAL_FIRST_STATUS_KIND,
  HONUA_LOCAL_FIRST_STATUS_VERSION,
  type HonuaOfflineRegionError,
  type LocalFirstState,
  type OfflineQueuedEdit,
  type OfflineQueuedEditState,
  type OfflineRegionCacheInventory,
  type OfflineRegionDiagnosticV1,
  createLocalFirstStatus,
  createOfflineRegionDiagnostic,
  createOfflineRegionManifest,
} from "../src/offline/index.js";

const encoder = new TextEncoder();
const NOW = new Date("2026-08-01T12:00:00.000Z");
const STALE_AFTER_MS = 60 * 60 * 1000;

async function integrity(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function diagnostic(
  options: {
    readonly stored?: boolean;
    readonly storedLogicalByteLength?: number;
    readonly observedAt?: string;
    readonly expiresAt?: string;
    readonly pinned?: boolean;
    readonly manifest?: Partial<CreateOfflineRegionManifestInput>;
    readonly now?: Date;
  } = {},
): Promise<OfflineRegionDiagnosticV1> {
  const manifest = await createOfflineRegionManifest({
    name: "North shore field area",
    sourceId: "incidents",
    endpoint: "https://reader:hunter2@example.test/FeatureServer/0?token=topsecret&f=json",
    authorizationScopeFingerprint: "tenant:a/role:field",
    bounds: { minX: -158.3, minY: 21.4, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" },
    sourceVersion: "source-v3",
    schemaVersion: "schema-v7",
    planVersion: "plan-v2",
    observation: { state: "live", observedAt: options.observedAt ?? "2026-08-01T11:30:00.000Z" },
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    attribution: { osm: "© OpenStreetMap contributors" },
    resources: [
      { id: "features/incidents", kind: "features", byteLength: 3, integrity: await integrity("one") },
      { id: "tile/8/40/100", kind: "tile", byteLength: 5, integrity: await integrity("two") },
    ],
    ...options.manifest,
  });
  const inventory: OfflineRegionCacheInventory =
    options.stored === false
      ? { revision: "rev-1", regions: [] }
      : {
          revision: "rev-1",
          regions: [
            {
              id: manifest.id,
              logicalByteLength: options.storedLogicalByteLength ?? manifest.totalLogicalBytes,
              lastAccessedAt: "2026-08-01T11:45:00.000Z",
              ...(options.expiresAt === undefined ? {} : { expiresAt: new Date(options.expiresAt).toISOString() }),
              ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
            },
          ],
        };
  return createOfflineRegionDiagnostic(manifest, inventory, {
    logicalQuotaBytes: 1024,
    now: options.now ?? NOW,
    staleAfterMs: STALE_AFTER_MS,
  });
}

function queuedEdit(overrides: Partial<OfflineQueuedEdit> & { readonly id: `sha256:${string}` }): OfflineQueuedEdit {
  return {
    version: "1.0",
    requestFingerprint: `sha256:${"b".repeat(64)}`,
    authorizationScopeDigest: `sha256:${"c".repeat(64)}`,
    sourceId: "incidents",
    idempotencyKey: "edit-key-1",
    edit: { operation: "update", featureId: "incident-1", attributes: { status: "closed" } },
    dependencyIds: [],
    state: "pending",
    createdAt: "2026-08-01T11:50:00.000Z",
    updatedAt: "2026-08-01T11:50:00.000Z",
    attemptCount: 0,
    audit: [],
    ...overrides,
  };
}

function editId(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

async function headline(
  options: Parameters<typeof createLocalFirstStatus>[0],
): Promise<{ state: LocalFirstState; reason: string }> {
  const status = createLocalFirstStatus(options);
  return { state: status.state, reason: status.reason };
}

describe("local-first status composition", () => {
  it("reports connected when reads are fresh, complete, and nothing is queued", async () => {
    const status = createLocalFirstStatus({
      connectivity: "online",
      now: NOW,
      regions: [await diagnostic()],
      edits: [],
    });

    expect(status.kind).toBe(HONUA_LOCAL_FIRST_STATUS_KIND);
    expect(status.version).toBe(HONUA_LOCAL_FIRST_STATUS_VERSION);
    expect(status.generatedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(status.state).toBe("online");
    expect(status.reason).toBe("connected");
    expect(status.connectivity).toBe("online");
    expect(status.reads).toMatchObject({
      availability: "live",
      freshness: "fresh",
      completeness: "complete",
      regionCount: 1,
      storedRegionCount: 1,
      readableRegionCount: 1,
      oldestObservedAt: "2026-08-01T11:30:00.000Z",
    });
    expect(status.writes).toMatchObject({ state: "idle", undeliveredCount: 0, conflictedCount: 0 });
    expect(status.writes.counts).toEqual({
      pending: 0,
      leased: 0,
      retryable: 0,
      applied: 0,
      conflicted: 0,
      cancelled: 0,
    });
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.reads.regions)).toBe(true);
    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
  });

  it("reports disconnected and cached availability when the host is offline", async () => {
    const status = createLocalFirstStatus({ connectivity: "offline", now: NOW, regions: [await diagnostic()] });

    expect(status.state).toBe("offline");
    expect(status.reason).toBe("disconnected");
    expect(status.reads.availability).toBe("cached");
  });

  it("reports unavailable reads when disconnected with nothing readable", async () => {
    const status = createLocalFirstStatus({
      connectivity: "offline",
      now: NOW,
      regions: [await diagnostic({ stored: false })],
    });

    expect(status.reads.availability).toBe("unavailable");
    expect(status.reads.storedRegionCount).toBe(0);
    expect(status.reads.readableRegionCount).toBe(0);
    expect(status.state).toBe("partial");
    expect(status.reason).toBe("missing-regions");
  });

  it("reaches every one of the seven REQ-006 states", async () => {
    const fresh = await diagnostic();
    const stale = await diagnostic({ observedAt: "2026-08-01T09:00:00.000Z" });
    const expired = await diagnostic({ expiresAt: "2026-08-01T11:00:00.000Z" });
    const partial = await diagnostic({ storedLogicalByteLength: 4 });
    const pending = queuedEdit({ id: editId("1") });
    const conflicted = queuedEdit({
      id: editId("2"),
      state: "conflicted",
      conflict: { conflictId: "conflict-9", detectedAt: "2026-08-01T11:55:00.000Z" },
    });

    const observed: LocalFirstState[] = [
      (await headline({ connectivity: "online", now: NOW, regions: [fresh] })).state,
      (await headline({ connectivity: "offline", now: NOW, regions: [fresh] })).state,
      (await headline({ connectivity: "online", now: NOW, regions: [stale] })).state,
      (await headline({ connectivity: "online", now: NOW, regions: [partial] })).state,
      (await headline({ connectivity: "online", now: NOW, regions: [fresh], edits: [pending] })).state,
      (await headline({ connectivity: "online", now: NOW, regions: [fresh], edits: [conflicted] })).state,
      (await headline({ connectivity: "online", now: NOW, regions: [expired] })).state,
    ];

    expect(observed).toEqual(["online", "offline", "stale", "partial", "pending", "conflicted", "expired"]);
  });

  it("resolves the documented precedence when several conditions apply at once", async () => {
    const expired = await diagnostic({ expiresAt: "2026-08-01T11:00:00.000Z" });
    const partial = await diagnostic({ storedLogicalByteLength: 4, manifest: { name: "Partial area" } });
    const stale = await diagnostic({ observedAt: "2026-08-01T09:00:00.000Z", manifest: { name: "Stale area" } });
    const pending = queuedEdit({ id: editId("1") });
    const conflicted = queuedEdit({
      id: editId("2"),
      state: "conflicted",
      conflict: { conflictId: "conflict-9", detectedAt: "2026-08-01T11:55:00.000Z" },
    });

    expect(
      await headline({
        connectivity: "offline",
        now: NOW,
        regions: [expired, partial, stale],
        edits: [pending, conflicted],
      }),
    ).toEqual({ state: "conflicted", reason: "conflicted-edits" });
    expect(
      await headline({ connectivity: "offline", now: NOW, regions: [expired, partial, stale], edits: [pending] }),
    ).toEqual({ state: "expired", reason: "expired-regions" });
    expect(await headline({ connectivity: "offline", now: NOW, regions: [partial, stale], edits: [pending] })).toEqual({
      state: "partial",
      reason: "partial-regions",
    });
    expect(await headline({ connectivity: "offline", now: NOW, regions: [stale], edits: [pending] })).toEqual({
      state: "pending",
      reason: "undelivered-edits",
    });
    expect(await headline({ connectivity: "offline", now: NOW, regions: [stale] })).toEqual({
      state: "stale",
      reason: "stale-regions",
    });
  });

  it("aggregates freshness and completeness worst-case across regions", async () => {
    const fresh = await diagnostic();
    const stale = await diagnostic({ observedAt: "2026-08-01T09:00:00.000Z", manifest: { name: "Stale area" } });
    const status = createLocalFirstStatus({ connectivity: "offline", now: NOW, regions: [fresh, stale] });

    expect(status.reads.freshness).toBe("stale");
    expect(status.reads.completeness).toBe("complete");
    expect(status.reads.regionCount).toBe(2);
    expect(status.reads.oldestObservedAt).toBe("2026-08-01T09:00:00.000Z");
    expect(status.reads.regions.map((region) => region.regionId)).toEqual(
      [...status.reads.regions.map((region) => region.regionId)].sort(),
    );
  });

  it("ignores the observation age of regions that are not stored", async () => {
    const missingButOld = await diagnostic({ stored: false, observedAt: "2026-07-01T09:00:00.000Z" });
    const status = createLocalFirstStatus({ connectivity: "online", now: NOW, regions: [missingButOld] });

    expect(status.reads.storedRegionCount).toBe(0);
    expect(status.reads.freshness).toBe("fresh");
    expect(status.state).toBe("partial");
    expect(status.reason).toBe("missing-regions");
  });

  it("classifies pending, leased, and retryable work as undelivered and surfaces the next retry", () => {
    const edits: OfflineQueuedEdit[] = [
      queuedEdit({ id: editId("1"), state: "pending", createdAt: "2026-08-01T11:40:00.000Z" }),
      queuedEdit({
        id: editId("2"),
        state: "leased",
        lease: { token: "lease-token-secret", workerId: "worker-1", expiresAt: "2026-08-01T12:05:00.000Z" },
      }),
      queuedEdit({
        id: editId("3"),
        state: "retryable",
        retry: { retryAt: "2026-08-01T12:10:00.000Z", reasonCode: "throttled" },
      }),
      queuedEdit({
        id: editId("4"),
        state: "retryable",
        retry: { retryAt: "2026-08-01T12:02:00.000Z", reasonCode: "throttled" },
      }),
      queuedEdit({ id: editId("5"), state: "applied", applied: { appliedAt: "2026-08-01T11:59:00.000Z" } }),
      queuedEdit({
        id: editId("6"),
        state: "cancelled",
        cancellation: { cancelledAt: "2026-08-01T11:58:00.000Z", reasonCode: "superseded" },
      }),
    ];
    const status = createLocalFirstStatus({ connectivity: "online", now: NOW, edits });

    expect(status.writes.state).toBe("pending");
    expect(status.writes.undeliveredCount).toBe(4);
    expect(status.writes.counts).toEqual({
      pending: 1,
      leased: 1,
      retryable: 2,
      applied: 1,
      conflicted: 0,
      cancelled: 1,
    });
    expect(status.writes.nextRetryAt).toBe("2026-08-01T12:02:00.000Z");
    expect(status.writes.oldestUndeliveredAt).toBe("2026-08-01T11:40:00.000Z");
    expect(JSON.stringify(status)).not.toContain("lease-token-secret");
  });

  it("lists conflicted edit identities in bounded deterministic order", () => {
    const edits = ["1", "2", "3"].map((seed) =>
      queuedEdit({
        id: editId(seed),
        state: "conflicted",
        conflict: { conflictId: `conflict-${seed}`, detectedAt: "2026-08-01T11:55:00.000Z" },
      }),
    );
    const status = createLocalFirstStatus({
      connectivity: "online",
      now: NOW,
      edits,
      limits: { maxListedEditIds: 2 },
    });

    expect(status.writes.state).toBe("conflicted");
    expect(status.writes.conflictedCount).toBe(3);
    expect(status.writes.conflictedEditIds).toEqual([editId("1"), editId("2")]);
    expect(status.writes.conflictedEditIdsTruncated).toBe(true);
  });

  it("treats a bounded sample as a lower bound and authoritative counts as the total", () => {
    const sample = [
      queuedEdit({ id: editId("1"), state: "applied", applied: { appliedAt: "2026-08-01T11:59:00.000Z" } }),
    ];

    const sampled = createLocalFirstStatus({ connectivity: "online", now: NOW, edits: sample });
    expect(sampled.writes.coverage).toBe("sampled");
    expect(sampled.state).toBe("online");

    // The same visible sample, but the partition really holds undelivered and
    // conflicted work beyond the 100-record list window.
    const complete = createLocalFirstStatus({
      connectivity: "online",
      now: NOW,
      edits: sample,
      editCounts: { pending: 3, leased: 1, retryable: 2, applied: 140, conflicted: 4, cancelled: 0 },
    });
    expect(complete.writes.coverage).toBe("complete");
    expect(complete.writes.undeliveredCount).toBe(6);
    expect(complete.writes.conflictedCount).toBe(4);
    expect(complete.writes.conflictedEditIds).toEqual([]);
    expect(complete.writes.conflictedEditIdsTruncated).toBe(true);
    expect(complete.state).toBe("conflicted");
    expect(complete.reason).toBe("conflicted-edits");
  });

  it("reports undelivered totals that the sample cannot show", () => {
    const status = createLocalFirstStatus({
      connectivity: "offline",
      now: NOW,
      edits: [],
      editCounts: { pending: 0, leased: 0, retryable: 7, applied: 100, conflicted: 0, cancelled: 0 },
    });

    expect(status.state).toBe("pending");
    expect(status.writes.undeliveredCount).toBe(7);
    expect(status.writes.counts.applied).toBe(100);
  });

  it("returns no credentials, endpoints, payload values, or scope fingerprints", async () => {
    const status = createLocalFirstStatus({
      connectivity: "offline",
      now: NOW,
      regions: [await diagnostic()],
      edits: [
        queuedEdit({
          id: editId("1"),
          edit: {
            operation: "update",
            featureId: "incident-1",
            attributes: { note: "classified-payload-value" },
            geometry: { type: "Point", coordinates: [-157.9, 21.5] },
          },
        }),
      ],
    });

    const serialized = JSON.stringify(status);
    for (const secret of [
      "classified-payload-value",
      "topsecret",
      "hunter2",
      "reader",
      "tenant:a/role:field",
      "example.test",
      "FeatureServer",
      "OpenStreetMap",
      "edit-key-1",
      "coordinates",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(status.reads.regions[0]?.authorizationScopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("never invokes accessors on edit payloads it does not read", () => {
    let touched = 0;
    const hostile = queuedEdit({ id: editId("1") });
    Object.defineProperty(hostile.edit, "attributes", {
      configurable: true,
      enumerable: true,
      get() {
        touched += 1;
        return { leak: "payload" };
      },
    });

    const status = createLocalFirstStatus({ connectivity: "offline", now: NOW, edits: [hostile] });

    expect(touched).toBe(0);
    expect(status.writes.undeliveredCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain("leak");
  });

  it("is deterministic for identical inputs regardless of supplied order", async () => {
    const first = await diagnostic();
    const second = await diagnostic({ manifest: { name: "Second area" } });
    const editA = queuedEdit({ id: editId("1") });
    const editB = queuedEdit({ id: editId("2"), idempotencyKey: "edit-key-2" });

    const forward = createLocalFirstStatus({
      connectivity: "offline",
      now: NOW,
      regions: [first, second],
      edits: [editA, editB],
    });
    const reversed = createLocalFirstStatus({
      connectivity: "offline",
      now: NOW,
      regions: [second, first],
      edits: [editB, editA],
    });

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});

describe("local-first status trust boundary", () => {
  function rejection(options: unknown): HonuaOfflineRegionError {
    try {
      createLocalFirstStatus(options as Parameters<typeof createLocalFirstStatus>[0]);
    } catch (error) {
      return error as HonuaOfflineRegionError;
    }
    throw new Error("Expected createLocalFirstStatus to reject.");
  }

  it("rejects malformed options with structured paths and a tagged envelope", () => {
    expect(rejection({ connectivity: "maybe", now: NOW }).path).toBe("options.connectivity");
    expect(rejection({ connectivity: "online", now: "2026-08-01" }).path).toBe("options.now");
    expect(rejection({ connectivity: "online", now: new Date(Number.NaN) }).path).toBe("options.now");
    expect(rejection({ connectivity: "online", now: NOW, tenant: "a" }).path).toBe("options.tenant");
    expect(rejection({ connectivity: "online", now: NOW, regions: {} }).path).toBe("options.regions");
    expect(rejection({ connectivity: "online", now: NOW, regions: null }).path).toBe("options.regions");
    expect(rejection({ connectivity: "online", now: NOW, edits: null }).path).toBe("options.edits");

    const error = rejection({ connectivity: "maybe", now: NOW });
    expect(isHonuaError(error)).toBe(true);
    expect(error.sdkCode).toBe("offline.region.validation");
    expect(error.code).toBe("invalid-manifest");
  });

  it("rejects tampered region diagnostics rather than assuming an optimistic state", async () => {
    const valid = await diagnostic();
    const tamperedPath = (mutate: (value: Record<string, any>) => void): string | undefined => {
      const copy = structuredClone(valid) as Record<string, any>;
      mutate(copy);
      return rejection({ connectivity: "online", now: NOW, regions: [copy] }).path;
    };

    expect(
      tamperedPath((value) => {
        value.version = "9.0";
      }),
    ).toBe("options.regions[0].version");
    expect(
      tamperedPath((value) => {
        value.cache.freshness = "brand-new";
      }),
    ).toBe("options.regions[0].cache.freshness");
    expect(
      tamperedPath((value) => {
        value.cache.readable = "yes";
      }),
    ).toBe("options.regions[0].cache.readable");
    expect(
      tamperedPath((value) => {
        value.cache.observedAt = "yesterday";
      }),
    ).toBe("options.regions[0].cache.observedAt");
    expect(
      tamperedPath((value) => {
        value.cache.extra = 1;
      }),
    ).toBe("options.regions[0].cache.extra");
    expect(
      tamperedPath((value) => {
        value.provenance.sourceId = "";
      }),
    ).toBe("options.regions[0].provenance.sourceId");
    expect(rejection({ connectivity: "online", now: NOW, regions: [valid, valid] }).path).toBe(
      "options.regions[1].regionId",
    );
  });

  it("rejects cache facets that cannot have been produced together", async () => {
    const valid = await diagnostic();
    const tamperedPath = (mutate: (value: Record<string, any>) => void): string | undefined => {
      const copy = structuredClone(valid) as Record<string, any>;
      mutate(copy);
      return rejection({ connectivity: "online", now: NOW, regions: [copy] }).path;
    };

    // A missing entry claiming to be complete and readable would otherwise
    // resolve to a confident "cached, complete" headline.
    expect(
      tamperedPath((value) => {
        value.cache.state = "missing";
      }),
    ).toBe("options.regions[0].cache.completeness");
    expect(
      tamperedPath((value) => {
        value.cache.readable = false;
      }),
    ).toBe("options.regions[0].cache.readable");
    expect(
      tamperedPath((value) => {
        value.cache.freshness = "expired";
      }),
    ).toBe("options.regions[0].cache.readable");
    expect(
      tamperedPath((value) => {
        value.cache.reason = "stale-entry";
      }),
    ).toBe("options.regions[0].cache.reason");
    expect(
      tamperedPath((value) => {
        value.cache.completeness = "partial";
        value.cache.readable = false;
      }),
    ).toBe("options.regions[0].cache.reason");
  });

  it("rejects authoritative counts that contradict the supplied sample", () => {
    const edits = [
      queuedEdit({ id: editId("1"), state: "pending" }),
      queuedEdit({ id: editId("2"), state: "pending" }),
    ];

    const error = rejection({
      connectivity: "online",
      now: NOW,
      edits,
      editCounts: { pending: 1, leased: 0, retryable: 0, applied: 0, conflicted: 0, cancelled: 0 },
    });
    expect(error.path).toBe("options.editCounts.pending");
    expect(
      rejection({
        connectivity: "online",
        now: NOW,
        editCounts: { pending: 1, leased: 0, retryable: 0, applied: 0, conflicted: 0, cancelled: -1 },
      }).path,
    ).toBe("options.editCounts.cancelled");
    expect(
      rejection({
        connectivity: "online",
        now: NOW,
        editCounts: { pending: 1, leased: 0, retryable: 0, applied: 0, conflicted: 0, cancelled: 0, rogue: 1 },
      }).path,
    ).toBe("options.editCounts.rogue");
    expect(
      rejection({
        connectivity: "online",
        now: NOW,
        editCounts: { pending: 1, leased: 0, retryable: 0, applied: 0, conflicted: 0 },
      }).path,
    ).toBe("options.editCounts.cancelled");
  });

  it("rejects tampered queued edits", () => {
    expect(
      rejection({
        connectivity: "online",
        now: NOW,
        edits: [queuedEdit({ id: editId("1"), state: "unknown" as OfflineQueuedEditState })],
      }).path,
    ).toBe("options.edits[0].state");
    expect(
      rejection({ connectivity: "online", now: NOW, edits: [{ ...queuedEdit({ id: editId("1") }), id: "1" }] }).path,
    ).toBe("options.edits[0].id");
    expect(
      rejection({
        connectivity: "online",
        now: NOW,
        edits: [{ ...queuedEdit({ id: editId("1") }), createdAt: "2026-08-01" }],
      }).path,
    ).toBe("options.edits[0].createdAt");
    expect(
      rejection({ connectivity: "online", now: NOW, edits: [{ ...queuedEdit({ id: editId("1") }), rogue: true }] })
        .path,
    ).toBe("options.edits[0].rogue");
    expect(
      rejection({
        connectivity: "online",
        now: NOW,
        edits: [queuedEdit({ id: editId("1") }), queuedEdit({ id: editId("1") })],
      }).path,
    ).toBe("options.edits[1].id");
  });

  it("rejects prototype-polluting, accessor-bearing, and sparse inputs", () => {
    expect(rejection(Object.create({ connectivity: "online", now: NOW })).path).toBe("options");
    const accessor: Record<string, unknown> = { now: NOW };
    Object.defineProperty(accessor, "connectivity", { enumerable: true, get: () => "online" });
    expect(rejection(accessor).path).toBe("options.connectivity");

    const sparse = [queuedEdit({ id: editId("1") })];
    sparse.length = 3;
    expect(rejection({ connectivity: "online", now: NOW, edits: sparse }).path).toBe("options.edits[1]");

    const named = [queuedEdit({ id: editId("1") })] as OfflineQueuedEdit[] & { label?: string };
    named.label = "hostile";
    expect(rejection({ connectivity: "online", now: NOW, edits: named }).path).toBe("options.edits.label");
  });

  it("enforces bounded inputs that callers may tighten but not raise", () => {
    const edits = Array.from({ length: 3 }, (_unused, index) =>
      queuedEdit({ id: editId(String(index + 1)), idempotencyKey: `edit-key-${index}` }),
    );
    const error = rejection({ connectivity: "online", now: NOW, edits, limits: { maxEdits: 2 } });

    expect(error.code).toBe("resource-limit-exceeded");
    expect(error.path).toBe("options.edits");
    expect(error.sdkCode).toBe("offline.region.validation");
    expect(
      createLocalFirstStatus({
        connectivity: "online",
        now: NOW,
        edits,
        limits: { maxEdits: Number.MAX_SAFE_INTEGER },
      }).writes.undeliveredCount,
    ).toBe(3);
  });
});
