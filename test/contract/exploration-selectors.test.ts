import { describe, expect, it } from "vitest";

import {
  EMPTY_STATE,
  createExplorationContext,
  extentToSpatialFilter,
  selectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget,
  subscribeExplorationSelector,
} from "../../src/exploration/index.js";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("exploration / linked-view selectors", () => {
  it("projects extent, filters, sorting, paging, fields, aggregation, and selection into a query model", () => {
    const target = sourceFeatureSelectionTarget("incidents", 101);
    const projection = selectLinkedViewQueryProjection({
      ...EMPTY_STATE,
      filters: {
        global: { field: "STATUS", operator: "=", value: "open" },
        incidentsOnly: { field: "TYPE", operator: "=", value: "fire", appliesTo: ["incidents"] },
        assetsOnly: { field: "TYPE", operator: "=", value: "hydrant", appliesTo: ["assets"] },
      },
      extent: { xmin: -1, ymin: -2, xmax: 3, ymax: 4 },
      selection: [target],
      sort: [{ field: "SEVERITY", direction: "desc" }],
      page: { offset: 20, limit: 10 },
      visibleFields: ["STATUS", "SEVERITY"],
      grouping: ["STATUS"],
      aggregation: { groupBy: ["STATUS"], metrics: [{ fn: "count", field: "OBJECTID", alias: "count" }] },
    });

    expect(projection.filters).toEqual({
      global: { field: "STATUS", operator: "=", value: "open" },
      incidentsOnly: { field: "TYPE", operator: "=", value: "fire", appliesTo: ["incidents"] },
      assetsOnly: { field: "TYPE", operator: "=", value: "hydrant", appliesTo: ["assets"] },
    });
    expect(projection.spatialFilter).toEqual(extentToSpatialFilter({ xmin: -1, ymin: -2, xmax: 3, ymax: 4 }));
    expect(projection.orderBy).toEqual([{ field: "SEVERITY", direction: "desc" }]);
    expect(projection.pagination).toEqual({ offset: 20, limit: 10 });
    expect(projection.outFields).toEqual(["STATUS", "SEVERITY"]);
    expect(projection.grouping).toEqual(["STATUS"]);
    expect(projection.selection).toEqual([target]);
  });

  it("can filter clauses to one source and suppress spatial output", () => {
    const projection = selectLinkedViewQueryProjection(
      {
        ...EMPTY_STATE,
        filters: {
          global: { field: "STATUS", operator: "=", value: "open" },
          incidentsOnly: { field: "TYPE", operator: "=", value: "fire", appliesTo: ["incidents"] },
          assetsOnly: { field: "TYPE", operator: "=", value: "hydrant", appliesTo: ["assets"] },
        },
        extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
      { sourceId: "incidents", spatialMode: "none" },
    );

    expect(Object.keys(projection.filters).sort()).toEqual(["global", "incidentsOnly"]);
    expect(projection.spatialFilter).toBeUndefined();
  });

  it("emits selector updates for changed object-valued filter values", async () => {
    const ctx = createExplorationContext({
      datasetId: "d",
      sourceIds: ["incidents"],
      initialState: {
        filters: {
          since: { field: "UPDATED_AT", operator: ">=", value: new Date("2026-01-01T00:00:00Z") },
        },
      },
    });
    const table = ctx.connectView({ id: "table", role: "grid" });
    const projections: unknown[] = [];
    subscribeExplorationSelector(table, "filters", selectLinkedViewQueryProjection, (projection) =>
      projections.push(projection),
    );

    ctx.dispatch({
      kind: "set-filter",
      id: "since",
      clause: { field: "UPDATED_AT", operator: ">=", value: new Date("2026-01-02T00:00:00Z") },
    });
    await flush();

    expect(projections).toHaveLength(1);
    ctx.dispose();
  });
});
