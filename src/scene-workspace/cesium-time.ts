/**
 * Application time and rebuild boundaries for the Cesium scene adapter.
 *
 * Issue #930 gave the Cesium mount a diff: identity plus configuration
 * fingerprint decide what is reused and what is rebuilt. What it did not have
 * was a *time*. `applyCesiumScenePrimitives()` accepted the workspace state —
 * the object carrying the `timeline` and `realtime` slices — and dropped it.
 * This module is the missing half:
 *
 * - {@link sceneTimelineToCesiumClockPlan} turns the renderer-neutral
 *   `SceneTimelineState` into the exact set of writes a Cesium `Clock` accepts.
 *   It is pure and Cesium-free, so a host can inspect (and a test can assert)
 *   what would be written without loading the optional peer.
 * - {@link applyCesiumClockPlan} performs those writes against a live clock and
 *   hands back the snapshot needed to undo them, so time participates in the
 *   adapter's existing transactional rollback exactly like the terrain provider.
 * - {@link bindTemporalPlaybackToCesium} gives the renderer-neutral playback
 *   controller (`createTemporalPlayback`, `@honua/sdk-js/map`) a Cesium sink, so
 *   the same controller that drives a MapLibre map and `<honua-time-slider>`
 *   drives a globe.
 * - {@link SceneRebuildBoundary} names, on the *beta* primitive path, what an
 *   update had to cross. Before this the vocabulary existed only as a detail
 *   field on the experimental entity slice's `incremental-update` diagnostic.
 *
 * ## Clock ownership
 *
 * The adapter binds a clock **only when the host opts in** by putting one on the
 * scene target ({@link CesiumClockTarget.clock}). A target without a clock is
 * never given one, and a target that declares `clockOwnership: "host"` is never
 * written to at all — a host driving `viewer.clock` from Cesium's own Animation
 * widget, or from a simulation loop, must not have the SDK fighting it. Both
 * refusals are reported rather than silent, so "the time did not reach the
 * globe" is always visible in the diagnostic list.
 *
 * ## Time is not a rebuild
 *
 * Application time lives in the workspace state, never in the scene plan, so it
 * is outside the fingerprint the mount diffs on. Advancing time therefore
 * crosses no rebuild boundary: every mounted binding is reused untouched and the
 * only mutation is on the clock. That property is asserted, not assumed
 * (`test/cesium-scene-temporal.test.ts`, and against a real `Viewer` in
 * `test/playwright/cesium-scene-adapter-fixtures.spec.mjs`).
 *
 * @beta Part of the beta `@honua/app-platform/scene-workspace` surface: these
 *   exports are not renamed or removed through 0.1.x, and the boundary and
 *   diagnostic vocabularies grow additively.
 * @module
 */

import type { ScenePrimitiveDiagnostic, SceneRuntimePrimitiveKind } from "./primitives.js";
import type { SceneTimelineState } from "./types.js";

// ── Clock binding ────────────────────────────────────────────────

/**
 * Who owns transport on the bound Cesium clock.
 *
 * - `"adapter"` (default): the SDK writes the canonical application time, and
 *   the transport fields the workspace timeline actually declares.
 * - `"host"`: the SDK writes nothing. Declare this when Cesium's own Animation /
 *   Timeline widgets, or a host simulation loop, own `viewer.clock`. The
 *   adapter still reports what it would have applied, so standing down is
 *   visible rather than indistinguishable from a missing binding.
 */
export type CesiumClockOwnership = "adapter" | "host";

/**
 * The minimal slice of Cesium's `Clock` the time binding touches. A real
 * `viewer.clock` satisfies it; tests pass a plain object.
 *
 * Times are `unknown` because they are Cesium `JulianDate` instances, which this
 * module never constructs itself — it asks the lazily-loaded peer for them.
 */
export interface CesiumClockLike {
  currentTime?: unknown;
  startTime?: unknown;
  stopTime?: unknown;
  multiplier?: number;
  shouldAnimate?: boolean;
}

/**
 * A scene target that may carry a clock. {@link CesiumSceneRuntimeTarget}
 * extends this, so anything the adapter accepts can drive time.
 */
