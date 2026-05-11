/**
 * CARTO-style widget data models over the canonical `Source` contract.
 *
 * The facade keeps dashboard widgets out of protocol-specific request
 * shapes. It prefers server aggregation when the source advertises it, uses
 * OData `$apply` only when metadata advertises Apply support, and stamps
 * structured degradation reasons whenever it must materialize records on the
 * client.
 *
 * @module
 */

import { rewriteWhereToOdataFilter } from "../core/odata.js";
import type { SpatialFilter } from "../core/spatial-filter.js";
import type { HonuaExtent, HonuaTypedFeature } from "../core/types.js";
import type {
  AggregationFn,
  AggregationHistogramBucketSpec,
  AggregationMetric,
  AggregationSpec,
  AggregationTimeIntervalSpec,
  AggregationTimeIntervalUnit,
  AggregationTimeSeriesSpec,
  DegradedReason,
  Protocol,
  Query,
  Result,
  SortSpec,
  Source,
  SourceAnalyticsCapabilities,
  SourceFreshnessContract,
  SourceId,
} from "./types.js";

export const WIDGET_SOURCE_SCHEMA_VERSION = "honua.widget-source.v1" as const;

export type WidgetSourceSchemaVersion = typeof WIDGET_SOURCE_SCHEMA_VERSION;
export type WidgetSourceModelKind =
  | "count"
  | "formula"
  | "categories"
  | "histogram"
  | "time-series"
  | "range"
  | "top-values";
export type WidgetSourceExecutionMode = "server" | "client" | "mixed";
export type WidgetSourceOrderBy =
  | "count-desc"
  | "count-asc"
  | "value-asc"
  | "value-desc"
  | "metric-desc"
  | "metric-asc";
export type WidgetSourceValue = string | number | boolean | null;
export type WidgetSourceFreshnessContract = SourceFreshnessContract;
export type WidgetTimeSeriesIntervalUnit = AggregationTimeIntervalUnit;

export interface WidgetSourceOptions {
  /** Maximum rows a client-side fallback may materialize. @default 10000 */
  readonly maxClientRows?: number;
  /** Default TTL advertised in response cache metadata. */
  readonly ttlMs?: number;
  /** Set true for realtime feeds so widget result caches are disabled by default. */
  readonly realtime?: boolean;
  /** Freshness contract that permits cache reuse for realtime result widgets. */
  readonly freshness?: WidgetSourceFreshnessContract;
  readonly cache?: WidgetSourceCacheHints;
}

export interface WidgetSourceCacheHints {
  readonly metadataCacheable?: boolean;
  readonly resultCacheable?: boolean;
  readonly ttlMs?: number;
  readonly freshness?: WidgetSourceFreshnessContract;
  readonly keyParts?: readonly string[];
}

export interface WidgetSourceProjection {
  readonly filters?: Readonly<Record<string, WidgetSourceFilterClause>>;
  readonly spatialFilter?: SpatialFilter;
  readonly extent?: HonuaExtent;
  readonly orderBy?: readonly SortSpec[];
  readonly pagination?: { readonly offset?: number; readonly limit?: number };
  readonly outFields?: readonly string[];
  readonly grouping?: readonly string[];
  readonly aggregation?: AggregationSpec;
}

export interface WidgetSourceFilterClause {
  readonly field: string;
  readonly operator:
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
  readonly value?: unknown;
  readonly appliesTo?: readonly SourceId[];
}

export interface WidgetSourceRequestBase<T = Record<string, unknown>> {
  readonly query?: Query<T>;
  /** Structural match for `selectLinkedViewQueryProjection(...)`. */
  readonly projection?: WidgetSourceProjection;
  readonly signal?: AbortSignal;
  readonly cache?: WidgetSourceCacheHints;
  readonly maxClientRows?: number;
}

export interface WidgetCountRequest<T = Record<string, unknown>> extends WidgetSourceRequestBase<T> {
  readonly field?: string;
}

export interface WidgetFormulaRequest<T = Record<string, unknown>> extends WidgetSourceRequestBase<T> {
  readonly metric: AggregationMetric;
}

export interface WidgetCategoriesRequest<T = Record<string, unknown>> extends WidgetSourceRequestBase<T> {
  readonly field: string;
  readonly limit?: number;
  readonly orderBy?: WidgetSourceOrderBy;
  readonly metric?: AggregationMetric;
}

export interface WidgetHistogramRequest<T = Record<string, unknown>> extends WidgetSourceRequestBase<T> {
  readonly field: string;
  readonly bins?: number;
  readonly min?: number;
  readonly max?: number;
}

export interface WidgetTimeSeriesInterval {
  readonly unit: WidgetTimeSeriesIntervalUnit;
  readonly step?: number;
  readonly timezone?: string;
}

export interface WidgetTimeSeriesRequest<T = Record<string, unknown>> extends WidgetSourceRequestBase<T> {
  readonly field: string;
  readonly interval?: WidgetTimeSeriesInterval | WidgetTimeSeriesIntervalUnit;
  readonly metric?: AggregationMetric;
  readonly start?: string | number | Date;
  readonly end?: string | number | Date;
  readonly fillMissing?: boolean;
}

export interface WidgetRangeRequest<T = Record<string, unknown>> extends WidgetSourceRequestBase<T> {
  readonly field: string;
}

export interface WidgetTopValuesRequest<T = Record<string, unknown>> extends WidgetSourceRequestBase<T> {
  readonly field: string;
  readonly limit?: number;
  readonly metric?: AggregationMetric;
}

export interface WidgetSourceCacheMetadata {
  readonly metadataCacheable: boolean;
  readonly resultCacheable: boolean;
  readonly cacheKey: string;
  readonly keyParts: readonly string[];
  readonly ttlMs?: number;
  readonly freshness?: WidgetSourceFreshnessContract;
  readonly status: "computed";
}

export interface WidgetSourceResponseBase<K extends WidgetSourceModelKind = WidgetSourceModelKind> {
  readonly schemaVersion: WidgetSourceSchemaVersion;
  readonly kind: K;
  readonly sourceId: SourceId;
  readonly protocol: Protocol;
  readonly execution: WidgetSourceExecutionMode;
  readonly serverPushdown: boolean;
  readonly cache: WidgetSourceCacheMetadata;
  readonly degraded?: readonly DegradedReason[];
}

export interface WidgetCountResult extends WidgetSourceResponseBase<"count"> {
  readonly value: number;
  readonly label: string;
}

export interface WidgetFormulaResult extends WidgetSourceResponseBase<"formula"> {
  readonly value: number | null;
  readonly metric: AggregationMetric;
  readonly label: string;
}

export interface WidgetCategoryBucket {
  readonly value: WidgetSourceValue;
  readonly label: string;
  readonly count: number;
  readonly percent: number;
  readonly metric?: number | null;
}

export interface WidgetCategoriesResult extends WidgetSourceResponseBase<"categories"> {
  readonly field: string;
  readonly buckets: readonly WidgetCategoryBucket[];
}

export interface WidgetHistogramBin {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly label: string;
  readonly count: number;
  readonly percent: number;
}

export interface WidgetHistogramResult extends WidgetSourceResponseBase<"histogram"> {
  readonly field: string;
  readonly min: number | null;
  readonly max: number | null;
  readonly bins: readonly WidgetHistogramBin[];
}

export interface WidgetTimeSeriesBucket {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly label: string;
  readonly count: number;
  readonly percent: number;
  readonly metric?: number | null;
}

export interface WidgetTimeSeriesResult extends WidgetSourceResponseBase<"time-series"> {
  readonly field: string;
  readonly interval: Required<WidgetTimeSeriesInterval>;
  readonly buckets: readonly WidgetTimeSeriesBucket[];
  readonly totalCount: number;
  readonly metric?: AggregationMetric;
}

export interface WidgetRangeResult extends WidgetSourceResponseBase<"range"> {
  readonly field: string;
  readonly min: number | null;
  readonly max: number | null;
  readonly count: number;
}

export interface WidgetTopValueBucket extends WidgetCategoryBucket {}

export interface WidgetTopValuesResult extends WidgetSourceResponseBase<"top-values"> {
  readonly field: string;
  readonly values: readonly WidgetTopValueBucket[];
}

export interface WidgetSource<T = Record<string, unknown>> {
  readonly source: Source<T>;
  count(request?: WidgetCountRequest<T>): Promise<WidgetCountResult>;
  formula(request: WidgetFormulaRequest<T>): Promise<WidgetFormulaResult>;
  categories(request: WidgetCategoriesRequest<T>): Promise<WidgetCategoriesResult>;
  histogram(request: WidgetHistogramRequest<T>): Promise<WidgetHistogramResult>;
  timeSeries(request: WidgetTimeSeriesRequest<T>): Promise<WidgetTimeSeriesResult>;
  range(request: WidgetRangeRequest<T>): Promise<WidgetRangeResult>;
  topValues(request: WidgetTopValuesRequest<T>): Promise<WidgetTopValuesResult>;
}

interface ResolvedWidgetQuery<T> {
  readonly query: Query<T>;
  readonly where?: string;
}

