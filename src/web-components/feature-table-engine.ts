/**
 * Bounded feature-table engine — the headless kernel behind
 * `<honua-feature-table>` (issue #681).
 *
 * The engine is deliberately DOM-free so the whole production contract
 * (paging, sort, typed filters, column semantics, budgets, virtualization,
 * linked exploration state, realtime reconciliation, bounded export, and the
 * keyboard focus model) is testable without a browser and reusable by any
 * renderer.
 *
 * Design rules this module holds itself to:
 *
 * - **Public seams only.** Data arrives through the canonical `Source`-shaped
 *   query surface ({@link HonuaFeatureTableQuerySource}), typed filters are
 *   compiled by `@honua/sdk-js/filter-registry`, linked state flows through an
 *   `@honua/sdk-js/exploration` view controller, and realtime deltas arrive as
 *   the `@honua/sdk-js/realtime` reconciliation diff. No protocol adapter,
 *   renderer, or SDK-private path is imported.
 * - **Never manufacture a count.** {@link HonuaFeatureTableCount} always names
 *   the evidence a number came from, and reports `"unknown"` rather than
 *   guessing (REQ-004).
 * - **Never materialize a layer.** Every fetch is bounded by
 *   {@link HonuaFeatureTableBudgets}; the page cache evicts to stay under the
 *   row/byte ceilings and stops issuing work once the request ceiling is
 *   reached (REQ-002).
 * - **Identity before linkage.** A table with no resolvable stable row identity
 *   enters the `"unsupported"` state instead of keying rows by their position
 *   in a page, which would corrupt selection across paging.
 *
 * @module
 */

import type { DegradedReason, FeatureId, Query, Result, SortSpec, SourceDescriptor } from "../contract/types.js";
import type { HonuaTypedFeature } from "../core/types.js";
import { isSourceQualifiedSelectionTarget, sourceFeatureSelectionTarget } from "../exploration/selection.js";
import type {
  FilterClause as ExplorationFilterClause,
  ExplorationViewController,
  FeatureSelectionTarget,
} from "../exploration/types.js";
import type { FilterClause, FilterRegistrySnapshot } from "../filter-registry/index.js";
import { projectFilterRegistryToQuery } from "../filter-registry/index.js";
import type { QueryExecutionPlan, QueryPlanFidelity } from "../query-planner/types.js";
import type {
  RealtimeReconciliationInvalidation,
  RealtimeReconciliationResetReasonCode,
} from "../realtime/reconciliation.js";
import { reconcileRealtimeKeyedState, reconcileRealtimeViewport } from "../realtime/reconciliation.js";

// ── Source seam ───────────────────────────────────────────────

/**
 * The exact slice of the canonical `Source` contract this engine needs. A real
 * `Source` from `dataset.source(id)` satisfies it structurally, so consumers
 * never wrap it and tests never stub a protocol adapter.
 */
export interface HonuaFeatureTableQuerySource<T = Record<string, unknown>> {
  /** Optional descriptor; supplies `schema.primaryKey`, schema identity, and freshness. */
  readonly descriptor?: SourceDescriptor;
  /** Bounded single-page query. */
  query(request?: Query<T>): Promise<Result<T>>;
  /** Forward-only cursor paging. Required for `pagingMode: "cursor"`. */
  stream?(request?: Query<T>): AsyncGenerator<Result<T>, void, undefined>;
}

// ── Column semantics (REQ-001) ────────────────────────────────

/** Protocol-neutral column value class used for alignment and formatting. */
export type HonuaFeatureTableColumnType = "string" | "number" | "integer" | "boolean" | "date" | "unknown";

/** One column of the grid: identity, presentation, and per-column affordances. */
export interface HonuaFeatureTableColumn {
  readonly field: string;
  readonly label?: string;
  readonly type?: HonuaFeatureTableColumnType;
  /** `false` hides the column without dropping it from the declared order. */
  readonly visible?: boolean;
  readonly sortable?: boolean;
  /** Presentation-only formatter. Always client work; recorded as such in the evidence. */
  readonly format?: (value: unknown) => string;
}

/** A resolved column, with every optional narrowed to a concrete value. */
export interface HonuaFeatureTableResolvedColumn {
  readonly field: string;
  readonly label: string;
  readonly type: HonuaFeatureTableColumnType;
  readonly visible: boolean;
  readonly sortable: boolean;
  readonly format?: (value: unknown) => string;
}

// ── Rows + identity ───────────────────────────────────────────

/**
 * Stable row key. Shares the `@honua/sdk-js/realtime` feature key space so a
 * realtime reconciliation diff applies directly, and is convertible to an
 * exploration selection target through {@link HonuaFeatureTableRow.target}.
 */
export type HonuaFeatureTableRowKey = string;

/** Build the engine's row key. Shares the realtime key space (`sourceId:id`). */
export function featureTableRowKey(sourceId: string, id: FeatureId): HonuaFeatureTableRowKey {
  return `${sourceId}:${String(id)}`;
}

/** One materialized row inside the bounded window cache. */
export interface HonuaFeatureTableRow<T = Record<string, unknown>> {
  readonly key: HonuaFeatureTableRowKey;
  readonly id: FeatureId;
  readonly sourceId: string;
  /** Absolute row index in the ordered result, so virtualization is exact. */
  readonly index: number;
  readonly attributes: T;
  readonly geometry?: HonuaTypedFeature<T>["geometry"];
  /** Exploration selection target for this row (stable across paging). */
  readonly target: FeatureSelectionTarget;
}

// ── Result truth (REQ-004) ────────────────────────────────────

/**
 * Lifecycle of the table. `partial` and `stale` are first-class rather than
 * folded into `ready`, and `cancelled` is distinct from `error`.
 */
export type HonuaFeatureTableState =
  | "idle"
  | "loading"
  | "ready"
  | "partial"
  | "stale"
  | "cancelled"
  | "unsupported"
  | "error";

/** Where a row count came from. `"none"` means no evidence existed. */
export type HonuaFeatureTableCountEvidence =
  | "result-total-count"
  | "plan-estimate"
  | "exhausted-pages"
  | "loaded-rows"
  | "none";

/**
 * Row-count truth. `value` is present only when evidence supports a number;
 * `kind: "unknown"` is returned rather than inventing one (REQ-004).
 */
export interface HonuaFeatureTableCount {
  readonly kind: "known" | "estimated" | "partial" | "unknown";
  readonly value?: number;
  /** Rows currently materialized in the bounded cache. Always exact. */
  readonly loaded: number;
  readonly evidence: HonuaFeatureTableCountEvidence;
}

// ── Budgets (REQ-002) ─────────────────────────────────────────

/** Configurable row, memory, and request ceilings. All are hard limits. */
export interface HonuaFeatureTableBudgets {
  /** Rows requested per page. */
  readonly pageSize: number;
  /** Hard ceiling on simultaneously materialized rows. Older pages are evicted. */
  readonly maxCachedRows: number;
  /** Hard ceiling on the serialized attribute bytes retained in the cache. */
  readonly maxCachedBytes: number;
  /** Hard ceiling on remote requests for the life of one filter/sort identity. */
  readonly maxRequests: number;
  /** Hard ceiling on rows an export may drain. */
  readonly maxExportRows: number;
  /** Extra rows fetched either side of the visible window. */
  readonly windowOverscan: number;
}

/** Conservative defaults sized for an operational browser panel. */
export const DEFAULT_FEATURE_TABLE_BUDGETS: HonuaFeatureTableBudgets = Object.freeze({
  pageSize: 200,
  maxCachedRows: 2_000,
  maxCachedBytes: 4 * 1024 * 1024,
  maxRequests: 64,
  maxExportRows: 10_000,
  windowOverscan: 20,
});

/** Which ceiling a bounded operation ran into. */
export type HonuaFeatureTableBudgetKind = "rows" | "bytes" | "requests" | "export-rows";

/** Running budget consumption. Exact, and never reset by a render. */
export interface HonuaFeatureTableBudgetLedger {
  /**
   * Requests issued against the **current** filter/sort/projection identity,
   * which is what `budgets.maxRequests` bounds. Reset when the identity
   * changes, so a new question always gets its own request allowance.
   */
  readonly requests: number;
  /** Requests issued over the engine's whole lifetime. Never reset. */
  readonly lifetimeRequests: number;
  /** Rows transferred over the engine's whole lifetime. Never reset. */
  readonly rows: number;
  /** Attribute bytes transferred over the engine's whole lifetime. Never reset. */
  readonly bytes: number;
  /** Rows dropped by cache eviction over the whole lifetime. Never reset. */
  readonly evictedRows: number;
  /** Ceilings hit under the current identity. */
  readonly exhausted: readonly HonuaFeatureTableBudgetKind[];
}

// ── Query evidence (pushdown vs residual vs presentation) ─────

