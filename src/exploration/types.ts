/**
 * `ExplorationContext` types — the canonical, protocol-neutral exploration
 * state shared across linked views (map, grid, chart, etc.).
 *
 * The runtime in `./context.ts` is a thin reducer + microtask coalescer
 * over these types; the full design lives in `docs/exploration-context.md`.
 *
 * @module
 */

import type { SpatialFilter } from "../core/spatial-filter.js";
import type { HonuaExtent } from "../core/types.js";
import type {
  AggregationSpec,
  FeatureId,
  PaginationSpec,
  SortSpec,
  SourceId,
} from "../contract/types.js";

// ── Filter clauses ────────────────────────────────────────────

/**
 * Filter operator vocabulary. Adapter implementations translate these to
 * GeoServices SQL-92, OGC CQL2, WFS Filter Encoding, OData $filter, etc.
 * Keep the set protocol-neutral — anything that does not translate
 * universally belongs in adapter-specific extensions.
 */
export type FilterOperator =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not-in"
  | "between"
  | "like"
  | "is-null"
  | "is-not-null";

/**
 * One global filter clause keyed by field. A `FilterClause` is value-only —
 * adapters build the protocol-specific WHERE / CQL2 / $filter expression
 * from `field`, `operator`, and `value` together.
 */
export interface FilterClause {
  field: string;
  operator: FilterOperator;
  value?: unknown;
  /** Optional list of source ids the clause applies to. Empty = all sources. */
  appliesTo?: ReadonlyArray<SourceId>;
}

// ── State ─────────────────────────────────────────────────────

/**
 * Immutable exploration-state snapshot. Reducers return a new object on
 * change; readers compare by reference (`prev.filters !== next.filters`).
 *
 * Fields map 1:1 to the slices that views can subscribe to (see
 * `ExplorationSlice`). Adding a field requires extending the slice union,
 * the reducer's diff logic, and the linked-view preset table.
 */
export interface ExplorationState {
  /** Global filters keyed by clause id. */
  readonly filters: Readonly<Record<string, FilterClause>>;
  /** Optional spatial filter (geometry + relationship). */
  readonly spatialFilter?: SpatialFilter;
  /** Current viewport extent. */
  readonly extent?: HonuaExtent;
  /** Currently selected feature ids. */
  readonly selection: ReadonlyArray<FeatureId>;
  /** Sort order shared across linked views. */
  readonly sort: ReadonlyArray<SortSpec>;
  /** Pagination cursor / offset / limit. */
  readonly page: PaginationSpec;
  /** Field visibility for tabular / form views. Empty = "all". */
  readonly visibleFields: ReadonlyArray<string>;
  /** Group-by keys for chart / pivot views. */
  readonly grouping: ReadonlyArray<string>;
  /** Aggregation spec (mirrors `Query.aggregation`). */
  readonly aggregation?: AggregationSpec;
  /** Active linked-view preset name. */
  readonly preset: LinkedViewPresetName;
}

/** Initial empty state used when none is provided. */
export const EMPTY_STATE: ExplorationState = {
  filters: {},
  selection: [],
  sort: [],
  page: {},
  visibleFields: [],
  grouping: [],
  preset: "globalLinked",
};

// ── Slices ────────────────────────────────────────────────────

/**
 * Subscribable slice keys. `"all"` fires for every change; the others fire
 * only when the corresponding state field actually changes by reference
 * (the reducer enforces structural equality).
 */
export type ExplorationSlice =
  | "all"
  | "filters"
  | "spatialFilter"
  | "extent"
  | "selection"
  | "sort"
  | "page"
  | "visibleFields"
  | "grouping"
  | "aggregation"
  | "preset";

/** All slice keys, in declaration order. */
export const SLICES: readonly ExplorationSlice[] = [
  "all",
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
] as const;

// ── Intents ───────────────────────────────────────────────────

/**
 * Tagged union of all dispatchable intents. Reducers exhaustively match
 * `intent.kind`; downstream tickets that need a new intent must extend this
 * union rather than introducing parallel dispatch surfaces.
 *
 * `viewId` is optional and identifies the originating view so the
 * linked-view policy can decide whether to propagate to peers.
 */
export type ExplorationIntent =
  | SetFilterIntent
  | ClearFilterIntent
  | SetSpatialFilterIntent
  | SetExtentIntent
  | SelectIntent
  | DeselectIntent
  | SetSortIntent
  | SetPageIntent
  | SetVisibleFieldsIntent
  | SetGroupingIntent
  | SetAggregationIntent
  | ApplyPresetIntent
  | SnapshotRestoreIntent;

interface IntentBase {
  readonly viewId?: string;
}

export interface SetFilterIntent extends IntentBase {
  readonly kind: "set-filter";
  readonly id: string;
  readonly clause: FilterClause;
}

export interface ClearFilterIntent extends IntentBase {
  readonly kind: "clear-filter";
  readonly id: string;
}

export interface SetSpatialFilterIntent extends IntentBase {
  readonly kind: "set-spatial-filter";
  readonly spatialFilter: SpatialFilter | undefined;
}

export interface SetExtentIntent extends IntentBase {
  readonly kind: "set-extent";
  readonly extent: HonuaExtent | undefined;
}