interface OdataApplyAdapter {
  readonly entitySetName: string;
  metadata(options?: { readonly signal?: AbortSignal }): Promise<{
    readonly capabilities?: Readonly<Record<string, { readonly apply?: boolean }>>;
  }>;
  apply(
    transformations: string,
    params?: { readonly filter?: string; readonly signal?: AbortSignal },
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>>; readonly totalCount?: number }>;
}

interface WidgetAnalyticsAdapterMetadata {
  readonly capabilities?: {
    readonly widgets?: SourceAnalyticsCapabilities;
    readonly histogram?: SourceAnalyticsCapabilities["histogram"];
    readonly timeSeries?: SourceAnalyticsCapabilities["timeSeries"];
    readonly freshness?: WidgetSourceFreshnessContract;
  };
}

interface WidgetProtocolAnalyticsAdapter {
  metadata?(options?: { readonly signal?: AbortSignal }): Promise<WidgetAnalyticsAdapterMetadata>;
  histogram?(
    request: Query & {
      readonly aggregation: AggregationSpec & { readonly histogram: AggregationHistogramBucketSpec };
    },
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>>; readonly degraded?: readonly DegradedReason[] }>;
  timeSeries?(
    request: Query & {
      readonly aggregation: AggregationSpec & { readonly timeSeries: AggregationTimeSeriesSpec };
    },
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>>; readonly degraded?: readonly DegradedReason[] }>;
}

const DEFAULT_MAX_CLIENT_ROWS = 10_000;
const DEFAULT_CATEGORY_LIMIT = 25;
const DEFAULT_TOP_VALUES_LIMIT = 10;
const DEFAULT_HISTOGRAM_BINS = 10;
const MAX_HISTOGRAM_BINS = 200;
const DEFAULT_TIME_SERIES_INTERVAL: Required<WidgetTimeSeriesInterval> = { unit: "day", step: 1, timezone: "UTC" };
const MAX_TIME_SERIES_BUCKETS = 500;

export function createWidgetSource<T = Record<string, unknown>>(
  source: Source<T>,
  options: WidgetSourceOptions = {},
): WidgetSource<T> {
  return {
    source,
    count: (request = {}) => count(source, options, request),
    formula: (request) => formula(source, options, request),
    categories: (request) => categories(source, options, request, "categories"),
    histogram: (request) => histogram(source, options, request),
    timeSeries: (request) => timeSeries(source, options, request),
    range: (request) => range(source, options, request),
    topValues: (request) => topValues(source, options, request),
  };
}

export const widgetSource = createWidgetSource;

async function count<T>(
  source: Source<T>,
  options: WidgetSourceOptions,
  request: WidgetCountRequest<T>,
): Promise<WidgetCountResult> {
  throwIfAborted(request.signal);
  const field = request.field ?? "*";
  const alias = "widget_count";
  const resolved = resolveWidgetQuery(source, request);
  const odata = await tryOdataApply(source, request.signal);
  let odataFallbackDegraded: readonly DegradedReason[] = [...(odata.degraded ?? [])];
  if (odata.supported) {
    const attempt = await tryRunOdataApply(
      source,
      odata.adapter,
      `aggregate($count as ${alias})`,
      resolved,
      request.signal,
    );
    if (attempt.rows) {
      const value = numeric(attempt.rows[0]?.[alias]) ?? 0;
      return {
        ...baseResponse(source, "count", "server", request, resolved, options, [
          ...(odata.degraded ?? []),
          ...(attempt.degraded ?? []),
        ]),
        value,
        label: "Count",
      };
    }
    odataFallbackDegraded = [...odataFallbackDegraded, ...(attempt.degraded ?? [])];
  }
  if (source.capabilities.has("queryAggregate")) {
    const result = await source.queryAggregate({
      ...resolved.query,
      aggregation: { metrics: [{ fn: "count", field, alias }] },
      signal: request.signal ?? resolved.query.signal,
    });
    const value = numeric(result.aggregateRows?.[0]?.[alias]) ?? 0;
    return {
      ...baseResponse(source, "count", "server", request, resolved, options, result.degraded),
      value,
      label: "Count",
    };
  }

  const materialized = await materialize(
    source,
    options,
    request,
    resolved,
    [field === "*" ? undefined : field],
    odataFallbackDegraded,
  );
  const value = materialized.result.totalCount ?? materialized.features.length;
  return {
    ...baseResponse(source, "count", "client", request, resolved, options, materialized.degraded),
    value,
    label: "Count",
  };
}

async function formula<T>(
  source: Source<T>,
  options: WidgetSourceOptions,
  request: WidgetFormulaRequest<T>,
): Promise<WidgetFormulaResult> {
  throwIfAborted(request.signal);
  const alias = metricAlias(request.metric);
  const resolved = resolveWidgetQuery(source, request);
  const odata = await tryOdataApply(source, request.signal);
  let odataFallbackDegraded: readonly DegradedReason[] = [...(odata.degraded ?? [])];
  if (odata.supported && odataMetricSupported(request.metric.fn)) {
    const attempt = await tryRunOdataApply(
      source,
      odata.adapter,
      `aggregate(${odataAggregateExpression(request.metric, alias)})`,
      resolved,
      request.signal,
    );
    if (attempt.rows) {
      return {
        ...baseResponse(source, "formula", "server", request, resolved, options, [
          ...(odata.degraded ?? []),
          ...(attempt.degraded ?? []),
        ]),
        value: nullableNumeric(attempt.rows[0]?.[alias]),
        metric: request.metric,
        label: alias,
      };
    }
    odataFallbackDegraded = [...odataFallbackDegraded, ...(attempt.degraded ?? [])];
  }
  if (source.capabilities.has("queryAggregate")) {
    const result = await source.queryAggregate({
      ...resolved.query,
      aggregation: { metrics: [{ ...request.metric, alias }] },
      signal: request.signal ?? resolved.query.signal,
    });
    return {
      ...baseResponse(source, "formula", "server", request, resolved, options, result.degraded),
      value: nullableNumeric(result.aggregateRows?.[0]?.[alias]),
      metric: request.metric,
      label: alias,
    };
  }

  const materialized = await materialize(
    source,
    options,
    request,
    resolved,
    [request.metric.field],
    odataFallbackDegraded,
  );
  return {
    ...baseResponse(source, "formula", "client", request, resolved, options, materialized.degraded),
    value: computeMetric(materialized.features, request.metric),
    metric: request.metric,
    label: alias,
  };
}

async function categories<T>(
  source: Source<T>,
  options: WidgetSourceOptions,
  request: WidgetCategoriesRequest<T>,
  kind: "categories",
): Promise<WidgetCategoriesResult> {
  throwIfAborted(request.signal);
  const limit = boundedLimit(request.limit, DEFAULT_CATEGORY_LIMIT);
  const resolved = resolveWidgetQuery(source, request);
  const metric = request.metric;
  const metricField = metric?.field && metric.field !== "*" ? metric.field : undefined;
  const countAlias = "count";
  const metricValueAlias = metric ? metricAlias(metric, "metric") : undefined;
  const odata = await tryOdataApply(source, request.signal);
  let odataFallbackDegraded: readonly DegradedReason[] = [...(odata.degraded ?? [])];
  if (odata.supported && (!metric || odataMetricSupported(metric.fn))) {
    const aggregateParts = [`$count as ${countAlias}`];
    if (metric && metricValueAlias) aggregateParts.push(odataAggregateExpression(metric, metricValueAlias));
    const attempt = await tryRunOdataApply(
      source,
      odata.adapter,
      `groupby((${request.field}),aggregate(${aggregateParts.join(",")}))`,
      resolved,
      request.signal,
    );
    if (attempt.rows) {
      return {
        ...baseResponse(source, kind, "server", request, resolved, options, [
          ...(odata.degraded ?? []),
          ...(attempt.degraded ?? []),
        ]),
        field: request.field,
        buckets: categoryBucketsFromRows(
          attempt.rows,
          request.field,
          countAlias,
          metricValueAlias,
          request.orderBy,
          limit,
        ),
      };
    }
    odataFallbackDegraded = [...odataFallbackDegraded, ...(attempt.degraded ?? [])];
  }
  if (source.capabilities.has("queryAggregate")) {
    const metrics: AggregationMetric[] = [{ fn: "count", field: "*", alias: countAlias }];
    if (metric && metricValueAlias) metrics.push({ ...metric, alias: metricValueAlias });
    const result = await source.queryAggregate({
      ...resolved.query,
      aggregation: { groupBy: [request.field], metrics },
      signal: request.signal ?? resolved.query.signal,
    });
    return {
      ...baseResponse(source, kind, "server", request, resolved, options, result.degraded),
      field: request.field,
      buckets: categoryBucketsFromRows(
        result.aggregateRows ?? [],
        request.field,
        countAlias,
        metricValueAlias,
        request.orderBy,
        limit,
      ),
    };
  }

  const materialized = await materialize(
    source,
    options,
    request,
    resolved,
    [request.field, metricField],
    odataFallbackDegraded,
  );
  return {
    ...baseResponse(source, kind, "client", request, resolved, options, materialized.degraded),
    field: request.field,
    buckets: categoryBucketsFromFeatures(materialized.features, request.field, metric, request.orderBy, limit),
  };
}

