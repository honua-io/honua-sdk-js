/**
 * MapLibre adapter for the renderer-neutral realtime reconciliation core
 * (`@honua/sdk-js/realtime`'s `reconciliation.ts`, issue #559 REQ-005).
 *
 * `createRealtimeReconciler` and the rest of `src/realtime/reconciliation.ts`
 * never import `maplibre-gl` and know nothing about feature state, sources,
 * or layers. This module is the *only* place a `RealtimeReconciliationResult`
 * is projected onto MapLibre:
 *
 * - `mode: "patch"` — each identity change becomes one `setFeatureState`
 *   (create/update) or `removeFeatureState` (delete) call against the
 *   caller's mounted source/layer, exactly mirroring
 *   `automatic-mount-integration.ts`'s existing `applyRealtimeFeatureState`
 *   duck-typed feature-state surface. No source `setData` and no layer
 *   teardown — the mounted geometry/attributes are untouched; only the
 *   `statusStateKey` paint-driven flag moves.
 * - `mode: "rebuild"` — the adapter never guesses how to re-materialize a
 *   source; it hands the whole result to the caller-supplied `rebuild`
 *   callback (typically a mounted source's `refresh()`/`setData()` path from
 *   `data-to-map-bridge.ts` or `automatic-source-strategy.ts`).
 *
 * deck.gl and Cesium adapters are out of scope for #559; this module is
 * MapLibre-only, matching `automatic-mount-integration.ts`'s scope.
 *
 * @module
 */

import type { FeatureId } from "../contract/types.js";
import {
  HonuaRealtimeReconciliationError,
  type RealtimeReconciliationChange,
  type RealtimeReconciliationResult,
} from "../realtime/reconciliation.js";

/**
 * Minimal MapLibre-shaped feature-state surface this adapter mutates. A real
 * `maplibregl.Map` satisfies this; both methods are optional so a host
 * without feature-state support degrades to a no-op `"patch"` path (the
 * `rebuild` callback still fires normally).
 */
export interface RealtimeReconciliationMapLibreMap {
  setFeatureState?(
    target: { source: string; id: FeatureId; sourceLayer?: string },
    state: Record<string, unknown>,
  ): void;
  removeFeatureState?(target: { source: string; id: FeatureId; sourceLayer?: string }, key?: string): void;
}

/** Options for {@link attachRealtimeReconciliationToMapLibre}. */
export interface RealtimeReconciliationMapLibreAdapterOptions {
  /** Mounted MapLibre source id `setFeatureState`/`removeFeatureState` target. */
  readonly sourceId: string;
  /** Vector `source-layer`, when the mounted source is a vector tile source. */
  readonly sourceLayer?: string;
  /** Feature-state key set to the change kind (`"create"`/`"update"`) on upserts. @default "realtimeStatus" */
  readonly statusStateKey?: string;
  /**
   * Invoked once per `mode: "rebuild"` result instead of per-feature
   * `setFeatureState` calls. Typically a mounted source's
   * `refresh()`/`setData()` path. Never called after {@link RealtimeReconciliationMapLibreAdapter.dispose}.
   */
  readonly rebuild: (result: RealtimeReconciliationResult<unknown>) => void | Promise<void>;
}

/** Cohesive MapLibre projection of one renderer-neutral reconciliation stream. */
export interface RealtimeReconciliationMapLibreAdapter {
  readonly sourceId: string;
  readonly disposed: boolean;
  /**
   * Apply one {@link RealtimeReconciliationResult}: `setFeatureState`/
   * `removeFeatureState` per change for `"patch"`, or the configured
   * `rebuild` callback for `"rebuild"`. Throws
   * {@link HonuaRealtimeReconciliationError} (`"disposed"`) once disposed —
   * a disposed adapter must never receive another patch.
   */
  apply(result: RealtimeReconciliationResult<unknown>): void | Promise<void>;
  /** Stop accepting reconciliation results. Idempotent. */
  dispose(): void;
}

/**
 * Attach a MapLibre projection to a renderer-neutral reconciliation stream.
 *
 * @example
 * ```ts
 * import { createRealtimeReconciler, diffRealtimeFeatureState } from "@honua/sdk-js/realtime";
 * import { attachRealtimeReconciliationToMapLibre } from "@honua/sdk-js/map";
 *
 * const reconciler = createRealtimeReconciler();
 * const adapter = attachRealtimeReconciliationToMapLibre(map, {
 *   sourceId: mounted.sourceId,
 *   rebuild: () => mounted.refresh(),
 * });
 * // On every accepted event, after reducing previous -> next state:
 * const result = reconciler.reconcile(previous, next, { kind: "event", event });
 * await adapter.apply(result);
 * ```
 *
 * @experimental
 */
export function attachRealtimeReconciliationToMapLibre(
  map: RealtimeReconciliationMapLibreMap,
  options: RealtimeReconciliationMapLibreAdapterOptions,
): RealtimeReconciliationMapLibreAdapter {
  const statusStateKey = options.statusStateKey ?? "realtimeStatus";
  const sourceId = options.sourceId;
  let disposed = false;

  const target = (id: FeatureId): { source: string; id: FeatureId; sourceLayer?: string } =>
    options.sourceLayer !== undefined
      ? { source: sourceId, id, sourceLayer: options.sourceLayer }
      : { source: sourceId, id };

  const applyChange = (change: RealtimeReconciliationChange<unknown>): void => {
    if (change.kind === "delete") {
      // Scope the removal to the one key this adapter owns: a keyless
      // removeFeatureState clears the feature's entire state, wiping
      // hover/selection/custom UI state other code set on the same source.
      map.removeFeatureState?.(target(change.id), statusStateKey);
      return;
    }
    map.setFeatureState?.(target(change.id), { [statusStateKey]: change.kind });
  };

  return {
    sourceId,
    get disposed() {
      return disposed;
    },
    apply(result) {
      if (disposed) {
        throw new HonuaRealtimeReconciliationError(
          "disposed",
          "Cannot apply a reconciliation result to a disposed MapLibre adapter.",
          { sourceId },
        );
      }
      if (result.mode === "rebuild") return options.rebuild(result);
      for (const change of result.changes) applyChange(change);
      return undefined;
    },
    dispose() {
      disposed = true;
    },
  };
}