export interface CesiumClockTarget {
  /**
   * Opt-in application-time binding: the live Cesium `Clock` (`viewer.clock`).
   * Omit it and the adapter never reads or writes a clock — a declared
   * application time is then reported as `scene-time-clock-unbound` instead of
   * being silently dropped.
   */
  readonly clock?: CesiumClockLike;
  /** Who owns transport on {@link clock}. Defaults to `"adapter"`. */
  readonly clockOwnership?: CesiumClockOwnership;
}

/**
 * The Cesium symbols the clock binding needs. Modelled as the minimal slice of
 * `typeof import("cesium")` so an injected stub satisfies it without a live
 * `Viewer`.
 */
export interface CesiumClockRuntimeModule {
  readonly JulianDate: {
    fromIso8601(value: string): unknown;
  };
}

/** Inject the peer, or a lazy loader for it. */
export type CesiumClockRuntimeLoader = () => Promise<CesiumClockRuntimeModule>;

/**
 * The exact writes a {@link SceneTimelineState} implies for a Cesium `Clock`.
 *
 * Instants stay ISO-8601 strings here — this plan is computable, comparable, and
 * loggable without the Cesium peer, which is what keeps time diagnostics
 * available to a host that has not loaded CesiumJS.
 */
export interface CesiumClockPlan {
  /** Canonical application time → `Clock.currentTime`. */
  readonly currentTime?: string;
  /** Timeline extent start → `Clock.startTime`. */
  readonly startTime?: string;
  /** Timeline extent end → `Clock.stopTime`. */
  readonly stopTime?: string;
  /** Clock rate → `Clock.multiplier` (simulated seconds per real second). */
  readonly multiplier?: number;
  /** Transport → `Clock.shouldAnimate`. */
  readonly shouldAnimate?: boolean;
  /**
   * Timeline fields that were declared but could not be interpreted (an
   * unparseable instant, a non-finite rate, an inverted extent). They are named
   * rather than dropped: a plan with a non-empty `rejected` list is what raises
   * `scene-time-invalid`.
   */
  readonly rejected: readonly string[];
}

/** The clock values a binding displaced, kept so they can be restored exactly. */
export interface CesiumClockSnapshot {
  readonly currentTime: unknown;
  readonly startTime: unknown;
  readonly stopTime: unknown;
  readonly multiplier: number | undefined;
  readonly shouldAnimate: boolean | undefined;
}

/** Stable diagnostic codes emitted by the Cesium time binding. */
export type SceneTimeDiagnosticCode =
  | "scene-time-applied"
  | "scene-time-host-owned"
  | "scene-time-clock-unbound"
  | "scene-time-invalid"
  | "scene-time-runtime-unavailable";

/**
 * Translate a renderer-neutral timeline slice into Cesium clock writes.
 *
 * Pure: no Cesium import, no clock, no side effect. Returns `undefined` when the
 * timeline declares nothing at all, so an empty slice (the default workspace
 * state) produces no diagnostic and no write.
 *
 * `currentTime`, `startTime`, and `endTime` are ISO-8601 in the workspace
 * contract and are passed through as strings for `JulianDate.fromIso8601`; each
 * is validated with `Date.parse` first so an unparseable instant is *named*
 * rather than handed to Cesium. The extent is applied only when both ends parse
 * and `start < end`, because a half or inverted extent would leave a Cesium
 * `Timeline` widget describing a range that does not exist.
 */
