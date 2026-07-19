/**
 * Raw WebSocket wire transport for `@honua/sdk-js/realtime`. Mirrors
 * `sse.ts`'s adapter shape (subscribe params encoded onto the connection URL,
 * default JSON event decoding, `HonuaRealtimeResumeError` failure tagging)
 * so the two transports are interchangeable everywhere a
 * `RealtimeFeatureTransport` is expected, including
 * {@link "./resumable-transport.js".createResumableRealtimeTransport}.
 *
 * This module opens exactly one socket per `subscribe()` call and never
 * reconnects on its own — reconnect/backoff, bounded queueing, and resume
 * ownership live in `resumable-transport.ts` (#557), matching the resumable
 * delivery gate's explicit non-goal ("the gate never reconnects a
 * transport itself").
 *
 * @module
 */

import { encodeDefaultRealtimeRequest } from "./sse.js";
import type {
  RealtimeFeatureEvent,
  RealtimeFeatureObserver,
  RealtimeFeatureTransport,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
} from "./types.js";
import { decodeDefaultRealtimeEnvelope, normalizeRealtimeErrorEvent, realtimeFailure } from "./wire.js";

/**
 * Minimal WebSocket surface the transport depends on. The global `WebSocket`
 * constructor (browsers, and Node's built-in client since Node 22) already
 * satisfies this; pass `webSocketFactory` to supply a polyfill or a mock in
 * tests without adding a runtime dependency.
 */
export interface RealtimeWebSocket {
  readonly readyState?: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: RealtimeWebSocketCloseEvent) => void) | null;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

