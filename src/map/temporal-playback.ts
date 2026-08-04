/**
 * Temporal playback (issue #497 REQ-004): a renderer-neutral play/pause/
 * scrub controller over a time extent, plus thin bindings that drive time
 * filters through the data-to-map bridge (`MountedSource.setFilter`) or
 * directly through MapLibre layer filters.
 *
 * Memory is bounded by construction: the controller keeps only the current
 * window (two numbers). Filter application is coalesced — at most one
 * request in flight and at most one pending window; intermediate windows
 * are dropped, never queued. No window data is pre-fetched or cached by the
 * controller itself (the issue's snapshot-plus-delta realtime vocabulary
 * from #393 applies only when playback is layered over a realtime feed;
 * playback over static data has no realtime dependency).
 *
 * @module
 */

import { HonuaSdkError } from "../core/error-envelope.js";

// ── Public contracts ─────────────────────────────────────────────

/** A half-open time window `[start, end)` in epoch milliseconds. @experimental */
export interface TemporalWindow {
  readonly start: number;
  readonly end: number;
}

/** Accepted time inputs: epoch ms, `Date`, or an ISO-8601 string. @experimental */
export type TemporalInstant = number | Date | string;

/** Payload for `"tick"` listeners. @experimental */
export interface TemporalPlaybackTick {
  /** The window that was just applied. */
  readonly window: TemporalWindow;
  /** Window-start progress through the extent, 0..1. */
  readonly progress: number;
  readonly playing: boolean;
}

/** Event names emitted by the controller. @experimental */
export type TemporalPlaybackEventType = "tick" | "play" | "pause" | "end" | "error";

/** Listener registration handle. @experimental */
export interface TemporalPlaybackSubscription {
  remove(): void;
}

/**
 * Bridge-shaped filter sink: the subset of `MountedSource` the playback
 * binding needs. Any object with a Query-shaped `setFilter` works.
 *
 * @experimental
 */
export interface TemporalFilterHandle {
  setFilter(query: { where?: string } | undefined): Promise<unknown>;
}

/** MapLibre-shaped filter sink for client-side (already materialized) data. @experimental */
export interface TemporalFilterMap {
  setFilter(layerId: string, filter: unknown): void;
  getFilter?(layerId: string): unknown;
}

/** Options for {@link createTemporalPlayback}. @experimental */
export interface TemporalPlaybackOptions {
  /** Full playable time extent as `[start, end]`. */
  readonly extent: readonly [TemporalInstant, TemporalInstant];
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Wall-clock delay between frames. @default 500 */
  readonly frameIntervalMs?: number;
  /** How far the window advances per frame. @default `windowMs` (non-overlapping windows) */
  readonly stepMs?: number;
  /** Restart from the extent start after the last window. @default false */
  readonly loop?: boolean;
  /**
   * Playback rate multiplier. Frames land every `frameIntervalMs / speed`
   * milliseconds, so `2` is twice as fast and `0.5` is half speed. The window
   * length and `stepMs` are unaffected — only the wall-clock cadence changes.
   *
   * @default 1
   */
  readonly speed?: number;
  /**
   * Bridge binding: a `MountedSource` (or anything with a Query-shaped
   * `setFilter`). Each window becomes a `where` clause on `timeField`.
   */
  readonly handle?: TemporalFilterHandle;
  /**
   * MapLibre binding: client-side `setFilter` over already-materialized
   * layers. Each window becomes a numeric range filter on `timeField`
   * composed (`all`) with the layer's filter at bind time, so bridge
   * geometry filters survive. Requires numeric (epoch ms) properties.
   */
  readonly layer?: { readonly map: TemporalFilterMap; readonly layerIds: readonly string[] };
  /** Custom sink; use instead of (or in addition to) `handle`/`layer`. */
  readonly apply?: (window: TemporalWindow) => void | Promise<void>;
  /** Feature property holding the feature's time. Required with `handle`/`layer`. */
  readonly timeField?: string;
  /** Extra query properties merged under the generated `where` (handle binding). */
  readonly baseQuery?: Readonly<Record<string, unknown>> & { readonly where?: string };
  /**
   * Override the generated `where` clause (handle binding). The default is
   * `<timeField> >= <startMs> AND <timeField> < <endMs>`.
   */
  readonly formatWhere?: (window: TemporalWindow, timeField: string) => string;
}

