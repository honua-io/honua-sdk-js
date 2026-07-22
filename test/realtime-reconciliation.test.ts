import { describe, expect, it } from "vitest";

import {
  HonuaRealtimeReconciliationError,
  createRealtimeReconciledCache,
  createRealtimeReconciler,
  diffRealtimeFeatureState,
  emptyRealtimeFeatureState,
  realtimeFeatureKey,
  realtimeReconciliationVersion,
  reconcileRealtimeKeyedState,
  reconcileRealtimeViewport,
  reduceRealtimeFeatureState,
} from "../src/realtime/index.js";
import type {
  RealtimeFeatureEvent,
  RealtimeFeatureState,
  RealtimeReconciliationResult,
  RealtimeReconciliationTrigger,
} from "../src/realtime/index.js";

interface Widget {
  readonly status: string;
}

function upsertEvent(id: string, status: string, sequence: number): RealtimeFeatureEvent<Widget> {
  return { type: "upsert", feature: { id, feature: { status } }, sequence };
}

function deleteEvent(id: string, sequence: number): RealtimeFeatureEvent<Widget> {
  return { type: "delete", id, sequence };
}

function snapshotEvent(entries: ReadonlyArray<[string, string]>, sequence: number): RealtimeFeatureEvent<Widget> {
  return {
    type: "snapshot",
    features: entries.map(([id, status]) => ({ id, feature: { status } })),
    sequence,
  };
}

/** Apply one event through the accepted reducer and return both states. */
function step(
  previous: RealtimeFeatureState<Widget>,
  event: RealtimeFeatureEvent<Widget>,
): { previous: RealtimeFeatureState<Widget>; next: RealtimeFeatureState<Widget> } {
  return { previous, next: reduceRealtimeFeatureState(previous, event) };
}

describe("diffRealtimeFeatureState (REQ-001 identity + patch/rebuild classification)", () => {
  it("classifies an upsert of a new key as create", () => {
    const { previous, next } = step(emptyRealtimeFeatureState<Widget>(), upsertEvent("f1", "open", 1));
    const diff = diffRealtimeFeatureState(previous, next, { kind: "event", event: upsertEvent("f1", "open", 1) });
    expect(diff.reset).toBe(false);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ kind: "create", id: "f1", key: realtimeFeatureKey(undefined, "f1") });
    expect(diff.changes[0].record?.feature).toEqual({ status: "open" });
  });

  it("classifies an upsert of an existing key as update", () => {
    const s1 = step(emptyRealtimeFeatureState<Widget>(), upsertEvent("f1", "open", 1));
    const event = upsertEvent("f1", "closed", 2);
    const s2 = step(s1.next, event);
    const diff = diffRealtimeFeatureState(s2.previous, s2.next, { kind: "event", event });
    expect(diff.changes[0].kind).toBe("update");
    expect(diff.changes[0].record?.feature).toEqual({ status: "closed" });
  });

  it("classifies a delete event and preserves the tombstone", () => {
    const s1 = step(emptyRealtimeFeatureState<Widget>(), upsertEvent("f1", "open", 1));
    const event = deleteEvent("f1", 2);
    const s2 = step(s1.next, event);
    const diff = diffRealtimeFeatureState(s2.previous, s2.next, { kind: "event", event });
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].kind).toBe("delete");
    expect(diff.changes[0].tombstone).toBeDefined();
    expect(diff.reset).toBe(false);
  });

  it("classifies a delta batch's upserts and deletes independently", () => {
    const s1 = step(emptyRealtimeFeatureState<Widget>(), upsertEvent("f1", "open", 1));
    const event: RealtimeFeatureEvent<Widget> = {
      type: "delta",
      upserts: [
        { id: "f1", feature: { status: "closed" } },
        { id: "f2", feature: { status: "open" } },
      ],
      deletes: [{ id: "f3" }],
      sequence: 2,
    };
    const s2 = step(s1.next, event);
    const diff = diffRealtimeFeatureState(s2.previous, s2.next, { kind: "event", event });
    expect(diff.reset).toBe(false);
    const kinds = diff.changes.map((change) => `${change.id}:${change.kind}`).sort();
    expect(kinds).toEqual(["f1:update", "f2:create", "f3:delete"]);
  });

  it("classifies a replacement snapshot as a reset", () => {
    const s1 = step(emptyRealtimeFeatureState<Widget>(), upsertEvent("f1", "open", 1));
    const event = snapshotEvent(
      [
        ["f2", "open"],
        ["f3", "open"],
      ],
      2,
    );
    const s2 = step(s1.next, event);
    const diff = diffRealtimeFeatureState(s2.previous, s2.next, { kind: "event", event });
    expect(diff.reset).toBe(true);
    expect(diff.resetReason).toBe("replacement-snapshot");
    // A reset always reports the *next* store's full record set as creates.
    expect(diff.changes.map((change) => change.id).sort()).toEqual(["f2", "f3"]);
  });

  it("classifies a merging (replace: false) snapshot as per-key create/update, not a reset", () => {
    const s1 = step(emptyRealtimeFeatureState<Widget>(), upsertEvent("f1", "open", 1));
    const event: RealtimeFeatureEvent<Widget> = {
      type: "snapshot",
      replace: false,
      features: [
        { id: "f1", feature: { status: "closed" } },
        { id: "f2", feature: { status: "open" } },
      ],
      sequence: 2,
    };
    const s2 = step(s1.next, event);
    const diff = diffRealtimeFeatureState(s2.previous, s2.next, { kind: "event", event });
    expect(diff.reset).toBe(false);
    const kinds = diff.changes.map((change) => `${change.id}:${change.kind}`).sort();
    expect(kinds).toEqual(["f1:update", "f2:create"]);
  });

  it("supports an explicit schema-change reset trigger outside the event stream", () => {
    const state = step(emptyRealtimeFeatureState<Widget>(), upsertEvent("f1", "open", 1)).next;
    const trigger: RealtimeReconciliationTrigger<Widget> = {
      kind: "reset",
      reason: "schema-changed",
      detail: "schemaVersion advanced",
    };
    const diff = diffRealtimeFeatureState(state, state, trigger);
    expect(diff.reset).toBe(true);
    expect(diff.resetReason).toBe("schema-changed");
    expect(diff.resetDetail).toBe("schemaVersion advanced");
    expect(diff.changes.map((change) => change.id)).toEqual(["f1"]);
  });

  it("produces no identity changes for heartbeat/status/error events", () => {
    const state = emptyRealtimeFeatureState<Widget>();
    for (const event of [
      { type: "heartbeat" } as RealtimeFeatureEvent<Widget>,
      { type: "status", status: "live" } as RealtimeFeatureEvent<Widget>,
      { type: "error", error: new Error("boom") } as RealtimeFeatureEvent<Widget>,
    ]) {
      const next = reduceRealtimeFeatureState(state, event);
      const diff = diffRealtimeFeatureState(state, next, { kind: "event", event });
      expect(diff.changes).toEqual([]);
      expect(diff.reset).toBe(false);
    }
  });
});

