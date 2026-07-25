/**
 * The versioned linked-analytics presentation contract.
 *
 * Honua does not ship a chart engine. This module defines the data-only seam
 * that lets a server-pushdown widget model, a bounded columnar transform, the
 * small accessible default presentation, and any specialist third-party chart
 * library participate in *one* filter / selection / temporal / capability /
 * provenance model.
 *
 * Two rules keep the seam honest:
 *
 * 1. **No renderer objects in SDK core.** An adapter receives an
 *    {@link AnalyticsArtifact} plus an {@link AnalyticsPresentationHost} and
 *    emits protocol-neutral {@link AnalyticsInteraction} values. Canvas
 *    contexts, chart instances, DOM nodes, and library option objects never
 *    cross back into the contract.
 * 2. **No duplicate data ownership.** An artifact is *accepted* once; every
 *    presentation holds the same frozen reference and owns no persistent
 *    cache. Updates are resolved by artifact identity into an explicit
 *    patch / invalidate / ignore decision (see
 *    `resolveAnalyticsUpdateDisposition`).
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0`.
 * @module
 */

import type { AggregationFn, AggregationTimeIntervalSpec, SourceId } from "../contract/types.js";
import type { FeatureSelectionTarget, FilterClause } from "../exploration/types.js";

/**
 * Version of the analytics presentation contract. Adapters echo the version
 * they were written against so a host can refuse an incompatible adapter
 * instead of silently mis-rendering (see `assertAnalyticsContractVersion`).
 */
export const ANALYTICS_CONTRACT_VERSION = "1.0" as const;

/** The contract version literal type. */
export type AnalyticsContractVersion = typeof ANALYTICS_CONTRACT_VERSION;

// ── Artifact semantics ────────────────────────────────────────

/**
 * Analytics semantics the contract models. Deliberately closed: each kind has
 * defined units, null handling, ordering, and interaction meaning. A chart
 * library may render a kind however it likes, but it may not invent a kind.
 */
export type AnalyticsArtifactKind = "category" | "histogram" | "aggregate" | "time-series";

/**
 * Honesty state of an accepted artifact. Every state is renderable and
 * inspectable — an adapter must never present `partial`, `stale`, or
 * `unsupported` data as authoritative.
 *
 * - `ready`: complete and current for its plan.
 * - `partial`: truthful but incomplete (transfer limit, bounded scan, or a
 *   degraded source strategy).
 * - `stale`: previously complete, superseded by a newer plan or expired
 *   freshness window; still shown, explicitly marked.
 * - `unsupported`: the requested analytic could not be computed. `message` is
 *   required; `points`/`values` are empty.
 * - `error`: computation failed. `message` is required.
 */
export type AnalyticsArtifactStatus = "ready" | "partial" | "stale" | "unsupported" | "error";

/**
 * Where the numbers came from. `server` and `worker` are pushdown paths;
 * `client` means the SDK reduced rows locally and is only legal under an
 * explicit, bounded budget.
 */
export type AnalyticsComputeSite = "server" | "worker" | "client";

/**
 * Freshness authority of an accepted artifact, mirroring the vocabulary the
 * realtime delivery gate uses so a dashboard can render one badge for both.
 */
export type AnalyticsFreshness = "live" | "cached" | "replaying" | "stale";

/** How null / missing inputs were treated. Never left implicit. */
export type AnalyticsNullPolicy = "excluded" | "counted-as-zero" | "separate-bucket" | "propagated-as-null" | "unknown";

/** Ordering key an artifact's marks are already sorted by. */
export type AnalyticsOrderingKey = "value" | "label" | "bucket" | "time" | "explicit";

/**
 * Declared ordering of the artifact's marks. The producer sorts once; adapters
 * render in array order and must not re-sort, so every linked presentation
 * shows the same sequence.
 */
export interface AnalyticsOrdering {
  readonly by: AnalyticsOrderingKey;
  readonly direction: "asc" | "desc";
  /** True when ties were broken by mark key to make the order deterministic. */
  readonly tieBreak?: "key";
}

/**
 * Unit and formatting metadata for a measure. `unit` is a free-form display
 * unit (`"count"`, `"km"`, `"USD"`, `"°C"`); `unitSystem` classifies it so a
 * host can localize without parsing the string.
 */