/** Where a unit of query work actually ran. */
export type HonuaFeatureTableWorkTier = "server" | "worker" | "client";

/** What the work was for. */
export type HonuaFeatureTableWorkConcern =
  | "filter"
  | "sort"
  | "paging"
  | "projection"
  | "format"
  | "virtualization"
  | "selection";

/** One attributed unit of query or presentation work. */
export interface HonuaFeatureTableWorkItem {
  readonly tier: HonuaFeatureTableWorkTier;
  readonly concern: HonuaFeatureTableWorkConcern;
  readonly detail: string;
  /** Accepted-plan step id, when the work was attributed to a plan step. */
  readonly planStepId?: string;
}

/**
 * Evidence for one refresh: the accepted plan's identity and pushdown verdict,
 * the residual work the plan pushed back to the client (or an injected worker),
 * and the presentation work this engine adds on top.
 */
export interface HonuaFeatureTableQueryEvidence {
  readonly planId?: string;
  readonly planFingerprint?: `sha256:${string}`;
  readonly pushdown?: "full" | "partial";
  readonly fidelity?: QueryPlanFidelity;
  readonly work: readonly HonuaFeatureTableWorkItem[];
  readonly degraded: readonly DegradedReason[];
  /** Page-cache identity digest for this filter/sort/projection generation. */
  readonly cacheKey: string;
}

/** Select the work items attributed to one execution tier. */
export function featureTableWorkByTier(
  evidence: HonuaFeatureTableQueryEvidence,
  tier: HonuaFeatureTableWorkTier,
): readonly HonuaFeatureTableWorkItem[] {
  return Object.freeze(evidence.work.filter((item) => item.tier === tier));
}

// ── Virtualization (REQ-002) ──────────────────────────────────

/** Scroll geometry the renderer measures and hands back to the engine. */
export interface HonuaFeatureTableScrollMetrics {
  readonly scrollTop: number;
  readonly rowHeight: number;
  readonly viewportHeight: number;
}

/** Inclusive-exclusive row window the renderer should paint. */
export interface HonuaFeatureTableWindow {
  readonly startIndex: number;
  readonly endIndex: number;
}

/**
 * Pure window computation: which absolute row indices a renderer must paint
 * for the given scroll geometry, widened by `overscan` and clamped to
 * `totalRows` when a total is known.
 */
export function featureTableWindow(
  metrics: HonuaFeatureTableScrollMetrics,
  options: { readonly overscan?: number; readonly totalRows?: number } = {},
): HonuaFeatureTableWindow {
  const rowHeight = metrics.rowHeight > 0 ? metrics.rowHeight : 1;
  const overscan = Math.max(0, options.overscan ?? 0);
  const first = Math.max(0, Math.floor(Math.max(0, metrics.scrollTop) / rowHeight) - overscan);
  const visible = Math.max(1, Math.ceil(Math.max(0, metrics.viewportHeight) / rowHeight));
  const last = first + visible + overscan * 2;
  const end = options.totalRows === undefined ? last : Math.min(last, Math.max(0, options.totalRows));
  return Object.freeze({ startIndex: Math.min(first, end), endIndex: end });
}

// ── Keyboard focus model (NFR-001) ────────────────────────────

/** The focused grid cell. Survives re-render and non-conflicting deltas. */
export interface HonuaFeatureTableFocus {
  readonly rowKey: HonuaFeatureTableRowKey;
  readonly field: string;
}

/** WAI-ARIA data-grid navigation vocabulary (WCAG 2.2 AA workflow). */
export type HonuaFeatureTableFocusMove =
  | "up"
  | "down"
  | "left"
  | "right"
  | "row-start"
  | "row-end"
  | "page-up"
  | "page-down"
  | "grid-start"
  | "grid-end";

// ── Realtime reconciliation (REQ-005) ─────────────────────────

/** Documented conflict announced when a delta cannot preserve interaction state. */
export type HonuaFeatureTableConflictCode =
  | "focused-row-deleted"
  | "selection-invalidated"
  | "snapshot-reset"
  | "schema-changed"
  | "sort-key-changed";

/** One announced conflict. Never silent, never a reorder behind the user's back. */
export interface HonuaFeatureTableConflict {
  readonly code: HonuaFeatureTableConflictCode;
  readonly message: string;
  readonly rowKeys: readonly HonuaFeatureTableRowKey[];
}

/**
 * Realtime input. A `RealtimeReconciliationDiff<HonuaTypedFeature<T>>` or
 * `RealtimeReconciliationResult<HonuaTypedFeature<T>>` from
 * `@honua/sdk-js/realtime` satisfies this structurally, so callers pass the
 * reconciler output straight through.
 */
export interface HonuaFeatureTableRealtimeDiff<T = Record<string, unknown>> {
  readonly changes: readonly {
    readonly kind: "create" | "update" | "delete";
    readonly key: string;
    readonly id: FeatureId;
    readonly sourceId?: string;
    /** Present for `"create"`/`"update"`. */
    readonly record?: { readonly feature: HonuaTypedFeature<T> };
  }[];
  readonly reset: boolean;
  readonly resetReason?: RealtimeReconciliationResetReasonCode;
}

/** Outcome of applying one realtime diff to the table. */
export interface HonuaFeatureTableRealtimeOutcome {
  /** True when focus, selection, sort, and window all survived unchanged. */
  readonly preserved: boolean;
  readonly conflicts: readonly HonuaFeatureTableConflict[];
  readonly focus?: HonuaFeatureTableFocus;
  readonly selection: readonly HonuaFeatureTableRowKey[];
  readonly sort: readonly SortSpec[];
  readonly window: HonuaFeatureTableWindow;
  readonly invalidations: readonly RealtimeReconciliationInvalidation[];
  /** Rows patched in place. A delta never reorders a materialized page. */
  readonly patchedRowKeys: readonly HonuaFeatureTableRowKey[];
}

// ── Export (REQ-001) ──────────────────────────────────────────

/** Bounded export request. Reuses the same paged query path as the grid. */
export interface HonuaFeatureTableExportRequest {
  readonly format: "csv" | "json";
  /** Requested row ceiling. Clamped to `budgets.maxExportRows`; never raises it. */
  readonly maxRows?: number;
  /** Restrict to the current selection instead of the full filtered result. */
  readonly selectionOnly?: boolean;
  readonly signal?: AbortSignal;
}

/** Bounded export result. `truncated` is the policy limit talking, not an error. */
export interface HonuaFeatureTableExport {
  readonly format: "csv" | "json";
  readonly content: string;
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly limit?: HonuaFeatureTableBudgetKind;
  readonly columns: readonly string[];
  readonly evidence: HonuaFeatureTableQueryEvidence;
}

// ── Page-cache identity ───────────────────────────────────────

/**
 * Everything that must change the cache key. Omitting any of these would let a
 * stale page answer a different question.
 */
export interface HonuaFeatureTablePageIdentity {
  readonly sourceId: string;
  readonly sourceVersion?: string;
  readonly schemaVersion?: string;
  readonly planFingerprint?: string;
  readonly filterKey: string;
  readonly sortKey: string;
  readonly projectionKey: string;
  readonly authorizationScope: readonly string[];
  readonly freshness: string;
}

/** Deterministic page-cache key. Stable across property insertion order. */
export function featureTablePageCacheKey(
  identity: HonuaFeatureTablePageIdentity,
  page: { readonly offset?: number; readonly limit?: number; readonly cursor?: number } = {},
): string {
  return [
    `source=${identity.sourceId}`,
    `sourceVersion=${identity.sourceVersion ?? ""}`,
    `schemaVersion=${identity.schemaVersion ?? ""}`,
    `plan=${identity.planFingerprint ?? ""}`,
    `filter=${identity.filterKey}`,
    `sort=${identity.sortKey}`,
    `projection=${identity.projectionKey}`,
    `scope=${[...identity.authorizationScope].sort().join("|")}`,
    `freshness=${identity.freshness}`,
    `offset=${page.offset ?? ""}`,
    `limit=${page.limit ?? ""}`,
    `cursor=${page.cursor ?? ""}`,
  ].join(" ");
}

// ── Snapshot ──────────────────────────────────────────────────

/** Forward-only cursor paging or random-access offset paging. */
export type HonuaFeatureTablePagingMode = "offset" | "cursor";

/** Paging position and drain state. */
export interface HonuaFeatureTablePaging {
  readonly mode: HonuaFeatureTablePagingMode;
  readonly pageSize: number;
  readonly loadedPages: number;
  /** True once the source reported no further rows for this identity. */
  readonly exhausted: boolean;
}

