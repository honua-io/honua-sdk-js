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
  AggregationMetric,
  AggregationSpec,
  DegradedReason,
  Protocol,
  Query,
  Result,
  SortSpec,
  Source,
  SourceId,
} from "./types.js";

export const WIDGET_SOURCE_SCHEMA_VERSION = "honua.widget-source.v1" as const;

export type WidgetSourceSchemaVersion = typeof WIDGET_SOURCE_SCHEMA_VERSION;
export type WidgetSourceModelKind = "count" | "formula" | "categories" | "histogram" | "range" | "top-values";
export type WidgetSourceExecutionMode = "server" | "client" | "mixed";
export type WidgetSourceOrderBy =
  | "count-desc"
  | "count-asc"
  | "value-asc"
  | "value-desc"
  | "metric-desc"
  | "metric-asc";
export type WidgetSourceValue = string | number | boolean | null;

export interface WidgetSourceOptions {
  /** Maximum rows a client-side fallback may materialize. @default 10000 */
  readonly maxClientRows?: number;
  /** Default TTL advertised in response cache metadata. */
  readonly ttlMs?: number;
  /** Set true for realtime feeds so widget result caches are disabled by default. */
  readonly realtime?: boolean;
  readonly cache?: WidgetSourceCacheHints;
}

export interface WidgetSourceCacheHints {
  readonly metadataCacheable?: boolean;
  readonly resultCacheable?: boolean;
  readonly ttlMs?: number;
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

const DEFAULT_MAX_CLIENT_ROWS = 10_000;
const DEFAULT_CATEGORY_LIMIT = 25;
const DEFAULT_TOP_VALUES_LIMIT = 10;
const DEFAULT_HISTOGRAM_BINS = 10;
const MAX_HISTOGRAM_BINS = 200;

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
  const resolved = resolveWidgetQuery(source, request);
  const materialized = await materialize(
    source,
    options,
    request,
    resolved,
    [request.field],
    [
      {
        capability: "queryAggregate",
        reason:
          "Histogram bucketization is not expressible through the current canonical aggregate contract; values were materialized client-side.",
        protocol: source.descriptor.protocol,
        sourceId: source.descriptor.id,
      },
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

function resolveWidgetQuery<T>(source: Source<T>, request: WidgetSourceRequestBase<T>): ResolvedWidgetQuery<T> {
  const projection = request.projection;
  const query = request.query ?? {};
  const projectionWhere = compileProjectionWhere(projection?.filters, source.descriptor.id);
  const where = combineWhere(query.where, projectionWhere);
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
  const bins = Array.from({ length: count }, (_, index) => {
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
    resultCacheable: hints.resultCacheable ?? !options.realtime,
    cacheKey: keyParts.join(":"),
    keyParts,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
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
