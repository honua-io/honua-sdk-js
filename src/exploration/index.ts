/**
 * Exploration context — protocol-neutral state shared across linked views.
 * Re-exported from `@honua/sdk-js/exploration`. See
 * `docs/exploration-context.md`.
 *
 * @module
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
