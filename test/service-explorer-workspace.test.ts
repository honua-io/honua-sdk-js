import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixtureServiceExplorerDataset } from "../examples/service-explorer/src/data.js";
import {
  beginServiceExplorerMetadataRevalidation,
  completeServiceExplorerMetadataRevalidation,
  createServiceExplorerWorkspace,
} from "../examples/service-explorer/src/explorer-workspace.js";
import { createDebouncedMapExtentSource } from "../examples/service-explorer/src/map-adapter.js";
import { applyServiceExplorerProjection } from "../examples/service-explorer/src/projection.js";
import {
  bindMapExtentToExploration,
  bindQueryProjectionToExploration,
  selectHonuaAppWorkspaceChartModel,
  selectHonuaAppWorkspaceDetailModel,
  selectHonuaAppWorkspaceMetadataCacheModel,
  sourceFeatureSelectionTarget,
} from "../src/index.js";
import type { HonuaExtent, LinkedViewQueryProjection } from "../src/index.js";

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

  moveTo(extent: HonuaExtent): void {
    this.#extent = extent;
    for (const listener of [...this.#listeners]) listener(extent);
  }
}

class FakeBounds {
  public constructor(
    private readonly west: number,
    private readonly south: number,
    private readonly east: number,
    private readonly north: number,
  ) {}

  getWest(): number {
    return this.west;
  }

  getEast(): number {
    return this.east;
  }

  getSouth(): number {
    return this.south;
  }

  getNorth(): number {
    return this.north;
  }
}

class FakeMoveMap {
  #bounds = new FakeBounds(-1, -1, 1, 1);
  #listeners = new Set<() => void>();

  getBounds(): FakeBounds {
    return this.#bounds;
  }

  on(_type: "move" | "moveend", listener: () => void): void {
    this.#listeners.add(listener);
  }

  off(_type: "move" | "moveend", listener: () => void): void {
    this.#listeners.delete(listener);
  }

  move(bounds: FakeBounds): void {
    this.#bounds = bounds;
    for (const listener of [...this.#listeners]) listener();
  }
}

describe("service explorer workspace", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("links map extent and filters into table projection and shared detail state", async () => {
    const dataset = createFixtureServiceExplorerDataset({ now: 1_000 });
    const explorer = createServiceExplorerWorkspace(dataset, { now: 1_000 });
    const extentHost = new FakeExtentHost();
    const projections: LinkedViewQueryProjection[] = [];

    const extentBinding = bindMapExtentToExploration(explorer.views.map, extentHost, {
      coalesce: false,
      publishSpatialFilter: true,
    });
    const unsubscribeProjection = bindQueryProjectionToExploration(
      explorer.views.table,
      (projection) => projections.push(projection),
      { applyInitial: false, sourceId: dataset.sourceId },
    );

    explorer.controllers.filters.setFilter("status", {
      field: "status",
      operator: "=",
      value: "open",
      appliesTo: [dataset.sourceId],
    });
    extentHost.moveTo({
      xmin: -157.89,
      ymin: 21.3,
      xmax: -157.84,
      ymax: 21.32,
      spatialReference: { wkid: 4326 },
    });
    await flush();

    const projection = projections.at(-1);
    expect(projection?.filters.status?.value).toBe("open");
    expect(projection?.spatialFilter?.geometry).toEqual(projection?.extent);

    const result = applyServiceExplorerProjection(dataset.featureSummaries, projection as LinkedViewQueryProjection, {
      sourceId: dataset.sourceId,
    });
    expect(result.rows.map((row) => row.id)).toEqual(["1001", "1003"]);

    explorer.controllers.table.select([sourceFeatureSelectionTarget(dataset.sourceId, result.rows[0]?.id ?? "")], {
      replace: true,
    });
    await flush();

    const detail = selectHonuaAppWorkspaceDetailModel(explorer.workspace.state);
    expect(detail.selectedRecords[0]?.feature.id).toBe("1001");
    expect(
      selectHonuaAppWorkspaceMetadataCacheModel(explorer.workspace.state).ready[0]?.metadata?.capabilities,
    ).toMatchObject({
      statistics: "degraded",
      attachments: "unsupported",
    });

    unsubscribeProjection();
    extentBinding.remove();
    explorer.dispose();
  });

  it("lets chart bucket selection drive filters and selection through the shared workspace", async () => {
    const dataset = createFixtureServiceExplorerDataset({ now: 2_000 });
    const explorer = createServiceExplorerWorkspace(dataset, { now: 2_000 });
    const target = sourceFeatureSelectionTarget(dataset.sourceId, "1001");

    explorer.controllers.chart.selectBucket({
      targets: [target],
      filters: {
        priority: { field: "priority", operator: "=", value: "high", appliesTo: [dataset.sourceId] },
      },
    });
    await flush();

    const chart = selectHonuaAppWorkspaceChartModel(explorer.workspace.state, { sourceId: dataset.sourceId });
    expect(chart.query.filters.priority?.value).toBe("high");
    expect(selectHonuaAppWorkspaceDetailModel(explorer.workspace.state).selectedRecords[0]?.feature.id).toBe("1001");

    explorer.dispose();
  });

  it("surfaces metadata cache revalidation states in the app workspace", () => {
    const dataset = createFixtureServiceExplorerDataset({ now: 3_000 });
    const explorer = createServiceExplorerWorkspace(dataset, { now: 3_000 });

    beginServiceExplorerMetadataRevalidation(explorer.workspace, dataset, { now: 4_000 });
    expect(selectHonuaAppWorkspaceMetadataCacheModel(explorer.workspace.state).loading[0]?.sourceId).toBe(
      dataset.sourceId,
    );

    completeServiceExplorerMetadataRevalidation(explorer.workspace, dataset, { now: 5_000, status: "stale" });
    const cache = selectHonuaAppWorkspaceMetadataCacheModel(explorer.workspace.state);
    expect(cache.stale[0]?.metadata?.cache).toMatchObject({
      status: "stale",
      updatedAt: 5_000,
    });

    explorer.dispose();
  });

  it("debounces high-frequency map movement before publishing extent", () => {
    vi.useFakeTimers();
    const map = new FakeMoveMap();
    const source = createDebouncedMapExtentSource(map, { debounceMs: 100 });
    const extents: HonuaExtent[] = [];
    const unsubscribe = source.subscribe((extent) => {
      if (extent) extents.push(extent);
    });

    map.move(new FakeBounds(-10, -9, -8, -7));
    map.move(new FakeBounds(-5, -4, -3, -2));
    vi.advanceTimersByTime(99);
    expect(extents).toEqual([]);

    map.move(new FakeBounds(1, 2, 3, 4));
    vi.advanceTimersByTime(100);

    expect(extents).toEqual([{ xmin: 1, ymin: 2, xmax: 3, ymax: 4, spatialReference: { wkid: 4326 } }]);
    if (typeof unsubscribe === "function") {
      unsubscribe();
    } else {
      unsubscribe.remove();
    }
  });
});