export interface AnalyticsMeasure {
  /** Field the measure aggregates. `"*"` for a plain row count. */
  readonly field: string;
  readonly fn: AggregationFn;
  /** Display label. Falls back to `alias ?? field` when omitted. */
  readonly label?: string;
  /** Alias the aggregate row uses for this measure. */
  readonly alias?: string;
  readonly unit?: string;
  readonly unitSystem?: "count" | "length" | "area" | "duration" | "currency" | "temperature" | "ratio" | "other";
  /** Decimal places a presentation should render by default. */
  readonly precision?: number;
}

// ── Identity + provenance ─────────────────────────────────────

/**
 * Freshness of the underlying source observation. The field vocabulary
 * deliberately matches `ColumnarFreshnessV1` (`src/columnar/types.ts`) so a
 * dashboard renders one badge for a columnar batch and an analytics artifact.
 *
 * `validator` and `generation` are opaque, non-secret source identifiers.
 * Producers must never place a bearer token, API key, cookie, or credential
 * in them.
 */
export interface AnalyticsFreshnessState {
  readonly authority: AnalyticsFreshness;
  /** RFC-3339 instant at which the source result was observed. */
  readonly observedAt: string;
  /** RFC-3339 instant after which the artifact must be revalidated. */
  readonly staleAfter?: string;
  /** Opaque source validator, such as an HTTP ETag. */
  readonly validator?: string;
  /** Opaque monotonic source generation or revision. */
  readonly generation?: string;
}

/**
 * Identity of an accepted analytics artifact. The lineage tuple
 * (`artifactId`, `sourceId`, `planFingerprint`) plus the artifact's kind and
 * dimension decides whether a later artifact *patches* the presentation or
 * *invalidates* it; `sequence` orders deltas within one lineage so a late
 * delta is ignored instead of overwriting newer numbers.
 */
export interface AnalyticsArtifactIdentity {
  /** Stable id for this widget's artifact lineage (not per-update). */
  readonly artifactId: string;
  readonly sourceId: SourceId;
  /** Plan id when the artifact came from an explained/executed plan. */
  readonly planId?: string;
  /**
   * Fingerprint of the query plan that produced the artifact — pass
   * `QueryExecutionPlan["fingerprint"]` when a plan was explained, or any
   * deterministic digest of the request otherwise.
   */
  readonly planFingerprint?: string;
  /** Source version the artifact was computed against. */
  readonly sourceVersion?: string;
  /** Deterministic cache key of the producing request, when the producer has one. */
  readonly cacheKey?: string;
  /** Monotonic counter within one lineage. Deltas must not go backwards. */
  readonly sequence: number;
  /** RFC-3339 instant the host accepted the artifact. */
  readonly acceptedAt: string;
  readonly freshness: AnalyticsFreshnessState;
}

/**
 * Structured record of what the producer was allowed to read and whether it
 * ran out of budget. This is the machine-readable form of the truncation that
 * widget sources otherwise only report as prose in `DegradedReason.reason`.
 */
export interface AnalyticsBounds {
  /** True when marks are missing because a budget or transfer limit was hit. */
  readonly truncated: boolean;
  /** Client-fallback row ceiling the producer was allowed. */
  readonly rowBudget?: number;
  /** Rows the aggregation consumed, when the producer reports it. */
  readonly scannedRowCount?: number;
  /** Rows transferred to the client to build the artifact. */
  readonly transferredRowCount?: number;
  /** Marks omitted by a category/bucket limit. */
  readonly omittedMarkCount?: number;
}

/**
 * Why the numbers can be trusted, and what they cost. Presentation adapters
 * surface this verbatim — they never re-derive or embellish it.
 */
export interface AnalyticsProvenance {
  readonly computedBy: AnalyticsComputeSite;
  /** True when the aggregation executed inside the source / server plan. */
  readonly pushdown: boolean;
  readonly bounds: AnalyticsBounds;
  /** Reasons the source degraded the aggregation, copied from `Result.degraded`. */
  readonly degraded?: readonly AnalyticsDegradation[];
  /** Attribution strings a presentation must display when non-empty. */
  readonly attribution?: readonly string[];
  /** Free-form producer notes (bounded scan, alias fallback, timezone, …). */
  readonly notes?: readonly string[];
}

