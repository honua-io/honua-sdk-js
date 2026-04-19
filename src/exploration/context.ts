/**
 * `ExplorationContext` runtime — a thin coalescing event bus over the
 * pure reducer in `./reducer.ts`.
 *
 * State is updated synchronously on `dispatch`. Listener callbacks run on
 * a microtask so a burst of intents within the same tick coalesces into a
 * single `ChangeEvent` per slice (the merged set of changed slices, the
 * latest state, and the previous state at the start of the tick).
 *
 * The implementation deliberately avoids `Promise.resolve().then` in tests
 * by using `queueMicrotask`, which integrates with vitest's fake-timer /
 * `await Promise.resolve()` flushing.
 *
 * @module
 */

import { HonuaExplorationContextError } from "../core/errors.js";
import { LINKED_VIEW_PRESETS, propagationFor } from "./presets.js";
import { reduce } from "./reducer.js";
import {
  EMPTY_STATE,
  type ChangeEvent,
  type CreateExplorationContextOptions,
  type ExplorationContext,
  type ExplorationIntent,
  type ExplorationSlice,
  type ExplorationState,
  type ExplorationStateSnapshot,
  type Listener,
  type LinkedViewPolicy,
  type Unsubscribe,
  type ViewBinding,
  type ViewHandle,
} from "./types.js";

/**
 * Construct an `ExplorationContext` over a dataset.
 *
 * The returned object is the canonical place to read and mutate
 * exploration state. Bind views with `bind()` and listen to slice changes
 * via `subscribe()`.
 */
export function createExplorationContext(options: CreateExplorationContextOptions): ExplorationContext {
  const { datasetId, sourceIds } = options;
  const sourceIdsCopy = [...sourceIds];

  let policy: LinkedViewPolicy = LINKED_VIEW_PRESETS[options.preset ?? "globalLinked"];
  let state: ExplorationState = mergeInitial(options.initialState, options.preset);
  let disposed = false;

  const bindings = new Map<string, ViewBinding>();
  const sliceListeners = new Map<ExplorationSlice, Set<Listener>>();

  // Coalescing state — a microtask is scheduled at most once per tick.
  // `pendingRawChangedSlices` is the full set of slices the reducer changed
  // (used to wake `"all"` subscribers per the public slice contract);
  // `pendingChangedSlices` is the policy-filtered subset used to wake
  // slice-specific subscribers.
  let pendingFlush = false;
  let pendingPrev: ExplorationState = state;
  const pendingRawChangedSlices = new Set<ExplorationSlice>();
  const pendingChangedSlices = new Set<ExplorationSlice>();
  let pendingOrigin: ExplorationIntent | undefined;

  function ensureLive(op: string): void {
    if (disposed) {
      throw new HonuaExplorationContextError(
        "disposed",
        `ExplorationContext("${datasetId}") cannot ${op} after dispose()`,
      );
    }
  }

  function scheduleFlush(): void {
    if (pendingFlush) return;
    pendingFlush = true;
    queueMicrotask(() => {
      pendingFlush = false;
      if (pendingRawChangedSlices.size === 0) return;
      // `"all"` subscribers see every change the reducer produced, including
      // those the linked-view policy kept local to the originating view.
      // Slice-specific subscribers only fire for the filtered subset.
      const allEvent: ChangeEvent = {
        state,
        previous: pendingPrev,
        changedSlices: new Set(pendingRawChangedSlices),
        origin: pendingOrigin,
      };
      const filteredChanges = new Set(pendingChangedSlices);
      pendingRawChangedSlices.clear();
      pendingChangedSlices.clear();
      pendingPrev = state;
      pendingOrigin = undefined;

      const allListeners = sliceListeners.get("all");
      if (allListeners) {
        for (const fn of [...allListeners]) fn(allEvent);
      }
      for (const slice of filteredChanges) {
        const listeners = sliceListeners.get(slice);
        if (!listeners) continue;
        const sliceEvent: ChangeEvent = {
          state: allEvent.state,
          previous: allEvent.previous,
          changedSlices: filteredChanges,
          origin: allEvent.origin,
        };
        for (const fn of [...listeners]) fn(sliceEvent);
      }
    });
  }

  return {
    datasetId,
    sourceIds: sourceIdsCopy,
    get state(): ExplorationState {
      return state;
    },
    get policy(): LinkedViewPolicy {
      return policy;
    },

    bind(view: ViewBinding): ViewHandle {
      ensureLive("bind");
      if (bindings.has(view.id)) {
        throw new HonuaExplorationContextError(
          "duplicate-binding",
          `ExplorationContext("${datasetId}"): a view is already bound with id "${view.id}"`,
        );
      }
      bindings.set(view.id, view);
      let unbound = false;
      return {
        id: view.id,
        unbind(): void {
          if (unbound) return;
          unbound = true;
          bindings.delete(view.id);
        },
      };
    },

    dispatch(intent: ExplorationIntent): void {
      ensureLive("dispatch");
      const result = reduce(state, intent);
      if (result.changedSlices.size === 0) return;

      const filtered = filterByPolicy(result.changedSlices, intent, policy, bindings);
      // Always update central state — propagation only filters which slice
      // listeners are woken, not whether the state itself moves. Record the
      // raw changed slices so `"all"` subscribers always see the change per
      // the public slice contract, even when the filtered set is empty.
      const movedToFreshTick = pendingRawChangedSlices.size === 0;
      if (movedToFreshTick) pendingPrev = state;
      state = result.state;
      for (const slice of result.changedSlices) pendingRawChangedSlices.add(slice);
      for (const slice of filtered) pendingChangedSlices.add(slice);
      pendingOrigin = intent;

      // Sync preset rotation if the intent was apply-preset.
      if (intent.kind === "apply-preset") {
        policy = LINKED_VIEW_PRESETS[intent.preset];
      } else if (intent.kind === "snapshot-restore") {
        policy = LINKED_VIEW_PRESETS[state.preset];
      }

      if (pendingRawChangedSlices.size > 0) scheduleFlush();
    },

    subscribe(slice: ExplorationSlice, fn: Listener): Unsubscribe {
      ensureLive("subscribe");
      let listeners = sliceListeners.get(slice);
      if (!listeners) {
        listeners = new Set();
        sliceListeners.set(slice, listeners);
      }
      listeners.add(fn);
      return () => {
        const set = sliceListeners.get(slice);
        if (!set) return;
        set.delete(fn);
        if (set.size === 0) sliceListeners.delete(slice);
      };
    },

    snapshot(): ExplorationStateSnapshot {
      return { version: 1, state };
    },

    restore(snapshot: ExplorationStateSnapshot): void {
      ensureLive("restore");
      if (snapshot.version !== 1) {
        throw new HonuaExplorationContextError(
          "incompatible-snapshot",
          `ExplorationContext("${datasetId}"): snapshot version ${String(snapshot.version)} is not supported`,
        );
      }
      this.dispatch({ kind: "snapshot-restore", snapshot });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      bindings.clear();
      sliceListeners.clear();
      pendingRawChangedSlices.clear();
      pendingChangedSlices.clear();
      pendingFlush = false;
    },
  };
}

