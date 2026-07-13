/**
 * Framework-neutral query cache used by the `@honua/react` hooks. Lives
 * outside React so it can back `useSyncExternalStore` (referentially stable
 * snapshots, StrictMode-safe subscriptions) and be shared across every hook
 * mounted under a single {@link HonuaProvider}.
 *
 * The cache keys results per `(source, query-hash)` string. It never persists
 * across sessions and holds no cross-`HonuaProvider` state: each provider owns
 * one cache instance.
 *
 * @module
 */

/** Lifecycle state of a single cached query. */
export type QueryStatus = "idle" | "loading" | "success" | "error";

/**
 * Immutable snapshot of a cached query. The same object reference is returned
 * from {@link HonuaQueryCache.getSnapshot} until the underlying state changes,
 * which is what gives hooks their referential stability (NFR-001).
 */
export interface QuerySnapshot<T> {
  readonly status: QueryStatus;
  /** Last resolved value. Preserved across background refetches. */
  readonly data: T | undefined;
  /** Last rejection reason, cleared on the next successful fetch. */
  readonly error: unknown;
  /** True only while the first fetch (no data yet) is in flight. */
  readonly isLoading: boolean;
  /** True whenever a fetch is in flight, including background refetches. */
  readonly isFetching: boolean;
  /**
   * Epoch milliseconds of the last successful fetch, `undefined` until one
   * resolves. Drives stale-while-revalidate decisions.
   *
   * @experimental
   */
  readonly dataUpdatedAt?: number;
}

interface CacheEntry {
  snapshot: QuerySnapshot<unknown>;
  readonly listeners: Set<() => void>;
  controller: AbortController | undefined;
  /** Monotonic token used to ignore stale (superseded / raced) responses. */
  token: number;
  /** Settles with the in-flight run (Suspense integration). */
  promise: Promise<unknown> | undefined;
}

const IDLE_SNAPSHOT: QuerySnapshot<unknown> = Object.freeze({
  status: "idle",
  data: undefined,
  error: undefined,
  isLoading: false,
  isFetching: false,
});

/**
 * Returns the shared idle snapshot. Exposed so the SSR / disabled-query paths
 * can hand back a stable reference without allocating.
 */
export function idleSnapshot<T>(): QuerySnapshot<T> {
  return IDLE_SNAPSHOT as QuerySnapshot<T>;
}

/** A fetcher receives the cache-owned `AbortSignal` for cooperative cancellation. */
export type QueryFetcher<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Per-`HonuaProvider` cache of query results. Not a React construct; it is
 * driven by the hooks via {@link subscribe} / {@link getSnapshot} / {@link ensure}.
 */
export class HonuaQueryCache {
  private readonly entries = new Map<string, CacheEntry>();

  /** Read the current snapshot for `key`; a stable idle snapshot if unseen. */
  getSnapshot<T>(key: string): QuerySnapshot<T> {
    return (this.entries.get(key)?.snapshot ?? IDLE_SNAPSHOT) as QuerySnapshot<T>;
  }