/** Subset of `CloseEvent` the transport reads; avoids depending on the DOM lib for `wasClean`. */
export interface RealtimeWebSocketCloseEvent {
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

export type RealtimeWebSocketFactory = (
  url: string,
  protocols: string | ReadonlyArray<string> | undefined,
) => RealtimeWebSocket;

export interface RealtimeWebSocketTransportOptions<TFeature = unknown> {
  readonly url: string;
  readonly protocols?: string | ReadonlyArray<string>;
  readonly webSocketFactory?: RealtimeWebSocketFactory;
  readonly encodeRequest?: (url: URL, request: RealtimeSubscriptionRequest) => void;
  readonly decodeEvent?: (payload: unknown) => RealtimeFeatureEvent<TFeature>;
  /**
   * Sent as a single JSON text frame immediately after the socket opens, for
   * servers that expect an explicit subscribe message instead of (or in
   * addition to) URL query parameters. The default transport never sends a
   * subscribe frame on its own.
   */
  readonly encodeSubscribeMessage?: (request: RealtimeSubscriptionRequest) => unknown;
  /**
   * WebSocket close codes treated as a normal, non-reconnectable end of the
   * stream rather than a `transport-gap` failure. @default [1000]
   */
  readonly cleanCloseCodes?: ReadonlyArray<number>;
}

const DEFAULT_CLEAN_CLOSE_CODES: ReadonlyArray<number> = [1000];

export function createRealtimeWebSocketTransport<TFeature = unknown>(
  options: RealtimeWebSocketTransportOptions<TFeature>,
): RealtimeFeatureTransport<TFeature> {
  return {
    capabilities: {
      kind: "websocket",
      resumeModes: ["cursor", "watermark", "timestamp", "sequence", "delta-token"],
      emitsHeartbeats: true,
      emitsWatermarks: true,
    },
    subscribe(request, observer): RealtimeSubscriptionHandle {
      // Mirrors sse.ts: a signal already aborted at subscribe time will never
      // fire its "abort" listener, so bail out before opening a socket that
      // would otherwise leak.
      if (request.signal?.aborted) {
        observer.complete();
        return { close: () => {} };
      }
      let socket: RealtimeWebSocket;
      try {
        const url = new URL(options.url, "http://honua.local");
        encodeDefaultRealtimeRequest(url, request);
        options.encodeRequest?.(url, request);
        socket = createSocket(resolveWebSocketUrl(options.url, url), options);
      } catch (cause) {
        throw realtimeFailure("delivery-failed", "Unable to initialize the realtime WebSocket transport.", cause);
      }
      let closed = false;

      const emitPayload = (payload: string): void => {
        if (closed || payload.trim() === "") return;
        let event: RealtimeFeatureEvent<TFeature>;
        try {
          const decoded = (options.decodeEvent ?? decodeDefaultRealtimeEnvelope<TFeature>)(JSON.parse(payload));
          event = normalizeRealtimeErrorEvent(decoded);
        } catch (cause) {
          observer.error(realtimeFailure("invalid-event", "Realtime WebSocket payload decoding failed.", cause));
          return;
        }
        try {
          observer.next(event);
        } catch (cause) {
          observer.error(realtimeFailure("consumer-failed", "Realtime event observer rejected delivery.", cause));
        }
      };

      socket.onopen = () => {
        if (closed) return;
        observer.next({ type: "status", status: "live", receivedAt: Date.now() });
        if (options.encodeSubscribeMessage) {
          try {
            socket.send(JSON.stringify(options.encodeSubscribeMessage(request)));
          } catch (cause) {
            observer.error(
              realtimeFailure("delivery-failed", "Unable to send the realtime WebSocket subscribe message.", cause),
            );
          }
        }
      };
      socket.onmessage = (event) => emitPayload(event.data);
      socket.onerror = () => {
        if (!closed)
          observer.next({ type: "status", status: "reconnecting", reason: "websocket-error", receivedAt: Date.now() });
      };
      socket.onclose = (event) => {
        if (closed) return;
        const cleanCodes = options.cleanCloseCodes ?? DEFAULT_CLEAN_CLOSE_CODES;
        const clean = event.wasClean !== false && event.code !== undefined && cleanCodes.includes(event.code);
        closed = true;
        request.signal?.removeEventListener("abort", abortListener);
        detachSocket(socket);
        if (clean) {
          observer.complete();
          return;
        }
        observer.error(
          realtimeFailure(
            "transport-gap",
            `Realtime WebSocket transport closed unexpectedly (code ${event.code ?? "unknown"}).`,
            event,
          ),
        );
      };

      const abortListener = () => closeSocket();
      request.signal?.addEventListener("abort", abortListener, { once: true });

      function closeSocket(): void {
        if (closed) return;
        closed = true;
        request.signal?.removeEventListener("abort", abortListener);
        detachSocket(socket);
        try {
          socket.close(1000, "Subscription closed by caller.");
        } catch {
          // Closing an already-broken socket is not itself a delivery
          // failure; the caller asked to stop, and stop is what happens.
        }
        observer.complete();
      }

      return {
        close: closeSocket,
      };
    },
  };
}

function detachSocket(socket: RealtimeWebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}

function createSocket<TFeature>(url: string, options: RealtimeWebSocketTransportOptions<TFeature>): RealtimeWebSocket {
  if (options.webSocketFactory) {
    return options.webSocketFactory(url, options.protocols);
  }
  // The global `WebSocket` is a constructor; guard rather than assume it is
  // present so Node runtimes without a global WebSocket (or older Node) get
  // an actionable error instead of a silent `undefined` crash, mirroring the
  // `EventSource` guard in sse.ts. No runtime dependency is added for this:
  // `WebSocket` is a web-standard global, optionally polyfilled by callers.
  const WebSocketCtor = (
    globalThis as unknown as {
      WebSocket?: new (url: string, protocols?: string | ReadonlyArray<string>) => RealtimeWebSocket;
    }
  ).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available; provide webSocketFactory for this runtime.");
  }
  return new WebSocketCtor(url, options.protocols);
}

function resolveWebSocketUrl(input: string, url: URL): string {
  if (
    input.startsWith("ws://") ||
    input.startsWith("wss://") ||
    input.startsWith("http://") ||
    input.startsWith("https://")
  ) {
    // A WebSocket URL must use the ws(s) scheme; rewrite an http(s) origin
    // the same way callers commonly configure REST base URLs.
    const rewritten = new URL(url.toString());
    if (rewritten.protocol === "http:") rewritten.protocol = "ws:";
    else if (rewritten.protocol === "https:") rewritten.protocol = "wss:";
    return rewritten.toString();
  }
  return `${url.pathname}${url.search}`;
}