async function topValues<T>(
  source: Source<T>,
  options: WidgetSourceOptions,
  request: WidgetTopValuesRequest<T>,
): Promise<WidgetTopValuesResult> {
  const result = await categories(
    source,
    options,
    {
      ...request,
      limit: request.limit ?? DEFAULT_TOP_VALUES_LIMIT,
      orderBy: request.metric ? "metric-desc" : "count-desc",
    },
    "categories",
  );
  return {
    ...result,
    kind: "top-values",
    values: result.buckets,
  };
}

async function histogram<T>(
  source: Source<T>,
  options: WidgetSourceOptions,
  request: WidgetHistogramRequest<T>,
): Promise<WidgetHistogramResult> {
  throwIfAborted(request.signal);
  const resolved = resolveWidgetQuery(source, request, histogramRangeWhere(request.field, request.min, request.max));
  const histogramSpec = aggregationHistogramSpec(request);
  const countAlias = "count";
  const bucketAlias = histogramSpec.aliases?.bucket ?? "bucket";
  const odata = await tryOdataApply(source, request.signal);
  let fallbackDegraded: readonly DegradedReason[] = [...(odata.degraded ?? [])];
  if (odata.supported) {
    const range = await resolveHistogramRangeFromOdata(source, odata.adapter, request, resolved, request.signal);
    if (range.value) {
      const attempt = await tryRunOdataApply(
        source,
        odata.adapter,
        odataHistogramTransformation(request.field, range.value.min, range.value.max, histogramSpec.bins, bucketAlias),
        resolved,
        request.signal,
      );
      if (attempt.rows) {
        const bins = histogramBinsFromRows(attempt.rows, {
          min: range.value.min,
          max: range.value.max,
          bins: histogramSpec.bins,
          bucketAlias,
          countAlias,
          minAlias: histogramSpec.aliases?.min,
          maxAlias: histogramSpec.aliases?.max,
          labelAlias: histogramSpec.aliases?.label,
        });
        return {
          ...baseResponse(source, "histogram", "server", request, resolved, options, [
            ...(odata.degraded ?? []),
            ...(range.degraded ?? []),
            ...(attempt.degraded ?? []),
          ]),
          field: request.field,
          min: bins.min,
          max: bins.max,
          bins: bins.bins,
        };
      }
      fallbackDegraded = [...fallbackDegraded, ...(range.degraded ?? []), ...(attempt.degraded ?? [])];
    } else {
      fallbackDegraded = [...fallbackDegraded, ...(range.degraded ?? [])];
    }
  }

  const canonical = await tryCanonicalHistogramPushdown(
    source,
    request,
    resolved,
    histogramSpec,
    countAlias,
    bucketAlias,
  );
  if (canonical.rows) {
    const bins = histogramBinsFromRows(canonical.rows, {
      min: request.min ?? canonical.min,
      max: request.max ?? canonical.max,
      bins: histogramSpec.bins,
      bucketAlias,
      countAlias,
      minAlias: histogramSpec.aliases?.min,
      maxAlias: histogramSpec.aliases?.max,
      labelAlias: histogramSpec.aliases?.label,
    });
    return {
      ...baseResponse(source, "histogram", "server", request, resolved, options, canonical.degraded),
      field: request.field,
      min: bins.min,
      max: bins.max,
      bins: bins.bins,
    };
  }
  fallbackDegraded = [...fallbackDegraded, ...(canonical.degraded ?? [])];

  const protocol = await tryProtocolHistogramPushdown(
    source,
    request,
    resolved,
    histogramSpec,
    countAlias,
    bucketAlias,
  );
  if (protocol.rows) {
    const bins = histogramBinsFromRows(protocol.rows, {
      min: request.min ?? protocol.min,
      max: request.max ?? protocol.max,
      bins: histogramSpec.bins,
      bucketAlias,
      countAlias,
      minAlias: histogramSpec.aliases?.min,
      maxAlias: histogramSpec.aliases?.max,
      labelAlias: histogramSpec.aliases?.label,
    });
    return {
      ...baseResponse(source, "histogram", "server", request, resolved, options, protocol.degraded),
      field: request.field,
      min: bins.min,
      max: bins.max,
      bins: bins.bins,
    };
  }
  fallbackDegraded = [...fallbackDegraded, ...(protocol.degraded ?? [])];

  const materialized = await materialize(
    source,
    options,
    request,
    resolved,
    [request.field],
    [
      {
        capability: "queryAggregate",
        reason: "No compatible histogram bucketization pushdown was advertised; values were materialized client-side.",
        protocol: source.descriptor.protocol,
        sourceId: source.descriptor.id,
      },
      ...fallbackDegraded,
    ],
  );
  const bins = histogramBins(materialized.features, request);
  return {
    ...baseResponse(source, "histogram", "client", request, resolved, options, materialized.degraded),
    field: request.field,
    min: bins.min,
    max: bins.max,
    bins: bins.bins,
  };
}

async function timeSeries<T>(
  source: Source<T>,
  options: WidgetSourceOptions,
  request: WidgetTimeSeriesRequest<T>,
): Promise<WidgetTimeSeriesResult> {
  throwIfAborted(request.signal);
  const interval = normalizeTimeSeriesInterval(request.interval);
  const rangeWhere = timeSeriesRangeWhere(request.field, request.start, request.end);
  const resolved = resolveWidgetQuery(source, request, rangeWhere);
  const countAlias = "count";
  const metric = request.metric;
  const metricAliasValue = metric ? metricAlias(metric, "metric") : undefined;
  const timeSeriesSpec = aggregationTimeSeriesSpec(request, interval);
  const startAlias = timeSeriesSpec.aliases?.start ?? "intervalStart";
  const endAlias = timeSeriesSpec.aliases?.end ?? "intervalEnd";
  const odata = await tryOdataApply(source, request.signal);
  let fallbackDegraded: readonly DegradedReason[] = [...(odata.degraded ?? [])];
  if (odata.supported && (!metric || odataMetricSupported(metric.fn))) {
    const aggregateParts = [`$count as ${countAlias}`];
    if (metric && metricAliasValue) aggregateParts.push(odataAggregateExpression(metric, metricAliasValue));
    const attempt = await tryRunOdataApply(
      source,
      odata.adapter,
      `${odataTimeBucketTransformation(request.field, interval, startAlias)}/groupby((${startAlias}),aggregate(${aggregateParts.join(",")}))`,
      resolved,
      request.signal,
    );
    if (attempt.rows) {
      const buckets = timeSeriesBucketsFromRows(attempt.rows, {
        interval,
        startAlias,
        endAlias,
        labelAlias: timeSeriesSpec.aliases?.label,
        countAlias,
        metricAlias: metricAliasValue,
        fillMissing: request.fillMissing,
        start: request.start,
        end: request.end,
      });
      return {
        ...baseResponse(source, "time-series", "server", request, resolved, options, [
          ...(odata.degraded ?? []),
          ...(attempt.degraded ?? []),
        ]),
        field: request.field,
        interval,
        buckets: buckets.buckets,
        totalCount: buckets.totalCount,
        ...(metric ? { metric } : {}),
      };
    }
    fallbackDegraded = [...fallbackDegraded, ...(attempt.degraded ?? [])];
  }

  const canonical = await tryCanonicalTimeSeriesPushdown(
    source,
    request,
    resolved,
    timeSeriesSpec,
    countAlias,
    metricAliasValue,
  );
  if (canonical.rows) {
    const buckets = timeSeriesBucketsFromRows(canonical.rows, {
      interval,
      startAlias,
      endAlias,
      labelAlias: timeSeriesSpec.aliases?.label,
      countAlias,
      metricAlias: metricAliasValue,
      fillMissing: request.fillMissing,
      start: request.start,
      end: request.end,
    });
    return {
      ...baseResponse(source, "time-series", "server", request, resolved, options, canonical.degraded),
      field: request.field,
      interval,
      buckets: buckets.buckets,
      totalCount: buckets.totalCount,
      ...(metric ? { metric } : {}),
    };
  }
  fallbackDegraded = [...fallbackDegraded, ...(canonical.degraded ?? [])];

  const protocol = await tryProtocolTimeSeriesPushdown(
    source,
    request,
    resolved,
    timeSeriesSpec,
    countAlias,
    metricAliasValue,
  );
  if (protocol.rows) {
    const buckets = timeSeriesBucketsFromRows(protocol.rows, {
      interval,
      startAlias,
      endAlias,
      labelAlias: timeSeriesSpec.aliases?.label,
      countAlias,
      metricAlias: metricAliasValue,
      fillMissing: request.fillMissing,
      start: request.start,
      end: request.end,
    });
    return {
      ...baseResponse(source, "time-series", "server", request, resolved, options, protocol.degraded),
      field: request.field,
      interval,
      buckets: buckets.buckets,
      totalCount: buckets.totalCount,
      ...(metric ? { metric } : {}),
    };
  }
  fallbackDegraded = [...fallbackDegraded, ...(protocol.degraded ?? [])];

  const metricField = metric?.field && metric.field !== "*" ? metric.field : undefined;
  const materialized = await materialize(
    source,
    options,
    request,
    resolved,
    [request.field, metricField],
    [
      {
        capability: "queryAggregate",
        reason: "No compatible time-series interval pushdown was advertised; records were materialized client-side.",
        protocol: source.descriptor.protocol,
        sourceId: source.descriptor.id,
      },
      ...fallbackDegraded,
    ],
  );
  const buckets = timeSeriesBucketsFromFeatures(materialized.features, request, interval);
  return {
    ...baseResponse(source, "time-series", "client", request, resolved, options, materialized.degraded),
    field: request.field,
    interval,
    buckets: buckets.buckets,
    totalCount: buckets.totalCount,
    ...(metric ? { metric } : {}),
  };
}

