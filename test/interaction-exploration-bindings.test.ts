import { describe, expect, it, vi } from "vitest";

import {
  bindDetailToSelection,
  bindMapSelectionToExploration,
  bindTableSelectionToExploration,
  createExplorationContext,
  sourceFeatureSelectionTarget,
  syncFeatureStateSelection,
} from "../src/index.js";
import type { FeatureStateMap, InteractiveMap } from "../src/index.js";

function createMockMap(): InteractiveMap & {
  readonly _state: Map<string, Record<string, unknown>>;
  readonly _handlers: Map<string, Array<(...args: unknown[]) => void>>;
  _fire(event: string, layer: string, ...args: unknown[]): void;
} {
  const state = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  function key(target: { source: string; id: string | number; sourceLayer?: string }): string {
    return `${target.source}:${target.sourceLayer ?? ""}:${target.id}`;
  }

  return {
    _state: state,
    _handlers: handlers,
    setFeatureState(target, patch) {
      const targetKey = key(target);
      state.set(targetKey, { ...(state.get(targetKey) ?? {}), ...patch });
    },
    getFeatureState(target) {
      return state.get(key(target)) ?? {};
    },
    removeFeatureState(target, removeKey?) {
      const targetKey = key(target);
      if (!removeKey) {
        state.delete(targetKey);
        return;
      }
      const existing = state.get(targetKey);
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
      const handlerKey = `${event}:${layerOrHandler}`;
      const list = handlers.get(handlerKey);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    _fire(event, layer, ...args) {
      for (const handler of handlers.get(`${event}:${layer}`) ?? []) {
        handler(...args);
      }
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("interaction exploration bindings", () => {
  it("publishes map selection as source-qualified exploration selection", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["parcels"] });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const map = createMockMap();
    const tableEvents: Array<ReadonlyArray<unknown>> = [];
    tableView.subscribe("selection", (event) => tableEvents.push(event.state.selection));

    bindMapSelectionToExploration(map, mapView, {
      source: "parcels",
      sourceLayer: "parcel-fill",
      layer: "parcel-fill",
    });
    map._fire("click", "parcel-fill", { features: [{ id: 101 }] });
    await flush();

    expect(ctx.state.selection).toEqual([sourceFeatureSelectionTarget("parcels", 101, { sourceLayer: "parcel-fill" })]);
    expect(tableEvents).toEqual([[sourceFeatureSelectionTarget("parcels", 101, { sourceLayer: "parcel-fill" })]]);
    ctx.dispose();
  });

  it("reflects table selection into map feature-state without cross-source collisions", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["parcels", "assets"] });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const map = createMockMap();
    syncFeatureStateSelection(map as FeatureStateMap, mapView, {
      source: "parcels",
      sourceLayer: "parcel-fill",
    });

    tableView.select(
      [
        sourceFeatureSelectionTarget("parcels", 101, { sourceLayer: "parcel-fill" }),
        sourceFeatureSelectionTarget("assets", 101),
      ],
      { replace: true },
    );
    await flush();

    expect(map._state.get("parcels:parcel-fill:101")).toEqual({ selected: true });
    expect(map._state.has("assets::101")).toBe(false);

    tableView.select([sourceFeatureSelectionTarget("assets", 101)], { replace: true });
    await flush();

    expect(map._state.get("parcels:parcel-fill:101")).toEqual({ selected: false });
    expect(map._state.has("assets::101")).toBe(false);
    ctx.dispose();
  });

  it("binds table and detail adapters to the shared selection slice", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["parcels"] });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const detailView = ctx.connectView({ id: "detail", role: "form" });
    const table = bindTableSelectionToExploration(tableView);
    const detailListener = vi.fn();
    const tableListener = vi.fn();
    bindDetailToSelection(detailView, detailListener);
    table.subscribe(tableListener);

    const target = sourceFeatureSelectionTarget("parcels", 7);
    table.select([target], { replace: true });
    await flush();

    expect(detailListener).toHaveBeenCalledWith([target], expect.objectContaining({ selfOrigin: false }));
    expect(tableListener).not.toHaveBeenCalled();

    table.clearSelection();
    await flush();

    expect(detailListener).toHaveBeenLastCalledWith([], expect.objectContaining({ selfOrigin: false }));
    ctx.dispose();
  });
});