/** Projection of a `Result.degraded` entry, without the protocol coupling. */
export interface AnalyticsDegradation {
  readonly capability: string;
  readonly reason: string;
  readonly protocol?: string;
  readonly sourceId?: SourceId;
}

// ── Marks ─────────────────────────────────────────────────────

/**
 * Common mark fields. `key` is the stable interaction identity: adapters emit
 * it back on click / hover, and the linked-state binding turns it into a
 * filter clause or selection. Keys are unique within an artifact.
 */
export interface AnalyticsMarkBase {
  readonly key: string;
  readonly label: string;
  /**
   * Measured value. `null` means "no value" and must render as an explicit
   * gap — never as `0` — unless the null policy is `counted-as-zero`.
   */
  readonly value: number | null;
  /** Row count behind the value, when it differs from `value`. */
  readonly count?: number;
  /**
   * Feature targets this mark stands for, when the producer can enumerate
   * them cheaply. Enables mark-click to drive map/table selection directly
   * instead of only filtering.
   */
  readonly targets?: readonly FeatureSelectionTarget[];
}

/** One category / group-by bucket. */
export interface AnalyticsCategoryMark extends AnalyticsMarkBase {
  /**
   * Raw field value used to build the linked filter clause. Distinct from
   * `label`, which may be localized or truncated. `null` selects the
   * null bucket via an `is-null` clause.
   */
  readonly filterValue: unknown;
  /** True for a producer-supplied "other"/overflow bucket, which cannot filter. */
  readonly overflow?: boolean;
}

/** One histogram bin over a numeric field. */
export interface AnalyticsHistogramMark extends AnalyticsMarkBase {
  readonly min: number;
  readonly max: number;
  /** Which end of `[min, max]` is inclusive. Mirrors the aggregation spec. */
  readonly boundary: "inclusive-exclusive" | "inclusive";
  /** Zero-based bin index in bucket order. */
  readonly bucket: number;
}

/** One time-series bucket. `start` is inclusive, `end` exclusive. */
export interface AnalyticsTimeSeriesMark extends AnalyticsMarkBase {
  /** ISO-8601 instant, inclusive bucket start. */
  readonly start: string;
  /** ISO-8601 instant, exclusive bucket end. */
  readonly end: string;
}

/** One scalar aggregate ("big number") value. */
export interface AnalyticsAggregateMark extends AnalyticsMarkBase {
  readonly measure: AnalyticsMeasure;
}

/** Any mark, in artifact order. */
export type AnalyticsMark =
  | AnalyticsCategoryMark
  | AnalyticsHistogramMark
  | AnalyticsTimeSeriesMark
  | AnalyticsAggregateMark;

// ── Artifacts ─────────────────────────────────────────────────

interface AnalyticsArtifactBase {
  readonly contractVersion: AnalyticsContractVersion;
  readonly identity: AnalyticsArtifactIdentity;
  readonly provenance: AnalyticsProvenance;
  readonly status: AnalyticsArtifactStatus;
  readonly title?: string;
  /** Required when `status` is `unsupported` or `error`. */
  readonly message?: string;
  readonly nullPolicy: AnalyticsNullPolicy;
  readonly ordering: AnalyticsOrdering;
  readonly measure: AnalyticsMeasure;
  /** Total across all marks when the producer knows it (may exceed the sum). */
  readonly total?: number | null;
}

/** Category / group-by distribution over one dimension field. */
export interface AnalyticsCategoryArtifact extends AnalyticsArtifactBase {
  readonly kind: "category";
  /** Dimension field the marks group by. */
  readonly dimension: string;
  readonly marks: readonly AnalyticsCategoryMark[];
  /** Distinct categories the source reports, when more exist than were returned. */
  readonly distinctCount?: number;
}

/** Binned distribution over one numeric field. */
export interface AnalyticsHistogramArtifact extends AnalyticsArtifactBase {
  readonly kind: "histogram";
  readonly dimension: string;
  readonly marks: readonly AnalyticsHistogramMark[];
  /** Requested bin count. `marks.length` may be smaller for sparse results. */
  readonly bins: number;
  /** Inclusive numeric domain the bins cover. */
  readonly domain?: { readonly min: number; readonly max: number };
}

