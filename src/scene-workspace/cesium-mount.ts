/**
 * Bounded mount lifecycle for Cesium scene primitives.
 *
 * `applyCesiumScenePrimitives()` is a one-shot projection: it hands back the
 * layer handles it created and forgets them. That is fine for a script and wrong
 * for an application, which must be able to revise the plan, cancel a mount that
 * is still loading, and prove on unmount that nothing survived.
 *
 * {@link mountScenePrimitivesToCesium} adds the missing half — one handle that
 * owns every adapter-created renderer resource for as long as the plan is live:
 *
 * - **Bounded.** A mount owns at most {@link MountScenePrimitivesToCesiumOptions.maxLayers}
 *   layer handles. A plan that would exceed the ceiling is rejected before the
 *   Cesium peer is even loaded, so the ceiling is a real admission gate rather
 *   than a post-hoc count.
 * - **Diffed.** Re-applying a revised plan reuses every primitive whose identity
 *   and configuration are unchanged and disposes exactly the ones that left.
 * - **Cancellation-safe.** An `AbortSignal` — the caller's, or the mount's own,
 *   fired by `dispose()` — unwinds an in-flight application through the adapter's
 *   transactional rollback, so an abandoned mount attaches nothing.
 * - **Provably released.** `dispose()` is idempotent and releases every handle
 *   the mount owns exactly once, including after a partially failed application.
 *
 * Diagnostics stay plan-scoped: every application re-diagnoses the whole plan
 * against {@link CESIUM_SCENE_CAPABILITIES}, so a reused primitive still reports
 * its current spatial-reference, terrain, and model findings. The mount adds one
 * lifecycle diagnostic per application describing what it created, reused, and
 * disposed. Plan findings say whether a binding *can* render correctly; mount
 * findings say what the renderer currently owns.
 *
 * @experimental Part of the experimental `scene-workspace` surface; not yet
 *   covered by the SDK's semver contract prior to `1.0.0`.
 * @module
 */

import {
  CESIUM_SCENE_CAPABILITIES,
  type CesiumLayerHandle,
  type CesiumSceneRuntimeTarget,
  applyCesiumScenePrimitivesInternal,
  scenePrimitiveFingerprint,
  scenePrimitiveMountKey,
} from "./cesium-adapter.js";
import {
  type ScenePrimitiveApplyResult,
  type ScenePrimitiveDiagnostic,
  type SceneRuntimePrimitive,
  type SceneRuntimePrimitiveKind,
  summarizeDiagnosticStatus,
} from "./primitives.js";
import type { SceneWorkspaceState } from "./types.js";

/**
 * Default ceiling on the number of live layer handles one mount may own.
 *
 * Terrain, imagery, tilesets, and models each pin GPU and worker resources for
 * as long as they are attached, so an unbounded plan is an unbounded leak. Sixty
 * four is generous for a hand-authored or server-published scene and small
 * enough that a runaway generated plan fails closed instead of exhausting the
 * renderer. Raise it deliberately with
 * {@link MountScenePrimitivesToCesiumOptions.maxLayers}.
 */
export const DEFAULT_SCENE_MOUNT_LAYER_LIMIT = 64;

/**
 * Failure codes raised by the scene mount lifecycle. Each one is a fail-closed
 * refusal, never a partially applied plan.
 */
export type CesiumSceneMountErrorCode = "disposed" | "invalid-option" | "layer-limit-exceeded";

/**
 * A lifecycle refusal from {@link mountScenePrimitivesToCesium} or
 * {@link MountedCesiumScenePrimitives.apply}. Renderer failures surfacing from
 * Cesium itself keep their own error types; this one is raised only by the
 * mount's own contract.
 */
export class HonuaCesiumSceneMountError extends Error {
  public constructor(
    public readonly code: CesiumSceneMountErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaCesiumSceneMountError";
  }
}

/**
 * Lifecycle state of a scene mount.
 *
 * `disposing` is reachable in two ways: transiently, while `dispose()` runs, and
 * durably, when a handle refused to release. The second case keeps the mount
 * retryable — `dispose()` may be called again and will retry only what is still
 * owned — while permanently refusing new applications.
 */
export type CesiumSceneMountState = "ready" | "applying" | "disposing" | "disposed";

/** Options for {@link mountScenePrimitivesToCesium}. */
export interface MountScenePrimitivesToCesiumOptions {
  /**
   * Cancels the initial application. Aborting before or during materialization
   * leaves the scene untouched, releases anything already attached, and rejects
   * the mount promise with the signal's reason.
   */
  readonly signal?: AbortSignal;
  /**
   * Ceiling on the live layer handles this mount may own. Defaults to
   * {@link DEFAULT_SCENE_MOUNT_LAYER_LIMIT}. Must be a positive integer.
   */
  readonly maxLayers?: number;
  /** Workspace state carried alongside the plan, mirroring the adapter's `apply`. */
  readonly state?: SceneWorkspaceState;
}

