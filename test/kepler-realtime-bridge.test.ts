import { describe, expect, it } from "vitest";

import {
  type KeplerWorkspaceDatasetState,
  defaultKeplerRealtimeFeatureProjector,
  keplerDatasetStateFromProjection,
  keplerDeltaFromRealtimeEvent,
  keplerSnapshotFromRealtimeEvent,
  projectResultToKeplerDataset,
  reconcileKeplerDataset,
} from "../src/kepler/index.js";
import type {
  RealtimeDeleteEvent,
  RealtimeDeltaEvent,
  RealtimeFeaturePatch,
  RealtimeSnapshotEvent,
  RealtimeUpsertEvent,
} from "../src/realtime/types.js";

/**
 * The canonical Honua feature shape a subscription carries. Typed as the real
 * `RealtimeFeaturePatch<TFeature>` so a change to the realtime contract breaks
 * this adapter's tests rather than silently producing empty attribute rows.
 */
interface IncidentFeature {
  readonly attributes: { readonly objectid: number; readonly status: string };
  readonly geometry?: { readonly x: number; readonly y: number };
}

const provenance = {
  sourceId: "incidents",
  schemaVersion: "schema-1",
  planId: "plan-1",
  authorizationScope: "scope:public-read",
} as const;

const projectionRequest = {
  datasetId: "incidents",
  provenance,
  rowIdentityField: "objectid",
} as const;

function patch(objectid: number, status: string, x = -122.4, y = 37.8): RealtimeFeaturePatch<IncidentFeature> {
  return { id: objectid, feature: { attributes: { objectid, status }, geometry: { x, y } } };
}

function openState(): KeplerWorkspaceDatasetState {
  return keplerDatasetStateFromProjection(
    projectResultToKeplerDataset({
      ...projectionRequest,
      result: {
        features: [
          { attributes: { objectid: 1, status: "open" }, geometry: { x: -122.4, y: 37.8 } },
          { attributes: { objectid: 2, status: "closed" }, geometry: { x: -122.5, y: 37.9 } },
        ],
        fields: [
          { name: "objectid", type: "esriFieldTypeOID" },
          { name: "status", type: "esriFieldTypeString" },
        ],
        exceededTransferLimit: false,
      },
    }),
    "cursor-1",
  );
}

describe("defaultKeplerRealtimeFeatureProjector", () => {
  it("reads a canonical HonuaTypedFeature payload", () => {
    expect(defaultKeplerRealtimeFeatureProjector({ attributes: { objectid: 1 }, geometry: { x: 1, y: 2 } })).toEqual({
      attributes: { objectid: 1 },
      geometry: { x: 1, y: 2 },
    });
  });

  it("reads a GeoJSON Feature payload", () => {
    expect(
      defaultKeplerRealtimeFeatureProjector({
        type: "Feature",
        properties: { objectid: 7 },
        geometry: { type: "Point", coordinates: [1, 2] },
      }),
    ).toEqual({ attributes: { objectid: 7 }, geometry: { type: "Point", coordinates: [1, 2] } });
  });

  it("reads a flat attribute record, lifting a geometry member out of the attributes", () => {
    expect(defaultKeplerRealtimeFeatureProjector({ objectid: 3, status: "open", geometry: { x: 1, y: 2 } })).toEqual({
      attributes: { objectid: 3, status: "open" },
      geometry: { x: 1, y: 2 },
    });
  });

  it("rejects a scalar payload instead of producing an empty row", () => {
    expect(() => defaultKeplerRealtimeFeatureProjector(42)).toThrowError(/must be an object/);
  });
});

