import { describe, expect, it, vi } from "vitest";

import {
  bindChartToExploration,
  bindDetailToSelection,
  bindFilterControlsToExploration,
  bindMapExtentToExploration,
  bindQueryProjectionToExploration,
  bindTableSelectionToExploration,
  createExplorationContext,
  sourceFeatureSelectionTarget,
  syncMapLayerFilterToExploration,
} from "../src/index.js";
import type { HonuaExtent, LinkedViewQueryProjection, MapLayerFilterTarget } from "../src/index.js";
import {
  emptyRealtimeFeatureState,
  reconcileRealtimeSelection,
  reconcileRealtimeStaleness,
  reduceRealtimeFeatureState,
} from "../src/realtime/index.js";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeExtentHost {
  #extent: HonuaExtent | undefined;
  #listeners = new Set<(extent: HonuaExtent | undefined) => void>();

  current(): HonuaExtent | undefined {
    return this.#extent;
  }

  subscribe(listener: (extent: HonuaExtent | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  moveTo(extent: HonuaExtent | undefined): void {
    this.#extent = extent;
    for (const listener of [...this.#listeners]) listener(extent);
  }
}

class FakeQueryHost {
  readonly queries: LinkedViewQueryProjection[] = [];

  apply(projection: LinkedViewQueryProjection): void {
    this.queries.push(projection);
  }
}

class FakeLayerFilterHost implements MapLayerFilterTarget {
  readonly filters: Array<{ layerId: string; filter: unknown }> = [];

  setFilter(layerId: string, filter: unknown): void {
    this.filters.push({ layerId, filter });
  }
}

describe("optional linked-view context sync layer", () => {
  it("projects map extent changes into table and chart queries without peer coupling", async () => {
    const ctx = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"], preset: "mapDriven" });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const chartView = ctx.connectView({ id: "chart", role: "chart" });
    const extentHost = new FakeExtentHost();
    const table = new FakeQueryHost();
    const chart = new FakeQueryHost();

    bindMapExtentToExploration(mapView, extentHost, { coalesce: false });
    bindQueryProjectionToExploration(tableView, (projection) => table.apply(projection), { applyInitial: false });
    bindChartToExploration(chartView).subscribeQuery((projection) => chart.apply(projection), { applyInitial: false });

    extentHost.moveTo({ xmin: -157.9, ymin: 21.2, xmax: -157.7, ymax: 21.4, spatialReference: { wkid: 4326 } });
    await flush();

    expect(table.queries).toHaveLength(1);
    expect(chart.queries).toHaveLength(1);
    expect(table.queries[0]).toMatchObject({
      extent: { xmin: -157.9, ymin: 21.2, xmax: -157.7, ymax: 21.4, spatialReference: { wkid: 4326 } },
      spatialFilter: {
        geometry: { xmin: -157.9, ymin: 21.2, xmax: -157.7, ymax: 21.4, spatialReference: { wkid: 4326 } },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
    });
    expect(chart.queries[0].spatialFilter).toEqual(table.queries[0].spatialFilter);
    ctx.dispose();
  });

  it("projects filter controls into map layer filters through a shared selector", async () => {
    const ctx = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"], preset: "mapDriven" });
    const filterView = ctx.connectView({ id: "filters", role: "filter" });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const controls = bindFilterControlsToExploration(filterView);
    const map = new FakeLayerFilterHost();

    syncMapLayerFilterToExploration(map, mapView, {
      layerId: "incident-points",
      applyInitial: false,
      sourceId: "incidents",
      translate(projection) {
        return [
          "all",
          ...Object.values(projection.filters).map((clause) => ["==", ["get", clause.field], clause.value]),
        ];
      },
    });

    controls.setFilter("status", { field: "STATUS", operator: "=", value: "open", appliesTo: ["incidents"] });
    await flush();

    expect(map.filters).toEqual([{ layerId: "incident-points", filter: ["all", ["==", ["get", "STATUS"], "open"]] }]);
    ctx.dispose();
  });

  it("shares chart bucket selection and filters with map, table, and detail subscribers", async () => {
    const ctx = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"], preset: "chartDriven" });
    const chartView = ctx.connectView({ id: "chart", role: "chart" });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const detailView = ctx.connectView({ id: "detail", role: "detail" });
    const chart = bindChartToExploration(chartView);
    const target = sourceFeatureSelectionTarget("incidents", "INC-101");
    const mapSelections: unknown[] = [];
    const tableFilters: unknown[] = [];
    const detail = vi.fn();

    mapView.subscribe("selection", (event) => mapSelections.push(event.state.selection));
    tableView.subscribe("filters", (event) => tableFilters.push(event.state.filters));
    bindDetailToSelection(detailView, detail);

    chart.selectBucket({
      targets: [target],
      filters: {
        severity: { field: "SEVERITY", operator: "=", value: "high", appliesTo: ["incidents"] },
      },
    });
    await flush();

    expect(ctx.state.selection).toEqual([target]);
    expect(ctx.state.filters.severity).toEqual({
      field: "SEVERITY",
      operator: "=",
      value: "high",
      appliesTo: ["incidents"],
    });
    expect(mapSelections).toEqual([[target]]);
    expect(tableFilters).toEqual([
      { severity: { field: "SEVERITY", operator: "=", value: "high", appliesTo: ["incidents"] } },
    ]);
    expect(detail).toHaveBeenCalledWith([target], expect.objectContaining({ selfOrigin: false }));
    ctx.dispose();
  });

  it("clears shared selection through table controls and updates detail panels", async () => {
    const ctx = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"], preset: "globalLinked" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const detailView = ctx.connectView({ id: "detail", role: "detail" });
    const table = bindTableSelectionToExploration(tableView);
    const detail = vi.fn();
    const target = sourceFeatureSelectionTarget("incidents", 7);

    bindDetailToSelection(detailView, detail);
    table.select([target], { replace: true });
    await flush();
    table.clearSelection();
    await flush();

    expect(ctx.state.selection).toEqual([]);
    expect(detail).toHaveBeenLastCalledWith([], expect.objectContaining({ selfOrigin: false }));
    ctx.dispose();
  });

  it("reconciles stale realtime tombstones out of shared selection", async () => {
    const ctx = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"], preset: "globalLinked" });
    const realtimeView = ctx.connectView({ id: "realtime", role: "custom" });
    const detailView = ctx.connectView({ id: "detail", role: "detail" });
    const detail = vi.fn();
    const deleted = sourceFeatureSelectionTarget("incidents", "INC-7");
    const live = sourceFeatureSelectionTarget("incidents", "INC-8");
    let state = reduceRealtimeFeatureState(emptyRealtimeFeatureState<{ status: string }>(), {
      type: "snapshot",
      receivedAt: 1_000,
      features: [
        { sourceId: "incidents", id: "INC-7", feature: { status: "open" } },
        { sourceId: "incidents", id: "INC-8", feature: { status: "open" } },
      ],
    });

    bindDetailToSelection(detailView, detail);
    realtimeView.select([deleted, live], { replace: true });
    await flush();

    state = reduceRealtimeFeatureState(state, {
      type: "delete",
      sourceId: "incidents",
      id: "INC-7",
      receivedAt: 1_100,
    });
    state = reconcileRealtimeStaleness(state, { staleAfterMs: 50, now: 1_200 });
    reconcileRealtimeSelection(realtimeView, state);
    await flush();

    expect(state.status).toBe("stale");
    expect(state.tombstones["incidents:INC-7"]).toBeDefined();
    expect(ctx.state.selection).toEqual([live]);
    expect(detail).toHaveBeenLastCalledWith([live], expect.objectContaining({ selfOrigin: false }));
    ctx.dispose();
  });

  it("keeps peer slice subscribers quiet in decoupled mode while central state stays serializable", async () => {
    const ctx = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"], preset: "decoupled" });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });
    const table = new FakeQueryHost();

    bindQueryProjectionToExploration(tableView, (projection) => table.apply(projection), { applyInitial: false });

    mapView.setExtent({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    await flush();

    expect(table.queries).toEqual([]);
    expect(ctx.state.extent).toEqual({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    expect(JSON.parse(JSON.stringify(ctx.snapshot()))).toMatchObject({
      version: 1,
      state: {
        preset: "decoupled",
        extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
    });
    ctx.dispose();
  });
});