describe("realtimeReconciliationVersion", () => {
  it("records only the resume-position fields present on the store", () => {
    const state = reduceRealtimeFeatureState(emptyRealtimeFeatureState<Widget>(), upsertEvent("f1", "open", 7));
    const version = realtimeReconciliationVersion(state);
    expect(version).toEqual({ sequence: 7 });
  });

  it("carries cursor/watermark/timestamp/deltaToken forward once seen", () => {
    const state = reduceRealtimeFeatureState(emptyRealtimeFeatureState<Widget>(), {
      type: "upsert",
      feature: { id: "f1", feature: { status: "open" } },
      cursor: "cur-1",
      watermark: "wm-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      deltaToken: "dt-1",
      sequence: 1,
    });
    expect(realtimeReconciliationVersion(state)).toEqual({
      cursor: "cur-1",
      watermark: "wm-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      sequence: 1,
      deltaToken: "dt-1",
    });
  });
});

describe("createRealtimeReconciler (REQ-004 bounded patch queue / rebuild policy)", () => {
  it("reports mode patch and accumulates pendingPatchCount across small deltas", () => {
    const reconciler = createRealtimeReconciler<Widget>({ rebuildThreshold: 10 });
    let state = emptyRealtimeFeatureState<Widget>();
    let result: RealtimeReconciliationResult<Widget> | undefined;
    for (let i = 0; i < 3; i++) {
      const event = upsertEvent(`f${i}`, "open", i + 1);
      const next = reduceRealtimeFeatureState(state, event);
      result = reconciler.reconcile(state, next, { kind: "event", event });
      state = next;
    }
    expect(result?.mode).toBe("patch");
    expect(result?.pendingPatchCount).toBe(3);
    expect(reconciler.pendingPatchCount).toBe(3);
  });

  it("forces a rebuild when a single event exceeds maxChangesPerEvent", () => {
    const reconciler = createRealtimeReconciler<Widget>({ maxChangesPerEvent: 2, rebuildThreshold: 100 });
    const previous = emptyRealtimeFeatureState<Widget>();
    const event: RealtimeFeatureEvent<Widget> = {
      type: "delta",
      upserts: [
        { id: "f1", feature: { status: "open" } },
        { id: "f2", feature: { status: "open" } },
        { id: "f3", feature: { status: "open" } },
      ],
      sequence: 1,
    };
    const next = reduceRealtimeFeatureState(previous, event);
    const result = reconciler.reconcile(previous, next, { kind: "event", event });
    expect(result.mode).toBe("rebuild");
    expect(result.rebuildReason).toBe("event-exceeds-patch-bound");
    expect(result.reset).toBe(false);
    expect(result.pendingPatchCount).toBe(0);
    expect(reconciler.pendingPatchCount).toBe(0);
  });

  it("switches to rebuild once the cumulative pending-patch queue crosses rebuildThreshold", () => {
    const reconciler = createRealtimeReconciler<Widget>({ rebuildThreshold: 3 });
    let state = emptyRealtimeFeatureState<Widget>();
    const results: RealtimeReconciliationResult<Widget>[] = [];
    for (let i = 0; i < 5; i++) {
      const event = upsertEvent(`f${i}`, "open", i + 1);
      const next = reduceRealtimeFeatureState(state, event);
      results.push(reconciler.reconcile(state, next, { kind: "event", event }));
      state = next;
    }
    // 3 patches accumulate (pending 1, 2, 3), the 4th push (pending would be 4 > 3) rebuilds and resets to 0,
    // the 5th goes back to patch mode with pending 1 — proving the bound never grows unboundedly.
    expect(results.map((result) => result.mode)).toEqual(["patch", "patch", "patch", "rebuild", "patch"]);
    expect(results[3].rebuildReason).toBe("queue-threshold-exceeded");
    expect(results[3].pendingPatchCount).toBe(0);
    expect(results[4].pendingPatchCount).toBe(1);
  });

  it("treats a reset trigger as an immediate rebuild and clears the pending queue", () => {
    const reconciler = createRealtimeReconciler<Widget>({ rebuildThreshold: 100 });
    let state = emptyRealtimeFeatureState<Widget>();
    for (let i = 0; i < 3; i++) {
      const event = upsertEvent(`f${i}`, "open", i + 1);
      const next = reduceRealtimeFeatureState(state, event);
      reconciler.reconcile(state, next, { kind: "event", event });
      state = next;
    }
    expect(reconciler.pendingPatchCount).toBe(3);
    const result = reconciler.reconcile(state, state, { kind: "reset", reason: "schema-changed" });
    expect(result.mode).toBe("rebuild");
    expect(result.rebuildReason).toBe("reset");
    expect(result.reset).toBe(true);
    expect(result.resetReason).toBe("schema-changed");
    expect(reconciler.pendingPatchCount).toBe(0);
  });

  it("rejects a non-positive option", () => {
    expect(() => createRealtimeReconciler({ maxChangesPerEvent: 0 })).toThrow(HonuaRealtimeReconciliationError);
    try {
      createRealtimeReconciler({ rebuildThreshold: -1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HonuaRealtimeReconciliationError);
      expect((error as HonuaRealtimeReconciliationError).code).toBe("invalid-option");
    }
  });

  it("disposal: a disposed reconciler receives no further patches", () => {
    const reconciler = createRealtimeReconciler<Widget>();
    const state = emptyRealtimeFeatureState<Widget>();
    reconciler.dispose();
    expect(reconciler.disposed).toBe(true);
    expect(() => reconciler.reconcile(state, state, { kind: "reset", reason: "manual" })).toThrow(
      HonuaRealtimeReconciliationError,
    );
    try {
      reconciler.reconcile(state, state, { kind: "reset", reason: "manual" });
      expect.unreachable();
    } catch (error) {
      expect((error as HonuaRealtimeReconciliationError).code).toBe("disposed");
    }
  });
});

describe("createRealtimeReconciledCache (REQ-002 cache identity consistency)", () => {
  it("keeps cached features identity-consistent with the accepted store across create/update/delete/reset", () => {
    const reconciler = createRealtimeReconciler<Widget>({ rebuildThreshold: 100 });
    const cache = createRealtimeReconciledCache<Widget>();
    let state = emptyRealtimeFeatureState<Widget>();

    const apply = (event: RealtimeFeatureEvent<Widget>): void => {
      const next = reduceRealtimeFeatureState(state, event);
      const result = reconciler.reconcile(state, next, { kind: "event", event });
      cache.apply(result);
      state = next;
      // Invariant under test: the cache's live feature set always matches the
      // accepted store's live record set (same identity keys, same feature payload).
      const cachedIds = new Set(cache.snapshot().features.map((feature) => feature.status));
      const storeIds = new Set(Object.values(state.records).map((record) => record.feature.status));
      expect(cachedIds).toEqual(storeIds);
      expect(cache.snapshot().features).toHaveLength(Object.keys(state.records).length);
    };

    apply(upsertEvent("f1", "created", 1)); // create
    apply(upsertEvent("f1", "updated", 2)); // update
    apply(upsertEvent("f2", "created", 3)); // create
    apply(deleteEvent("f1", 4)); // delete
    apply(snapshotEvent([["f9", "reset"]], 5)); // reset -> rebuild

    expect(cache.snapshot().features).toEqual([{ status: "reset" }]);
    expect(cache.snapshot().version).toEqual({ sequence: 5 });
  });

  it("preserves insertion order for a patched update and drops deleted entries", () => {
    const reconciler = createRealtimeReconciler<Widget>({ rebuildThreshold: 100 });
    const cache = createRealtimeReconciledCache<Widget>();
    let state = emptyRealtimeFeatureState<Widget>();
    const apply = (event: RealtimeFeatureEvent<Widget>) => {
      const next = reduceRealtimeFeatureState(state, event);
      cache.apply(reconciler.reconcile(state, next, { kind: "event", event }));
      state = next;
    };
    apply(upsertEvent("a", "1", 1));
    apply(upsertEvent("b", "2", 2));
    apply(upsertEvent("a", "1-updated", 3)); // update: must not move position
    expect(cache.snapshot().features).toEqual([{ status: "1-updated" }, { status: "2" }]);
    apply(deleteEvent("b", 4));
    expect(cache.snapshot().features).toEqual([{ status: "1-updated" }]);
  });

  it("disposal: a disposed cache receives no further patches", () => {
    const cache = createRealtimeReconciledCache<Widget>();
    const result: RealtimeReconciliationResult<Widget> = {
      mode: "rebuild",
      reset: true,
      resetReason: "replacement-snapshot",
      changes: [],
      version: {},
      pendingPatchCount: 0,
    };
    cache.apply(result);
    cache.dispose();
    expect(cache.disposed).toBe(true);
    expect(() => cache.apply(result)).toThrow(HonuaRealtimeReconciliationError);
  });
});

describe("reconcileRealtimeKeyedState (REQ-003 selection/filter deterministic preservation/invalidation)", () => {
  it("preserves keys untouched by the delta", () => {
    const keys = new Set(["a", "b"]);
    const result = reconcileRealtimeKeyedState(keys, { changes: [], reset: false });
    expect(result.next).toBe(keys);
    expect(result.invalidations).toEqual([]);
  });

  it("invalidates a selected/filtered key that the delta deleted, with a structured reason", () => {
    const keys = new Set(["a", "b"]);
    const result = reconcileRealtimeKeyedState(keys, {
      changes: [{ kind: "delete", key: "a", id: "a" }],
      reset: false,
    });
    expect([...result.next]).toEqual(["b"]);
    expect(result.invalidations).toEqual([{ key: "a", reason: "feature-deleted" }]);
  });

  it("invalidates every key on reset, with reason reset", () => {
    const keys = new Set(["a", "b"]);
    const result = reconcileRealtimeKeyedState(keys, { changes: [], reset: true, resetReason: "replacement-snapshot" });
    expect(result.next.size).toBe(0);
    expect([...result.invalidations].sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { key: "a", reason: "reset" },
      { key: "b", reason: "reset" },
    ]);
  });

  it("invalidates every key with reason schema-changed when that was the reset reason", () => {
    const keys = new Set(["a"]);
    const result = reconcileRealtimeKeyedState(keys, { changes: [], reset: true, resetReason: "schema-changed" });
    expect(result.invalidations).toEqual([{ key: "a", reason: "schema-changed" }]);
  });
});

describe("reconcileRealtimeViewport (REQ-003 viewport preservation)", () => {
  it("preserves the viewport unchanged and not invalidated for a non-reset result", () => {
    const viewport = { center: [1, 2], zoom: 5 };
    const result = reconcileRealtimeViewport(viewport, { reset: false });
    expect(result.viewport).toBe(viewport);
    expect(result.invalidated).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("still passes the viewport through unchanged on reset, but flags it invalidated", () => {
    const viewport = { center: [1, 2], zoom: 5 };
    const result = reconcileRealtimeViewport(viewport, { reset: true, resetReason: "replacement-snapshot" });
    expect(result.viewport).toBe(viewport);
    expect(result.invalidated).toBe(true);
    expect(result.reason).toBe("reset");
  });

  it("reports schema-changed as the invalidation reason on a schema reset", () => {
    const result = reconcileRealtimeViewport({}, { reset: true, resetReason: "schema-changed" });
    expect(result.reason).toBe("schema-changed");
  });
});