/** Immutable view of the whole table. Renderers read only this. */
export interface HonuaFeatureTableSnapshot<T = Record<string, unknown>> {
  readonly sourceId: string | undefined;
  readonly state: HonuaFeatureTableState;
  readonly columns: readonly HonuaFeatureTableResolvedColumn[];
  readonly visibleColumns: readonly HonuaFeatureTableResolvedColumn[];
  /**
   * The window slice, in absolute row order. `undefined` marks a row inside
   * the window whose page is not resident — the renderer paints a placeholder
   * rather than the engine inventing data.
   */
  readonly rows: readonly (HonuaFeatureTableRow<T> | undefined)[];
  readonly window: HonuaFeatureTableWindow;
  readonly count: HonuaFeatureTableCount;
  readonly sort: readonly SortSpec[];
  readonly filters: readonly FilterClause[];
  readonly selection: readonly HonuaFeatureTableRowKey[];
  readonly focus?: HonuaFeatureTableFocus;
  readonly paging: HonuaFeatureTablePaging;
  readonly budgets: HonuaFeatureTableBudgets;
  readonly ledger: HonuaFeatureTableBudgetLedger;
  readonly evidence: HonuaFeatureTableQueryEvidence;
  readonly conflicts: readonly HonuaFeatureTableConflict[];
  readonly stale: boolean;
  readonly message?: string;
  readonly error?: unknown;
  /** Monotonic revision; changes exactly when the snapshot changes. */
  readonly revision: number;
}

// ── Options ───────────────────────────────────────────────────

/** Accepted-plan provider. Called with the composed query before each fetch. */
export type HonuaFeatureTablePlanner<T = Record<string, unknown>> = (query: Query<T>) => QueryExecutionPlan | undefined;

export interface CreateHonuaFeatureTableOptions<T = Record<string, unknown>> {
  readonly source: HonuaFeatureTableQuerySource<T>;
  readonly sourceId: string;
  readonly columns?: readonly HonuaFeatureTableColumn[];
  readonly budgets?: Partial<HonuaFeatureTableBudgets>;
  readonly pagingMode?: HonuaFeatureTablePagingMode;
  readonly sort?: readonly SortSpec[];
  readonly filters?: readonly FilterClause[] | FilterRegistrySnapshot;
  /**
   * Attribute carrying stable row identity. Defaults to
   * `descriptor.schema.primaryKey`. Without one the table reports
   * `"unsupported"` instead of keying rows by page position.
   */
  readonly identityField?: string;
  /**
   * Explains the composed query so evidence can attribute pushdown. Pass
   * `(query) => explainQuery({ descriptor, query })` from
   * `@honua/sdk-js/query-planner`; omit to run without plan evidence.
   */
  readonly planner?: HonuaFeatureTablePlanner<T>;
  /** Where the plan's non-remote residual steps actually execute. @default "client" */
  readonly residualExecution?: "worker" | "client";
  /** Stable scope identifiers only. Never credentials. */
  readonly authorizationScope?: readonly string[];
  /** Bounded, credential-screened source version identity for the cache key. */
  readonly sourceVersion?: string;
  /** Whether geometry is requested with each page. @default false */
  readonly returnGeometry?: boolean;
}

// ── Public engine ─────────────────────────────────────────────

export interface HonuaFeatureTable<T = Record<string, unknown>> {
  readonly snapshot: HonuaFeatureTableSnapshot<T>;
  subscribe(listener: (snapshot: HonuaFeatureTableSnapshot<T>) => void): () => void;

  /** Discard cached pages and load the window again under the current identity. */
  refresh(options?: { readonly signal?: AbortSignal }): Promise<HonuaFeatureTableSnapshot<T>>;
  /** Report scroll geometry; loads only the pages the new window needs. */
  setScroll(metrics: HonuaFeatureTableScrollMetrics): Promise<HonuaFeatureTableSnapshot<T>>;
  /** Replace the multi-column sort. Invalidates the page cache. */
  setSort(sort: readonly SortSpec[]): Promise<HonuaFeatureTableSnapshot<T>>;
  /** Cycle one column asc → desc → unsorted. `additive` keeps the other keys. */
  toggleSort(field: string, options?: { readonly additive?: boolean }): Promise<HonuaFeatureTableSnapshot<T>>;
  /** Replace typed filters. Invalidates the page cache. */
  setFilters(filters: readonly FilterClause[] | FilterRegistrySnapshot): Promise<HonuaFeatureTableSnapshot<T>>;
  /** Replace column visibility/order/formatting. Projection changes refetch. */
  setColumns(columns: readonly HonuaFeatureTableColumn[]): Promise<HonuaFeatureTableSnapshot<T>>;
  /** Show/hide one column without reordering the rest. */
  setColumnVisibility(field: string, visible: boolean): Promise<HonuaFeatureTableSnapshot<T>>;

  select(keys: readonly HonuaFeatureTableRowKey[], options?: { readonly replace?: boolean }): void;
  deselect(keys?: readonly HonuaFeatureTableRowKey[]): void;
  /** Resolve exploration selection targets (map selection) to table row keys. */
  keysForTargets(targets: readonly FeatureSelectionTarget[]): readonly HonuaFeatureTableRowKey[];
  /** Exploration selection targets for the current selection (table → map). */
  selectionTargets(): readonly FeatureSelectionTarget[];

  setFocus(focus: HonuaFeatureTableFocus | undefined): void;
  /** Move the focused cell; may load the page the new focus lands on. */
  moveFocus(move: HonuaFeatureTableFocusMove): Promise<HonuaFeatureTableSnapshot<T>>;

  /** Apply one realtime diff, preserving interaction state or announcing a conflict. */
  applyRealtimeDiff(diff: HonuaFeatureTableRealtimeDiff<T>): HonuaFeatureTableRealtimeOutcome;
  /** Mark the resident pages stale without discarding them. */
  markStale(message?: string): void;

  /** Bounded export over the same paged query path. Cannot exceed policy. */
  export(request: HonuaFeatureTableExportRequest): Promise<HonuaFeatureTableExport>;

  /** Cancel the in-flight fetch; the table settles in the `"cancelled"` state. */
  cancel(): void;
  dispose(): void;
}

const EMPTY_EVIDENCE: HonuaFeatureTableQueryEvidence = Object.freeze({
  work: Object.freeze([]),
  degraded: Object.freeze([]),
  cacheKey: "",
});

const CANCELLED_MESSAGE = "The table refresh was cancelled.";

const NO_IDENTITY_FIELD_MESSAGE =
  "A stable row identity is required. Set `identityField` (or the source descriptor's `schema.primaryKey`) so selection, focus, and realtime reconciliation survive paging.";

const QUERY_CAPABILITY_MESSAGE =
  "The source does not advertise the canonical `query` capability, so a feature table cannot claim that bounded paging is supported.";

const IDENTITY_REQUIRED_HINT =
  "Every row must carry a string or number identity value, or selection and realtime reconciliation cannot survive paging.";

const PAGE_SIZE_HINT =
  "no page could ever be held within the memory budget. Lower `pageSize` or raise `maxCachedRows`.";

const CACHE_BUDGET_HINT = "Lower `pageSize` or raise the cache budget.";

interface CachedPage<T> {
  readonly offset: number;
  readonly rows: readonly HonuaFeatureTableRow<T>[];
  readonly bytes: number;
  readonly cacheKey: string;
  sequence: number;
}

/**
 * Create a bounded feature table.
 *
 * The engine starts `"idle"` and performs no I/O until {@link
 * HonuaFeatureTable.refresh} or {@link HonuaFeatureTable.setScroll} is called,
 * so mounting a grid never triggers an unbounded drain.
 */
