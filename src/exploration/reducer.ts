/**
 * Pure reducer for `ExplorationState`. Every transition returns a new
 * state object — readers may use referential equality to detect change on
 * any slice (e.g. `prev.filters !== next.filters`).
 *
 * The reducer does not own scheduling, propagation, or events; those live
 * in `./context.ts`.
 *
 * @module
 */

import type { AggregationSpec } from "../contract/types.js";
import type { SpatialFilter } from "../core/spatial-filter.js";
import { featureSelectionKey } from "./selection.js";
import type {
  ExplorationIntent,
  ExplorationSlice,
  ExplorationState,
  FeatureSelectionTarget,
  FilterClause,
} from "./types.js";

export interface ReducerResult {
  readonly state: ExplorationState;
  readonly changedSlices: ReadonlySet<ExplorationSlice>;
}

/**
 * Apply one intent. Returns the next state plus the set of slices that
 * actually changed (by reference). Callers compare the set rather than
 * re-deriving it so that "no-op" intents (e.g. setting the same sort)
 * do not wake listeners.
 */
export function reduce(state: ExplorationState, intent: ExplorationIntent): ReducerResult {
  switch (intent.kind) {
    case "set-filter": {
      const existing = state.filters[intent.id];
      if (existing && filtersEqual(existing, intent.clause)) {
        return { state, changedSlices: EMPTY };
      }
      const filters = { ...state.filters, [intent.id]: intent.clause };
      return { state: { ...state, filters }, changedSlices: only("filters") };
    }
    case "clear-filter": {
      if (!(intent.id in state.filters)) return { state, changedSlices: EMPTY };
      const filters = { ...state.filters };
      delete filters[intent.id];
      return { state: { ...state, filters }, changedSlices: only("filters") };
    }
    case "set-spatial-filter": {
      if (spatialFiltersEqual(state.spatialFilter, intent.spatialFilter)) {
        return { state, changedSlices: EMPTY };
      }
      return {
        state: cloneWithOptional(state, "spatialFilter", intent.spatialFilter),
        changedSlices: only("spatialFilter"),
      };
    }
    case "set-extent": {
      if (extentsEqual(state.extent, intent.extent)) {
        return { state, changedSlices: EMPTY };
      }
      return {
        state: cloneWithOptional(state, "extent", intent.extent),
        changedSlices: only("extent"),
      };
    }
    case "select": {
      const incoming = intent.ids;
      let selection: ReadonlyArray<FeatureSelectionTarget>;
      if (intent.replace === true) {
        selection = dedupeSelection(incoming);
      } else {
        selection = dedupeSelection([...state.selection, ...incoming]);
      }
      if (selectionEqual(state.selection, selection)) {
        return { state, changedSlices: EMPTY };
      }
      return {
        state: { ...state, selection },
        changedSlices: only("selection"),
      };
    }
    case "deselect": {
      if (!intent.ids || intent.ids.length === 0) {
        if (state.selection.length === 0) return { state, changedSlices: EMPTY };
        return { state: { ...state, selection: [] }, changedSlices: only("selection") };
      }
      const removeSet = new Set(intent.ids.map((target) => featureSelectionKey(target)));
      const selection = state.selection.filter((target) => !removeSet.has(featureSelectionKey(target)));
      if (selection.length === state.selection.length) {
        return { state, changedSlices: EMPTY };
      }
      return { state: { ...state, selection }, changedSlices: only("selection") };
    }
    case "set-sort": {
      if (sortEqual(state.sort, intent.sort)) return { state, changedSlices: EMPTY };
      return { state: { ...state, sort: [...intent.sort] }, changedSlices: only("sort") };
    }
    case "set-page": {
      if (pageEqual(state.page, intent.page)) return { state, changedSlices: EMPTY };
      return { state: { ...state, page: { ...intent.page } }, changedSlices: only("page") };
    }
    case "set-visible-fields": {
      if (sequenceEqual(state.visibleFields, intent.fields)) {
        return { state, changedSlices: EMPTY };
      }
      return {
        state: { ...state, visibleFields: [...intent.fields] },
        changedSlices: only("visibleFields"),
      };
    }
    case "set-grouping": {
      if (sequenceEqual(state.grouping, intent.grouping)) {
        return { state, changedSlices: EMPTY };
      }
      return {
        state: { ...state, grouping: [...intent.grouping] },
        changedSlices: only("grouping"),
      };
    }
    case "set-aggregation": {
      if (aggregationEqual(state.aggregation, intent.aggregation)) {
        return { state, changedSlices: EMPTY };
      }
      return {
        state: cloneWithOptional(state, "aggregation", intent.aggregation),
        changedSlices: only("aggregation"),
      };
    }
    case "apply-preset": {
      if (state.preset === intent.preset) return { state, changedSlices: EMPTY };
      return { state: { ...state, preset: intent.preset }, changedSlices: only("preset") };
    }
    case "snapshot-restore": {
      const next = intent.snapshot.state;
      const changed = diffSlices(state, next);
      if (changed.size === 0) return { state, changedSlices: EMPTY };
      return { state: next, changedSlices: changed };
    }
  }
}

