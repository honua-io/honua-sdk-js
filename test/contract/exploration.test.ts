/**
 * `ExplorationContext` reducer + linked-view + coalescing semantics.
 *
 * The reducer tests are pure; the context tests rely on `await
 * Promise.resolve()` to flush microtasks (the implementation uses
 * `queueMicrotask`).
 */

import { describe, expect, it } from "vitest";

import { HonuaExplorationContextError } from "../../src/core/errors.js";
import { envelope } from "../../src/core/spatial-filter.js";
import {
  type ChangeEvent,
  EMPTY_STATE,
  type ExplorationIntent,
  type ExplorationState,
  LINKED_VIEW_PRESETS,
  SLICES,
  createExplorationContext,
  propagationFor,
  reduce,
} from "../../src/exploration/index.js";

async function flush(): Promise<void> {
  // Drain microtask queue twice — `queueMicrotask` schedules into the same
  // queue as `Promise.resolve().then`, so two drains catch listeners that
  // dispatch in response to a change.
  await Promise.resolve();
  await Promise.resolve();
}

describe("exploration / reduce", () => {
  it("set-filter adds a new clause and only changes the filters slice", () => {
    const next = reduce(EMPTY_STATE, {
      kind: "set-filter",
      id: "state",
      clause: { field: "STATE", operator: "=", value: "CA" },
    });
    expect(next.changedSlices).toEqual(new Set(["filters"]));
    expect(next.state.filters.state.value).toBe("CA");
  });

  it("set-filter is a no-op when the same clause is dispatched twice", () => {
    const first = reduce(EMPTY_STATE, {
      kind: "set-filter",
      id: "state",
      clause: { field: "STATE", operator: "=", value: "CA" },
    });
    const second = reduce(first.state, {
      kind: "set-filter",
      id: "state",
      clause: { field: "STATE", operator: "=", value: "CA" },
    });
    expect(second.changedSlices.size).toBe(0);
    expect(second.state).toBe(first.state);
  });

  it("clear-filter removes the named clause", () => {
    const seeded = reduce(EMPTY_STATE, {
      kind: "set-filter",
      id: "state",
      clause: { field: "STATE", operator: "=", value: "CA" },
    });
    const cleared = reduce(seeded.state, { kind: "clear-filter", id: "state" });
    expect(cleared.state.filters).toEqual({});
    expect(cleared.changedSlices).toEqual(new Set(["filters"]));
  });

  it("select is additive by default and replace=true wipes the prior selection", () => {
    const additive = reduce(EMPTY_STATE, { kind: "select", ids: [1, 2] });
    expect(additive.state.selection).toEqual([1, 2]);
    const more = reduce(additive.state, { kind: "select", ids: [2, 3] });
    expect(more.state.selection).toEqual([1, 2, 3]);
    const replaced = reduce(more.state, { kind: "select", ids: [99], replace: true });
    expect(replaced.state.selection).toEqual([99]);
  });

  it("deselect without ids clears the selection", () => {
    const seeded = reduce(EMPTY_STATE, { kind: "select", ids: [1, 2, 3] });
    const wiped = reduce(seeded.state, { kind: "deselect" });
    expect(wiped.state.selection).toEqual([]);
  });

  it("set-spatial-filter treats structurally equal filters as a no-op", () => {
    const a = reduce(EMPTY_STATE, {
      kind: "set-spatial-filter",
      spatialFilter: envelope(-118, 33, -117, 34),
    });
    const b = reduce(a.state, {
      kind: "set-spatial-filter",
      spatialFilter: envelope(-118, 33, -117, 34),
    });
    expect(b.changedSlices.size).toBe(0);
    expect(b.state).toBe(a.state);
  });

  it("snapshot-restore with a structurally equal spatial filter does not flag spatialFilter as changed", () => {
    const seeded = reduce(EMPTY_STATE, {
      kind: "set-spatial-filter",
      spatialFilter: envelope(-118, 33, -117, 34),
    });
    const restored = reduce(seeded.state, {
      kind: "snapshot-restore",
      snapshot: {
        version: 1,
        state: { ...seeded.state, spatialFilter: envelope(-118, 33, -117, 34) },
      },
    });
    expect(restored.changedSlices.has("spatialFilter")).toBe(false);
    expect(restored.changedSlices.size).toBe(0);
  });

  it("set-extent treats structurally equal extents as a no-op", () => {
    const a = reduce(EMPTY_STATE, {
      kind: "set-extent",
      extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    });
    const b = reduce(a.state, {
      kind: "set-extent",
      extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    });
    expect(b.changedSlices.size).toBe(0);
  });

  it("snapshot-restore reports every slice that actually moved", () => {
    const seeded = reduce(EMPTY_STATE, { kind: "select", ids: [1] });
    const restored = reduce(seeded.state, {
      kind: "snapshot-restore",
      snapshot: { version: 1, state: { ...EMPTY_STATE, sort: [{ field: "ACRES", direction: "desc" }] } },
    });
    expect(restored.changedSlices.has("selection")).toBe(true);
    expect(restored.changedSlices.has("sort")).toBe(true);
  });
});