export function createHonuaFeatureTable<T = Record<string, unknown>>(
  options: CreateHonuaFeatureTableOptions<T>,
): HonuaFeatureTable<T> {
  const budgets: HonuaFeatureTableBudgets = Object.freeze({ ...DEFAULT_FEATURE_TABLE_BUDGETS, ...options.budgets });
  const pagingMode: HonuaFeatureTablePagingMode = options.pagingMode ?? "offset";
  const residualTier: HonuaFeatureTableWorkTier = options.residualExecution === "worker" ? "worker" : "client";
  const authorizationScope: readonly string[] = Object.freeze([...(options.authorizationScope ?? [])]);
  const returnGeometry = options.returnGeometry ?? false;
  const identityField = options.identityField ?? options.source.descriptor?.schema?.primaryKey;
  const queryCapabilityAdvertised = options.source.descriptor?.capabilities?.has("query");

  const listeners = new Set<(snapshot: HonuaFeatureTableSnapshot<T>) => void>();
  const pages = new Map<number, CachedPage<T>>();
  /**
   * Exploration selection targets for the keys currently selected. Selection
   * outlives cache residency, so a row scrolled out of the bounded window must
   * still round-trip to a target. Pruned to the live selection on every change,
   * so this never becomes a second unbounded row cache.
   */
  const selectionTargetIndex = new Map<HonuaFeatureTableRowKey, FeatureSelectionTarget>();

  const misconfiguredPageSize = budgets.pageSize > budgets.maxCachedRows;

  let columns = resolveColumns(options.columns ?? []);
  let sort: readonly SortSpec[] = Object.freeze([...(options.sort ?? [])]);
  let filters = normalizeFilters(options.filters);
  let selection: readonly HonuaFeatureTableRowKey[] = Object.freeze([]);
  let focus: HonuaFeatureTableFocus | undefined;
  let window: HonuaFeatureTableWindow = Object.freeze({ startIndex: 0, endIndex: 0 });
  let state: HonuaFeatureTableState =
    identityField && !misconfiguredPageSize && queryCapabilityAdvertised !== false ? "idle" : "unsupported";
  let stale = false;
  let message: string | undefined = !identityField
    ? NO_IDENTITY_FIELD_MESSAGE
    : queryCapabilityAdvertised === false
      ? QUERY_CAPABILITY_MESSAGE
      : misconfiguredPageSize
        ? `\`budgets.pageSize\` (${budgets.pageSize}) exceeds \`budgets.maxCachedRows\` (${budgets.maxCachedRows}), so ${PAGE_SIZE_HINT}`
        : undefined;
  /** Set when a bounded operation had to give something up; survives a successful run. */
  let budgetNotice: string | undefined;
  let error: unknown;
  let conflicts: readonly HonuaFeatureTableConflict[] = Object.freeze([]);
  let evidence = EMPTY_EVIDENCE;
  let count: HonuaFeatureTableCount = Object.freeze({ kind: "unknown", loaded: 0, evidence: "none" });
  let ledger: HonuaFeatureTableBudgetLedger = Object.freeze({
    requests: 0,
    lifetimeRequests: 0,
    rows: 0,
    bytes: 0,
    evictedRows: 0,
    exhausted: Object.freeze([]),
  });
  let totalKnown: number | undefined;
  /** Which evidence produced `totalKnown`. Never inferred after the fact. */
  let totalEvidence: Extract<HonuaFeatureTableCountEvidence, "result-total-count" | "exhausted-pages"> =
    "result-total-count";
  let totalEstimated: number | undefined;
  let exhausted = false;
  let sequence = 0;
  let revision = 0;
  let disposed = false;
  let generation = 0;
  let cursorPages = 0;
  let cursorIterator: AsyncGenerator<Result<T>, void, undefined> | undefined;
  let inFlight: AbortController | undefined;

  // ── Snapshot assembly ───────────────────────────────────────

  function buildSnapshot(): HonuaFeatureTableSnapshot<T> {
    return Object.freeze({
      sourceId: options.sourceId,
      state,
      columns,
      visibleColumns: Object.freeze(columns.filter((column) => column.visible)),
      rows: Object.freeze(rowsInWindow()),
      window,
      count,
      sort,
      filters,
      selection,
      ...(focus ? { focus } : {}),
      paging: Object.freeze({ mode: pagingMode, pageSize: budgets.pageSize, loadedPages: pages.size, exhausted }),
      budgets,
      ledger,
      evidence,
      conflicts,
      stale,
      ...(message !== undefined ? { message } : {}),
      ...(error !== undefined ? { error } : {}),
      revision,
    });
  }

  let snapshot: HonuaFeatureTableSnapshot<T> = buildSnapshot();

  function publish(): HonuaFeatureTableSnapshot<T> {
    revision += 1;
    snapshot = buildSnapshot();
    for (const listener of [...listeners]) listener(snapshot);
    return snapshot;
  }

  /**
   * Read `state` opaquely. `loadWindow`/`nextCursorPage` can move the table to
   * `"unsupported"` mid-flight, which a direct comparison would have narrowed
   * away at the call site.
   */
  function currentState(): HonuaFeatureTableState {
    return state;
  }

  function rowsInWindow(): (HonuaFeatureTableRow<T> | undefined)[] {
    const out: (HonuaFeatureTableRow<T> | undefined)[] = [];
    for (let index = window.startIndex; index < window.endIndex; index += 1) out.push(rowAt(index));
    return out;
  }

  function rowAt(index: number): HonuaFeatureTableRow<T> | undefined {
    const page = pages.get(pageOffsetFor(index));
    if (!page) return undefined;
    return page.rows.find((row) => row.index === index);
  }

  function pageOffsetFor(index: number): number {
    return Math.floor(index / budgets.pageSize) * budgets.pageSize;
  }

  function loadedRows(): HonuaFeatureTableRow<T>[] {
    const out: HonuaFeatureTableRow<T>[] = [];
    for (const page of [...pages.values()].sort((left, right) => left.offset - right.offset)) out.push(...page.rows);
    return out;
  }

  function findRow(key: HonuaFeatureTableRowKey): HonuaFeatureTableRow<T> | undefined {
    for (const page of pages.values()) {
      const hit = page.rows.find((row) => row.key === key);
      if (hit) return hit;
    }
    return undefined;
  }

  // ── Query composition ───────────────────────────────────────

  function projection(): readonly string[] | undefined {
    const fields = columns.filter((column) => column.visible).map((column) => column.field);
    if (fields.length === 0) return undefined;
    return identityField && !fields.includes(identityField) ? [...fields, identityField] : fields;
  }

  function orderedFields(): readonly string[] {
    const visible = columns.filter((column) => column.visible).map((column) => column.field);
    return visible.length > 0 ? visible : columns.map((column) => column.field);
  }

  function composeQuery(page: { readonly offset?: number; readonly limit: number }): {
    readonly query: Query<T>;
    readonly degraded: readonly DegradedReason[];
    readonly filterKey: string;
  } {
    const descriptor = options.source.descriptor;
    const projected = projectFilterRegistryToQuery(
      { version: 1, clauses: filters },
      {
        sourceId: options.sourceId,
        ...(descriptor
          ? { source: { id: descriptor.id, protocol: descriptor.protocol, capabilities: descriptor.capabilities } }
          : {}),
      },
    );
    const outFields = projection();
    const query: Query<T> = {
      ...(projected.where !== undefined ? { where: projected.where } : {}),
      ...(projected.query.spatialFilter ? { spatialFilter: projected.query.spatialFilter } : {}),
      ...(outFields ? { outFields } : {}),
      ...(sort.length > 0 ? { orderBy: [...sort] } : {}),
      pagination: { ...(page.offset === undefined ? {} : { offset: page.offset }), limit: page.limit },
      returnGeometry,
    };
    return { query, degraded: projected.degraded ?? [], filterKey: projected.cacheKey };
  }

  function identity(filterKey: string, planFingerprint: string | undefined): HonuaFeatureTablePageIdentity {
    const descriptor = options.source.descriptor;
    const freshness = descriptor?.analytics?.freshness;
    return {
      sourceId: options.sourceId,
      ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
      ...(descriptor?.schemaV2?.fingerprint ? { schemaVersion: descriptor.schemaV2.fingerprint } : {}),
      ...(planFingerprint ? { planFingerprint } : {}),
      filterKey,
      sortKey: sort.map((entry) => `${entry.field}:${entry.direction ?? "asc"}`).join(","),
      projectionKey: (projection() ?? ["*"]).join(","),
      authorizationScope,
      freshness: freshness ? `${freshness.mode}:${freshness.ttlMs ?? ""}:${generation}` : `generation:${generation}`,
    };
  }

  function buildEvidence(
    plan: QueryExecutionPlan | undefined,
    degraded: readonly DegradedReason[],
    cacheKey: string,
  ): HonuaFeatureTableQueryEvidence {
    const work: HonuaFeatureTableWorkItem[] = [];
    for (const step of plan?.steps ?? []) {
      if (step.engine === "remote") {
        work.push({
          tier: "server",
          concern: step.pushdown === "full" ? "filter" : "paging",
          detail: `${step.operation} pushdown=${step.pushdown} fidelity=${step.fidelity}: ${step.reason}`,
          planStepId: step.id,
        });
      } else {
        work.push({
          tier: residualTier,
          concern: "filter",
          detail: `residual ${step.operation} bounded to ${step.maxRows} rows: ${step.reason}`,
          planStepId: step.id,
        });
      }
    }
    for (const reason of degraded) {
      work.push({
        tier: residualTier,
        concern: "filter",
        detail: `residual for ${reason.capability}: ${reason.reason}`,
      });
    }
    if (sort.length > 0) {
      work.push({
        tier: plan === undefined || plan.pushdown === "full" ? "server" : residualTier,
        concern: "sort",
        detail: `orderBy ${sort.map((entry) => `${entry.field} ${entry.direction ?? "asc"}`).join(", ")}`,
      });
    }
    work.push({
      tier: "client",
      concern: "virtualization",
      detail: `window ${window.startIndex}-${window.endIndex} over ${pages.size} resident page(s)`,
    });
    const formatted = columns.filter((column) => column.format).length;
    if (formatted > 0) {
      work.push({
        tier: "client",
        concern: "format",
        detail: `${formatted} column formatter(s) applied at render`,
      });
    }
    return Object.freeze({
      ...(plan ? { planId: plan.id, planFingerprint: plan.fingerprint, pushdown: plan.pushdown } : {}),
      ...(plan ? { fidelity: plan.fidelity } : {}),
      work: Object.freeze(work.map((item) => Object.freeze(item))),
      degraded: Object.freeze([...degraded]),
      cacheKey,
    });
  }

  // ── Budget accounting ───────────────────────────────────────

  function noteBudget(patch: { requests?: number; rows?: number; bytes?: number; evictedRows?: number }): void {
    ledger = Object.freeze({
      requests: ledger.requests + (patch.requests ?? 0),
      lifetimeRequests: ledger.lifetimeRequests + (patch.requests ?? 0),
      rows: ledger.rows + (patch.rows ?? 0),
      bytes: ledger.bytes + (patch.bytes ?? 0),
      evictedRows: ledger.evictedRows + (patch.evictedRows ?? 0),
      exhausted: ledger.exhausted,
    });
  }

  function markExhausted(kind: HonuaFeatureTableBudgetKind): void {
    if (ledger.exhausted.includes(kind)) return;
    ledger = Object.freeze({ ...ledger, exhausted: Object.freeze([...ledger.exhausted, kind]) });
  }

  function residentRows(): number {
    let total = 0;
    for (const page of pages.values()) total += page.rows.length;
    return total;
  }

  function residentBytes(): number {
    let total = 0;
    for (const page of pages.values()) total += page.bytes;
    return total;
  }

  function withinMemoryBudgets(): boolean {
    return residentRows() <= budgets.maxCachedRows && residentBytes() <= budgets.maxCachedBytes;
  }

  function evictPage(victim: CachedPage<T>): void {
    markExhausted(residentBytes() > budgets.maxCachedBytes ? "bytes" : "rows");
    pages.delete(victim.offset);
    noteBudget({ evictedRows: victim.rows.length });
  }

  /**
   * Evict least-recently-used pages until both memory ceilings hold.
   *
   * `protectedOffsets` names the pages the current window just fetched, which
   * are evicted last — but they are *not* exempt. A single page heavier than
   * `maxCachedBytes` would otherwise sit above a ceiling documented as hard,
   * so once every other page is gone the oversized page is dropped too and the
   * caller is told why. Its window rows then render as placeholders, which is
   * the honest outcome: the budget forbids holding that page.
   */
  function enforceMemoryBudgets(protectedOffsets: ReadonlySet<number>): void {
    const byAge = (left: CachedPage<T>, right: CachedPage<T>) => left.sequence - right.sequence;
    const evictable = [...pages.values()].filter((page) => !protectedOffsets.has(page.offset)).sort(byAge);
    for (const victim of evictable) {
      if (withinMemoryBudgets()) return;
      evictPage(victim);
    }
    if (withinMemoryBudgets()) return;
    for (const victim of [...pages.values()].sort(byAge)) {
      if (withinMemoryBudgets()) break;
      evictPage(victim);
      budgetNotice = `A page exceeded the table's memory budget (${budgets.maxCachedRows} rows / ${budgets.maxCachedBytes} bytes) and was dropped. ${CACHE_BUDGET_HINT}`;
    }
  }

  // ── Fetching ────────────────────────────────────────────────

  async function fetchPage(offset: number, signal: AbortSignal | undefined): Promise<CachedPage<T> | undefined> {
    const composed = composeQuery({ offset: pagingMode === "cursor" ? undefined : offset, limit: budgets.pageSize });
    const plan = options.planner?.(composed.query);
    const cacheKey = featureTablePageCacheKey(identity(composed.filterKey, plan?.fingerprint), {
      offset,
      limit: budgets.pageSize,
      ...(pagingMode === "cursor" ? { cursor: offset / budgets.pageSize } : {}),
    });
    const cached = pages.get(offset);
    if (cached && cached.cacheKey === cacheKey) {
      sequence += 1;
      cached.sequence = sequence;
      evidence = buildEvidence(plan, composed.degraded, cacheKey);
      return cached;
    }
    if (ledger.requests >= budgets.maxRequests) {
      markExhausted("requests");
      return undefined;
    }

    noteBudget({ requests: 1 });
    const request: Query<T> = { ...composed.query, ...(signal ? { signal } : {}) };
    // `Source.query` is not required to reject when its signal aborts, so a
    // superseded generation's response can still resolve normally and land here
    // long after the filter/sort/projection moved on. Cancellation alone cannot
    // prevent that; only refusing to write results whose generation no longer
    // matches can.
    const requestGeneration = generation;
    const result =
      pagingMode === "cursor" ? await nextCursorPage(offset, request) : await options.source.query(request);
    if (generation !== requestGeneration || disposed) return undefined;
    if (!result) return undefined;

    const rows: HonuaFeatureTableRow<T>[] = [];
    for (const [index, feature] of result.features.entries()) {
      const row = toRow(feature, offset + index);
      if (!row) return undefined; // `toRow` already moved the table to `"unsupported"`.
      rows.push(row);
    }
    const bytes = estimateBytes(result.features);
    sequence += 1;
    const page: CachedPage<T> = { offset, rows: Object.freeze([...rows]), bytes, cacheKey, sequence };
    pages.set(offset, page);
    noteBudget({ rows: rows.length, bytes });
    if (rows.length < budgets.pageSize && !result.exceededTransferLimit) {
      exhausted = true;
      if (totalKnown === undefined) {
        totalKnown = offset + rows.length;
        totalEvidence = "exhausted-pages";
      }
    }
    if (typeof result.totalCount === "number") {
      totalKnown = result.totalCount;
      totalEvidence = "result-total-count";
    } else if (typeof plan?.estimates?.rows === "number") totalEstimated = plan.estimates.rows;
    evidence = buildEvidence(plan, [...composed.degraded, ...(result.degraded ?? [])], cacheKey);
    enforceMemoryBudgets(new Set([offset]));
    return page;
  }

  /**
   * Forward-only cursor paging over `Source.stream()` — the protocol-neutral
   * cursor seam. Random access is impossible by construction, so a jump past
   * the drained frontier is reported as `"unsupported"` rather than silently
   * served from the wrong page.
   */
  async function nextCursorPage(offset: number, request: Query<T>): Promise<Result<T> | undefined> {
    const stream = options.source.stream;
    if (!stream) {
      state = "unsupported";
      message = 'Cursor paging requires the source\'s `stream` capability. Use `pagingMode: "offset"` instead.';
      return undefined;
    }
    const wantedPage = offset / budgets.pageSize;
    if (wantedPage > cursorPages) {
      state = "unsupported";
      message = `Cursor paging is forward-only: page ${wantedPage} is past the drained frontier (${cursorPages}).`;
      return undefined;
    }
    cursorIterator ??= stream.call(options.source, request);
    const next = await cursorIterator.next();
    if (next.done) {
      exhausted = true;
      return { features: [], exceededTransferLimit: false };
    }
    cursorPages += 1;
    return next.value;
  }

  /**
   * Build one row, or move the table to `"unsupported"` and return `undefined`.
   *
   * A row whose identity attribute is missing, `null`, or not a string/number
   * has no stable identity. Substituting its position in the page would key the
   * row by an offset that changes with every sort, filter, and page boundary —
   * exactly the selection corruption the unsupported-identity state exists to
   * prevent — so this refuses instead of inventing one.
   */
  function toRow(feature: HonuaTypedFeature<T>, index: number): HonuaFeatureTableRow<T> | undefined {
    const attributes = feature.attributes ?? ({} as T);
    const raw = identityField ? (attributes as Record<string, unknown>)[identityField] : undefined;
    if (typeof raw !== "string" && typeof raw !== "number") {
      state = "unsupported";
      message = `Row ${index} has no stable identity: \`${identityField}\` is ${describeIdentityValue(raw)}. ${IDENTITY_REQUIRED_HINT}`;
      return undefined;
    }
    const id: FeatureId = raw;
    return Object.freeze({
      key: featureTableRowKey(options.sourceId, id),
      id,
      sourceId: options.sourceId,
      index,
      attributes,
      ...(feature.geometry !== undefined ? { geometry: feature.geometry } : {}),
      target: sourceFeatureSelectionTarget(options.sourceId, id),
    });
  }

  function recomputeCount(): void {
    const loaded = residentRows();
    if (typeof totalKnown === "number") {
      count = Object.freeze({ kind: "known", value: totalKnown, loaded, evidence: totalEvidence });
      return;
    }
    if (exhausted) {
      count = Object.freeze({ kind: "known", value: loaded, loaded, evidence: "exhausted-pages" });
      return;
    }
    if (typeof totalEstimated === "number") {
      count = Object.freeze({ kind: "estimated", value: totalEstimated, loaded, evidence: "plan-estimate" });
      return;
    }
    count =
      loaded > 0
        ? Object.freeze({ kind: "partial", loaded, evidence: "loaded-rows" })
        : Object.freeze({ kind: "unknown", loaded, evidence: "none" });
  }

  async function loadWindow(signal: AbortSignal | undefined): Promise<void> {
    const wanted = new Set<number>();
    const end = Math.max(window.endIndex, window.startIndex + 1);
    for (let index = window.startIndex; index < end; index += 1) wanted.add(pageOffsetFor(index));
    for (const offset of [...wanted].sort((left, right) => left - right)) {
      if (currentState() === "unsupported") return;
      if (exhausted && typeof totalKnown === "number" && offset >= totalKnown) continue;
      await fetchPage(offset, signal);
      if (signal?.aborted) return;
    }
    enforceMemoryBudgets(wanted);
  }

  async function run(signal: AbortSignal | undefined): Promise<HonuaFeatureTableSnapshot<T>> {
    if (disposed || state === "unsupported") return snapshot;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    // A superseded run must not write state either: its `cancelled` verdict
    // would otherwise land after the newer run already published `ready`.
    const runGeneration = generation;
    state = "loading";
    error = undefined;
    publish();
    try {
      await loadWindow(controller.signal);
      if (generation !== runGeneration || disposed) return snapshot;
      if (controller.signal.aborted) {
        state = "cancelled";
        message = CANCELLED_MESSAGE;
      } else if (currentState() !== "unsupported") {
        const complete = exhausted || (typeof totalKnown === "number" && residentRows() >= totalKnown);
        state = complete ? "ready" : "partial";
        // A budget the run had to give something up for is not an error, but it
        // must not be silently cleared either.
        message = budgetNotice;
        stale = false;
      }
    } catch (caught) {
      if (generation !== runGeneration || disposed) return snapshot;
      if (isAbort(caught)) {
        state = "cancelled";
        message = CANCELLED_MESSAGE;
      } else {
        state = "error";
        error = caught;
        message = caught instanceof Error ? caught.message : "The table query failed.";
      }
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
    recomputeCount();
    return publish();
  }

  function invalidate(): void {
    generation += 1;
    pages.clear();
    exhausted = false;
    totalKnown = undefined;
    totalEvidence = "result-total-count";
    totalEstimated = undefined;
    cursorPages = 0;
    void cursorIterator?.return(undefined);
    cursorIterator = undefined;
    // `budgets.maxRequests` bounds one filter/sort/projection identity. Carrying
    // the previous identity's consumption forward would let an exhausted table
    // refuse to load a brand-new question forever, so the per-identity counter
    // and its exhaustion flags reset while the lifetime totals stay intact.
    ledger = Object.freeze({ ...ledger, requests: 0, exhausted: Object.freeze([]) });
    budgetNotice = undefined;
    conflicts = Object.freeze([]);
    if (state !== "unsupported") state = "idle";
  }

  function ensureWindow(): void {
    if (window.endIndex > window.startIndex) return;
    window = Object.freeze({ startIndex: 0, endIndex: budgets.pageSize });
  }

  // ── Selection + focus ───────────────────────────────────────

  function setSelection(next: readonly HonuaFeatureTableRowKey[]): void {
    const deduped = [...new Set(next)];
    if (deduped.length === selection.length && deduped.every((key, index) => selection[index] === key)) return;
    selection = Object.freeze(deduped);
    rememberSelectionTargets();
    publish();
  }

  /**
   * Keep an exploration target for every selected key, and only for those keys.
   *
   * Resident rows supply their own target; keys learned from
   * {@link HonuaFeatureTable.keysForTargets} keep the target they were resolved
   * from. Pruning to the live selection bounds the index by selection size.
   */
  function rememberSelectionTargets(): void {
    for (const key of selection) {
      const row = findRow(key);
      if (row) selectionTargetIndex.set(key, row.target);
    }
    for (const key of [...selectionTargetIndex.keys()]) {
      if (!selection.includes(key)) selectionTargetIndex.delete(key);
    }
  }

  /**
   * The row key a selection target maps to, or `undefined` when the target
   * belongs to another source.
   *
   * Resolution is arithmetic on identity, not a cache lookup: a target for this
   * source resolves whether or not its page is resident. A bare `FeatureId`
   * target (the single-source exploration form) is treated as this source's.
   */
  function keyForTarget(target: FeatureSelectionTarget): HonuaFeatureTableRowKey | undefined {
    if (!isSourceQualifiedSelectionTarget(target)) return featureTableRowKey(options.sourceId, target);
    if (target.sourceId !== options.sourceId) return undefined;
    return featureTableRowKey(options.sourceId, target.id);
  }

  async function applyFocusMove(move: HonuaFeatureTableFocusMove): Promise<HonuaFeatureTableSnapshot<T>> {
    const fields = orderedFields();
    if (fields.length === 0) return snapshot;
    const current = focus ? findRow(focus.rowKey) : undefined;
    const pageStep = Math.max(1, window.endIndex - window.startIndex);
    const lastIndex = typeof totalKnown === "number" ? Math.max(0, totalKnown - 1) : maxLoadedIndex();

    let absolute = current?.index ?? window.startIndex;
    let field = focus ? Math.max(0, fields.indexOf(focus.field)) : 0;
    switch (move) {
      case "up":
        absolute -= 1;
        break;
      case "down":
        absolute += 1;
        break;
      case "left":
        field -= 1;
        break;
      case "right":
        field += 1;
        break;
      case "row-start":
        field = 0;
        break;
      case "row-end":
        field = fields.length - 1;
        break;
      case "page-up":
        absolute -= pageStep;
        break;
      case "page-down":
        absolute += pageStep;
        break;
      case "grid-start":
        absolute = 0;
        field = 0;
        break;
      case "grid-end":
        absolute = lastIndex;
        field = fields.length - 1;
        break;
    }
    absolute = Math.max(0, Math.min(absolute, lastIndex));
    field = Math.max(0, Math.min(field, fields.length - 1));

    if (absolute < window.startIndex || absolute >= window.endIndex) {
      const span = Math.max(1, window.endIndex - window.startIndex);
      const start = Math.max(0, absolute - Math.floor(span / 2));
      window = Object.freeze({ startIndex: start, endIndex: start + span });
      await run(undefined);
    }
    const row = rowAt(absolute);
    const nextField = fields[field];
    if (!row || nextField === undefined) return publish();
    focus = Object.freeze({ rowKey: row.key, field: nextField });
    return publish();
  }

  function maxLoadedIndex(): number {
    let max = 0;
    for (const page of pages.values()) {
      for (const row of page.rows) max = Math.max(max, row.index);
    }
    return max;
  }

  // ── Realtime reconciliation (REQ-005) ───────────────────────

  function reconcile(diff: HonuaFeatureTableRealtimeDiff<T>): HonuaFeatureTableRealtimeOutcome {
    const keyed = {
      changes: diff.changes.map((change) => ({ kind: change.kind, key: change.key, id: change.id })),
      reset: diff.reset,
      ...(diff.resetReason ? { resetReason: diff.resetReason } : {}),
    };
    const nextConflicts: HonuaFeatureTableConflict[] = [];
    const patched: HonuaFeatureTableRowKey[] = [];
    const sortFields = new Set(sort.map((entry) => entry.field));

    const selectionResult = reconcileRealtimeKeyedState(new Set(selection), keyed);
    const focusResult = reconcileRealtimeKeyedState(new Set(focus ? [focus.rowKey] : []), keyed);
    const viewportResult = reconcileRealtimeViewport(window, keyed);

    if (diff.reset) {
      // A replacement snapshot / schema change replaces identity wholesale: the
      // cache is dropped and the conflict announced. Sort, filters, and column
      // state are user intent, so they are deliberately preserved.
      const preservedWindow = window;
      invalidate();
      window = preservedWindow;
      selection = Object.freeze([]);
      focus = undefined;
      stale = true;
      if (state !== "unsupported") state = "stale";
      const code: HonuaFeatureTableConflictCode =
        diff.resetReason === "schema-changed" ? "schema-changed" : "snapshot-reset";
      message =
        code === "schema-changed"
          ? "The source schema changed; refresh the table to rebuild rows."
          : "A replacement snapshot arrived; refresh the table to rebuild rows.";
      nextConflicts.push({ code, message, rowKeys: Object.freeze([]) });
    } else {
      for (const change of diff.changes) {
        if (change.kind === "delete") {
          removeRow(change.key);
          continue;
        }
        const existing = findRow(change.key);
        // A create landing outside the resident window is picked up by the next
        // fetch; patching it in would fabricate an ordering position.
        if (!existing) continue;
        const attributes = change.record?.feature.attributes;
        if (!attributes) continue;
        if (changesSortKey(existing.attributes, attributes, sortFields)) {
          nextConflicts.push({
            code: "sort-key-changed",
            message:
              "A live update changed a sorted column. The row was patched in place; refresh to re-order the table.",
            rowKeys: Object.freeze([change.key]),
          });
        }
        patchRow(existing, attributes, change.record?.feature.geometry);
        patched.push(change.key);
      }
      if (selectionResult.invalidations.length > 0) {
        selection = Object.freeze([...selectionResult.next]);
        nextConflicts.push({
          code: "selection-invalidated",
          message: "Selected rows were deleted upstream and were dropped from the selection.",
          rowKeys: Object.freeze(selectionResult.invalidations.map((entry) => entry.key)),
        });
      }
      if (focus && focusResult.invalidations.length > 0) {
        const deleted = focus.rowKey;
        focus = nextFocusAfterDeletion(focus);
        nextConflicts.push({
          code: "focused-row-deleted",
          message: "The focused row was deleted upstream. Focus moved to the next available row.",
          rowKeys: Object.freeze([deleted]),
        });
      }
    }

    recomputeCount();
    conflicts = Object.freeze(nextConflicts.map((conflict) => Object.freeze(conflict)));
    return Object.freeze({
      preserved: nextConflicts.length === 0,
      conflicts,
      ...(focus ? { focus } : {}),
      selection,
      sort,
      window: viewportResult.viewport,
      invalidations: Object.freeze([...selectionResult.invalidations, ...focusResult.invalidations]),
      patchedRowKeys: Object.freeze(patched),
    });
  }

  function removeRow(key: HonuaFeatureTableRowKey): void {
    for (const page of [...pages.values()]) {
      if (!page.rows.some((row) => row.key === key)) continue;
      pages.set(page.offset, { ...page, rows: Object.freeze(page.rows.filter((row) => row.key !== key)) });
      if (typeof totalKnown === "number") totalKnown = Math.max(0, totalKnown - 1);
      return;
    }
  }

  function patchRow(row: HonuaFeatureTableRow<T>, attributes: T, geometry: HonuaTypedFeature<T>["geometry"]): void {
    const page = pages.get(pageOffsetFor(row.index));
    if (!page) return;
    const next: HonuaFeatureTableRow<T> = Object.freeze({
      ...row,
      attributes: { ...(row.attributes as Record<string, unknown>), ...(attributes as Record<string, unknown>) } as T,
      ...(geometry !== undefined ? { geometry } : {}),
    });
    pages.set(page.offset, {
      ...page,
      rows: Object.freeze(page.rows.map((candidate) => (candidate.key === row.key ? next : candidate))),
    });
  }

  function nextFocusAfterDeletion(current: HonuaFeatureTableFocus): HonuaFeatureTableFocus | undefined {
    const fallback = loadedRows().find((row) => row.key !== current.rowKey);
    return fallback ? Object.freeze({ rowKey: fallback.key, field: current.field }) : undefined;
  }

  // ── Mutators ────────────────────────────────────────────────

  async function refresh(refreshOptions: { readonly signal?: AbortSignal } = {}) {
    invalidate();
    ensureWindow();
    return run(refreshOptions.signal);
  }

  async function setSort(nextSort: readonly SortSpec[]) {
    sort = Object.freeze([...nextSort]);
    invalidate();
    ensureWindow();
    return run(undefined);
  }

  async function setColumns(nextColumns: readonly HonuaFeatureTableColumn[]) {
    const before = (projection() ?? []).join(",");
    columns = resolveColumns(nextColumns);
    if ((projection() ?? []).join(",") === before) return publish();
    invalidate();
    ensureWindow();
    return run(undefined);
  }

  async function runExport(request: HonuaFeatureTableExportRequest): Promise<HonuaFeatureTableExport> {
    const fields = orderedFields();
    const ceiling = Math.max(0, Math.min(request.maxRows ?? budgets.maxExportRows, budgets.maxExportRows));
    const rows: HonuaFeatureTableRow<T>[] = [];
    let limit: HonuaFeatureTableBudgetKind | undefined =
      (request.maxRows ?? 0) > budgets.maxExportRows ? "export-rows" : undefined;

    if (request.selectionOnly) {
      const keys = new Set(selection);
      for (const row of loadedRows()) {
        if (keys.has(row.key) && rows.length < ceiling) rows.push(row);
      }
    } else {
      let offset = 0;
      while (rows.length < ceiling) {
        if (ledger.requests >= budgets.maxRequests) {
          markExhausted("requests");
          limit = "requests";
          break;
        }
        const page = await fetchPage(offset, request.signal);
        if (!page || page.rows.length === 0) break;
        for (const row of page.rows) {
          if (rows.length < ceiling) rows.push(row);
        }
        if (page.rows.length < budgets.pageSize) break;
        offset += budgets.pageSize;
      }
      if (rows.length >= ceiling && !exhausted) limit ??= "export-rows";
    }

    recomputeCount();
    publish();
    return Object.freeze({
      format: request.format,
      content: request.format === "csv" ? toCsv(rows, fields, columns) : toJson(rows, fields, columns),
      rowCount: rows.length,
      truncated: limit !== undefined,
      ...(limit ? { limit } : {}),
      columns: Object.freeze([...fields]),
      evidence,
    });
  }

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    async setScroll(metrics) {
      const next = featureTableWindow(metrics, {
        overscan: budgets.windowOverscan,
        ...(typeof totalKnown === "number" ? { totalRows: totalKnown } : {}),
      });
      if (next.startIndex === window.startIndex && next.endIndex === window.endIndex && state !== "idle") {
        return snapshot;
      }
      window = next;
      return run(undefined);
    },
    setSort,
    async toggleSort(field, toggleOptions = {}) {
      const existing = sort.find((entry) => entry.field === field);
      const others = toggleOptions.additive ? sort.filter((entry) => entry.field !== field) : [];
      if (existing === undefined) return setSort([...others, { field, direction: "asc" }]);
      if ((existing.direction ?? "asc") === "asc") return setSort([...others, { field, direction: "desc" }]);
      return setSort(others);
    },
    async setFilters(nextFilters) {
      filters = normalizeFilters(nextFilters);
      invalidate();
      ensureWindow();
      return run(undefined);
    },
    setColumns,
    async setColumnVisibility(field, visible) {
      return setColumns(columns.map((column) => (column.field === field ? { ...column, visible } : { ...column })));
    },
    select(keys, selectOptions = {}) {
      setSelection(selectOptions.replace === false ? [...selection, ...keys] : keys);
    },
    deselect(keys) {
      if (!keys) {
        setSelection([]);
        return;
      }
      const drop = new Set(keys);
      setSelection(selection.filter((key) => !drop.has(key)));
    },
    keysForTargets(targets) {
      const out: HonuaFeatureTableRowKey[] = [];
      for (const target of targets) {
        const key = keyForTarget(target);
        if (key === undefined || out.includes(key)) continue;
        // Remember the target so a selection made from an off-window key can
        // still be published back as a target.
        selectionTargetIndex.set(key, target);
        out.push(key);
      }
      return Object.freeze(out);
    },
    selectionTargets() {
      const out: FeatureSelectionTarget[] = [];
      for (const key of selection) {
        const target = findRow(key)?.target ?? selectionTargetIndex.get(key);
        if (target !== undefined) out.push(target);
      }
      return Object.freeze(out);
    },
    setFocus(nextFocus) {
      focus = nextFocus ? Object.freeze({ ...nextFocus }) : undefined;
      publish();
    },
    moveFocus: applyFocusMove,
    applyRealtimeDiff(diff) {
      const outcome = reconcile(diff);
      publish();
      return outcome;
    },
    markStale(nextMessage) {
      stale = true;
      if (state === "ready" || state === "partial") state = "stale";
      message = nextMessage;
      publish();
    },
    export: runExport,
    cancel() {
      const controller = inFlight;
      inFlight = undefined;
      controller?.abort();
      if (state === "loading") {
        state = "cancelled";
        message = CANCELLED_MESSAGE;
        publish();
      }
    },
    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = undefined;
      void cursorIterator?.return(undefined);
      cursorIterator = undefined;
      pages.clear();
      listeners.clear();
    },
  };
}

