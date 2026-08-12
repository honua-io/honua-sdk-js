import { describe, expect, it, vi } from "vitest";

import { createExplorationContext, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import type { ExplorationViewController, FilterClause } from "@honua/sdk-js/exploration";
import type { InteractiveMap } from "@honua/sdk-js/interactions";
import {
  HONUA_INTERACTION_FANOUT_CAP,
  type HonuaInteraction,
  type HonuaInteractionComponents,
  compileHonuaInteractions,
  parseHonuaInteractionRef,
  resolveHonuaInteractionArgs,
  validateHonuaInteractions,
} from "@honua/sdk-js/interactions/declarative";

// ── Harness ───────────────────────────────────────────────────

type MockMap = InteractiveMap & {
  readonly _state: Map<string, Record<string, unknown>>;
  readonly _handlers: Map<string, Array<(...args: unknown[]) => void>>;
  _fire(event: string, layer: string, ...args: unknown[]): void;
  _handlerCount(): number;
};

function createMockMap(): MockMap {
  const state = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const key = (target: { source: string; id: string | number; sourceLayer?: string }): string =>
    `${target.source}:${target.sourceLayer ?? ""}:${target.id}`;

  return {
    _state: state,
    _handlers: handlers,
    setFeatureState(target, patch) {
      state.set(key(target), { ...(state.get(key(target)) ?? {}), ...patch });
    },
    getFeatureState(target) {
      return state.get(key(target)) ?? {};
    },
    removeFeatureState(target, removeKey?) {
      if (!removeKey) {
        state.delete(key(target));
        return;
      }
      const existing = state.get(key(target));
      if (existing) delete existing[removeKey];
    },
    on(event, layerOrHandler, handler) {
      if (typeof layerOrHandler !== "string" || !handler) return;
      const handlerKey = `${event}:${layerOrHandler}`;
      if (!handlers.has(handlerKey)) handlers.set(handlerKey, []);
      handlers.get(handlerKey)!.push(handler);
    },
    off(event, layerOrHandler, handler) {
      if (typeof layerOrHandler !== "string" || !handler) return;
      const list = handlers.get(`${event}:${layerOrHandler}`);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    _fire(event, layer, ...args) {
      for (const handler of [...(handlers.get(`${event}:${layer}`) ?? [])]) handler(...args);
    },
    _handlerCount() {
      let total = 0;
      for (const list of handlers.values()) total += list.length;
      return total;
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function harness(): {
  /** The view the compiler owns — actions write through it. */
  readonly view: ExplorationViewController;
  /** A second bound view standing in for the host's own widgets: gestures published here reach the compiler. */
  readonly host: ExplorationViewController;
  readonly map: MockMap;
  readonly components: HonuaInteractionComponents;
  readonly widgetFilters: FilterClause[];
  readonly widgetQueries: Array<Record<string, unknown>>;
  readonly viewports: unknown[];
  readonly visibility: boolean[];
  dispose(): void;
} {
  const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["parcels", "incidents"] });
  const view = ctx.connectView({ id: "interactions", role: "custom" });
  const host = ctx.connectView({ id: "host", role: "grid" });
  const map = createMockMap();
  const widgetFilters: FilterClause[] = [];
  const widgetQueries: Array<Record<string, unknown>> = [];
  const viewports: unknown[] = [];
  const visibility: boolean[] = [];

  const components: HonuaInteractionComponents = {
    map: { setViewport: (viewport) => viewports.push(viewport) },
    layers: {
      parcels: { map, sourceId: "parcels", layerId: "parcel-fill" },
      "no-map": { sourceId: "parcels" },
      hidden: { map, setVisibility: (visible) => visibility.push(visible) },
    },
    widgets: {
      "area-chart": {
        setFilter: (clause) => {
          if (clause) widgetFilters.push(clause);
        },
        runQuery: (request) => widgetQueries.push({ ...request }),
      },
      "plain-table": {},
    },
    controls: { status: {} },
  };

  return {
    view,
    host,
    map,
    components,
    widgetFilters,
    widgetQueries,
    viewports,
    visibility,
    dispose: () => ctx.dispose(),
  };
}

const SELECT_TO_FILTER: HonuaInteraction = {
  id: "select-parcel-filters-chart",
  on: { ref: "layer:parcels", event: "featureSelect" },
  do: {
    ref: "widget:area-chart",
    verb: "setFilter",
    args: { field: "parcelId", operator: "=", value: "$event.featureId" },
  },
};

// ── Contract-level validation ─────────────────────────────────

describe("declarative interaction validation", () => {
  it("parses the standard's four reference kinds and rejects malformed ones", () => {
    expect(parseHonuaInteractionRef("map")).toEqual({ kind: "map" });
    expect(parseHonuaInteractionRef("layer:parcels")).toEqual({ kind: "layer", id: "parcels" });
    expect(parseHonuaInteractionRef("widget:chart")).toEqual({ kind: "widget", id: "chart" });
    expect(parseHonuaInteractionRef("control:status")).toEqual({ kind: "control", id: "status" });
    expect(parseHonuaInteractionRef("basemap:dark")).toBeUndefined();
    expect(parseHonuaInteractionRef("layer:")).toBeUndefined();
  });

  it("rejects events and verbs outside the closed sets", () => {
    const validation = validateHonuaInteractions([
      { id: "a", on: { ref: "map", event: "featureHoverEnd" }, do: { ref: "map", verb: "setViewport" } },
      { id: "b", on: { ref: "map", event: "viewportChange" }, do: { ref: "map", verb: "setBasemap" } },
    ]);

    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(["unknown-event", "unknown-verb"]);
  });

  it("rejects duplicate ids within one block", () => {
    const validation = validateHonuaInteractions([SELECT_TO_FILTER, { ...SELECT_TO_FILTER }]);
    expect(validation.issues.map((issue) => issue.code)).toContain("duplicate-id");
  });

  it("rejects a block over the fan-out cap rather than truncating it", () => {
    const over = Array.from({ length: HONUA_INTERACTION_FANOUT_CAP + 1 }, (_unused, index) => ({
      ...SELECT_TO_FILTER,
      id: `binding-${index}`,
    }));
    const at = over.slice(0, HONUA_INTERACTION_FANOUT_CAP);

    const overResult = validateHonuaInteractions(over);
    expect(overResult.ok).toBe(false);
    const issue = overResult.issues.find((entry) => entry.code === "fan-out-exceeded");
    expect(issue?.message).toContain("(layer:parcels, featureSelect)");
    expect(issue?.message).toContain("rejected, not truncated");
    expect(validateHonuaInteractions(at).ok).toBe(true);
  });

  it("does not count disabled bindings toward the fan-out cap", () => {
    const bindings = Array.from({ length: HONUA_INTERACTION_FANOUT_CAP + 3 }, (_unused, index) => ({
      ...SELECT_TO_FILTER,
      id: `binding-${index}`,
      ...(index >= HONUA_INTERACTION_FANOUT_CAP ? { disabled: true } : {}),
    }));
    expect(validateHonuaInteractions(bindings).ok).toBe(true);
  });

  it("accepts only well-formed $event.* substitution paths — there is no expression language", () => {
    const validation = validateHonuaInteractions([
      {
        id: "expr",
        on: { ref: "map", event: "viewportChange" },
        do: { ref: "map", verb: "setViewport", args: { zoom: "$event.zoom + 1", ok: "$event.bbox" } },
      },
    ]);
    expect(validation.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["invalid-event-path", "interactions[0].do.args.zoom"],
    ]);
  });

  it("substitutes $event.* paths, including nested and array positions, and leaves static JSON alone", () => {
    const resolved = resolveHonuaInteractionArgs(
      {
        literal: "parcelId",
        value: "$event.featureId",
        missing: "$event.nope.deeper",
        nested: { list: ["$event.targets.0.sourceId", 7] },
      },
      { featureId: 101, targets: [{ sourceId: "parcels" }] },
    );

    expect(resolved).toEqual({
      literal: "parcelId",
      value: 101,
      missing: undefined,
      nested: { list: ["parcels", 7] },
    });
  });
});

// ── Compilation ───────────────────────────────────────────────

describe("compileHonuaInteractions", () => {
  it("binds nothing when the block fails validation", () => {
    const h = harness();
    const compiled = compileHonuaInteractions([SELECT_TO_FILTER, { ...SELECT_TO_FILTER }], {
      view: h.view,
      components: h.components,
    });

    expect(compiled.ok).toBe(false);
    expect(compiled.bindings).toEqual([]);
    expect(h.map._handlerCount()).toBe(0);
    h.dispose();
  });

  it("rejects a ref that does not resolve to a declared component", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [{ ...SELECT_TO_FILTER, do: { ref: "widget:absent", verb: "setFilter" } }],
      { view: h.view, components: h.components },
    );

    expect(compiled.ok).toBe(false);
    expect(compiled.issues[0]).toMatchObject({ code: "invalid-ref", path: "interactions[0].do.ref" });
    h.dispose();
  });

  it("compiles featureSelect onto the selection primitive and dispatches setFilter with the substituted id", () => {
    const h = harness();
    const compiled = compileHonuaInteractions([SELECT_TO_FILTER], { view: h.view, components: h.components });

    expect(compiled.ok).toBe(true);
    expect(compiled.bindings).toHaveLength(1);
    expect(compiled.bindings[0]?.pair).toBe("featureSelect -> setFilter");

    h.map._fire("click", "parcel-fill", { features: [{ id: 101 }] });

    expect(h.widgetFilters).toEqual([{ field: "parcelId", operator: "=", value: 101 }]);
    compiled.dispose();
    h.dispose();
  });

  it("falls back to the shared exploration filter when the target declares no setFilter", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [{ ...SELECT_TO_FILTER, id: "to-plain-table", do: { ...SELECT_TO_FILTER.do, ref: "widget:plain-table" } }],
      { view: h.view, components: h.components },
    );

    h.map._fire("click", "parcel-fill", { features: [{ id: 7 }] });

    expect(compiled.ok).toBe(true);
    expect(h.view.state.filters["plain-table"]).toEqual({ field: "parcelId", operator: "=", value: 7 });
    compiled.dispose();
    h.dispose();
  });

  it("compiles featureHover onto the hover primitive", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        {
          id: "hover-runs-query",
          on: { ref: "layer:parcels", event: "featureHover" },
          do: { ref: "widget:area-chart", verb: "runWidgetQuery", args: { kind: "count", id: "$event.featureId" } },
        },
      ],
      { view: h.view, components: h.components },
    );

    h.map._fire("mousemove", "parcel-fill", { features: [{ id: 55 }] });
    h.map._fire("mousemove", "parcel-fill", { features: [{ id: 55 }] });

    expect(compiled.ok).toBe(true);
    // Feature-state is idempotent per pointer sample; the binding fires once
    // per hovered feature.
    expect(h.widgetQueries).toEqual([{ kind: "count", id: 55 }]);
    compiled.dispose();
    h.dispose();
  });

  it("compiles a control change onto the filter-control primitive", async () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        {
          id: "status-moves-map",
          on: { ref: "control:status", event: "change" },
          do: { ref: "map", verb: "setViewport", args: { zoom: 9 } },
        },
      ],
      { view: h.view, components: h.components },
    );

    h.host.setFilter("status", { field: "status", operator: "=", value: "open" });
    await flush();

    expect(compiled.ok).toBe(true);
    expect(h.viewports).toEqual([{ zoom: 9 }]);
    compiled.dispose();
    h.dispose();
  });

  it("compiles map viewportChange onto the shared extent slice", async () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        {
          id: "extent-filters-chart",
          on: { ref: "map", event: "viewportChange" },
          do: { ref: "widget:area-chart", verb: "setFilter", args: { field: "bbox", value: "$event.bbox" } },
        },
      ],
      { view: h.view, components: h.components },
    );

    h.host.setExtent({ xmin: 0, ymin: 1, xmax: 2, ymax: 3 });
    await flush();

    expect(compiled.ok).toBe(true);
    expect(h.widgetFilters).toEqual([{ field: "bbox", operator: "=", value: [0, 1, 2, 3] }]);
    compiled.dispose();
    h.dispose();
  });

  it("compiles setVisibility and selectFeature", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        {
          id: "hover-hides-layer",
          on: { ref: "layer:parcels", event: "featureHover" },
          do: { ref: "layer:hidden", verb: "setVisibility", args: { visible: false } },
        },
        {
          id: "hover-selects",
          on: { ref: "layer:parcels", event: "featureHover" },
          do: { ref: "layer:parcels", verb: "selectFeature", args: { featureId: "$event.featureId" } },
        },
      ],
      { view: h.view, components: h.components },
    );

    h.map._fire("mousemove", "parcel-fill", { features: [{ id: 12 }] });

    expect(compiled.ok).toBe(true);
    expect(h.visibility).toEqual([false]);
    expect(h.view.state.selection).toEqual([sourceFeatureSelectionTarget("parcels", 12)]);
    compiled.dispose();
    h.dispose();
  });

  it("skips disabled bindings without binding them", () => {
    const h = harness();
    const compiled = compileHonuaInteractions([{ ...SELECT_TO_FILTER, disabled: true }], {
      view: h.view,
      components: h.components,
    });

    h.map._fire("click", "parcel-fill", { features: [{ id: 101 }] });

    expect(compiled.disabled).toEqual([SELECT_TO_FILTER.id]);
    expect(compiled.bindings).toEqual([]);
    expect(h.widgetFilters).toEqual([]);
    h.dispose();
  });
});

