/**
 * Realtime (Server-Sent Events) integration coverage. Exercises the SDK's
 * `@honua/sdk-js/realtime` transport against honua-server's
 * `/api/v1/streaming/features` endpoint:
 *
 *   1. subscribe over SSE and confirm the connection goes live (bounded wait),
 *   2. decode any server feature-change envelope through the honua-server
 *      preset decoder,
 *   3. surface a `reconnecting` status when the stream drops and derive a
 *      resume checkpoint — the mechanism a client uses to resume after a drop.
 *
 * Node 20 has no global `EventSource`, so the suite supplies a small fetch-based
 * `eventSourceFactory` (the exact extension point the transport exposes for
 * non-browser runtimes) — the SDK's `src/realtime` decode / status / reconnect
 * logic is what is under test, not a browser EventSource.
 *
 * The live subscribe/decode tests gate on the server actually publishing the
 * streaming endpoint (skip with an explicit reason otherwise); the
 * reconnect/resume test drives the transport deterministically and always runs
 * when the lane is configured, so the surface never silently no-ops.
 *
 * All waits are bounded and event-driven — the suite resolves as soon as the
 * expected event arrives and never sleeps a fixed interval.
 *
 * @module
 */

import { expect, it } from "vitest";
import {
  HONUA_SERVER_STREAMING_FEATURES_PATH,
  createHonuaServerRealtimeSubscription,
  emptyRealtimeFeatureState,
  realtimeResumeCheckpoint,
  reduceRealtimeFeatureState,
} from "../../../src/realtime/index.js";
import type {
  RealtimeFeatureEvent,
  RealtimeFeatureObserver,
  RealtimeServerSentEventSource,
  RealtimeServerSentEventSourceFactory,
} from "../../../src/realtime/index.js";
import { integrationSuite } from "../harness.js";

const SURFACE = "realtime";

/** Bounded window (ms) to wait for the live stream to open / emit an event. */
const LIVE_WAIT_MS = 15_000;