// ── Exploration linkage (REQ-003) ─────────────────────────────

export interface LinkFeatureTableToExplorationOptions {
  /** Sync the table's sort to the shared `sort` slice. @default true */
  readonly sort?: boolean;
  /** Sync column visibility to the shared `visibleFields` slice. @default true */
  readonly visibleFields?: boolean;
  /** Sync the shared `filters` slice into typed table filters. @default true */
  readonly filters?: boolean;
  /** Publish the table's selection to the shared `selection` slice. @default true */
  readonly selection?: boolean;
  /** Publish the virtualization window as the shared `page` slice. @default true */
  readonly page?: boolean;
}

/**
 * Wire a bounded table to a shared exploration view controller in **both**
 * directions (REQ-003).
 *
 * Table → context: selection, sort, and the virtualization window (as the
 * shared `page` slice) are published as intents from the bound view, so the
 * linked-view preset decides whether peers accept them.
 *
 * Context → table: peer changes to selection, sort, visible fields, and filters
 * are applied to the table. The view controller suppresses self-origin
 * notifications, and this binding additionally guards re-entry, so no feedback
 * loop is possible.
 *
 * Returns an unsubscribe function; call it on component teardown.
 */
export function linkFeatureTableToExploration<T>(
  table: HonuaFeatureTable<T>,
  view: ExplorationViewController,
  options: LinkFeatureTableToExplorationOptions = {},
): () => void {
  const syncSort = options.sort ?? true;
  const syncFields = options.visibleFields ?? true;
  const syncFilters = options.filters ?? true;
  const syncSelection = options.selection ?? true;
  const syncPage = options.page ?? true;

  let applying = false;

  const unsubscribeContext = view.subscribe(["selection", "sort", "visibleFields", "filters"], (event) => {
    if (applying) return;
    applying = true;
    try {
      if (syncSelection && event.changedSlices.has("selection")) {
        table.select(table.keysForTargets(event.state.selection), { replace: true });
      }
      if (syncSort && event.changedSlices.has("sort")) void table.setSort(event.state.sort);
      if (syncFields && event.changedSlices.has("visibleFields")) {
        const fields = new Set(event.state.visibleFields);
        if (fields.size > 0) {
          void table.setColumns(
            table.snapshot.columns.map((column) => ({ ...column, visible: fields.has(column.field) })),
          );
        }
      }
      if (syncFilters && event.changedSlices.has("filters")) {
        void table.setFilters(
          Object.entries(event.state.filters).map(([id, clause]) => explorationClauseToFilterClause(id, clause)),
        );
      }
    } finally {
      applying = false;
    }
  });

  let lastSelection = table.snapshot.selection;
  let lastSort = table.snapshot.sort;
  let lastWindow = table.snapshot.window;
  const unsubscribeTable = table.subscribe((snapshot) => {
    if (applying) return;
    applying = true;
    try {
      if (syncSelection && snapshot.selection !== lastSelection) {
        lastSelection = snapshot.selection;
        // Replace only this table's own source. A multi-source workspace's
        // selections for peer sources are not the table's to drop.
        const sourceId = snapshot.sourceId;
        const peers = view.state.selection.filter(
          (target) => isSourceQualifiedSelectionTarget(target) && target.sourceId !== sourceId,
        );
        view.select([...peers, ...table.selectionTargets()], { replace: true });
      }
      if (syncSort && snapshot.sort !== lastSort) {
        lastSort = snapshot.sort;
        view.setSort(snapshot.sort);
      }
      if (syncPage && snapshot.window !== lastWindow) {
        lastWindow = snapshot.window;
        view.setPage({
          offset: snapshot.window.startIndex,
          limit: Math.max(0, snapshot.window.endIndex - snapshot.window.startIndex),
        });
      }
    } finally {
      applying = false;
    }
  });

  return () => {
    unsubscribeContext();
    unsubscribeTable();
  };
}

