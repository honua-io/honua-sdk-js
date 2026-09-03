import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HonuaRealtimeResumeError,
  computeReconnectDelayMs,
  createResumableRealtimeTransport,
  createResumableServerSentEventsTransport,
  createResumableWebSocketTransport,
} from "../src/realtime/index.js";
import type {
  RealtimeFeatureEvent,
  RealtimeFeatureObserver,
  RealtimeFeatureTransport,
  RealtimeResumableTransportTelemetry,
  RealtimeResumeContextV1,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
} from "../src/realtime/index.js";
import type { RealtimeServerSentEventSource } from "../src/realtime/sse.js";
import type { RealtimeWebSocket, RealtimeWebSocketCloseEvent } from "../src/realtime/websocket.js";

interface Feature {
  readonly id: number;
  readonly status: string;
}

const context: RealtimeResumeContextV1 = {
  kind: "honua.realtime-resume-context",
  version: 1,
  sourceId: "incidents",
  queryFingerprint: "sha256:accepted-query-v1",
  sourceVersion: "incidents-snapshot-v7",
  schemaVersion: "incident-schema-v3",
  authorizationScopeFingerprint: "sha256:dispatch-read-v2",
};

interface RecordedAttempt {
  readonly request: RealtimeSubscriptionRequest;
  readonly observer: RealtimeFeatureObserver<Feature>;
  closed: boolean;
}

function createFakeTransport(): {
  transport: RealtimeFeatureTransport<Feature>;
  attempts: RecordedAttempt[];
} {
  const attempts: RecordedAttempt[] = [];
  const transport: RealtimeFeatureTransport<Feature> = {
    capabilities: { kind: "custom" },
    subscribe(request, observer): RealtimeSubscriptionHandle {
      const attempt: RecordedAttempt = { request, observer, closed: false };
      attempts.push(attempt);
      return {
        close: () => {
          attempt.closed = true;
        },
      };
    },
  };
  return { transport, attempts };
}

function snapshotEvent(sequence: number, cursor: string): RealtimeFeatureEvent<Feature> {
  return {
    type: "snapshot",
    sequence,
    cursor,
    features: [{ id: 1, sourceId: "incidents", feature: { id: 1, status: "open" } }],
  };
}

function deltaEvent(sequence: number, cursor: string): RealtimeFeatureEvent<Feature> {
  return {
    type: "delta",
    sequence,
    cursor,
    upserts: [{ id: 1, sourceId: "incidents", feature: { id: 1, status: "open" } }],
  };
}