/** Bucketed series over one temporal field. */
export interface AnalyticsTimeSeriesArtifact extends AnalyticsArtifactBase {
  readonly kind: "time-series";
  readonly dimension: string;
  readonly marks: readonly AnalyticsTimeSeriesMark[];
  readonly interval: AggregationTimeIntervalSpec;
  /** Half-open temporal domain the series covers. */
  readonly window?: AnalyticsTemporalWindow;
}

/** One or more scalar aggregates with no dimension. */
export interface AnalyticsAggregateArtifact extends AnalyticsArtifactBase {
  readonly kind: "aggregate";
  readonly marks: readonly AnalyticsAggregateMark[];
}

/**
 * The accepted analytics artifact. One value, owned by the host, shared by
 * reference with every linked presentation.
 */
export type AnalyticsArtifact =
  | AnalyticsCategoryArtifact
  | AnalyticsHistogramArtifact
  | AnalyticsTimeSeriesArtifact
  | AnalyticsAggregateArtifact;

/** How a newly accepted artifact relates to the one a presentation holds. */
export type AnalyticsUpdateDisposition = "patch" | "invalidate" | "ignore";

/** Explained outcome of comparing two artifacts by identity. */
export interface AnalyticsUpdateDecision {
  readonly disposition: AnalyticsUpdateDisposition;
  /** Stable, machine-readable reason for the disposition. */
  readonly reason:
    | "first-artifact"
    | "same-sequence"
    | "newer-sequence"
    | "stale-sequence"
    | "lineage-changed"
    | "plan-changed"
    | "shape-changed";
  readonly message: string;
}

// ── Interactions (adapter → SDK) ──────────────────────────────

/** Half-open temporal window. `start` inclusive, `end` exclusive, both ISO-8601. */
export interface AnalyticsTemporalWindow {
  readonly start: string;
  readonly end: string;
}

/** Inclusive numeric range brushed on a histogram or aggregate axis. */
export interface AnalyticsNumericRange {
  readonly min: number;
  readonly max: number;
}

interface AnalyticsInteractionBase {
  /** Adapter id that produced the interaction, for provenance and loop-breaking. */
  readonly adapterId: string;
  /** Artifact the interaction was performed against. */
  readonly artifactId: string;
}

/** A mark was activated (click, Enter/Space, or programmatic toggle). */
export interface AnalyticsMarkSelectInteraction extends AnalyticsInteractionBase {
  readonly kind: "mark-select";
  readonly markKeys: readonly string[];
  /** Replace the current mark selection instead of toggling. @default true */
  readonly replace?: boolean;
}

/** A numeric range was brushed (histogram / aggregate axis). */
export interface AnalyticsRangeBrushInteraction extends AnalyticsInteractionBase {
  readonly kind: "range-brush";
  readonly range: AnalyticsNumericRange;
}

/** A temporal window was brushed (time-series axis). */
export interface AnalyticsTemporalBrushInteraction extends AnalyticsInteractionBase {
  readonly kind: "temporal-brush";
  readonly window: AnalyticsTemporalWindow;
}

/** The pointer / focus moved onto a mark, or off every mark (`markKey` absent). */
export interface AnalyticsHoverInteraction extends AnalyticsInteractionBase {
  readonly kind: "hover";
  readonly markKey?: string;
}

/** The user cleared this presentation's contribution to shared state. */
export interface AnalyticsClearInteraction extends AnalyticsInteractionBase {
  readonly kind: "clear";
  /** Limit the clear to one channel. Omit to clear everything this view owns. */
  readonly channel?: "marks" | "range" | "temporal" | "hover";
}

/**
 * Protocol-neutral interaction vocabulary. Chart libraries translate their own
 * events into these; nothing library-specific crosses the seam.
 */
export type AnalyticsInteraction =
  | AnalyticsMarkSelectInteraction
  | AnalyticsRangeBrushInteraction
  | AnalyticsTemporalBrushInteraction
  | AnalyticsHoverInteraction
  | AnalyticsClearInteraction;

// ── Linked state (SDK → adapter) ──────────────────────────────

/**
 * The shared linked state a presentation renders, derived from the exploration
 * context. Hover is included so peer presentations can cross-highlight; it is
 * ephemeral and never persisted into a snapshot.
 */
