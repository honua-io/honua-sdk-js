import { describe, expect, it } from "vitest";

import { createExplorationContext } from "../src/exploration/context.js";
import type { ExplorationViewController } from "../src/exploration/types.js";
import {
  KEPLER_LINKED_STATE_MAPPINGS,
  type KeplerLinkedStateUpdate,
  type KeplerMapState,
  createKeplerLinkedStateSync,
  extentToKeplerMapState,
  honuaClauseToKeplerFilter,
  honuaClauseToTemporalWindow,
  keplerFilterToHonuaClause,
  keplerLinkedStateMapping,
  keplerMapStateToExtent,
  keplerSelectionFilterValue,
  keplerTimeRangeToTemporalWindow,
  temporalWindowToHonuaClause,
} from "../src/kepler/index.js";

const VIEWPORT = { width: 1200, height: 800 } as const;

function mapState(overrides: Partial<KeplerMapState> = {}): KeplerMapState {
  return { longitude: -122.4, latitude: 37.8, zoom: 11, bearing: 0, pitch: 0, ...overrides };
}

interface Workspace {
  readonly kepler: ExplorationViewController;
  /** A second view on the same context, so a change can originate elsewhere. */
  readonly peer: ExplorationViewController;
}

function workspace(): Workspace {
  const context = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"] });
  return {
    kepler: context.connectView({ id: "kepler", role: "map" }),
    peer: context.connectView({ id: "panel", role: "filter" }),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("KEPLER_LINKED_STATE_MAPPINGS", () => {
  it("declares a direction and equivalence for every channel exactly once", () => {
    const channels = KEPLER_LINKED_STATE_MAPPINGS.map((mapping) => mapping.channel);

    expect(new Set(channels).size).toBe(channels.length);
    for (const mapping of KEPLER_LINKED_STATE_MAPPINGS) {
      expect(mapping.reason.length).toBeGreaterThan(20);
      if (mapping.direction === "unsupported") expect(mapping.equivalence).toBe("none");
      else expect(mapping.equivalence).not.toBe("none");
    }
  });

  it("reports hover, spatial filters, and query-shaping slices as unsupported", () => {
    for (const channel of [
      "hover",
      "spatial-filter",
      "sort",
      "pagination",
      "grouping",
      "aggregation",
      "visible-fields",
    ] as const) {
      expect(keplerLinkedStateMapping(channel).direction).toBe("unsupported");
    }
  });

  it("declares the viewport mapping lossy and dependent on the viewport size", () => {
    const viewport = keplerLinkedStateMapping("viewport");

    expect(viewport.direction).toBe("bidirectional");
    expect(viewport.equivalence).toBe("lossy");
    expect(viewport.requires).toEqual(["viewportSize"]);
  });

  it("declares the temporal window mapping exact and bidirectional", () => {
    expect(keplerLinkedStateMapping("temporal-window")).toMatchObject({
      direction: "bidirectional",
      equivalence: "exact",
    });
  });
});

describe("viewport conversion", () => {
  it("round-trips a Kepler map state through a Honua extent within rendering tolerance", () => {
    const extent = keplerMapStateToExtent(mapState(), VIEWPORT);
    const back = extentToKeplerMapState(extent, VIEWPORT);

    expect(back.longitude).toBeCloseTo(-122.4, 9);
    expect(back.latitude).toBeCloseTo(37.8, 6);
    expect(back.zoom).toBeCloseTo(11, 9);
  });

  it("produces a deterministic extent for a given map state and viewport", () => {
    expect(keplerMapStateToExtent(mapState(), VIEWPORT)).toEqual(keplerMapStateToExtent(mapState(), VIEWPORT));
  });

  it("refuses to invent a zoom without a viewport size", () => {
    expect(() =>
      extentToKeplerMapState({ xmin: -1, ymin: -1, xmax: 1, ymax: 1 }, { width: 0, height: 0 }),
    ).toThrowError(/requires a positive viewport size/);
  });

  it("carries bearing and pitch over rather than deriving them from an extent", () => {
    const derived = extentToKeplerMapState({ xmin: -1, ymin: -1, xmax: 1, ymax: 1 }, VIEWPORT, {
      bearing: 45,
      pitch: 30,
    });

    expect(derived).toMatchObject({ bearing: 45, pitch: 30 });
  });
});

describe("temporal window conversion", () => {
  const start = Date.parse("2026-07-25T10:00:00Z");
  const end = Date.parse("2026-07-25T12:00:00Z");

  it("round-trips exactly in epoch milliseconds", () => {
    const clause = temporalWindowToHonuaClause({ field: "reported_at", start, end });
    const window = honuaClauseToTemporalWindow("reported_at", clause);

    expect(window).toEqual({ field: "reported_at", start, end });
  });

  it("accepts ISO bounds from Honua and normalizes them to epoch milliseconds", () => {
    expect(
      honuaClauseToTemporalWindow("reported_at", {
        field: "reported_at",
        operator: "between",
        value: ["2026-07-25T10:00:00Z", "2026-07-25T12:00:00Z"],
      }),
    ).toEqual({ field: "reported_at", start, end });
  });

  it("reads a Kepler timeRange filter", () => {
    expect(
      keplerTimeRangeToTemporalWindow({
        id: "f",
        dataId: ["incidents"],
        name: ["reported_at"],
        type: "timeRange",
        value: [start, end],
      }),
    ).toEqual({ field: "reported_at", start, end });
  });

  it("rejects an inverted window", () => {
    expect(
      honuaClauseToTemporalWindow("reported_at", { field: "reported_at", operator: "between", value: [end, start] }),
    ).toBeUndefined();
  });
});

describe("value-filter conversion", () => {
  it("maps equality, membership, and numeric ranges", () => {
    expect(honuaClauseToKeplerFilter({ field: "status", operator: "=", value: "open" })).toMatchObject({
      supported: true,
      type: "select",
    });
    expect(honuaClauseToKeplerFilter({ field: "status", operator: "in", value: ["open", "new"] })).toMatchObject({
      supported: true,
      type: "multiSelect",
      value: ["open", "new"],
    });
    expect(honuaClauseToKeplerFilter({ field: "severity", operator: "between", value: [1, 5] })).toMatchObject({
      supported: true,
      type: "range",
      value: [1, 5],
    });
  });

  it("reports operators Kepler cannot express instead of degrading them", () => {
    for (const operator of ["like", "is-null", "is-not-null", "not-in", "!=", "<", ">"] as const) {
      const projection = honuaClauseToKeplerFilter({ field: "status", operator, value: "x" });
      expect(projection.supported).toBe(false);
      expect(projection.reason).toContain(operator);
    }
  });

  it("projects Kepler filters back onto Honua clauses", () => {
    expect(
      keplerFilterToHonuaClause({ id: "f", dataId: ["d"], name: ["status"], type: "select", value: "open" }),
    ).toEqual({
      field: "status",
      operator: "=",
      value: "open",
    });
    expect(
      keplerFilterToHonuaClause({ id: "f", dataId: ["d"], name: ["severity"], type: "range", value: [1, 5] }),
    ).toEqual({ field: "severity", operator: "between", value: [1, 5] });
  });
});

describe("keplerSelectionFilterValue", () => {
  it("keeps only the ids belonging to the projected source", () => {
    expect(
      keplerSelectionFilterValue([{ sourceId: "incidents", id: 1 }, { sourceId: "other", id: 2 }, 3], "incidents"),
    ).toEqual([1, 3]);
  });
});

describe("createKeplerLinkedStateSync", () => {
  it("applies a Kepler map move to the shared exploration extent", () => {
    const { kepler: controller } = workspace();
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      viewportSize: VIEWPORT,
      applyToKepler: () => undefined,
    });

    sync.receiveMapState(mapState());

    expect(controller.state.extent).toEqual(keplerMapStateToExtent(mapState(), VIEWPORT));
    expect(sync.appliedToHonua).toBe(1);
    sync.dispose();
  });

  it("applies a Kepler time range as a Honua between clause and pushes a Honua window back", async () => {
    const { kepler: controller, peer } = workspace();
    const updates: KeplerLinkedStateUpdate[] = [];
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      temporalField: "reported_at",
      applyToKepler: (update) => updates.push(update),
    });

    sync.receiveTimeRange([1000, 2000]);
    expect(controller.state.filters["kepler-temporal-window"]).toEqual({
      field: "reported_at",
      operator: "between",
      value: [1000, 2000],
    });

    // A different view moves the shared window; Kepler must be told.
    peer.setFilter("kepler-temporal-window", { field: "reported_at", operator: "between", value: [3000, 4000] });
    await flush();

    expect(updates).toEqual([{ kind: "time-range", field: "reported_at", value: [3000, 4000] }]);
    sync.dispose();
  });

  it("suppresses a Kepler echo of a value it was just given instead of looping", async () => {
    const { kepler: controller, peer } = workspace();
    let keplerApplications = 0;
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      temporalField: "reported_at",
      viewportSize: VIEWPORT,
      applyToKepler: (update) => {
        keplerApplications += 1;
        // A real Kepler store fires its own change callbacks after an update.
        if (update.kind === "time-range") sync.receiveTimeRange(update.value);
        if (update.kind === "map-state") sync.receiveMapState(update.mapState);
      },
    });

    peer.setFilter("kepler-temporal-window", { field: "reported_at", operator: "between", value: [10, 20] });
    peer.setExtent({ xmin: -10, ymin: -10, xmax: 10, ymax: 10 });
    await flush();
    await flush();

    expect(keplerApplications).toBe(2);
    expect(sync.suppressedEchoes).toBe(2);
    expect(sync.appliedToHonua).toBe(0);
    sync.dispose();
  });

  it("re-applies a Kepler viewport that returns to an earlier value (A -> B -> A)", () => {
    const { kepler: controller } = workspace();
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      viewportSize: VIEWPORT,
      applyToKepler: () => undefined,
    });

    const a = mapState({ zoom: 11 });
    const b = mapState({ zoom: 13 });

    // Kepler reports A, then B, then returns to A. Every step is a real user
    // move and must reach the shared extent; a retained echo marker for A would
    // drop the third step and leave Honua stuck on B.
    sync.receiveMapState(a);
    expect(controller.state.extent).toEqual(keplerMapStateToExtent(a, VIEWPORT));
    sync.receiveMapState(b);
    expect(controller.state.extent).toEqual(keplerMapStateToExtent(b, VIEWPORT));
    sync.receiveMapState(a);

    expect(controller.state.extent).toEqual(keplerMapStateToExtent(a, VIEWPORT));
    expect(sync.appliedToHonua).toBe(3);
    expect(sync.suppressedEchoes).toBe(0);
    sync.dispose();
  });

  it("re-applies a Kepler temporal window that returns to an earlier value (A -> B -> A)", () => {
    const { kepler: controller } = workspace();
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      temporalField: "reported_at",
      applyToKepler: () => undefined,
    });

    sync.receiveTimeRange([10, 20]);
    sync.receiveTimeRange([30, 40]);
    sync.receiveTimeRange([10, 20]);

    expect(controller.state.filters["kepler-temporal-window"]).toEqual({
      field: "reported_at",
      operator: "between",
      value: [10, 20],
    });
    expect(sync.appliedToHonua).toBe(3);
    expect(sync.suppressedEchoes).toBe(0);
    sync.dispose();
  });

  it("consumes an outbound echo marker once, so the same value can come back from Kepler later", async () => {
    const { kepler: controller, peer } = workspace();
    const updates: KeplerLinkedStateUpdate[] = [];
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      temporalField: "reported_at",
      applyToKepler: (update) => {
        updates.push(update);
        // Kepler echoes the value it was just handed.
        if (update.kind === "time-range") sync.receiveTimeRange(update.value);
      },
    });

    // Honua -> Kepler (A), echoed back and suppressed exactly once.
    peer.setFilter("kepler-temporal-window", { field: "reported_at", operator: "between", value: [10, 20] });
    await flush();
    expect(updates).toHaveLength(1);
    expect(sync.suppressedEchoes).toBe(1);
    expect(sync.appliedToHonua).toBe(0);

    // The user moves Kepler to B and then back to A. A is no longer a pending
    // echo, so it must be applied rather than dropped.
    sync.receiveTimeRange([30, 40]);
    sync.receiveTimeRange([10, 20]);

    expect(controller.state.filters["kepler-temporal-window"]).toEqual({
      field: "reported_at",
      operator: "between",
      value: [10, 20],
    });
    expect(sync.appliedToHonua).toBe(2);
    sync.dispose();
  });

  it("does not re-emit an identical Kepler map state", () => {
    const { kepler: controller } = workspace();
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      viewportSize: VIEWPORT,
      applyToKepler: () => undefined,
    });

    sync.receiveMapState(mapState());
    sync.receiveMapState(mapState());

    expect(sync.appliedToHonua).toBe(1);
    expect(sync.suppressedEchoes).toBe(1);
    sync.dispose();
  });

  it("maps a Kepler pick onto a source-qualified selection and clears it deterministically", () => {
    const { kepler: controller } = workspace();
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      applyToKepler: () => undefined,
    });

    sync.receiveSelection(42);
    expect(controller.state.selection).toEqual([{ sourceId: "incidents", id: 42 }]);

    sync.receiveSelection(undefined);
    expect(controller.state.selection).toEqual([]);
    sync.dispose();
  });

  it("projects a Honua selection into Kepler only as a declared-lossy identity filter", async () => {
    const { kepler: controller, peer } = workspace();
    const updates: KeplerLinkedStateUpdate[] = [];
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      selectionFilterField: "objectid",
      applyToKepler: (update) => updates.push(update),
    });

    peer.select([{ sourceId: "incidents", id: 7 }], { replace: true });
    await flush();

    expect(updates).toEqual([{ kind: "selection-filter", field: "objectid", value: [7] }]);
    expect(sync.diagnostics.some((entry) => entry.channel === "selection-as-filter" && entry.outcome === "lossy")).toBe(
      true,
    );
    sync.dispose();
  });

  it("reports the unsupported viewport mapping when no viewport size is available", () => {
    const { kepler: controller } = workspace();
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      applyToKepler: () => undefined,
    });

    sync.receiveMapState(mapState());

    expect(controller.state.extent).toBeUndefined();
    expect(sync.diagnostics).toEqual([
      {
        channel: "viewport",
        direction: "kepler-to-honua",
        outcome: "unsupported",
        detail: "No viewportSize was supplied, so a Kepler map state cannot be converted into a Honua extent.",
      },
    ]);
    sync.dispose();
  });

  it("stops applying state after dispose", () => {
    const { kepler: controller } = workspace();
    const sync = createKeplerLinkedStateSync({
      view: controller,
      sourceId: "incidents",
      viewportSize: VIEWPORT,
      applyToKepler: () => undefined,
    });

    sync.dispose();
    sync.receiveMapState(mapState());

    expect(sync.disposed).toBe(true);
    expect(controller.state.extent).toBeUndefined();
  });
});