// ── Unsupported pairs ─────────────────────────────────────────

describe("unsupported (on, do) pairs", () => {
  it("names the pair for an event the source kind cannot emit", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        {
          id: "layer-cannot-viewport",
          on: { ref: "layer:parcels", event: "viewportChange" },
          do: { ref: "map", verb: "setViewport" },
        },
        {
          id: "widget-cannot-feature-select",
          on: { ref: "widget:area-chart", event: "featureSelect" },
          do: { ref: "map", verb: "setViewport" },
        },
      ],
      { view: h.view, components: h.components },
    );

    expect(compiled.ok).toBe(false);
    expect(compiled.bindings).toEqual([]);
    expect(compiled.unsupported.map((entry) => [entry.interactionId, entry.pair])).toEqual([
      ["layer-cannot-viewport", "viewportChange -> setViewport"],
      ["widget-cannot-feature-select", "featureSelect -> setViewport"],
    ]);
    expect(compiled.unsupported[0]?.reason).toContain("only `map` publishes it");
    h.dispose();
  });

  it("names the pair when a layer has no map to bind the event to", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [{ ...SELECT_TO_FILTER, id: "no-map", on: { ref: "layer:no-map", event: "featureSelect" } }],
      { view: h.view, components: h.components },
    );

    expect(compiled.unsupported[0]).toMatchObject({
      interactionId: "no-map",
      pair: "featureSelect -> setFilter",
    });
    expect(compiled.unsupported[0]?.reason).toContain("declares no `map`");
    h.dispose();
  });

  it("names the pair when the verb has no primitive on the target — never silently drops it", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        {
          id: "no-run-query",
          on: { ref: "layer:parcels", event: "featureSelect" },
          do: { ref: "widget:plain-table", verb: "runWidgetQuery" },
        },
        {
          id: "no-visibility",
          on: { ref: "layer:parcels", event: "featureSelect" },
          do: { ref: "widget:plain-table", verb: "setVisibility" },
        },
        {
          id: "map-visibility",
          on: { ref: "layer:parcels", event: "featureSelect" },
          do: { ref: "map", verb: "setVisibility" },
        },
      ],
      { view: h.view, components: h.components },
    );

    expect(compiled.ok).toBe(false);
    expect(compiled.unsupported).toHaveLength(3);
    expect(compiled.unsupported[0]?.reason).toContain("no exploration-level fallback");
    expect(compiled.unsupported[1]?.reason).toContain("declares no `setVisibility`");
    expect(compiled.unsupported[2]?.reason).toContain("never `map`");
    h.dispose();
  });

  it("compiles the supported bindings in a block that also has unsupported ones", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [SELECT_TO_FILTER, { ...SELECT_TO_FILTER, id: "bad", do: { ref: "widget:plain-table", verb: "runWidgetQuery" } }],
      { view: h.view, components: h.components },
    );

    h.map._fire("click", "parcel-fill", { features: [{ id: 4 }] });

    expect(compiled.ok).toBe(false);
    expect(compiled.bindings.map((binding) => binding.interactionId)).toEqual([SELECT_TO_FILTER.id]);
    expect(compiled.unsupported.map((entry) => entry.interactionId)).toEqual(["bad"]);
    expect(h.widgetFilters).toHaveLength(1);
    compiled.dispose();
    h.dispose();
  });
});

