import { afterEach, describe, expect, test, vi } from "vitest";

import { HonuaClient } from "../../src/core/client.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  type HonuaMapRuntime,
  MAP_PACKAGE_REALTIME_CHANNEL_V1,
  type MapPackageRealtimeEventSource,
  type MapPackageRealtimeObserver,
  type MapPackageRealtimeSubscribeRequest,
  type MapPackageRealtimeTransport,
  type MapPackageWatchEvent,
  mapPackageFingerprint,
  watchMapPackage,
} from "../../src/runtime/index.js";

class MockMapPackageEventSource implements MapPackageRealtimeEventSource {
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
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watchMapPackage realtime", () => {
  test("applies realtime package updates once and ignores duplicate update messages", async () => {
    const initial = makePackage();
    const next = makePackage({
      updatedAt: "2026-05-11T00:01:00.000Z",
      mapSpec: styleWithFill("#0055ff"),
    });
    const events: MapPackageWatchEvent[] = [];
    let observer: MapPackageRealtimeObserver | undefined;
    let request: MapPackageRealtimeSubscribeRequest | undefined;
    const close = vi.fn();
    const transport: MapPackageRealtimeTransport = {
      kind: "mock",
      subscribe(nextRequest, nextObserver) {
        request = nextRequest;
        observer = nextObserver;
        return { close };
      },
    };
    const updatePackage = vi.fn(async () => {});
    const runtime = { mapPackage: initial, updatePackage } as unknown as HonuaMapRuntime;

    const handle = watchMapPackage("pkg-001", {
      client: makeClient(vi.fn()),
      initialPackage: initial,
      runtime,
      immediate: false,
      realtime: { transport, reconnect: false },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(request?.resumeFrom?.fingerprint).toBe(mapPackageFingerprint(initial));
    observer?.connected({ transport: "mock", channel: MAP_PACKAGE_REALTIME_CHANNEL_V1 });
    observer?.message({
      type: "updated",
      packageId: "pkg-001",
      eventId: "evt-2",
      sequence: 2,
      update: { kind: "package", mapPackage: next },
    });
    await flushPromises();
    observer?.message({
      type: "updated",
      packageId: "pkg-001",
      eventId: "evt-2",
      sequence: 2,
      update: { kind: "package", mapPackage: next },
    });
    await flushPromises();

    expect(updatePackage).toHaveBeenCalledTimes(1);
    expect(updatePackage).toHaveBeenCalledWith(next);
    expect(events.map((event) => event.type)).toContain("connected");
    expect(events.filter((event) => event.type === "updated")).toHaveLength(1);

    handle.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(request?.signal.aborted).toBe(true);
  });

  test("uses an advertised SSE watch channel", async () => {
    const initial = makePackage({
      realtime: {
        mapPackageWatch: {
          channel: MAP_PACKAGE_REALTIME_CHANNEL_V1,
          transport: "sse",
          href: "/api/v1/map-packages/pkg-001/watch",
          withCredentials: true,
        },
      },
    });
    const next = makePackage({
      updatedAt: "2026-05-11T00:02:00.000Z",
      mapSpec: styleWithFill("#ff5500"),
    });
    const events: MapPackageWatchEvent[] = [];
    const sources: MockMapPackageEventSource[] = [];
    const updatePackage = vi.fn(async () => {});

    const handle = watchMapPackage("pkg-001", {
      client: makeClient(vi.fn()),
      initialPackage: initial,
      runtime: { mapPackage: initial, updatePackage } as unknown as HonuaMapRuntime,
      immediate: false,
      realtime: {
        eventSourceFactory(url, init) {
          expect(init?.withCredentials).toBe(true);
          const source = new MockMapPackageEventSource(url);
          sources.push(source);
          return source;
        },
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    const [source] = sources;
    expect(source?.url).toContain("/api/v1/map-packages/pkg-001/watch?");
    expect(source?.url).toContain(`channel=${encodeURIComponent(MAP_PACKAGE_REALTIME_CHANNEL_V1)}`);
    expect(source?.url).toContain("packageId=pkg-001");

    source?.open();
    source?.message({
      type: "updated",
      packageId: "pkg-001",
      eventId: "evt-3",
      sequence: 3,
      mapPackage: next,
    });
    await flushPromises();

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "connected", advertised: true })]));
    expect(updatePackage).toHaveBeenCalledWith(next);

    handle.dispose();
    expect(source?.closed).toBe(true);
  });