export interface AnalyticsLinkedState {
  readonly selectedMarkKeys: readonly string[];
  readonly hoveredMarkKey?: string;
  readonly range?: AnalyticsNumericRange;
  readonly temporalWindow?: AnalyticsTemporalWindow;
}

/** Empty linked state. Frozen and safe to share. */
export const EMPTY_ANALYTICS_LINKED_STATE: AnalyticsLinkedState = Object.freeze({
  selectedMarkKeys: Object.freeze([]) as readonly string[],
});

// ── Adapter contract ──────────────────────────────────────────

/** Why an adapter cannot present an artifact. */
export type AnalyticsUnsupportedReason =
  | "kind-not-supported"
  | "contract-version-mismatch"
  | "peer-unavailable"
  | "interaction-not-supported"
  | "artifact-invalid";

/**
 * An adapter's honest answer about one artifact. `supported: false` carries a
 * machine-readable reason so a host can fall back to the accessible table
 * instead of rendering an empty chart.
 */
export type AnalyticsSupportDecision =
  | { readonly supported: true; readonly notes?: readonly string[] }
  | { readonly supported: false; readonly reason: AnalyticsUnsupportedReason; readonly message: string };

/** Interaction channels an adapter can originate. */
export type AnalyticsInteractionChannel = "mark-select" | "range-brush" | "temporal-brush" | "hover" | "clear";

/**
 * Callbacks the host hands to an adapter at mount time. The adapter may call
 * `emit` any number of times; the host owns debouncing and state commits.
 */
export interface AnalyticsPresentationHost {
  /** Publish a protocol-neutral interaction. */
  emit(interaction: AnalyticsInteraction): void;
  /** Report a non-fatal adapter problem without throwing through the renderer. */
  reportWarning?(message: string, detail?: Readonly<Record<string, unknown>>): void;
}

/**
 * A live presentation. `dispose()` must release every peer instance, listener,
 * timer, and observer the adapter created; it is idempotent after success.
 */
export interface AnalyticsPresentationHandle {
  readonly adapterId: string;
  /** The artifact currently rendered. Always the host's reference, never a copy. */
  readonly artifact: AnalyticsArtifact;
  /**
   * A text description equivalent to the visual encoding. Required so every
   * state (including `partial` / `stale` / `unsupported`) stays inspectable by
   * assistive technology and by tests.
   */
  readonly accessibleDescription: string;
  readonly disposed: boolean;
  /**
   * Accept a new artifact. Implementations call
   * `resolveAnalyticsUpdateDisposition` and honour the decision: `patch`
   * updates in place preserving focus, `invalidate` rebuilds, `ignore` is a
   * no-op. Returns the decision it acted on.
   */
  update(artifact: AnalyticsArtifact): AnalyticsUpdateDecision;
  /** Reflect inbound shared state (selection, brush, hover, temporal window). */
  applyLinkedState(state: AnalyticsLinkedState): void;
  dispose(): void;
}

/** Everything an adapter needs to mount, minus anything renderer-specific. */
export interface AnalyticsMountRequest {
  readonly artifact: AnalyticsArtifact;
  readonly host: AnalyticsPresentationHost;
  /** Initial shared state. @default EMPTY_ANALYTICS_LINKED_STATE */
  readonly linkedState?: AnalyticsLinkedState;
  /** BCP-47 tag used for number / date formatting. */
  readonly locale?: string;
  /**
   * Opaque render target. The SDK never inspects it — the default DOM
   * presentation expects an `Element`, a canvas adapter may expect a
   * container, and a headless adapter may ignore it entirely.
   */
  readonly target?: unknown;
}

/**
 * A chart / analytics presentation adapter.
 *
 * Implementations live outside SDK core (a subpath module, an app, or a
 * third-party package) and are registered with the host. `mount` may be
 * asynchronous so an adapter can dynamically import an optional peer.
 */