// ── Actions never emit events ─────────────────────────────────

describe("actions never emit events", () => {
  it("does not let a selectFeature action re-trigger a selection-sourced binding", async () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        {
          // A binding whose event source is widget selection and whose action
          // writes selection: the cascade a naive dispatcher would loop on.
          id: "selection-selects",
          on: { ref: "widget:plain-table", event: "selection" },
          do: { ref: "layer:parcels", verb: "selectFeature", args: { featureId: 999 } },
        },
      ],
      { view: h.view, components: h.components },
    );
    const dispatches: string[] = [];
    const observed = compileHonuaInteractions(
      [
        {
          id: "selection-runs-query",
          on: { ref: "widget:plain-table", event: "selection" },
          do: { ref: "widget:area-chart", verb: "runWidgetQuery", args: { kind: "count" } },
        },
      ],
      {
        view: h.view,
        components: h.components,
        onDispatch: (dispatch) => dispatches.push(dispatch.interactionId),
      },
    );

    expect(compiled.ok).toBe(true);
    expect(observed.ok).toBe(true);

    // One genuine user gesture through a different view.
    h.host.select([sourceFeatureSelectionTarget("parcels", 1)], { replace: true });
    await flush();
    await flush();

    // The action-driven selection change never re-enters either dispatcher:
    // the observed binding sees exactly the one user gesture.
    expect(dispatches).toEqual(["selection-runs-query"]);
    expect(h.view.state.selection).toEqual([sourceFeatureSelectionTarget("parcels", 999)]);
    compiled.dispose();
    observed.dispose();
    h.dispose();
  });

  it("drops an event delivered synchronously while an action is in flight", () => {
    const h = harness();
    const reentrant = vi.fn();
    const components: HonuaInteractionComponents = {
      ...h.components,
      widgets: {
        ...h.components.widgets,
        "area-chart": {
          runQuery: (request) => {
            reentrant(request);
            // A misbehaving component that fires the source event from inside
            // the action. The guard must swallow the re-entry.
            h.map._fire("click", "parcel-fill", { features: [{ id: 2 }] });
          },
        },
      },
    };
    const compiled = compileHonuaInteractions(
      [
        {
          id: "reentrant",
          on: { ref: "layer:parcels", event: "featureSelect" },
          do: { ref: "widget:area-chart", verb: "runWidgetQuery", args: { kind: "count" } },
        },
      ],
      { view: h.view, components },
    );

    h.map._fire("click", "parcel-fill", { features: [{ id: 1 }] });

    expect(compiled.ok).toBe(true);
    expect(reentrant).toHaveBeenCalledTimes(1);
    compiled.dispose();
    h.dispose();
  });
});