const EMPTY: ReadonlySet<ExplorationSlice> = new Set();

function only(slice: ExplorationSlice): ReadonlySet<ExplorationSlice> {
  return new Set([slice]);
}

function filterMapsEqual(
  a: Readonly<Record<string, FilterClause>>,
  b: Readonly<Record<string, FilterClause>>,
): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!filtersEqual(a[key], b[key])) return false;
  }
  return true;
}

function filtersEqual(a: FilterClause, b: FilterClause): boolean {
  if (a.field !== b.field || a.operator !== b.operator) return false;
  if (a.value !== b.value) {
    if (Array.isArray(a.value) && Array.isArray(b.value)) {
      if (a.value.length !== b.value.length) return false;
      for (let i = 0; i < a.value.length; i++) {
        if (a.value[i] !== b.value[i]) return false;
      }
    } else {
      return false;
    }
  }
  if ((a.appliesTo ?? null) !== (b.appliesTo ?? null)) {
    if (!a.appliesTo || !b.appliesTo) return false;
    if (!sequenceEqual(a.appliesTo, b.appliesTo)) return false;
  }
  return true;
}

function spatialFiltersEqual(a: SpatialFilter | undefined, b: SpatialFilter | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.geometryType !== b.geometryType) return false;
  if ((a.spatialRel ?? null) !== (b.spatialRel ?? null)) return false;
  return geometryEqual(a.geometry, b.geometry);
}

function geometryEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!geometryEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.hasOwn(b as Record<string, unknown>, key)) return false;
      if (!geometryEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function extentsEqual(a: ExplorationState["extent"], b: ExplorationState["extent"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.xmin === b.xmin && a.ymin === b.ymin && a.xmax === b.xmax && a.ymax === b.ymax;
}

function sortEqual(a: ExplorationState["sort"], b: ExplorationState["sort"]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].field !== b[i].field || (a[i].direction ?? "asc") !== (b[i].direction ?? "asc")) {
      return false;
    }
  }
  return true;
}

function pageEqual(a: ExplorationState["page"], b: ExplorationState["page"]): boolean {
  return a.offset === b.offset && a.limit === b.limit;
}

function sequenceEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function selectionEqual(a: ReadonlyArray<FeatureSelectionTarget>, b: ReadonlyArray<FeatureSelectionTarget>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (featureSelectionKey(a[i]) !== featureSelectionKey(b[i])) return false;
  }
  return true;
}

function dedupeSelection(values: ReadonlyArray<FeatureSelectionTarget>): FeatureSelectionTarget[] {
  const seen = new Set<string>();
  const out: FeatureSelectionTarget[] = [];
  for (const v of values) {
    const key = featureSelectionKey(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function cloneWithOptional<K extends "spatialFilter" | "extent" | "aggregation">(
  state: ExplorationState,
  key: K,
  value: ExplorationState[K] | undefined,
): ExplorationState {
  // Spread, then either omit or set — keeps the field optional in shape.
  const { spatialFilter, extent, aggregation, ...rest } = state;
  const base: ExplorationState = {
    ...rest,
    ...(spatialFilter !== undefined && key !== "spatialFilter" ? { spatialFilter } : {}),
    ...(extent !== undefined && key !== "extent" ? { extent } : {}),
    ...(aggregation !== undefined && key !== "aggregation" ? { aggregation } : {}),
  };
  if (value === undefined) return base;
  return { ...base, [key]: value } as ExplorationState;
}

function diffSlices(prev: ExplorationState, next: ExplorationState): Set<ExplorationSlice> {
  const changed = new Set<ExplorationSlice>();
  if (!filterMapsEqual(prev.filters, next.filters)) changed.add("filters");
  if (!spatialFiltersEqual(prev.spatialFilter, next.spatialFilter)) changed.add("spatialFilter");
  if (!extentsEqual(prev.extent, next.extent)) changed.add("extent");
  if (!selectionEqual(prev.selection, next.selection)) changed.add("selection");
  if (!sortEqual(prev.sort, next.sort)) changed.add("sort");
  if (!pageEqual(prev.page, next.page)) changed.add("page");
  if (!sequenceEqual(prev.visibleFields, next.visibleFields)) changed.add("visibleFields");
  if (!sequenceEqual(prev.grouping, next.grouping)) changed.add("grouping");
  if (!aggregationEqual(prev.aggregation, next.aggregation)) changed.add("aggregation");
  if (prev.preset !== next.preset) changed.add("preset");
  return changed;
}

function aggregationEqual(a: AggregationSpec | undefined, b: AggregationSpec | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aGroup = a.groupBy ?? [];
  const bGroup = b.groupBy ?? [];
  if (!sequenceEqual(aGroup, bGroup)) return false;
  if (a.metrics.length !== b.metrics.length) return false;
  for (let i = 0; i < a.metrics.length; i++) {
    const am = a.metrics[i];
    const bm = b.metrics[i];
    if (am.fn !== bm.fn || am.field !== bm.field || (am.alias ?? null) !== (bm.alias ?? null)) {
      return false;
    }
  }
  return true;
}
