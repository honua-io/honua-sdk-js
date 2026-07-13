/**
 * `@honua/react` hooks: {@link useHonuaClient}, {@link useDataset},
 * {@link useQuery}, {@link useCapabilities}, {@link useMapRuntime}, and
 * {@link useRealtime}.
 *
 * All data hooks are AbortController-wired and StrictMode-safe, and expose
 * `loading` / `error` / `data` state. Query results are referentially stable
 * until the underlying data changes (NFR-001) because reads go through
 * `useSyncExternalStore` over the provider's {@link HonuaQueryCache}.
 *
 * @module
 */

import { useCallback, useContext, useDebugValue, useEffect, useMemo, useSyncExternalStore } from "react";

import type {
  CapabilityPolicy,
  Dataset,
  DatasetId,
  Query,
  Result,
  Source,
  SourceDescriptor,
  SourceResolver,
} from "../contract/index.js";
import { createDataset } from "../contract/index.js";
import type { HonuaClient } from "../core/client.js";
import type { HonuaCompatibilityRequest, HonuaServerCompatibility } from "../core/types.js";
import type { HonuaMapRuntime } from "../runtime/index.js";
import { HonuaContext, type HonuaContextValue, HonuaMapContext } from "./context.js";
import { type HonuaQueryCache, type QuerySnapshot, idleSnapshot, stableQueryHash } from "./query-cache.js";

function useHonuaContext(hookName: string): HonuaContextValue {
  const value = useContext(HonuaContext);
  if (value === null) {
    throw new Error(`${hookName} must be used within a <HonuaProvider>.`);
  }
  return value;
}

/**
 * Access the {@link HonuaClient} published by the nearest {@link HonuaProvider}.
 *
 * @throws if called outside a `HonuaProvider`.
 */
export function useHonuaClient(): HonuaClient {
  return useHonuaContext("useHonuaClient").client;
}

/**
 * Access the provider's {@link HonuaQueryCache}. Rarely needed directly;
 * exposed for advanced invalidation (`cache.invalidate(key)` / `cache.clear()`).
 */
export function useHonuaQueryCache(): HonuaQueryCache {
  return useHonuaContext("useHonuaQueryCache").cache;
}

/** Options accepted by {@link useDataset}. `client` is taken from context. */
export interface UseDatasetOptions {
  id: DatasetId;
  sources: ReadonlyArray<SourceDescriptor>;
  capabilityPolicy?: CapabilityPolicy;
  skipCompatibilityCheck?: boolean;
  resolveSource?: SourceResolver;
}

function datasetSignature(options: UseDatasetOptions): string {
  const descriptors = options.sources
    .map((descriptor) => stableQueryHash({ ...descriptor, capabilities: descriptor.capabilities }))
    .join("|");
  return [
    options.id,
    options.capabilityPolicy ?? "strict",
    options.skipCompatibilityCheck ? "1" : "0",
    descriptors,
  ].join("::");
}

/**
 * Build a memoized {@link Dataset} bound to the provider's client. The dataset
 * identity is stable until its `id`, source descriptors, or policy change, so
 * it is safe to pass its sources into {@link useQuery} across re-renders.
 *
 * @example
 * ```tsx
 * const dataset = useDataset({
 *   id: "incidents",
 *   sources: [{ id: "incidents", protocol: "geoservices-feature-service",
 *     locator: { url, serviceId: "incidents", layerId: 0 },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"] }],
 * });
 * ```
 */
export function useDataset(options: UseDatasetOptions): Dataset {
  const client = useHonuaClient();
  const signature = datasetSignature(options);
  // `signature` captures id/sources/policy; `resolveSource` is a function
  // identity folded in so a new resolver rebuilds the dataset. Callers should
  // memoize `resolveSource` to keep the dataset stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: options.* are captured through `signature`.
  const dataset = useMemo(
    () =>
      createDataset({
        id: options.id,
        client,
        sources: options.sources,
        capabilityPolicy: options.capabilityPolicy,
        skipCompatibilityCheck: options.skipCompatibilityCheck,
        resolveSource: options.resolveSource,
      }),
    [client, signature, options.resolveSource],
  );
  useDebugValue(dataset.id);
  return dataset;
}

