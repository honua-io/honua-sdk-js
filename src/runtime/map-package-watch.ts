import { type MapPackageDiff, diffPackages } from "./diff.js";
import { HonuaMapPackageError } from "./errors.js";
import {
  type FetchMapPackageOptions,
  type FetchMapPackageResult,
  type MapPackageLocator,
  fetchMapPackage,
  mapPackageFingerprint,
  resolveMapPackagePath,
} from "./map-package-fetch.js";
import {
  MAP_PACKAGE_REALTIME_CHANNEL_V1,
  createMapPackageServerSentEventsTransport,
  readMapPackageRealtimeAdvertisement,
} from "./map-package-realtime.js";
import type {
  MapPackageRealtimeCheckpoint,
  MapPackageRealtimeFallbackMode,
  MapPackageRealtimeMessage,
  MapPackageRealtimeReconnectOptions,
  MapPackageRealtimeSubscriptionHandle,
  MapPackageRealtimeTransport,
  MapPackageRealtimeTransportKind,
  MapPackageRealtimeUpdate,
  MapPackageRealtimeWatchOptions,
} from "./map-package-realtime.js";
import { hasMapPackageDiagnosticErrors, validateMapPackage } from "./map-package-validation.js";
import type { HonuaMapPackage } from "./map-package.js";
import type { HonuaMapRuntime } from "./runtime.js";

export type MapPackageWatchEvent =
  | {
      readonly type: "connected";
      readonly transport: MapPackageRealtimeTransportKind;
      readonly channel?: string;
      readonly url?: string;
      readonly advertised: boolean;
      readonly resumedFrom?: MapPackageRealtimeCheckpoint;
    }
  | {
      readonly type: "disconnected";
      readonly transport?: MapPackageRealtimeTransportKind;
      readonly reason?: string;
      readonly willReconnect: boolean;
      readonly reconnectAttempt?: number;
    }
  | {
      readonly type: "stale";
      readonly reason: string;
      readonly retryAfterMs?: number;
      readonly fallback: boolean;
    }
  | {
      readonly type: "fallback";
      readonly mode: MapPackageRealtimeFallbackMode;
      readonly reason: string;
      readonly error?: unknown;
    }
  | { readonly type: "fetched"; readonly result: FetchMapPackageResult }
  | { readonly type: "unchanged"; readonly result: FetchMapPackageResult }
  | {
      readonly type: "updated";
      readonly result: FetchMapPackageResult;
      readonly diff: MapPackageDiff | undefined;
      readonly applied: boolean;
    }
  | {
      readonly type: "reload-required";
      readonly result: FetchMapPackageResult;
      readonly diff: MapPackageDiff;
      readonly reason: string;
    }
  | { readonly type: "error"; readonly error: unknown }
  | { readonly type: "disposed" };

