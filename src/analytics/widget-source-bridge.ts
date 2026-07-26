/**
 * The pushdown acceptance path: turn a `WidgetSource` response into an
 * accepted {@link AnalyticsArtifact}.
 *
 * `createWidgetSource()` already does the work that matters for correctness —
 * it prefers OData `$apply`, `source.queryAggregate`, and typed protocol
 * histogram/time-series adapters, and only falls back to a *bounded* client
 * scan. This module preserves that decision in the artifact instead of
 * flattening it away: `execution` and `serverPushdown` become
 * {@link AnalyticsProvenance}, the widget cache identity becomes artifact
 * identity, and the widget source's prose truncation warnings become
 * structured {@link AnalyticsBounds}.
 *
 * Nothing here fetches or caches. Callers await the widget-source promise
 * themselves, so one awaited response can be accepted once and shared by the
 * map, the table, and every chart presentation.
 *
 * @experimental
 * @module
 */

import type { DegradedReason } from "../contract/types.js";
import type {
  WidgetCategoriesResult,
  WidgetCountResult,
  WidgetFormulaResult,
  WidgetHistogramResult,
  WidgetSourceResponseBase,
  WidgetTimeSeriesResult,
  WidgetTopValuesResult,
} from "../contract/widget-source.js";
import {
  DEFAULT_BUCKET_ORDERING,
  DEFAULT_TIME_ORDERING,
  acceptAggregateArtifact,
  acceptCategoryArtifact,
  acceptHistogramArtifact,
  acceptTimeSeriesArtifact,
  analyticsArtifactIdentity,
  analyticsProvenance,
} from "./artifact.js";
import { HonuaAnalyticsError } from "./types.js";
import type {
  AnalyticsAggregateArtifact,
  AnalyticsAggregateMark,
  AnalyticsCategoryArtifact,
  AnalyticsCategoryMark,
  AnalyticsComputeSite,
  AnalyticsDegradation,
  AnalyticsHistogramArtifact,
  AnalyticsHistogramMark,
  AnalyticsMeasure,
  AnalyticsOrdering,
  AnalyticsProvenance,
  AnalyticsTimeSeriesArtifact,
  AnalyticsTimeSeriesMark,
} from "./types.js";

/**
 * Substring the widget source uses when it bounded a client-side scan. Matched
 * to recover structured truncation from the prose `DegradedReason`, since
 * `Result` has no truncation flag of its own.
 */
const BOUNDED_SCAN_MARKER = "was bounded at";

/** Caller-supplied identity and presentation metadata for the bridge. */
export interface AcceptWidgetArtifactOptions {
  /** Stable lineage id for the widget. Reused across refreshes and deltas. */
  readonly artifactId: string;
  /** Monotonic counter within the lineage. @default 0 */
  readonly sequence?: number;
  /** Source version / etag the response was computed against. */
  readonly sourceVersion?: string;
  /** Plan id / fingerprint when the widget ran through an explained plan. */
  readonly planId?: string;
  readonly planFingerprint?: string;
  readonly title?: string;
  /** RFC-3339 acceptance instant. @default now */
  readonly acceptedAt?: string;
  /** RFC-3339 source-observation instant. @default `acceptedAt` */
  readonly observedAt?: string;
  /** Freshness authority. @default `"cached"` when the result is cacheable, else `"live"` */
  readonly freshnessAuthority?: "live" | "cached" | "replaying" | "stale";
  /** Attribution a presentation must display. */
  readonly attribution?: readonly string[];
  /** Client-fallback row ceiling the widget source was configured with. */
  readonly rowBudget?: number;
  /** Measure metadata overrides (unit, precision, label). */
  readonly measure?: Partial<AnalyticsMeasure>;
  /** Ordering override when the caller sorted the buckets itself. */
  readonly ordering?: AnalyticsOrdering;
  /** Clock injection for status derivation. */
  readonly now?: number;
}

function toDegradation(reason: DegradedReason): AnalyticsDegradation {
  return {
    capability: String(reason.capability),
    reason: reason.reason,
    ...(reason.protocol ? { protocol: String(reason.protocol) } : {}),
    ...(reason.sourceId ? { sourceId: reason.sourceId } : {}),
  };
}

function computeSiteFor(response: WidgetSourceResponseBase): AnalyticsComputeSite {
  // `mixed` means part of the work was pushed down; the reduction that
  // produced the buckets still ran locally, so it is reported as client work.
  return response.execution === "server" ? "server" : "client";
}

/**
 * Project a widget response's execution mode, degradations, and prose
 * truncation warnings into structured provenance.
 */