/** Options for {@link useQuery}. */
export interface UseQueryOptions {
  /** When `false`, the query is not executed and stays in `idle`. Default `true`. */
  enabled?: boolean;
  /** Use `source.queryAll()` (drain every page) instead of a single page. */
  drainAllPages?: boolean;
  /**
   * Stale-while-revalidate window in milliseconds. When a consumer (re)mounts
   * or the query key changes and the cached result is at least this old, the
   * cached data keeps rendering while a background refetch runs
   * (`isFetching: true`, `data` preserved). `0` revalidates on every mount.
   * Omitted keeps the historical behavior: cached results are served without
   * revalidation until `refetch()` or an explicit invalidation.
   *
   * @experimental
   */
  staleTimeMs?: number;
  /**
   * Throw query errors during render so the nearest React error boundary
   * receives them (typed errors such as `HonuaCapabilityNotSupportedError`
   * arrive intact). Default `false`: errors are returned on the snapshot.
   *
   * @experimental
   */
  throwOnError?: boolean;
  /**
   * Suspense mode: while the first fetch (no cached data yet) is in flight the
   * hook suspends, and errors are thrown to the nearest error boundary. Wrap
   * consumers in `<Suspense fallback={…}>`. Background refetches do not
   * suspend — cached data keeps rendering stale-while-revalidate style.
   *
   * @experimental
   */
  suspense?: boolean;
}

/** Result of {@link useQuery}: a stable snapshot plus a `refetch` trigger. */
export interface UseQueryResult<T> extends QuerySnapshot<Result<T>> {
  /** Force a fresh fetch, superseding any in-flight request. */
  refetch: () => void;
}

/**
 * Execute a contract {@link Query} against a {@link Source} with loading /
 * error / data state. Results are cached per `(source, query-hash)` inside the
 * provider and are referentially stable until the data changes. The request is
 * aborted when the component unmounts or the query key changes; superseded
 * responses are ignored (no races).
 *
 * @example
 * ```tsx
 * const { data, isLoading, error, refetch } = useQuery(
 *   dataset.source("incidents"),
 *   { where: "STATUS = 'OPEN'", returnGeometry: true },
 * );
 * ```
 */
