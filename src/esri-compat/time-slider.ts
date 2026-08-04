import {
  CompatEventBus,
  type CompatEventSubscription,
  resolveCompatEventBus,
  safeInvokeCompatListener,
} from "./event-bus.js";
import { HonuaWidgetHost } from "./widget-host.js";

export type TimeSliderModeCompat = "instant" | "time-window";
export type TimeSliderIntervalUnitCompat = "milliseconds" | "seconds" | "minutes" | "hours" | "days";

export interface TimeExtentCompat {
  start: Date;
  end: Date;
}

export interface TimeSliderStopsCompat {
  values?: readonly (Date | string | number)[];
  interval?: {
    value: number;
    unit: TimeSliderIntervalUnitCompat;
  };
}

export interface TimeSliderCompatOptions {
  view?: unknown;
  container?: unknown;
  eventBus?: CompatEventBus;
  fullTimeExtent?: Partial<{
    start: Date | string | number;
    end: Date | string | number;
  }>;
  timeExtent?: Partial<{
    start: Date | string | number;
    end: Date | string | number;
  }>;
  stops?: TimeSliderStopsCompat;
  mode?: TimeSliderModeCompat;
  loop?: boolean;
  playRate?: number;
}

export type TimeSliderLoadStatusCompat = "not-loaded" | "loading" | "loaded";

/**
 * Structural slice of the app-platform time-slider element's `playback`
 * contract (`HonuaTimeSliderPlayback`), restated here rather than imported:
 * `/esri-compat` is bundle-budgeted and must not reach into the component kit
 * (see `./widget-host.ts`). Drift is caught by the delegation test, which
 * mounts a real `<honua-time-slider>` against this adapter.
 */
interface TimeSliderPlaybackAdapter {
  readonly playing: boolean;
  readonly window: { readonly start: number; readonly end: number };
  readonly extent: { readonly start: number; readonly end: number };
  readonly stepMs: number;
  play(): void;
  pause(): void;
  scrub(time: number): void;
  step(direction?: 1 | -1): void;
  on(type: string, listener: (payload?: unknown) => void): { remove(): void };
}

/** Declared on the element when the widget has no full time extent to scrub. */
const NO_TIME_EXTENT_REASON =
  "This time slider has no full time extent: the service returned no usable time-info metadata.";

export interface TimeSliderHandleCompat {
  remove(): void;
}

export class TimeSliderCompat {
  public readonly view: unknown;
  public readonly container: unknown;
  public readonly eventBus: CompatEventBus;
  public loaded: boolean;
  public loadStatus: TimeSliderLoadStatusCompat;
  public readonly mode: TimeSliderModeCompat;
  public readonly loop: boolean;
  public readonly playRate: number;
  public readonly stops: TimeSliderStopsCompat;
  public fullTimeExtent: TimeExtentCompat | undefined;
  public timeExtent: TimeExtentCompat | undefined;
  public playing: boolean;

  private stopIndex: number;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  /**
   * When a `container` is supplied and a DOM is present, the shim delegates
   * its rendering to the app-platform `<honua-time-slider>` component through
   * {@link HonuaWidgetHost} (issue #959). The element is driven by a
   * playback-controller-shaped adapter over this shim's own stop list, so the
   * migrated widget is a real UI rather than the state model plus an empty
   * container. Headless usage (no container / no DOM / no registered kit)
   * keeps the pre-delegation state-model-only behavior.
   */
  private readonly widgetHost: HonuaWidgetHost | undefined;
  private playbackAdapterCache: TimeSliderPlaybackAdapter | undefined;