export function widgetResponseProvenance(
  response: WidgetSourceResponseBase,
  options: AcceptWidgetArtifactOptions,
  marksReturned: number,
): AnalyticsProvenance {
  const degraded = (response.degraded ?? []).map(toDegradation);
  const truncated = degraded.some((entry) => entry.reason.includes(BOUNDED_SCAN_MARKER));
  const notes = [
    `widget-source execution: ${response.execution}`,
    `cache key parts: ${response.cache.keyParts.length}`,
  ];
  if (truncated) {
    notes.push("Marks are incomplete: the widget source bounded its client-side scan.");
  }

  // On the pushdown path the aggregate rows *are* the transfer, so the mark
  // count is the true transferred-row count. On a client or mixed reduction the
  // rows that crossed the wire are the underlying features, a number the widget
  // response does not expose — reporting 5 buckets as "5 rows transferred"
  // after a 10,000-row scan would badly understate the cost, so the field is
  // left absent. Honest absence beats a confident wrong number.
  const pushedDown = response.serverPushdown && response.execution === "server";
  if (!pushedDown) {
    notes.push("Transferred row count is unavailable: the reduction ran outside the source.");
  }

  return analyticsProvenance({
    computedBy: computeSiteFor(response),
    pushdown: response.serverPushdown,
    bounds: {
      truncated,
      ...(options.rowBudget !== undefined ? { rowBudget: options.rowBudget } : {}),
      ...(pushedDown ? { transferredRowCount: marksReturned } : {}),
    },
    degraded,
    ...(options.attribution ? { attribution: options.attribution } : {}),
    notes,
  });
}

function bridgeIdentity(response: WidgetSourceResponseBase, options: AcceptWidgetArtifactOptions) {
  const acceptedAt = options.acceptedAt ?? new Date().toISOString();
  return analyticsArtifactIdentity({
    artifactId: options.artifactId,
    sourceId: response.sourceId,
    ...(options.planId ? { planId: options.planId } : {}),
    ...(options.planFingerprint ? { planFingerprint: options.planFingerprint } : {}),
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    cacheKey: response.cache.cacheKey,
    sequence: options.sequence ?? 0,
    acceptedAt,
    freshness: {
      authority: options.freshnessAuthority ?? (response.cache.resultCacheable ? "cached" : "live"),
      observedAt: options.observedAt ?? acceptedAt,
      ...(response.cache.ttlMs !== undefined
        ? { staleAfter: new Date(Date.parse(options.observedAt ?? acceptedAt) + response.cache.ttlMs).toISOString() }
        : {}),
      ...(options.sourceVersion ? { generation: options.sourceVersion } : {}),
    },
  });
}

function measureFor(options: AcceptWidgetArtifactOptions, fallback: AnalyticsMeasure): AnalyticsMeasure {
  return { ...fallback, ...options.measure };
}

/**
 * Accept a `WidgetCategoriesResult` (or `WidgetTopValuesResult`) as a category
 * artifact. Buckets keep the widget source's order, which is already
 * descending by count.
 */
export function acceptWidgetCategoriesArtifact(
  response: WidgetCategoriesResult | WidgetTopValuesResult,
  options: AcceptWidgetArtifactOptions,
): AnalyticsCategoryArtifact {
  const buckets = response.kind === "top-values" ? response.values : response.buckets;
  const marks: AnalyticsCategoryMark[] = buckets.map((bucket, index) => ({
    key: categoryMarkKey(bucket.value, index),
    label: bucket.label,
    value: bucket.metric ?? bucket.count,
    count: bucket.count,
    filterValue: bucket.value,
  }));
  return acceptCategoryArtifact({
    identity: bridgeIdentity(response, options),
    provenance: widgetResponseProvenance(response, options, marks.length),
    measure: measureFor(options, { field: "*", fn: "count", label: "Count", unit: "count", unitSystem: "count" }),
    ...(options.title ? { title: options.title } : {}),
    nullPolicy: "separate-bucket",
    ordering: options.ordering ?? { by: "value", direction: "desc", tieBreak: "key" },
    dimension: response.field,
    marks,
    now: options.now,
  });
}

/**
 * Stable, type-tagged mark key for a category bucket value. The tag keeps the
 * string `"1"` and the number `1` from colliding, so a mark key round-trips
 * back to exactly one bucket when an interaction is applied.
 */
export function categoryMarkKey(value: unknown, index: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number") return `n:${String(value)}`;
  if (typeof value === "boolean") return `b:${String(value)}`;
  return `i:${index}`;
}

/** Accept a `WidgetHistogramResult` as a histogram artifact. */
export function acceptWidgetHistogramArtifact(
  response: WidgetHistogramResult,
  options: AcceptWidgetArtifactOptions,
): AnalyticsHistogramArtifact {
  const marks: AnalyticsHistogramMark[] = response.bins.map((bin, index) => ({
    key: bin.id,
    label: bin.label,
    value: bin.count,
    count: bin.count,
    min: bin.min,
    max: bin.max,
    boundary: "inclusive-exclusive",
    bucket: index,
  }));
  return acceptHistogramArtifact({
    identity: bridgeIdentity(response, options),
    provenance: widgetResponseProvenance(response, options, marks.length),
    measure: measureFor(options, { field: "*", fn: "count", label: "Count", unit: "count", unitSystem: "count" }),
    ...(options.title ? { title: options.title } : {}),
    nullPolicy: "excluded",
    ordering: options.ordering ?? DEFAULT_BUCKET_ORDERING,
    dimension: response.field,
    marks,
    bins: response.bins.length,
    ...(response.min !== null && response.max !== null ? { domain: { min: response.min, max: response.max } } : {}),
    now: options.now,
  });
}

