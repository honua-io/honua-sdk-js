/**
 * Built-in `Source` adapters that wrap the runtime classes in
 * `src/core/surfaces.ts` (`HonuaFeatureLayer`, `HonuaMapLayer`,
 * `HonuaOgcFeatureCollection`). Downstream tickets supply WFS / WMS /
 * OData adapters via `CreateDatasetOptions.resolveSource`.
 *
 * These adapters do not reimplement query logic — they translate the
 * canonical `Query` / `Result` envelope to and from the existing per-class
 * request and response shapes.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import {
  HonuaFeatureLayer,
  HonuaMapLayer,
  HonuaMapService,
  HonuaOgcFeatureCollection,
  HonuaOgcFeatures,
} from "../core/surfaces.js";
import type {
  HonuaFeature,
  HonuaQueryResponse,
  HonuaTypedFeature,
  HonuaTypedQueryResponse,
} from "../core/types.js";
import {
  CAPABILITIES,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type AdapterFor,
  type AdapterKind,
  type AggregationFn,
  type AggregationMetric,
  type AggregationSpec,
  type Capability,
  type CapabilityPolicy,
  type CreateDatasetOptions,
  type Dataset,
  type DegradedReason,
  type Protocol,
  type Query,
  type Result,
  type Source,
  type SourceDescriptor,
  type SourceId,
} from "./types.js";

/**
 * Construct a `Dataset` over one `HonuaClient`. Compatibility is checked
 * once and cached on the client. `Source` handles are constructed lazily.
 */
export function createDataset(options: CreateDatasetOptions): Dataset {
  const { id, client, sources, resolveSource } = options;
  const policy: CapabilityPolicy = options.capabilityPolicy ?? "strict";
  const descriptors = new Map<SourceId, SourceDescriptor>();
  const handles = new Map<SourceId, Source>();
  let compatibilityPromise: Promise<boolean> | undefined;

  for (const descriptor of sources) {
    if (descriptors.has(descriptor.id)) {
      throw new Error(`createDataset: duplicate source id "${descriptor.id}"`);
    }
    descriptors.set(descriptor.id, descriptor);
  }

  function resolve<T>(descriptor: SourceDescriptor): Source<T> {
    const cached = handles.get(descriptor.id);
    if (cached) return cached as Source<T>;

    const built = buildBuiltInSource<T>(descriptor, client, policy)
      ?? resolveSource?.(descriptor, { client, capabilityPolicy: policy }) as Source<T> | undefined;
    if (!built) {
      throw new HonuaCapabilityNotSupportedError(
        "query",
        descriptor.protocol,
        descriptor.id,
      );
    }
    handles.set(descriptor.id, built as Source);
    return built;
  }

  return {
    id,
    client,
    sourceDescriptors: [...descriptors.values()],
    source<T = Record<string, unknown>>(sourceId: SourceId): Source<T> | undefined {
      const descriptor = descriptors.get(sourceId);
      if (!descriptor) return undefined;
      return resolve<T>(descriptor);
    },
    sourceIds(): readonly SourceId[] {
      return [...descriptors.keys()];
    },
    isCompatible(): Promise<boolean> {
      if (options.skipCompatibilityCheck) return Promise.resolve(true);
      if (!compatibilityPromise) {
        compatibilityPromise = client.checkCompatibility().then((status) => status.supported).catch(() => false);
      }
      return compatibilityPromise;
    },
    supportsFeature(feature) {
      return client.supportsFeature(feature).catch(() => false);
    },
  };
}

// ── Built-in resolver ─────────────────────────────────────────

function buildBuiltInSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> | undefined {
  switch (descriptor.protocol) {
    case "geoservices-feature-service":
      return geoServicesFeatureSource<T>(descriptor, client, policy);
    case "geoservices-map-service":
      return geoServicesMapServiceSource<T>(descriptor, client, policy);
    case "ogc-features":
      return ogcFeaturesSource<T>(descriptor, client, policy);
    default:
      return undefined;
  }
}

// ── GeoServices Feature Service ───────────────────────────────

