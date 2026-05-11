import { type MapPackageDiff, diffPackages } from "./diff.js";
import {
  type FetchMapPackageOptions,
  type FetchMapPackageResult,
  type MapPackageLocator,
  fetchMapPackage,
  mapPackageFingerprint,
} from "./map-package-fetch.js";
import type { HonuaMapPackage } from "./map-package.js";
import type { HonuaMapRuntime } from "./runtime.js";

export type MapPackageWatchEvent =
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
  readonly onEvent?: (event: MapPackageWatchEvent) => void | Promise<void>;
  readonly onUpdate?: (event: Extract<MapPackageWatchEvent, { type: "updated" }>) => void | Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export interface MapPackageWatchHandle {
  readonly disposed: boolean;
  refresh(): Promise<void>;
  dispose(): void;
}

const DEFAULT_WATCH_INTERVAL_MS = 30_000;

export function watchMapPackage(locator: MapPackageLocator, options: WatchMapPackageOptions): MapPackageWatchHandle {
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingResult: FetchMapPackageResult | undefined;
  let previousPackage = options.initialPackage ?? options.runtime?.mapPackage;
  let previousFingerprint = previousPackage ? mapPackageFingerprint(previousPackage) : undefined;
  let currentAbort: AbortController | undefined;

  const intervalMs = normalizeDelay(options.intervalMs, DEFAULT_WATCH_INTERVAL_MS);
  const debounceMs = normalizeDelay(options.debounceMs, 0);

  const emit = (event: MapPackageWatchEvent): void => {
    void options.onEvent?.(event);
    if (event.type === "updated") void options.onUpdate?.(event);
    if (event.type === "error") void options.onError?.(event.error);
  };

  const schedule = (): void => {
    if (disposed) return;
    timer = setTimeout(() => {
      void poll();
    }, intervalMs);
  };

  const clearScheduled = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const queueApply = (result: FetchMapPackageResult): void => {
    pendingResult = result;
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
      const result = pendingResult;
      pendingResult = undefined;
      if (!result || disposed) return;

      const nextFingerprint = mapPackageFingerprint(result.mapPackage);
      if (previousFingerprint === nextFingerprint) {
        emit({ type: "unchanged", result });
        return;
      }

      const diff = previousPackage ? diffPackages(previousPackage, result.mapPackage) : undefined;
      if (diff && !diff.incremental) {
        emit({
          type: "reload-required",
          result,
          diff,
          reason: diff.structuralReason ?? "MapPackage update requires a full style reload.",
        });
      }

      const shouldApply = Boolean(options.runtime) && options.applyUpdates !== false;
      if (shouldApply) {
        await options.runtime?.updatePackage(result.mapPackage);
      }
      previousPackage = result.mapPackage;
      previousFingerprint = nextFingerprint;
      emit({ type: "updated", result, diff, applied: shouldApply });
    } catch (error) {
      if (!disposed) emit({ type: "error", error });
    }
  };

  const poll = async (): Promise<void> => {
    if (disposed || inFlight) return;
    inFlight = true;
    currentAbort = new AbortController();
    try {
      const result = await fetchMapPackage(locator, {
        ...options,
        signal: linkAbortSignals(options.signal, currentAbort.signal),
      });
      emit({ type: "fetched", result });
      if (result.cache.status === "not-modified") {
        emit({ type: "unchanged", result });
        return;
      }
      queueApply(result);
    } catch (error) {
      if (!disposed) emit({ type: "error", error });
    } finally {
      inFlight = false;
      currentAbort = undefined;
      schedule();
    }
  };

  const handle: MapPackageWatchHandle = {
    get disposed() {
      return disposed;
    },
    refresh: poll,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduled();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      pendingResult = undefined;
      currentAbort?.abort();
      emit({ type: "disposed" });
    },
  };

  if (options.immediate !== false) {
    void poll();
  } else {
    schedule();
  }

  return handle;
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
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
