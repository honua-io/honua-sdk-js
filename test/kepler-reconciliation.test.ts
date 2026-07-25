import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEPLER_BRIDGE_LIMITS,
  type KeplerDatasetProjection,
  type KeplerResultProjectionRequest,
  type KeplerWorkspaceDatasetState,
  keplerDatasetStateFromProjection,
  projectResultToKeplerDataset,
  reconcileKeplerDataset,
} from "../src/kepler/index.js";

const provenance = {
  sourceId: "incidents",
  schemaVersion: "schema-1",
  planId: "plan-1",
  authorizationScope: "scope:public-read",
} as const;

function snapshotProjection(
  features: KeplerResultProjectionRequest["result"]["features"],
  overrides: Partial<KeplerResultProjectionRequest> = {},
): KeplerDatasetProjection {
  return projectResultToKeplerDataset({
    datasetId: "incidents",
    provenance,
    rowIdentityField: "objectid",
    result: {
      features,
      fields: [
        { name: "objectid", type: "esriFieldTypeOID" },
        { name: "status", type: "esriFieldTypeString" },
      ],
      exceededTransferLimit: false,
    },
    ...overrides,
  });
}

function baseState(): KeplerWorkspaceDatasetState {
  return keplerDatasetStateFromProjection(
    snapshotProjection([
      { attributes: { objectid: 1, status: "open" }, geometry: { x: -122.4, y: 37.8 } },
      { attributes: { objectid: 2, status: "closed" }, geometry: { x: -122.5, y: 37.9 } },
    ]),
    "cursor-1",
  );
}

describe("keplerDatasetStateFromProjection", () => {
  it("carries row identity, plan identity, authorization scope, and point columns", () => {
    const state = baseState();

    expect(state).toMatchObject({
      datasetId: "incidents",
      rowIdentityField: "objectid",
      schemaVersion: "schema-1",
      planId: "plan-1",
      authorizationScope: "scope:public-read",
      cursor: "cursor-1",
      pointColumns: { longitude: "longitude", latitude: "latitude" },
    });
    expect(state.rows).toHaveLength(2);
  });
});

describe("reconcileKeplerDataset — snapshot replacement", () => {
  it("replaces rows in place when the field plan is unchanged", () => {
    const plan = reconcileKeplerDataset(baseState(), {
      type: "snapshot",
      projection: snapshotProjection([{ attributes: { objectid: 3, status: "new" }, geometry: { x: 0, y: 0 } }]),
      cursor: "cursor-2",
    });

    expect(plan.diagnostic.mode).toBe("snapshot-replace");
    expect(plan.diagnostic.bounded).toBe(true);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].kind).toBe("replace-rows");
    expect(plan.nextState?.rows).toHaveLength(1);
    expect(plan.nextState?.cursor).toBe("cursor-2");
  });

  it("requires an explicit rebuild when the snapshot field plan changed", () => {
    const plan = reconcileKeplerDataset(baseState(), {
      type: "snapshot",
      projection: projectResultToKeplerDataset({
        datasetId: "incidents",
        provenance,
        result: {
          features: [{ attributes: { objectid: 1, priority: 2 }, geometry: { x: 0, y: 0 } }],
          exceededTransferLimit: false,
        },
      }),
    });

    expect(plan.diagnostic.mode).toBe("rebuild-required");
    expect(plan.diagnostic.rebuildReason).toBe("schema-changed");
    expect(plan.nextState).toBeUndefined();
    expect(plan.operations[0]).toMatchObject({ kind: "rebuild-workspace", reason: "schema-changed" });
  });

  it("refuses a snapshot for a different dataset", () => {
    expect(() =>
      reconcileKeplerDataset(baseState(), {
        type: "snapshot",
        projection: snapshotProjection([{ attributes: { objectid: 1, status: "open" } }], { datasetId: "other" }),
      }),
    ).toThrowError(/cannot reconcile dataset/);
  });
});

