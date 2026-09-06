import { describe, expect, it } from "vitest";

import { isHonuaError } from "../src/index.js";
import {
  HONUA_SERVER_STREAMING_FEATURES_PATH,
  HonuaRealtimeResumeError,
  createHonuaServerRealtimeSubscription,
  decodeHonuaServerRealtimeEvent,
  encodeHonuaServerRealtimeRequest,
  honuaServerRealtimePreset,
} from "../src/realtime/index.js";
import type {
  HonuaServerFeatureChangeEnvelope,
  RealtimeFeatureEvent,
  RealtimeFeatureObserver,
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
}

describe("honua-server realtime preset", () => {
  it("keeps the current-server envelope additive over the public string cursor contract", () => {
    const envelope: HonuaServerFeatureChangeEnvelope = {
      cursor: "42",
      operation: "update",
    };
    const cursor: string | undefined = envelope.cursor;
    type CurrentOperation = NonNullable<HonuaServerFeatureChangeEnvelope["operation"]>;
    const operation: CurrentOperation = envelope.operation ?? "update";
    // @ts-expect-error Snapshot remains a legacy `op`/`changes` value, not a current-server `operation`.
    const unsupportedOperation: CurrentOperation = "snapshot";

    expect(cursor).toBe("42");
    expect(operation).toBe("update");
    expect(unsupportedOperation).toBe("snapshot");
  });

  it("encodes serviceId/layers query params instead of sourceId/layerId", () => {
    const request: RealtimeSubscriptionRequest = {
      sourceId: "incidents",
      layerId: "active-incidents",
      where: "status <> 'resolved'",
      fields: ["id", "status"],
      mode: "snapshot-then-delta",
    };
    const url = new URL("https://honua.example/api/v1/streaming/features");

    encodeHonuaServerRealtimeRequest(url, request);

    expect(url.searchParams.get("serviceId")).toBe("incidents");
    expect(url.searchParams.get("layers")).toBe("active-incidents");
    expect(url.searchParams.has("sourceId")).toBe(false);
    expect(url.searchParams.has("layerId")).toBe(false);
    expect(url.searchParams.get("where")).toBe("status <> 'resolved'");
    expect(url.searchParams.get("fields")).toBe("id,status");
    expect(url.searchParams.get("mode")).toBe("snapshot-then-delta");
  });

  it("decodes a multi-change feature-change envelope into an SDK delta event", () => {
    const event = decodeHonuaServerRealtimeEvent<{ status: string }>({
      kind: "feature-change",
      serviceId: "incidents",
      eventId: "evt-7",
      sequence: 42,
      cursor: "c-42",
      changes: [
        { op: "update", featureId: 101, feature: { status: "active" }, version: 3, updatedAt: "2026-06-14T00:00:00Z" },
        { op: "insert", featureId: 102, feature: { status: "new" } },
        { op: "delete", featureId: 99, version: 2 },
      ],
    });

    expect(event).toEqual({
      type: "delta",
      eventId: "evt-7",
      sequence: 42,
      cursor: "c-42",
      watermark: undefined,
      timestamp: undefined,
      deltaToken: undefined,
      upserts: [
        {
          id: 101,
          sourceId: "incidents",
          feature: { status: "active" },
          version: 3,
          updatedAt: "2026-06-14T00:00:00Z",
        },
        { id: 102, sourceId: "incidents", feature: { status: "new" }, version: undefined, updatedAt: undefined },
      ],
      deletes: [{ id: 99, sourceId: "incidents", version: 2, updatedAt: undefined }],
    });
  });

  it("decodes a single inline feature-change envelope", () => {
    const event = decodeHonuaServerRealtimeEvent<{ status: string }>({
      type: "feature-change",
      serviceId: "incidents",
      op: "insert",
      featureId: "abc",
      feature: { status: "new" },
    });

    expect(event.type).toBe("delta");
    if (event.type === "delta") {
      expect(event.upserts).toEqual([
        { id: "abc", sourceId: "incidents", feature: { status: "new" }, version: undefined, updatedAt: undefined },
      ]);
      expect(event.deletes).toBeUndefined();
    }
  });

  it("decodes the current honua-server feature-stream envelope without inventing sequence from cursor", () => {
    const event = decodeHonuaServerRealtimeEvent({
      type: "feature-change",
      eventId: "01JCURRENT",
      operationInstanceId: "opinst-exact",
      correlationId: "corr-exact",
      auditId: "audit-exact",
      proposalId: "proposal-exact",
      cursor: 42,
      timestamp: "2026-07-27T18:00:00Z",
      sourceId: "postgres-cdc",
      serviceId: "incidents",
      layerId: 0,
      featureId: "4321",
      objectId: 4321,
      operation: "update",
      geometry: { type: "Point", coordinates: [-157.85, 21.3] },
      attributes: { objectid: 4321, status: "assigned" },
    });

    expect(event).toEqual({
      type: "delta",
      eventId: "01JCURRENT",
      operationInstanceId: "opinst-exact",
      correlationId: "corr-exact",
      auditId: "audit-exact",
      proposalId: "proposal-exact",
      sequence: undefined,
      cursor: "42",
      watermark: undefined,
      timestamp: "2026-07-27T18:00:00Z",
      deltaToken: undefined,
      upserts: [
        {
          id: "4321",
          sourceId: "incidents",
          feature: {
            type: "Feature",
            id: "4321",
            geometry: { type: "Point", coordinates: [-157.85, 21.3] },
            properties: { objectid: 4321, status: "assigned" },
          },
          version: undefined,
          updatedAt: "2026-07-27T18:00:00Z",
        },
      ],
    });
  });

  it("keeps non-contiguous numeric replay cursors opaque on filtered streams", () => {
    const events = [40, 42].map((cursor) =>
      decodeHonuaServerRealtimeEvent({
        type: "feature-change",
        eventId: `evt-${String(cursor)}`,
        cursor,
        sourceId: null,
        serviceId: "incidents",
        layerId: 0,
        featureId: String(cursor),
        objectId: cursor,
        operation: "update",
        geometry: null,
        attributes: { objectid: cursor, status: "assigned" },
      }),
    );

    expect(events.map((event) => event.sequence)).toEqual([undefined, undefined]);
    expect(events.map((event) => event.cursor)).toEqual(["40", "42"]);
  });

  it("fails closed when current-server insert/update events lack complete after-images", () => {
    const complete = {
      type: "feature-change",
      cursor: 42,
      serviceId: "incidents",
      featureId: "4321",
      objectId: 4321,
      operation: "update",
    };

    expect(() =>
      decodeHonuaServerRealtimeEvent({
        ...complete,
        attributes: { objectid: 4321, status: "assigned" },
      }),
    ).toThrow(/geometry after-image/u);
    expect(() =>
      decodeHonuaServerRealtimeEvent({
        ...complete,
        feature: { type: "Feature", geometry: null, properties: { objectid: 4321 } },
      }),
    ).toThrow(/geometry after-image/u);
    expect(() =>
      decodeHonuaServerRealtimeEvent({
        ...complete,
        changes: [
          {
            op: "update",
            featureId: "legacy-4321",
            feature: { type: "Feature", geometry: null, properties: { objectid: 4321 } },
          },
        ],
        attributes: { objectid: 4321, status: "assigned" },
      }),
    ).toThrow(/geometry after-image/u);
    expect(() =>
      decodeHonuaServerRealtimeEvent({
        ...complete,
        geometry: undefined,
        attributes: { objectid: 4321, status: "assigned" },
      }),
    ).toThrow(/geometry after-image/u);
    expect(() =>
      decodeHonuaServerRealtimeEvent({
        ...complete,
        geometry: null,
      }),
    ).toThrow(/attributes after-image/u);
    expect(() =>
      decodeHonuaServerRealtimeEvent({
        ...complete,
        feature: { type: "Feature", geometry: null, properties: { objectid: 4321 } },
        geometry: null,
      }),
    ).toThrow(/attributes after-image/u);
    expect(() =>
      decodeHonuaServerRealtimeEvent({
        ...complete,
        op: "update",
        feature: { type: "Feature", geometry: null, properties: { objectid: 4321 } },
        geometry: null,
      }),
    ).toThrow(/attributes after-image/u);
    expect(() =>
      decodeHonuaServerRealtimeEvent({
        ...complete,
        geometry: null,
        attributes: null,
      }),
    ).toThrow(/attributes after-image/u);
  });

  it.each([
    ["operation", { operation: "truncate", serviceId: "incidents", featureId: "1", geometry: null, attributes: {} }],
    ["feature id", { operation: "update", serviceId: "incidents", featureId: {}, geometry: null, attributes: {} }],
    ["service id", { operation: "update", serviceId: 42, featureId: "1", geometry: null, attributes: {} }],
    [
      "cursor object",
      { operation: "update", serviceId: "incidents", featureId: "1", cursor: {}, geometry: null, attributes: {} },
    ],
    [
      "cursor integer",
      { operation: "update", serviceId: "incidents", featureId: "1", cursor: 1.5, geometry: null, attributes: {} },
    ],
  ])("rejects an invalid current-server %s", (_label, invalid) => {
    expect(() =>
      decodeHonuaServerRealtimeEvent({
        type: "feature-change",
        ...invalid,
      }),
    ).toThrow(HonuaRealtimeResumeError);
  });

  it.each(["status", "error", "heartbeat"])(
    "gives the current-server operation discriminator precedence over colliding %s type",
    (type) => {
      expect(() =>
        decodeHonuaServerRealtimeEvent({
          type,
          status: "connected",
          terminal: false,
          operation: "truncate",
          serviceId: "incidents",
          featureId: "1",
          geometry: null,
          attributes: {},
        }),
      ).toThrow(/current feature-change operation/u);
    },
  );

  it("decodes a valid current-server change despite a colliding generic type", () => {
    const event = decodeHonuaServerRealtimeEvent({
      type: "status",
      status: "connected",
      operation: "update",
      serviceId: "incidents",
      featureId: "1",
      geometry: null,
      attributes: { objectid: 1, status: "assigned" },
    });

    expect(event).toMatchObject({
      type: "delta",
      upserts: [
        {
          id: "1",
          sourceId: "incidents",
          feature: {
            type: "Feature",
            id: "1",
            geometry: null,
            properties: { objectid: 1, status: "assigned" },
          },
        },
      ],
    });
  });

  it("normalizes current honua-server connection statuses to the public live status", () => {
    expect(
      decodeHonuaServerRealtimeEvent({
        type: "status",
        status: "connected",
        sessionId: "session-1",
      }),
    ).toEqual({
      type: "status",
      status: "live",
      sessionId: "session-1",
    });
  });

  it("renders the batched baseline frame's numeric event-store cursor as the checkpointed string", () => {
    // honua-server's `mode=snapshot-then-delta` baseline carries `cursor` as a
    // JSON number (the global event-store position), while the SDK's resume
    // gate checkpoints the string form. Without this normalization a batched
    // baseline fails closed as a checkpoint conflict instead of resuming.
    const event = decodeHonuaServerRealtimeEvent({
      type: "snapshot",
      snapshotId: "9f2",
      subscriptionId: "alpha",
      sequence: 0,
      cursor: 4821,
      reason: "initial",
      replace: true,
      layerIds: [0],
      featureCount: 0,
      complete: true,
      features: [],
    });
    expect(event).toMatchObject({ type: "snapshot", sequence: 0, cursor: "4821" });
  });

  it("leaves a malformed numeric cursor for the resume gate to report", () => {
    const event = decodeHonuaServerRealtimeEvent({ type: "snapshot", sequence: 0, cursor: -1, features: [] });
    expect(event).toMatchObject({ cursor: -1 });
  });

  it("passes through status envelopes unchanged", () => {
    const event = decodeHonuaServerRealtimeEvent({
      type: "status",
      status: "reconnecting",
      reason: "server-restart",
    });
    expect(event).toEqual({ type: "status", status: "reconnecting", reason: "server-restart" });
  });

  it("normalizes server error envelopes through the tagged realtime redaction boundary", () => {
    const rawError = {
      authorization: "Bearer raw-header-secret",
      token: "raw-token-secret",
      payload: { owner: "raw-payload-secret" },
      filter: "owner = 'raw-filter-secret'",
    };
    const event = decodeHonuaServerRealtimeEvent({
      type: "error",
      terminal: true,
      code: "AUTH",
      cursor: "raw-cursor-secret",
      error: rawError,
    });

    expect(event.type).toBe("error");
    if (event.type !== "error") throw new Error("expected a realtime error event");
    expect(event.error).toBeInstanceOf(HonuaRealtimeResumeError);
    expect(isHonuaError(event.error)).toBe(true);
    expect(event.error).toMatchObject({
      code: "invalid-event",
      sdkCode: "realtime.protocol.terminal",
      retryable: false,
    });
    expect(event.error).not.toHaveProperty("cause");
    expect(event.error).not.toBe(rawError);
    expect(event).toMatchObject({ type: "error", code: "invalid-event", terminal: true });
    expect(event).not.toHaveProperty("cursor");
    expect(event).not.toHaveProperty("authorization");
    expect(event).not.toHaveProperty("token");
    expect(event).not.toHaveProperty("payload");
    expect(event).not.toHaveProperty("filter");
    const serialized = JSON.stringify(event);
    for (const secret of [
      "raw-cursor-secret",
      "raw-header-secret",
      "raw-token-secret",
      "raw-payload-secret",
      "raw-filter-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("throws on a malformed feature-change envelope", () => {
    expect(() => decodeHonuaServerRealtimeEvent({ kind: "feature-change", changes: [] })).toThrow();
    expect(() => decodeHonuaServerRealtimeEvent({ kind: "feature-change", changes: [null] })).toThrow(
      HonuaRealtimeResumeError,
    );
    expect(() =>
      decodeHonuaServerRealtimeEvent({ kind: "feature-change", changes: [{ op: "update", feature: {} }] }),
    ).toThrow();
  });

  it("wires the preset hooks through createHonuaServerRealtimeSubscription", () => {
    let created: MockRealtimeEventSource | undefined;
    const transport = createHonuaServerRealtimeSubscription<{ status: string }>({
      baseUrl: "https://honua.example/",
      eventSourceFactory: (url) => {
        created = new MockRealtimeEventSource(url);
        return created;
      },
    });

    const events: Array<RealtimeFeatureEvent<{ status: string }>> = [];
    const observer: RealtimeFeatureObserver<{ status: string }> = {
      next: (event) => events.push(event),
      error: () => {},
      complete: () => {},
    };

    const handle = transport.subscribe({ sourceId: "incidents", layerId: "0" }, observer);

    expect(created).toBeDefined();
    const requestUrl = new URL(created?.url ?? "", "http://honua.local");
    expect(requestUrl.pathname).toBe(HONUA_SERVER_STREAMING_FEATURES_PATH);
    expect(requestUrl.searchParams.get("serviceId")).toBe("incidents");
    expect(requestUrl.searchParams.get("layers")).toBe("0");

    created?.message({
      kind: "feature-change",
      serviceId: "incidents",
      op: "insert",
      featureId: 1,
      feature: { status: "active" },
    });

    const delta = events.find((event) => event.type === "delta");
    expect(delta).toBeDefined();
    handle.close();
  });

  it("exposes preset hooks as a spreadable options bundle", () => {
    const preset = honuaServerRealtimePreset<{ status: string }>();
    expect(typeof preset.encodeRequest).toBe("function");
    expect(typeof preset.decodeEvent).toBe("function");
  });
});
