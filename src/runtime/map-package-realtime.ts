import type { HonuaCacheValidator } from "../core/cache-state.js";
import type { HonuaClient } from "../core/client.js";
import type { MapPackageLocator } from "./map-package-fetch.js";
import type { HonuaMapPackage } from "./map-package.js";

export const MAP_PACKAGE_REALTIME_CHANNEL_V1 = "honua.map-package.watch.v1" as const;

export type MapPackageRealtimeChannel = typeof MAP_PACKAGE_REALTIME_CHANNEL_V1;
export type MapPackageRealtimeTransportKind = "sse" | "websocket" | "custom" | "mock";
export type MapPackageRealtimeFallbackMode = "polling" | "none";

export interface MapPackageRealtimeCheckpoint {
  readonly eventId?: string;
  readonly sequence?: number;
  readonly fingerprint?: string;
  readonly updatedAt?: string;
  readonly validator?: HonuaCacheValidator;
}

export interface MapPackageRealtimeMessageBase extends MapPackageRealtimeCheckpoint {
  readonly channel?: MapPackageRealtimeChannel | string;
  readonly packageId?: string;
  readonly receivedAt?: string;
}

export type MapPackageRealtimeUpdate =
  | {
      readonly kind: "package";
      readonly mapPackage: HonuaMapPackage;
    }
  | {
      readonly kind: "patch";
      readonly patch: unknown;
      readonly baseFingerprint?: string;
    }
  | {
      readonly kind: "refetch";
      readonly path?: string;
      readonly validator?: HonuaCacheValidator;
    };

export interface MapPackageRealtimeReadyMessage extends MapPackageRealtimeMessageBase {
  readonly type: "ready";
}

export interface MapPackageRealtimeHeartbeatMessage extends MapPackageRealtimeMessageBase {
  readonly type: "heartbeat";
}

export interface MapPackageRealtimeStaleMessage extends MapPackageRealtimeMessageBase {
  readonly type: "stale";
  readonly reason?: string;
  readonly retryAfterMs?: number;
}

export interface MapPackageRealtimeUpdatedMessage extends MapPackageRealtimeMessageBase {
  readonly type: "updated";
  readonly update: MapPackageRealtimeUpdate;
}

export interface MapPackageRealtimeRefetchRequiredMessage extends MapPackageRealtimeMessageBase {
  readonly type: "refetch-required";
  readonly reason?: string;
  readonly path?: string;
  readonly validator?: HonuaCacheValidator;
}

export interface MapPackageRealtimeReloadRequiredMessage extends MapPackageRealtimeMessageBase {
  readonly type: "reload-required";
  readonly reason: string;
  readonly update?: MapPackageRealtimeUpdate;
}

export interface MapPackageRealtimeErrorMessage extends MapPackageRealtimeMessageBase {
  readonly type: "error";
  readonly error: unknown;
  readonly code?: string;
  readonly terminal?: boolean;
  readonly retryAfterMs?: number;
}

export interface MapPackageRealtimeDisconnectedMessage extends MapPackageRealtimeMessageBase {
  readonly type: "disconnected";
  readonly reason?: string;
  readonly retryAfterMs?: number;
}

export type MapPackageRealtimeMessage =
  | MapPackageRealtimeReadyMessage
  | MapPackageRealtimeHeartbeatMessage
  | MapPackageRealtimeStaleMessage
  | MapPackageRealtimeUpdatedMessage
  | MapPackageRealtimeRefetchRequiredMessage
  | MapPackageRealtimeReloadRequiredMessage
  | MapPackageRealtimeErrorMessage
  | MapPackageRealtimeDisconnectedMessage;

export interface MapPackageRealtimeConnectionInfo {
  readonly channel?: string;
  readonly transport: MapPackageRealtimeTransportKind;
  readonly url?: string;
}

export interface MapPackageRealtimeDisconnectInfo {
  readonly reason?: string;
  readonly retryAfterMs?: number;
}

export interface MapPackageRealtimeObserver {
  connected(info: MapPackageRealtimeConnectionInfo): void;
  message(message: MapPackageRealtimeMessage): void;
  disconnected(info?: MapPackageRealtimeDisconnectInfo): void;
  error(error: unknown): void;
}

