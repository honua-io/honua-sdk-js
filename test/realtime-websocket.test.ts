import { describe, expect, it, vi } from "vitest";

import { HonuaRealtimeResumeError, createRealtimeWebSocketTransport } from "../src/realtime/index.js";
import type { RealtimeWebSocket, RealtimeWebSocketCloseEvent } from "../src/realtime/index.js";

class MockRealtimeWebSocket implements RealtimeWebSocket {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: RealtimeWebSocketCloseEvent) => void) | null = null;
  public readyState = 0;
  public closed = false;
  public readonly sent: string[] = [];

  public constructor(
    public readonly url: string,
    public readonly protocols?: string | ReadonlyArray<string>,
  ) {}

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason, wasClean: true });
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  public message(payload: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  public fail(): void {
    this.onerror?.(new Event("error"));
  }

  public remoteClose(code: number, wasClean = false): void {
    this.readyState = 3;
    this.onclose?.({ code, wasClean });
  }
}

describe("realtime WebSocket transport", () => {
  it("encodes the default subscribe query params onto the connection URL", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url, protocols) {
        socket = new MockRealtimeWebSocket(url, protocols);
        return socket;
      },
    });

    transport.subscribe(
      { sourceId: "incidents", layerId: "active", resumeFrom: { cursor: "c1" } },
      { next: vi.fn(), error: vi.fn(), complete: vi.fn() },
    );

    expect(socket?.url).toContain("/api/v1/realtime/events?");
    expect(socket?.url).toContain("sourceId=incidents");
    expect(socket?.url).toContain("layerId=active");
    expect(socket?.url).toContain("cursor=c1");
  });

  it("rewrites an http(s) URL to the matching ws(s) scheme", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
    });
    transport.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    expect(socket?.url.startsWith("wss://honua.example")).toBe(true);
  });

  it("emits a live status on open and decodes default JSON envelopes", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const next = vi.fn();
    const transport = createRealtimeWebSocketTransport<{ status: string }>({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
    });

    transport.subscribe({ sourceId: "incidents" }, { next, error: vi.fn(), complete: vi.fn() });
    socket?.open();
    expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ type: "status", status: "live" }));

    socket?.message({
      type: "upsert",
      sequence: 1,
      cursor: "c1",
      feature: { sourceId: "incidents", id: 1, feature: { status: "open" } },
    });
    expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ type: "upsert", sequence: 1, cursor: "c1" }));
  });

  it("sends an encodeSubscribeMessage frame after the socket opens", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
      encodeSubscribeMessage: (request) => ({ op: "subscribe", sourceId: request.sourceId }),
    });

    transport.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    socket?.open();

    expect(socket?.sent).toEqual([JSON.stringify({ op: "subscribe", sourceId: "incidents" })]);
  });

  it("completes without an error on a clean close (code 1000)", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const next = vi.fn();
    const error = vi.fn();
    const complete = vi.fn();
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
    });

    transport.subscribe({ sourceId: "incidents" }, { next, error, complete });
    socket?.open();
    socket?.remoteClose(1000, true);

    expect(error).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("tags an unclean close as a retryable transport-gap failure", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const errors: unknown[] = [];
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
    });

    transport.subscribe(
      { sourceId: "incidents" },
      { next: vi.fn(), error: (error) => errors.push(error), complete: vi.fn() },
    );
    socket?.open();
    socket?.remoteClose(1006, false);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HonuaRealtimeResumeError);
    expect(errors[0]).toMatchObject({
      code: "transport-gap",
      sdkCode: "realtime.transport.reconnectable",
      retryable: true,
    });
  });

  it("reports a reconnecting status on a socket error without failing the subscription", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const next = vi.fn();
    const error = vi.fn();
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
    });

    transport.subscribe({ sourceId: "incidents" }, { next, error, complete: vi.fn() });
    socket?.open();
    socket?.fail();

    expect(next).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "status", status: "reconnecting", reason: "websocket-error" }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("completes a pre-aborted subscription without constructing a socket", () => {
    const controller = new AbortController();
    controller.abort("already stopped");
    const factory = vi.fn();
    const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory: factory,
    });

    transport.subscribe({ sourceId: "incidents", signal: controller.signal }, observer);

    expect(factory).not.toHaveBeenCalled();
    expect(observer.complete).toHaveBeenCalledTimes(1);
    expect(observer.error).not.toHaveBeenCalled();
  });

  it("closes the socket cleanly when the caller aborts", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const controller = new AbortController();
    const complete = vi.fn();
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
    });

    transport.subscribe(
      { sourceId: "incidents", signal: controller.signal },
      { next: vi.fn(), error: vi.fn(), complete },
    );
    socket?.open();
    controller.abort("caller stopped");

    expect(socket?.closed).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("tags synchronous initialization failures and preserves their local cause without leaking it", () => {
    const cause = new Error("factory-local-secret");
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory() {
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
    let socket: MockRealtimeWebSocket | undefined;
    const cause = new Error("observer-callback-secret");
    const errors: unknown[] = [];
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
    });

    transport.subscribe(
      { sourceId: "incidents" },
      {
        next(event) {
          if (event.type === "heartbeat") throw cause;
        },
        error(error) {
          errors.push(error);
        },
        complete: vi.fn(),
      },
    );
    socket?.open();
    socket?.message({ type: "heartbeat", receivedAt: 1 });

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

  it("tags malformed payloads as invalid-event without throwing out of the message handler", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const errors: unknown[] = [];
    const transport = createRealtimeWebSocketTransport({
      url: "https://honua.example/api/v1/realtime/events",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
    });

    transport.subscribe(
      { sourceId: "incidents" },
      { next: vi.fn(), error: (error) => errors.push(error), complete: vi.fn() },
    );
    socket?.open();
    socket?.onmessage?.(new MessageEvent("message", { data: "not json" }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "invalid-event", sdkCode: "realtime.protocol.terminal", retryable: false });
  });

  it("supports custom encodeRequest and decodeEvent hooks", () => {
    let socket: MockRealtimeWebSocket | undefined;
    const next = vi.fn();
    const transport = createRealtimeWebSocketTransport<{ status: string }>({
      url: "https://honua.example/stream",
      webSocketFactory(url) {
        socket = new MockRealtimeWebSocket(url);
        return socket;
      },
      encodeRequest: (url, request) => url.searchParams.set("serviceId", String(request.sourceId)),
      decodeEvent: (payload) => ({
        type: "delta",
        sequence: 1,
        upserts: [{ id: 1, feature: { status: "open" }, sourceId: (payload as { service: string }).service }],
      }),
    });

    transport.subscribe({ sourceId: "incidents" }, { next, error: vi.fn(), complete: vi.fn() });
    expect(socket?.url).toContain("serviceId=incidents");

    socket?.open();
    socket?.message({ service: "incidents" });
    expect(next).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "delta",
        upserts: [{ id: 1, feature: { status: "open" }, sourceId: "incidents" }],
      }),
    );
  });

  it("constructs the global WebSocket with `new` when no webSocketFactory is provided", () => {
    const constructed: GlobalWebSocketDouble[] = [];
    class GlobalWebSocketDouble implements RealtimeWebSocket {
      public onopen: ((event: Event) => void) | null = null;
      public onmessage: ((event: MessageEvent<string>) => void) | null = null;
      public onerror: ((event: Event) => void) | null = null;
      public onclose: ((event: RealtimeWebSocketCloseEvent) => void) | null = null;
      public readyState = 0;
      public constructor(
        public readonly url: string,
        public readonly protocols?: string | ReadonlyArray<string>,
      ) {
        constructed.push(this);
      }
      public send(): void {}
      public close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", GlobalWebSocketDouble);
    try {
      const transport = createRealtimeWebSocketTransport({ url: "https://honua.example/api/v1/realtime/events" });
      transport.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
      expect(constructed).toHaveLength(1);
      expect(constructed[0]?.url).toContain("sourceId=incidents");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws an actionable error when no WebSocket implementation is available", () => {
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      const transport = createRealtimeWebSocketTransport({ url: "https://honua.example/api/v1/realtime/events" });
      expect(() =>
        transport.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() }),
      ).toThrow(HonuaRealtimeResumeError);
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = original;
    }
  });
});
