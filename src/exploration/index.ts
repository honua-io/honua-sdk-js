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
  Unsubscribe,
  ViewBinding,
  ViewHandle,
  ViewRole,
} from "./types.js";

export { LINKED_VIEW_PRESETS, propagationFor } from "./presets.js";
export { reduce, type ReducerResult } from "./reducer.js";
export { createExplorationContext } from "./context.js";
