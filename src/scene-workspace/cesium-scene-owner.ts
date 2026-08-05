/**
 * One owner for both halves of a Cesium scene.
 *
 * A Cesium application that draws a published scene *and* an accepted-plan
 * feature query had two lifecycle owners and nothing above them:
 * {@link mountScenePrimitivesToCesium} owns terrain, imagery, tilesets, and
 * models on `viewer.scene`, and {@link mountSourceToCesium} owns entities on
 * `viewer.entities`. Composing them worked — that is proven against a real
 * `Viewer` — but the application had to hold two handles, dispose them in the
 * right order, and get that right on every error path. This module is the
 * missing owner (epic #395 REQ-003, issue #1050).
 *
 * {@link mountCesiumScene} is deliberately a **delegating** owner rather than a
 * new adapter:
 *
 * - It does not reimplement either mount. The primitive mount keeps its own
 *   diff, layer ceiling, transactional apply, and rebuild boundaries; each
 *   entity mount keeps its own refresh diff, entity ceiling, and rollback. The
 *   owner adds ordering, admission, and a single `dispose()`.
 * - It does not change the beta mount's shape. `mountScenePrimitivesToCesium`
 *   and its handle are untouched and remain the supported way to own primitives
 *   alone; `mountCesiumScene` is additive, and a host that already holds a
 *   primitive mount keeps working exactly as before.
 * - One target. A live `Viewer` structurally satisfies
 *   {@link CesiumSceneOwnerTarget} — `camera`, `scene`, `clock`, `entities` —
 *   so the owner is handed the viewer, not a pair of collections the caller has
 *   to keep consistent.
 *
 * Disposal releases entity mounts first, in reverse acquisition order, and the
 * primitive mount last. That is the order the browser lane measures: entity
 * visualizers attach their own primitives to `scene.primitives`, and releasing
 * an elevation-source handle resets the globe's terrain provider, so tearing the
 * scene down underneath live entities is the arrangement worth avoiding. A
 * refusing mount leaves the owner in `disposing`, still owning exactly what did
 * not release, so `dispose()` can be called again.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier with the accepted-plan entity slice it composes: the entity half has no
 *   symbology surface yet, and adding one changes shapes this owner forwards.
 *   See `docs/cesium-entity-adapter.md`.
 * @module
 */

import type { Source } from "../contract/types.js";
import type { QueryExecutionPlanV1 } from "../query-planner/types.js";
import type { CesiumSceneRuntimeTarget } from "./cesium-adapter.js";
import {
  type ApplyMountedScenePrimitivesOptions,
  type MountScenePrimitivesToCesiumOptions,
  type MountedCesiumScenePrimitives,
  type MountedScenePrimitiveApplyResult,
  mountScenePrimitivesToCesium,
} from "./cesium-mount.js";
import type { SceneRuntimePrimitive } from "./primitives.js";
import {
  type CesiumEntityCollectionTarget,
  type MountSourceToCesiumOptions,
  type MountedCesiumEntitySource,
  mountSourceToCesium,
} from "./source-to-cesium.js";

/**
 * Default ceiling on the number of live entity mounts one owner may hold.
 *
 * Each mount materializes up to `DEFAULT_CESIUM_ENTITY_LIMIT` entities, so an
 * unbounded set of mounts is an unbounded scene. Eight is generous for an
 * operational view — a handful of feature layers over a published scene — and
 * small enough that a runaway generated application fails closed. Raise it
 * deliberately with {@link MountCesiumSceneOptions.maxSources}.
 */
export const DEFAULT_CESIUM_SCENE_SOURCE_LIMIT = 8;

/** Failure codes raised by the scene owner's own contract. */
export type CesiumSceneOwnerErrorCode =
  | "disposed"
  | "entities-unavailable"
  | "invalid-option"
  | "source-conflict"
  | "source-limit-exceeded";

/**
 * A lifecycle refusal from {@link mountCesiumScene} or the handle it returns.
 * Failures raised by the mounts it delegates to keep their own error types —
 * `HonuaCesiumSceneMountError` and `HonuaCesiumEntityAdapterError` — so a caller
 * can still tell a layer-ceiling refusal from an entity-ceiling refusal.
 */
export class HonuaCesiumSceneOwnerError extends Error {
  public constructor(
    public readonly code: CesiumSceneOwnerErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaCesiumSceneOwnerError";
  }
}

