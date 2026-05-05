/**
 * Interaction bindings between map/table/detail surfaces and
 * `ExplorationViewController`.
 *
 * These helpers keep component adapters small: maps publish source-qualified
 * selection targets, tables publish the same targets, maps observe shared
 * selection to update feature-state, and detail panels subscribe to the
 * shared selection slice.
 *
 * @module
 */

import type { AggregationSpec, FeatureId } from "../contract/types.js";
import type { HonuaExtent } from "../core/types.js";
import {
  featureSelectionKey,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "../exploration/selection.js";
import {
  extentToSpatialFilter,
  selectLinkedViewQueryProjection,
  subscribeExplorationSelector,
} from "../exploration/selectors.js";
import type {
  ExplorationSelectorListener,
  ExplorationSelectorSubscribeOptions,
  LinkedViewQueryProjection,
  LinkedViewQueryProjectionOptions,
} from "../exploration/selectors.js";
import type {
  ExplorationViewChangeEvent,
  ExplorationViewController,
  ExplorationViewSubscribeOptions,
  ExplorationViewSubscription,
  FeatureSelectionTarget,
  FilterClause,
  SourceQualifiedFeatureSelectionTarget,
  Unsubscribe,
} from "../exploration/types.js";
import { createSelectionHandler } from "./feature-state.js";
import type {
  FeatureStateMap,
  FeatureTarget,
  InteractiveMap,
  SelectionHandle,
  SelectionHandlerOptions,
} from "./feature-state.js";

export interface MapSelectionExplorationBindingOptions extends SelectionHandlerOptions {
  /** Replace the exploration selection with the map selection. @default true */
  readonly replaceSelection?: boolean;
}

/**
 * Bind a MapLibre-style selection handler to an exploration view.
 *
 * The map handler already knows its source and source layer, so this publishes
 * source-qualified targets into the shared exploration selection slice.
 */
export function bindMapSelectionToExploration(
  map: InteractiveMap,
  view: ExplorationViewController,
  options: MapSelectionExplorationBindingOptions,
): SelectionHandle {
  const { replaceSelection = true, onSelectionTargetsChange } = options;
  return createSelectionHandler(map, {
    ...options,
    onSelectionTargetsChange(targets) {
      view.select(targets, { replace: replaceSelection });
      onSelectionTargetsChange?.(targets);
    },
  });
}

export interface FeatureStateSelectionSyncOptions {
  readonly source: string;
  readonly sourceLayer?: string;
  readonly stateKey?: string;
  /** Apply raw legacy ids to this source. @default true */
  readonly includeRawIds?: boolean;
  /** Apply current view state immediately. @default true */
  readonly applyInitial?: boolean;
  readonly subscribeOptions?: ExplorationViewSubscribeOptions;
}

export interface InteractionBindingHandle {
  remove(): void;
}

export interface LinkedViewQueryBindingOptions
  extends LinkedViewQueryProjectionOptions,
    ExplorationViewSubscribeOptions {
  /** Slices that should recompute the projection. */
  readonly subscription?: ExplorationViewSubscription;
  /** Emit the current projection before waiting for changes. @default true */
  readonly applyInitial?: boolean;
  /** Equality check used to suppress unchanged projections. @default deep value equality */
  readonly equals?: (a: LinkedViewQueryProjection, b: LinkedViewQueryProjection) => boolean;
}

export interface MapExtentExplorationSource {
  current?(): HonuaExtent | undefined;
  subscribe(listener: (extent: HonuaExtent | undefined) => void): Unsubscribe | InteractionBindingHandle;
}

export interface MapExtentExplorationBindingOptions {
  /** Publish the source's current extent on bind when available. @default true */
  readonly applyInitial?: boolean;
  /** Also mirror the extent into `spatialFilter`. @default false */
  readonly publishSpatialFilter?: boolean;
  /** Coalesce same-tick move events before dispatching. @default true */
  readonly coalesce?: boolean;
}

export interface FilterControlsExplorationBinding {
  setFilter(id: string, clause: FilterClause): void;
  clearFilter(id: string): void;
  subscribe(
    listener: ExplorationSelectorListener<Readonly<Record<string, FilterClause>>>,
    options?: ExplorationSelectorSubscribeOptions<Readonly<Record<string, FilterClause>>>,
  ): Unsubscribe;
}

export interface ChartBucketSelection {
  readonly targets?: ReadonlyArray<FeatureSelectionTarget>;
  readonly filters?: Readonly<Record<string, FilterClause>>;
}

export interface ChartBucketSelectionOptions {
  /** Replace the current selection when the bucket supplies targets. @default true */
  readonly replaceSelection?: boolean;
}

export interface ChartExplorationBinding {
  setGrouping(grouping: ReadonlyArray<string>): void;
  setAggregation(aggregation: AggregationSpec | undefined): void;
  selectTargets(targets: ReadonlyArray<FeatureSelectionTarget>, options?: { readonly replace?: boolean }): void;
  selectBucket(bucket: ChartBucketSelection, options?: ChartBucketSelectionOptions): void;
  subscribeQuery(
    listener: ExplorationSelectorListener<LinkedViewQueryProjection>,
    options?: LinkedViewQueryBindingOptions,
  ): Unsubscribe;
}

export interface MapLayerFilterTarget {
  setFilter(layerId: string, filter: unknown): void;
}

export interface MapLayerFilterExplorationBindingOptions extends LinkedViewQueryBindingOptions {
  readonly layerId: string;
  readonly translate: (projection: LinkedViewQueryProjection) => unknown;
}

/**
 * Reflect exploration selection into MapLibre feature-state.
 *
 * This is the table-to-map path: a table or detail panel can call
 * `view.select(...)`; the map observes the shared selection slice and toggles
 * feature-state for matching source-qualified targets.
 */
export function syncFeatureStateSelection(
  map: FeatureStateMap,
  view: ExplorationViewController,
  options: FeatureStateSelectionSyncOptions,
): InteractionBindingHandle {
  const { source, sourceLayer, stateKey = "selected", includeRawIds = true, applyInitial = true } = options;
  let active = new Map<string, FeatureTarget>();

  function apply(selection: ReadonlyArray<FeatureSelectionTarget>): void {
    const next = new Map<string, FeatureTarget>();
    for (const target of selection) {
      const featureTarget = toFeatureTarget(target, source, sourceLayer, includeRawIds);
      if (!featureTarget) continue;
      next.set(featureTargetKey(featureTarget), featureTarget);
    }

    for (const [key, target] of active) {
      if (!next.has(key)) map.setFeatureState(target, { [stateKey]: false });
    }
    for (const [key, target] of next) {
      if (!active.has(key)) map.setFeatureState(target, { [stateKey]: true });
    }
    active = next;
  }

  const unsubscribe = view.subscribe("selection", (event) => apply(event.state.selection), options.subscribeOptions);
  if (applyInitial) apply(view.state.selection);

  return {
    remove(): void {
      unsubscribe();
      for (const target of active.values()) {
        map.setFeatureState(target, { [stateKey]: false });
      }
      active.clear();
    },
  };
}

/** Publish viewport extent changes from a map adapter into an exploration view. */
export function bindMapExtentToExploration(
  view: ExplorationViewController,
  source: MapExtentExplorationSource,
  options: MapExtentExplorationBindingOptions = {},
): InteractionBindingHandle {
  const { applyInitial = true, publishSpatialFilter = false, coalesce = true } = options;
  let active = true;
  let pending = false;
  let latest: HonuaExtent | undefined;

  function publish(extent: HonuaExtent | undefined): void {
    if (!active) return;
    view.setExtent(extent);
    if (publishSpatialFilter) {
      view.setSpatialFilter(extent ? extentToSpatialFilter(extent) : undefined);
    }
  }

  function enqueue(extent: HonuaExtent | undefined): void {
    latest = extent;
    if (!coalesce) {
      publish(latest);
      return;
    }
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      publish(latest);
    });
  }

  const handle = source.subscribe(enqueue);
  if (applyInitial && source.current) enqueue(source.current());

  return {
    remove(): void {
      if (!active) return;
      active = false;
      removeSourceHandle(handle);
    },
  };
}