/** Options for {@link MountedCesiumScenePrimitives.apply}. */
export interface ApplyMountedScenePrimitivesOptions {
  /** Cancels this application only; the mount itself stays usable. */
  readonly signal?: AbortSignal;
  /** Workspace state carried alongside the plan, mirroring the adapter's `apply`. */
  readonly state?: SceneWorkspaceState;
}

/**
 * The result of one application through a mount: the adapter's own apply result
 * plus the diff that produced it.
 */
export interface MountedScenePrimitiveApplyResult extends ScenePrimitiveApplyResult {
  /** Live layer handles keyed by primitive id, reused and newly created alike. */
  readonly layers: ReadonlyMap<string, CesiumLayerHandle>;
  /** 1 for the initial application, incremented for every revision. */
  readonly revision: number;
  /** Ids whose renderer resource was constructed by this application. */
  readonly created: readonly string[];
  /** Ids whose renderer resource was carried forward untouched. */
  readonly reused: readonly string[];
  /** Ids whose renderer resource was released because the primitive left or changed. */
  readonly disposed: readonly string[];
}

/**
 * One mount of a scene plan against a live Cesium target.
 *
 * The mount owns every layer handle it created. Callers hold the mount, not the
 * handles: a revision goes through {@link apply} and teardown goes through
 * {@link dispose}, so there is never a set of handles the caller must remember
 * to release separately.
 */
export interface MountedCesiumScenePrimitives {
  readonly renderer: "cesium";
  /** Lifecycle state. See {@link CesiumSceneMountState}. */
  readonly state: CesiumSceneMountState;
  /** Status of the most recent application, summarized from its diagnostics. */
  readonly status: ScenePrimitiveApplyResult["status"];
  /** Diagnostics from the most recent application: plan findings plus the lifecycle finding. */
  readonly diagnostics: readonly ScenePrimitiveDiagnostic[];
  /** Live layer handles keyed by primitive id. Empty once disposed. */
  readonly layers: ReadonlyMap<string, CesiumLayerHandle>;
  /** The ceiling this mount was created with. */
  readonly layerLimit: number;
  /** 1 after the initial application, incremented for every revision. */
  readonly revision: number;
  /**
   * Apply a revised plan through this mount. Primitives whose identity and
   * configuration are unchanged are reused untouched; primitives that left the
   * plan — or whose configuration changed — are disposed once the revision has
   * landed. A failure rolls the scene back to the previously applied plan.
   *
   * Applications are serialized: a second call queues behind the first rather
   * than interleaving scene mutations.
   */
  apply(
    primitives: readonly SceneRuntimePrimitive[],
    options?: ApplyMountedScenePrimitivesOptions,
  ): Promise<MountedScenePrimitiveApplyResult>;
  /**
   * Release every resource this mount owns. Idempotent: the second call is a
   * no-op. Cancels any in-flight application first, so a mount disposed mid-load
   * cannot be completed behind the caller's back.
   *
   * If a handle refuses to release, the failures are aggregated and thrown, the
   * mount stays in `disposing`, and a later `dispose()` retries only what is
   * still owned.
   */
  dispose(): void;
}

interface MountEntry {
  readonly key: string;
  readonly id: string;
  readonly kind: SceneRuntimePrimitiveKind;
  readonly fingerprint: string | undefined;
  readonly handle: CesiumLayerHandle | undefined;
}

/**
 * Mount a scene plan against a live Cesium target and return the handle that
 * owns it.
 *
 * The initial plan is applied before the promise resolves, so a resolved mount
 * is a mounted scene. A rejection means nothing was left attached: the adapter's
 * transactional rollback has already run.
 *
 * @param target Live Cesium `Viewer`/`Scene` surface (a `camera`, optionally a `scene`).
 * @param primitives The accepted scene plan.
 */