describe("computeReconnectDelayMs", () => {
  it("grows exponentially, capped by maxDelayMs, within the [0.5x, 1x] jitter band", () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1_000 };
    for (const attempt of [0, 1, 2, 3, 10]) {
      const exponential = 100 * 2 ** attempt;
      const cap = Math.min(1_000, exponential);
      const samples = Array.from({ length: 20 }, () => computeReconnectDelayMs(policy, attempt));
      for (const delay of samples) {
        expect(delay).toBeGreaterThanOrEqual(cap * 0.5);
        expect(delay).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("falls back to defaults for missing or invalid policy fields", () => {
    expect(computeReconnectDelayMs(undefined, 0)).toBeGreaterThan(0);
    expect(computeReconnectDelayMs({ baseDelayMs: -5, maxDelayMs: Number.NaN }, 0)).toBeGreaterThan(0);
  });
});

describe("createResumableRealtimeTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Gate construction (`createResumableRealtimeSubscription`) is async, so the first raw `transport.subscribe()` call lands one microtask after `subscribe()` returns. Every test must flush that before touching `attempts[0]`. */
  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it("requests no resume position on the very first connection", async () => {
    const { transport, attempts } = createFakeTransport();
    const wrapped = createResumableRealtimeTransport(transport, { context });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    await flush();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.request.resumeFrom).toBeUndefined();
  });

  it("strips caller-supplied cursor/resumeFrom fields from the subscribe request", async () => {
    const { transport, attempts } = createFakeTransport();
    const wrapped = createResumableRealtimeTransport(transport, { context });
    wrapped.subscribe(
      { sourceId: "incidents", cursor: "caller-supplied-should-be-ignored", resumeFrom: { cursor: "also-ignored" } },
      { next: vi.fn(), error: vi.fn(), complete: vi.fn() },
    );
    await flush();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.request.cursor).toBeUndefined();
    expect(attempts[0]?.request.resumeFrom).toBeUndefined();
    expect(attempts[0]?.request.sourceId).toBe("incidents");
  });

  it("seeds the first connection's resume position from a compatible initialCheckpoint", async () => {
    const { transport, attempts } = createFakeTransport();
    const initialCheckpoint = {
      kind: "honua.realtime-checkpoint" as const,
      version: 1 as const,
      context,
      resume: { sequence: 5, cursor: "seeded-cursor" },
      recentEventIds: [],
      savedAt: "2026-07-10T00:00:00.000Z",
    };
    const wrapped = createResumableRealtimeTransport(transport, { context, initialCheckpoint });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    await flush();

    expect(attempts[0]?.request.resumeFrom).toMatchObject({ sequence: 5, cursor: "seeded-cursor" });
  });

  it("forwards applied events, heartbeats, and status events to the caller observer", async () => {
    const { transport, attempts } = createFakeTransport();
    const wrapped = createResumableRealtimeTransport(transport, { context });
    const next = vi.fn();
    wrapped.subscribe({ sourceId: "incidents" }, { next, error: vi.fn(), complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next({ type: "status", status: "live" });
    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();
    attempts[0]?.observer.next({ type: "heartbeat", receivedAt: 100 });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ type: "status", status: "live" }));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshot", sequence: 1 }));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ type: "heartbeat" }));
  });

  it("resets the reconnect budget on a healthy delivery without forcing a reconnect", async () => {
    const { transport, attempts } = createFakeTransport();
    const telemetry: RealtimeResumableTransportTelemetry[] = [];
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      onTelemetry: (event) => telemetry.push(event),
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();
    attempts[0]?.observer.next(snapshotEvent(1, "c1")); // duplicate, same sequence
    await flush();

    expect(attempts).toHaveLength(1);
    expect(telemetry.at(-1)).toMatchObject({ reconnectAttempt: 0 });
  });

  it("forces a fresh snapshot on reconnect after a retryable transport-gap failure", async () => {
    const { transport, attempts } = createFakeTransport();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      reconnect: { baseDelayMs: 100, maxDelayMs: 100 },
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();
    expect(attempts[0]?.request.resumeFrom).toBeUndefined(); // still the first connection

    attempts[0]?.observer.error(new HonuaRealtimeResumeError("transport-gap", "closed unexpectedly"));
    expect(attempts[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.request.resumeFrom).toBeUndefined();
  });

  it("forces a fresh snapshot on reconnect after a gate-detected sequence gap", async () => {
    const { transport, attempts } = createFakeTransport();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      reconnect: { baseDelayMs: 50, maxDelayMs: 50 },
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();
    // Sequence 1 -> jump straight to sequence 9: a gap the gate detects on its own.
    attempts[0]?.observer.next(deltaEvent(9, "c9"));
    await flush();

    await vi.advanceTimersByTimeAsync(50);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.request.resumeFrom).toBeUndefined();
  });

  it("deduplicates a burst of resnapshot-required deliveries into exactly one reconnect", async () => {
    const { transport, attempts } = createFakeTransport();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      reconnect: { baseDelayMs: 50, maxDelayMs: 50 },
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();

    // A burst: the first delta jumps the sequence, a gap the gate detects
    // synchronously inside `enqueue()` (before any microtask boundary), so
    // by the time this call returns the gate is already
    // `resnapshot-required`. The next two deltas land in the same
    // synchronous tick and are rejected by that same phase check. All three
    // deliveries resolve `resnapshot-required` and each calls
    // `scheduleReconnect` before the reconnect delay has had any chance to
    // fire.
    attempts[0]?.observer.next(deltaEvent(9, "c9"));
    attempts[0]?.observer.next(deltaEvent(10, "c10"));
    attempts[0]?.observer.next(deltaEvent(11, "c11"));
    await flush();

    // Only the single reconnect timer from the first call should be pending
    // -- no reconnect has fired yet.
    expect(attempts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);
    // Exactly one reconnect fired. Piled-up, undeduplicated timers from the
    // burst would have produced two or three extra connection attempts here.
    expect(attempts).toHaveLength(2);

    // No dangling reconnect timers were left over from the deduplicated
    // burst.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(2);
  });

  it("upgrades a delta-mode subscription to request a fresh snapshot on a cursor-expired/transport-gap reconnect", async () => {
    const { transport, attempts } = createFakeTransport();
    const next = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      reconnect: { baseDelayMs: 25, maxDelayMs: 25 },
    });
    wrapped.subscribe({ sourceId: "incidents", mode: "delta" }, { next, error: vi.fn(), complete: vi.fn() });
    await flush();
    expect(attempts[0]?.request.mode).toBe("delta");

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();

    attempts[0]?.observer.error(new HonuaRealtimeResumeError("cursor-expired", "cursor no longer valid"));
    expect(attempts[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(25);

    // Reconnecting still in pure `delta` mode after a cursor-expired
    // resnapshot would never receive the `snapshot` event the gate requires
    // to leave `resnapshot-required` (`resumable.ts`'s `enqueue` rejects
    // every other event type in that phase), silently losing the gap's data
    // and everything delivered after it. The wrapper must upgrade the mode
    // to request a fresh snapshot, not just drop `resumeFrom`.
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.request.mode).toBe("snapshot-then-delta");
    expect(attempts[1]?.request.resumeFrom).toBeUndefined();

    // And delivery actually recovers: a replacement snapshot on the new
    // connection clears `resnapshot-required` and subsequent deltas apply
    // normally instead of being dropped forever.
    attempts[1]?.observer.next(snapshotEvent(20, "c20"));
    await flush();
    attempts[1]?.observer.next(deltaEvent(21, "c21"));
    await flush();

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshot", sequence: 20 }));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ type: "delta", sequence: 21 }));
  });

  it("treats a non-terminal decoded error event as a transport gap, forwarding it and reconnecting fresh", async () => {
    const { transport, attempts } = createFakeTransport();
    const next = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next, error: vi.fn(), complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();
    const decodedError = new HonuaRealtimeResumeError("transport-gap", "server reported a gap");
    attempts[0]?.observer.next({ type: "error", error: decodedError, terminal: false });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ type: "error", terminal: false }));
    await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.request.resumeFrom).toBeUndefined();
  });

  it("treats a terminal decoded error event as fail-closed without reconnecting", async () => {
    const { transport, attempts } = createFakeTransport();
    const error = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, { context });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error, complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();
    const terminalError = new HonuaRealtimeResumeError("invalid-event", "unrecoverable protocol failure");
    attempts[0]?.observer.next({ type: "error", error: terminalError, terminal: true });

    expect(error).toHaveBeenCalledWith(terminalError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
  });

  it("fails closed immediately on a non-retryable transport error without scheduling a reconnect", async () => {
    const { transport, attempts } = createFakeTransport();
    const error = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, { context });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error, complete: vi.fn() });
    await flush();

    const cause = new HonuaRealtimeResumeError("invalid-event", "malformed payload");
    attempts[0]?.observer.error(cause);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(cause);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
  });

  it("fails closed on an unrecognized (non-SDK) error rather than guessing it is retryable", async () => {
    const { transport, attempts } = createFakeTransport();
    const error = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, { context });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error, complete: vi.fn() });
    await flush();

    attempts[0]?.observer.error(new Error("unknown failure"));

    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
  });

  it("gives up and fails closed after exhausting the configured reconnect attempts", async () => {
    const { transport, attempts } = createFakeTransport();
    const error = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      reconnect: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error, complete: vi.fn() });
    await flush();

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const attempt = attempts.at(-1);
      attempt?.observer.error(new HonuaRealtimeResumeError("transport-gap", "closed"));
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ sdkCode: "realtime.protocol.terminal", retryable: false }),
    );
    // Attempt 1 (initial) + 2 reconnects = 3 total connection attempts, then fail closed.
    expect(attempts).toHaveLength(3);
  });

  it("treats prolonged silence past heartbeatTimeoutMs as a transport gap and reconnects fresh", async () => {
    const { transport, attempts } = createFakeTransport();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      heartbeatTimeoutMs: 1_000,
      reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000); // heartbeat timeout fires
    await vi.advanceTimersByTimeAsync(10); // reconnect delay

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.request.resumeFrom).toBeUndefined();
  });

  it("bounds pending delivery and forces a fresh snapshot on queue overflow, never dropping silently", async () => {
    const { transport, attempts } = createFakeTransport();
    const applied: number[] = [];
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      maxPendingEvents: 2,
      reconnect: { baseDelayMs: 5, maxDelayMs: 5 },
    });
    const next = vi.fn((event: RealtimeFeatureEvent<Feature>) => {
      if (event.sequence !== undefined) applied.push(event.sequence);
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next, error: vi.fn(), complete: vi.fn() });
    await flush();

    // Fire a burst of sequenced events synchronously, faster than the
    // single-flight gate can drain its queue, to exceed maxPendingEvents.
    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    attempts[0]?.observer.next(deltaEvent(2, "c2"));
    attempts[0]?.observer.next(deltaEvent(3, "c3"));
    attempts[0]?.observer.next(deltaEvent(4, "c4"));
    await flush();
    await vi.advanceTimersByTimeAsync(5);

    // Every accepted event was applied exactly once (no silent drop); once
    // the bound was exceeded, delivery required a fresh reconnect.
    expect(new Set(applied).size).toBe(applied.length);
    expect(applied.length).toBeGreaterThan(0);
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.at(-1)?.request.resumeFrom).toBeUndefined();
  });

  it("never leaks a raw cursor, watermark, or delta-token through telemetry", async () => {
    const { transport, attempts } = createFakeTransport();
    const telemetry: RealtimeResumableTransportTelemetry[] = [];
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      onTelemetry: (event) => telemetry.push(event),
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "super-secret-cursor-value"));
    await flush();

    expect(telemetry.length).toBeGreaterThan(0);
    const withCheckpoint = telemetry.find((entry) => entry.checkpoint !== undefined);
    expect(withCheckpoint?.checkpoint?.resume.cursor).toMatch(/^sha256:/);
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain("super-secret-cursor-value");
    expect(withCheckpoint?.authority).toMatchObject({ state: "live", authoritative: true });
  });

  it("is idempotent under repeated close() and stops timers, the connection, and the gate", async () => {
    const { transport, attempts } = createFakeTransport();
    const complete = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
    });
    const handle = wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();

    handle.close();
    handle.close(); // idempotent
    expect(attempts[0]?.closed).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);

    // No further reconnect should fire after disposal.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
  });

  it("completes a pre-aborted subscription without opening a connection", async () => {
    const { transport, attempts } = createFakeTransport();
    const controller = new AbortController();
    controller.abort("already stopped");
    const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    const wrapped = createResumableRealtimeTransport(transport, { context });

    wrapped.subscribe({ sourceId: "incidents", signal: controller.signal }, observer);
    await flush();

    expect(attempts).toHaveLength(0);
    expect(observer.complete).toHaveBeenCalledTimes(1);
    expect(observer.error).not.toHaveBeenCalled();
  });

  it("propagates external AbortSignal cancellation as an error-free, idempotent completion", async () => {
    const { transport, attempts } = createFakeTransport();
    const controller = new AbortController();
    const complete = vi.fn();
    const error = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, { context });
    wrapped.subscribe({ sourceId: "incidents", signal: controller.signal }, { next: vi.fn(), error, complete });
    await flush();

    attempts[0]?.observer.next(snapshotEvent(1, "c1"));
    await flush();

    controller.abort("caller navigated away");

    expect(attempts[0]?.closed).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
  });

  it("fails closed when the checkpoint store rejects the initial load", async () => {
    const { transport, attempts } = createFakeTransport();
    const error = vi.fn();
    const wrapped = createResumableRealtimeTransport(transport, {
      context,
      checkpointStore: {
        load: () => Promise.reject(new Error("store unavailable")),
        save: () => Promise.resolve(),
      },
    });
    wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error, complete: vi.fn() });
    await flush();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toBeInstanceOf(HonuaRealtimeResumeError);
    expect(attempts).toHaveLength(0);
  });
});