export function sceneTimelineToCesiumClockPlan(timeline: SceneTimelineState | undefined): CesiumClockPlan | undefined {
  if (!timeline) return undefined;
  const declared =
    timeline.currentTime !== undefined ||
    timeline.startTime !== undefined ||
    timeline.endTime !== undefined ||
    timeline.playing !== undefined ||
    timeline.speed !== undefined;
  if (!declared) return undefined;

  const rejected: string[] = [];
  const instant = (value: string | undefined, label: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      rejected.push(label);
      return undefined;
    }
    return value;
  };

  const currentTime = instant(timeline.currentTime, "currentTime");
  const startTime = instant(timeline.startTime, "startTime");
  const endTime = instant(timeline.endTime, "endTime");
  const extentOrdered =
    startTime !== undefined && endTime !== undefined ? Date.parse(startTime) < Date.parse(endTime) : false;
  if (startTime !== undefined && endTime !== undefined && !extentOrdered) rejected.push("extent");

  let multiplier: number | undefined;
  if (timeline.speed !== undefined) {
    if (typeof timeline.speed === "number" && Number.isFinite(timeline.speed)) multiplier = timeline.speed;
    else rejected.push("speed");
  }
  const shouldAnimate = typeof timeline.playing === "boolean" ? timeline.playing : undefined;
  if (timeline.playing !== undefined && shouldAnimate === undefined) rejected.push("playing");

  return Object.freeze({
    ...(currentTime === undefined ? {} : { currentTime }),
    ...(extentOrdered ? { startTime, stopTime: endTime } : {}),
    ...(multiplier === undefined ? {} : { multiplier }),
    ...(shouldAnimate === undefined ? {} : { shouldAnimate }),
    rejected: Object.freeze(rejected),
  });
}

/** Whether a plan would actually write anything to a clock. */
export function cesiumClockPlanWrites(plan: CesiumClockPlan | undefined): boolean {
  if (!plan) return false;
  return (
    plan.currentTime !== undefined ||
    plan.startTime !== undefined ||
    plan.stopTime !== undefined ||
    plan.multiplier !== undefined ||
    plan.shouldAnimate !== undefined
  );
}

/** Read the clock values a plan is about to displace. */
export function readCesiumClock(clock: CesiumClockLike): CesiumClockSnapshot {
  return {
    currentTime: clock.currentTime,
    startTime: clock.startTime,
    stopTime: clock.stopTime,
    multiplier: clock.multiplier,
    shouldAnimate: clock.shouldAnimate,
  };
}

/** Restore a clock to a snapshot taken by {@link readCesiumClock}. */
export function restoreCesiumClock(clock: CesiumClockLike, snapshot: CesiumClockSnapshot): void {
  clock.currentTime = snapshot.currentTime;
  clock.startTime = snapshot.startTime;
  clock.stopTime = snapshot.stopTime;
  clock.multiplier = snapshot.multiplier;
  clock.shouldAnimate = snapshot.shouldAnimate;
}

/**
 * Apply a {@link CesiumClockPlan} to a live clock and return what it displaced.
 *
 * The extent is written before `currentTime` so a clock whose `clockRange`
 * clamps to `[startTime, stopTime]` accepts the new instant rather than pinning
 * it to the previous range's edge.
 */
export function applyCesiumClockPlan(
  clock: CesiumClockLike,
  plan: CesiumClockPlan,
  runtime: CesiumClockRuntimeModule,
): CesiumClockSnapshot {
  const previous = readCesiumClock(clock);
  if (plan.startTime !== undefined && plan.stopTime !== undefined) {
    clock.startTime = runtime.JulianDate.fromIso8601(plan.startTime);
    clock.stopTime = runtime.JulianDate.fromIso8601(plan.stopTime);
  }
  if (plan.currentTime !== undefined) clock.currentTime = runtime.JulianDate.fromIso8601(plan.currentTime);
  if (plan.multiplier !== undefined) clock.multiplier = plan.multiplier;
  if (plan.shouldAnimate !== undefined) clock.shouldAnimate = plan.shouldAnimate;
  return previous;
}

/** Whether a loaded peer exposes the time symbols the clock binding needs. */
export function isCesiumClockRuntime(runtime: unknown): runtime is CesiumClockRuntimeModule {
  if (runtime === null || typeof runtime !== "object") return false;
  const julian = (runtime as { JulianDate?: { fromIso8601?: unknown } }).JulianDate;
  return typeof julian?.fromIso8601 === "function";
}

/** The outcome of one time application, ready to fold into an apply result. */
export interface CesiumSceneTimeApplication {
  /** `true` when at least one clock field was written. */
  readonly applied: boolean;
  /** What the plan asked for, whether or not it was applied. */
  readonly plan: CesiumClockPlan | undefined;
  /** Displaced values, present only when something was written. */
  readonly previous: CesiumClockSnapshot | undefined;
  readonly diagnostics: readonly ScenePrimitiveDiagnostic[];
}

