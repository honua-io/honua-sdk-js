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

import type { FeatureId } from "../contract/types.js";
import {
  featureSelectionKey,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "../exploration/selection.js";
import type {
  ExplorationViewChangeEvent,
  ExplorationViewController,
  ExplorationViewSubscribeOptions,
  FeatureSelectionTarget,
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
