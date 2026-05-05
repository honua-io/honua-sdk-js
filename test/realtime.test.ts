import { describe, expect, it, vi } from "vitest";

import { createExplorationContext, sourceFeatureSelectionTarget } from "../src/exploration/index.js";
import {
  createRealtimeFeatureStore,
  emptyRealtimeFeatureState,
  filterRealtimeSelection,
  realtimeFeatureKey,
  reconcileRealtimeSelection,
  reconcileRealtimeStaleness,
  reduceRealtimeFeatureState,
} from "../src/realtime/index.js";
import type {
  RealtimeFeatureObserver,
  RealtimeFeatureTransport,
  RealtimeSubscriptionRequest,
} from "../src/realtime/index.js";

describe("realtime feature state", () => {
  it("applies snapshot, upsert, delete, cursor, and heartbeat events", () => {
    let state = emptyRealtimeFeatureState<{ status: string }>();

    state = reduceRealtimeFeatureState(state, {
      type: "snapshot",
      cursor: "c1",
      sequence: 1,
      receivedAt: 100,
      features: [
        { sourceId: "incidents", id: 1, feature: { status: "open" } },
        { sourceId: "incidents", id: 2, feature: { status: "monitoring" } },
      ],
    });

    expect(state.status).toBe("live");
    expect(state.cursor).toBe("c1");
    expect(Object.keys(state.records)).toEqual(["incidents:1", "incidents:2"]);

    state = reduceRealtimeFeatureState(state, {
      type: "upsert",
      cursor: "c2",
      sequence: 2,
      receivedAt: 110,
      feature: { sourceId: "incidents", id: 2, feature: { status: "closed" } },
    });
    expect(state.records["incidents:2"]?.feature.status).toBe("closed");

    state = reduceRealtimeFeatureState(state, {
      type: "delete",
      cursor: "c3",
      sequence: 3,
      receivedAt: 120,
      sourceId: "incidents",
      id: 1,
    });
    expect(state.records["incidents:1"]).toBeUndefined();
    expect(state.tombstones["incidents:1"]?.deletedAt).toBe(120);

    state = reduceRealtimeFeatureState(state, { type: "heartbeat", cursor: "c4", receivedAt: 130 });
    expect(state.lastHeartbeatAt).toBe(130);
    expect(state.cursor).toBe("c4");
  });

  it("ignores duplicate event ids and out-of-order sequences", () => {
    let state = emptyRealtimeFeatureState<{ status: string }>();
    state = reduceRealtimeFeatureState(state, {
      type: "upsert",
      eventId: "e1",
      sequence: 10,
      feature: { sourceId: "incidents", id: 1, feature: { status: "open" } },
    });

    const duplicate = reduceRealtimeFeatureState(state, {
      type: "upsert",
      eventId: "e1",
      sequence: 11,
      feature: { sourceId: "incidents", id: 1, feature: { status: "closed" } },
    });
    expect(duplicate.records["incidents:1"]?.feature.status).toBe("open");
    expect(duplicate.ignoredEventCount).toBe(1);

    const outOfOrder = reduceRealtimeFeatureState(duplicate, {
      type: "upsert",
      eventId: "e2",
      sequence: 9,
      feature: { sourceId: "incidents", id: 1, feature: { status: "closed" } },
    });
    expect(outOfOrder.records["incidents:1"]?.feature.status).toBe("open");
    expect(outOfOrder.ignoredEventCount).toBe(2);
  });

  it("marks live state stale when heartbeats exceed the configured threshold", () => {
    const state = reduceRealtimeFeatureState(emptyRealtimeFeatureState(), {
      type: "heartbeat",
      receivedAt: 1_000,
    });

    expect(
      reconcileRealtimeStaleness(state, {
        staleAfterMs: 250,
        now: 1_400,
      }),
    ).toMatchObject({
      status: "stale",
      staleSince: 1_250,
    });
  });

  it("bridges mock transports into a subscribable realtime store", () => {
    let observer: RealtimeFeatureObserver<{ status: string }> | undefined;
    const close = vi.fn();
    const transport: RealtimeFeatureTransport<{ status: string }> = {
      subscribe(_request: RealtimeSubscriptionRequest, nextObserver) {
        observer = nextObserver;
        return { close };
      },
    };
    const store = createRealtimeFeatureStore<{ status: string }>();
    const listener = vi.fn();
    store.subscribe(listener);

    const handle = store.connect(transport, { sourceId: "incidents" });
    observer?.next({
      type: "upsert",
      cursor: "c1",
      feature: { sourceId: "incidents", id: 7, feature: { status: "open" } },
    });
    observer?.next({ type: "status", status: "reconnecting" });
    observer?.next({ type: "heartbeat", receivedAt: 50 });
    observer?.complete();

    expect(store.state.records[realtimeFeatureKey("incidents", 7)]?.feature.status).toBe("open");
    expect(store.state.status).toBe("closed");
    expect(listener).toHaveBeenCalled();
    handle.close();
    expect(close).toHaveBeenCalled();
  });

  it("filters linked exploration selection against deletes and missing live records", () => {
    const state = reduceRealtimeFeatureState(emptyRealtimeFeatureState(), {
      type: "snapshot",
      features: [{ sourceId: "incidents", id: 1, feature: { status: "open" } }],
    });
    const deleted = reduceRealtimeFeatureState(state, {
      type: "delete",
      sourceId: "incidents",
      id: 2,
    });

    const selection = [
      sourceFeatureSelectionTarget("incidents", 1),
      sourceFeatureSelectionTarget("incidents", 2),
      sourceFeatureSelectionTarget("incidents", 3),
    ];

    expect(filterRealtimeSelection(selection, deleted)).toEqual([sourceFeatureSelectionTarget("incidents", 1)]);
  });

  it("can reconcile deleted selection back into an exploration view", async () => {
    const ctx = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"] });
    const view = ctx.connectView({ id: "realtime", role: "custom" });
    view.select([sourceFeatureSelectionTarget("incidents", 2)], { replace: true });

    const state = reduceRealtimeFeatureState(emptyRealtimeFeatureState(), {
      type: "delete",
      sourceId: "incidents",
      id: 2,
    });
    reconcileRealtimeSelection(view, state, { requireLiveRecord: false });

    expect(ctx.state.selection).toEqual([]);
    ctx.dispose();
  });
});