const NO_TIME_APPLICATION: CesiumSceneTimeApplication = Object.freeze({
  applied: false,
  plan: undefined,
  previous: undefined,
  diagnostics: Object.freeze([]),
});

function timeDiagnostic(
  code: SceneTimeDiagnosticCode,
  severity: ScenePrimitiveDiagnostic["severity"],
  status: ScenePrimitiveDiagnostic["status"],
  message: string,
  context: Readonly<Record<string, unknown>>,
  fallback?: string,
): ScenePrimitiveDiagnostic {
  return {
    code,
    severity,
    status,
    renderer: "cesium",
    message,
    ...(fallback === undefined ? {} : { fallback }),
    context,
  };
}

function planContext(plan: CesiumClockPlan): Readonly<Record<string, unknown>> {
  return {
    ...(plan.currentTime === undefined ? {} : { currentTime: plan.currentTime }),
    ...(plan.startTime === undefined ? {} : { startTime: plan.startTime }),
    ...(plan.stopTime === undefined ? {} : { stopTime: plan.stopTime }),
    ...(plan.multiplier === undefined ? {} : { multiplier: plan.multiplier }),
    ...(plan.shouldAnimate === undefined ? {} : { shouldAnimate: plan.shouldAnimate }),
  };
}

/**
 * Bind the workspace timeline slice to a scene target's clock.
 *
 * Every arm reports itself, so the diagnostic list always answers "did the
 * application time reach the globe, and if not, why":
 *
 * | Situation | Code | Status |
 * | --- | --- | --- |
 * | Written to the clock | `scene-time-applied` | supported |
 * | `clockOwnership: "host"` | `scene-time-host-owned` | supported |
 * | Time declared, no clock on the target | `scene-time-clock-unbound` | degraded |
 * | Time declared but uninterpretable | `scene-time-invalid` | degraded |
 * | Peer has no usable `JulianDate` | `scene-time-runtime-unavailable` | degraded |
 *
 * The `rebuildBoundary: "none"` on `scene-time-applied` is load-bearing: it
 * states, in the same vocabulary the mount uses for plan revisions, that moving
 * time rebuilt nothing.
 */
export function applyCesiumSceneTime(
  target: CesiumClockTarget,
  timeline: SceneTimelineState | undefined,
  runtime: unknown,
): CesiumSceneTimeApplication {
  const plan = sceneTimelineToCesiumClockPlan(timeline);
  if (!plan) return NO_TIME_APPLICATION;

  if (plan.rejected.length > 0 && !cesiumClockPlanWrites(plan)) {
    return {
      applied: false,
      plan,
      previous: undefined,
      diagnostics: [
        timeDiagnostic(
          "scene-time-invalid",
          "warning",
          "degraded",
          `The scene timeline declares application time this adapter cannot interpret: ${plan.rejected.join(", ")}.`,
          { rejected: [...plan.rejected] },
          "Supply ISO-8601 instants (and a finite speed) on the workspace timeline slice.",
        ),
      ],
    };
  }

  const ownership: CesiumClockOwnership = target.clockOwnership ?? "adapter";
  if (!target.clock) {
    return {
      applied: false,
      plan,
      previous: undefined,
      diagnostics: [
        timeDiagnostic(
          "scene-time-clock-unbound",
          "warning",
          "degraded",
          "The scene timeline declares an application time, but no Cesium clock is bound to this target.",
          { ...planContext(plan), ownership },
          "Attach the viewer's clock to the scene target: `{ camera: viewer.camera, scene: viewer.scene, clock: viewer.clock }`.",
        ),
      ],
    };
  }
  if (ownership === "host") {
    return {
      applied: false,
      plan,
      previous: undefined,
      diagnostics: [
        timeDiagnostic(
          "scene-time-host-owned",
          "info",
          "supported",
          "The host owns this Cesium clock; the adapter reported the application time without writing it.",
          { ...planContext(plan), ownership },
        ),
      ],
    };
  }
  if (!isCesiumClockRuntime(runtime)) {
    return {
      applied: false,
      plan,
      previous: undefined,
      diagnostics: [
        timeDiagnostic(
          "scene-time-runtime-unavailable",
          "warning",
          "degraded",
          "The loaded Cesium runtime does not expose JulianDate.fromIso8601, so application time cannot be bound.",
          { ...planContext(plan), ownership },
          "Upgrade the `cesium` peer to a build that exports JulianDate.",
        ),
      ],
    };
  }

  const previous = applyCesiumClockPlan(target.clock, plan, runtime);
  const diagnostics: ScenePrimitiveDiagnostic[] = [
    timeDiagnostic(
      "scene-time-applied",
      "info",
      "supported",
      "Bound canonical application time to the Cesium clock without rebuilding any scene primitive.",
      { ...planContext(plan), ownership, rebuildBoundary: "none" satisfies SceneRebuildBoundary },
    ),
  ];
  if (plan.rejected.length > 0) {
    diagnostics.push(
      timeDiagnostic(
        "scene-time-invalid",
        "warning",
        "degraded",
        `Part of the scene timeline could not be interpreted and was not applied: ${plan.rejected.join(", ")}.`,
        { rejected: [...plan.rejected] },
        "Supply ISO-8601 instants (and a finite speed) on the workspace timeline slice.",
      ),
    );
  }
  return { applied: true, plan, previous, diagnostics };
}