export function geoServicesFeatureSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
  const { serviceId, layerId } = requireFeatureServiceLocator(descriptor);
  const layer = new HonuaFeatureLayer<T>({ client, serviceId, layerId });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"];

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "geoservices-feature-service": layer,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      const requestParams = toFeatureLayerRequest(request);
      if (request?.aggregation) {
        const [extraParams, aggregateAlias] = appendAggregationParams(requestParams.extraParams, request.aggregation);
        return aggregateResultFromFeatureLayer(
          await layer.queryFeatures({ ...requestParams, extraParams }),
          aggregateAlias,
        );
      }
      const response = await layer.queryFeatures(requestParams);
      return featureLayerResultFromTyped<T>(response);
    },
    async queryAll(request) {
      const params = withPaginationLimitAsPageSize(toFeatureLayerRequest(request), request?.pagination?.limit);
      const features = await layer.queryFeaturesAll(params);
      const { features: limited, exceededTransferLimit } = applyQueryAllLimit(features, request?.pagination?.limit);
      return {
        features: limited,
        exceededTransferLimit,
        totalCount: limited.length,
      } satisfies Result<T>;
    },
    async queryAggregate(request) {
      ensureCapability(descriptor, caps, "queryAggregate", policy);
      const requestParams = toFeatureLayerRequest(request);
      const [extraParams, aggregateAlias] = appendAggregationParams(requestParams.extraParams, request.aggregation);
      const response = await layer.queryFeatures({ ...requestParams, extraParams });
      return aggregateResultFromFeatureLayer(response, aggregateAlias);
    },
    async queryExtent(request) {
      ensureCapability(descriptor, caps, "queryExtent", policy);
      const params = toFeatureLayerRequest(request);
      const out = await layer.queryExtent({ where: params.where, method: params.method, extraParams: params.extraParams });
      return { extent: out.extent ?? null, count: out.count };
    },
    async *stream(request) {
      const stream = layer.queryFeaturesStream(toFeatureLayerRequest(request));
      for await (const page of stream) {
        yield {
          features: page,
          exceededTransferLimit: false,
        } satisfies Result<T>;
      }
    },
  });
}

// ── GeoServices Map Service / Map Layer ───────────────────────

export function geoServicesMapServiceSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
  const { serviceId, layerId } = requireMapServiceLocator(descriptor);
  const service = new HonuaMapService({ client, serviceId });
  const layer = new HonuaMapLayer({ client, serviceId, layerId });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["geoservices-map-service"];

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "geoservices-map-service": service,
    "geoservices-map-layer": layer,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      const params = toFeatureLayerRequest(request);
      if (request?.aggregation) {
        const [extraParams, aggregateAlias] = appendAggregationParams(params.extraParams, request.aggregation);
        return aggregateResultFromUntyped<T>(await layer.queryFeatures({ ...params, extraParams }), aggregateAlias);
      }
      const response = await layer.queryFeatures(params);
      return featureLayerResultFromUntyped<T>(response);
    },
    async queryAll(request) {
      const params = withPaginationLimitAsPageSize(toFeatureLayerRequest(request), request?.pagination?.limit);
      const features = await layer.queryFeaturesAll(params);
      const typed = features.map(toTypedFeature<T>);
      const { features: limited, exceededTransferLimit } = applyQueryAllLimit(typed, request?.pagination?.limit);
      return {
        features: limited,
        exceededTransferLimit,
        totalCount: limited.length,
      } satisfies Result<T>;
    },
    async queryAggregate(request) {
      ensureCapability(descriptor, caps, "queryAggregate", policy);
      const params = toFeatureLayerRequest(request);
      const [extraParams, aggregateAlias] = appendAggregationParams(params.extraParams, request.aggregation);
      const response = await layer.queryFeatures({ ...params, extraParams });
      return aggregateResultFromUntyped<T>(response, aggregateAlias);
    },
    async queryExtent(request) {
      ensureCapability(descriptor, caps, "queryExtent", policy);
      const params = toFeatureLayerRequest(request);
      const out = await layer.queryExtent({ where: params.where, method: params.method, extraParams: params.extraParams });
      return { extent: out.extent ?? null, count: out.count };
    },
    async *stream(request) {
      const stream = layer.queryFeaturesStream(toFeatureLayerRequest(request));
      for await (const page of stream) {
        yield {
          features: page.map(toTypedFeature<T>),
          exceededTransferLimit: false,
        } satisfies Result<T>;
      }
    },
  });
}

// ── OGC API Features ──────────────────────────────────────────

