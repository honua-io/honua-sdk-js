import { describe, expect, it } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  WIDGET_SOURCE_SCHEMA_VERSION,
  capabilities,
  createDataset,
  createWidgetSource,
} from "../../src/contract/index.js";
import type { AttachmentApi, Query, Result, Source, SourceDescriptor } from "../../src/contract/index.js";
import { createExplorationContext, selectLinkedViewQueryProjection } from "../../src/exploration/index.js";
import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  geoservicesQueryResponse,
  jsonResponse,
  makeMockClient,
  odataMetadataDocument,
  ogcCollectionMetadata,
  ogcItemsResponse,
} from "./shared.js";

describe("contract / widget source", () => {
  it("pushes count, formula, categories, and range to GeoServices queryAggregate", async () => {
    const observed = {
      stats: 0,
      where: [] as string[],
    };
    const client = makeMockClient({
      routes: [
        [
          "/rest/services/Parcels/FeatureServer/0/query",
          (url) => {
            const statsParam = url.searchParams.get("outStatistics");
            observed.where.push(url.searchParams.get("where") ?? "");
            if (!statsParam) return jsonResponse(geoservicesQueryResponse());
            observed.stats += 1;
            const groupBy = url.searchParams.get("groupByFieldsForStatistics");
            const stats = JSON.parse(statsParam) as Array<{ statisticType: string; outStatisticFieldName: string }>;
            const aliases = new Set(stats.map((entry) => entry.outStatisticFieldName));
            if (groupBy === "STATE") {
              return jsonResponse({
                features: [
                  { attributes: { STATE: "CA", count: 2 }, geometry: null },
                  { attributes: { STATE: "OR", count: 1 }, geometry: null },
                ],
              });
            }
            if (aliases.has("SUM_ACRES")) {
              return jsonResponse({ features: [{ attributes: { SUM_ACRES: 39.5 }, geometry: null }] });
            }
            if (aliases.has("min_ACRES") && aliases.has("max_ACRES")) {
              return jsonResponse({
                features: [{ attributes: { min_ACRES: 7.5, max_ACRES: 20, count: 3 }, geometry: null }],
              });
            }
            return jsonResponse({ features: [{ attributes: { widget_count: 3 }, geometry: null }] });
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-fs",
          protocol: "geoservices-feature-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;
    const widgets = createWidgetSource(source, { ttlMs: 60_000 });
    const context = createExplorationContext({ datasetId: "parcels", sourceIds: ["parcels-fs"] });
    context.dispatch({
      kind: "set-filter",
      id: "state-filter",
      clause: { field: "STATE", operator: "=", value: "CA", appliesTo: ["parcels-fs"] },
    });
    const projection = selectLinkedViewQueryProjection(context.state, { sourceId: "parcels-fs" });

    const count = await widgets.count({ projection });
    const formula = await widgets.formula({ projection, metric: { fn: "sum", field: "ACRES", alias: "SUM_ACRES" } });
    const categories = await widgets.categories({ projection, field: "STATE", limit: 1 });
    const range = await widgets.range({ projection, field: "ACRES" });
    const topValues = await widgets.topValues({ projection, field: "STATE" });

    expect(count).toMatchObject({
      schemaVersion: WIDGET_SOURCE_SCHEMA_VERSION,
      kind: "count",
      value: 3,
      execution: "server",
      serverPushdown: true,
      cache: { ttlMs: 60_000, metadataCacheable: true, resultCacheable: true },
    });
    expect(formula.value).toBe(39.5);
    expect(categories.buckets).toEqual([{ value: "CA", label: "CA", count: 2, percent: 2 / 3 }]);
    expect(topValues.values.map((bucket) => [bucket.value, bucket.count])).toEqual([
      ["CA", 2],
      ["OR", 1],
    ]);
    expect(range).toMatchObject({ min: 7.5, max: 20, count: 3 });
    expect(observed.stats).toBe(5);
    expect(observed.where.every((where) => where.includes("STATE = 'CA'"))).toBe(true);
  });

  it("uses OData $apply only when metadata advertises ApplySupported", async () => {
    let observedApply: string | null = null;
    let observedFilter: string | null = null;
    const metadata = odataMetadataDocument().replace(
      "</EntitySet>",
      '<Annotation Term="Org.OData.Capabilities.V1.ApplySupported" Bool="true"/></EntitySet>',
    );
    const client = makeMockClient({
      routes: [
        [
          "/odata/$metadata",
          () => new Response(metadata, { status: 200, headers: { "Content-Type": "application/xml" } }),
        ],
        [
          "/odata/Parcels",
          (url) => {
            observedApply = url.searchParams.get("$apply");
            observedFilter = url.searchParams.get("$filter");
            return jsonResponse({
              value: [
                { STATE: "CA", count: 2 },
                { STATE: "OR", count: 1 },
              ],
            });
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-odata",
          protocol: "odata",
          locator: { url: "https://mock/odata", entitySet: "Parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-odata")!;
    const context = createExplorationContext({ datasetId: "parcels", sourceIds: ["parcels-odata"] });
    context.dispatch({
      kind: "set-filter",
      id: "state-filter",
      clause: { field: "STATE", operator: "=", value: "CA", appliesTo: ["parcels-odata"] },
    });

    const result = await createWidgetSource(source).categories({
      field: "STATE",
      projection: selectLinkedViewQueryProjection(context.state, { sourceId: "parcels-odata" }),
    });

    expect(result).toMatchObject({ execution: "server", serverPushdown: true });
    expect(result.degraded).toBeUndefined();
    expect(result.buckets.map((bucket) => [bucket.value, bucket.count])).toEqual([
      ["CA", 2],
      ["OR", 1],
    ]);
    expect(observedApply).toBe("groupby((STATE),aggregate($count as count))");
    expect(observedFilter).toBe("(STATE eq 'CA')");
  });

  it("pushes histograms through canonical aggregation when source analytics metadata advertises support", async () => {
    let observedAggregation: Query<ParcelAttrs>["aggregation"] | undefined;
    const base = stubSource({
      queryAggregate: async (request) => {
        observedAggregation = request.aggregation;
        return {
          features: [],
          exceededTransferLimit: false,
          aggregateRows: [
            { bucket: 0, bucketMin: 0, bucketMax: 10, count: 2 },
            { bucket: 1, bucketMin: 10, bucketMax: 20, count: 1 },
          ],
        };
      },
    });
    const source: Source<ParcelAttrs> = {
      ...base,
      descriptor: {
        ...base.descriptor,
        analytics: { histogram: { fields: ["ACRES"], maxBins: 4 } },
      },
    };

    const result = await createWidgetSource(source).histogram({ field: "ACRES", bins: 2, min: 0, max: 20 });

    expect(result).toMatchObject({ kind: "histogram", execution: "server", serverPushdown: true });
    expect(observedAggregation?.histogram).toMatchObject({ field: "ACRES", bins: 2, min: 0, max: 20 });
    expect(result.bins.map((bin) => [bin.min, bin.max, bin.count])).toEqual([
      [0, 10, 2],
      [10, 20, 1],
    ]);
    expect(result.degraded).toBeUndefined();
  });

  it("uses OData $apply for histogram and time-series pushdown when ApplySupported is advertised", async () => {
    const observedApply: string[] = [];
    const metadata = odataMetadataDocument().replace(
      "</EntitySet>",
      '<Annotation Term="Org.OData.Capabilities.V1.ApplySupported" Bool="true"/></EntitySet>',
    );
    const client = makeMockClient({
      routes: [
        [
          "/odata/$metadata",
          () => new Response(metadata, { status: 200, headers: { "Content-Type": "application/xml" } }),
        ],
        [
          "/odata/Parcels",
          (url) => {
            const apply = url.searchParams.get("$apply") ?? "";
            observedApply.push(apply);
            if (apply.includes("with min")) {
              return jsonResponse({ value: [{ histogram_min: 0, histogram_max: 20 }] });
            }
            if (apply.includes("floor")) {
              return jsonResponse({
                value: [
                  { bucket: 0, count: 2 },
                  { bucket: 1, count: 1 },
                ],
              });
            }
            if (apply.includes("honua.timeBucket")) {
              return jsonResponse({
                value: [
                  { intervalStart: "2026-01-01T00:00:00.000Z", count: 2 },
                  { intervalStart: "2026-01-02T00:00:00.000Z", count: 1 },
                ],
              });
            }
            return jsonResponse({ value: [] });
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-odata",
          protocol: "odata",
          locator: { url: "https://mock/odata", entitySet: "Parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
        } satisfies SourceDescriptor,
      ],
    });
    const widgets = createWidgetSource(dataset.source<ParcelAttrs>("parcels-odata")!);

    const histogram = await widgets.histogram({ field: "ACRES", bins: 2 });
    const series = await widgets.timeSeries({ field: "UPDATED_AT", interval: "day" });

    expect(histogram).toMatchObject({ execution: "server", serverPushdown: true, min: 0, max: 20 });
    expect(histogram.bins.map((bin) => bin.count)).toEqual([2, 1]);
    expect(series).toMatchObject({
      execution: "server",
      serverPushdown: true,
      interval: { unit: "day", step: 1, timezone: "UTC" },
      totalCount: 3,
    });
    expect(series.buckets.map((bucket) => [bucket.start, bucket.count])).toEqual([
      ["2026-01-01T00:00:00.000Z", 2],
      ["2026-01-02T00:00:00.000Z", 1],
    ]);
    expect(observedApply.some((entry) => entry.includes("floor"))).toBe(true);
    expect(observedApply.some((entry) => entry.includes("honua.timeBucket(UPDATED_AT,'day',1,'UTC')"))).toBe(true);
  });

  it("uses protocol-specific time-series pushdown only when adapter metadata advertises support", async () => {
    let observedAggregation: Query<ParcelAttrs>["aggregation"] | undefined;
    const adapter = {
      metadata: async () => ({
        capabilities: {
          widgets: {
            timeSeries: { fields: ["OBSERVED_AT"], intervals: ["hour" as const] },
          },
        },
      }),
      timeSeries: async (
        request: Query<ParcelAttrs> & { aggregation: NonNullable<Query<ParcelAttrs>["aggregation"]> },
      ) => {
        observedAggregation = request.aggregation;
        return {
          rows: [
            { intervalStart: "2026-01-01T00:00:00.000Z", count: 4, metric_avg_ACRES: 12.5 },
            { intervalStart: "2026-01-01T01:00:00.000Z", count: 2, metric_avg_ACRES: 8 },
          ],
        };
      },
    };
    const base = stubSource();
    const source: Source<ParcelAttrs> = {
      ...base,
      protocol: (kind) => (kind === "geoservices-feature-service" ? (adapter as never) : undefined),
      adapter: (kind) => (kind === "geoservices-feature-service" ? (adapter as never) : undefined),
    };

    const result = await createWidgetSource(source).timeSeries({
      field: "OBSERVED_AT",
      interval: { unit: "hour", timezone: "UTC" },
      metric: { fn: "avg", field: "ACRES" },
    });

    expect(result).toMatchObject({ kind: "time-series", execution: "server", serverPushdown: true });
    expect(observedAggregation?.timeSeries).toMatchObject({
      field: "OBSERVED_AT",
      interval: { unit: "hour", step: 1, timezone: "UTC" },
    });
    expect(result.buckets.map((bucket) => [bucket.start, bucket.count, bucket.metric])).toEqual([
      ["2026-01-01T00:00:00.000Z", 4, 12.5],
      ["2026-01-01T01:00:00.000Z", 2, 8],
    ]);
  });

  it("returns degraded, bounded, cache-aware chart models for client histogram fallback", async () => {
    const client = makeMockClient({
      routes: [
        ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const result = await createWidgetSource(dataset.source<ParcelAttrs>("parcels-ogc")!, {
      maxClientRows: 2,
      realtime: true,
    }).histogram({ field: "ACRES", bins: 2 });

    expect(result).toMatchObject({
      kind: "histogram",
      execution: "client",
      serverPushdown: false,
      cache: { resultCacheable: false, metadataCacheable: true },
    });
    expect(result.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(2);
    expect(result.degraded?.map((reason) => reason.capability)).toContain("queryAggregate");
    expect(result.degraded?.some((reason) => reason.reason.includes("bounded at 2 rows"))).toBe(true);
  });

  it("keeps realtime result caches disabled unless a freshness contract is present", async () => {
    const base = stubSource();
    const realtime = await createWidgetSource(base, { realtime: true }).count();
    const freshSource: Source<ParcelAttrs> = {
      ...base,
      descriptor: {
        ...base.descriptor,
        analytics: { freshness: { mode: "watermark", watermarkField: "UPDATED_AT", ttlMs: 5_000 } },
      },
    };
    const fresh = await createWidgetSource(freshSource, { realtime: true }).count();

    expect(realtime.cache.resultCacheable).toBe(false);
    expect(fresh.cache).toMatchObject({
      resultCacheable: true,
      freshness: { mode: "watermark", watermarkField: "UPDATED_AT", ttlMs: 5_000 },
    });
  });

  it("passes abort signals through server pushdown and refuses pre-aborted requests", async () => {
    let capturedSignal: AbortSignal | undefined;
    const source = stubSource({
      queryAggregate: async (request) => {
        capturedSignal = request.signal;
        return {
          features: [],
          exceededTransferLimit: false,
          aggregateRows: [{ widget_count: 7 }],
        };
      },
    });
    const controller = new AbortController();

    await expect(createWidgetSource(source).count({ signal: controller.signal })).resolves.toMatchObject({ value: 7 });
    expect(capturedSignal).toBe(controller.signal);

    const aborted = new AbortController();
    aborted.abort();
    await expect(createWidgetSource(source).count({ signal: aborted.signal })).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
  });
});

const emptyAttachments: AttachmentApi = {
  query: async () => [],
  list: async () => [],
  add: async () => ({ success: false }),
  update: async () => ({ success: false }),
  delete: async () => [],
};

function stubSource(
  impl: Partial<{
    queryAggregate: Source<ParcelAttrs>["queryAggregate"];
    queryAll: Source<ParcelAttrs>["queryAll"];
  }> = {},
): Source<ParcelAttrs> {
  return {
    descriptor: {
      id: "stub",
      protocol: "geoservices-feature-service",
      locator: { url: "https://mock/", serviceId: "Stub", layerId: 0 },
      capabilities: capabilities(["query", "queryAggregate"]),
    },
    capabilities: capabilities(["query", "queryAggregate"]),
    query: async () => ({ features: [], exceededTransferLimit: false }),
    queryAll:
      impl.queryAll ??
      (async (_request?: Query<ParcelAttrs>): Promise<Result<ParcelAttrs>> => ({
        features: PARCEL_FEATURES,
        exceededTransferLimit: false,
      })),
    queryAggregate:
      impl.queryAggregate ??
      (async () => ({
        features: [],
        exceededTransferLimit: false,
        aggregateRows: [{ widget_count: 0 }],
      })),
    queryExtent: async () => ({ extent: null }),
    stream: async function* () {},
    queryObjectIds: async () => [],
    applyEdits: async () => ({ added: [], updated: [], deleted: [] }),
    queryRelated: async () => ({ groups: [] }),
    attachments: emptyAttachments,
    protocol: () => undefined,
    adapter: () => undefined,
  };
}