export interface SelectIntent extends IntentBase {
  readonly kind: "select";
  readonly ids: ReadonlyArray<FeatureId>;
  /** When `true`, replaces the selection. Default = additive. */
  readonly replace?: boolean;
}

export interface DeselectIntent extends IntentBase {
  readonly kind: "deselect";
  /** Omit `ids` to clear the entire selection. */
  readonly ids?: ReadonlyArray<FeatureId>;
}

export interface SetSortIntent extends IntentBase {
  readonly kind: "set-sort";
  readonly sort: ReadonlyArray<SortSpec>;
}

export interface SetPageIntent extends IntentBase {
  readonly kind: "set-page";
  readonly page: PaginationSpec;
}

export interface SetVisibleFieldsIntent extends IntentBase {
  readonly kind: "set-visible-fields";
  readonly fields: ReadonlyArray<string>;
}

export interface SetGroupingIntent extends IntentBase {
  readonly kind: "set-grouping";
  readonly grouping: ReadonlyArray<string>;
}

export interface SetAggregationIntent extends IntentBase {
  readonly kind: "set-aggregation";
  readonly aggregation: AggregationSpec | undefined;
}

export interface ApplyPresetIntent extends IntentBase {
  readonly kind: "apply-preset";
  readonly preset: LinkedViewPresetName;
}

export interface SnapshotRestoreIntent extends IntentBase {
  readonly kind: "snapshot-restore";
  readonly snapshot: ExplorationStateSnapshot;
}

// ── Snapshots ─────────────────────────────────────────────────

/**
 * Serializable snapshot of an `ExplorationState`. Versioned so that future
 * shape changes can migrate forward. The shape is structurally compatible
 * with `ExplorationState` minus the live preset enum (carried verbatim).
 */
export interface ExplorationStateSnapshot {
  readonly version: 1;
  readonly state: ExplorationState;
}

// ── Linked-view policy ────────────────────────────────────────

/**
 * Built-in linked-view presets. Each preset declares which slices propagate
 * from the originating view to its peers.
 *
 * - `globalLinked`: every view sees every change. Default.
 * - `mapDriven`: only the map's extent / spatial filter / selection
 *   propagates outward; other views' changes stay local.
 * - `gridDriven`: only the grid's selection / sort / page propagates outward.
 * - `chartDriven`: only the chart's grouping / aggregation propagates outward.
 * - `decoupled`: nothing propagates — each view is independent.
 */
export type LinkedViewPresetName =
  | "globalLinked"
  | "mapDriven"
  | "gridDriven"
  | "chartDriven"
  | "decoupled";

/**
 * Per-view propagation rule. `propagatesFrom` lists the view roles whose
 * changes a peer view will accept; `propagatesSlices` lists which state
 * slices a view contributes when it is the origin.
 */
export interface LinkedViewRule {
  readonly role: ViewRole;
  readonly propagatesSlices: ReadonlyArray<ExplorationSlice>;
}

/** Coarse role that informs the linked-view policy. */
export type ViewRole = "map" | "grid" | "chart" | "form" | "custom";

export interface LinkedViewPolicy {
  readonly preset: LinkedViewPresetName;
  readonly rules: ReadonlyArray<LinkedViewRule>;
}

// ── View bindings ─────────────────────────────────────────────

/**
 * Descriptor a caller passes to `ExplorationContext.bind`. `role` is used
 * by the linked-view policy; `slices` declares which slices the view wants
 * to subscribe to (defaults to `["all"]`).
 */
export interface ViewBinding {
  readonly id: string;
  readonly role: ViewRole;
  readonly slices?: ReadonlyArray<ExplorationSlice>;
}

/** Handle returned from `ExplorationContext.bind`. */
export interface ViewHandle {
  readonly id: string;
  /** Releases the binding. After unbinding, callbacks no longer fire. */
  unbind(): void;
}

// ── Listeners + change events ─────────────────────────────────

export interface ChangeEvent {
  readonly state: ExplorationState;
  readonly previous: ExplorationState;
  readonly changedSlices: ReadonlySet<ExplorationSlice>;
  readonly origin: ExplorationIntent | undefined;
}

export type Listener = (event: ChangeEvent) => void;
export type Unsubscribe = () => void;

// ── ExplorationContext ────────────────────────────────────────

/**
 * Protocol-neutral container for shared exploration state. One context
 * normally backs one `Dataset`; multiple views attach via `bind`. State
 * mutations go through `dispatch` and are visible synchronously to
 * `state` / `snapshot` but listeners fire on a microtask so a burst of
 * intents coalesces into a single notification per slice.
 */
export interface ExplorationContext {
  readonly datasetId: string;
  readonly sourceIds: ReadonlyArray<SourceId>;
  readonly state: ExplorationState;
  readonly policy: LinkedViewPolicy;

  bind(view: ViewBinding): ViewHandle;
  dispatch(intent: ExplorationIntent): void;
  subscribe(slice: ExplorationSlice, fn: Listener): Unsubscribe;
  snapshot(): ExplorationStateSnapshot;
  restore(snapshot: ExplorationStateSnapshot): void;
  /** Releases all bindings, clears listeners, and stops accepting intents. */
  dispose(): void;
}

export interface CreateExplorationContextOptions {
  datasetId: string;
  sourceIds: ReadonlyArray<SourceId>;
  initialState?: Partial<ExplorationState>;
  preset?: LinkedViewPresetName;
}