export function ogcFeaturesSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
  const { collectionId } = requireOgcLocator(descriptor);
  const collection = new HonuaOgcFeatureCollection({ client, collectionId });
  const root = new HonuaOgcFeatures({ client });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"];

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "ogc-features": collection,
  };
  void root;

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query", policy);
      if (request?.aggregation) {
        ensureCapability(descriptor, caps, "queryAggregate", policy);
      }
      const response = await collection.items(toOgcRequest(request));
      const features = response.features.map(toTypedFeatureFromOgc<T>);
      const totalCount = response.numberMatched;
      const degraded: DegradedReason[] = [];
      const exceededTransferLimit = totalCount !== undefined && features.length < totalCount;
      if (request?.aggregation) {
        const aggregateRows = clientSideAggregate(features, request.aggregation);
        degraded.push({
          capability: "queryAggregate",
          reason: "OGC API Features does not expose server-side aggregation; aggregating client-side over the returned page.",
          protocol: "ogc-features",
        });
        return {
          features,
          exceededTransferLimit,
          totalCount,
          aggregateRows,
          degraded,
        } satisfies Result<T>;
      }
      return {
        features,
        exceededTransferLimit,
        totalCount,
      } satisfies Result<T>;
    },
    async queryAll(request) {
      const all = await collection.itemsAll(toOgcRequest(request));
      const features = all.map(toTypedFeatureFromOgc<T>);
      return {
        features,
        exceededTransferLimit: false,
        totalCount: features.length,
      } satisfies Result<T>;
    },
    async queryAggregate(request) {
      ensureCapability(descriptor, caps, "queryAggregate", policy);
      const all = await collection.itemsAll(toOgcRequest(request));
      const features = all.map(toTypedFeatureFromOgc<T>);
      return {
        features,
        exceededTransferLimit: false,
        totalCount: features.length,
        aggregateRows: clientSideAggregate(features, request.aggregation),
        degraded: [
          {
            capability: "queryAggregate",
            reason: "OGC API Features aggregation evaluated client-side over the materialized result set.",
            protocol: "ogc-features",
          },
        ],
      } satisfies Result<T>;
    },
    async queryExtent(request) {
      ensureCapability(descriptor, caps, "queryExtent", policy);
      const meta = await collection.metadata();
      const bbox = meta.extent?.spatial?.bbox?.[0];
      if (!bbox || bbox.length < 4) return { extent: null };
      void request;
      const [xmin, ymin, xmax, ymax] = bbox;
      return {
        extent: { xmin, ymin, xmax, ymax },
      };
    },
    async *stream(request) {
      const stream = collection.itemsStream(toOgcRequest(request));
      for await (const page of stream) {
        yield {
          features: page.map(toTypedFeatureFromOgc<T>),
          exceededTransferLimit: false,
        } satisfies Result<T>;
      }
    },
  });
}

// ── Internal helpers ──────────────────────────────────────────

interface SourceImplementation<T> {
  query(request?: Query<T>): Promise<Result<T>>;
  queryAll(request?: Query<T>): Promise<Result<T>>;
  queryAggregate(request: Query<T> & { aggregation: AggregationSpec }): Promise<Result<T>>;
  queryExtent(request?: Query<T>): Promise<{ extent: import("../core/types.js").HonuaExtent | null; count?: number }>;
  stream(request?: Query<T>): AsyncGenerator<Result<T>, void, undefined>;
}

function makeSource<T>(
  descriptor: SourceDescriptor,
  caps: ReadonlySet<Capability>,
  _policy: CapabilityPolicy,
  adapters: Partial<Record<AdapterKind, unknown>>,
  impl: SourceImplementation<T>,
): Source<T> {
  return {
    descriptor: { ...descriptor, capabilities: caps },
    capabilities: caps,
    query: impl.query.bind(impl),
    queryAll: impl.queryAll.bind(impl),
    queryAggregate: impl.queryAggregate.bind(impl),
    queryExtent: impl.queryExtent.bind(impl),
    stream: impl.stream.bind(impl),
    adapter<K extends AdapterKind>(kind: K): AdapterFor<K> | undefined {
      return adapters[kind] as AdapterFor<K> | undefined;
    },
  };
}

function ensureCapability(
  descriptor: SourceDescriptor,
  caps: ReadonlySet<Capability>,
  capability: Capability,
  policy: CapabilityPolicy,
): void {
  if (caps.has(capability)) return;
  if (policy === "strict") {
    throw new HonuaCapabilityNotSupportedError(capability, descriptor.protocol, descriptor.id);
  }
}

function requireFeatureServiceLocator(descriptor: SourceDescriptor): { serviceId: string; layerId: number } {
  const { serviceId, layerId } = descriptor.locator;
  if (typeof serviceId !== "string" || typeof layerId !== "number") {
    throw new Error(
      `createDataset: source "${descriptor.id}" (geoservices-feature-service) requires locator.serviceId and locator.layerId`,
    );
  }
  return { serviceId, layerId };
}

function requireMapServiceLocator(descriptor: SourceDescriptor): { serviceId: string; layerId: number } {
  const { serviceId, layerId } = descriptor.locator;
  if (typeof serviceId !== "string" || typeof layerId !== "number") {
    throw new Error(
      `createDataset: source "${descriptor.id}" (geoservices-map-service) requires locator.serviceId and locator.layerId`,
    );
  }
  return { serviceId, layerId };
}