/** Subscribe a table, chart, or result adapter to the shared query projection. */
export function bindQueryProjectionToExploration(
  view: ExplorationViewController,
  listener: ExplorationSelectorListener<LinkedViewQueryProjection>,
  options: LinkedViewQueryBindingOptions = {},
): Unsubscribe {
  const {
    subscription = [
      "filters",
      "spatialFilter",
      "extent",
      "sort",
      "page",
      "visibleFields",
      "grouping",
      "aggregation",
      "selection",
    ],
    applyInitial = true,
    equals,
    includeSelf,
    sourceId,
    spatialMode,
  } = options;
  return subscribeExplorationSelector(
    view,
    subscription,
    (state) => selectLinkedViewQueryProjection(state, { sourceId, spatialMode }),
    listener,
    { fireImmediately: applyInitial, equals, includeSelf },
  );
}

/** Adapter for filter bars and query-builder controls. */
export function bindFilterControlsToExploration(view: ExplorationViewController): FilterControlsExplorationBinding {
  return {
    setFilter(id, clause): void {
      view.setFilter(id, clause);
    },
    clearFilter(id): void {
      view.clearFilter(id);
    },
    subscribe(listener, options): Unsubscribe {
      return subscribeExplorationSelector(view, "filters", (state) => state.filters, listener, options);
    },
  };
}

