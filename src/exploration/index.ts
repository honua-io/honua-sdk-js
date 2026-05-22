/**
 * `@honua/sdk-js/exploration` — protocol-neutral state container shared across
 * linked views (map / table / chart). Provides `createExplorationContext()`
 * with preset link policies (`globalLinked`, `mapDriven`, `gridDriven`,
 * `chartDriven`, `decoupled`). See `docs/exploration-context.md` for the
 * full design.
 *
 * @example
 * ```ts
 * import { createExplorationContext } from "@honua/sdk-js/exploration";
 *
 * const ctx = createExplorationContext({ dataset, preset: "globalLinked" });
 * ctx.dispatch({ type: "set-extent", extent });
 * const unsubscribe = ctx.subscribe(["selection"], (state) => render(state));
 * ```
 *
 * @packageDocumentation
 */

export {
  EMPTY_STATE,
  SLICES,
} from "./types.js";

export type {
  ApplyPresetIntent,
  ChangeEvent,
  ClearFilterIntent,
  CreateExplorationContextOptions,
  DeselectIntent,
  ExplorationContext,
  ExplorationIntent,
  ExplorationSlice,
  ExplorationState,
  ExplorationStateSnapshot,
  ExplorationViewChangeEvent,
  ExplorationViewController,
  ExplorationViewIntent,
  ExplorationViewListener,
  ExplorationViewSubscribeOptions,
  ExplorationViewSubscription,
  FeatureSelectionTarget,
  FilterClause,
  FilterOperator,
  LinkedViewPolicy,
  LinkedViewPresetName,
  LinkedViewRule,
  Listener,
  SelectIntent,
  SetAggregationIntent,
  SetExtentIntent,
  SetFilterIntent,
  SetGroupingIntent,
  SetPageIntent,
  SetSortIntent,
  SetSpatialFilterIntent,
  SetVisibleFieldsIntent,
  SnapshotRestoreIntent,
  SourceQualifiedFeatureSelectionTarget,
  Unsubscribe,
  ViewBinding,
  ViewHandle,
  ViewRole,
} from "./types.js";

export { LINKED_VIEW_PRESETS, propagationFor } from "./presets.js";
export { reduce, type ReducerResult } from "./reducer.js";
export { createExplorationContext } from "./context.js";
export { featureSelectionKey, isSourceQualifiedSelectionTarget, sourceFeatureSelectionTarget } from "./selection.js";
export {
  extentToSpatialFilter,
  selectLinkedViewQueryProjection,
  subscribeExplorationSelector,
} from "./selectors.js";
export type {
  ExplorationSelector,
  ExplorationSelectorListener,
  ExplorationSelectorSubscribeOptions,
  LinkedViewQueryProjection,
  LinkedViewQueryProjectionOptions,
  LinkedViewSpatialMode,
} from "./selectors.js";