function requireOgcLocator(descriptor: SourceDescriptor): { collectionId: string | number } {
  const { collectionId } = descriptor.locator;
  if (collectionId === undefined || collectionId === null || collectionId === "") {
    throw new Error(`createDataset: source "${descriptor.id}" (ogc-features) requires locator.collectionId`);
  }
  return { collectionId };
}

/**
 * `HonuaFeatureLayer.queryFeaturesAll` / `HonuaMapLayer.queryFeaturesAll`
 * drive paging from their own `pageSize` / `maxPages` knobs and overwrite
 * `resultRecordCount` per page, so the canonical `Query.pagination.limit`
 * the adapter translates to `resultRecordCount` is ignored. When a limit is
 * supplied, scale the per-page fetch to the limit so small limits do a
 * single request and large limits still terminate promptly.
 */
function withPaginationLimitAsPageSize<R extends object>(
  params: R,
  limit: number | undefined,
): R & { pageSize?: number } {
  if (typeof limit !== "number" || limit < 1) return params;
  return { ...params, pageSize: Math.max(1, Math.min(limit, 2000)) };
}

function applyQueryAllLimit<F>(
  features: readonly F[],
  limit: number | undefined,
): { features: readonly F[]; exceededTransferLimit: boolean } {
  if (typeof limit !== "number" || limit < 0) {
    return { features, exceededTransferLimit: false };
  }
  if (features.length <= limit) {
    return { features, exceededTransferLimit: false };
  }
  return { features: features.slice(0, limit), exceededTransferLimit: true };
}

function toFeatureLayerRequest<T>(request?: Query<T>): {
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  outSr?: string | number;
  orderByFields?: string;
  geometry?: Record<string, unknown>;
  geometryType?: import("../core/types.js").EsriGeometryType;
  spatialRel?: import("../core/types.js").EsriSpatialRel;
  resultOffset?: number;
  resultRecordCount?: number;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  method?: import("../core/types.js").QueryMethod;
} {
  if (!request) return {};
  const out: Record<string, unknown> = {};
  if (request.where !== undefined) out.where = request.where;
  if (request.outFields && request.outFields.length > 0) out.outFields = [...request.outFields];
  if (request.returnGeometry !== undefined) out.returnGeometry = request.returnGeometry;
  if (request.outSr !== undefined) out.outSr = request.outSr;
  if (request.orderBy && request.orderBy.length > 0) {
    out.orderByFields = request.orderBy
      .map((s) => `${s.field}${s.direction === "desc" ? " DESC" : ""}`)
      .join(",");
  }
  if (request.spatialFilter) {
    out.geometry = request.spatialFilter.geometry;
    out.geometryType = request.spatialFilter.geometryType;
    if (request.spatialFilter.spatialRel) out.spatialRel = request.spatialFilter.spatialRel;
  }
  if (request.pagination) {
    if (request.pagination.offset !== undefined) out.resultOffset = request.pagination.offset;
    if (request.pagination.limit !== undefined) out.resultRecordCount = request.pagination.limit;
  }
  if (request.signal) out.signal = request.signal;
  return out;
}