/** Playback controller returned by {@link createTemporalPlayback}. @experimental */
export interface TemporalPlayback {
  readonly playing: boolean;
  /** The current window (epoch ms, half-open). */
  readonly window: TemporalWindow;
  /** The normalized extent (epoch ms). */
  readonly extent: TemporalWindow;
  /** How far the window advances per frame, in milliseconds. */
  readonly stepMs: number;
  /** Current playback rate multiplier. See {@link TemporalPlaybackOptions.speed}. */
  readonly speed: number;
  /** Start advancing one window per frame. Applies the current window immediately. */
  play(): void;
  pause(): void;
  /** Jump the window start to a time (clamped to the extent) and apply it. */
  scrub(time: TemporalInstant): void;
  /**
   * Move the window one `stepMs` forward (`1`, the default) or backward
   * (`-1`) and apply it, without starting or stopping the frame timer. The
   * result is clamped to the extent exactly like {@link TemporalPlayback.scrub},
   * so stepping past either edge parks the window on that edge.
   */
  step(direction?: 1 | -1): void;
  /** Change the window length, keeping the current start, and apply it. */
  setWindow(windowMs: number): void;
  /**
   * Change the playback rate multiplier. While playing, the frame timer is
   * restarted at the new cadence without re-emitting `"play"` or re-applying
   * the current window; while paused, the next `play()` uses the new rate.
   */
  setSpeed(multiplier: number): void;
  on(type: "tick", listener: (event: TemporalPlaybackTick) => void): TemporalPlaybackSubscription;
  on(type: "play" | "pause" | "end", listener: () => void): TemporalPlaybackSubscription;
  on(type: "error", listener: (error: unknown) => void): TemporalPlaybackSubscription;
  /** Stop the timer and drop all listeners. Idempotent. */
  dispose(): void;
}

/** Raised for invalid playback options. @experimental */
export class HonuaTemporalPlaybackError extends HonuaSdkError {
  public constructor(message: string) {
    super("map.temporal-playback.invalid-option", message);
    this.name = "HonuaTemporalPlaybackError";
  }
}

// ── Implementation ───────────────────────────────────────────────

/**
 * Create a temporal playback controller over a time extent.
 *
 * @example
 * ```ts
 * const playback = createTemporalPlayback({
 *   handle: mounted, // from mountSource()
 *   timeField: "event_time",
 *   extent: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
 *   windowMs: 24 * 60 * 60 * 1000,
 *   frameIntervalMs: 400,
 * });
 * playback.on("tick", ({ window, progress }) => updateSlider(progress));
 * playback.play();
 * ```
 *
 * @experimental
 */
export function createTemporalPlayback(options: TemporalPlaybackOptions): TemporalPlayback {
  const extentStart = toEpochMs(options.extent?.[0], "extent[0]");
  const extentEnd = toEpochMs(options.extent?.[1], "extent[1]");
  if (extentEnd <= extentStart) {
    throw new HonuaTemporalPlaybackError("extent end must be after extent start.");
  }
  let windowMs = requirePositive(options.windowMs, "windowMs");
  const frameIntervalMs = requirePositive(options.frameIntervalMs ?? 500, "frameIntervalMs");
  const stepMs = requirePositive(options.stepMs ?? options.windowMs, "stepMs");
  let speed = requirePositive(options.speed ?? 1, "speed");
  if ((options.handle || options.layer) && !options.timeField) {
    throw new HonuaTemporalPlaybackError("timeField is required with the handle/layer bindings.");
  }
  if (!options.handle && !options.layer && !options.apply) {
    throw new HonuaTemporalPlaybackError("Provide at least one sink: handle, layer, or apply.");
  }
  const sinks = buildSinks(options);
  const extent: TemporalWindow = Object.freeze({ start: extentStart, end: extentEnd });

  const listeners = new Map<TemporalPlaybackEventType, Set<(payload?: unknown) => void>>();
  let windowStart = extentStart;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  // Coalesced application: at most one in-flight window and one pending
  // window; intermediate windows are dropped (bounded memory, REQ-004).
  let inFlight = false;
  let pending: TemporalWindow | undefined;

  const emit = (type: TemporalPlaybackEventType, payload?: unknown): void => {
    for (const listener of listeners.get(type) ?? []) {
      try {
        listener(payload);
      } catch {
        /* listener errors must not break playback */
      }
    }
  };

  const currentWindow = (): TemporalWindow => Object.freeze({ start: windowStart, end: windowStart + windowMs });

  const progress = (): number => {
    const span = extent.end - extent.start;
    return span <= 0 ? 1 : Math.min(1, Math.max(0, (windowStart - extent.start) / span));
  };

  const drainPending = (): void => {
    if (pending === undefined) return;
    const next = pending;
    pending = undefined;
    applyWindow(next);
  };

  const applyWindow = (window: TemporalWindow): void => {
    if (disposed) return;
    if (inFlight) {
      pending = window; // keep only the latest window
      return;
    }
    inFlight = true;
    void Promise.all(sinks.map((sink) => Promise.resolve().then(() => sink(window))))
      .then(() => {
        if (!disposed) emit("tick", { window, progress: progress(), playing: timer !== undefined });
      })
      .catch((error: unknown) => {
        if (!disposed) emit("error", error);
      })
      .finally(() => {
        inFlight = false;
        if (!disposed) drainPending();
      });
  };

  const lastStart = (): number => Math.max(extent.start, extent.end - windowMs);

  const advance = (): void => {
    if (windowStart >= lastStart()) {
      if (options.loop) {
        windowStart = extent.start;
        applyWindow(currentWindow());
        return;
      }
      pause();
      emit("end");
      return;
    }
    windowStart = Math.min(windowStart + stepMs, lastStart());
    applyWindow(currentWindow());
  };

  const frameDelay = (): number => Math.max(1, frameIntervalMs / speed);

  const play = (): void => {
    if (disposed || timer !== undefined) return;
    if (windowStart >= lastStart() && !options.loop) windowStart = extent.start;
    timer = setInterval(advance, frameDelay());
    emit("play");
    applyWindow(currentWindow());
  };

  const pause = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    emit("pause");
  };

  return {
    get playing() {
      return timer !== undefined;
    },
    get window() {
      return currentWindow();
    },
    extent,
    stepMs,
    get speed() {
      return speed;
    },
    play,
    pause,
    scrub(time: TemporalInstant): void {
      if (disposed) return;
      windowStart = Math.min(Math.max(toEpochMs(time, "scrub time"), extent.start), lastStart());
      applyWindow(currentWindow());
    },
    step(direction: 1 | -1 = 1): void {
      if (disposed) return;
      const delta = direction < 0 ? -stepMs : stepMs;
      windowStart = Math.min(Math.max(windowStart + delta, extent.start), lastStart());
      applyWindow(currentWindow());
    },
    setWindow(nextWindowMs: number): void {
      if (disposed) return;
      windowMs = requirePositive(nextWindowMs, "windowMs");
      windowStart = Math.min(windowStart, lastStart());
      applyWindow(currentWindow());
    },
    setSpeed(multiplier: number): void {
      if (disposed) return;
      const next = requirePositive(multiplier, "speed");
      if (next === speed) return;
      speed = next;
      // Re-arm the frame timer at the new cadence. Deliberately silent: this
      // is a rate change, not a transport change, so no play/pause event is
      // emitted and the current window is not re-applied.
      if (timer !== undefined) {
        clearInterval(timer);
        timer = setInterval(advance, frameDelay());
      }
    },
    on(type: TemporalPlaybackEventType, listener: unknown): TemporalPlaybackSubscription {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as (payload?: unknown) => void);
      listeners.set(type, set);
      return {
        remove: () => {
          set.delete(listener as (payload?: unknown) => void);
        },
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      pending = undefined;
      listeners.clear();
    },
  };
}