async function range<T>(
  source: Source<T>,
  options: WidgetSourceOptions,
  request: WidgetRangeRequest<T>,
): Promise<WidgetRangeResult> {
  throwIfAborted(request.signal);
  const resolved = resolveWidgetQuery(source, request);
  const minAlias = `min_${request.field}`;
  const maxAlias = `max_${request.field}`;
  const countAlias = "count";
  const odata = await tryOdataApply(source, request.signal);
  let odataFallbackDegraded: readonly DegradedReason[] = [...(odata.degraded ?? [])];
  if (odata.supported) {
    const attempt = await tryRunOdataApply(
      source,
      odata.adapter,
      `aggregate(${request.field} with min as ${minAlias},${request.field} with max as ${maxAlias},$count as ${countAlias})`,
      resolved,
      request.signal,
    );
    if (attempt.rows) {
      const row = attempt.rows[0] ?? {};
      return {
        ...baseResponse(source, "range", "server", request, resolved, options, [
          ...(odata.degraded ?? []),
          ...(attempt.degraded ?? []),
        ]),
        field: request.field,
        min: nullableNumeric(row[minAlias]),
        max: nullableNumeric(row[maxAlias]),
        count: numeric(row[countAlias]) ?? 0,
      };
    }
    odataFallbackDegraded = [...odataFallbackDegraded, ...(attempt.degraded ?? [])];
  }
  if (source.capabilities.has("queryAggregate")) {
    const result = await source.queryAggregate({
      ...resolved.query,
      aggregation: {
        metrics: [
          { fn: "min", field: request.field, alias: minAlias },
          { fn: "max", field: request.field, alias: maxAlias },
          { fn: "count", field: request.field, alias: countAlias },
        ],
      },
      signal: request.signal ?? resolved.query.signal,
    });
    const row = result.aggregateRows?.[0] ?? {};
    return {
      ...baseResponse(source, "range", "server", request, resolved, options, result.degraded),
      field: request.field,
      min: nullableNumeric(row[minAlias]),
      max: nullableNumeric(row[maxAlias]),
      count: numeric(row[countAlias]) ?? 0,
    };
  }

  const materialized = await materialize(source, options, request, resolved, [request.field], odataFallbackDegraded);
  const values = numericValues(materialized.features, request.field);
  return {
    ...baseResponse(source, "range", "client", request, resolved, options, materialized.degraded),
    field: request.field,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    count: values.length,
  };
}

function resolveWidgetQuery<T>(
  source: Source<T>,
  request: WidgetSourceRequestBase<T>,
  extraWhere?: string,
): ResolvedWidgetQuery<T> {
  const projection = request.projection;
  const query = request.query ?? {};
  const projectionWhere = compileProjectionWhere(projection?.filters, source.descriptor.id);
  const where = combineWhere(combineWhere(query.where, projectionWhere), extraWhere);
  const spatialFilter = query.spatialFilter ?? projection?.spatialFilter ?? spatialFilterFromExtent(projection?.extent);
  const out: Query<T> = {
    ...query,
    ...(where ? { where } : {}),
    ...(spatialFilter ? { spatialFilter } : {}),
    ...((query.orderBy ?? projection?.orderBy) ? { orderBy: query.orderBy ?? projection?.orderBy } : {}),
    ...((query.outFields ?? projection?.outFields) ? { outFields: query.outFields ?? projection?.outFields } : {}),
    returnGeometry: false,
    ...((request.signal ?? query.signal) ? { signal: request.signal ?? query.signal } : {}),
  };
  return { query: out, ...(where ? { where } : {}) };
}

function baseResponse<T, K extends WidgetSourceModelKind>(
  source: Source<T>,
  kind: K,
  execution: WidgetSourceExecutionMode,
  request: WidgetSourceRequestBase<T>,
  resolved: ResolvedWidgetQuery<T>,
  options: WidgetSourceOptions,
  degraded: readonly DegradedReason[] | undefined,
): WidgetSourceResponseBase<K> {
  const cache = cacheMetadata(source, kind, request, resolved, options);
  const normalizedDegraded = degraded && degraded.length > 0 ? dedupeDegraded(degraded) : undefined;
  return {
    schemaVersion: WIDGET_SOURCE_SCHEMA_VERSION,
    kind,
    sourceId: source.descriptor.id,
    protocol: source.descriptor.protocol,
    execution,
    serverPushdown: execution === "server",
    cache,
    ...(normalizedDegraded ? { degraded: normalizedDegraded } : {}),
  };
}

async function materialize<T>(
  source: Source<T>,
  options: WidgetSourceOptions,
  request: WidgetSourceRequestBase<T>,
  resolved: ResolvedWidgetQuery<T>,
  fields: ReadonlyArray<string | undefined>,
  extraDegraded: readonly DegradedReason[] = [],
): Promise<{
  readonly result: Result<T>;
  readonly features: readonly HonuaTypedFeature<T>[];
  readonly degraded: readonly DegradedReason[];
}> {
  throwIfAborted(request.signal);
  const maxRows = maxClientRows(options, request);
  const result = await source.queryAll({
    ...resolved.query,
    outFields: mergeOutFields(resolved.query.outFields, fields),
    pagination: { limit: maxRows + 1 },
    returnGeometry: false,
    signal: request.signal ?? resolved.query.signal,
  });
  throwIfAborted(request.signal);
  const features = result.features.slice(0, maxRows);
  const degraded: DegradedReason[] = [
    {
      capability: "queryAggregate",
      reason:
        "Widget source evaluated this model client-side because no compatible server aggregate pushdown is available.",
      protocol: source.descriptor.protocol,
      sourceId: source.descriptor.id,
    },
    ...extraDegraded,
    ...(result.degraded ?? []),
  ];
  if (result.exceededTransferLimit || result.features.length > maxRows) {
    degraded.push({
      capability: "queryAggregate",
      reason: `Widget source client-side scan was bounded at ${maxRows} rows; results may be partial.`,
      protocol: source.descriptor.protocol,
      sourceId: source.descriptor.id,
    });
  }
  return { result, features, degraded: dedupeDegraded(degraded) };
}

async function tryOdataApply<T>(
  source: Source<T>,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly supported: true; readonly adapter: OdataApplyAdapter; readonly degraded?: readonly DegradedReason[] }
  | { readonly supported: false; readonly degraded?: readonly DegradedReason[] }
> {
  const adapter = source.protocol("odata") as OdataApplyAdapter | undefined;
  if (!adapter?.apply || !adapter.metadata) return { supported: false };
  throwIfAborted(signal);
  try {
    const metadata = await adapter.metadata(signal ? { signal } : undefined);
    throwIfAborted(signal);
    if (metadata.capabilities?.[adapter.entitySetName]?.apply === true) {
      return { supported: true, adapter };
    }
    return {
      supported: false,
      degraded: [
        {
          capability: "queryAggregate",
          reason: "OData metadata does not advertise ApplySupported; widget source did not use $apply pushdown.",
          protocol: source.descriptor.protocol,
          sourceId: source.descriptor.id,
        },
      ],
    };
  } catch (error) {
    throwIfAborted(signal);
    return {
      supported: false,
      degraded: [
        {
          capability: "queryAggregate",
          reason: `OData Apply capability negotiation failed: ${error instanceof Error ? error.message : String(error)}`,
          protocol: source.descriptor.protocol,
          sourceId: source.descriptor.id,
        },
      ],
    };
  }
}

async function tryRunOdataApply<T>(
  source: Source<T>,
  adapter: OdataApplyAdapter,
  transformation: string,
  resolved: ResolvedWidgetQuery<T>,
  signal: AbortSignal | undefined,
): Promise<{
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly degraded?: readonly DegradedReason[];
}> {
  if (resolved.query.spatialFilter) {
    return {
      degraded: [
        {
          capability: "queryAggregate",
          reason: "OData $apply pushdown cannot combine with spatialFilter yet; widget source used client fallback.",
          protocol: source.descriptor.protocol,
          sourceId: source.descriptor.id,
        },
      ],
    };
  }
  try {
    const filter = resolved.where ? rewriteWhereToOdataFilter(resolved.where) : undefined;
    const result = await adapter.apply(transformation, {
      ...(filter ? { filter } : {}),
      ...(signal ? { signal } : {}),
    });
    return { rows: result.rows };
  } catch (error) {
    throwIfAborted(signal);
    return {
      degraded: [
        {
          capability: "queryAggregate",
          reason: `OData $apply pushdown failed: ${error instanceof Error ? error.message : String(error)}`,
          protocol: source.descriptor.protocol,
          sourceId: source.descriptor.id,
        },
      ],
    };
  }
}

