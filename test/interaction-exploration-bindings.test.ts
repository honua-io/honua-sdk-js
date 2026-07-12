import { describe, expect, it, vi } from "vitest";

import { createExplorationContext, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";
import {
  bindChartToExploration,
  bindDetailToSelection,
  bindFilterControlsToExploration,
  bindMapExtentToExploration,
  bindMapSelectionToExploration,
  bindQueryProjectionToExploration,
  bindTableSelectionToExploration,
  syncFeatureStateSelection,
  syncMapLayerFilterToExploration,
} from "@honua/sdk-js/interactions";
import type { FeatureStateMap, InteractiveMap } from "@honua/sdk-js/interactions";

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

  it("links map extent changes to table query projections", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents"], preset: "mapDriven" });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const extents: Array<{ listener: (extent: HonuaExtent | undefined) => void }> = [];
    const projections: Array<unknown> = [];

    bindQueryProjectionToExploration(tableView, (projection) => projections.push(projection), {
      applyInitial: false,
    });
    bindMapExtentToExploration(
      mapView,
      {
        subscribe(listener) {
          extents.push({ listener });
          return () => {};
        },
      },
      { coalesce: false },
    );

    extents[0].listener({ xmin: 1, ymin: 2, xmax: 3, ymax: 4 });
    await flush();

    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      extent: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 },
      spatialFilter: {
        geometry: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
    });
    ctx.dispose();
  });

  it("links filter controls to map layer filters through a query projection", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents"], preset: "mapDriven" });
    const filterView = ctx.connectView({ id: "filters", role: "filter" });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const filterControls = bindFilterControlsToExploration(filterView);
    const setFilter = vi.fn();

    syncMapLayerFilterToExploration({ setFilter }, mapView, {
      layerId: "incident-points",
      applyInitial: false,
      translate(projection) {
        return ["==", ["get", "STATUS"], projection.filters.status.value];
      },
    });

    filterControls.setFilter("status", { field: "STATUS", operator: "=", value: "open" });
    await flush();

    expect(setFilter).toHaveBeenCalledWith("incident-points", ["==", ["get", "STATUS"], "open"]);
    ctx.dispose();
  });

  it("lets chart bucket selection drive shared selection under chartDriven", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents"], preset: "chartDriven" });
    const chartView = ctx.connectView({ id: "chart", role: "chart" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const chart = bindChartToExploration(chartView);
    const target = sourceFeatureSelectionTarget("incidents", 9);
    const tableEvents: Array<ReadonlyArray<unknown>> = [];
    tableView.subscribe("selection", (event) => tableEvents.push(event.state.selection));

    chart.selectBucket({
      targets: [target],
      filters: {
        severity: { field: "SEVERITY", operator: "=", value: "high" },
      },
    });
    await flush();

    expect(ctx.state.filters.severity).toEqual({ field: "SEVERITY", operator: "=", value: "high" });
    expect(tableEvents).toEqual([[target]]);
    ctx.dispose();
  });

  it("keeps linked adapters quiet in decoupled mode while central state still moves", async () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents"], preset: "decoupled" });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const projections: Array<unknown> = [];
    bindQueryProjectionToExploration(tableView, (projection) => projections.push(projection), {
      applyInitial: false,
    });

    mapView.setExtent({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    await flush();

    expect(ctx.state.extent).toEqual({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    expect(projections).toEqual([]);
    ctx.dispose();
  });
});