export interface WatchMapPackageOptions extends FetchMapPackageOptions {
  /** Runtime to update after a changed package is fetched. */
  readonly runtime?: HonuaMapRuntime;
  /** Previous package snapshot for diffing when no runtime is supplied. */
  readonly initialPackage?: HonuaMapPackage;
  /** Defaults to true when `runtime` is supplied. */
  readonly applyUpdates?: boolean;
  /** Polling cadence. Defaults to 30 seconds. */
  readonly intervalMs?: number;
  /** Delay changed-package application to coalesce rapid fetches. Defaults to 0. */
  readonly debounceMs?: number;
  /** Fetch immediately on watcher creation. Defaults to true. */
  readonly immediate?: boolean;
  /** Realtime channel configuration. Omit to use package-advertised channels; pass false to force polling. */
  readonly realtime?: false | MapPackageRealtimeWatchOptions;
  readonly onEvent?: (event: MapPackageWatchEvent) => void | Promise<void>;
  readonly onUpdate?: (event: Extract<MapPackageWatchEvent, { type: "updated" }>) => void | Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export interface MapPackageWatchHandle {
  readonly disposed: boolean;
  refresh(): Promise<void>;
  dispose(): void;
}

interface PendingApply {
  readonly result: FetchMapPackageResult;
  readonly reloadReason?: string;
}

interface ActiveRealtimeSource {
  readonly transport: MapPackageRealtimeTransport;
  readonly transportKind: MapPackageRealtimeTransportKind;
  readonly advertised: boolean;
  readonly url?: string;
  readonly channel?: string;
  readonly fallback: MapPackageRealtimeFallbackMode;
  readonly reconnect: false | Required<MapPackageRealtimeReconnectOptions>;
  readonly staleAfterMs?: number;
  readonly fallbackOnStale: boolean;
}

type RealtimeResolution =
  | { readonly type: "available"; readonly source: ActiveRealtimeSource }
  | { readonly type: "unsupported"; readonly reason: string; readonly fallback: MapPackageRealtimeFallbackMode };

const DEFAULT_WATCH_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_OPTIONS: Required<MapPackageRealtimeReconnectOptions> = {
  maxAttempts: 3,
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
};

export function watchMapPackage(locator: MapPackageLocator, options: WatchMapPackageOptions): MapPackageWatchHandle {
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingApply: PendingApply | undefined;
  let previousPackage = options.initialPackage ?? options.runtime?.mapPackage;
  let lastFetchedPackage = previousPackage;
  let previousFingerprint = previousPackage ? mapPackageFingerprint(previousPackage) : undefined;
  let currentAbort: AbortController | undefined;
  let realtimeAbort: AbortController | undefined;
  let realtimeSubscription: MapPackageRealtimeSubscriptionHandle | undefined;
  let activeRealtime: ActiveRealtimeSource | undefined;
  let suppressRealtimeDisconnect = false;
  let reconnectAttempt = 0;
  let fallbackActive = false;
  let unsupportedRealtimeNotified = false;
  let lastRealtimeCheckpoint: MapPackageRealtimeCheckpoint | undefined = previousPackage
    ? {
        fingerprint: previousFingerprint,
        updatedAt: previousPackage.updatedAt,
      }
    : undefined;
  let lastAppliedRealtimeSequence: number | undefined;
  const seenRealtimeEventIds: string[] = [];

  const intervalMs = normalizeDelay(options.intervalMs, DEFAULT_WATCH_INTERVAL_MS);
  const debounceMs = normalizeDelay(options.debounceMs, 0);

  const emit = (event: MapPackageWatchEvent): void => {
    void options.onEvent?.(event);
    if (event.type === "updated") void options.onUpdate?.(event);
    if (event.type === "error") void options.onError?.(event.error);
  };

  const schedule = (): void => {
    if (disposed || realtimeSubscription) return;
    timer = setTimeout(() => {
      void poll({ scheduleAfter: true, discoverRealtime: true });
    }, intervalMs);
  };

  const clearScheduled = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const clearRealtimeTimers = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (staleTimer) clearTimeout(staleTimer);
    reconnectTimer = undefined;
    staleTimer = undefined;
  };