// ── Rebuild boundaries ───────────────────────────────────────────

/**
 * What an update had to cross to land.
 *
 * - `none` — applied in place. The binding's renderer resource was reused
 *   untouched. Advancing application time is always this.
 * - `primitive-identity` — the binding is new to this mount (kind + id were not
 *   previously mounted), so its resource was constructed.
 * - `primitive-configuration` — the binding's configuration fingerprint changed,
 *   so its resource was rebuilt. This is the boundary a realtime data delta
 *   crosses when it revises a binding rather than only its time.
 * - `plan-membership` — the binding left the plan, so its resource was released.
 * - `unfingerprintable` — the primitive could not be fingerprinted
 *   deterministically, so it was rebuilt conservatively rather than assumed
 *   unchanged.
 */
export type SceneRebuildBoundary =
  | "none"
  | "primitive-identity"
  | "primitive-configuration"
  | "plan-membership"
  | "unfingerprintable";

/** The boundary vocabulary, in escalation order. */
export const SCENE_REBUILD_BOUNDARIES: readonly SceneRebuildBoundary[] = Object.freeze([
  "none",
  "primitive-identity",
  "primitive-configuration",
  "plan-membership",
  "unfingerprintable",
]);

/** One binding's outcome across an update. */
export interface SceneRebuildBoundaryReport {
  readonly id: string;
  readonly kind: SceneRuntimePrimitiveKind;
  readonly boundary: SceneRebuildBoundary;
  /** `true` when the binding's renderer resource survived the update untouched. */
  readonly incremental: boolean;
  readonly reason: string;
}

const BOUNDARY_REASONS: Readonly<Record<SceneRebuildBoundary, string>> = Object.freeze({
  none: "Identity and configuration are unchanged; the renderer resource was reused.",
  "primitive-identity": "The binding was not previously mounted; its renderer resource was constructed.",
  "primitive-configuration": "The configuration fingerprint changed; the renderer resource was rebuilt.",
  "plan-membership": "The binding left the plan; its renderer resource was released.",
  unfingerprintable: "The primitive could not be fingerprinted deterministically and was rebuilt conservatively.",
});

/** Build one boundary report with the vocabulary's own stable reason text. */
export function sceneRebuildBoundaryReport(
  id: string,
  kind: SceneRuntimePrimitiveKind,
  boundary: SceneRebuildBoundary,
): SceneRebuildBoundaryReport {
  return Object.freeze({
    id,
    kind,
    boundary,
    incremental: boundary === "none",
    reason: BOUNDARY_REASONS[boundary],
  });
}

// ── Temporal playback sink ───────────────────────────────────────

/** A half-open window `[start, end)` in epoch milliseconds. */
export interface CesiumTemporalPlaybackWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * The structural slice of a temporal playback controller this binding drives.
 *
 * Declared here rather than imported so `scene-workspace` never pulls the `/map`
 * entrypoint into its graph — the same structural-typing posture
 * `<honua-time-slider>` takes with `HonuaTimeSliderPlayback`. A
 * `createTemporalPlayback()` controller satisfies it exactly.
 */