describe("createResumableServerSentEventsTransport / createResumableWebSocketTransport", () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  class MockEventSource implements RealtimeServerSentEventSource {
    public onopen: ((event: Event) => void) | null = null;
    public onmessage: ((event: MessageEvent<string>) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public readyState = 0;
    public constructor(public readonly url: string) {}
    public close(): void {
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

  it("composes the SSE wire adapter with bounded resumable delivery", async () => {
    let source: MockEventSource | undefined;
    const next = vi.fn();
    const transport = createResumableServerSentEventsTransport<Feature>(
      {
        url: "https://honua.example/api/v1/realtime/events",
        eventSourceFactory: (url) => {
          source = new MockEventSource(url);
          return source;
        },
      },
      { context },
    );

    transport.subscribe({ sourceId: "incidents" }, { next, error: vi.fn(), complete: vi.fn() });
    await flushMicrotasks();
    source?.open();
    source?.message({
      type: "snapshot",
      sequence: 1,
      cursor: "c1",
      operationInstanceId: "opinst-1",
      correlationId: "corr-1",
      auditId: "audit-1",
      proposalId: "proposal-1",
      features: [{ id: 1, feature: { id: 1, status: "open" } }],
    });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "snapshot",
        sequence: 1,
        operationInstanceId: "opinst-1",
        correlationId: "corr-1",
        auditId: "audit-1",
        proposalId: "proposal-1",
      }),
    );
  });

  class MockWebSocket implements RealtimeWebSocket {
    public onopen: ((event: Event) => void) | null = null;
    public onmessage: ((event: MessageEvent<string>) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public onclose: ((event: RealtimeWebSocketCloseEvent) => void) | null = null;
    public constructor(public readonly url: string) {}
    public send(): void {}
    public close(): void {}
    public open(): void {
      this.onopen?.(new Event("open"));
    }
    public message(payload: unknown): void {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
    }
  }

  it("composes the WebSocket wire adapter with bounded resumable delivery", async () => {
    let socket: MockWebSocket | undefined;
    const next = vi.fn();
    const transport = createResumableWebSocketTransport<Feature>(
      {
        url: "https://honua.example/api/v1/realtime/events",
        webSocketFactory: (url) => {
          socket = new MockWebSocket(url);
          return socket;
        },
      },
      { context },
    );

    transport.subscribe({ sourceId: "incidents" }, { next, error: vi.fn(), complete: vi.fn() });
    await flushMicrotasks();
    socket?.open();
    socket?.message({
      type: "snapshot",
      sequence: 1,
      cursor: "c1",
      features: [{ id: 1, feature: { id: 1, status: "open" } }],
    });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshot", sequence: 1 }));
  });
});