describe("exploration / LINKED_VIEW_PRESETS", () => {
  it("globalLinked propagates every slice from every role", () => {
    const slices = propagationFor("globalLinked", "map");
    expect(slices.has("filters")).toBe(true);
    expect(slices.has("sort")).toBe(true);
    expect(slices.has("preset")).toBe(true);
  });

  it("mapDriven only propagates map-origin extent / spatialFilter / selection / filters", () => {
    expect([...propagationFor("mapDriven", "map")].sort()).toEqual(
      ["extent", "filters", "selection", "spatialFilter"].sort(),
    );
    expect(propagationFor("mapDriven", "grid").size).toBe(0);
  });

  it("decoupled propagates nothing", () => {
    for (const role of ["map", "grid", "chart", "form", "custom"] as const) {
      expect(propagationFor("decoupled", role).size).toBe(0);
    }
  });

  it("declares a rule for every ViewRole on every preset", () => {
    for (const name of Object.keys(LINKED_VIEW_PRESETS) as Array<keyof typeof LINKED_VIEW_PRESETS>) {
      const policy = LINKED_VIEW_PRESETS[name];
      const roles = new Set(policy.rules.map((r) => r.role));
      expect(roles).toEqual(new Set(["map", "grid", "chart", "form", "custom"]));
    }
  });
});

