/**
 * Realtime helpers for linked exploration views.
 *
 * @module
 */

import type { SourceId } from "../contract/types.js";
import { isSourceQualifiedSelectionTarget } from "../exploration/selection.js";
import type { ExplorationViewController, FeatureSelectionTarget } from "../exploration/types.js";
import { realtimeFeatureKey } from "./reducer.js";
import type { RealtimeFeatureState } from "./types.js";

export interface ReconcileRealtimeSelectionOptions {
  readonly sourceId?: SourceId;
  /** Remove selections when the record is absent from live state. @default true */
  readonly requireLiveRecord?: boolean;
}

export function filterRealtimeSelection<TFeature>(
  selection: ReadonlyArray<FeatureSelectionTarget>,
  state: RealtimeFeatureState<TFeature>,
  options: ReconcileRealtimeSelectionOptions = {},
): ReadonlyArray<FeatureSelectionTarget> {
  const { sourceId, requireLiveRecord = true } = options;
  return selection.filter((target) => {
    const key = selectionKey(target, sourceId);
    if (!key) return true;
    if (state.tombstones[key]) return false;
    return requireLiveRecord ? Boolean(state.records[key]) : true;
  });
}

export function reconcileRealtimeSelection<TFeature>(
  view: ExplorationViewController,
  state: RealtimeFeatureState<TFeature>,
  options: ReconcileRealtimeSelectionOptions = {},
): void {
  const next = filterRealtimeSelection(view.state.selection, state, options);
  if (next.length === view.state.selection.length) return;
  view.select(next, { replace: true });
}

function selectionKey(target: FeatureSelectionTarget, sourceId: SourceId | undefined): string | undefined {
  if (isSourceQualifiedSelectionTarget(target)) {
    return realtimeFeatureKey(target.sourceId, target.id);
  }
  if (!sourceId) return undefined;
  return realtimeFeatureKey(sourceId, target);
}