describe("reconcileKeplerDataset — bounded delta", () => {
  it("applies updates, appends, and removals as bounded row operations", () => {
    const plan = reconcileKeplerDataset(baseState(), {
      type: "delta",
      upserts: [
        { id: 1, attributes: { objectid: 1, status: "resolved" }, geometry: { x: -122.45, y: 37.85 } },
        { id: 3, attributes: { objectid: 3, status: "open" }, geometry: { x: -122.6, y: 38 } },
      ],
      deletes: [{ id: 2 }],
      cursor: "cursor-2",
      expectedPreviousCursor: "cursor-1",
    });

    expect(plan.diagnostic).toMatchObject({
      mode: "bounded-delta",
      bounded: true,
      rowsUpdated: 1,
      rowsAppended: 1,
      rowsRemoved: 1,
      rowsUnmatchedDeletes: 0,
    });
    expect(plan.operations.map((operation) => operation.kind)).toEqual(["update-rows", "append-rows", "remove-rows"]);
    expect(plan.nextState?.rows).toEqual([
      [1, "resolved", -122.45, 37.85],
      [3, "open", -122.6, 38],
    ]);
    expect(plan.nextState?.cursor).toBe("cursor-2");
  });

  it("counts a delete for a row the workspace never held without rebuilding", () => {
    const plan = reconcileKeplerDataset(baseState(), { type: "delta", deletes: [{ id: 99 }] });

    expect(plan.diagnostic.mode).toBe("bounded-delta");
    expect(plan.diagnostic.rowsUnmatchedDeletes).toBe(1);
    expect(plan.operations).toEqual([]);
  });

  it("emits an explicit rebuild diagnostic on a resume gap", () => {
    const plan = reconcileKeplerDataset(baseState(), {
      type: "delta",
      upserts: [{ id: 1, attributes: { objectid: 1, status: "open" } }],
      expectedPreviousCursor: "cursor-7",
    });

    expect(plan.diagnostic.rebuildReason).toBe("resume-gap");
    expect(plan.diagnostic.bounded).toBe(false);
    expect(plan.diagnostic.detail).toContain("cursor-7");
  });

  it("emits an explicit rebuild diagnostic when the plan identity changes", () => {
    const plan = reconcileKeplerDataset(baseState(), {
      type: "delta",
      upserts: [{ id: 1, attributes: { objectid: 1, status: "open" } }],
      planId: "plan-2",
    });

    expect(plan.diagnostic.rebuildReason).toBe("plan-identity-changed");
  });

  it("emits an explicit rebuild diagnostic when the authorization scope changes", () => {
    const plan = reconcileKeplerDataset(baseState(), {
      type: "delta",
      upserts: [{ id: 1, attributes: { objectid: 1, status: "open" } }],
      authorizationScope: "scope:internal",
    });

    expect(plan.diagnostic.rebuildReason).toBe("authorization-scope-changed");
    expect(plan.diagnostic.detail).toContain("never be merged");
  });

  it("emits an explicit rebuild diagnostic when the schema version changes", () => {
    const plan = reconcileKeplerDataset(baseState(), {
      type: "delta",
      upserts: [{ id: 1, attributes: { objectid: 1, status: "open" } }],
      schemaVersion: "schema-2",
    });

    expect(plan.diagnostic.rebuildReason).toBe("schema-changed");
  });

  it("requires a rebuild when the dataset was opened without a row identity", () => {
    const state = keplerDatasetStateFromProjection(
      projectResultToKeplerDataset({
        datasetId: "incidents",
        provenance,
        result: { features: [{ attributes: { objectid: 1 } }], exceededTransferLimit: false },
      }),
    );

    const plan = reconcileKeplerDataset(state, {
      type: "delta",
      upserts: [{ id: 1, attributes: { objectid: 1 } }],
    });

    expect(plan.diagnostic.rebuildReason).toBe("missing-row-identity");
  });

  it("requires a rebuild when the delta exceeds the bounded-delta budget", () => {
    const plan = reconcileKeplerDataset(
      baseState(),
      {
        type: "delta",
        upserts: [
          { id: 1, attributes: { objectid: 1, status: "a" } },
          { id: 2, attributes: { objectid: 2, status: "b" } },
        ],
      },
      { ...DEFAULT_KEPLER_BRIDGE_LIMITS, maxDeltaRows: 1 },
    );

    expect(plan.diagnostic.rebuildReason).toBe("delta-budget-exceeded");
    expect(plan.diagnostic.detail).toContain("1-row bounded-delta budget");
  });

  it("requires a rebuild when applying the delta would exceed the row budget", () => {
    const plan = reconcileKeplerDataset(
      baseState(),
      { type: "delta", upserts: [{ id: 3, attributes: { objectid: 3, status: "open" } }] },
      { ...DEFAULT_KEPLER_BRIDGE_LIMITS, maxRowsPerDataset: 2 },
    );

    expect(plan.diagnostic.rebuildReason).toBe("row-budget-exceeded");
  });

  it("projects a delta upsert through the geojson column when the dataset uses one", () => {
    const state = keplerDatasetStateFromProjection(
      snapshotProjection([
        {
          attributes: { objectid: 1, status: "open" },
          geometry: {
            rings: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ]),
    );

    const plan = reconcileKeplerDataset(state, {
      type: "delta",
      upserts: [
        {
          id: 1,
          attributes: { objectid: 1, status: "closed" },
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [2, 2],
            ],
          },
        },
      ],
    });

    expect(plan.diagnostic.rowsUpdated).toBe(1);
    expect(plan.nextState?.rows[0].at(-1)).toEqual({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [2, 2],
        ],
      },
    });
  });

  it("rejects a delta upsert without a usable identity", () => {
    expect(() =>
      reconcileKeplerDataset(baseState(), {
        type: "delta",
        upserts: [{ id: undefined as unknown as number, attributes: { objectid: 1 } }],
      }),
    ).toThrowError(/requires a string or number id/);
  });
});