export interface MapPackageRealtimeSubscribeRequest {
  readonly locator: MapPackageLocator;
  readonly packageId?: string;
  readonly path: string;
  readonly client: HonuaClient;
  readonly headers?: HeadersInit;
  readonly signal: AbortSignal;
  readonly resumeFrom?: MapPackageRealtimeCheckpoint;
}

export interface MapPackageRealtimeSubscriptionHandle {
  close(): void;
}

export interface MapPackageRealtimeTransport {
  readonly kind?: MapPackageRealtimeTransportKind;
  subscribe(
    request: MapPackageRealtimeSubscribeRequest,
    observer: MapPackageRealtimeObserver,
  ): MapPackageRealtimeSubscriptionHandle;
}

export interface MapPackageRealtimeReconnectOptions {
  /** Defaults to 3; use `Infinity` for unbounded reconnect attempts. */
  readonly maxAttempts?: number;
  /** Defaults to 1000 ms. */
  readonly minDelayMs?: number;
  /** Defaults to 30000 ms. */
  readonly maxDelayMs?: number;
  /** Defaults to 2. */
  readonly factor?: number;
}

export type MapPackageRealtimeAuth =
  | { readonly kind: "none" }
  | { readonly kind: "cookie"; readonly withCredentials?: boolean }
  | { readonly kind: "query-token"; readonly token: string; readonly parameterName?: string };

export interface MapPackageRealtimeWatchOptions {
  readonly transport?: MapPackageRealtimeTransport;
  readonly url?: string;
  readonly eventSourceFactory?: MapPackageRealtimeEventSourceFactory;
  readonly eventTypes?: readonly string[];
  readonly withCredentials?: boolean;
  readonly auth?: MapPackageRealtimeAuth;
  readonly advertise?: boolean;
  readonly allowedAdvertisedOrigins?: readonly string[];
  readonly fallback?: MapPackageRealtimeFallbackMode;
  readonly reconnect?: false | MapPackageRealtimeReconnectOptions;
  readonly staleAfterMs?: number;
  readonly fallbackOnStale?: boolean;
}

export interface MapPackageRealtimeAdvertisement {
  readonly channel?: string;
  readonly transport?: MapPackageRealtimeTransportKind | string;
  readonly href?: string;
  readonly url?: string;
  readonly path?: string;
  readonly withCredentials?: boolean;
  readonly fallback?: MapPackageRealtimeFallbackMode;
  readonly staleAfterMs?: number;
}

export interface MapPackageRealtimeEventSource {
  readonly readyState?: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
  addEventListener?(type: string, listener: (event: MessageEvent<string>) => void): void;
  removeEventListener?(type: string, listener: (event: MessageEvent<string>) => void): void;
}

export type MapPackageRealtimeEventSourceFactory = (
  url: string,
  init?: EventSourceInit,
) => MapPackageRealtimeEventSource;

export interface MapPackageServerSentEventsTransportOptions {
  readonly url: string;
  readonly eventSourceFactory?: MapPackageRealtimeEventSourceFactory;
  readonly eventTypes?: readonly string[];
  readonly withCredentials?: boolean;
  readonly auth?: MapPackageRealtimeAuth;
}

const DEFAULT_MAP_PACKAGE_EVENT_TYPES = [
  "ready",
  "heartbeat",
  "stale",
  "updated",
  "refetch-required",
  "reload-required",
  "error",
  "disconnected",
] as const;

