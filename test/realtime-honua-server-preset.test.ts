import { describe, expect, it } from "vitest";

import {
  HONUA_SERVER_STREAMING_FEATURES_PATH,
  createHonuaServerRealtimeSubscription,
  decodeHonuaServerRealtimeEvent,
  encodeHonuaServerRealtimeRequest,
  honuaServerRealtimePreset,
} from "../src/realtime/index.js";
import type {
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

  it("passes through status envelopes unchanged", () => {
    const event = decodeHonuaServerRealtimeEvent({
      type: "status",
      status: "reconnecting",
      reason: "server-restart",
    });
    expect(event).toEqual({ type: "status", status: "reconnecting", reason: "server-restart" });
  });

  it("throws on a malformed feature-change envelope", () => {
    expect(() => decodeHonuaServerRealtimeEvent({ kind: "feature-change", changes: [] })).toThrow();
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