export interface CesiumTemporalPlayback {
  readonly playing: boolean;
  /** The window currently applied by the controller. */
  readonly window: CesiumTemporalPlaybackWindow;
  /** The full playable extent. */
  readonly extent: CesiumTemporalPlaybackWindow;
  /** Current playback rate multiplier, when the controller exposes one. */
  readonly speed?: number;
  on(type: "tick", listener: (event: { window: CesiumTemporalPlaybackWindow }) => void): { remove(): void };
  on(type: "play" | "pause" | "end", listener: () => void): { remove(): void };
  on(type: "error", listener: (error: unknown) => void): { remove(): void };
}

/**
 * Which edge of the playback window becomes the clock's instant.
 *
 * A playback window is an interval and a Cesium clock is an instant, so the
 * mapping is `equivalent`, never exact. `"window-start"` (the default) matches
 * `<honua-time-slider>`'s `aria-valuenow` and the controller's own `scrub()` and
 * `progress` semantics, so a slider and a globe agree on what time it is.
 * `"window-end"` binds the window's leading edge instead, which is what a
 * trailing-window live feed usually means by "now".
 */
export type CesiumTemporalPlaybackInstant = "window-start" | "window-end";

/**
 * How the binding treats Cesium's own clock animation.
 *
 * - `"paused"` (default): `shouldAnimate` is set to `false` for as long as the
 *   binding is live. The controller is the transport and the SDK is the only
 *   writer of `currentTime`; letting Cesium animate the same clock would put two
 *   drivers on it.
 * - `"mirror"`: `shouldAnimate` follows `playback.playing` and `Clock.multiplier`
 *   follows `playback.speed`, scaled by whatever multiplier the clock carried at
 *   bind time. Cesium then interpolates between the controller's frames and the
 *   controller re-anchors it to canonical time on every tick. Use it when
 *   entity interpolation should look continuous rather than stepped.
 */
export type CesiumTemporalPlaybackTransport = "paused" | "mirror";

/** Options for {@link bindTemporalPlaybackToCesium}. */
export interface BindTemporalPlaybackToCesiumOptions {
  /** Which window edge becomes `Clock.currentTime`. @default "window-start" */
  readonly instant?: CesiumTemporalPlaybackInstant;
  /** How Cesium's own clock animation is treated. @default "paused" */
  readonly transport?: CesiumTemporalPlaybackTransport;
  /**
   * Write `Clock.startTime` / `Clock.stopTime` from the controller's extent so a
   * Cesium `Timeline` widget shows the playable range. @default true
   */
  readonly bindExtent?: boolean;
  /** Apply the controller's current window immediately on bind. @default true */
  readonly applyImmediately?: boolean;
  /** Inject the peer or a lazy loader. Omit to use `import("cesium")`. */
  readonly cesium?: CesiumClockRuntimeModule | CesiumClockRuntimeLoader;
}

/** Why a binding stood down instead of driving the clock. */
export type CesiumTemporalPlaybackRefusal = "clock-unbound" | "host-owned" | "runtime-unavailable";

/** The handle returned by {@link bindTemporalPlaybackToCesium}. */
export interface CesiumTemporalPlaybackBinding {
  /** `false` when the binding stood down; see {@link refusal}. */
  readonly bound: boolean;
  /** Present exactly when {@link bound} is `false`. */
  readonly refusal?: CesiumTemporalPlaybackRefusal;
  /** How many controller events have been written to the clock. */
  readonly applications: number;
  /** The most recent plan written (or, when unbound, the one that was refused). */
  readonly plan: CesiumClockPlan | undefined;
  /**
   * Drop the controller subscriptions and restore the clock exactly as it was at
   * bind time. Idempotent. A binding that never wrote restores nothing.
   */
  dispose(): void;
}

async function loadCesiumClockRuntime(
  source: CesiumClockRuntimeModule | CesiumClockRuntimeLoader | undefined,
): Promise<unknown> {
  if (typeof source === "function") return source();
  if (source !== undefined) return source;
  return await import("cesium");
}

function refusedBinding(
  refusal: CesiumTemporalPlaybackRefusal,
  plan: CesiumClockPlan | undefined,
): CesiumTemporalPlaybackBinding {
  return {
    bound: false,
    refusal,
    applications: 0,
    plan,
    dispose() {
      /* nothing was subscribed and nothing was written */
    },
  };
}