export interface AnalyticsPresentationAdapter {
  readonly id: string;
  /** Contract version the adapter was written against. */
  readonly contractVersion: string;
  readonly kinds: readonly AnalyticsArtifactKind[];
  readonly channels: readonly AnalyticsInteractionChannel[];
  /** Human-readable name of the underlying library, when there is one. */
  readonly library?: string;
  /**
   * True when the adapter renders into a DOM/canvas target and therefore
   * needs a browser environment. Headless adapters (accessible table, tests)
   * report `false`.
   */
  readonly requiresDom?: boolean;
  /** Cheap, synchronous, side-effect-free support answer. */
  describeSupport(artifact: AnalyticsArtifact): AnalyticsSupportDecision;
  mount(request: AnalyticsMountRequest): AnalyticsPresentationHandle | Promise<AnalyticsPresentationHandle>;
}

// ── Errors ────────────────────────────────────────────────────

/** Machine-readable analytics-contract failure codes. */
export type HonuaAnalyticsErrorCode =
  | "artifact-invalid"
  | "contract-version-mismatch"
  | "row-budget-exceeded"
  | "pushdown-required"
  | "adapter-unsupported"
  | "adapter-not-registered"
  | "duplicate-adapter"
  | "missing-peer"
  | "disposed";

/**
 * Error raised by the analytics contract. Mirrors the deck.gl adapter's
 * `code` + `detail` shape so app-platform error handling stays uniform.
 */
export class HonuaAnalyticsError extends Error {
  public constructor(
    public readonly code: HonuaAnalyticsErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaAnalyticsError";
  }
}

// ── Linked-state binding ──────────────────────────────────────

/** Clause ids the binding owns inside the shared `filters` slice. */
export interface AnalyticsFilterClauseIds {
  /** Clause id for category / mark filtering. */
  readonly marks: string;
  /** Clause id for a brushed numeric range. */
  readonly range: string;
  /** Clause id for a brushed temporal window. */
  readonly temporal: string;
}

/**
 * The inverse of one committed interaction. `undo()` restores exactly the
 * slices the commit touched to exactly their previous values — it never
 * replays a whole snapshot, so a concurrent change from a peer view survives.
 */
export interface AnalyticsLinkCommit {
  readonly interaction: AnalyticsInteraction;
  /** True when the interaction changed shared exploration state. */
  readonly changed: boolean;
  /** Filter clause ids written or cleared by this commit. */
  readonly touchedClauseIds: readonly string[];
  /** True when the commit replaced the shared selection. */
  readonly touchedSelection: boolean;
  /** Linked state after the commit. */
  readonly linkedState: AnalyticsLinkedState;
  /** Deterministically restores the pre-commit values of the touched slices. */
  undo(): void;
}

/** Options for {@link AnalyticsLinkedStateBinding} construction. */
export interface AnalyticsLinkBindingOptions {
  /**
   * Clause-id prefix, so several widgets over one dataset do not collide.
   * @default the artifact's `artifactId`
   */
  readonly clausePrefix?: string;
  /** Explicit clause ids. Overrides `clausePrefix`. */
  readonly clauseIds?: Partial<AnalyticsFilterClauseIds>;
  /**
   * Also publish `select`/`deselect` intents when a clicked mark carries
   * `targets`. @default true
   */
  readonly publishSelection?: boolean;
  /**
   * Replace the shared selection when publishing mark targets.
   * @default true
   */
  readonly replaceSelection?: boolean;
  /**
   * Mirror a brushed temporal window into the shared `filters` slice as a
   * `between` clause on the artifact's temporal dimension. @default true
   */
  readonly publishTemporalFilter?: boolean;
}

/**
 * Two-way bridge between adapter interactions and shared exploration state.
 * The binding owns no chart objects and no data — only clause bookkeeping.
 */
export interface AnalyticsLinkedStateBinding {
  readonly clauseIds: AnalyticsFilterClauseIds;
  /** Current linked state projected from the exploration view. */
  readonly linkedState: AnalyticsLinkedState;
  /** Commit one adapter interaction into shared state. */
  apply(interaction: AnalyticsInteraction): AnalyticsLinkCommit;
  /** Observe linked-state changes (including those made by peer views). */
  subscribe(listener: (state: AnalyticsLinkedState) => void): () => void;
  /** Release subscriptions. Does not clear the clauses it wrote. */
  dispose(): void;
}

/** Filter clause plus the id it is stored under. */
export interface AnalyticsFilterContribution {
  readonly id: string;
  readonly clause: FilterClause;
}