  const queueApply = (result: FetchMapPackageResult, reloadReason?: string): void => {
    pendingApply = { result, ...(reloadReason ? { reloadReason } : {}) };
    if (debounceMs === 0) {
      void applyPending();
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void applyPending();
    }, debounceMs);
  };

  const applyPending = async (): Promise<void> => {
    try {
      const pending = pendingApply;
      pendingApply = undefined;
      if (!pending || disposed) return;

      const { result, reloadReason } = pending;
      const nextFingerprint = mapPackageFingerprint(result.mapPackage);
      if (previousFingerprint === nextFingerprint) {
        emit({ type: "unchanged", result });
        return;
      }

      const diff = previousPackage ? diffPackages(previousPackage, result.mapPackage) : undefined;
      if (diff && (reloadReason || !diff.incremental)) {
        emit({
          type: "reload-required",
          result,
          diff,
          reason: reloadReason ?? diff.structuralReason ?? "MapPackage update requires a full style reload.",
        });
      }

      const shouldApply = Boolean(options.runtime) && options.applyUpdates !== false;
      if (shouldApply) {
        await options.runtime?.updatePackage(result.mapPackage);
      }
      previousPackage = result.mapPackage;
      lastFetchedPackage = result.mapPackage;
      previousFingerprint = nextFingerprint;
      lastRealtimeCheckpoint = {
        ...lastRealtimeCheckpoint,
        fingerprint: nextFingerprint,
        updatedAt: result.mapPackage.updatedAt,
        validator: result.cache.validator,
      };
      emit({ type: "updated", result, diff, applied: shouldApply });
    } catch (error) {
      if (!disposed) emit({ type: "error", error });
    }
  };

  const poll = async (
    input: {
      readonly locatorOverride?: MapPackageLocator;
      readonly scheduleAfter?: boolean;
      readonly discoverRealtime?: boolean;
    } = {},
  ): Promise<void> => {
    if (disposed || inFlight) return;
    inFlight = true;
    currentAbort = new AbortController();
    try {
      const result = await fetchMapPackage(input.locatorOverride ?? locator, {
        ...options,
        signal: linkAbortSignals(options.signal, currentAbort.signal),
      });
      lastFetchedPackage = result.mapPackage;
      emit({ type: "fetched", result });
      if (result.cache.status === "not-modified") {
        emit({ type: "unchanged", result });
      } else {
        queueApply(result);
      }
      if (input.discoverRealtime !== false && !realtimeSubscription && !fallbackActive) {
        startRealtime();
      }
    } catch (error) {
      if (!disposed) emit({ type: "error", error });
    } finally {
      inFlight = false;
      currentAbort = undefined;
      if (input.scheduleAfter !== false) schedule();
    }
  };

  const startRealtime = (): boolean => {
    if (disposed || realtimeSubscription || options.realtime === false || fallbackActive) return false;
    const resolution = resolveRealtimeSource();
    if (!resolution) return false;
    if (resolution.type === "unsupported") {
      if (!unsupportedRealtimeNotified) {
        unsupportedRealtimeNotified = true;
        emit({ type: "fallback", mode: resolution.fallback, reason: resolution.reason });
      }
      return false;
    }

    const source = resolution.source;
    const abort = new AbortController();
    const signal = linkAbortSignals(options.signal, abort.signal);
    const path = resolveMapPackagePath(locator, options.resolvePath);
    activeRealtime = source;
    realtimeAbort = abort;
    clearScheduled();

    try {
      const subscription = source.transport.subscribe(
        {
          locator,
          packageId: packageIdFromLocator(locator) ?? previousPackage?.mapPackageId ?? lastFetchedPackage?.mapPackageId,
          path,
          client: options.client,
          headers: options.headers,
          signal,
          resumeFrom: lastRealtimeCheckpoint,
        },
        {
          connected: (info) => {
            if (disposed) return;
            reconnectAttempt = 0;
            armRealtimeStaleTimer(source);
            emit({
              type: "connected",
              transport: info.transport,
              advertised: source.advertised,
              ...(info.channel ? { channel: info.channel } : source.channel ? { channel: source.channel } : {}),
              ...(info.url ? { url: info.url } : source.url ? { url: source.url } : {}),
              ...(lastRealtimeCheckpoint ? { resumedFrom: lastRealtimeCheckpoint } : {}),
            });
          },
          message: (message) => {
            if (!disposed) void handleRealtimeMessage(message);
          },
          disconnected: (info) => {
            if (disposed || suppressRealtimeDisconnect) return;
            handleRealtimeFailure(info?.reason ?? "disconnected", undefined, info?.retryAfterMs);
          },
          error: (error) => {
            if (disposed) return;
            emit({ type: "error", error });
            handleRealtimeFailure("error", error);
          },
        },
      );
      if (disposed || activeRealtime !== source || fallbackActive) {
        suppressRealtimeDisconnect = true;
        try {
          subscription.close();
        } finally {
          suppressRealtimeDisconnect = false;
        }
        return false;
      }
      realtimeSubscription = subscription;
      return true;
    } catch (error) {
      cleanupRealtime(true);
      emit({ type: "error", error });
      startFallback("realtime-unavailable", error, source);
      return false;
    }
  };

  const handleRealtimeMessage = async (message: MapPackageRealtimeMessage): Promise<void> => {
    if (disposed) return;
    armRealtimeStaleTimer(activeRealtime);
    updateRealtimeCheckpoint(message);

    if (!isExpectedPackageMessage(message)) return;

    switch (message.type) {
      case "ready":
      case "heartbeat":
        return;
      case "stale":
        emit({
          type: "stale",
          reason: message.reason ?? "realtime-stale",
          ...(message.retryAfterMs !== undefined ? { retryAfterMs: message.retryAfterMs } : {}),
          fallback: activeRealtime?.fallbackOnStale === true,
        });
        if (activeRealtime?.fallbackOnStale === true) {
          const source = activeRealtime;
          cleanupRealtime(true);
          startFallback(message.reason ?? "realtime-stale", undefined, source);
        }
        return;
      case "updated":
        if (!rememberRealtimeMutation(message)) return;
        await applyRealtimeUpdate(message.update);
        return;
      case "refetch-required":
        if (!rememberRealtimeMutation(message)) return;
        await refetchFromRealtime(message.path, message.reason);
        return;
      case "reload-required":
        if (!rememberRealtimeMutation(message)) return;
        if (message.update) {
          await applyRealtimeUpdate(message.update, message.reason);
        } else {
          await refetchFromRealtime(undefined, message.reason);
        }
        return;
      case "error":
        emit({ type: "error", error: message.error });
        if (message.terminal) {
          const source = activeRealtime;
          cleanupRealtime(true);
          startFallback(message.code ?? "realtime-terminal-error", message.error, source);
        }
        return;
      case "disconnected":
        handleRealtimeFailure(message.reason ?? "disconnected", undefined, message.retryAfterMs);
        return;
    }
  };

  const applyRealtimeUpdate = async (update: MapPackageRealtimeUpdate, reloadReason?: string): Promise<void> => {
    if (update.kind === "package") {
      queueApply(buildRealtimeFetchResult(update.mapPackage), reloadReason);
      return;
    }
    if (update.kind === "refetch") {
      await refetchFromRealtime(update.path, reloadReason ?? "realtime-refetch-required");
      return;
    }

    emit({ type: "fallback", mode: "polling", reason: "realtime-patch-refetch" });
    await refetchFromRealtime(undefined, reloadReason ?? "realtime-patch-refetch");
  };

  const refetchFromRealtime = async (path: string | undefined, reloadReason?: string): Promise<void> => {
    if (disposed) return;
    inFlight = true;
    currentAbort = new AbortController();
    try {
      const result = await fetchMapPackage(path ? { path } : locator, {
        ...options,
        signal: linkAbortSignals(options.signal, currentAbort.signal),
      });
      lastFetchedPackage = result.mapPackage;
      emit({ type: "fetched", result });
      if (result.cache.status === "not-modified") {
        emit({ type: "unchanged", result });
      } else {
        queueApply(result, reloadReason);
      }
    } catch (error) {
      if (!disposed) emit({ type: "error", error });
    } finally {
      inFlight = false;
      currentAbort = undefined;
    }
  };

  const handleRealtimeFailure = (reason: string, error?: unknown, retryAfterMs?: number): void => {
    const source = activeRealtime;
    if (!source || disposed) return;
    cleanupRealtime(true);
    const reconnect = source.reconnect;
    if (reconnect !== false && reconnectAttempt < reconnect.maxAttempts) {
      reconnectAttempt += 1;
      emit({
        type: "disconnected",
        transport: source.transportKind,
        reason,
        willReconnect: true,
        reconnectAttempt,
      });
      const delayMs = retryAfterMs ?? reconnectDelayMs(reconnectAttempt, reconnect);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        startRealtime();
      }, delayMs);
      return;
    }

    emit({ type: "disconnected", transport: source.transportKind, reason, willReconnect: false });
    startFallback(reason, error, source);
  };

  const startFallback = (
    reason: string,
    error?: unknown,
    source: ActiveRealtimeSource | undefined = activeRealtime,
  ): void => {
    const mode = source?.fallback ?? "polling";
    if (fallbackActive) return;
    fallbackActive = true;
    emit({ type: "fallback", mode, reason, ...(error ? { error } : {}) });
    if (mode === "polling") {
      void poll({ scheduleAfter: true, discoverRealtime: false });
    }
  };

  const cleanupRealtime = (close: boolean): void => {
    clearRealtimeTimers();
    const subscription = realtimeSubscription;
    realtimeSubscription = undefined;
    realtimeAbort?.abort();
    realtimeAbort = undefined;
    activeRealtime = undefined;
    if (close && subscription) {
      suppressRealtimeDisconnect = true;
      try {
        subscription.close();
      } finally {
        suppressRealtimeDisconnect = false;
      }
    }
  };

  const armRealtimeStaleTimer = (source: ActiveRealtimeSource | undefined): void => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = undefined;
    if (!source?.staleAfterMs || disposed) return;
    staleTimer = setTimeout(() => {
      staleTimer = undefined;
      if (disposed) return;
      emit({ type: "stale", reason: "heartbeat-timeout", fallback: source.fallbackOnStale });
      if (source.fallbackOnStale) {
        cleanupRealtime(true);
        startFallback("heartbeat-timeout", undefined, source);
      }
    }, source.staleAfterMs);
  };

  const resolveRealtimeSource = (): RealtimeResolution | undefined => {
    if (options.realtime === false) return undefined;
    const realtime = options.realtime ?? {};
    const fallback = realtime.fallback ?? "polling";
    const reconnect = normalizeReconnectOptions(realtime.reconnect);

    if (realtime.transport) {
      return {
        type: "available",
        source: {
          transport: realtime.transport,
          transportKind: realtime.transport.kind ?? "custom",
          advertised: false,
          fallback,
          reconnect,
          ...(realtime.staleAfterMs !== undefined ? { staleAfterMs: normalizeDelay(realtime.staleAfterMs, 0) } : {}),
          fallbackOnStale: realtime.fallbackOnStale !== false,
        },
      };
    }

    if (realtime.url) {
      return {
        type: "available",
        source: {
          transport: createMapPackageServerSentEventsTransport({
            url: realtime.url,
            eventSourceFactory: realtime.eventSourceFactory,
            eventTypes: realtime.eventTypes,
            withCredentials: realtime.withCredentials ?? cookieCredentials(realtime),
            auth: realtime.auth,
          }),
          transportKind: "sse",
          advertised: false,
          url: realtime.url,
          channel: MAP_PACKAGE_REALTIME_CHANNEL_V1,
          fallback,
          reconnect,
          ...(realtime.staleAfterMs !== undefined ? { staleAfterMs: normalizeDelay(realtime.staleAfterMs, 0) } : {}),
          fallbackOnStale: realtime.fallbackOnStale !== false,
        },
      };
    }

    if (realtime.advertise === false) return undefined;

    const advertisement = readMapPackageRealtimeAdvertisement(lastFetchedPackage ?? previousPackage);
    if (!advertisement) return undefined;
    const advertisedFallback = realtime.fallback ?? advertisement.fallback ?? "polling";
    const advertisedTransport = advertisement.transport ?? "sse";
    if (advertisedTransport !== "sse") {
      return {
        type: "unsupported",
        reason: `unsupported-realtime-transport:${advertisedTransport}`,
        fallback: advertisedFallback,
      };
    }

    const url = advertisement.href ?? advertisement.url ?? advertisement.path;
    if (!url) {
      return { type: "unsupported", reason: "missing-realtime-url", fallback: advertisedFallback };
    }

    return {
      type: "available",
      source: {
        transport: createMapPackageServerSentEventsTransport({
          url,
          eventSourceFactory: realtime.eventSourceFactory,
          eventTypes: realtime.eventTypes,
          withCredentials: realtime.withCredentials ?? advertisement.withCredentials ?? cookieCredentials(realtime),
          auth: realtime.auth,
        }),
        transportKind: "sse",
        advertised: true,
        url,
        channel: advertisement.channel ?? MAP_PACKAGE_REALTIME_CHANNEL_V1,
        fallback: advertisedFallback,
        reconnect,
        ...(realtime.staleAfterMs !== undefined
          ? { staleAfterMs: normalizeDelay(realtime.staleAfterMs, 0) }
          : advertisement.staleAfterMs !== undefined
            ? { staleAfterMs: normalizeDelay(advertisement.staleAfterMs, 0) }
            : {}),
        fallbackOnStale: realtime.fallbackOnStale !== false,
      },
    };
  };

  const buildRealtimeFetchResult = (mapPackage: HonuaMapPackage): FetchMapPackageResult => {
    const path = resolveMapPackagePath(locator, options.resolvePath);
    const validation = validateMapPackage(mapPackage, {
      maxAgeMs: options.maxAgeMs,
      now: options.now,
    });
    if (hasMapPackageDiagnosticErrors(validation.diagnostics) && options.allowInvalid !== true) {
      throw new HonuaMapPackageError("MapPackage validation failed", {
        packageId: mapPackage.mapPackageId,
        stage: "validate",
        detail: { diagnostics: validation.diagnostics, path },
      });
    }
    return {
      mapPackage,
      diagnostics: validation.diagnostics,
      cache: {
        status: "refreshed",
        key: path,
        fetchedAt: new Date().toISOString(),
        ...(lastRealtimeCheckpoint?.validator ? { validator: lastRealtimeCheckpoint.validator } : {}),
      },
    };
  };

  const isExpectedPackageMessage = (message: MapPackageRealtimeMessage): boolean => {
    if (!message.packageId) return true;
    const expected = previousPackage?.mapPackageId ?? lastFetchedPackage?.mapPackageId ?? packageIdFromLocator(locator);
    if (!expected || expected === message.packageId) return true;
    emit({
      type: "error",
      error: new HonuaMapPackageError("MapPackage realtime message packageId does not match watcher locator", {
        packageId: message.packageId,
        stage: "fetch",
        detail: { expectedPackageId: expected },
      }),
    });
    return false;
  };

  const updateRealtimeCheckpoint = (message: MapPackageRealtimeMessage): void => {
    lastRealtimeCheckpoint = {
      ...lastRealtimeCheckpoint,
      ...(message.eventId ? { eventId: message.eventId } : {}),
      ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
      ...(message.fingerprint ? { fingerprint: message.fingerprint } : {}),
      ...(message.updatedAt ? { updatedAt: message.updatedAt } : {}),
      ...(message.validator ? { validator: message.validator } : {}),
    };
  };

  const rememberRealtimeMutation = (message: MapPackageRealtimeMessage): boolean => {
    if (message.eventId && seenRealtimeEventIds.includes(message.eventId)) return false;
    if (
      message.sequence !== undefined &&
      lastAppliedRealtimeSequence !== undefined &&
      message.sequence <= lastAppliedRealtimeSequence
    ) {
      return false;
    }
    if (message.eventId) {
      seenRealtimeEventIds.push(message.eventId);
      if (seenRealtimeEventIds.length > 100) seenRealtimeEventIds.shift();
    }
    if (message.sequence !== undefined) lastAppliedRealtimeSequence = message.sequence;
    return true;
  };

  const abortFromOptions = (): void => {
    handle.dispose();
  };

  const handle: MapPackageWatchHandle = {
    get disposed() {
      return disposed;
    },
    refresh: () => poll({ scheduleAfter: false, discoverRealtime: true }),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduled();
      clearRealtimeTimers();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      pendingApply = undefined;
      currentAbort?.abort();
      cleanupRealtime(true);
      options.signal?.removeEventListener("abort", abortFromOptions);
      emit({ type: "disposed" });
    },
  };

  if (options.signal?.aborted) {
    handle.dispose();
    return handle;
  }
  options.signal?.addEventListener("abort", abortFromOptions, { once: true });

  if (options.immediate !== false) {
    void poll({ scheduleAfter: false, discoverRealtime: true }).finally(() => {
      if (!disposed && !realtimeSubscription && !fallbackActive) {
        startRealtime();
        schedule();
      }
    });
  } else if (!startRealtime()) {
    schedule();
  }

  return handle;
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function normalizeReconnectOptions(
  value: false | MapPackageRealtimeReconnectOptions | undefined,
): false | Required<MapPackageRealtimeReconnectOptions> {
  if (value === false) return false;
  return {
    maxAttempts: normalizeReconnectAttempts(value?.maxAttempts, DEFAULT_RECONNECT_OPTIONS.maxAttempts),
    minDelayMs: normalizeDelay(value?.minDelayMs, DEFAULT_RECONNECT_OPTIONS.minDelayMs),
    maxDelayMs: normalizeDelay(value?.maxDelayMs, DEFAULT_RECONNECT_OPTIONS.maxDelayMs),
    factor: normalizeReconnectFactor(value?.factor),
  };
}

function normalizeReconnectAttempts(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function normalizeReconnectFactor(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RECONNECT_OPTIONS.factor;
  return Math.max(1, value);
}

function reconnectDelayMs(attempt: number, options: Required<MapPackageRealtimeReconnectOptions>): number {
  const delay = options.minDelayMs * options.factor ** Math.max(0, attempt - 1);
  return Math.min(options.maxDelayMs, Math.max(0, Math.trunc(delay)));
}

function cookieCredentials(options: MapPackageRealtimeWatchOptions): boolean | undefined {
  return options.auth?.kind === "cookie" ? options.auth.withCredentials : undefined;
}

function packageIdFromLocator(locator: MapPackageLocator): string | undefined {
  if (typeof locator === "string") {
    if (locator.startsWith("/") || locator.startsWith("http://") || locator.startsWith("https://")) return undefined;
    const prefix = "honua://map-packages/";
    if (locator.startsWith(prefix)) return decodeURIComponent(locator.slice(prefix.length));
    return locator;
  }
  return locator.packageId ?? locator.id;
}

function linkAbortSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