/**
 * The live Cesium surface both halves of the scene attach to. A `Viewer`
 * satisfies it structurally; `entities` is optional so a scene that never mounts
 * a source can hand over the same target the primitive adapter already accepts.
 */
export interface CesiumSceneOwnerTarget extends CesiumSceneRuntimeTarget {
  /** Live `viewer.entities`. Required before {@link MountedCesiumScene.mountSource} can run. */
  readonly entities?: CesiumEntityCollectionTarget;
}

/**
 * Lifecycle state of a scene owner.
 *
 * `disposing` is durable when a mount refused to release: the owner permanently
 * refuses new work while remaining retryable, exactly like the primitive mount.
 */
export type CesiumSceneOwnerState = "ready" | "disposing" | "disposed";

/** Options for {@link mountCesiumScene}. */
export interface MountCesiumSceneOptions extends MountScenePrimitivesToCesiumOptions {
  /**
   * Ceiling on the live entity mounts this owner may hold. Defaults to
   * {@link DEFAULT_CESIUM_SCENE_SOURCE_LIMIT}. Must be a positive integer.
   */
  readonly maxSources?: number;
}

/**
 * One owner of a whole Cesium scene: the primitive plan and every accepted-plan
 * source mounted over it.
 *
 * Callers hold the owner, not the mounts. The mounts are still reachable —
 * {@link primitives} and {@link sources} expose them so their diagnostics,
 * revisions, and rebuild boundaries stay readable — but ownership is the owner's,
 * and {@link dispose} is the only teardown a host has to sequence.
 */
export interface MountedCesiumScene {
  readonly renderer: "cesium";
  /** Lifecycle state. See {@link CesiumSceneOwnerState}. */
  readonly state: CesiumSceneOwnerState;
  /** The primitive mount this owner created. Its own lifecycle is owned here. */
  readonly primitives: MountedCesiumScenePrimitives;
  /** Live entity mounts keyed by their `sourceId`, in acquisition order. */
  readonly sources: ReadonlyMap<string, MountedCesiumEntitySource>;
  /** The entity-mount ceiling this owner was created with. */
  readonly sourceLimit: number;
  /**
   * Apply a revised primitive plan. Delegates to the primitive mount's diff, so
   * unchanged primitives are reused and the owner's entity mounts are untouched.
   */
  applyPrimitives(
    primitives: readonly SceneRuntimePrimitive[],
    options?: ApplyMountedScenePrimitivesOptions,
  ): Promise<MountedScenePrimitiveApplyResult>;
  /**
   * Mount an accepted plan against a source and take ownership of the result.
   *
   * The mount runs under the owner's lifecycle: disposing the owner mid-mount
   * aborts it and leaves nothing attached. A source whose `sourceId` is already
   * mounted is refused with `source-conflict` and the redundant mount is
   * released, so the owner can never hold two mounts fighting over one set of
   * entity ids.
   */
  mountSource<T>(
    source: Source<T>,
    plan: QueryExecutionPlanV1,
    options?: MountSourceToCesiumOptions,
  ): Promise<MountedCesiumEntitySource>;
  /**
   * Release one entity mount by `sourceId`, leaving the rest of the scene alone.
   * Returns `false` when the owner does not hold that source. A mount that
   * refuses to release stays owned so a later {@link dispose} retries it.
   */
  releaseSource(sourceId: string): boolean;
  /**
   * Release every mount this owner holds — entity mounts first, in reverse
   * acquisition order, then the primitive mount. Idempotent.
   *
   * A mount that refuses to release does not stop the teardown: everything that
   * can be released is, the failures are aggregated and thrown, the owner stays
   * in `disposing` still owning exactly what refused, and a later `dispose()`
   * retries only that. One stuck entity therefore never pins the scene's GPU
   * resources indefinitely.
   */
  dispose(): void;
}

/**
 * Mount a whole Cesium scene — primitives now, sources later — behind one owner.
 *
 * The initial primitive plan is applied before the promise resolves, so a
 * resolved owner is a mounted scene. A rejection means nothing was left
 * attached: the primitive mount's transactional rollback has already run and no
 * source has been mounted yet. Pass an empty plan to own entity mounts alone.
 *
 * @param target Live Cesium `Viewer`/`Scene` surface, optionally carrying `entities`.
 * @param primitives The accepted scene plan.
 */