export function createMapPackageServerSentEventsTransport(
  options: MapPackageServerSentEventsTransportOptions,
): MapPackageRealtimeTransport {
  return {
    kind: "sse",
    subscribe(request, observer): MapPackageRealtimeSubscriptionHandle {
      const encoded = encodeMapPackageRealtimeUrl(new URL(options.url, request.client.serverBaseUrl), request);
      applyMapPackageRealtimeAuth(encoded, options.auth);
      const source = createEventSource(resolveEventSourceUrl(options.url, encoded), options);
      const listeners: Array<readonly [string, (event: MessageEvent<string>) => void]> = [];
      let closed = false;

      const emitPayload = (payload: string): void => {
        if (closed || payload.trim() === "") return;
        try {
          observer.message(decodeMapPackageRealtimeMessage(JSON.parse(payload)));
        } catch (error) {
          observer.error(error);
        }
      };

      const messageListener = (event: MessageEvent<string>): void => emitPayload(event.data);

      source.onopen = () => {
        if (!closed) {
          observer.connected({
            channel: MAP_PACKAGE_REALTIME_CHANNEL_V1,
            transport: "sse",
            url: redactMapPackageRealtimeUrl(encoded),
          });
        }
      };
      source.onmessage = messageListener;
      source.onerror = (event) => {
        if (closed) return;
        if (isEventSourceClosed(source)) {
          observer.error(event);
          closeSource("sse-closed");
        } else {
          observer.message({
            type: "stale",
            channel: MAP_PACKAGE_REALTIME_CHANNEL_V1,
            packageId: request.packageId,
            reason: "sse-error",
          });
        }
      };

      for (const type of options.eventTypes ?? DEFAULT_MAP_PACKAGE_EVENT_TYPES) {
        if (!source.addEventListener) break;
        const listener = (event: MessageEvent<string>): void => emitPayload(event.data);
        source.addEventListener(type, listener);
        listeners.push([type, listener]);
      }

      const abortListener = (): void => closeSource("aborted");
      request.signal.addEventListener("abort", abortListener, { once: true });

      function closeSource(reason?: string): void {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", abortListener);
        for (const [type, listener] of listeners) source.removeEventListener?.(type, listener);
        source.onopen = null;
        source.onmessage = null;
        source.onerror = null;
        source.close();
        observer.disconnected({ reason });
      }

      return {
        close: () => closeSource("closed"),
      };
    },
  };
}

export function encodeMapPackageRealtimeUrl(url: URL, request: MapPackageRealtimeSubscribeRequest): URL {
  url.searchParams.set("channel", MAP_PACKAGE_REALTIME_CHANNEL_V1);
  url.searchParams.set("path", request.path);
  if (request.packageId) url.searchParams.set("packageId", request.packageId);
  if (request.resumeFrom?.eventId) url.searchParams.set("eventId", request.resumeFrom.eventId);
  if (request.resumeFrom?.fingerprint) url.searchParams.set("fingerprint", request.resumeFrom.fingerprint);
  if (request.resumeFrom?.updatedAt) url.searchParams.set("updatedAt", request.resumeFrom.updatedAt);
  if (request.resumeFrom?.sequence !== undefined) url.searchParams.set("sequence", String(request.resumeFrom.sequence));
  if (request.resumeFrom?.validator?.etag) url.searchParams.set("etag", request.resumeFrom.validator.etag);
  if (request.resumeFrom?.validator?.lastModified) {
    url.searchParams.set("lastModified", request.resumeFrom.validator.lastModified);
  }
  return url;
}

export function redactMapPackageRealtimeUrl(input: string | URL): string {
  const text = String(input);
  try {
    const url = new URL(text, "https://honua.invalid");
    const sensitiveParams = new Set(["access_token", "token", "api_key", "apikey", "key", "authorization"]);
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveParams.has(key.toLowerCase())) {
        url.searchParams.set(key, "REDACTED");
      }
    }
    url.username = url.username ? "REDACTED" : "";
    url.password = url.password ? "REDACTED" : "";
    const redacted = url.toString();
    return text.startsWith("http://") || text.startsWith("https://")
      ? redacted
      : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return text.replace(/([?&](?:access_token|token|api_key|apikey|key|authorization)=)[^&#]*/gi, "$1REDACTED");
  }
}