function mergeInitial(
  initial: Partial<ExplorationState> | undefined,
  preset: ExplorationState["preset"] | undefined,
): ExplorationState {
  if (!initial && !preset) return EMPTY_STATE;
  return {
    ...EMPTY_STATE,
    ...(initial ?? {}),
    preset: preset ?? initial?.preset ?? EMPTY_STATE.preset,
  };
}

/**
 * Apply linked-view propagation. Every intent updates central state; the
 * returned set is the subset of changed slices that should wake listeners
 * given the originating view's role.
 *
 * Rules:
 *  - If `intent.viewId` is undefined, the intent is "external" — all
 *    changed slices propagate.
 *  - If the binding exists and the role's preset entry permits the slice,
 *    the slice propagates.
 *  - If the binding does not exist, treat as external.
 *  - `apply-preset` and `snapshot-restore` always propagate fully so that
 *    structural changes are visible everywhere.
 */
function filterByPolicy(
  changed: ReadonlySet<ExplorationSlice>,
  intent: ExplorationIntent,
  policy: LinkedViewPolicy,
  bindings: ReadonlyMap<string, ViewBinding>,
): ReadonlySet<ExplorationSlice> {
  if (intent.kind === "apply-preset" || intent.kind === "snapshot-restore") {
    return changed;
  }
  if (!intent.viewId) return changed;
  const binding = bindings.get(intent.viewId);
  if (!binding) return changed;
  const allowed = propagationFor(policy.preset, binding.role);
  if (allowed.size === 0) return new Set();
  const out = new Set<ExplorationSlice>();
  for (const slice of changed) {
    if (allowed.has(slice)) out.add(slice);
  }
  return out;
}
