import type {
  RealtimeFeatureEvent,
  RealtimeFeatureObserver,
  RealtimeFeatureTransport,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
} from "./types.js";

export interface RealtimeServerSentEventSource {
  readonly readyState?: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
  addEventListener?(type: string, listener: (event: MessageEvent<string>) => void): void;
  removeEventListener?(type: string, listener: (event: MessageEvent<string>) => void): void;
}

export type RealtimeServerSentEventSourceFactory = (
  url: string,
  init?: EventSourceInit,
) => RealtimeServerSentEventSource;

export interface RealtimeServerSentEventsTransportOptions<TFeature = unknown> {
  readonly url: string;
  readonly eventSourceFactory?: RealtimeServerSentEventSourceFactory;
  readonly withCredentials?: boolean;
  readonly eventTypes?: ReadonlyArray<string>;
  readonly encodeRequest?: (url: URL, request: RealtimeSubscriptionRequest) => void;
  readonly decodeEvent?: (payload: unknown) => RealtimeFeatureEvent<TFeature>;
}

const DEFAULT_EVENT_TYPES = ["snapshot", "upsert", "delete", "delta", "heartbeat", "status", "error"] as const;

export function createRealtimeServerSentEventsTransport<TFeature = unknown>(
  options: RealtimeServerSentEventsTransportOptions<TFeature>,
): RealtimeFeatureTransport<TFeature> {
  return {
    capabilities: {
      kind: "sse",
      resumeModes: ["cursor", "watermark", "timestamp", "sequence", "delta-token"],
      emitsHeartbeats: true,
      emitsWatermarks: true,
    },
    subscribe(request, observer): RealtimeSubscriptionHandle {
      const url = new URL(options.url, "http://honua.local");
      encodeDefaultRealtimeRequest(url, request);
      options.encodeRequest?.(url, request);
      const source = createEventSource(resolveEventSourceUrl(options.url, url), options);
      let closed = false;
      const listeners: Array<readonly [string, (event: MessageEvent<string>) => void]> = [];

      const emitPayload = (payload: string): void => {
        if (closed || payload.trim() === "") return;
        try {
          observer.next((options.decodeEvent ?? decodeRealtimeServerSentEvent<TFeature>)(JSON.parse(payload)));
        } catch (error) {
          observer.error(error);
        }
      };
      const messageListener = (event: MessageEvent<string>) => emitPayload(event.data);

      source.onopen = () => {
        if (!closed) observer.next({ type: "status", status: "live", receivedAt: Date.now() });
      };
      source.onmessage = messageListener;
      source.onerror = (event) => {
        if (!closed)
          observer.next({ type: "status", status: "reconnecting", reason: "sse-error", receivedAt: Date.now() });
        if (isEventSourceClosed(source)) observer.error(event);
      };

      for (const type of options.eventTypes ?? DEFAULT_EVENT_TYPES) {
        if (!source.addEventListener) break;
        const listener = (event: MessageEvent<string>) => emitPayload(event.data);
        source.addEventListener(type, listener);
        listeners.push([type, listener]);
      }

      const abortListener = () => closeSource();
      request.signal?.addEventListener("abort", abortListener, { once: true });

      function closeSource(): void {
        if (closed) return;
        closed = true;
        request.signal?.removeEventListener("abort", abortListener);
        for (const [type, listener] of listeners) source.removeEventListener?.(type, listener);
        source.onopen = null;
        source.onmessage = null;
        source.onerror = null;
        source.close();
        observer.complete();
      }

      return {
        close: closeSource,
      };
    },
  };
}

export function encodeDefaultRealtimeRequest(url: URL, request: RealtimeSubscriptionRequest): URL {
  url.searchParams.set("sourceId", String(request.sourceId));
  if (request.layerId !== undefined) url.searchParams.set("layerId", String(request.layerId));
  if (request.requestId) url.searchParams.set("requestId", request.requestId);
  if (request.mode) url.searchParams.set("mode", request.mode);
  if (request.where) url.searchParams.set("where", request.where);
  if (request.fields?.length) url.searchParams.set("fields", request.fields.join(","));
  if (request.cursor ?? request.resumeFrom?.cursor)
    url.searchParams.set("cursor", request.cursor ?? request.resumeFrom?.cursor ?? "");
  if (request.watermark ?? request.resumeFrom?.watermark) {
    url.searchParams.set("watermark", request.watermark ?? request.resumeFrom?.watermark ?? "");
  }
  if (request.timestamp ?? request.resumeFrom?.timestamp) {
    url.searchParams.set("timestamp", request.timestamp ?? request.resumeFrom?.timestamp ?? "");
  }
  if (request.deltaToken ?? request.resumeFrom?.deltaToken) {
    url.searchParams.set("deltaToken", request.deltaToken ?? request.resumeFrom?.deltaToken ?? "");
  }
  if (request.resumeFrom?.sequence !== undefined) url.searchParams.set("sequence", String(request.resumeFrom.sequence));
  if (request.spatialFilter !== undefined) url.searchParams.set("spatialFilter", JSON.stringify(request.spatialFilter));
  if (request.metadata !== undefined) url.searchParams.set("metadata", JSON.stringify(request.metadata));
  return url;
}

export function decodeRealtimeServerSentEvent<TFeature = unknown>(payload: unknown): RealtimeFeatureEvent<TFeature> {
  if (!isRecord(payload)) throw new Error("Realtime SSE payload must be a JSON object.");
  if (typeof payload.type === "string") return payload as unknown as RealtimeFeatureEvent<TFeature>;
  if (isRecord(payload.event) && typeof payload.event.type === "string") {
    return payload.event as unknown as RealtimeFeatureEvent<TFeature>;
  }
  if (typeof payload.kind === "string") {
    return { ...payload, type: payload.kind } as unknown as RealtimeFeatureEvent<TFeature>;
  }
  throw new Error("Realtime SSE payload is missing an event type.");
}

function createEventSource<TFeature>(
  url: string,
  options: RealtimeServerSentEventsTransportOptions<TFeature>,
): RealtimeServerSentEventSource {
  const factory =
    options.eventSourceFactory ??
    ((globalThis as unknown as { EventSource?: RealtimeServerSentEventSourceFactory }).EventSource as
      | RealtimeServerSentEventSourceFactory
      | undefined);
  if (!factory) throw new Error("EventSource is not available; provide eventSourceFactory for this runtime.");
  return factory(url, { withCredentials: options.withCredentials });
}

function resolveEventSourceUrl(input: string, url: URL): string {
  if (input.startsWith("http://") || input.startsWith("https://")) return url.toString();
  return `${url.pathname}${url.search}`;
}

function isEventSourceClosed(source: RealtimeServerSentEventSource): boolean {
  return source.readyState === 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