// ── Disposal ──────────────────────────────────────────────────

describe("disposal", () => {
  it("releases every map handler and stops dispatching", () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        SELECT_TO_FILTER,
        {
          id: "hover-query",
          on: { ref: "layer:parcels", event: "featureHover" },
          do: { ref: "widget:area-chart", verb: "runWidgetQuery", args: { kind: "count" } },
        },
      ],
      { view: h.view, components: h.components },
    );

    expect(h.map._handlerCount()).toBeGreaterThan(0);
    compiled.dispose();
    expect(h.map._handlerCount()).toBe(0);

    h.map._fire("click", "parcel-fill", { features: [{ id: 3 }] });
    expect(h.widgetFilters).toEqual([]);
    expect(h.widgetQueries).toEqual([]);
    h.dispose();
  });

  it("is idempotent, per binding and per block", () => {
    const h = harness();
    const compiled = compileHonuaInteractions([SELECT_TO_FILTER], { view: h.view, components: h.components });

    compiled.bindings[0]?.dispose();
    compiled.bindings[0]?.dispose();
    compiled.dispose();
    compiled.dispose();

    expect(h.map._handlerCount()).toBe(0);
    h.dispose();
  });

  it("stops exploration-backed bindings on dispose", async () => {
    const h = harness();
    const compiled = compileHonuaInteractions(
      [
        {
          id: "extent-query",
          on: { ref: "map", event: "viewportChange" },
          do: { ref: "widget:area-chart", verb: "runWidgetQuery", args: { kind: "count" } },
        },
      ],
      { view: h.view, components: h.components },
    );

    compiled.dispose();
    h.host.setExtent({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    await flush();

    expect(h.widgetQueries).toEqual([]);
    h.dispose();
  });
});