export async function mountScenePrimitivesToCesium(
  target: CesiumSceneRuntimeTarget,
  primitives: readonly SceneRuntimePrimitive[],
  options: MountScenePrimitivesToCesiumOptions = {},
): Promise<MountedCesiumScenePrimitives> {
  const layerLimit = resolveLayerLimit(options.maxLayers);
  const lifecycle = new AbortController();
  let entries = new Map<string, MountEntry>();
  let orphans: CesiumLayerHandle[] = [];
  let diagnostics: readonly ScenePrimitiveDiagnostic[] = [];
  let status: ScenePrimitiveApplyResult["status"] = "supported";
  let state: CesiumSceneMountState = "ready";
  let revision = 0;
  let applyTail: Promise<void> = Promise.resolve();
  let disposeActive = false;

  const runApply = async (
    plan: readonly SceneRuntimePrimitive[],
    applyOptions: ApplyMountedScenePrimitivesOptions,
  ): Promise<MountedScenePrimitiveApplyResult> => {
    if (state === "disposing" || state === "disposed") {
      throw new HonuaCesiumSceneMountError("disposed", "Cannot apply a plan through a disposed Cesium scene mount.");
    }
    assertWithinLayerLimit(plan, layerLimit);
    const signal = combineSignals([lifecycle.signal, applyOptions.signal]);
    signal.throwIfAborted();

    // Identity + configuration diff against what is already mounted. A primitive
    // with no fingerprint is treated as changed, never as unchanged.
    const reuse = new Map<string, CesiumLayerHandle | undefined>();
    const planEntries: MountEntry[] = [];
    for (const primitive of plan) {
      const key = scenePrimitiveMountKey(primitive);
      const fingerprint = scenePrimitiveFingerprint(primitive);
      const previous = entries.get(key);
      const unchanged = previous !== undefined && fingerprint !== undefined && previous.fingerprint === fingerprint;
      if (unchanged) reuse.set(key, previous.handle);
      planEntries.push({ key, id: primitive.id, kind: primitive.kind, fingerprint, handle: undefined });
    }

    state = "applying";
    let application: Awaited<ReturnType<typeof applyCesiumScenePrimitivesInternal>>;
    try {
      application = await applyCesiumScenePrimitivesInternal(target, plan, { signal, reuse });
    } finally {
      if (state === "applying") state = "ready";
    }
    if (lifecycle.signal.aborted) {
      // Disposal won the race with a materialization that had no checkpoint left
      // to hit. Release what this application built rather than committing it
      // into a mount the host has already torn down.
      releaseHandles(collectCreatedHandles(application.mounted, reuse));
      throw lifecycle.signal.reason;
    }

    // Only now that the revision has landed is it safe to release what it
    // displaced. Disposing earlier would make a mid-application failure
    // unrecoverable.
    const nextEntries = new Map<string, MountEntry>();
    for (const entry of planEntries) {
      nextEntries.set(entry.key, { ...entry, handle: application.mounted.get(entry.key) });
    }
    const disposed: string[] = [];
    const disposalFailures: unknown[] = [];
    for (const entry of [...entries.values()].reverse()) {
      if (reuse.has(entry.key) || !entry.handle) continue;
      try {
        entry.handle.remove();
        disposed.push(entry.id);
      } catch (error) {
        disposalFailures.push(error);
        // Still owned, so still this mount's problem: `dispose()` retries it.
        orphans.push(entry.handle);
      }
    }
    entries = nextEntries;
    revision += 1;

    const lifecycleDiagnostics = [
      appliedDiagnostic(revision, application.created, application.reused, disposed, layerLimit, entries.size),
      ...(disposalFailures.length > 0 ? [disposalIncompleteDiagnostic(disposalFailures)] : []),
    ];
    diagnostics = Object.freeze([...application.diagnostics, ...lifecycleDiagnostics]);
    status = summarizeDiagnosticStatus(diagnostics);
    return {
      status,
      diagnostics,
      layers: application.layers,
      revision,
      created: Object.freeze([...application.created]),
      reused: Object.freeze([...application.reused]),
      disposed: Object.freeze(disposed),
    };
  };

  const enqueueApply = (
    plan: readonly SceneRuntimePrimitive[],
    applyOptions: ApplyMountedScenePrimitivesOptions,
  ): Promise<MountedScenePrimitiveApplyResult> => {
    const value = applyTail.then(() => runApply(plan, applyOptions));
    applyTail = value.then(
      () => undefined,
      () => undefined,
    );
    return value;
  };

  await runApply(primitives, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.state ? { state: options.state } : {}),
  });

  return {
    renderer: "cesium",
    get state() {
      return state;
    },
    get status() {
      return status;
    },
    get diagnostics() {
      return diagnostics;
    },
    get layers() {
      const live = new Map<string, CesiumLayerHandle>();
      for (const entry of entries.values()) if (entry.handle) live.set(entry.id, entry.handle);
      return live;
    },
    layerLimit,
    get revision() {
      return revision;
    },
    apply(plan, applyOptions = {}) {
      return enqueueApply(plan, applyOptions);
    },
    dispose() {
      if (state === "disposed" || disposeActive) return;
      disposeActive = true;
      if (!lifecycle.signal.aborted) {
        lifecycle.abort(new DOMException("Cesium scene mount disposed", "AbortError"));
      }
      state = "disposing";
      try {
        // Reverse construction order, orphaned handles from an earlier failure
        // first, so a retry drains the backlog before the current plan.
        const owned = [...entries.values()]
          .reverse()
          .map((entry) => entry.handle)
          .filter((handle): handle is CesiumLayerHandle => handle !== undefined);
        const pending = [...orphans, ...owned];
        orphans = [];
        entries = new Map();
        const failures = releaseHandles(pending);
        orphans = failures.retained;
        if (failures.errors.length > 0) {
          throw new AggregateError(failures.errors, "Cesium scene mount disposal is incomplete and may be retried.");
        }
        state = "disposed";
      } finally {
        disposeActive = false;
      }
    },
  };
}

