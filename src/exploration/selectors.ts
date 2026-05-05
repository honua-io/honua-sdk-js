/**
 * Selector helpers for linked exploration views.
 *
 * The selectors are framework-neutral: UI adapters subscribe to narrow
 * exploration slices and render derived models instead of synchronizing peer
 * components directly.
 *
 * @module
 */

import type { AggregationSpec, PaginationSpec, SortSpec, SourceId } from "../contract/types.js";
import { type SpatialFilter, envelope } from "../core/spatial-filter.js";
import type { HonuaExtent } from "../core/types.js";
import type {
  ExplorationState,
  ExplorationViewChangeEvent,
  ExplorationViewController,
  ExplorationViewSubscribeOptions,
  ExplorationViewSubscription,
  FeatureSelectionTarget,
  FilterClause,
  Unsubscribe,
} from "./types.js";

export type LinkedViewSpatialMode = "none" | "state" | "extent" | "state-or-extent";

export interface LinkedViewQueryProjectionOptions {
  /** Restrict filters whose `appliesTo` list names another source. */
  readonly sourceId?: SourceId;
  /** How spatial state should be projected into query inputs. @default "state-or-extent" */
  readonly spatialMode?: LinkedViewSpatialMode;
}

/**
 * Serializable query-facing view of exploration state.
 *
 * Protocol adapters can translate `filters` into SQL, CQL2, OData, or
 * MapLibre expressions while reusing the same spatial, sorting, paging,
 * grouping, and selection state.
 */
export interface LinkedViewQueryProjection {
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly spatialFilter?: SpatialFilter;
  readonly extent?: HonuaExtent;
  readonly orderBy: ReadonlyArray<SortSpec>;
  readonly pagination: PaginationSpec;
  readonly outFields?: ReadonlyArray<string>;
  readonly grouping: ReadonlyArray<string>;
  readonly aggregation?: AggregationSpec;
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
}

export type ExplorationSelector<T> = (state: ExplorationState) => T;
export type ExplorationSelectorListener<T> = (value: T, event: ExplorationViewChangeEvent | undefined) => void;

export interface ExplorationSelectorSubscribeOptions<T> extends ExplorationViewSubscribeOptions {
  /** Emit the selector's current value before waiting for changes. @default false */
  readonly fireImmediately?: boolean;
  /** Equality check used to suppress unchanged selector output. @default deep value equality */
  readonly equals?: (a: T, b: T) => boolean;
}

/** Convert a viewport extent into the standard Honua envelope spatial filter. */
export function extentToSpatialFilter(extent: HonuaExtent): SpatialFilter {
  return envelope(extent.xmin, extent.ymin, extent.xmax, extent.ymax, extent.spatialReference);
}

/** Derive a query-facing projection from the current linked exploration state. */
export function selectLinkedViewQueryProjection(
  state: ExplorationState,
  options: LinkedViewQueryProjectionOptions = {},
): LinkedViewQueryProjection {
  const visibleFields = state.visibleFields.length > 0 ? [...state.visibleFields] : undefined;
  return {
    filters: filtersForSource(state.filters, options.sourceId),
    spatialFilter: spatialFilterForState(state, options.spatialMode ?? "state-or-extent"),
    extent: state.extent,
    orderBy: [...state.sort],
    pagination: { ...state.page },
    outFields: visibleFields,
    grouping: [...state.grouping],
    aggregation: state.aggregation,
    selection: [...state.selection],
  };
}

/**
 * Subscribe to a narrow state subscription and emit only when a derived
 * selector value changes.
 */
export function subscribeExplorationSelector<T>(
  view: ExplorationViewController,
  subscription: ExplorationViewSubscription,
  selector: ExplorationSelector<T>,
  listener: ExplorationSelectorListener<T>,
  options: ExplorationSelectorSubscribeOptions<T> = {},
): Unsubscribe {
  const equals = options.equals ?? valuesEqual;
  let current = selector(view.state);

  if (options.fireImmediately) {
    listener(current, undefined);
  }

  return view.subscribe(
    subscription,
    (event) => {
      const next = selector(event.state);
      if (equals(current, next)) return;
      current = next;
      listener(next, event);
    },
    options,
  );
}

function spatialFilterForState(state: ExplorationState, mode: LinkedViewSpatialMode): SpatialFilter | undefined {
  switch (mode) {
    case "none":
      return undefined;
    case "state":
      return state.spatialFilter;
    case "extent":
      return state.extent ? extentToSpatialFilter(state.extent) : undefined;
    case "state-or-extent":
      return state.spatialFilter ?? (state.extent ? extentToSpatialFilter(state.extent) : undefined);
  }
}

function filtersForSource(
  filters: Readonly<Record<string, FilterClause>>,
  sourceId: SourceId | undefined,
): Readonly<Record<string, FilterClause>> {
  if (!sourceId) return filters;
  const out: Record<string, FilterClause> = {};
  for (const [id, clause] of Object.entries(filters)) {
    if (!clause.appliesTo || clause.appliesTo.length === 0 || clause.appliesTo.includes(sourceId)) {
      out[id] = clause;
    }
  }
  return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  if (leftKeys.length === 0) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!valuesEqual(left[key], right[key])) return false;
  }
  return true;
}