export function decodeMapPackageRealtimeMessage(payload: unknown): MapPackageRealtimeMessage {
  const event = unwrapRealtimeEnvelope(payload);
  const rawType = typeof event.type === "string" ? event.type : typeof event.kind === "string" ? event.kind : undefined;
  if (!rawType) throw new Error("MapPackage realtime message is missing type.");

  const base = realtimeMessageBase(event);
  switch (rawType) {
    case "ready":
    case "connected":
      return { ...base, type: "ready" };
    case "heartbeat":
      return { ...base, type: "heartbeat" };
    case "stale":
      return {
        ...base,
        type: "stale",
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
        ...(typeof event.retryAfterMs === "number" ? { retryAfterMs: event.retryAfterMs } : {}),
      };
    case "updated":
    case "package":
      return { ...base, type: "updated", update: decodeRealtimeUpdate(event) };
    case "refetch-required":
      return {
        ...base,
        type: "refetch-required",
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
        ...(typeof event.path === "string" ? { path: event.path } : {}),
        ...(isCacheValidator(event.validator) ? { validator: event.validator } : {}),
      };
    case "reload-required":
      return {
        ...base,
        type: "reload-required",
        reason: typeof event.reason === "string" ? event.reason : "MapPackage update requires a full style reload.",
        ...(hasRealtimeUpdate(event) ? { update: decodeRealtimeUpdate(event) } : {}),
      };
    case "error":
      return {
        ...base,
        type: "error",
        error: event.error ?? event.message ?? "MapPackage realtime channel error.",
        ...(typeof event.code === "string" ? { code: event.code } : {}),
        ...(typeof event.terminal === "boolean" ? { terminal: event.terminal } : {}),
        ...(typeof event.retryAfterMs === "number" ? { retryAfterMs: event.retryAfterMs } : {}),
      };
    case "disconnected":
      return {
        ...base,
        type: "disconnected",
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
        ...(typeof event.retryAfterMs === "number" ? { retryAfterMs: event.retryAfterMs } : {}),
      };
    default:
      throw new Error(`Unsupported MapPackage realtime message type "${rawType}".`);
  }
}