/**
 * Drive a live Cesium clock from a renderer-neutral temporal playback
 * controller.
 *
 * This is the Cesium sink `createTemporalPlayback()` never had: the same
 * controller instance can hold a MapLibre filter binding, a data-to-map bridge
 * `where` clause, a `<honua-time-slider>` view, and now a globe, without any of
 * them knowing about the others.
 *
 * Ownership is the target's, not this function's: a target with no clock, or one
 * that declares `clockOwnership: "host"`, gets an inert binding whose `refusal`
 * names why. Nothing is written and nothing is thrown — a UI binding must not
 * explode because the host drives its own clock.
 *
 * @example
 * ```ts doc-test=skip reason="requires a live Cesium Viewer and a mounted source"
 * const playback = createTemporalPlayback({ handle: mounted, timeField: "observed_at", ... });
 * const binding = await bindTemporalPlaybackToCesium(
 *   { camera: viewer.camera, scene: viewer.scene, clock: viewer.clock },
 *   playback,
 * );
 * playback.play();          // the globe's clock now follows the controller
 * binding.dispose();        // the clock is restored exactly as it was
 * ```
 */
export async function bindTemporalPlaybackToCesium(
  target: CesiumClockTarget,
  playback: CesiumTemporalPlayback,
  options: BindTemporalPlaybackToCesiumOptions = {},
): Promise<CesiumTemporalPlaybackBinding> {
  const instant = options.instant ?? "window-start";
  const transport = options.transport ?? "paused";
  const bindExtent = options.bindExtent !== false;

  // The clock's rate at bind time is the reference the controller's multiplier
  // scales, so `speed: 2` means "twice whatever the host configured" rather than
  // silently redefining the host's simulation rate as 1.
  let baseMultiplier = 1;

  const timelineFor = (window: CesiumTemporalPlaybackWindow): SceneTimelineState => {
    const at = instant === "window-end" ? window.end : window.start;
    return {
      currentTime: new Date(at).toISOString(),
      ...(bindExtent
        ? {
            startTime: new Date(playback.extent.start).toISOString(),
            endTime: new Date(playback.extent.end).toISOString(),
          }
        : {}),
      playing: transport === "mirror" ? playback.playing : false,
      ...(transport === "mirror" ? { speed: (playback.speed ?? 1) * baseMultiplier } : {}),
    };
  };
  const planFor = (window: CesiumTemporalPlaybackWindow): CesiumClockPlan | undefined =>
    sceneTimelineToCesiumClockPlan(timelineFor(window));

  const ownership: CesiumClockOwnership = target.clockOwnership ?? "adapter";
  const clock = target.clock;
  if (!clock) return refusedBinding("clock-unbound", planFor(playback.window));
  if (ownership === "host") return refusedBinding("host-owned", planFor(playback.window));

  const runtime = await loadCesiumClockRuntime(options.cesium);
  if (!isCesiumClockRuntime(runtime)) return refusedBinding("runtime-unavailable", planFor(playback.window));

  const restore = readCesiumClock(clock);
  if (typeof restore.multiplier === "number" && Number.isFinite(restore.multiplier) && restore.multiplier !== 0) {
    baseMultiplier = restore.multiplier;
  }

  let applications = 0;
  let plan: CesiumClockPlan | undefined;
  let disposed = false;

  const write = (window: CesiumTemporalPlaybackWindow): void => {
    if (disposed) return;
    const next = planFor(window);
    if (!next || !cesiumClockPlanWrites(next)) return;
    applyCesiumClockPlan(clock, next, runtime);
    plan = next;
    applications += 1;
  };

  const subscriptions = [
    playback.on("tick", (event) => write(event.window)),
    playback.on("play", () => write(playback.window)),
    playback.on("pause", () => write(playback.window)),
    playback.on("end", () => write(playback.window)),
  ];

  if (options.applyImmediately !== false) write(playback.window);

  return {
    bound: true,
    get applications() {
      return applications;
    },
    get plan() {
      return plan;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.remove();
      restoreCesiumClock(clock, restore);
    },
  };
}