async function resolveHistogramRangeFromOdata<T>(
  source: Source<T>,
  adapter: OdataApplyAdapter,
  request: WidgetHistogramRequest<T>,
  resolved: ResolvedWidgetQuery<T>,
  signal: AbortSignal | undefined,
): Promise<{
  readonly value?: { readonly min: number; readonly max: number };
  readonly degraded?: readonly DegradedReason[];
}> {
  if (request.min !== undefined && request.max !== undefined) {
    return { value: { min: request.min, max: request.max } };
  }
  const minAlias = "histogram_min";
  const maxAlias = "histogram_max";
  const attempt = await tryRunOdataApply(
    source,
    adapter,
    `aggregate(${request.field} with min as ${minAlias},${request.field} with max as ${maxAlias})`,
    resolved,
    signal,
  );
  if (!attempt.rows) return { degraded: attempt.degraded };
  const row = attempt.rows[0] ?? {};
  const min = request.min ?? numeric(row[minAlias]);
  const max = request.max ?? numeric(row[maxAlias]);
  if (min === undefined || max === undefined) {
    return {
      degraded: [
        ...(attempt.degraded ?? []),
        degradedReason(
          source,
          "OData $apply histogram pushdown could not determine numeric bucket boundaries; widget source used client fallback.",
        ),
      ],
    };
  }
  return { value: { min, max }, degraded: attempt.degraded };
}

