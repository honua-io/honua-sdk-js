import { create } from "@bufbuild/protobuf";
import { type Mock, describe, expect, it, vi } from "vitest";
import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { toProtoQueryRequest } from "../../src/core/grpc-adapter.js";
import type { HonuaExtent, HonuaQueryResponse, QueryFeaturesRequest } from "../../src/core/types.js";
import {
  AttributeValueSchema,
  FeatureSchema,
  FieldDefinitionSchema,
  QueryFeaturesResponseSchema,
} from "../../src/gen/geospatial/v1/index.js";

const fields = ["OBJECTID", "VALUE", "STATE", "CATEGORY"].map((name) => ({
  name,
  type: "esriFieldTypeDouble" as const,
}));

const aggregate = { metrics: [{ fn: "sum" as const, field: "VALUE", alias: "total" }] };

function fixture(policy: "strict" | "degraded" = "degraded") {
  const fetchFn = vi.fn(() => {
    throw new Error("REST fallback is forbidden");
  });
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    transport: "grpc-web",
    apiKey: "fixture-key",
    fetchFn,
  });
  const query = vi.spyOn(client, "queryFeatures") as unknown as Mock<
    (request: QueryFeaturesRequest) => Promise<HonuaQueryResponse & { count?: unknown; extent?: HonuaExtent }>
  >;
  const source = createDataset({
    id: "fixture",
    client,
    capabilityPolicy: policy,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "source",
        protocol: "geoservices-feature-service",
        locator: { url: client.serverBaseUrl, serviceId: "published", layerId: 10 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
      },
    ],
  }).source("source")!;
  return { source, query, fetchFn, client };
}