/**
 * Project one exploration filter clause onto a filter-registry clause so the
 * shared `filters` slice compiles through the same typed pushdown path as
 * table-owned filters.
 */
export function explorationClauseToFilterClause(id: string, clause: ExplorationFilterClause): FilterClause {
  return {
    id,
    owner: { kind: "table", id: "honua-feature-table" },
    field: clause.field,
    operator: clause.operator,
    ...(clause.value === undefined ? {} : { value: clause.value }),
    ...(clause.appliesTo && clause.appliesTo.length > 0 ? { sourceScope: [...clause.appliesTo] } : {}),
    effect: "filter",
  };
}

// ── Presentation helpers ──────────────────────────────────────

/**
 * Default cell formatting. Pure presentation (always client work): `null` and
 * `undefined` render as an empty string rather than the words
 * `"null"`/`"undefined"`.
 */
export function formatFeatureTableCell(value: unknown, column?: HonuaFeatureTableResolvedColumn): string {
  if (column?.format) return column.format(value);
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

/** `aria-sort` token for one column, per the WAI-ARIA grid pattern. */
export function featureTableAriaSort(
  field: string,
  sort: readonly SortSpec[],
): "ascending" | "descending" | "none" | "other" {
  const entry = sort.find((candidate) => candidate.field === field);
  if (!entry) return "none";
  if (sort.length > 1 && sort[0]?.field !== field) return "other";
  return (entry.direction ?? "asc") === "asc" ? "ascending" : "descending";
}

/**
 * Screen-reader announcement for the current result truth. Deliberately says
 * "at least" for partial results instead of presenting a loaded-row count as a
 * total (REQ-004).
 */
export function describeFeatureTableCount(count: HonuaFeatureTableCount): string {
  switch (count.kind) {
    case "known":
      return `${count.value ?? 0} rows`;
    case "estimated":
      return `about ${count.value ?? 0} rows (estimated)`;
    case "partial":
      return `at least ${count.loaded} rows loaded; total unknown`;
    default:
      return "row count unknown";
  }
}

/**
 * `aria-rowcount` for the grid. Returns `-1` — the ARIA value for "total
 * unknown" — instead of substituting the loaded-row count (REQ-004).
 */
export function featureTableAriaRowCount(count: HonuaFeatureTableCount): number {
  return count.kind === "known" || count.kind === "estimated" ? (count.value ?? -1) + 1 : -1;
}

// ── Internals ─────────────────────────────────────────────────

function resolveColumns(columns: readonly HonuaFeatureTableColumn[]): readonly HonuaFeatureTableResolvedColumn[] {
  return Object.freeze(
    columns.map((column) =>
      Object.freeze({
        field: column.field,
        label: column.label ?? column.field,
        type: column.type ?? "unknown",
        visible: column.visible ?? true,
        sortable: column.sortable ?? true,
        ...(column.format ? { format: column.format } : {}),
      }),
    ),
  );
}

/** Name an unusable identity value without leaking the attribute payload. */
function describeIdentityValue(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  return `a ${Array.isArray(value) ? "array" : typeof value}`;
}

function normalizeFilters(
  filters: readonly FilterClause[] | FilterRegistrySnapshot | undefined,
): readonly FilterClause[] {
  if (!filters) return Object.freeze([]);
  if (Array.isArray(filters)) return Object.freeze([...filters]);
  return Object.freeze([...(filters as FilterRegistrySnapshot).clauses]);
}

function estimateBytes<T>(features: readonly HonuaTypedFeature<T>[]): number {
  let total = 0;
  for (const feature of features) {
    try {
      total += JSON.stringify(feature.attributes ?? {})?.length ?? 0;
    } catch {
      // A non-serializable attribute bag contributes no measurable ceiling cost.
    }
  }
  return total * 2; // UTF-16 code units
}

function changesSortKey<T>(previous: T, next: T, sortFields: ReadonlySet<string>): boolean {
  if (sortFields.size === 0) return false;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  for (const field of sortFields) {
    if (field in after && before[field] !== after[field]) return true;
  }
  return false;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function toCsv<T>(
  rows: readonly HonuaFeatureTableRow<T>[],
  fields: readonly string[],
  columns: readonly HonuaFeatureTableResolvedColumn[],
): string {
  const byField = new Map(columns.map((column) => [column.field, column] as const));
  const lines = [fields.map(csvCell).join(",")];
  for (const row of rows) {
    const attributes = row.attributes as Record<string, unknown>;
    lines.push(fields.map((field) => csvCell(formatFeatureTableCell(attributes[field], byField.get(field)))).join(","));
  }
  return lines.join("\n");
}

function csvCell(value: string): string {
  if (!value.includes(",") && !value.includes('"') && !value.includes("\n")) return value;
  return `"${value.split('"').join('""')}"`;
}

function toJson<T>(
  rows: readonly HonuaFeatureTableRow<T>[],
  fields: readonly string[],
  columns: readonly HonuaFeatureTableResolvedColumn[],
): string {
  const byField = new Map(columns.map((column) => [column.field, column] as const));
  return JSON.stringify(
    rows.map((row) => {
      const attributes = row.attributes as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const field of fields) out[field] = formatFeatureTableCell(attributes[field], byField.get(field));
      return { id: row.id, attributes: out };
    }),
  );
}