/** Adapter for chart/grouped-result controls that publish grouping, aggregation, filters, and selection. */
export function bindChartToExploration(view: ExplorationViewController): ChartExplorationBinding {
  return {
    setGrouping(grouping): void {
      view.setGrouping(grouping);
    },
    setAggregation(aggregation): void {
      view.setAggregation(aggregation);
    },
    selectTargets(targets, options): void {
      view.select(targets, options);
    },
    selectBucket(bucket, options): void {
      for (const [id, clause] of Object.entries(bucket.filters ?? {})) {
        view.setFilter(id, clause);
      }
      if (bucket.targets) {
        view.select(bucket.targets, { replace: options?.replaceSelection ?? true });
      }
    },
    subscribeQuery(listener, options): Unsubscribe {
      return bindQueryProjectionToExploration(view, listener, options);
    },
  };
}

/** Reflect linked filter/query state into a MapLibre-style layer filter. */
export function syncMapLayerFilterToExploration(
  map: MapLayerFilterTarget,
  view: ExplorationViewController,
  options: MapLayerFilterExplorationBindingOptions,
): InteractionBindingHandle {
  const unsubscribe = bindQueryProjectionToExploration(
    view,
    (projection) => map.setFilter(options.layerId, options.translate(projection)),
    {
      ...options,
      subscription: options.subscription ?? ["filters", "spatialFilter", "extent"],
    },
  );
  return {
    remove(): void {
      unsubscribe();
    },
  };
}

export type SelectionDetailListener = (
  selection: ReadonlyArray<FeatureSelectionTarget>,
  event: ExplorationViewChangeEvent,
) => void;

/** Subscribe a detail panel to the shared exploration selection. */
export function bindDetailToSelection(
  view: ExplorationViewController,
  listener: SelectionDetailListener,
  options?: ExplorationViewSubscribeOptions,
): Unsubscribe {
  return view.subscribe("selection", (event) => listener(event.state.selection, event), options);
}

export interface TableSelectionExplorationBinding {
  select(targets: ReadonlyArray<FeatureSelectionTarget>, options?: { readonly replace?: boolean }): void;
  clearSelection(): void;
  subscribe(listener: SelectionDetailListener, options?: ExplorationViewSubscribeOptions): Unsubscribe;
}

/** Small adapter for table/grid components that publish and observe selection. */
export function bindTableSelectionToExploration(view: ExplorationViewController): TableSelectionExplorationBinding {
  return {
    select(targets, options): void {
      view.select(targets, options);
    },
    clearSelection(): void {
      view.deselect();
    },
    subscribe(listener, options): Unsubscribe {
      return bindDetailToSelection(view, listener, options);
    },
  };
}

function toFeatureTarget(
  target: FeatureSelectionTarget,
  source: string,
  sourceLayer: string | undefined,
  includeRawIds: boolean,
): FeatureTarget | undefined {
  if (isSourceQualifiedSelectionTarget(target)) {
    if (target.sourceId !== source) return undefined;
    if ((target.sourceLayer ?? "") !== (sourceLayer ?? "")) return undefined;
    return { source, id: target.id, sourceLayer };
  }

  if (!includeRawIds) return undefined;
  return { source, id: target, sourceLayer };
}

function featureTargetKey(target: FeatureTarget): string {
  const selectionTarget: SourceQualifiedFeatureSelectionTarget = sourceFeatureSelectionTarget(
    target.source,
    target.id as FeatureId,
    { sourceLayer: target.sourceLayer },
  );
  return featureSelectionKey(selectionTarget);
}

function removeSourceHandle(handle: Unsubscribe | InteractionBindingHandle): void {
  if (typeof handle === "function") {
    handle();
    return;
  }
  handle.remove();
}