// ── Sink builders ────────────────────────────────────────────────

type Sink = (window: TemporalWindow) => void | Promise<void>;

function buildSinks(options: TemporalPlaybackOptions): Sink[] {
  const sinks: Sink[] = [];
  if (options.handle && options.timeField) {
    sinks.push(createHandleSink(options.handle, options.timeField, options.baseQuery, options.formatWhere));
  }
  if (options.layer && options.timeField) {
    sinks.push(createLayerSink(options.layer.map, options.layer.layerIds, options.timeField));
  }
  if (options.apply) sinks.push(options.apply);
  return sinks;
}

function createHandleSink(
  handle: TemporalFilterHandle,
  timeField: string,
  baseQuery: (Readonly<Record<string, unknown>> & { readonly where?: string }) | undefined,
  formatWhere: ((window: TemporalWindow, timeField: string) => string) | undefined,
): Sink {
  return async (window) => {
    const windowWhere = formatWhere
      ? formatWhere(window, timeField)
      : `${timeField} >= ${window.start} AND ${timeField} < ${window.end}`;
    const where = baseQuery?.where ? `(${baseQuery.where}) AND (${windowWhere})` : windowWhere;
    await handle.setFilter({ ...(baseQuery ?? {}), where });
  };
}

function createLayerSink(map: TemporalFilterMap, layerIds: readonly string[], timeField: string): Sink {
  // Capture each layer's filter at bind time so the window range composes
  // with (instead of replacing) bridge geometry filters.
  const baseFilters = new Map<string, unknown>();
  for (const layerId of layerIds) {
    baseFilters.set(layerId, typeof map.getFilter === "function" ? map.getFilter(layerId) : undefined);
  }
  return (window) => {
    const range = [
      [">=", ["get", timeField], window.start],
      ["<", ["get", timeField], window.end],
    ];
    for (const layerId of layerIds) {
      const base = baseFilters.get(layerId);
      map.setFilter(layerId, base !== undefined && base !== null ? ["all", base, ...range] : ["all", ...range]);
    }
  };
}

// ── Time parsing ─────────────────────────────────────────────────

function toEpochMs(value: TemporalInstant | undefined, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new HonuaTemporalPlaybackError(`${label} must be an epoch-ms number, Date, or ISO-8601 string.`);
}

function requirePositive(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HonuaTemporalPlaybackError(`${label} must be a positive, finite number.`);
  }
  return value;
}