describe("exploration / createExplorationContext", () => {
  it("reflects state mutations synchronously and notifies listeners on a microtask", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
    const events: ChangeEvent[] = [];
    ctx.subscribe("filters", (e) => events.push(e));

    ctx.dispatch({
      kind: "set-filter",
      id: "state",
      clause: { field: "STATE", operator: "=", value: "CA" },
    });
    expect(ctx.state.filters.state).toBeDefined();
    expect(events.length).toBe(0);

    await flush();
    expect(events.length).toBe(1);
    expect(events[0].changedSlices.has("filters")).toBe(true);

    ctx.dispose();
  });

  it("coalesces a burst of intents into a single event per slice", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
    const filterEvents: ChangeEvent[] = [];
    const sortEvents: ChangeEvent[] = [];
    const allEvents: ChangeEvent[] = [];
    ctx.subscribe("filters", (e) => filterEvents.push(e));
    ctx.subscribe("sort", (e) => sortEvents.push(e));
    ctx.subscribe("all", (e) => allEvents.push(e));

    ctx.dispatch({ kind: "set-filter", id: "a", clause: { field: "A", operator: "=", value: 1 } });
    ctx.dispatch({ kind: "set-filter", id: "b", clause: { field: "B", operator: "=", value: 2 } });
    ctx.dispatch({ kind: "set-sort", sort: [{ field: "A", direction: "asc" }] });

    await flush();

    expect(filterEvents.length).toBe(1);
    expect(sortEvents.length).toBe(1);
    expect(allEvents.length).toBe(1);
    expect(allEvents[0].changedSlices).toEqual(new Set(["filters", "sort"]));
    ctx.dispose();
  });

  it("respects the linked-view policy when filtering listener wakeups", async () => {
    const ctx = createExplorationContext({
      datasetId: "d",
      sourceIds: ["s"],
      preset: "mapDriven",
    });
    ctx.bind({ id: "map", role: "map" });
    ctx.bind({ id: "grid", role: "grid" });

    const sortEvents: ChangeEvent[] = [];
    ctx.subscribe("sort", (e) => sortEvents.push(e));
    const extentEvents: ChangeEvent[] = [];
    ctx.subscribe("extent", (e) => extentEvents.push(e));

    // Grid cannot propagate sort under mapDriven → listener is not woken
    // even though state is updated centrally.
    ctx.dispatch({ kind: "set-sort", sort: [{ field: "A" }], viewId: "grid" });
    // Map propagates extent → listener is woken.
    ctx.dispatch({ kind: "set-extent", extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, viewId: "map" });
    await flush();

    expect(sortEvents.length).toBe(0);
    expect(extentEvents.length).toBe(1);
    // Central state still moved.
    expect(ctx.state.sort).toHaveLength(1);
    expect(ctx.state.extent).toBeDefined();

    ctx.dispose();
  });

  it("snapshot / restore round-trips state", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
    ctx.dispatch({
      kind: "set-filter",
      id: "state",
      clause: { field: "STATE", operator: "=", value: "CA" },
    });
    await flush();
    const snap = ctx.snapshot();

    ctx.dispatch({ kind: "clear-filter", id: "state" });
    await flush();
    expect(ctx.state.filters).toEqual({});

    ctx.restore(snap);
    await flush();
    expect(ctx.state.filters.state.value).toBe("CA");
    ctx.dispose();
  });

  it("apply-preset rotates the active linked-view policy", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
    expect(ctx.policy.preset).toBe("globalLinked");
    ctx.dispatch({ kind: "apply-preset", preset: "decoupled" });
    await flush();
    expect(ctx.policy.preset).toBe("decoupled");
    ctx.dispose();
  });

  it("rejects bind / dispatch / restore after dispose with HonuaExplorationContextError", () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
    ctx.dispose();
    expect(() => ctx.dispatch({ kind: "deselect" })).toThrow(HonuaExplorationContextError);
    expect(() => ctx.bind({ id: "v", role: "map" })).toThrow(HonuaExplorationContextError);
  });

  it("rejects duplicate view bindings", () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
    ctx.bind({ id: "v", role: "map" });
    expect(() => ctx.bind({ id: "v", role: "grid" })).toThrow(HonuaExplorationContextError);
    ctx.dispose();
  });

  it("rejects snapshots whose version is unsupported", () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
    expect(() => ctx.restore({ version: 99 as unknown as 1, state: EMPTY_STATE } as never)).toThrow(
      HonuaExplorationContextError,
    );
    ctx.dispose();
  });
});

describe("exploration / SLICES", () => {
  it("includes 'all' plus every state field", () => {
    expect(SLICES[0]).toBe("all");
    const stateKeys: Array<keyof ExplorationState> = [
      "filters",
      "spatialFilter",
      "extent",
      "selection",
      "sort",
      "page",
      "visibleFields",
      "grouping",
      "aggregation",
      "preset",
    ];
    for (const key of stateKeys) expect(SLICES).toContain(key);
  });
});

describe("exploration / dispatch ignores unknown viewIds", () => {
  it("falls back to external propagation when viewId is unknown", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"], preset: "decoupled" });
    const events: ChangeEvent[] = [];
    ctx.subscribe("sort", (e) => events.push(e));
    // viewId references no binding → external intent → propagates everywhere
    // (decoupled only kicks in for *bound* views).
    const intent: ExplorationIntent = { kind: "set-sort", sort: [{ field: "A" }], viewId: "ghost" };
    ctx.dispatch(intent);
    await flush();
    expect(events.length).toBe(1);
    ctx.dispose();
  });
});