/** Accept a `WidgetTimeSeriesResult` as a time-series artifact. */
export function acceptWidgetTimeSeriesArtifact(
  response: WidgetTimeSeriesResult,
  options: AcceptWidgetArtifactOptions,
): AnalyticsTimeSeriesArtifact {
  const marks: AnalyticsTimeSeriesMark[] = response.buckets.map((bucket) => ({
    key: bucket.id,
    label: bucket.label,
    value: bucket.metric ?? bucket.count,
    count: bucket.count,
    start: bucket.start,
    end: bucket.end,
  }));
  const metric = response.metric;
  return acceptTimeSeriesArtifact({
    identity: bridgeIdentity(response, options),
    provenance: widgetResponseProvenance(response, options, marks.length),
    measure: measureFor(
      options,
      metric
        ? { field: metric.field, fn: metric.fn, label: metric.alias ?? metric.field }
        : { field: "*", fn: "count", label: "Count", unit: "count", unitSystem: "count" },
    ),
    ...(options.title ? { title: options.title } : {}),
    nullPolicy: "propagated-as-null",
    ordering: options.ordering ?? DEFAULT_TIME_ORDERING,
    dimension: response.field,
    marks,
    interval: response.interval,
    total: response.totalCount,
    now: options.now,
  });
}

/**
 * Accept one or more `WidgetCountResult` / `WidgetFormulaResult` values as a
 * single aggregate artifact. Every response must come from the same source so
 * one identity honestly describes the whole tile.
 */
export function acceptWidgetAggregateArtifact(
  responses: ReadonlyArray<WidgetCountResult | WidgetFormulaResult>,
  options: AcceptWidgetArtifactOptions,
): AnalyticsAggregateArtifact {
  if (responses.length === 0) {
    throw new HonuaAnalyticsError(
      "artifact-invalid",
      "acceptWidgetAggregateArtifact requires at least one count or formula response.",
    );
  }
  const [first] = responses;
  for (const response of responses) {
    if (response.sourceId !== first.sourceId) {
      throw new HonuaAnalyticsError(
        "artifact-invalid",
        "Every response in one aggregate artifact must come from the same source.",
        { expected: first.sourceId, received: response.sourceId },
      );
    }
  }

  const marks: AnalyticsAggregateMark[] = responses.map((response, index) => {
    const measure: AnalyticsMeasure =
      response.kind === "formula"
        ? {
            field: response.metric.field,
            fn: response.metric.fn,
            label: response.metric.alias ?? response.label,
            ...(response.metric.alias ? { alias: response.metric.alias } : {}),
          }
        : { field: "*", fn: "count", label: response.label, unit: "count", unitSystem: "count" };
    return { key: `${response.kind}:${index}`, label: response.label, value: response.value, measure };
  });

  const degraded = responses.flatMap((response) => (response.degraded ?? []).map(toDegradation));
  const truncated = degraded.some((entry) => entry.reason.includes(BOUNDED_SCAN_MARKER));

  return acceptAggregateArtifact({
    identity: bridgeIdentity(first, options),
    provenance: analyticsProvenance({
      computedBy: responses.every((response) => response.execution === "server") ? "server" : "client",
      pushdown: responses.every((response) => response.serverPushdown),
      bounds: {
        truncated,
        ...(options.rowBudget !== undefined ? { rowBudget: options.rowBudget } : {}),
      },
      degraded,
      ...(options.attribution ? { attribution: options.attribution } : {}),
      notes: [`widget-source execution: ${responses.map((response) => response.execution).join(", ")}`],
    }),
    measure: measureFor(options, marks[0].measure),
    ...(options.title ? { title: options.title } : {}),
    nullPolicy: "propagated-as-null",
    marks,
    now: options.now,
  });
}

/**
 * Assert that an artifact's numbers were produced by pushdown.
 *
 * Dashboards that must never pull a dataset to the browser call this on every
 * accepted artifact and surface the rejection instead of rendering. The
 * bounded client fallback is still available — it just has to be an explicit,
 * reviewed choice rather than a silent default.
 */
export function assertAnalyticsPushdown(provenance: AnalyticsProvenance, context?: string): void {
  if (provenance.pushdown && provenance.computedBy !== "client") return;
  throw new HonuaAnalyticsError(
    "pushdown-required",
    `${context ?? "This analytics artifact"} was computed by "${provenance.computedBy}" without server pushdown. Aggregate at the source, use a worker, or opt into the bounded client fallback explicitly.`,
    { computedBy: provenance.computedBy, pushdown: provenance.pushdown, bounds: provenance.bounds },
  );
}