export function useQuery<T = Record<string, unknown>>(
  source: Source<T> | undefined | null,
  query?: Query<T>,
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const { cache } = useHonuaContext("useQuery");
  const enabled = options.enabled ?? true;
  const drainAllPages = options.drainAllPages ?? false;
  const sourceId = source?.descriptor.id;
  const queryHash = stableQueryHash(query ?? {});

  // `key` (and thus every effect below) intentionally re-derives from the
  // stable `queryHash` rather than the `query` object identity, so an inline
  // query literal does not thrash the cache.
  const key = useMemo(() => {
    if (!source || sourceId === undefined || !enabled) return null;
    return `query::${String(sourceId)}::${drainAllPages ? "all" : "page"}::${queryHash}`;
  }, [source, sourceId, enabled, drainAllPages, queryHash]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (key ? cache.subscribe(key, onStoreChange) : () => {}),
    [cache, key],
  );
  const getSnapshot = useCallback(
    () => (key ? cache.getSnapshot<Result<T>>(key) : idleSnapshot<Result<T>>()),
    [cache, key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => idleSnapshot<Result<T>>());
  const staleTimeMs = options.staleTimeMs;

  // `key` already encodes source id + query + mode, so the fetcher (like the
  // effects below) is intentionally keyed on it rather than on the identity of
  // the `source` / `query` objects — an inline literal cannot thrash the cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` already encodes source id + query + mode.
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      drainAllPages
        ? (source as Source<T>).queryAll({ ...query, signal })
        : (source as Source<T>).query({ ...query, signal }),
    [key],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` already encodes source id + query + mode.
  useEffect(() => {
    if (!key || !source) return;
    cache.ensure<Result<T>>(key, fetcher, staleTimeMs !== undefined ? { staleTimeMs } : {});
  }, [cache, key, fetcher, staleTimeMs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` already encodes source id + query + mode.
  const refetch = useCallback(() => {
    if (!key || !source) return;
    cache.run<Result<T>>(key, fetcher);
  }, [cache, key, fetcher]);

  useDebugValue(snapshot.status);

  if (key && source && (options.suspense || options.throwOnError) && snapshot.status === "error") {
    // Surface the typed error (e.g. HonuaCapabilityNotSupportedError) to the
    // nearest error boundary. `refetch()` from the boundary retries.
    throw snapshot.error;
  }
  if (options.suspense && key && source && snapshot.data === undefined) {
    // First load with no cached data: kick the fetch during render (idempotent
    // — `ensure` is a no-op once the entry left `idle`, so StrictMode's double
    // render cannot double-fetch) and suspend on its promise.
    cache.ensure<Result<T>>(key, fetcher, staleTimeMs !== undefined ? { staleTimeMs } : {});
    const pending = cache.getPromise(key);
    if (pending) throw pending;
  }

  return useMemo(() => ({ ...snapshot, refetch }), [snapshot, refetch]);
}

/** Options for {@link useCapabilities}. */
export interface UseCapabilitiesOptions {
  /** When `false`, capabilities are not fetched. Default `true`. */
  enabled?: boolean;
  /** Forwarded to `client.getCompatibility` (e.g. `{ refresh: true }`). */
  request?: Omit<HonuaCompatibilityRequest, "signal">;
}

/** Result of {@link useCapabilities}. */
export interface UseCapabilitiesResult extends QuerySnapshot<HonuaServerCompatibility> {
  refetch: () => void;
}

/**
 * Fetch the Honua server's capability / compatibility descriptor
 * (`serverVersion`, `releaseChannel`, feature flags) with loading / error /
 * data state. Cached per-request inside the provider.
 */
export function useCapabilities(options: UseCapabilitiesOptions = {}): UseCapabilitiesResult {
  const { client, cache } = useHonuaContext("useCapabilities");
  const enabled = options.enabled ?? true;
  const requestHash = stableQueryHash(options.request ?? {});

  const key = useMemo(() => (enabled ? `capabilities::${requestHash}` : null), [enabled, requestHash]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (key ? cache.subscribe(key, onStoreChange) : () => {}),
    [cache, key],
  );
  const getSnapshot = useCallback(
    () => (key ? cache.getSnapshot<HonuaServerCompatibility>(key) : idleSnapshot<HonuaServerCompatibility>()),
    [cache, key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => idleSnapshot<HonuaServerCompatibility>());

  // biome-ignore lint/correctness/useExhaustiveDependencies: request identity is captured through `requestHash`.
  const fetcher = useCallback(
    (signal: AbortSignal) => client.getCompatibility({ ...options.request, signal }),
    [client, requestHash],
  );

  useEffect(() => {
    if (!key) return;
    cache.ensure<HonuaServerCompatibility>(key, fetcher);
  }, [cache, key, fetcher]);

  const refetch = useCallback(() => {
    if (!key) return;
    cache.run<HonuaServerCompatibility>(key, fetcher);
  }, [cache, key, fetcher]);

  useDebugValue(snapshot.status);
  return useMemo(() => ({ ...snapshot, refetch }), [snapshot, refetch]);
}

/**
 * Access the {@link HonuaMapRuntime} owned by the nearest {@link HonuaMap}.
 * Returns `null` until the map has finished loading its package, and when
 * called outside a `HonuaMap`.
 */
export function useMapRuntime(): HonuaMapRuntime | null {
  return useContext(HonuaMapContext)?.runtime ?? null;
}

/** A realtime subscription cleanup handle, in any of the SDK's shapes. */
export type RealtimeCleanup = (() => void) | { close(): void } | { remove(): void } | { unsubscribe(): void };

/**
 * Open a realtime subscription for the lifetime of the component and tear it
 * down on unmount (StrictMode-safe: the effect's cleanup runs between the
 * double-invoked mounts, so no duplicate subscriptions leak).
 *
 * `factory` should open the subscription and return its cleanup handle. It is
 * re-run whenever `deps` change. Works with the SDK realtime store
 * (`store.connect(...)` returns `{ close() }`) or any `() => void` unsubscribe.
 *
 * @example
 * ```tsx
 * useRealtime(() => store.connect(transport, request), [transport, request]);
 * ```
 */
export function useRealtime(
  factory: (() => RealtimeCleanup | undefined) | null | undefined,
  deps: readonly unknown[] = [],
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller-supplied dependency list controls re-subscription.
  useEffect(() => {
    if (!factory) return;
    const handle = factory();
    return () => {
      runCleanup(handle);
    };
  }, deps);
}

function runCleanup(handle: RealtimeCleanup | undefined): void {
  if (!handle) return;
  if (typeof handle === "function") {
    handle();
  } else if ("close" in handle) {
    handle.close();
  } else if ("remove" in handle) {
    handle.remove();
  } else {
    handle.unsubscribe();
  }
}
