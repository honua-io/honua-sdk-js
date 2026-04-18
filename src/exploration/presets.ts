/**
 * Built-in linked-view presets. The presets are declarative — the reducer
 * uses them to decide whether an intent originating in one view should
 * propagate to peers.
 *
 * Documented in `docs/exploration-context.md`.
 *
 * @module
 */

import type {
  ExplorationSlice,
  LinkedViewPolicy,
  LinkedViewPresetName,
  ViewRole,
} from "./types.js";

const ALL_SLICES: ReadonlyArray<ExplorationSlice> = [
  "filters",
  "spatialFilter",
  "extent",
  "selection",
  "sort",
  "page",
  "visibleFields",
  "grouping",
  "aggregation",
  "preset",
];

const NO_SLICES: ReadonlyArray<ExplorationSlice> = [];

/**
 * Built-in presets. The role-keyed `propagatesSlices` arrays describe what
 * a view of that role contributes when it is the originator of an intent.
 *
 * Usage by the reducer: when an intent arrives with `viewId`, the reducer
 * looks up the originator's role and intersects the slices it changed
 * with the role's `propagatesSlices`. Slices outside the intersection are
 * still applied to the central state but listeners on peer views' specific
 * slice subscriptions are not woken.
 *
 * `globalLinked` is the default — it is the safe choice for prototypes
 * and small dashboards where every change should affect every view.
 */
export const LINKED_VIEW_PRESETS: Readonly<Record<LinkedViewPresetName, LinkedViewPolicy>> = {
  globalLinked: {
    preset: "globalLinked",
    rules: roleRules({
      map: ALL_SLICES,
      grid: ALL_SLICES,
      chart: ALL_SLICES,
      form: ALL_SLICES,
      custom: ALL_SLICES,
    }),
  },
  mapDriven: {
    preset: "mapDriven",
    rules: roleRules({
      map: ["extent", "spatialFilter", "selection", "filters"],
      grid: NO_SLICES,
      chart: NO_SLICES,
      form: NO_SLICES,
      custom: NO_SLICES,
    }),
  },
  gridDriven: {
    preset: "gridDriven",
    rules: roleRules({
      map: NO_SLICES,
      grid: ["selection", "sort", "page", "filters", "visibleFields"],
      chart: NO_SLICES,
      form: NO_SLICES,
      custom: NO_SLICES,
    }),
  },
  chartDriven: {
    preset: "chartDriven",
    rules: roleRules({
      map: NO_SLICES,
      grid: NO_SLICES,
      chart: ["grouping", "aggregation", "filters"],
      form: NO_SLICES,
      custom: NO_SLICES,
    }),
  },
  decoupled: {
    preset: "decoupled",
    rules: roleRules({
      map: NO_SLICES,
      grid: NO_SLICES,
      chart: NO_SLICES,
      form: NO_SLICES,
      custom: NO_SLICES,
    }),
  },
};

function roleRules(
  table: Record<ViewRole, ReadonlyArray<ExplorationSlice>>,
): LinkedViewPolicy["rules"] {
  return [
    { role: "map", propagatesSlices: table.map },
    { role: "grid", propagatesSlices: table.grid },
    { role: "chart", propagatesSlices: table.chart },
    { role: "form", propagatesSlices: table.form },
    { role: "custom", propagatesSlices: table.custom },
  ];
}

/** Lookup the slices a role propagates under a given preset. */
export function propagationFor(
  preset: LinkedViewPresetName,
  role: ViewRole,
): ReadonlySet<ExplorationSlice> {
  const policy = LINKED_VIEW_PRESETS[preset];
  const rule = policy.rules.find((r) => r.role === role);
  return new Set(rule?.propagatesSlices ?? NO_SLICES);
}
