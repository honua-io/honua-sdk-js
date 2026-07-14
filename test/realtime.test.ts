import { describe, expect, it, vi } from "vitest";

import { createExplorationContext, sourceFeatureSelectionTarget } from "../src/exploration/index.js";
import { isHonuaError } from "../src/index.js";
import {
  HonuaRealtimeResumeError,
  createRealtimeFeatureStore,
  createRealtimeServerSentEventsTransport,
  decodeRealtimeServerSentEvent,
  emptyRealtimeFeatureState,
  encodeDefaultRealtimeRequest,
  filterRealtimeSelection,
  realtimeFeatureKey,
  realtimeResumeCheckpoint,
  realtimeSubscriptionKey,
  reconcileRealtimeSelection,
  reconcileRealtimeStaleness,
  reduceRealtimeFeatureState,
  selectRealtimeDetail,
  selectRealtimeFeatureRecordMap,
  selectRealtimeFeatureRecords,
  selectRealtimeFeatureTombstones,
  selectRealtimeFeatures,
} from "../src/realtime/index.js";
import type {
  RealtimeFeatureObserver,
  RealtimeFeatureTransport,
  RealtimeServerSentEventSource,
  RealtimeSubscriptionRequest,
} from "../src/realtime/index.js";

class MockRealtimeEventSource implements RealtimeServerSentEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public readyState = 0;
  public closed = false;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  public constructor(public readonly url: string) {}

  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  public close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  public message(payload: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  public namedMessage(type: string, payload: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  public fail(closed = false): void {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}

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

  it("applies delta batches and exposes cursor, watermark, timestamp, and delta-token checkpoints", () => {
    let state = reduceRealtimeFeatureState(emptyRealtimeFeatureState<{ status: string }>(), {
      type: "snapshot",
      eventId: "snapshot-1",
      checkpoint: {
        cursor: "c1",
        watermark: "w1",
        timestamp: "2026-05-05T10:00:00.000Z",
        sequence: 1,
      },
      features: [
        { sourceId: "incidents", id: 1, feature: { status: "open" } },
        { sourceId: "incidents", id: 2, feature: { status: "monitoring" } },
      ],
    });

    state = reduceRealtimeFeatureState(state, {
      type: "delta",
      eventId: "delta-2",
      sequence: 2,
      checkpoint: {
        cursor: "c2",
        watermark: "w2",
        timestamp: "2026-05-05T10:00:05.000Z",
        deltaToken: "dt2",
      },
      upserts: [
        { sourceId: "incidents", id: 1, feature: { status: "assigned" }, version: 2 },
        { sourceId: "incidents", id: 3, feature: { status: "open" }, version: 1 },
      ],
      deletes: [{ sourceId: "incidents", id: 2, version: 3, updatedAt: "2026-05-05T10:00:05.000Z" }],
    });

    expect(state.records["incidents:1"]?.feature.status).toBe("assigned");
    expect(state.records["incidents:3"]?.feature.status).toBe("open");
    expect(state.records["incidents:2"]).toBeUndefined();
    expect(state.tombstones["incidents:2"]).toMatchObject({
      version: 3,
      updatedAt: "2026-05-05T10:00:05.000Z",
    });
    expect(realtimeResumeCheckpoint(state)).toEqual({
      cursor: "c2",
      watermark: "w2",
      timestamp: "2026-05-05T10:00:05.000Z",
      sequence: 2,
      deltaToken: "dt2",
    });
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

  it("bridges mock transports and lifecycle events into a subscribable realtime store", () => {
    let observer: RealtimeFeatureObserver<{ status: string }> | undefined;
    const close = vi.fn();
    const requests: RealtimeSubscriptionRequest[] = [];
    const transport: RealtimeFeatureTransport<{ status: string }> = {
      capabilities: {
        kind: "mock",
        resumeModes: ["cursor", "watermark", "timestamp", "delta-token"],
        emitsHeartbeats: true,
        emitsWatermarks: true,
      },
      subscribe(request: RealtimeSubscriptionRequest, nextObserver) {
        requests.push(request);
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
    observer?.next({ type: "status", status: "reconnecting", reconnectAttempt: 1, retryAfterMs: 250 });
    observer?.next({ type: "heartbeat", receivedAt: 50 });
    observer?.next({ type: "status", status: "offline", reason: "browser-offline", receivedAt: 60 });
    observer?.next({ type: "error", error: new Error("permission denied"), terminal: true, code: "AUTH" });

    expect(requests).toEqual([{ sourceId: "incidents" }]);
    expect(store.state.status).toBe("error");
    expect(store.state.statusReason).toBe("AUTH");
    expect(store.state.terminalError).toBe(true);
    expect(store.state.records[realtimeFeatureKey("incidents", 7)]?.feature.status).toBe("open");

    observer?.complete();

    expect(store.state.status).toBe("closed");
    expect(listener).toHaveBeenCalled();
    handle.close();
    expect(close).toHaveBeenCalled();
  });

  it("passes stable request identity and resume checkpoints to transport adapters", () => {
    const resumeFrom = {
      cursor: "c7",
      watermark: "w7",
      timestamp: "2026-05-05T11:00:00.000Z",
      deltaToken: "dt7",
    };
    const request: RealtimeSubscriptionRequest = {
      requestId: "incident-ops",
      sourceId: "incidents",
      layerId: "active-incidents",
      fields: ["id", "status"],
      where: "status <> 'resolved'",
      spatialFilter: { relationship: "intersects", geometry: { y: 21.31, x: -157.86 } },
      mode: "snapshot-then-delta",
      resumeFrom,
    };
    const sameLogicalRequest = {
      ...request,
      spatialFilter: { geometry: { x: -157.86, y: 21.31 }, relationship: "intersects" },
      metadata: { traceId: "request-1" },
    };
    const changedFilter = { ...request, where: "severity = 'critical'" };

    expect(realtimeSubscriptionKey(request)).toBe(realtimeSubscriptionKey(sameLogicalRequest));
    expect(realtimeSubscriptionKey(request)).not.toBe(realtimeSubscriptionKey(changedFilter));

    let connectedRequest: RealtimeSubscriptionRequest | undefined;
    const transport: RealtimeFeatureTransport<{ status: string }> = {
      capabilities: {
        kind: "polling",
        resumeModes: ["cursor", "timestamp", "delta-token"],
      },
      subscribe(nextRequest, _observer) {
        connectedRequest = nextRequest;
        return { close: vi.fn() };
      },
    };

    createRealtimeFeatureStore<{ status: string }>().connect(transport, request);
    expect(connectedRequest).toMatchObject({
      sourceId: "incidents",
      layerId: "active-incidents",
      mode: "snapshot-then-delta",
      resumeFrom,
    });
  });

  it("encodes server-sent event subscription requests for cloud realtime streams", () => {
    const url = encodeDefaultRealtimeRequest(new URL("https://honua.example/realtime/events"), {
      requestId: "incident-ops",
      sourceId: "incidents",
      layerId: "active",
      fields: ["id", "status"],
      where: "status <> 'resolved'",
      mode: "snapshot-then-delta",
      resumeFrom: {
        cursor: "c7",
        watermark: "w7",
        timestamp: "2026-05-05T11:00:00.000Z",
        sequence: 12,
        deltaToken: "dt7",
      },
      spatialFilter: { relationship: "intersects", geometry: { x: -157.86, y: 21.31 } },
      metadata: { demo: "incident-dashboard" },
    });

    expect(url.searchParams.get("requestId")).toBe("incident-ops");
    expect(url.searchParams.get("sourceId")).toBe("incidents");
    expect(url.searchParams.get("layerId")).toBe("active");
    expect(url.searchParams.get("mode")).toBe("snapshot-then-delta");
    expect(url.searchParams.get("cursor")).toBe("c7");
    expect(url.searchParams.get("sequence")).toBe("12");
    expect(JSON.parse(url.searchParams.get("spatialFilter") ?? "{}")).toEqual({
      relationship: "intersects",
      geometry: { x: -157.86, y: 21.31 },
    });
  });

  it("decodes direct and enveloped server-sent event payloads", () => {
    expect(
      decodeRealtimeServerSentEvent<{ status: string }>({
        type: "upsert",
        feature: { sourceId: "incidents", id: 1, feature: { status: "open" } },
      }),
    ).toMatchObject({
      type: "upsert",
      feature: { id: 1 },
    });
    expect(
      decodeRealtimeServerSentEvent<{ status: string }>({
        event: {
          type: "heartbeat",
          cursor: "c9",
        },
      }),
    ).toEqual({
      type: "heartbeat",
      cursor: "c9",
    });
    let malformed: unknown;
    try {
      decodeRealtimeServerSentEvent({ event: "missing-type" });
    } catch (error) {
      malformed = error;
    }
    expect(malformed).toBeInstanceOf(HonuaRealtimeResumeError);
    expect(isHonuaError(malformed)).toBe(true);
    expect(malformed).toMatchObject({
      code: "invalid-event",
      sdkCode: "realtime.protocol.terminal",
      retryable: false,
    });

    const terminal = decodeRealtimeServerSentEvent({
      type: "error",
      terminal: true,
      code: "AUTH",
      error: {
        kind: "honua.sdk.error.v1",
        name: "HonuaRealtimeResumeError",
        domain: "realtime",
        sdkCode: "realtime.protocol.terminal",
        category: "protocol",
        retryable: false,
        context: { payload: "spoofed-context-secret" },
        authorization: "Bearer server-header-secret",
        resumeToken: "server-resume-secret",
        payload: { feature: "server-payload-secret" },
        filter: "owner = 'server-filter-secret'",
      },
    });
    expect(terminal.type).toBe("error");
    if (terminal.type !== "error") throw new Error("expected a realtime error event");
    expect(terminal.error).toBeInstanceOf(HonuaRealtimeResumeError);
    expect(terminal.error).toMatchObject({ sdkCode: "realtime.protocol.terminal", retryable: false });
    const serialized = JSON.stringify(terminal.error);
    for (const secret of [
      "server-header-secret",
      "spoofed-context-secret",
      "server-resume-secret",
      "server-payload-secret",
      "server-filter-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps SSE reconnect and abort policy while tagging terminal transport failures", () => {
    let source: MockRealtimeEventSource | undefined;
    const next = vi.fn();
    const errors: unknown[] = [];
    const complete = vi.fn();
    const controller = new AbortController();
    const transport = createRealtimeServerSentEventsTransport({
      url: "https://honua.example/api/v1/realtime/events",
      eventSourceFactory(url) {
        source = new MockRealtimeEventSource(url);
        return source;
      },
    });
    transport.subscribe(
      { sourceId: "incidents", signal: controller.signal },
      { next, error: (error) => errors.push(error), complete },
    );

    source?.fail(false);
    expect(next).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "status", status: "reconnecting", reason: "sse-error" }),
    );
    expect(errors).toEqual([]);

    source?.fail(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HonuaRealtimeResumeError);
    expect(errors[0]).toMatchObject({
      code: "transport-gap",
      sdkCode: "realtime.transport.reconnectable",
      retryable: true,
    });

    controller.abort("caller stopped");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it("completes a pre-aborted SSE subscription without constructing a transport or emitting an error", () => {
    const controller = new AbortController();
    controller.abort("already stopped");
    const factory = vi.fn();
    const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    const transport = createRealtimeServerSentEventsTransport({
      url: "https://honua.example/api/v1/realtime/events",
      eventSourceFactory: factory,
    });

    transport.subscribe({ sourceId: "incidents", signal: controller.signal }, observer);

    expect(factory).not.toHaveBeenCalled();
    expect(observer.next).not.toHaveBeenCalled();
    expect(observer.error).not.toHaveBeenCalled();
    expect(observer.complete).toHaveBeenCalledTimes(1);
  });

  it("tags synchronous SSE initialization failures and preserves their local cause", () => {
    const cause = new Error("factory-local-secret");
    const transport = createRealtimeServerSentEventsTransport({
      url: "https://honua.example/api/v1/realtime/events",
      eventSourceFactory() {
        throw cause;
      },
    });

    let failure: unknown;
    try {
      transport.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HonuaRealtimeResumeError);
    expect(failure).toMatchObject({ sdkCode: "realtime.protocol.terminal", cause });
    expect(JSON.stringify(failure)).not.toContain("factory-local-secret");
  });

  it("classifies observer callback failures as consumer failures without serializing their cause", () => {
    let source: MockRealtimeEventSource | undefined;
    const cause = new Error("observer-callback-secret");
    const errors: unknown[] = [];
    const transport = createRealtimeServerSentEventsTransport({
      url: "https://honua.example/api/v1/realtime/events",
      eventSourceFactory(url) {
        source = new MockRealtimeEventSource(url);
        return source;
      },
    });
    transport.subscribe(
      { sourceId: "incidents" },
      {
        next() {
          throw cause;
        },
        error(error) {
          errors.push(error);
        },
        complete: vi.fn(),
      },
    );

    source?.message({ type: "heartbeat", receivedAt: 1 });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HonuaRealtimeResumeError);
    expect(errors[0]).toMatchObject({
      code: "consumer-failed",
      sdkCode: "realtime.protocol.terminal",
      retryable: false,
      cause,
    });
    expect(JSON.stringify(errors[0])).not.toContain("observer-callback-secret");
  });

  it("bridges server-sent events into the realtime store without live cloud calls", () => {
    const sources: MockRealtimeEventSource[] = [];
    const transport = createRealtimeServerSentEventsTransport<{ status: string }>({
      url: "https://honua.example/api/v1/realtime/events",
      eventSourceFactory(url) {
        const source = new MockRealtimeEventSource(url);
        sources.push(source);
        return source;
      },
    });
    const store = createRealtimeFeatureStore<{ status: string }>();
    const listener = vi.fn();
    store.subscribe(listener);

    const handle = store.connect(transport, {
      sourceId: "incidents",
      layerId: "active",
      mode: "snapshot-then-delta",
      resumeFrom: { cursor: "c1" },
    });
    const [source] = sources;
    expect(source?.url).toContain("/api/v1/realtime/events?");
    expect(source?.url).toContain("sourceId=incidents");
    expect(source?.url).toContain("cursor=c1");

    source?.open();
    source?.message({
      type: "delta",
      cursor: "c2",
      sequence: 2,
      upserts: [{ sourceId: "incidents", id: 7, feature: { status: "open" } }],
    });
    source?.namedMessage("heartbeat", {
      type: "heartbeat",
      cursor: "c3",
      receivedAt: 500,
    });

    expect(store.state.status).toBe("live");
    expect(store.state.cursor).toBe("c3");
    expect(store.state.records[realtimeFeatureKey("incidents", 7)]?.feature.status).toBe("open");
    expect(store.state.lastHeartbeatAt).toBe(500);

    handle.close();
    expect(source?.closed).toBe(true);
    expect(store.state.status).toBe("closed");
    expect(listener).toHaveBeenCalled();
  });

  it("projects realtime state for map, table, tombstone, and detail synchronization", () => {
    let state = reduceRealtimeFeatureState(emptyRealtimeFeatureState<{ label: string; sort: number }>(), {
      type: "snapshot",
      features: [
        { sourceId: "incidents", id: "A", feature: { label: "Alpha", sort: 2 } },
        { sourceId: "incidents", id: "B", feature: { label: "Bravo", sort: 1 } },
        { sourceId: "units", id: "A", feature: { label: "Unit", sort: 3 } },
      ],
    });
    state = reduceRealtimeFeatureState(state, {
      type: "delete",
      sourceId: "incidents",
      id: "A",
    });

    expect(
      selectRealtimeFeatureRecords(state, {
        sourceId: "incidents",
        sort: (left, right) => left.feature.sort - right.feature.sort,
      }).map((record) => record.id),
    ).toEqual(["B"]);
    expect(selectRealtimeFeatures(state, { sourceId: "incidents" })).toEqual([{ label: "Bravo", sort: 1 }]);
    expect(Object.keys(selectRealtimeFeatureRecordMap(state, { sourceId: "units" }))).toEqual(["units:A"]);
    expect(selectRealtimeFeatureTombstones(state, { sourceId: "incidents" }).map((tombstone) => tombstone.id)).toEqual([
      "A",
    ]);
    expect(selectRealtimeDetail(state, "B", { sourceId: "incidents" })).toMatchObject({
      status: "present",
      record: { key: "incidents:B" },
    });
    expect(selectRealtimeDetail(state, { sourceId: "incidents", id: "A" })).toMatchObject({
      status: "deleted",
      tombstone: { key: "incidents:A" },
    });
    expect(selectRealtimeDetail(state, "missing", { sourceId: "incidents" })).toEqual({ status: "missing" });
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

describe("realtime tombstone bounding", () => {
  it("caps tombstone count at maxTombstones, retaining the most recently deleted", () => {
    let state = emptyRealtimeFeatureState();
    for (const [id, receivedAt] of [
      [1, 100],
      [2, 200],
      [3, 300],
    ] as const) {
      state = reduceRealtimeFeatureState(
        state,
        { type: "delete", sourceId: "s", id, receivedAt },
        { maxTombstones: 2 },
      );
    }
    expect(Object.keys(state.tombstones).sort()).toEqual(["s:2", "s:3"]);
  });

  it("drops tombstones older than tombstoneTtlMs", () => {
    let state = emptyRealtimeFeatureState();
    state = reduceRealtimeFeatureState(
      state,
      { type: "delete", sourceId: "s", id: 1, receivedAt: 1_000 },
      { tombstoneTtlMs: 5_000 },
    );
    state = reduceRealtimeFeatureState(
      state,
      { type: "delete", sourceId: "s", id: 2, receivedAt: 7_000 },
      { tombstoneTtlMs: 5_000 },
    );
    expect(state.tombstones["s:1"]).toBeUndefined();
    expect(state.tombstones["s:2"]).toBeDefined();
  });

  it("returns the same state reference for an empty delta", () => {
    const state = reduceRealtimeFeatureState(emptyRealtimeFeatureState(), {
      type: "snapshot",
      features: [{ sourceId: "s", id: 1, feature: { v: 1 } }],
    });
    const next = reduceRealtimeFeatureState(state, { type: "delta", upserts: [], deletes: [] });
    expect(next.records).toBe(state.records);
    expect(next.tombstones).toBe(state.tombstones);
  });
});

describe("realtime SSE default EventSource factory", () => {
  // The global `EventSource` is a constructor: invoking it as a plain
  // call (`EventSource(url, init)`) throws a TypeError in browsers
  // (#271). A class double reproduces that — class constructors also
  // throw when invoked without `new` — so this test fails unless the
  // default factory constructs the source.
  it("constructs the global EventSource with `new` when no eventSourceFactory is provided", () => {
    const constructed: GlobalEventSourceDouble[] = [];
    class GlobalEventSourceDouble implements RealtimeServerSentEventSource {
      public onopen: ((event: Event) => void) | null = null;
      public onmessage: ((event: MessageEvent<string>) => void) | null = null;
      public onerror: ((event: Event) => void) | null = null;
      public readyState = 0;
      public closed = false;
      public constructor(
        public readonly url: string,
        public readonly init?: EventSourceInit,
      ) {
        constructed.push(this);
      }
      public close(): void {
        this.closed = true;
        this.readyState = 2;
      }
    }
    vi.stubGlobal("EventSource", GlobalEventSourceDouble);
    try {
      const transport = createRealtimeServerSentEventsTransport<{ status: string }>({
        url: "https://honua.example/api/v1/realtime/events",
        withCredentials: true,
      });
      const handle = transport.subscribe(
        { sourceId: "incidents" },
        { next: () => {}, error: () => {}, complete: () => {} },
      );
      expect(constructed).toHaveLength(1);
      expect(constructed[0]).toBeInstanceOf(GlobalEventSourceDouble);
      expect(constructed[0].url).toContain("sourceId=incidents");
      expect(constructed[0].init).toEqual({ withCredentials: true });
      handle.close();
      expect(constructed[0].closed).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