describe("gRPC whole-set client-side aggregation", () => {
  it("uses the actual client protobuf mapping for count and aggregate data without a REST request", async () => {
    const { source, query, fetchFn, client } = fixture();
    query.mockRestore();
    const count = create(QueryFeaturesResponseSchema, { count: 2n });
    const features = [1n, 2n].map((id) =>
      create(FeatureSchema, {
        id,
        attributes: { VALUE: create(AttributeValueSchema, { value: { case: "doubleValue", value: Number(id) * 3 } }) },
      }),
    );
    const response = create(QueryFeaturesResponseSchema, {
      fields: fields.map(({ name }) => create(FieldDefinitionSchema, { name })),
      objectIdFieldName: "OBJECTID",
      features,
    });
    const rpc = vi.fn().mockResolvedValueOnce(count).mockResolvedValueOnce(response);
    Object.defineProperty(client, "connectClient", { value: { queryFeatures: rpc }, configurable: true });
    const signal = new AbortController().signal;
    const result = await source.queryAggregate({ where: "VALUE >= 3", signal, aggregation: aggregate });
    expect(result.aggregateRows).toEqual([{ total: 9 }]);
    expect(rpc.mock.calls[0][0]).toMatchObject({
      serviceId: "published",
      layerId: 10,
      where: "VALUE >= 3",
      returnCountOnly: true,
    });
    expect(rpc.mock.calls[1][0]).toMatchObject({
      serviceId: "published",
      layerId: 10,
      resultOffsetLong: 0n,
      resultRecordCountLong: 2000n,
    });
    expect(rpc.mock.calls[0][1]).toEqual({ signal });
    expect(rpc.mock.calls[1][1]).toEqual({ signal });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("drains matching pages from zero, retrieves all metric fields, and preserves filters and cancellation", async () => {
    const { source, query, fetchFn } = fixture();
    query
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({
        fields,
        objectIdFieldName: "OBJECTID",
        features: [{ attributes: { OBJECTID: 1, VALUE: 2 } }, { attributes: { OBJECTID: 2, VALUE: 3 } }],
        exceededTransferLimit: true,
      })
      .mockResolvedValueOnce({
        fields,
        objectIdFieldName: "OBJECTID",
        features: [{ attributes: { OBJECTID: 3, VALUE: 7 } }],
        exceededTransferLimit: false,
      });
    const signal = new AbortController().signal;
    const result = await source.queryAggregate({
      where: "VALUE > 1",
      pagination: { limit: 1, offset: 2 },
      outFields: ["OBJECTID"],
      signal,
      aggregation: aggregate,
    });
    expect(result.aggregateRows).toEqual([{ total: 12 }]);
    expect(result.totalCount).toBe(3);
    expect(result.exceededTransferLimit).toBe(false);
    expect(result.degraded).toEqual([
      expect.objectContaining({
        capability: "queryAggregate",
        protocol: "grpc",
        reason: expect.stringContaining("complete matching set"),
      }),
    ]);
    expect(query.mock.calls.map(([request]) => request.resultOffset)).toEqual([undefined, 0, 2]);
    for (const [request] of query.mock.calls) {
      expect(request).toMatchObject({
        serviceId: "published",
        layerId: 10,
        where: "VALUE > 1",
        signal,
        returnGeometry: false,
      });
      expect(request.outStatistics).toBeUndefined();
      expect(request.groupByFieldsForStatistics).toBeUndefined();
    }
    expect(query.mock.calls[1][0].outFields).toEqual(["*"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("groups the complete set rather than the caller's display window", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({
      fields,
      objectIdFieldName: "OBJECTID",
      features: [
        { attributes: { OBJECTID: 1, STATE: "A", VALUE: 2 } },
        { attributes: { OBJECTID: 2, STATE: "B", VALUE: 5 } },
      ],
    });
    const result = await source.queryAggregate({
      pagination: { limit: 1, offset: 99 },
      aggregation: { ...aggregate, groupBy: ["STATE"] },
    });
    expect(result.aggregateRows).toEqual([
      { STATE: "A", total: 2 },
      { STATE: "B", total: 5 },
    ]);
  });

  it("rejects server truncation instead of publishing a partial aggregate", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({
      fields,
      objectIdFieldName: "OBJECTID",
      features: [{ attributes: { OBJECTID: 1, VALUE: 2 } }],
    });
    await expect(source.queryAggregate({ aggregation: aggregate })).rejects.toMatchObject({
      context: { reason: expect.stringContaining("materialization did not match") },
    });
  });

  it("rejects a repeated gRPC page", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 4 }).mockResolvedValue({
      fields,
      objectIdFieldName: "OBJECTID",
      features: [{ attributes: { OBJECTID: 1, VALUE: 2 } }],
      exceededTransferLimit: true,
    });
    await expect(source.queryAggregate({ aggregation: aggregate })).rejects.toMatchObject({
      context: { reason: expect.stringContaining("repeated object ID") },
    });
  });

  it("fails on a finite page budget rather than accepting incomplete rows", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 101 });
    let id = 0;
    query.mockImplementation(async () => ({
      fields,
      objectIdFieldName: "OBJECTID",
      features: [{ attributes: { OBJECTID: ++id, VALUE: 1 } }],
      exceededTransferLimit: true,
    }));
    await expect(source.queryAggregate({ aggregation: aggregate })).rejects.toMatchObject({
      context: { reason: expect.stringContaining("materialization did not match") },
    });
    expect(query).toHaveBeenCalledTimes(101);
  });

  it("rejects oversized materialization before fetching data", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 200001 });
    await expect(source.queryAggregate({ aggregation: aggregate })).rejects.toMatchObject({
      context: { reason: expect.stringContaining("200000-feature") },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps strict source aggregation and raw aggregate RPC rejection", async () => {
    const { source, query } = fixture("strict");
    await expect(source.queryAggregate({ aggregation: aggregate })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(query).not.toHaveBeenCalled();
    expect(() =>
      toProtoQueryRequest({
        serviceId: "published",
        layerId: 10,
        outStatistics: [{ statisticType: "sum", onStatisticField: "VALUE", outStatisticFieldName: "total" }],
      }),
    ).toThrow(HonuaCapabilityNotSupportedError);
  });

  it.each([0, 7])("uses an exact gRPC count (%i), keeping the original spatial predicate", async (count) => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } }).mockResolvedValueOnce({ count });
    const result = await source.queryExtent({
      where: "VALUE > 2",
      spatialFilter: {
        geometry: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
    });
    expect(result.count).toBe(count);
    const first = query.mock.calls[0][0];
    const second = query.mock.calls[1][0];
    expect(second.where).toBe(first.where);
    expect(second.geometry).toEqual(first.geometry);
    expect(second.extraParams).toEqual({ returnCountOnly: true });
  });

  it.each([undefined, Number.NaN, -1, 1.5])("rejects an invalid exact count (%s)", async (count) => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count });
    await expect(source.queryAggregate({ aggregation: aggregate })).rejects.toMatchObject({
      context: { reason: expect.stringContaining("exact nonnegative count") },
    });
  });

  it("rejects duplicate IDs even when attributes change and the row count matches", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({
      fields,
      objectIdFieldName: "OBJECTID",
      features: [{ attributes: { OBJECTID: 1, VALUE: 2 } }, { attributes: { OBJECTID: 1, VALUE: 99 } }],
    });
    await expect(source.queryAggregate({ aggregation: aggregate })).rejects.toMatchObject({
      context: { reason: expect.stringContaining("repeated object ID") },
    });
  });

  it("matches SQL null counts, sample variance and case-insensitive field names", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({
      fields,
      objectIdFieldName: "objectid",
      features: [
        { attributes: { OBJECTID: 1, value: 2, category: null } },
        { attributes: { OBJECTID: 2, value: 4, category: null } },
        { attributes: { OBJECTID: 3, value: null, category: "" } },
      ],
    });
    const result = await source.queryAggregate({
      aggregation: {
        groupBy: ["CATEGORY"],
        metrics: [
          { fn: "count", field: "VALUE", alias: "n" },
          { fn: "avg", field: "VALUE", alias: "avg" },
          { fn: "var", field: "VALUE", alias: "variance" },
          { fn: "stddev", field: "VALUE", alias: "stddev" },
        ],
      },
    });
    expect(result.aggregateRows).toEqual([
      { CATEGORY: null, n: 2, avg: 3, variance: 2, stddev: Math.sqrt(2) },
      { CATEGORY: "", n: 0, avg: null, variance: null, stddev: null },
    ]);
  });

  it("validates the server schema for an empty aggregate set", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ fields, features: [] });
    const result = await source.queryAggregate({
      aggregation: {
        metrics: [
          { fn: "count", field: "VALUE", alias: "n" },
          { fn: "sum", field: "VALUE", alias: "sum" },
          { fn: "min", field: "VALUE", alias: "min" },
          { fn: "max", field: "VALUE", alias: "max" },
        ],
      },
    });
    expect(result.aggregateRows).toEqual([{ n: 0, sum: null, min: null, max: null }]);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([0, 1])("rejects unknown metric and group fields even with %i matching rows", async (count) => {
    for (const aggregation of [
      { metrics: [{ fn: "count" as const, field: "TYPO" }] },
      { ...aggregate, groupBy: ["TYPO"] },
    ]) {
      const { source, query } = fixture();
      query.mockResolvedValueOnce({ count }).mockResolvedValueOnce({
        fields,
        objectIdFieldName: "OBJECTID",
        features: count ? [{ attributes: { OBJECTID: 1, VALUE: null } }] : [],
      });
      await expect(source.queryAggregate({ aggregation })).rejects.toMatchObject({
        context: { reason: expect.stringContaining("unknown or ambiguous") },
      });
    }
  });
  it("does not advertise REST-only native capabilities for a gRPC client", () => {
    const { source } = fixture();
    expect(source.capabilities.has("queryAggregate")).toBe(false);
    expect(source.capabilities.has("queryRelated")).toBe(false);
    expect(source.capabilities.has("query")).toBe(true);
  });
  it.each(["sum", "var", "stddev"] as const)("rejects nonfinite computed %s", async (fn) => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({
      fields,
      objectIdFieldName: "OBJECTID",
      features: [
        { attributes: { OBJECTID: 1, VALUE: 1e308 } },
        { attributes: { OBJECTID: 2, VALUE: fn === "sum" ? 1e308 : -1e308 } },
      ],
    });
    await expect(source.queryAggregate({ aggregation: { metrics: [{ fn, field: "VALUE" }] } })).rejects.toMatchObject({
      context: { reason: expect.stringContaining("overflowed") },
    });
  });
  it.each(["sum", "avg", "min", "max", "var", "stddev", "groupBy"] as const)(
    "rejects wildcard %s before any RPC",
    async (fn) => {
      const { source, query } = fixture();
      const aggregation = fn === "groupBy" ? { ...aggregate, groupBy: ["*"] } : { metrics: [{ fn, field: "*" }] };
      await expect(source.queryAggregate({ aggregation })).rejects.toMatchObject({
        context: { reason: expect.stringContaining("only for COUNT") },
      });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("retains COUNT(*) over nullable values", async () => {
    const { source, query } = fixture();
    query.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({
      fields,
      objectIdFieldName: "OBJECTID",
      features: [{ attributes: { OBJECTID: 1, VALUE: null } }],
    });
    const result = await source.queryAggregate({ aggregation: { metrics: [{ fn: "count", field: "*", alias: "n" }] } });
    expect(result.aggregateRows).toEqual([{ n: 1 }]);
  });
});
