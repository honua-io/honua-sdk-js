import { describe, expect, it, vi } from "vitest";

import { type RealtimeReconciliationMapLibreMap, attachRealtimeReconciliationToMapLibre } from "../src/map/index.js";
import {
  HonuaRealtimeReconciliationError,
  createRealtimeReconciler,
  emptyRealtimeFeatureState,
  reduceRealtimeFeatureState,
} from "../src/realtime/index.js";
import type { RealtimeFeatureEvent, RealtimeReconciliationResult } from "../src/realtime/index.js";

class FakeMapLibreMap implements RealtimeReconciliationMapLibreMap {
  readonly featureState = new Map<string, Record<string, unknown>>();
  readonly removedKeys: string[] = [];

  private key(id: string | number, sourceLayer?: string): string {
    return `${sourceLayer ?? ""}:${id}`;
  }

  setFeatureState(
    target: { source: string; id: string | number; sourceLayer?: string },
    state: Record<string, unknown>,
  ): void {
    const key = this.key(target.id, target.sourceLayer);
    this.featureState.set(key, { ...this.featureState.get(key), ...state });
  }

  // Mirrors MapLibre semantics: with a state key, only that key is cleared;
  // without one, the feature's entire state is dropped.
  removeFeatureState(target: { source: string; id: string | number; sourceLayer?: string }, stateKey?: string): void {
    const key = this.key(target.id, target.sourceLayer);
    this.removedKeys.push(stateKey === undefined ? key : `${key}[${stateKey}]`);
    if (stateKey === undefined) {
      this.featureState.delete(key);
      return;
    }
    const state = this.featureState.get(key);
    if (!state) return;
    const { [stateKey]: _removed, ...rest } = state;
    if (Object.keys(rest).length === 0) this.featureState.delete(key);
    else this.featureState.set(key, rest);
  }
}

function patchResult(changes: RealtimeReconciliationResult<unknown>["changes"]): RealtimeReconciliationResult<unknown> {
  return { mode: "patch", changes, version: {}, reset: false, pendingPatchCount: changes.length };
}

function rebuildResult(): RealtimeReconciliationResult<unknown> {
  return { mode: "rebuild", rebuildReason: "reset", changes: [], version: {}, reset: true, pendingPatchCount: 0 };
}

describe("attachRealtimeReconciliationToMapLibre (REQ-005 renderer adapter)", () => {
  it("applies create/update changes as setFeatureState in patch mode", () => {
    const map = new FakeMapLibreMap();
    const rebuild = vi.fn();
    const adapter = attachRealtimeReconciliationToMapLibre(map, { sourceId: "parcels", rebuild });
    adapter.apply(
      patchResult([
        { kind: "create", key: "k1", id: "f1" },
        { kind: "update", key: "k2", id: "f2" },
      ]),
    );
    expect(map.featureState.get(":f1")).toEqual({ realtimeStatus: "create" });
    expect(map.featureState.get(":f2")).toEqual({ realtimeStatus: "update" });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("applies delete changes as a removeFeatureState scoped to the status key in patch mode", () => {
    const map = new FakeMapLibreMap();
    const adapter = attachRealtimeReconciliationToMapLibre(map, { sourceId: "parcels", rebuild: vi.fn() });
    adapter.apply(patchResult([{ kind: "create", key: "k1", id: "f1" }]));
    adapter.apply(patchResult([{ kind: "delete", key: "k1", id: "f1" }]));
    expect(map.removedKeys).toEqual([":f1[realtimeStatus]"]);
    expect(map.featureState.has(":f1")).toBe(false);
  });

  it("delete removes only the adapter-owned status key, preserving unrelated feature state", () => {
    const map = new FakeMapLibreMap();
    const adapter = attachRealtimeReconciliationToMapLibre(map, { sourceId: "parcels", rebuild: vi.fn() });
    adapter.apply(patchResult([{ kind: "create", key: "k1", id: "f1" }]));
    // Hover/selection state set by other code on the same source and feature.
    map.setFeatureState({ source: "parcels", id: "f1" }, { hover: true });
    adapter.apply(patchResult([{ kind: "delete", key: "k1", id: "f1" }]));
    expect(map.featureState.get(":f1")).toEqual({ hover: true });
  });

  it("honors a custom statusStateKey and sourceLayer target", () => {
    const map = new FakeMapLibreMap();
    const adapter = attachRealtimeReconciliationToMapLibre(map, {
      sourceId: "parcels",
      sourceLayer: "parcels-layer",
      statusStateKey: "liveStatus",
      rebuild: vi.fn(),
    });
    adapter.apply(patchResult([{ kind: "create", key: "k1", id: "f1" }]));
    expect(map.featureState.get("parcels-layer:f1")).toEqual({ liveStatus: "create" });
  });

  it("invokes the rebuild callback (and not setFeatureState) for rebuild-mode results", () => {
    const map = new FakeMapLibreMap();
    const rebuild = vi.fn();
    const adapter = attachRealtimeReconciliationToMapLibre(map, { sourceId: "parcels", rebuild });
    const result = rebuildResult();
    adapter.apply(result);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(result);
    expect(map.featureState.size).toBe(0);
  });

  it("does not throw against a map without feature-state methods", () => {
    const adapter = attachRealtimeReconciliationToMapLibre({}, { sourceId: "parcels", rebuild: vi.fn() });
    expect(() =>
      adapter.apply(
        patchResult([
          { kind: "create", key: "k1", id: "f1" },
          { kind: "delete", key: "k2", id: "f2" },
        ]),
      ),
    ).not.toThrow();
  });

  it("disposal: a disposed adapter receives no further patches and never calls rebuild again", () => {
    const map = new FakeMapLibreMap();
    const rebuild = vi.fn();
    const adapter = attachRealtimeReconciliationToMapLibre(map, { sourceId: "parcels", rebuild });
    adapter.dispose();
    expect(adapter.disposed).toBe(true);
    expect(() => adapter.apply(rebuildResult())).toThrow(HonuaRealtimeReconciliationError);
    expect(rebuild).not.toHaveBeenCalled();
    try {
      adapter.apply(patchResult([{ kind: "create", key: "k1", id: "f1" }]));
      expect.unreachable();
    } catch (error) {
      expect((error as HonuaRealtimeReconciliationError).code).toBe("disposed");
    }
    expect(map.featureState.size).toBe(0);
  });

  it("integrates end-to-end with createRealtimeReconciler across create/update/delete", () => {
    const map = new FakeMapLibreMap();
    const reconciler = createRealtimeReconciler<{ status: string }>({ rebuildThreshold: 100 });
    const rebuild = vi.fn();
    const adapter = attachRealtimeReconciliationToMapLibre(map, { sourceId: "parcels", rebuild });

    let state = emptyRealtimeFeatureState<{ status: string }>();
    const apply = (event: RealtimeFeatureEvent<{ status: string }>) => {
      const next = reduceRealtimeFeatureState(state, event);
      const result = reconciler.reconcile(state, next, { kind: "event", event });
      adapter.apply(result);
      state = next;
    };

    apply({ type: "upsert", feature: { id: "f1", feature: { status: "open" } }, sequence: 1 });
    apply({ type: "upsert", feature: { id: "f1", feature: { status: "closed" } }, sequence: 2 });
    apply({ type: "delete", id: "f1", sequence: 3 });

    expect(map.removedKeys).toEqual([":f1[realtimeStatus]"]);
    expect(map.featureState.has(":f1")).toBe(false);
    expect(rebuild).not.toHaveBeenCalled();
  });
});