integrationSuite("Realtime SSE", SURFACE, ({ config }) => {
  const streamingUrl = `${config.baseUrl.replace(/\/+$/, "")}${HONUA_SERVER_STREAMING_FEATURES_PATH}`;
  const authHeaders: Record<string, string> = {};
  if (config.apiKey) authHeaders["X-API-Key"] = config.apiKey;
  if (config.bearerToken) authHeaders.Authorization = `Bearer ${config.bearerToken}`;

  // Runtime capability probe: does the server publish an SSE streaming endpoint?
  let probe: Promise<string | undefined> | undefined;
  const probeCapability = (): Promise<string | undefined> => {
    probe ??= (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const url = new URL(streamingUrl);
        url.searchParams.set("serviceId", config.serviceId);
        url.searchParams.set("layers", String(config.layerId));
        const response = await fetch(url, {
          headers: { Accept: "text/event-stream", ...authHeaders },
          signal: controller.signal,
        });
        // Drain/close the stream immediately; we only inspect the handshake.
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404 || response.status === 405 || response.status === 501) {
          return `streaming endpoint not published (HTTP ${response.status})`;
        }
        if (!response.ok) {
          return `streaming endpoint returned HTTP ${response.status}`;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("text/event-stream")) {
          return `streaming endpoint did not negotiate text/event-stream (content-type: ${contentType || "none"})`;
        }
        return undefined;
      } catch (error) {
        return `streaming endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        clearTimeout(timeout);
      }
    })();
    return probe;
  };

  it("subscribes over SSE and reports a live connection, decoding any change [cert:realtime/subscribe#positive] [cert:realtime/subscribe#media-schema]", async (ctx) => {
    const gap = await probeCapability();
    if (gap) {
      ctx.skip(gap);
      return;
    }

    const factory: RealtimeServerSentEventSourceFactory = (url) => new FetchEventSource(url, authHeaders);
    const transport = createHonuaServerRealtimeSubscription({ url: streamingUrl, eventSourceFactory: factory });

    const events: RealtimeFeatureEvent[] = [];
    const wentLive = deferred<void>();
    const observer: RealtimeFeatureObserver = {
      next(event) {
        events.push(event);
        if (event.type === "status" && event.status === "live") wentLive.resolve();
        // A server feature-change decodes to a delta/upsert/delete/snapshot —
        // resolve early on the first real data event too.
        if (event.type === "delta" || event.type === "upsert" || event.type === "snapshot") wentLive.resolve();
      },
      error(error) {
        wentLive.reject(error instanceof Error ? error : new Error(String(error)));
      },
      complete() {},
    };

    const handle = transport.subscribe({ sourceId: config.serviceId, layerId: config.layerId }, observer);
    try {
      await withTimeout(wentLive.promise, LIVE_WAIT_MS, "SSE stream did not go live within the bounded window");
    } finally {
      handle.close();
    }

    // The synthetic `status: live` is emitted on open; any additional envelope
    // (heartbeat/snapshot/delta) proves the decoder ran on real server output.
    expect(events.some((event) => event.type === "status" && event.status === "live")).toBe(true);
    for (const event of events) {
      expect(typeof event.type).toBe("string");
    }
  });

  it("surfaces a reconnecting status and derives a resume checkpoint on a drop [cert:realtime/resume#positive] [cert:realtime/resume#media-schema]", async () => {
    // Deterministic reconnect drill: drive a controllable source so the outcome
    // does not depend on the server dropping the connection on cue. This still
    // exercises the real SDK transport (status derivation + honua-server decode
    // + reducer resume-checkpoint), just with a source the test can steer.
    const controllable = new ControllableEventSource();
    const transport = createHonuaServerRealtimeSubscription({
      url: streamingUrl,
      eventSourceFactory: () => controllable,
    });

    const events: RealtimeFeatureEvent[] = [];
    const observer: RealtimeFeatureObserver = {
      next(event) {
        events.push(event);
      },
      error() {},
      complete() {},
    };
    const handle = transport.subscribe({ sourceId: config.serviceId, layerId: config.layerId }, observer);

    // Open, then drop while still "open" (readyState !== CLOSED) so the
    // transport reports `reconnecting` rather than terminating with an error.
    controllable.readyState = 1;
    controllable.onopen?.(new Event("open"));
    controllable.readyState = 1;
    controllable.onerror?.(new Event("error"));

    // Feed one honua-server feature-change envelope and confirm it decodes to a
    // delta carrying the resume cursor/sequence a reconnect would replay from.
    const envelope = {
      serviceId: config.serviceId,
      layerId: config.layerId,
      eventId: "evt-1",
      sequence: 42,
      cursor: "cursor-42",
      watermark: "2026-07-05T00:00:00Z",
      changes: [{ op: "insert", featureId: 1001, feature: { id: 1001, name: "probe" } }],
    };
    controllable.emitMessage(JSON.stringify(envelope));

    handle.close();

    expect(events.some((event) => event.type === "status" && event.status === "live")).toBe(true);
    expect(events.some((event) => event.type === "status" && event.status === "reconnecting")).toBe(true);

    const delta = events.find((event) => event.type === "delta");
    expect(delta).toBeDefined();

    // Reduce the decoded delta into feature state and confirm a resume
    // checkpoint is derivable — the exact value a reconnect passes as
    // `resumeFrom` so the server replays from the last seen position.
    let state = emptyRealtimeFeatureState();
    for (const event of events) {
      state = reduceRealtimeFeatureState(state, event);
    }
    const checkpoint = realtimeResumeCheckpoint(state);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.cursor ?? checkpoint?.sequence).toBeDefined();
  });
});

/** A promise plus its resolve/reject handles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Reject if `promise` has not settled within `ms`. Clears its timer on settle. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Minimal fetch-based `EventSource` for Node runtimes without a global
 * `EventSource`. Implements only the surface the SDK's SSE transport consumes:
 * `onopen` / `onmessage` / `onerror` / `readyState` / `close()`. It streams the
 * response body, splits SSE frames on the blank-line delimiter, and dispatches
 * `data:` payloads. Named `event:` frames route to `addEventListener` listeners
 * (mirroring the browser), unnamed frames route to `onmessage`.
 */
class FetchEventSource implements RealtimeServerSentEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public readyState = 0; // CONNECTING
  private readonly controller = new AbortController();
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  private closed = false;

  public constructor(url: string, headers: Record<string, string>) {
    void this.connect(url, headers);
  }

  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  public removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 2; // CLOSED
    this.controller.abort();
  }

  private async connect(url: string, headers: Record<string, string>): Promise<void> {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream", ...headers },
        signal: this.controller.signal,
      });
      if (!response.ok || !response.body) {
        this.fail();
        return;
      }
      this.readyState = 1; // OPEN
      this.onopen?.(new Event("open"));

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          this.dispatchFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
      // The stream ended without the caller closing us — signal an error so the
      // transport reports `reconnecting`, matching native EventSource behavior.
      if (!this.closed) this.fail();
    } catch {
      if (!this.closed) this.fail();
    }
  }

  private dispatchFrame(frame: string): void {
    if (this.closed) return;
    let eventType = "message";
    const dataLines: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) return;
    const messageEvent = { data: dataLines.join("\n") } as MessageEvent<string>;
    if (eventType === "message") {
      this.onmessage?.(messageEvent);
      return;
    }
    for (const listener of this.listeners.get(eventType) ?? []) listener(messageEvent);
  }

  private fail(): void {
    this.readyState = 2; // CLOSED
    this.onerror?.(new Event("error"));
  }
}

/** Test-driven `EventSource` for the deterministic reconnect drill. */
class ControllableEventSource implements RealtimeServerSentEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public readyState = 0;
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  public removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public close(): void {
    this.readyState = 2;
  }

  /** Dispatch a default (`message`) frame carrying `data`. */
  public emitMessage(data: string): void {
    const event = { data } as MessageEvent<string>;
    this.onmessage?.(event);
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
}
