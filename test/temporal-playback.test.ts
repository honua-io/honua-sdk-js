import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HonuaTemporalPlaybackError, createTemporalPlayback } from "../src/map/index.js";
import type { TemporalPlaybackTick, TemporalWindow } from "../src/map/index.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const T1 = T0 + 10 * DAY;

describe("createTemporalPlayback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates options", () => {
    expect(() => createTemporalPlayback({ extent: [T1, T0], windowMs: DAY, apply: () => {} })).toThrow(
      HonuaTemporalPlaybackError,
    );
    expect(() => createTemporalPlayback({ extent: [T0, T1], windowMs: 0, apply: () => {} })).toThrow(/windowMs/);
    expect(() => createTemporalPlayback({ extent: [T0, T1], windowMs: DAY })).toThrow(/sink/);
    expect(() =>
      createTemporalPlayback({ extent: [T0, T1], windowMs: DAY, handle: { setFilter: async () => ({}) } }),
    ).toThrow(/timeField/);
    expect(() => createTemporalPlayback({ extent: ["garbage", T1], windowMs: DAY, apply: () => {} })).toThrow(
      /extent\[0\]/,
    );
  });

  it("accepts Date and ISO extents", () => {
    const playback = createTemporalPlayback({
      extent: [new Date(T0), "2026-01-11T00:00:00Z"],
      windowMs: DAY,
      apply: () => {},
    });
    expect(playback.extent).toEqual({ start: T0, end: T1 });
    expect(playback.window).toEqual({ start: T0, end: T0 + DAY });
    playback.dispose();
  });

  it("plays: applies the current window immediately, then advances by stepMs per frame", async () => {
    const windows: TemporalWindow[] = [];
    const ticks: TemporalPlaybackTick[] = [];
    const playback = createTemporalPlayback({
      extent: [T0, T1],
      windowMs: 2 * DAY,
      stepMs: DAY,
      frameIntervalMs: 100,
      apply: (window) => {
        windows.push(window);
      },
    });
    playback.on("tick", (tick) => ticks.push(tick));

    playback.play();
    expect(playback.playing).toBe(true);
    await vi.advanceTimersByTimeAsync(250); // initial apply + 2 frames
    expect(windows).toEqual([
      { start: T0, end: T0 + 2 * DAY },
      { start: T0 + DAY, end: T0 + 3 * DAY },
      { start: T0 + 2 * DAY, end: T0 + 4 * DAY },
    ]);
    expect(ticks).toHaveLength(3);
    expect(ticks[0].progress).toBe(0);
    expect(ticks[2].window.start).toBe(T0 + 2 * DAY);

    playback.pause();
    expect(playback.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(windows).toHaveLength(3); // no frames while paused
    playback.dispose();
  });

  it("clamps at the extent end, emits end, and pauses (no loop)", async () => {
    const events: string[] = [];
    const playback = createTemporalPlayback({
      extent: [T0, T0 + 3 * DAY],
      windowMs: DAY,
      frameIntervalMs: 100,
      apply: () => {},
    });
    playback.on("end", () => events.push("end"));
    playback.on("pause", () => events.push("pause"));
    playback.on("tick", (tick) => events.push(`tick:${(tick.window.start - T0) / DAY}`));

    playback.play();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(["tick:0", "tick:1", "tick:2", "pause", "end"]);
    expect(playback.playing).toBe(false);
    expect(playback.window).toEqual({ start: T0 + 2 * DAY, end: T0 + 3 * DAY });
    playback.dispose();
  });

  it("loops back to the extent start when loop is set", async () => {
    const starts: number[] = [];
    const playback = createTemporalPlayback({
      extent: [T0, T0 + 2 * DAY],
      windowMs: DAY,
      frameIntervalMs: 100,
      loop: true,
      apply: (window) => {
        starts.push((window.start - T0) / DAY);
      },
    });
    playback.play();
    await vi.advanceTimersByTimeAsync(450);
    expect(starts).toEqual([0, 1, 0, 1, 0]);
    expect(playback.playing).toBe(true);
    playback.dispose();
  });

  it("scrub clamps into the extent and applies immediately", async () => {
    const windows: TemporalWindow[] = [];
    const playback = createTemporalPlayback({
      extent: [T0, T1],
      windowMs: DAY,
      apply: (window) => {
        windows.push(window);
      },
    });
    playback.scrub(T0 + 4 * DAY);
    await vi.advanceTimersByTimeAsync(1);
    playback.scrub(T0 - 5 * DAY); // clamps to start
    await vi.advanceTimersByTimeAsync(1);
    playback.scrub(T1 + 5 * DAY); // clamps to last full window
    await vi.advanceTimersByTimeAsync(1);
    expect(windows).toEqual([
      { start: T0 + 4 * DAY, end: T0 + 5 * DAY },
      { start: T0, end: T0 + DAY },
      { start: T1 - DAY, end: T1 },
    ]);
    playback.dispose();
  });

  it("setWindow revalidates, keeps the start, and clamps to the extent", async () => {
    const windows: TemporalWindow[] = [];
    const playback = createTemporalPlayback({
      extent: [T0, T1],
      windowMs: DAY,
      apply: (window) => {
        windows.push(window);
      },
    });
    playback.scrub(T1 - DAY);
    playback.setWindow(3 * DAY); // start must clamp back so the window fits
    await vi.advanceTimersByTimeAsync(1);
    expect(windows.at(-1)).toEqual({ start: T1 - 3 * DAY, end: T1 });
    expect(() => playback.setWindow(-1)).toThrow(/windowMs/);
    playback.dispose();
  });

  it("coalesces slow applications: at most one in flight plus the latest pending window", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const applied: number[] = [];
    let release: (() => void) | undefined;
    const playback = createTemporalPlayback({
      extent: [T0, T1],
      windowMs: DAY,
      apply: async (window) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        inFlight -= 1;
        applied.push((window.start - T0) / DAY);
      },
    });
    // Scrub five times while the first application is still pending.
    for (let day = 0; day < 5; day++) playback.scrub(T0 + day * DAY);
    await vi.advanceTimersByTimeAsync(0); // let the first sink start
    expect(maxInFlight).toBe(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0); // drain: latest pending window starts
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    // Only the first and the LATEST pending window ran; days 1-3 were dropped.
    expect(applied).toEqual([0, 4]);
    expect(maxInFlight).toBe(1);
    playback.dispose();
  });

  it("emits error events instead of throwing from the timer", async () => {
    const errors: unknown[] = [];
    const playback = createTemporalPlayback({
      extent: [T0, T1],
      windowMs: DAY,
      apply: () => {
        throw new Error("sink failed");
      },
    });
    playback.on("error", (error) => errors.push(error));
    playback.scrub(T0 + DAY);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("sink failed");
    playback.dispose();
  });

  it("drives a bridge handle with a where-clause window filter", async () => {
    const queries: Array<{ where?: string } | undefined> = [];
    const handle = {
      setFilter: async (query: { where?: string } | undefined) => {
        queries.push(query);
        return {};
      },
    };
    const playback = createTemporalPlayback({
      handle,
      timeField: "event_time",
      baseQuery: { where: "STATUS = 'ACTIVE'", outFields: ["id"] },
      extent: [T0, T1],
      windowMs: DAY,
    });
    playback.scrub(T0);
    await vi.advanceTimersByTimeAsync(1);
    expect(queries).toEqual([
      {
        where: `(STATUS = 'ACTIVE') AND (event_time >= ${T0} AND event_time < ${T0 + DAY})`,
        outFields: ["id"],
      },
    ]);
    playback.dispose();
  });

  it("supports a custom where formatter", async () => {
    const queries: Array<{ where?: string } | undefined> = [];
    const playback = createTemporalPlayback({
      handle: {
        setFilter: async (query: { where?: string } | undefined) => {
          queries.push(query);
          return {};
        },
      },
      timeField: "event_time",
      formatWhere: (window, field) =>
        `${field} BETWEEN timestamp '${new Date(window.start).toISOString()}' AND timestamp '${new Date(window.end).toISOString()}'`,
      extent: [T0, T1],
      windowMs: DAY,
    });
    playback.scrub(T0);
    await vi.advanceTimersByTimeAsync(1);
    expect(queries[0]?.where).toBe(
      "event_time BETWEEN timestamp '2026-01-01T00:00:00.000Z' AND timestamp '2026-01-02T00:00:00.000Z'",
    );
    playback.dispose();
  });

  it("drives MapLibre layer filters composed with the bind-time base filter", async () => {
    const setCalls: Array<[string, unknown]> = [];
    const map = {
      setFilter: (layerId: string, filter: unknown) => {
        setCalls.push([layerId, filter]);
      },
      getFilter: (layerId: string) => (layerId === "quakes-point" ? ["==", ["geometry-type"], "Point"] : undefined),
    };
    const playback = createTemporalPlayback({
      layer: { map, layerIds: ["quakes-point", "quakes-line"] },
      timeField: "time",
      extent: [T0, T1],
      windowMs: DAY,
    });
    playback.scrub(T0 + DAY);
    await vi.advanceTimersByTimeAsync(1);
    expect(setCalls).toEqual([
      [
        "quakes-point",
        [
          "all",
          ["==", ["geometry-type"], "Point"],
          [">=", ["get", "time"], T0 + DAY],
          ["<", ["get", "time"], T0 + 2 * DAY],
        ],
      ],
      ["quakes-line", ["all", [">=", ["get", "time"], T0 + DAY], ["<", ["get", "time"], T0 + 2 * DAY]]],
    ]);
    playback.dispose();
  });

  it("dispose stops the timer, drops listeners, and is idempotent", async () => {
    const windows: TemporalWindow[] = [];
    const playback = createTemporalPlayback({
      extent: [T0, T1],
      windowMs: DAY,
      frameIntervalMs: 100,
      apply: (window) => {
        windows.push(window);
      },
    });
    playback.play();
    await vi.advanceTimersByTimeAsync(150);
    const seen = windows.length;
    playback.dispose();
    playback.dispose();
    playback.play();
    playback.scrub(T0 + DAY);
    await vi.advanceTimersByTimeAsync(500);
    expect(windows).toHaveLength(seen);
    expect(playback.playing).toBe(false);
  });
});