export function readMapPackageRealtimeAdvertisement(
  pkg: HonuaMapPackage | undefined,
): MapPackageRealtimeAdvertisement | undefined {
  if (!pkg) return undefined;
  const record = pkg as Record<string, unknown>;
  const directCandidates = [
    valueAt(record, ["realtime", "mapPackageWatch"]),
    valueAt(record, ["realtime", "mapPackage"]),
    valueAt(record, ["watch", "realtime"]),
    record.realtimeWatch,
    record.watchChannel,
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeAdvertisement(candidate);
    if (normalized) return normalized;
  }

  if (Array.isArray(record.links)) {
    for (const link of record.links) {
      const normalized = normalizeLinkAdvertisement(link);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

function createEventSource(
  url: string,
  options: MapPackageServerSentEventsTransportOptions,
): MapPackageRealtimeEventSource {
  if (options.eventSourceFactory) {
    return options.eventSourceFactory(url, { withCredentials: options.withCredentials });
  }
  // The global `EventSource` is a constructor: calling it as a plain
  // function (`EventSource(url, init)`) throws a TypeError in browsers,
  // so the default path must construct with `new`.
  const EventSourceCtor = (
    globalThis as unknown as {
      EventSource?: new (url: string, init?: EventSourceInit) => MapPackageRealtimeEventSource;
    }
  ).EventSource;
  if (!EventSourceCtor) throw new Error("EventSource is not available; provide eventSourceFactory for this runtime.");
  return new EventSourceCtor(url, { withCredentials: options.withCredentials });
}

function applyMapPackageRealtimeAuth(url: URL, auth: MapPackageRealtimeAuth | undefined): void {
  if (!auth || auth.kind !== "query-token") return;
  url.searchParams.set(auth.parameterName ?? "access_token", auth.token);
}

function resolveEventSourceUrl(input: string, url: URL): string {
  if (input.startsWith("http://") || input.startsWith("https://")) return url.toString();
  return `${url.pathname}${url.search}`;
}

function isEventSourceClosed(source: MapPackageRealtimeEventSource): boolean {
  return source.readyState === 2;
}

function unwrapRealtimeEnvelope(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("MapPackage realtime message must be a JSON object.");
  if (isRecord(payload.event)) return payload.event;
  if (isRecord(payload.message)) return payload.message;
  if (isRecord(payload.mapPackageWatch)) return payload.mapPackageWatch;
  return payload;
}

function realtimeMessageBase(event: Record<string, unknown>): MapPackageRealtimeMessageBase {
  return {
    ...(typeof event.channel === "string" ? { channel: event.channel } : {}),
    ...(typeof event.packageId === "string" ? { packageId: event.packageId } : {}),
    ...(typeof event.eventId === "string" ? { eventId: event.eventId } : {}),
    ...(typeof event.sequence === "number" ? { sequence: event.sequence } : {}),
    ...(typeof event.fingerprint === "string" ? { fingerprint: event.fingerprint } : {}),
    ...(typeof event.updatedAt === "string" ? { updatedAt: event.updatedAt } : {}),
    ...(typeof event.receivedAt === "string" ? { receivedAt: event.receivedAt } : {}),
    ...(isCacheValidator(event.validator) ? { validator: event.validator } : {}),
  };
}

function hasRealtimeUpdate(event: Record<string, unknown>): boolean {
  return isRecord(event.update) || isRecord(event.mapPackage) || "patch" in event || event.refetchRequired === true;
}

function decodeRealtimeUpdate(event: Record<string, unknown>): MapPackageRealtimeUpdate {
  const update = isRecord(event.update) ? event.update : undefined;
  const kind =
    typeof update?.kind === "string" ? update.kind : typeof update?.type === "string" ? update.type : undefined;

  if (kind === "package" && isRecord(update?.mapPackage)) {
    return { kind: "package", mapPackage: update.mapPackage as unknown as HonuaMapPackage };
  }
  if (kind === "patch" && update && "patch" in update) {
    return {
      kind: "patch",
      patch: update.patch,
      ...(typeof update.baseFingerprint === "string" ? { baseFingerprint: update.baseFingerprint } : {}),
    };
  }
  if (kind === "refetch") {
    return {
      kind: "refetch",
      ...(typeof update?.path === "string" ? { path: update.path } : {}),
      ...(isCacheValidator(update?.validator) ? { validator: update.validator } : {}),
    };
  }
  if (isRecord(event.mapPackage)) {
    return { kind: "package", mapPackage: event.mapPackage as unknown as HonuaMapPackage };
  }
  if ("patch" in event) {
    return {
      kind: "patch",
      patch: event.patch,
      ...(typeof event.baseFingerprint === "string" ? { baseFingerprint: event.baseFingerprint } : {}),
    };
  }
  if (event.refetchRequired === true || event.refetch === true) {
    return {
      kind: "refetch",
      ...(typeof event.path === "string" ? { path: event.path } : {}),
      ...(isCacheValidator(event.validator) ? { validator: event.validator } : {}),
    };
  }

  throw new Error("MapPackage realtime update must include package, patch, or refetch payload.");
}

function normalizeAdvertisement(value: unknown): MapPackageRealtimeAdvertisement | undefined {
  if (!isRecord(value)) return undefined;
  const href = stringField(value, "href");
  const url = stringField(value, "url");
  const path = stringField(value, "path");
  const transport = stringField(value, "transport") ?? (href || url || path ? "sse" : undefined);
  if (!transport && !href && !url && !path) return undefined;
  return {
    ...(stringField(value, "channel") ? { channel: stringField(value, "channel") } : {}),
    ...(transport ? { transport } : {}),
    ...(href ? { href } : {}),
    ...(url ? { url } : {}),
    ...(path ? { path } : {}),
    ...(typeof value.withCredentials === "boolean" ? { withCredentials: value.withCredentials } : {}),
    ...(value.fallback === "polling" || value.fallback === "none" ? { fallback: value.fallback } : {}),
    ...(typeof value.staleAfterMs === "number" ? { staleAfterMs: value.staleAfterMs } : {}),
  };
}

function normalizeLinkAdvertisement(value: unknown): MapPackageRealtimeAdvertisement | undefined {
  if (!isRecord(value)) return undefined;
  const rel = stringField(value, "rel");
  if (rel !== "map-package-watch" && rel !== "map-package-realtime-watch" && rel !== "honua:map-package-watch") {
    return undefined;
  }
  return normalizeAdvertisement({
    ...value,
    transport: stringField(value, "transport") ?? "sse",
    href: stringField(value, "href") ?? stringField(value, "url"),
  });
}

function valueAt(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCacheValidator(value: unknown): value is HonuaCacheValidator {
  return isRecord(value) && (typeof value.etag === "string" || typeof value.lastModified === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