function toOgcRequest<T>(request?: Query<T>): Record<string, unknown> {
  if (!request) return {};
  const out: Record<string, unknown> = {};
  if (request.where !== undefined) out.filter = request.where;
  if (request.outFields && request.outFields.length > 0) out.properties = [...request.outFields];
  if (request.outSr !== undefined) out.crs = String(request.outSr);
  if (request.pagination) {
    if (request.pagination.limit !== undefined) out.limit = request.pagination.limit;
    if (request.pagination.offset !== undefined) out.offset = request.pagination.offset;
  }
  if (request.orderBy && request.orderBy.length > 0) {
    out.sortby = request.orderBy
      .map((s) => `${s.direction === "desc" ? "-" : ""}${s.field}`)
      .join(",");
  }
  if (request.spatialFilter && request.spatialFilter.geometryType === "esriGeometryEnvelope") {
    const env = request.spatialFilter.geometry as { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
    if (
      typeof env.xmin === "number" &&
      typeof env.ymin === "number" &&
      typeof env.xmax === "number" &&
      typeof env.ymax === "number"
    ) {
      out.bbox = `${env.xmin},${env.ymin},${env.xmax},${env.ymax}`;
    }
  }
  if (request.signal) out.signal = request.signal;
  return out;
}

function featureLayerResultFromTyped<T>(response: HonuaTypedQueryResponse<T>): Result<T> {
  return {
    features: response.features ?? [],
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    fields: response.fields,
  };
}

function featureLayerResultFromUntyped<T>(response: HonuaQueryResponse): Result<T> {
  const features = (response.features ?? []).map(toTypedFeature<T>);
  return {
    features,
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    fields: response.fields,
  };
}

function toTypedFeature<T>(feature: HonuaFeature): HonuaTypedFeature<T> {
  return {
    attributes: feature.attributes as T,
    geometry: feature.geometry,
  };
}

function toTypedFeatureFromOgc<T>(feature: import("../core/types.js").HonuaOgcFeatureResponse): HonuaTypedFeature<T> {
  return {
    attributes: (feature.properties ?? {}) as T,
    geometry: feature.geometry as Record<string, unknown> | null,
  };
}

function appendAggregationParams(
  extraParams: Record<string, string | number | boolean> | undefined,
  aggregation: AggregationSpec,
): [Record<string, string | number | boolean>, string | undefined] {
  const next: Record<string, string | number | boolean> = { ...(extraParams ?? {}) };
  const stats = aggregation.metrics.map((m) => ({
    statisticType: toGeoServicesStatisticType(m.fn),
    onStatisticField: m.field,
    outStatisticFieldName: m.alias ?? `${m.fn}_${m.field}`,
  }));
  next.outStatistics = JSON.stringify(stats);
  if (aggregation.groupBy && aggregation.groupBy.length > 0) {
    next.groupByFieldsForStatistics = aggregation.groupBy.join(",");
  }
  next.returnGeometry = false;
  return [next, stats[0]?.outStatisticFieldName];
}

function toGeoServicesStatisticType(fn: AggregationFn): string {
  switch (fn) {
    case "stddev":
      return "stddev";
    case "var":
      return "var";
    default:
      return fn;
  }
}

function aggregateResultFromFeatureLayer<T>(
  response: HonuaTypedQueryResponse<T>,
  _aggregateAlias: string | undefined,
): Result<T> {
  const aggregateRows = (response.features ?? []).map((f) => f.attributes as Record<string, unknown>);
  return {
    features: [],
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    aggregateRows,
    fields: response.fields,
  };
}

function aggregateResultFromUntyped<T>(response: HonuaQueryResponse, _alias: string | undefined): Result<T> {
  const aggregateRows = (response.features ?? []).map((f) => f.attributes);
  return {
    features: [],
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    aggregateRows,
    fields: response.fields,
  };
}

function clientSideAggregate<T>(
  features: ReadonlyArray<HonuaTypedFeature<T>>,
  aggregation: AggregationSpec,
): Array<Record<string, unknown>> {
  const groupKeys = aggregation.groupBy ?? [];
  if (groupKeys.length === 0) {
    return [computeMetrics(features, aggregation.metrics)];
  }
  const groups = new Map<string, HonuaTypedFeature<T>[]>();
  for (const feature of features) {
    const key = groupKeys.map((field) => String(readField(feature.attributes, field) ?? "")).join("\u0000");
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(feature);
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const bucket of groups.values()) {
    const head = bucket[0];
    const row: Record<string, unknown> = {};
    for (const field of groupKeys) {
      row[field] = readField(head.attributes, field);
    }
    Object.assign(row, computeMetrics(bucket, aggregation.metrics));
    rows.push(row);
  }
  return rows;
}

function computeMetrics<T>(
  features: ReadonlyArray<HonuaTypedFeature<T>>,
  metrics: ReadonlyArray<AggregationMetric>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const metric of metrics) {
    const alias = metric.alias ?? `${metric.fn}_${metric.field}`;
    const values = features
      .map((f) => readField(f.attributes, metric.field))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    out[alias] = applyAggregation(metric.fn, values, features.length);
  }
  return out;
}

function applyAggregation(fn: AggregationFn, values: readonly number[], totalLength: number): number {
  if (fn === "count") return totalLength;
  if (values.length === 0) return 0;
  switch (fn) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "stddev":
    case "var": {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      return fn === "var" ? variance : Math.sqrt(variance);
    }
    default:
      return 0;
  }
}

function readField(attributes: unknown, field: string): unknown {
  if (typeof attributes !== "object" || attributes === null) return undefined;
  return (attributes as Record<string, unknown>)[field];
}

// ── Re-exports for downstream tickets ─────────────────────────

/** Sentinel: `Capabilities` set that contains every defined capability. */
export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES);

/** Tag a `Protocol` as "first-party-supported by this build". */
export const FIRST_PARTY_PROTOCOLS: ReadonlySet<Protocol> = new Set([
  "geoservices-feature-service",
  "geoservices-map-service",
  "ogc-features",
] as const);