async function tryCanonicalHistogramPushdown<T>(
  source: Source<T>,
  request: WidgetHistogramRequest<T>,
  resolved: ResolvedWidgetQuery<T>,
  histogramSpec: AggregationHistogramBucketSpec,
  countAlias: string,
  bucketAlias: string,
): Promise<{
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly min?: number;
  readonly max?: number;
  readonly degraded?: readonly DegradedReason[];
}> {
  if (!source.capabilities.has("queryAggregate")) return {};
  if (!histogramCapabilityCompatible(source.descriptor.analytics?.histogram, request.field, histogramSpec.bins)) {
    return {};
  }
  const minAlias = histogramSpec.aliases?.min ?? "bucketMin";
  const maxAlias = histogramSpec.aliases?.max ?? "bucketMax";
  try {
    const result = await source.queryAggregate({
      ...resolved.query,
      aggregation: {
        metrics: [
          { fn: "count", field: "*", alias: countAlias },
          { fn: "min", field: request.field, alias: minAlias },
          { fn: "max", field: request.field, alias: maxAlias },
        ],
        histogram: { ...histogramSpec, aliases: { ...histogramSpec.aliases, bucket: bucketAlias } },
      },
      signal: request.signal ?? resolved.query.signal,
    });
    const rows = result.aggregateRows ?? [];
    return {
      rows,
      min: rowsMin(rows, minAlias),
      max: rowsMax(rows, maxAlias),
      degraded: result.degraded,
    };
  } catch (error) {
    throwIfAborted(request.signal);
    return {
      degraded: [
        degradedReason(
          source,
          `Canonical histogram queryAggregate pushdown failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

async function tryCanonicalTimeSeriesPushdown<T>(
  source: Source<T>,
  request: WidgetTimeSeriesRequest<T>,
  resolved: ResolvedWidgetQuery<T>,
  timeSeriesSpec: AggregationTimeSeriesSpec,
  countAlias: string,
  metricAliasValue: string | undefined,
): Promise<{
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly degraded?: readonly DegradedReason[];
}> {
  if (!source.capabilities.has("queryAggregate")) return {};
  if (
    !timeSeriesCapabilityCompatible(
      source.descriptor.analytics?.timeSeries,
      request.field,
      timeSeriesSpec.interval.unit,
    )
  ) {
    return {};
  }
  const metrics: AggregationMetric[] = [{ fn: "count", field: "*", alias: countAlias }];
  if (request.metric && metricAliasValue) metrics.push({ ...request.metric, alias: metricAliasValue });
  try {
    const result = await source.queryAggregate({
      ...resolved.query,
      aggregation: {
        metrics,
        timeSeries: timeSeriesSpec,
      },
      signal: request.signal ?? resolved.query.signal,
    });
    return { rows: result.aggregateRows ?? [], degraded: result.degraded };
  } catch (error) {
    throwIfAborted(request.signal);
    return {
      degraded: [
        degradedReason(
          source,
          `Canonical time-series queryAggregate pushdown failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

async function tryProtocolHistogramPushdown<T>(
  source: Source<T>,
  request: WidgetHistogramRequest<T>,
  resolved: ResolvedWidgetQuery<T>,
  histogramSpec: AggregationHistogramBucketSpec,
  countAlias: string,
  bucketAlias: string,
): Promise<{
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly min?: number;
  readonly max?: number;
  readonly degraded?: readonly DegradedReason[];
}> {
  const adapter = widgetAnalyticsAdapter(source);
  if (!adapter?.histogram) return {};
  const metadata = await widgetAnalyticsMetadata(source, adapter, request.signal);
  if (metadata.degraded) return { degraded: metadata.degraded };
  if (!histogramCapabilityCompatible(metadata.analytics?.histogram, request.field, histogramSpec.bins)) return {};
  const minAlias = histogramSpec.aliases?.min ?? "bucketMin";
  const maxAlias = histogramSpec.aliases?.max ?? "bucketMax";
  try {
    const result = await adapter.histogram({
      ...resolved.query,
      aggregation: {
        metrics: [
          { fn: "count", field: "*", alias: countAlias },
          { fn: "min", field: request.field, alias: minAlias },
          { fn: "max", field: request.field, alias: maxAlias },
        ],
        histogram: { ...histogramSpec, aliases: { ...histogramSpec.aliases, bucket: bucketAlias } },
      },
      signal: request.signal ?? resolved.query.signal,
    });
    return {
      rows: result.rows,
      min: rowsMin(result.rows, minAlias),
      max: rowsMax(result.rows, maxAlias),
      degraded: result.degraded,
    };
  } catch (error) {
    throwIfAborted(request.signal);
    return {
      degraded: [
        degradedReason(
          source,
          `Protocol histogram pushdown failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

async function tryProtocolTimeSeriesPushdown<T>(
  source: Source<T>,
  request: WidgetTimeSeriesRequest<T>,
  resolved: ResolvedWidgetQuery<T>,
  timeSeriesSpec: AggregationTimeSeriesSpec,
  countAlias: string,
  metricAliasValue: string | undefined,
): Promise<{
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly degraded?: readonly DegradedReason[];
}> {
  const adapter = widgetAnalyticsAdapter(source);
  if (!adapter?.timeSeries) return {};
  const metadata = await widgetAnalyticsMetadata(source, adapter, request.signal);
  if (metadata.degraded) return { degraded: metadata.degraded };
  if (!timeSeriesCapabilityCompatible(metadata.analytics?.timeSeries, request.field, timeSeriesSpec.interval.unit)) {
    return {};
  }
  const metrics: AggregationMetric[] = [{ fn: "count", field: "*", alias: countAlias }];
  if (request.metric && metricAliasValue) metrics.push({ ...request.metric, alias: metricAliasValue });
  try {
    const result = await adapter.timeSeries({
      ...resolved.query,
      aggregation: { metrics, timeSeries: timeSeriesSpec },
      signal: request.signal ?? resolved.query.signal,
    });
    return { rows: result.rows, degraded: result.degraded };
  } catch (error) {
    throwIfAborted(request.signal);
    return {
      degraded: [
        degradedReason(
          source,
          `Protocol time-series pushdown failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

function aggregationHistogramSpec<T>(request: WidgetHistogramRequest<T>): AggregationHistogramBucketSpec {
  return {
    field: request.field,
    bins: clampInteger(request.bins ?? DEFAULT_HISTOGRAM_BINS, 1, MAX_HISTOGRAM_BINS),
    ...(request.min !== undefined ? { min: request.min } : {}),
    ...(request.max !== undefined ? { max: request.max } : {}),
    boundary: "inclusive-exclusive",
    aliases: {
      bucket: "bucket",
      min: "bucketMin",
      max: "bucketMax",
      label: "label",
    },
  };
}

function aggregationTimeSeriesSpec<T>(
  request: WidgetTimeSeriesRequest<T>,
  interval: Required<WidgetTimeSeriesInterval>,
): AggregationTimeSeriesSpec {
  return {
    field: request.field,
    interval,
    ...(request.start !== undefined ? { start: serializeTimeValue(request.start) } : {}),
    ...(request.end !== undefined ? { end: serializeTimeValue(request.end) } : {}),
    aliases: {
      start: "intervalStart",
      end: "intervalEnd",
      label: "label",
    },
  };
}

function odataHistogramTransformation(
  field: string,
  min: number,
  max: number,
  bins: number,
  bucketAlias: string,
): string {
  const width = max === min ? 1 : (max - min) / bins;
  return `compute(floor((${field} sub ${formatOdataNumber(min)}) div ${formatOdataNumber(width)}) as ${bucketAlias})/groupby((${bucketAlias}),aggregate($count as count))`;
}

function odataTimeBucketTransformation(
  field: string,
  interval: Required<WidgetTimeSeriesInterval>,
  alias: string,
): string {
  return `compute(honua.timeBucket(${field},'${interval.unit}',${interval.step},'${interval.timezone.replace(/'/g, "''")}') as ${alias})`;
}

function formatOdataNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function widgetAnalyticsAdapter<T>(source: Source<T>): WidgetProtocolAnalyticsAdapter | undefined {
  const protocol = source.protocol as unknown as (kind: string) => unknown;
  const candidate = protocol(source.descriptor.protocol);
  if (!candidate || typeof candidate !== "object") return undefined;
  const adapter = candidate as WidgetProtocolAnalyticsAdapter;
  if (typeof adapter.histogram !== "function" && typeof adapter.timeSeries !== "function") return undefined;
  return adapter;
}

async function widgetAnalyticsMetadata<T>(
  source: Source<T>,
  adapter: WidgetProtocolAnalyticsAdapter,
  signal: AbortSignal | undefined,
): Promise<{
  readonly analytics?: SourceAnalyticsCapabilities;
  readonly degraded?: readonly DegradedReason[];
}> {
  if (!adapter.metadata) {
    return {
      degraded: [
        degradedReason(
          source,
          "Protocol widget analytics adapter did not expose capability metadata; widget source used client fallback.",
        ),
      ],
    };
  }
  try {
    const metadata = await adapter.metadata(signal ? { signal } : undefined);
    const capabilities = metadata.capabilities;
    const analytics = capabilities?.widgets ?? {
      histogram: capabilities?.histogram,
      timeSeries: capabilities?.timeSeries,
      freshness: capabilities?.freshness,
    };
    return { analytics };
  } catch (error) {
    throwIfAborted(signal);
    return {
      degraded: [
        degradedReason(
          source,
          `Protocol widget analytics capability negotiation failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

function histogramCapabilityCompatible(
  capability: SourceAnalyticsCapabilities["histogram"] | undefined,
  field: string,
  bins: number,
): boolean {
  if (capability === true) return true;
  if (capability === undefined || capability === false) return false;
  if (capability.fields && !capability.fields.includes(field)) return false;
  return capability.maxBins === undefined || bins <= capability.maxBins;
}

function timeSeriesCapabilityCompatible(
  capability: SourceAnalyticsCapabilities["timeSeries"] | undefined,
  field: string,
  interval: WidgetTimeSeriesIntervalUnit,
): boolean {
  if (capability === true) return true;
  if (capability === undefined || capability === false) return false;
  if (capability.fields && !capability.fields.includes(field)) return false;
  return !capability.intervals || capability.intervals.includes(interval);
}

function degradedReason<T>(source: Source<T>, reason: string): DegradedReason {
  return {
    capability: "queryAggregate",
    reason,
    protocol: source.descriptor.protocol,
    sourceId: source.descriptor.id,
  };
}

function compileProjectionWhere(
  filters: Readonly<Record<string, WidgetSourceFilterClause>> | undefined,
  sourceId: SourceId,
): string | undefined {
  const parts: string[] = [];
  for (const clause of Object.values(filters ?? {})) {
    if (clause.appliesTo && clause.appliesTo.length > 0 && !clause.appliesTo.includes(sourceId)) continue;
    const compiled = compileClause(clause);
    if (compiled) parts.push(compiled);
  }
  return parts.length > 0 ? parts.map((part) => `(${part})`).join(" AND ") : undefined;
}

function compileClause(clause: WidgetSourceFilterClause): string | undefined {
  const field = clause.field;
  switch (clause.operator) {
    case "=":
      return `${field} = ${literal(clause.value)}`;
    case "!=":
      return `${field} <> ${literal(clause.value)}`;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return `${field} ${clause.operator} ${literal(clause.value)}`;
    case "in":
    case "not-in": {
      if (!Array.isArray(clause.value) || clause.value.length === 0) return undefined;
      const values = clause.value.map(literal).join(", ");
      return `${field} ${clause.operator === "not-in" ? "NOT " : ""}IN (${values})`;
    }
    case "between": {
      if (!Array.isArray(clause.value) || clause.value.length < 2) return undefined;
      return `${field} BETWEEN ${literal(clause.value[0])} AND ${literal(clause.value[1])}`;
    }
    case "like":
      return `${field} LIKE ${literal(clause.value)}`;
    case "is-null":
      return `${field} IS NULL`;
    case "is-not-null":
      return `${field} IS NOT NULL`;
  }
}

function combineWhere(left: string | undefined, right: string | undefined): string | undefined {
  if (left && right) return `(${left}) AND (${right})`;
  return left || right || undefined;
}

function spatialFilterFromExtent(extent: HonuaExtent | undefined): SpatialFilter | undefined {
  if (!extent) return undefined;
  return {
    geometryType: "esriGeometryEnvelope",
    geometry: {
      xmin: extent.xmin,
      ymin: extent.ymin,
      xmax: extent.xmax,
      ymax: extent.ymax,
      ...(extent.spatialReference ? { spatialReference: extent.spatialReference } : {}),
    },
    spatialRel: "esriSpatialRelIntersects",
  };
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function categoryBucketsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  field: string,
  countAlias: string,
  metricAliasValue: string | undefined,
  orderBy: WidgetSourceOrderBy | undefined,
  limit: number,
): readonly WidgetCategoryBucket[] {
  const total = rows.reduce((sum, row) => sum + (numeric(row[countAlias]) ?? 0), 0);
  return sortBuckets(
    rows.map((row) => {
      const count = numeric(row[countAlias]) ?? 0;
      const value = normalizeBucketValue(row[field]);
      return {
        value,
        label: label(value),
        count,
        percent: total > 0 ? count / total : 0,
        ...(metricAliasValue ? { metric: nullableNumeric(row[metricAliasValue]) } : {}),
      };
    }),
    orderBy ?? "count-desc",
  ).slice(0, limit);
}

function categoryBucketsFromFeatures<T>(
  features: readonly HonuaTypedFeature<T>[],
  field: string,
  metric: AggregationMetric | undefined,
  orderBy: WidgetSourceOrderBy | undefined,
  limit: number,
): readonly WidgetCategoryBucket[] {
  const buckets = new Map<string, { value: WidgetSourceValue; count: number; values: number[] }>();
  for (const feature of features) {
    const value = normalizeBucketValue(readField(feature.attributes, field));
    const key = String(value);
    const entry = buckets.get(key) ?? { value, count: 0, values: [] };
    entry.count += 1;
    const metricValue = metric ? numeric(readField(feature.attributes, metric.field)) : undefined;
    if (metricValue !== undefined) entry.values.push(metricValue);
    buckets.set(key, entry);
  }
  const total = features.length;
  return sortBuckets(
    [...buckets.values()].map((entry) => ({
      value: entry.value,
      label: label(entry.value),
      count: entry.count,
      percent: total > 0 ? entry.count / total : 0,
      ...(metric ? { metric: computeNumbersMetric(entry.values, metric.fn) } : {}),
    })),
    orderBy ?? (metric ? "metric-desc" : "count-desc"),
  ).slice(0, limit);
}

function histogramBinsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: {
    readonly min?: number;
    readonly max?: number;
    readonly bins: number;
    readonly bucketAlias: string;
    readonly countAlias: string;
    readonly minAlias?: string;
    readonly maxAlias?: string;
    readonly labelAlias?: string;
  },
): { readonly min: number | null; readonly max: number | null; readonly bins: readonly WidgetHistogramBin[] } {
  const min = options.min ?? (options.minAlias ? rowsMin(rows, options.minAlias) : undefined);
  const max = options.max ?? (options.maxAlias ? rowsMax(rows, options.maxAlias) : undefined);
  if (min === undefined || max === undefined) return { min: null, max: null, bins: [] };
  const count = clampInteger(options.bins, 1, MAX_HISTOGRAM_BINS);
  const bins = emptyHistogramBins(min, max, count);
  const width = max === min ? 1 : (max - min) / count;
  for (const row of rows) {
    const rowCount = numeric(row[options.countAlias]) ?? 0;
    let index = numeric(row[options.bucketAlias]);
    if (index === undefined && options.minAlias) {
      const rowMin = numeric(row[options.minAlias]);
      if (rowMin !== undefined) index = max === min ? 0 : Math.floor((rowMin - min) / width);
    }
    if (index === undefined) continue;
    const bucketIndex = Math.max(0, Math.min(count - 1, Math.trunc(index)));
    const bin = bins[bucketIndex];
    const rowMin = options.minAlias ? numeric(row[options.minAlias]) : undefined;
    const rowMax = options.maxAlias ? numeric(row[options.maxAlias]) : undefined;
    const rowLabel = options.labelAlias ? row[options.labelAlias] : undefined;
    bins[bucketIndex] = {
      ...bin,
      ...(rowMin !== undefined ? { min: rowMin } : {}),
      ...(rowMax !== undefined ? { max: rowMax } : {}),
      ...(typeof rowLabel === "string" && rowLabel !== "" ? { label: rowLabel } : {}),
      count: bin.count + rowCount,
    };
  }
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  return {
    min,
    max,
    bins: bins.map((bin) => ({ ...bin, percent: total > 0 ? bin.count / total : 0 })),
  };
}

function emptyHistogramBins(min: number, max: number, count: number): WidgetHistogramBin[] {
  const width = max === min ? 1 : (max - min) / count;
  return Array.from({ length: count }, (_, index) => {
    const binMin = min + index * width;
    const binMax = index === count - 1 ? max : min + (index + 1) * width;
    return {
      id: `${index}`,
      min: binMin,
      max: binMax,
      label: `${formatNumber(binMin)} - ${formatNumber(binMax)}`,
      count: 0,
      percent: 0,
    };
  });
}

function histogramBins<T>(
  features: readonly HonuaTypedFeature<T>[],
  request: WidgetHistogramRequest<T>,
): { readonly min: number | null; readonly max: number | null; readonly bins: readonly WidgetHistogramBin[] } {
  const values = numericValues(features, request.field);
  const min = request.min ?? (values.length > 0 ? Math.min(...values) : undefined);
  const max = request.max ?? (values.length > 0 ? Math.max(...values) : undefined);
  if (min === undefined || max === undefined) return { min: null, max: null, bins: [] };
  const count = clampInteger(request.bins ?? DEFAULT_HISTOGRAM_BINS, 1, MAX_HISTOGRAM_BINS);
  const width = max === min ? 1 : (max - min) / count;
  const bins = emptyHistogramBins(min, max, count);
  for (const value of values) {
    if (value < min || value > max) continue;
    const index = max === min ? 0 : Math.min(count - 1, Math.floor((value - min) / width));
    bins[index] = { ...bins[index], count: bins[index].count + 1 };
  }
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  return {
    min,
    max,
    bins: bins.map((bin) => ({ ...bin, percent: total > 0 ? bin.count / total : 0 })),
  };
}

function timeSeriesBucketsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: {
    readonly interval: Required<WidgetTimeSeriesInterval>;
    readonly startAlias: string;
    readonly endAlias: string;
    readonly labelAlias?: string;
    readonly countAlias: string;
    readonly metricAlias?: string;
    readonly fillMissing?: boolean;
    readonly start?: string | number | Date;
    readonly end?: string | number | Date;
  },
): { readonly buckets: readonly WidgetTimeSeriesBucket[]; readonly totalCount: number } {
  const buckets: TimeSeriesWorkingBucket[] = [];
  for (const row of rows) {
    const start = dateFromValue(row[options.startAlias]);
    if (!start) continue;
    const end = dateFromValue(row[options.endAlias]) ?? addInterval(start, options.interval);
    const count = numeric(row[options.countAlias]) ?? 0;
    const labelValue = options.labelAlias ? row[options.labelAlias] : undefined;
    buckets.push({
      start,
      end,
      label:
        typeof labelValue === "string" && labelValue !== "" ? labelValue : formatTimeLabel(start, options.interval),
      count,
      ...(options.metricAlias ? { metric: nullableNumeric(row[options.metricAlias]) } : {}),
    });
  }
  buckets.sort((a, b) => a.start.getTime() - b.start.getTime());
  return finalizeTimeSeriesBuckets(
    options.fillMissing ? fillMissingTimeBuckets(buckets, options.interval, options.start, options.end) : buckets,
  );
}

function timeSeriesBucketsFromFeatures<T>(
  features: readonly HonuaTypedFeature<T>[],
  request: WidgetTimeSeriesRequest<T>,
  interval: Required<WidgetTimeSeriesInterval>,
): { readonly buckets: readonly WidgetTimeSeriesBucket[]; readonly totalCount: number } {
  const startLimit = dateFromValue(request.start);
  const endLimit = dateFromValue(request.end);
  const byStart = new Map<string, TimeSeriesWorkingBucket & { readonly values: number[] }>();
  for (const feature of features) {
    const date = dateFromValue(readField(feature.attributes, request.field));
    if (!date) continue;
    if (startLimit && date < startLimit) continue;
    if (endLimit && date >= endLimit) continue;
    const start = truncateDate(date, interval);
    const end = addInterval(start, interval);
    const key = start.toISOString();
    const existing = byStart.get(key) ?? {
      start,
      end,
      label: formatTimeLabel(start, interval),
      count: 0,
      metric: undefined,
      values: [],
    };
    existing.count += 1;
    if (request.metric && request.metric.fn !== "count") {
      const value = numeric(readField(feature.attributes, request.metric.field));
      if (value !== undefined) existing.values.push(value);
    }
    byStart.set(key, existing);
  }
  const buckets = [...byStart.values()]
    .map((bucket) => ({
      start: bucket.start,
      end: bucket.end,
      label: bucket.label,
      count: bucket.count,
      metric: request.metric
        ? request.metric.fn === "count"
          ? bucket.count
          : computeNumbersMetric(bucket.values, request.metric.fn)
        : undefined,
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return finalizeTimeSeriesBuckets(
    request.fillMissing ? fillMissingTimeBuckets(buckets, interval, request.start, request.end) : buckets,
  );
}

interface TimeSeriesWorkingBucket {
  readonly start: Date;
  readonly end: Date;
  readonly label: string;
  count: number;
  readonly metric?: number | null;
}

function finalizeTimeSeriesBuckets(buckets: readonly TimeSeriesWorkingBucket[]): {
  readonly buckets: readonly WidgetTimeSeriesBucket[];
  readonly totalCount: number;
} {
  const totalCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  return {
    totalCount,
    buckets: buckets.map((bucket) => ({
      id: bucket.start.toISOString(),
      start: bucket.start.toISOString(),
      end: bucket.end.toISOString(),
      label: bucket.label,
      count: bucket.count,
      percent: totalCount > 0 ? bucket.count / totalCount : 0,
      ...(bucket.metric !== undefined ? { metric: bucket.metric } : {}),
    })),
  };
}

function fillMissingTimeBuckets(
  buckets: readonly TimeSeriesWorkingBucket[],
  interval: Required<WidgetTimeSeriesInterval>,
  startValue: string | number | Date | undefined,
  endValue: string | number | Date | undefined,
): readonly TimeSeriesWorkingBucket[] {
  if (buckets.length === 0 && (startValue === undefined || endValue === undefined)) return buckets;
  const byStart = new Map(buckets.map((bucket) => [bucket.start.toISOString(), bucket]));
  const first = dateFromValue(startValue) ?? buckets[0]?.start;
  const lastEnd = dateFromValue(endValue) ?? buckets.at(-1)?.end;
  if (!first || !lastEnd || first >= lastEnd) return buckets;
  const out: TimeSeriesWorkingBucket[] = [];
  let cursor = truncateDate(first, interval);
  while (cursor < lastEnd && out.length < MAX_TIME_SERIES_BUCKETS) {
    const key = cursor.toISOString();
    const existing = byStart.get(key);
    if (existing) {
      out.push(existing);
    } else {
      out.push({
        start: new Date(cursor.getTime()),
        end: addInterval(cursor, interval),
        label: formatTimeLabel(cursor, interval),
        count: 0,
        metric: null,
      });
    }
    cursor = addInterval(cursor, interval);
  }
  return out;
}

function computeMetric<T>(features: readonly HonuaTypedFeature<T>[], metric: AggregationMetric): number | null {
  if (metric.fn === "count") return features.length;
  return computeNumbersMetric(numericValues(features, metric.field), metric.fn);
}

function computeNumbersMetric(values: readonly number[], fn: AggregationFn): number | null {
  if (fn === "count") return values.length;
  if (values.length === 0) return null;
  switch (fn) {
    case "sum":
      return values.reduce((sum, value) => sum + value, 0);
    case "avg":
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "stddev": {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      return Math.sqrt(variance);
    }
    case "var": {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    }
  }
}

function numericValues<T>(features: readonly HonuaTypedFeature<T>[], field: string): number[] {
  const values: number[] = [];
  for (const feature of features) {
    const value = numeric(readField(feature.attributes, field));
    if (value !== undefined) values.push(value);
  }
  return values;
}

function rowsMin(rows: ReadonlyArray<Record<string, unknown>>, field: string): number | undefined {
  const values = rows.map((row) => numeric(row[field])).filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.min(...values) : undefined;
}

function rowsMax(rows: ReadonlyArray<Record<string, unknown>>, field: string): number | undefined {
  const values = rows.map((row) => numeric(row[field])).filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function normalizeTimeSeriesInterval(
  interval: WidgetTimeSeriesRequest["interval"],
): Required<WidgetTimeSeriesInterval> {
  if (!interval) return DEFAULT_TIME_SERIES_INTERVAL;
  if (typeof interval === "string") return { unit: interval, step: 1, timezone: "UTC" };
  return {
    unit: interval.unit,
    step: clampInteger(interval.step ?? 1, 1, 10_000),
    timezone: interval.timezone ?? "UTC",
  };
}

function histogramRangeWhere(field: string, min: number | undefined, max: number | undefined): string | undefined {
  const parts: string[] = [];
  if (min !== undefined) parts.push(`${field} >= ${literal(min)}`);
  if (max !== undefined) parts.push(`${field} <= ${literal(max)}`);
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

function timeSeriesRangeWhere<T>(
  field: string,
  start: WidgetTimeSeriesRequest<T>["start"],
  end: WidgetTimeSeriesRequest<T>["end"],
): string | undefined {
  const parts: string[] = [];
  if (start !== undefined) parts.push(`${field} >= ${literal(serializeTimeValue(start))}`);
  if (end !== undefined) parts.push(`${field} < ${literal(serializeTimeValue(end))}`);
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

function serializeTimeValue(value: string | number | Date): string | number {
  return value instanceof Date ? value.toISOString() : value;
}

function dateFromValue(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function truncateDate(date: Date, interval: Required<WidgetTimeSeriesInterval>): Date {
  const out = new Date(date.getTime());
  const step = interval.step;
  switch (interval.unit) {
    case "minute":
      out.setUTCSeconds(0, 0);
      out.setUTCMinutes(Math.floor(out.getUTCMinutes() / step) * step);
      return out;
    case "hour":
      out.setUTCMinutes(0, 0, 0);
      out.setUTCHours(Math.floor(out.getUTCHours() / step) * step);
      return out;
    case "day":
      return new Date(
        Math.floor(Date.UTC(out.getUTCFullYear(), out.getUTCMonth(), out.getUTCDate()) / dayMs(step)) * dayMs(step),
      );
    case "week": {
      const day = out.getUTCDay();
      const mondayOffset = day === 0 ? 6 : day - 1;
      const monday = Date.UTC(out.getUTCFullYear(), out.getUTCMonth(), out.getUTCDate() - mondayOffset);
      return new Date(Math.floor(monday / dayMs(step * 7)) * dayMs(step * 7));
    }
    case "month":
      return new Date(Date.UTC(out.getUTCFullYear(), Math.floor(out.getUTCMonth() / step) * step, 1));
    case "quarter": {
      const months = step * 3;
      return new Date(Date.UTC(out.getUTCFullYear(), Math.floor(out.getUTCMonth() / months) * months, 1));
    }
    case "year":
      return new Date(Date.UTC(Math.floor(out.getUTCFullYear() / step) * step, 0, 1));
  }
}

function addInterval(date: Date, interval: Required<WidgetTimeSeriesInterval>): Date {
  const out = new Date(date.getTime());
  switch (interval.unit) {
    case "minute":
      out.setUTCMinutes(out.getUTCMinutes() + interval.step);
      return out;
    case "hour":
      out.setUTCHours(out.getUTCHours() + interval.step);
      return out;
    case "day":
      out.setUTCDate(out.getUTCDate() + interval.step);
      return out;
    case "week":
      out.setUTCDate(out.getUTCDate() + interval.step * 7);
      return out;
    case "month":
      out.setUTCMonth(out.getUTCMonth() + interval.step);
      return out;
    case "quarter":
      out.setUTCMonth(out.getUTCMonth() + interval.step * 3);
      return out;
    case "year":
      out.setUTCFullYear(out.getUTCFullYear() + interval.step);
      return out;
  }
}

function dayMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

function formatTimeLabel(date: Date, interval: Required<WidgetTimeSeriesInterval>): string {
  const iso = date.toISOString();
  if (interval.unit === "year") return iso.slice(0, 4);
  if (interval.unit === "quarter") return `${iso.slice(0, 4)} Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  if (interval.unit === "month") return iso.slice(0, 7);
  if (interval.unit === "day" || interval.unit === "week") return iso.slice(0, 10);
  if (interval.unit === "hour") return `${iso.slice(0, 13)}:00Z`;
  return `${iso.slice(0, 16)}Z`;
}

function sortBuckets<
  T extends { readonly value: WidgetSourceValue; readonly count: number; readonly metric?: number | null },
>(buckets: readonly T[], orderBy: WidgetSourceOrderBy): T[] {
  return [...buckets].sort((a, b) => {
    switch (orderBy) {
      case "count-asc":
        return a.count - b.count || compareBucketValue(a.value, b.value);
      case "value-asc":
        return compareBucketValue(a.value, b.value);
      case "value-desc":
        return compareBucketValue(b.value, a.value);
      case "metric-asc":
        return compareNullableNumber(a.metric, b.metric) || compareBucketValue(a.value, b.value);
      case "metric-desc":
        return compareNullableNumber(b.metric, a.metric) || compareBucketValue(a.value, b.value);
      case "count-desc":
        return b.count - a.count || compareBucketValue(a.value, b.value);
    }
  });
}

function compareBucketValue(a: WidgetSourceValue, b: WidgetSourceValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return label(a).localeCompare(label(b));
}

function compareNullableNumber(a: number | null | undefined, b: number | null | undefined): number {
  const left = a ?? Number.NEGATIVE_INFINITY;
  const right = b ?? Number.NEGATIVE_INFINITY;
  return left - right;
}

function readField(attributes: unknown, field: string): unknown {
  if (!attributes || typeof attributes !== "object") return undefined;
  return (attributes as Record<string, unknown>)[field];
}

function normalizeBucketValue(value: unknown): WidgetSourceValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (value === undefined) return null;
  return String(value);
}

function label(value: WidgetSourceValue): string {
  return value === null ? "Null" : String(value);
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function nullableNumeric(value: unknown): number | null {
  return numeric(value) ?? null;
}

function metricAlias(metric: AggregationMetric, prefix = "widget"): string {
  const field = metric.field === "*" ? "all" : metric.field.replace(/\W+/g, "_");
  return metric.alias ?? `${prefix}_${metric.fn}_${field}`;
}

function odataAggregateExpression(metric: AggregationMetric, alias: string): string {
  if (metric.fn === "count") return `$count as ${alias}`;
  return `${metric.field} with ${odataMetricName(metric.fn)} as ${alias}`;
}

function odataMetricSupported(fn: AggregationFn): boolean {
  return fn === "count" || fn === "sum" || fn === "avg" || fn === "min" || fn === "max";
}

function odataMetricName(fn: AggregationFn): string {
  return fn === "avg" ? "average" : fn;
}

function mergeOutFields(
  existing: readonly string[] | undefined,
  fields: ReadonlyArray<string | undefined>,
): readonly string[] | undefined {
  const out = new Set(existing ?? []);
  for (const field of fields) {
    if (field && field !== "*") out.add(field);
  }
  return out.size > 0 ? [...out] : existing;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return clampInteger(value ?? fallback, 1, 500);
}

function maxClientRows(options: WidgetSourceOptions, request: WidgetSourceRequestBase): number {
  return clampInteger(request.maxClientRows ?? options.maxClientRows ?? DEFAULT_MAX_CLIENT_ROWS, 1, 100_000);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function cacheMetadata<T>(
  source: Source<T>,
  kind: WidgetSourceModelKind,
  request: WidgetSourceRequestBase<T>,
  resolved: ResolvedWidgetQuery<T>,
  options: WidgetSourceOptions,
): WidgetSourceCacheMetadata {
  const hints = { ...(options.cache ?? {}), ...(request.cache ?? {}) };
  const ttlMs = hints.ttlMs ?? options.ttlMs;
  const freshness = hints.freshness ?? options.freshness ?? source.descriptor.analytics?.freshness;
  const keyParts = [
    WIDGET_SOURCE_SCHEMA_VERSION,
    source.descriptor.id,
    source.descriptor.protocol,
    kind,
    stableStringify({
      query: sanitizeQuery(resolved.query),
      request: sanitizeRequest(request),
    }),
    ...(hints.keyParts ?? []),
  ];
  return {
    metadataCacheable: hints.metadataCacheable ?? true,
    resultCacheable: hints.resultCacheable ?? (!options.realtime || freshness !== undefined),
    cacheKey: keyParts.join(":"),
    keyParts,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(freshness ? { freshness } : {}),
    status: "computed",
  };
}

function sanitizeQuery(query: Query): Record<string, unknown> {
  const { signal: _signal, ...rest } = query;
  void _signal;
  return rest as Record<string, unknown>;
}

function sanitizeRequest(request: WidgetSourceRequestBase): Record<string, unknown> {
  const { signal: _signal, query: _query, projection: _projection, ...rest } = request;
  void _signal;
  void _query;
  void _projection;
  return rest as Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function dedupeDegraded(reasons: readonly DegradedReason[]): readonly DegradedReason[] {
  const out: DegradedReason[] = [];
  const seen = new Set<string>();
  for (const reason of reasons) {
    const key = `${reason.capability}:${reason.protocol ?? ""}:${reason.sourceId ?? ""}:${reason.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }
  return out;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(6)).toString();
}