function collectCreatedHandles(
  mountedHandles: ReadonlyMap<string, CesiumLayerHandle | undefined>,
  reuse: ReadonlyMap<string, CesiumLayerHandle | undefined>,
): CesiumLayerHandle[] {
  const handles: CesiumLayerHandle[] = [];
  for (const [key, handle] of mountedHandles) {
    if (handle && !reuse.has(key)) handles.push(handle);
  }
  return handles.reverse();
}

function releaseHandles(handles: readonly CesiumLayerHandle[]): {
  readonly errors: unknown[];
  readonly retained: CesiumLayerHandle[];
} {
  const errors: unknown[] = [];
  const retained: CesiumLayerHandle[] = [];
  for (const handle of handles) {
    try {
      handle.remove();
    } catch (error) {
      errors.push(error);
      retained.push(handle);
    }
  }
  return { errors, retained };
}

/**
 * Reject an over-budget plan before the Cesium peer loads.
 *
 * The count is of primitives that would each materialize one adapter-owned layer
 * handle. Camera, ground, extrusion, and scene-layer-metadata primitives own no
 * renderer resource on this adapter and are not counted; an unsupported binding
 * is counted, because refusing a plan must not depend on which of its bindings
 * happen to be renderable today.
 */
function assertWithinLayerLimit(primitives: readonly SceneRuntimePrimitive[], layerLimit: number): void {
  const layerCount = primitives.filter(
    (primitive) =>
      primitive.kind === "elevation-source" || primitive.kind === "imagery-layer" || primitive.kind === "model-layer",
  ).length;
  if (layerCount > layerLimit) {
    throw new HonuaCesiumSceneMountError(
      "layer-limit-exceeded",
      `Scene plan declares ${layerCount} renderer layers, exceeding the mount ceiling ${layerLimit}.`,
      { layerCount, layerLimit },
    );
  }
}

function resolveLayerLimit(maxLayers: number | undefined): number {
  if (maxLayers === undefined) return DEFAULT_SCENE_MOUNT_LAYER_LIMIT;
  if (!Number.isSafeInteger(maxLayers) || maxLayers <= 0) {
    throw new HonuaCesiumSceneMountError("invalid-option", "maxLayers must be a positive integer.", { maxLayers });
  }
  return maxLayers;
}

function appliedDiagnostic(
  revision: number,
  created: readonly string[],
  reused: readonly string[],
  disposed: readonly string[],
  layerLimit: number,
  mountedPrimitiveCount: number,
): ScenePrimitiveDiagnostic {
  return {
    code: "scene-mount-applied",
    severity: "info",
    status: "supported",
    renderer: CESIUM_SCENE_CAPABILITIES.renderer,
    message: `Applied scene plan revision ${revision}: created ${created.length}, reused ${reused.length}, disposed ${disposed.length}.`,
    context: {
      revision,
      created: [...created],
      reused: [...reused],
      disposed: [...disposed],
      layerLimit,
      mountedPrimitiveCount,
    },
  };
}

function disposalIncompleteDiagnostic(failures: readonly unknown[]): ScenePrimitiveDiagnostic {
  return {
    code: "scene-mount-disposal-incomplete",
    severity: "error",
    status: "degraded",
    renderer: CESIUM_SCENE_CAPABILITIES.renderer,
    message: `${failures.length} displaced layer handle(s) refused to release; the revised plan is mounted and the handles remain owned.`,
    fallback: "Call dispose() to retry releasing the retained handles.",
    context: {
      retainedHandleCount: failures.length,
      failures: failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))),
    },
  };
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return available.length === 1 ? (available[0] as AbortSignal) : AbortSignal.any(available);
}