export async function mountCesiumScene(
  target: CesiumSceneOwnerTarget,
  primitives: readonly SceneRuntimePrimitive[],
  options: MountCesiumSceneOptions = {},
): Promise<MountedCesiumScene> {
  const sourceLimit = resolveSourceLimit(options.maxSources);
  const lifecycle = new AbortController();
  const sources = new Map<string, MountedCesiumEntitySource>();
  let state: CesiumSceneOwnerState = "ready";
  let disposeActive = false;

  const primitiveMount = await mountScenePrimitivesToCesium(target, primitives, {
    ...(options.signal ? { signal: combineSignals([lifecycle.signal, options.signal]) } : { signal: lifecycle.signal }),
    ...(options.maxLayers === undefined ? {} : { maxLayers: options.maxLayers }),
    ...(options.state ? { state: options.state } : {}),
  });

  const assertReady = (): void => {
    if (state !== "ready") {
      throw new HonuaCesiumSceneOwnerError("disposed", "Cannot use a disposed Cesium scene owner.", { state });
    }
  };

  return {
    renderer: "cesium",
    get state() {
      return state;
    },
    get primitives() {
      return primitiveMount;
    },
    get sources() {
      return new Map(sources);
    },
    sourceLimit,
    applyPrimitives(plan, applyOptions = {}) {
      try {
        assertReady();
      } catch (error) {
        return Promise.reject(error);
      }
      return primitiveMount.apply(plan, {
        ...applyOptions,
        signal: combineSignals([lifecycle.signal, applyOptions.signal]),
      });
    },
    async mountSource(source, plan, sourceOptions = {}) {
      assertReady();
      const entities = target.entities;
      if (!entities) {
        throw new HonuaCesiumSceneOwnerError(
          "entities-unavailable",
          "The Cesium scene target carries no entity collection; pass `viewer.entities` to mount a source.",
        );
      }
      if (sources.size >= sourceLimit) {
        throw new HonuaCesiumSceneOwnerError(
          "source-limit-exceeded",
          `The Cesium scene owner already holds ${sources.size} source mounts, its ceiling.`,
          { sourceCount: sources.size, sourceLimit },
        );
      }
      const signal = combineSignals([lifecycle.signal, sourceOptions.signal]);
      signal.throwIfAborted();
      const mounted = await mountSourceToCesium(entities, source, plan, { ...sourceOptions, signal });
      // Disposal may have won the race with a mount that had no checkpoint left
      // to hit. Release what it built rather than committing it into an owner the
      // host has already torn down.
      if (state !== "ready") {
        mounted.dispose();
        throw lifecycle.signal.reason;
      }
      if (sources.has(mounted.sourceId)) {
        mounted.dispose();
        throw new HonuaCesiumSceneOwnerError(
          "source-conflict",
          `The Cesium scene owner already holds a mount for source "${mounted.sourceId}".`,
          { sourceId: mounted.sourceId },
        );
      }
      sources.set(mounted.sourceId, mounted);
      return mounted;
    },
    releaseSource(sourceId) {
      const mounted = sources.get(sourceId);
      if (!mounted) return false;
      // Delete only once the mount says it released: a refusing mount stays owned
      // so `dispose()` retries exactly what is still attached.
      mounted.dispose();
      sources.delete(sourceId);
      return true;
    },
    dispose() {
      if (state === "disposed" || disposeActive) return;
      disposeActive = true;
      if (!lifecycle.signal.aborted) {
        lifecycle.abort(new DOMException("Cesium scene owner disposed", "AbortError"));
      }
      state = "disposing";
      try {
        const failures: unknown[] = [];
        for (const [sourceId, mounted] of [...sources.entries()].reverse()) {
          try {
            mounted.dispose();
            sources.delete(sourceId);
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          primitiveMount.dispose();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Cesium scene owner disposal is incomplete and may be retried.");
        }
        state = "disposed";
      } finally {
        disposeActive = false;
      }
    },
  };
}

function resolveSourceLimit(maxSources: number | undefined): number {
  if (maxSources === undefined) return DEFAULT_CESIUM_SCENE_SOURCE_LIMIT;
  if (!Number.isSafeInteger(maxSources) || maxSources <= 0) {
    throw new HonuaCesiumSceneOwnerError("invalid-option", "maxSources must be a positive integer.", { maxSources });
  }
  return maxSources;
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return available.length === 1 ? (available[0] as AbortSignal) : AbortSignal.any(available);
}