  public constructor(options: TimeSliderCompatOptions = {}) {
    this.view = options.view;
    this.container = options.container;
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.view) ?? new CompatEventBus();
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.mode = options.mode ?? "instant";
    this.loop = options.loop ?? false;
    this.playRate = options.playRate ?? 1000;
    this.stops = {
      values: options.stops?.values ? [...options.stops.values] : undefined,
      interval: options.stops?.interval ? { ...options.stops.interval } : undefined,
    };
    this.fullTimeExtent = parseTimeExtent(options.fullTimeExtent);
    this.timeExtent = parseTimeExtent(options.timeExtent) ?? this.fullTimeExtent;
    this.playing = false;
    this.stopIndex = 0;
    this.watchListeners = new Map();
    const widgetHost =
      options.container != null
        ? new HonuaWidgetHost("honua-time-slider", options.container, this.eventBus)
        : undefined;
    this.widgetHost = widgetHost?.available ? widgetHost : undefined;
  }

  public async load(): Promise<TimeSliderCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("timeslider.loading", undefined, this);
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("timeslider.loaded", undefined, this);
    await this.renderWidgetHost();
    return this;
  }

  public async when(callback?: (widget: TimeSliderCompat) => void): Promise<TimeSliderCompat> {
    const widget = await this.load();
    if (callback) {
      callback(widget);
    }
    return widget;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): TimeSliderHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);

    return {
      remove: () => {
        listeners?.delete(listener);
      },
    };
  }

  public setTimeExtent(timeExtent: TimeExtentCompat): void {
    this.timeExtent = {
      start: new Date(timeExtent.start.getTime()),
      end: new Date(timeExtent.end.getTime()),
    };
    this.notifyWatchers("timeExtent", this.timeExtent);
    this.eventBus.emit("timeslider.updated", { timeExtent: this.timeExtent }, this);
    void this.renderWidgetHost();
  }

  public play(): void {
    if (this.playing) {
      return;
    }
    this.playing = true;
    this.notifyWatchers("playing", this.playing);
    this.eventBus.emit("timeslider.play", { playRate: this.playRate }, this);
  }

  public stop(): void {
    if (!this.playing) {
      return;
    }
    this.playing = false;
    this.notifyWatchers("playing", this.playing);
    this.eventBus.emit("timeslider.stop", undefined, this);
  }

  public next(): TimeExtentCompat | undefined {
    const nextExtent = this.shift(1);
    if (nextExtent) {
      this.eventBus.emit("timeslider.next", { timeExtent: nextExtent }, this);
    }
    return nextExtent;
  }

  public previous(): TimeExtentCompat | undefined {
    const previousExtent = this.shift(-1);
    if (previousExtent) {
      this.eventBus.emit("timeslider.previous", { timeExtent: previousExtent }, this);
    }
    return previousExtent;
  }

  private shift(stepDirection: 1 | -1): TimeExtentCompat | undefined {
    const stopValues = this.stops.values?.map((value) => toDate(value)).filter((value): value is Date => !!value);
    if (stopValues && stopValues.length > 0) {
      const lastIndex = stopValues.length - 1;
      this.stopIndex += stepDirection;

      if (this.stopIndex < 0 || this.stopIndex > lastIndex) {
        if (!this.loop) {
          this.stopIndex = Math.max(0, Math.min(lastIndex, this.stopIndex));
          return this.timeExtent;
        }
        this.stopIndex = this.stopIndex < 0 ? lastIndex : 0;
      }

      const current = stopValues[this.stopIndex];
      if (!current) {
        return this.timeExtent;
      }
      const extent = {
        start: current,
        end: current,
      };
      this.setTimeExtent(extent);
      return this.timeExtent;
    }

    const interval = this.stops.interval;
    if (!interval || !this.timeExtent) {
      return this.timeExtent;
    }

    const deltaMillis = intervalToMilliseconds(interval.value, interval.unit) * stepDirection;
    const shifted: TimeExtentCompat = {
      start: new Date(this.timeExtent.start.getTime() + deltaMillis),
      end: new Date(this.timeExtent.end.getTime() + deltaMillis),
    };
    this.setTimeExtent(shifted);
    return this.timeExtent;
  }

  public connectLayer(layer: {
    setTimeExtent(extent: { start: Date; end: Date } | undefined): void;
  }): TimeSliderHandleCompat {
    if (this.timeExtent) {
      layer.setTimeExtent(this.timeExtent);
    }

    const subscription: CompatEventSubscription = this.eventBus.on("timeslider.updated", (event) => {
      const payload = event.payload as { timeExtent?: { start: Date; end: Date } } | undefined;
      if (payload?.timeExtent) {
        layer.setTimeExtent(payload.timeExtent);
      }
    });

    return {
      remove: () => {
        subscription.remove();
      },
    };
  }

  public destroy(): void {
    this.watchListeners.clear();
    this.widgetHost?.destroy();
  }

  /**
   * Mounts (or refreshes) the delegated `<honua-time-slider>`.
   *
   * The element is a view over a playback controller, so the shim hands it a
   * controller-shaped adapter over its own transport rather than a snapshot:
   * one assignment, then every later shim state change reaches the element
   * through the adapter's event bridge. A widget with no usable full time
   * extent — the ArcGIS "the service returned no time-info" case — mounts the
   * element in its declared degraded state instead of a scrubber that cannot
   * move, which is the honest half of REQ-002.
   */
  private async renderWidgetHost(): Promise<void> {
    const host = this.widgetHost;
    if (!host) return;
    const adapter = this.playbackAdapter();
    await host.update((element) => {
      if (!adapter) {
        element.playback = undefined;
        element.setAttribute("unavailable-reason", NO_TIME_EXTENT_REASON);
        return;
      }
      element.removeAttribute("unavailable-reason");
      if (element.playback !== adapter) element.playback = adapter;
    });
  }

  /**
   * A temporal-playback-controller-shaped live view of this shim, or
   * `undefined` while the widget has no full time extent to scrub over.
   * Created once so re-assignment through {@link renderWidgetHost} is a no-op.
   */
  private playbackAdapter(): TimeSliderPlaybackAdapter | undefined {
    if (!this.fullTimeExtent || !this.timeExtent) return undefined;
    if (this.playbackAdapterCache) return this.playbackAdapterCache;
    const shim = this;
    const bridge = (types: readonly string[], listener: (payload?: unknown) => void): { remove(): void } => {
      const subscriptions = types.map((type) => shim.eventBus.on(type, (event) => listener(event.payload)));
      return {
        remove: () => {
          for (const subscription of subscriptions) subscription.remove();
        },
      };
    };
    const adapter: TimeSliderPlaybackAdapter = {
      get playing() {
        return shim.playing;
      },
      get window() {
        const extent = shim.timeExtent ?? shim.fullTimeExtent;
        return { start: extent?.start.getTime() ?? 0, end: extent?.end.getTime() ?? 0 };
      },
      get extent() {
        return {
          start: shim.fullTimeExtent?.start.getTime() ?? 0,
          end: shim.fullTimeExtent?.end.getTime() ?? 0,
        };
      },
      get stepMs() {
        const interval = shim.stops.interval;
        if (interval) return intervalToMilliseconds(interval.value, interval.unit);
        const extent = shim.timeExtent;
        if (!extent) return 0;
        return Math.max(1, extent.end.getTime() - extent.start.getTime());
      },
      play: () => shim.play(),
      pause: () => shim.stop(),
      scrub: (time: number) => {
        const current = shim.timeExtent;
        const span = current ? current.end.getTime() - current.start.getTime() : 0;
        shim.setTimeExtent({ start: new Date(time), end: new Date(time + span) });
      },
      step: (direction: 1 | -1 = 1) => {
        if (direction < 0) shim.previous();
        else shim.next();
      },
      on: (type: string, listener: (payload?: unknown) => void) => {
        if (type === "tick") return bridge(["timeslider.updated", "timeslider.next", "timeslider.previous"], listener);
        if (type === "play") return bridge(["timeslider.play"], listener);
        if (type === "pause") return bridge(["timeslider.stop"], listener);
        return { remove: () => undefined };
      },
    };
    this.playbackAdapterCache = adapter;
    return adapter;
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}

function parseTimeExtent(
  extent:
    | Partial<{
        start: Date | string | number;
        end: Date | string | number;
      }>
    | undefined,
): TimeExtentCompat | undefined {
  if (!extent) {
    return undefined;
  }

  const start = toDate(extent.start);
  const end = toDate(extent.end);
  if (!start || !end) {
    return undefined;
  }
  return { start, end };
}

function toDate(value: Date | string | number | undefined): Date | undefined {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return undefined;
}

function intervalToMilliseconds(value: number, unit: TimeSliderIntervalUnitCompat): number {
  switch (unit) {
    case "milliseconds":
      return value;
    case "seconds":
      return value * 1000;
    case "minutes":
      return value * 60_000;
    case "hours":
      return value * 3_600_000;
    case "days":
      return value * 86_400_000;
  }
}