describe("keplerDeltaFromRealtimeEvent", () => {
  it("projects a real RealtimeDeltaEvent into reconcilable upserts and deletes", () => {
    const event: RealtimeDeltaEvent<IncidentFeature> = {
      type: "delta",
      upserts: [patch(1, "resolved", -122.45, 37.85), patch(3, "open", -122.6, 38)],
      deletes: [{ id: 2 }],
      cursor: "cursor-2",
    };

    const delta = keplerDeltaFromRealtimeEvent(event, { expectedPreviousCursor: "cursor-1" });

    expect(delta).toEqual({
      type: "delta",
      upserts: [
        { id: 1, attributes: { objectid: 1, status: "resolved" }, geometry: { x: -122.45, y: 37.85 } },
        { id: 3, attributes: { objectid: 3, status: "open" }, geometry: { x: -122.6, y: 38 } },
      ],
      deletes: [{ id: 2 }],
      cursor: "cursor-2",
      expectedPreviousCursor: "cursor-1",
    });
  });

  it("round-trips a real realtime delta all the way through reconciliation", () => {
    const event: RealtimeDeltaEvent<IncidentFeature> = {
      type: "delta",
      upserts: [patch(1, "resolved", -122.45, 37.85), patch(3, "open", -122.6, 38)],
      deletes: [{ id: 2 }],
      cursor: "cursor-2",
    };

    const plan = reconcileKeplerDataset(
      openState(),
      keplerDeltaFromRealtimeEvent(event, { expectedPreviousCursor: "cursor-1" }),
    );

    expect(plan.diagnostic).toMatchObject({ mode: "bounded-delta", rowsUpdated: 1, rowsAppended: 1, rowsRemoved: 1 });
    expect(plan.nextState?.rows).toEqual([
      [1, "resolved", -122.45, 37.85],
      [3, "open", -122.6, 38],
    ]);
    expect(plan.nextState?.cursor).toBe("cursor-2");
  });

  it("projects a single RealtimeUpsertEvent", () => {
    const event: RealtimeUpsertEvent<IncidentFeature> = { type: "upsert", feature: patch(5, "new") };

    expect(keplerDeltaFromRealtimeEvent(event)).toEqual({
      type: "delta",
      upserts: [{ id: 5, attributes: { objectid: 5, status: "new" }, geometry: { x: -122.4, y: 37.8 } }],
    });
  });

  it("projects a RealtimeDeleteEvent", () => {
    const event: RealtimeDeleteEvent = { type: "delete", id: 2, cursor: "cursor-9" };

    expect(keplerDeltaFromRealtimeEvent(event)).toEqual({ type: "delta", deletes: [{ id: 2 }], cursor: "cursor-9" });
  });

  it("honors a caller-supplied feature projector for an adapter-specific payload", () => {
    const event: RealtimeDeltaEvent<[number, string]> = {
      type: "delta",
      upserts: [{ id: 8, feature: [8, "open"] }],
    };

    const delta = keplerDeltaFromRealtimeEvent(event, {
      projectFeature: ([objectid, status], id) => ({ attributes: { objectid, status, id } }),
    });

    expect(delta.upserts).toEqual([{ id: 8, attributes: { objectid: 8, status: "open", id: 8 } }]);
  });

  it("carries plan, schema, and authorization identity so a changed scope still forces a rebuild", () => {
    const event: RealtimeDeltaEvent<IncidentFeature> = { type: "delta", upserts: [patch(1, "resolved")] };

    const plan = reconcileKeplerDataset(
      openState(),
      keplerDeltaFromRealtimeEvent(event, { authorizationScope: "scope:internal" }),
    );

    expect(plan.diagnostic.rebuildReason).toBe("authorization-scope-changed");
  });

  it("refuses an event type that carries no rows", () => {
    expect(() => keplerDeltaFromRealtimeEvent({ type: "heartbeat" } as unknown as RealtimeDeleteEvent)).toThrowError(
      /carries no rows to reconcile/,
    );
  });
});

describe("keplerSnapshotFromRealtimeEvent", () => {
  it("re-projects a real RealtimeSnapshotEvent's features into a replaceable snapshot", () => {
    const event: RealtimeSnapshotEvent<IncidentFeature> = {
      type: "snapshot",
      features: [patch(1, "open"), patch(2, "closed", -122.5, 37.9)],
      cursor: "cursor-5",
    };

    const snapshot = keplerSnapshotFromRealtimeEvent(event, projectionRequest);

    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.cursor).toBe("cursor-5");
    // Attributes came out of `feature`, not an empty object.
    expect(snapshot.projection.dataset.data.rows).toEqual([
      [1, "open", -122.4, 37.8],
      [2, "closed", -122.5, 37.9],
    ]);
    expect(snapshot.projection.diagnostic.geoJsonBytes).toBe(0);
  });

  it("reconciles the re-projected snapshot in place without a rebuild", () => {
    const event: RealtimeSnapshotEvent<IncidentFeature> = {
      type: "snapshot",
      features: [patch(9, "open", -122.9, 38.5)],
      cursor: "cursor-6",
    };

    const plan = reconcileKeplerDataset(openState(), keplerSnapshotFromRealtimeEvent(event, projectionRequest));

    expect(plan.diagnostic.mode).toBe("snapshot-replace");
    expect(plan.nextState?.rows).toEqual([[9, "open", -122.9, 38.5]]);
    expect(plan.nextState?.cursor).toBe("cursor-6");
  });

  it("refuses a non-snapshot event", () => {
    expect(() =>
      keplerSnapshotFromRealtimeEvent(
        { type: "delta" } as unknown as RealtimeSnapshotEvent<IncidentFeature>,
        projectionRequest,
      ),
    ).toThrowError(/requires a realtime snapshot event/);
  });
});
