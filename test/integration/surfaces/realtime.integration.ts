/**
 * Realtime SSE integration coverage against honua-server's live
 * /api/v1/streaming/features endpoint.
 *
 * Certification requires decoded server data, not merely a successful
 * handshake. Resume coverage obtains a checkpoint from one live connection,
 * sends it on a second connection, and requires a non-regressing server event.
 * No synthetic EventSource may satisfy a governed certification marker.
 *
 * Node 20 has no global EventSource, so the suite uses a bounded fetch-backed
 * adapter while retaining the SDK's production decoder and transport.
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

integrationSuite("Realtime SSE", SURFACE, ({ client, config }) => {
  const streamingUrl = `${config.baseUrl.replace(/\/+$/, "")}${HONUA_SERVER_STREAMING_FEATURES_PATH}`;
  const streamingOrigin = new URL(streamingUrl).origin;
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
          redirect: "error",
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

  it("subscribes over SSE and decodes a live server data envelope [cert:realtime/subscribe#positive] [cert:realtime/subscribe#media-schema]", async (ctx) => {
    const gap = await probeCapability();
    if (gap) {
      ctx.skip(gap);
      return;
    }

    const liveUrl = new URL(streamingUrl);
    liveUrl.searchParams.set("mode", "snapshot-then-delta");
    liveUrl.searchParams.set("requestId", "sdk-certification-subscribe");
    const factory: RealtimeServerSentEventSourceFactory = (url) =>
      new FetchEventSource(url, authHeaders, streamingOrigin);
    const transport = createHonuaServerRealtimeSubscription({
      url: liveUrl.toString(),
      eventSourceFactory: factory,
    });

    const events: RealtimeFeatureEvent[] = [];
    const receivedData = deferred<RealtimeFeatureEvent>();
    const observer: RealtimeFeatureObserver = {
      next(event) {
        events.push(event);
        if (isServerDataEvent(event)) receivedData.resolve(event);
      },
      error(error) {
        receivedData.reject(error instanceof Error ? error : new Error(String(error)));
      },
      complete() {},
    };

    const handle = transport.subscribe({ sourceId: config.serviceId, layerId: config.layerId }, observer);
    let dataEvent: RealtimeFeatureEvent;
    try {
      dataEvent = await withTimeout(
        receivedData.promise,
        LIVE_WAIT_MS,
        "SSE stream did not emit a decodable server data envelope within the bounded window",
      );
    } finally {
      handle.close();
    }

    expect(events.some((event) => event.type === "status" && event.status === "live")).toBe(true);
    expect(isServerDataEvent(dataEvent)).toBe(true);
  });

  it("resumes a live server stream from an observed checkpoint [cert:realtime/resume#positive] [cert:realtime/resume#media-schema]", async (ctx) => {
    const gap = await probeCapability();
    if (gap) {
      ctx.skip(gap);
      return;
    }

    const initialUrl = new URL(streamingUrl);
    initialUrl.searchParams.set("mode", "snapshot-then-delta");
    initialUrl.searchParams.set("requestId", "sdk-certification-resume-initial");
    const initialCheckpoint = deferred<NonNullable<ReturnType<typeof realtimeResumeCheckpoint>>>();
    let initialState = emptyRealtimeFeatureState();
    const initialTransport = createHonuaServerRealtimeSubscription({
      url: initialUrl.toString(),
      eventSourceFactory: (url) => new FetchEventSource(url, authHeaders, streamingOrigin),
    });
    const initialHandle = initialTransport.subscribe(
      { sourceId: config.serviceId, layerId: config.layerId },
      {
        next(event) {
          if (!isServerDataEvent(event)) return;
          initialState = reduceRealtimeFeatureState(initialState, event);
          const checkpoint = realtimeResumeCheckpoint(initialState);
          if (checkpoint?.cursor !== undefined || checkpoint?.sequence !== undefined) {
            initialCheckpoint.resolve(checkpoint);
          }
        },
        error(error) {
          initialCheckpoint.reject(error instanceof Error ? error : new Error(String(error)));
        },
        complete() {},
      },
    );

    let checkpoint: NonNullable<ReturnType<typeof realtimeResumeCheckpoint>>;
    try {
      checkpoint = await withTimeout(
        initialCheckpoint.promise,
        LIVE_WAIT_MS,
        "initial SSE stream did not emit a resumable server checkpoint",
      );
    } finally {
      initialHandle.close();
    }

    const marker = `sdk-certification-resume-${Date.now()}`;
    const mutation = await client.applyEdits({
      serviceId: config.serviceId,
      layerId: config.layerId,
      adds: [
        {
          attributes: { name: marker },
          geometry: { x: -156.5, y: 20.8, spatialReference: { wkid: 4326 } },
        },
      ],
    });
    const addResult = mutation.addResults?.[0];
    const addedId = addResult?.objectId;
    let primaryError: unknown;
    try {
      expect(addResult?.success).toBe(true);
      expect(addedId).toBeDefined();
      if (addedId === undefined) throw new Error("controlled realtime mutation did not return an object id");

      const resumedUrl = new URL(streamingUrl);
      resumedUrl.searchParams.set("mode", "snapshot-then-delta");
      resumedUrl.searchParams.set("requestId", "sdk-certification-resume-reconnect");
      let observedRequestUrl: string | undefined;
      let resumedState = emptyRealtimeFeatureState();
      const resumedCheckpoint = deferred<NonNullable<ReturnType<typeof realtimeResumeCheckpoint>>>();
      const resumedTransport = createHonuaServerRealtimeSubscription({
        url: resumedUrl.toString(),
        eventSourceFactory: (url) => {
          observedRequestUrl = url;
          return new FetchEventSource(url, authHeaders, streamingOrigin);
        },
      });
      const resumedHandle = resumedTransport.subscribe(
        { sourceId: config.serviceId, layerId: config.layerId, resumeFrom: checkpoint },
        {
          next(event) {
            if (!isReplayOfAddedFeature(event, addedId)) return;
            resumedState = reduceRealtimeFeatureState(resumedState, event);
            const nextCheckpoint = realtimeResumeCheckpoint(resumedState);
            if (nextCheckpoint?.cursor !== undefined || nextCheckpoint?.sequence !== undefined) {
              resumedCheckpoint.resolve(nextCheckpoint);
            }
          },
          error(error) {
            resumedCheckpoint.reject(error instanceof Error ? error : new Error(String(error)));
          },
          complete() {},
        },
      );

      let nextCheckpoint: NonNullable<ReturnType<typeof realtimeResumeCheckpoint>>;
      try {
        nextCheckpoint = await withTimeout(
          resumedCheckpoint.promise,
          LIVE_WAIT_MS,
          "resumed SSE stream did not replay the controlled post-checkpoint mutation",
        );
      } finally {
        resumedHandle.close();
      }

      expect(observedRequestUrl).toBeDefined();
      const request = new URL(observedRequestUrl!);
      if (checkpoint.cursor !== undefined) {
        expect(request.searchParams.get("cursor")).toBe(checkpoint.cursor);
      }
      if (checkpoint.sequence !== undefined) {
        expect(request.searchParams.get("sequence")).toBe(String(checkpoint.sequence));
      }
      if (checkpoint.cursor !== undefined && nextCheckpoint.cursor !== undefined) {
        expect(nextCheckpoint.cursor).not.toBe(checkpoint.cursor);
      }
      if (checkpoint.sequence !== undefined && nextCheckpoint.sequence !== undefined) {
        expect(nextCheckpoint.sequence).toBeGreaterThan(checkpoint.sequence);
      }
    } catch (error) {
      primaryError = error;
    }

    let cleanupError: unknown;
    if (addedId !== undefined) {
      try {
        const cleanup = await client.applyEdits({
          serviceId: config.serviceId,
          layerId: config.layerId,
          deletes: [addedId],
        });
        expect(cleanup.deleteResults?.[0]?.success).toBe(true);
      } catch (error) {
        cleanupError = error;
      }
    }

    if (primaryError !== undefined) {
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "realtime resume certification failed and controlled-feature cleanup also failed",
          { cause: primaryError },
        );
      }
      throw primaryError;
    }
    if (cleanupError !== undefined) throw cleanupError;
  });
});

function isServerDataEvent(event: RealtimeFeatureEvent): boolean {
  return event.type === "delta" || event.type === "upsert" || event.type === "delete" || event.type === "snapshot";
}

function isReplayOfAddedFeature(event: RealtimeFeatureEvent, expectedId: unknown): boolean {
  const expected = String(expectedId);
  if (event.type === "upsert") return String(event.feature.id) === expected;
  if (event.type === "delta") {
    return event.upserts?.some((feature) => String(feature.id) === expected) === true;
  }
  return false;
}
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

  public constructor(url: string, headers: Record<string, string>, allowedOrigin: string) {
    void this.connect(url, headers, allowedOrigin);
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

  private async connect(url: string, headers: Record<string, string>, allowedOrigin: string): Promise<void> {
    try {
      const target = new URL(url);
      if (target.origin !== allowedOrigin || target.username || target.password) {
        throw new Error("SSE target must remain credential-free and on the configured deployment origin");
      }
      const response = await fetch(target, {
        headers: { Accept: "text/event-stream", ...headers },
        redirect: "error",
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
        let boundary = /(?:\r\n|\r|\n){2}/.exec(buffer);
        while (boundary) {
          this.dispatchFrame(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
          boundary = /(?:\r\n|\r|\n){2}/.exec(buffer);
        }
      }
      // The stream ended without the caller closing us â€” signal an error so the
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
    for (const line of frame.split(/\r\n|\r|\n/)) {
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