  test("falls back to polling when the realtime channel is terminal", async () => {
    const initial = makePackage();
    const next = makePackage({
      updatedAt: "2026-05-11T00:03:00.000Z",
      mapSpec: styleWithFill("#22aa66"),
    });
    const fetchFn = vi.fn(async () => jsonResponse(next));
    const events: MapPackageWatchEvent[] = [];
    let observer: MapPackageRealtimeObserver | undefined;
    const transport: MapPackageRealtimeTransport = {
      kind: "mock",
      subscribe(_request, nextObserver) {
        observer = nextObserver;
        return { close: vi.fn() };
      },
    };
    const updatePackage = vi.fn(async () => {});

    const handle = watchMapPackage("pkg-001", {
      client: makeClient(fetchFn),
      initialPackage: initial,
      runtime: { mapPackage: initial, updatePackage } as unknown as HonuaMapRuntime,
      immediate: false,
      realtime: { transport, reconnect: false },
      onEvent: (event) => {
        events.push(event);
      },
    });

    observer?.message({
      type: "error",
      packageId: "pkg-001",
      code: "AUTH",
      terminal: true,
      error: "permission denied",
    });
    await flushPromises();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(updatePackage).toHaveBeenCalledWith(next);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "fallback", mode: "polling", reason: "AUTH" }),
        expect.objectContaining({ type: "fetched" }),
        expect.objectContaining({ type: "updated" }),
      ]),
    );

    handle.dispose();
  });

  test("refetch-required messages can surface reload-required diffs", async () => {
    const initial = makePackage();
    const next = makePackage({
      updatedAt: "2026-05-11T00:04:00.000Z",
      mapSpec: {
        version: 8,
        sources: {},
        layers: [
          { id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#cccccc" } },
          { id: "parcels-line", type: "line", source: "parcels", paint: { "line-color": "#111111" } },
        ],
      },
    });
    const fetchFn = vi.fn(async () => jsonResponse(next));
    const events: MapPackageWatchEvent[] = [];
    let observer: MapPackageRealtimeObserver | undefined;
    const transport: MapPackageRealtimeTransport = {
      kind: "mock",
      subscribe(_request, nextObserver) {
        observer = nextObserver;
        return { close: vi.fn() };
      },
    };

    const handle = watchMapPackage("pkg-001", {
      client: makeClient(fetchFn),
      initialPackage: initial,
      immediate: false,
      realtime: { transport, reconnect: false },
      onEvent: (event) => {
        events.push(event);
      },
    });

    observer?.message({
      type: "reload-required",
      packageId: "pkg-001",
      eventId: "evt-4",
      sequence: 4,
      reason: "server-composed-structural-change",
    });
    await flushPromises();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reload-required",
          reason: "server-composed-structural-change",
          diff: expect.objectContaining({ incremental: false }),
        }),
        expect.objectContaining({ type: "updated", applied: false }),
      ]),
    );

    handle.dispose();
  });
});

function makePackage(overrides: Partial<HonuaMapPackage> = {}): HonuaMapPackage {
  return {
    mapPackageId: "pkg-001",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    status: "Ready",
    updatedAt: "2026-05-11T00:00:00.000Z",
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://server.example.com/rest/services/Parcels/FeatureServer/0" },
      },
    ],
    mapSpec: styleWithFill("#cccccc"),
    ...overrides,
  };
}

function styleWithFill(color: string): HonuaMapPackage["mapSpec"] {
  return {
    version: 8,
    sources: {},
    layers: [{ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": color } }],
  };
}

function makeClient(fetchFn: typeof fetch): HonuaClient {
  return new HonuaClient({ baseUrl: "https://mock.honua.test", fetchFn });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