  /**
   * Subscribe `listener` to changes for `key`. When the final listener for a
   * key unsubscribes and a fetch is still in flight, the fetch is aborted so
   * unmounting the last consumer cancels the underlying request.
   */
  subscribe(key: string, listener: () => void): () => void {
    const entry = this.entryFor(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && entry.controller) {
        // Last consumer left while a fetch was in flight: abort it and
        // invalidate the run so its (now irrelevant) settlement is ignored.
        entry.controller.abort();
        entry.controller = undefined;
        entry.token += 1;
        // If nothing had resolved yet, drop back to `idle` so the next
        // subscriber (e.g. a StrictMode remount) re-fetches from a clean
        // state instead of being stuck on a `loading` snapshot that will
        // never settle. A previously-resolved value is preserved.
        if (entry.snapshot.status === "loading") {
          entry.snapshot =
            entry.snapshot.data === undefined
              ? IDLE_SNAPSHOT
              : {
                  status: "success",
                  data: entry.snapshot.data,
                  error: undefined,
                  isLoading: false,
                  isFetching: false,
                  dataUpdatedAt: entry.snapshot.dataUpdatedAt,
                };
        }
      }
    };
  }

  /**
   * Kick off a fetch for `key` when it has never resolved and is not already
   * in flight. This is the idempotent entry point hooks call from an effect;
   * StrictMode's double-invoke therefore does not double-fetch.
   *
   * With `options.staleTimeMs`, a resolved entry whose data is at least that
   * old is additionally revalidated in the background (stale-while-revalidate:
   * the cached data stays served while `isFetching` is true). `0` revalidates
   * on every ensure; omitted keeps the historical never-revalidate behavior.
   */
  ensure<T>(key: string, fetcher: QueryFetcher<T>, options: { staleTimeMs?: number } = {}): void {
    const entry = this.entryFor(key);
    if (entry.snapshot.status === "idle") {
      this.run(key, fetcher);
      return;
    }
    if (
      options.staleTimeMs !== undefined &&
      entry.snapshot.status === "success" &&
      !entry.snapshot.isFetching &&
      Date.now() - (entry.snapshot.dataUpdatedAt ?? 0) >= options.staleTimeMs
    ) {
      this.run(key, fetcher);
    }
  }

  /**
   * The promise of the in-flight run for `key`, or `undefined` when no fetch
   * is running. Suspense-mode hooks throw this promise while the first load is
   * pending; it never rejects (errors land on the snapshot instead).
   *
   * @experimental
   */
  getPromise(key: string): Promise<unknown> | undefined {
    const entry = this.entries.get(key);
    return entry?.snapshot.isFetching ? entry.promise : undefined;
  }

  /**
   * Force a (re)fetch for `key`, superseding any in-flight request. The last
   * resolved `data` is preserved while the refetch runs.
   */
  run<T>(key: string, fetcher: QueryFetcher<T>): void {
    const entry = this.entryFor(key);
    entry.controller?.abort();

    const controller = new AbortController();
    const token = entry.token + 1;
    entry.token = token;
    entry.controller = controller;

    this.write(entry, {
      status: "loading",
      data: entry.snapshot.data,
      error: undefined,
      isLoading: entry.snapshot.data === undefined,
      isFetching: true,
      dataUpdatedAt: entry.snapshot.dataUpdatedAt,
    });

    entry.promise = fetcher(controller.signal).then(
      (value) => {
        if (entry.token !== token) return;
        entry.controller = undefined;
        this.write(entry, {
          status: "success",
          data: value,
          error: undefined,
          isLoading: false,
          isFetching: false,
          dataUpdatedAt: Date.now(),
        });
      },
      (error) => {
        if (entry.token !== token || controller.signal.aborted) return;
        entry.controller = undefined;
        this.write(entry, {
          status: "error",
          data: entry.snapshot.data,
          error,
          isLoading: false,
          isFetching: false,
          dataUpdatedAt: entry.snapshot.dataUpdatedAt,
        });
      },
    );
  }

  /** Drop the cached result for `key` and abort any in-flight fetch. */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.controller?.abort();
    entry.controller = undefined;
    entry.token += 1;
    this.write(entry, IDLE_SNAPSHOT);
  }

  /** Abort every in-flight fetch and clear all cached results. */
  clear(): void {
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      entry.controller = undefined;
      entry.token += 1;
    }
    this.entries.clear();
  }

  private entryFor(key: string): CacheEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { snapshot: IDLE_SNAPSHOT, listeners: new Set(), controller: undefined, token: 0, promise: undefined };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private write(entry: CacheEntry, snapshot: QuerySnapshot<unknown>): void {
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) {
      listener();
    }
  }
}

/**
 * Deterministic, key-order-independent hash of a query-like object. Used to
 * build the `(source, query-hash)` cache key. `AbortSignal` and `undefined`
 * values are ignored so they do not perturb the identity of a query.
 */
export function stableQueryHash(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof AbortSignal) {
    return '"[signal]"';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isReadonlySet(value)) {
    return `[${[...value.values()]
      .map((entry) => stableStringify(entry))
      .sort()
      .join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined && !(record[key] instanceof AbortSignal))
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * Recognize native, cross-realm, and intentionally branded immutable sets.
 * Requiring the complete ReadonlySet surface plus the Set brand avoids
 * consuming strings, maps, generators, or arbitrary domain iterables.
 */
function isReadonlySet(value: object): value is ReadonlySet<unknown> {
  const candidate = value as Partial<ReadonlySet<unknown>> & { readonly [Symbol.toStringTag]?: unknown };
  return (
    candidate[Symbol.toStringTag] === "Set" &&
    typeof candidate.size === "number" &&
    typeof candidate.has === "function" &&
    typeof candidate.entries === "function" &&
    typeof candidate.keys === "function" &&
    typeof candidate.values === "function" &&
    typeof candidate.forEach === "function" &&
    typeof candidate[Symbol.iterator] === "function"
  );
}
