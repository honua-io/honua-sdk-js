import { describe, expect, it, vi } from "vitest";

import type { Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import {
  HonuaQueryPlanExecutionError,
  HonuaQueryPlanningError,
  MAX_LOCAL_MATERIALIZATION_ROWS,
  canonicalStringify,
  createQueryIr,
  executeQueryPlan,
  explainQuery,
  hashQueryIr,
  sha256,
} from "../src/query-planner/index.js";

const descriptor = (queryAggregate = true): SourceDescriptor => ({
  id: "incidents",
  protocol: "geoservices-feature-service",
  locator: {
    url: "https://user:secret@demo.honua.io/FeatureServer?token=secret#fragment",
    serviceId: "incidents",
    layerId: 0,
  },
  capabilities: capabilities(queryAggregate ? ["query", "queryAggregate"] : ["query"]),
  schema: { primaryKey: "OBJECTID" },
});

const aggregateQuery: Query = {
  where: "status = 'open'",
  orderBy: [{ field: "incident_count", direction: "desc" }],
  pagination: { offset: 1, limit: 2 },
  aggregation: {
    groupBy: ["severity"],
    metrics: [
      { fn: "count", field: "OBJECTID", alias: "incident_count" },
      { fn: "avg", field: "duration", alias: "average_duration" },
    ],
  },
};

describe("query IR", () => {
  it("uses a portable SHA-256 implementation", () => {
    expect(sha256("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("serializes object keys deterministically while preserving array order", () => {
    expect(canonicalStringify({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it("produces stable identity, excludes cancellation, and strips credentials", () => {
    const first = createQueryIr({
      descriptor: descriptor(),
      query: {
        where: "1=1",
        spatialFilter: { geometry: { ymax: 2, xmin: 0, xmax: 3, ymin: 1 }, geometryType: "esriGeometryEnvelope" },
      },
      authorizationScope: ["map:read", "data:read", "data:read"],
      sourceVersion: "v7",
    });
    const second = createQueryIr({
      descriptor: descriptor(),
      query: {
        where: "1=1",
        spatialFilter: { geometry: { xmin: 0, ymin: 1, xmax: 3, ymax: 2 }, geometryType: "esriGeometryEnvelope" },
        signal: new AbortController().signal,
      },
      authorizationScope: ["data:read", "map:read"],
      sourceVersion: "v7",
    });

    expect(hashQueryIr(first)).toBe(hashQueryIr(second));
    expect(first.source.endpoint).toBe("https://demo.honua.io/FeatureServer");
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(Object.isFrozen(first.query.spatialFilter?.geometry)).toBe(true);
  });

  it("fails closed for malformed authority credentials while preserving safe relative paths", () => {
    const malformed = descriptor();
    malformed.locator.url = "https://user:password@example.test:bad/FeatureServer?token=secret";
    const malformedIr = createQueryIr({ descriptor: malformed, query: {} });
    expect(malformedIr.source.endpoint).toBe("[invalid-endpoint]");
    expect(JSON.stringify(malformedIr)).not.toContain("user");
    expect(JSON.stringify(malformedIr)).not.toContain("password");
    expect(JSON.stringify(malformedIr)).not.toContain("secret");

    const backslashAuthority = descriptor();
    backslashAuthority.locator.url = String.raw`https:\\user:backslash-password@example.test:bad\path?token=backslash-token`;
    const backslashIr = createQueryIr({ descriptor: backslashAuthority, query: {} });
    expect(backslashIr.source.endpoint).toBe("[invalid-endpoint]");
    expect(JSON.stringify(backslashIr)).not.toContain("backslash-password");
    expect(JSON.stringify(backslashIr)).not.toContain("backslash-token");

    const relative = descriptor();
    relative.locator.url = "fixtures/places.parquet?token=secret#fragment";
    expect(createQueryIr({ descriptor: relative, query: {} }).source.endpoint).toBe("fixtures/places.parquet");
  });

  it("never serializes credentials from GeoParquet execution sources", () => {
    const geoparquet: SourceDescriptor = {
      id: "places",
      protocol: "geoparquet",
      locator: {
        url: "https://user:primary-password@example.test/places.parquet?token=primary-token",
        geoparquet: {
          urls: ["https://other:additional-password@example.test/more.parquet?sig=additional-token"],
        },
      },
      capabilities: capabilities(["query"]),
    };

    expect(() => createQueryIr({ descriptor: geoparquet, query: {} })).toThrow(HonuaQueryPlanningError);
    try {
      createQueryIr({ descriptor: geoparquet, query: {} });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("primary-password");
      expect(JSON.stringify(error)).not.toContain("additional-password");
      expect(String(error)).not.toContain("primary-token");
      expect(String(error)).not.toContain("additional-token");
    }
  });

  it("rejects non-serializable geometry and invalid pagination", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      createQueryIr({
        descriptor: descriptor(),
        query: { spatialFilter: { geometry: cyclic, geometryType: "esriGeometryPoint" } },
      }),
    ).toThrowError(HonuaQueryPlanningError);
    expect(() => createQueryIr({ descriptor: descriptor(), query: { pagination: { limit: -1 } } })).toThrowError(
      /limit/,
    );
  });
});

describe("explainQuery", () => {
  it("compiles a complete aggregation to the existing GeoServices request path", () => {
    const plan = explainQuery({
      descriptor: descriptor(),
      query: aggregateQuery,
      schemaVersion: "schema-4",
      sourceVersion: "snapshot-9",
      authorizationScope: ["data:read"],
    });

    expect(plan.pushdown).toBe("full");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      operation: "queryAggregate",
      compiled: {
        compiler: "geoservices-rest-query-v1",
        serviceId: "incidents",
        layerId: 0,
        where: "status = 'open'",
        groupByFieldsForStatistics: "severity",
        returnGeometry: false,
        resultOffset: 1,
        resultRecordCount: 2,
      },
    });
    const remote = plan.steps[0];
    if (!remote || remote.engine !== "remote") throw new Error("expected a remote plan step");
    if (remote.compiled.compiler !== "geoservices-rest-query-v1") throw new Error("expected GeoServices compiler");
    expect(remote.compiled.outStatistics).toEqual([
      { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "incident_count" },
      { statisticType: "avg", onStatisticField: "duration", outStatisticFieldName: "average_duration" },
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("changes the fingerprint when policy-relevant context changes", () => {
    const base = { descriptor: descriptor(), query: { where: "1=1" } };
    expect(explainQuery({ ...base, sourceVersion: "one" }).fingerprint).not.toBe(
      explainQuery({ ...base, sourceVersion: "two" }).fingerprint,
    );
    expect(explainQuery({ ...base, authorizationScope: ["read"] }).fingerprint).not.toBe(
      explainQuery({ ...base, authorizationScope: ["admin"] }).fingerprint,
    );
  });

  it("requires an explicit degraded and bounded fallback", () => {
    expect(() => explainQuery({ descriptor: descriptor(false), query: aggregateQuery })).toThrowError(
      expect.objectContaining({ code: "capability-not-supported" }),
    );
    expect(() =>
      explainQuery({ descriptor: descriptor(false), query: aggregateQuery, capabilityPolicy: "degraded" }),
    ).toThrowError(expect.objectContaining({ code: "fallback-disabled" }));
  });

  it("plans remote filtering and one bounded local aggregate through the same plan", () => {
    const plan = explainQuery({
      descriptor: descriptor(false),
      query: aggregateQuery,
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 50, maxBytes: 20_000 },
      estimates: { rows: 40, bytes: 10_000 },
    });

    expect(plan.pushdown).toBe("partial");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      operation: "queryAll",
      query: {
        outFields: ["OBJECTID", "duration", "severity"],
        returnGeometry: false,
        pagination: { offset: 0, limit: 51 },
      },
      compiled: { resultOffset: 0, resultRecordCount: 51 },
    });
    expect(plan.steps[1]).toMatchObject({ engine: "client", operation: "aggregate", maxRows: 50, maxBytes: 20_000 });
  });

  it("rejects unsafe local budgets, known overflow, and unsupported aggregation variants", () => {
    expect(() =>
      explainQuery({
        descriptor: descriptor(false),
        query: aggregateQuery,
        capabilityPolicy: "degraded",
        fallback: { mode: "bounded-local", maxRows: MAX_LOCAL_MATERIALIZATION_ROWS + 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe-materialization" }));
    expect(() =>
      explainQuery({
        descriptor: descriptor(false),
        query: aggregateQuery,
        capabilityPolicy: "degraded",
        fallback: { mode: "bounded-local", maxRows: 10 },
        estimates: { rows: 11 },
      }),
    ).toThrowError(/exceeds/);
    expect(() =>
      explainQuery({
        descriptor: descriptor(),
        query: {
          aggregation: { metrics: [{ fn: "count", field: "OBJECTID" }], histogram: { field: "duration", bins: 5 } },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-query" }));
  });
});

describe("executeQueryPlan", () => {
  it("executes the accepted remote plan without replanning", async () => {
    const plan = explainQuery({ descriptor: descriptor(), query: aggregateQuery, sourceVersion: "v1" });
    const response: Result = { features: [], exceededTransferLimit: false, aggregateRows: [{ incident_count: 4 }] };
    const queryAggregate = vi.fn().mockResolvedValue(response);
    const execution = await executeQueryPlan(plan, fakeSource(descriptor(), { queryAggregate }), {
      sourceVersion: "v1",
    });

    expect(queryAggregate).toHaveBeenCalledOnce();
    expect(execution.planId).toBe(plan.id);
    expect(execution.result).toBe(response);
  });

  it("enforces the runtime bound before local aggregation", async () => {
    const plan = explainQuery({
      descriptor: descriptor(false),
      query: aggregateQuery,
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 3 },
    });
    const features = [
      feature({ OBJECTID: 1, severity: "low", duration: 2 }),
      feature({ OBJECTID: 2, severity: "high", duration: 10 }),
      feature({ OBJECTID: 3, severity: "high", duration: 20 }),
    ];
    const queryAll = vi.fn().mockResolvedValue({ features, exceededTransferLimit: false });
    const execution = await executeQueryPlan(plan, fakeSource(descriptor(false), { queryAll }));

    expect(queryAll).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: { offset: 0, limit: 4 }, returnGeometry: false }),
    );
    expect(execution.result.aggregateRows).toEqual([{ severity: "low", incident_count: 1, average_duration: 2 }]);
    expect(execution.result.degraded?.[0]?.capability).toBe("queryAggregate");
  });

  it("rejects overflow, transfer-limit, tampering, and context drift", async () => {
    const plan = explainQuery({
      descriptor: descriptor(false),
      query: { aggregation: { metrics: [{ fn: "count", field: "OBJECTID" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 2 },
      authorizationScope: ["read"],
      schemaVersion: "schema-one",
    });
    const overflow = fakeSource(descriptor(false), {
      queryAll: vi.fn().mockResolvedValue({
        features: [feature({ OBJECTID: 1 }), feature({ OBJECTID: 2 }), feature({ OBJECTID: 3 })],
        exceededTransferLimit: false,
      }),
    });
    await expect(
      executeQueryPlan(plan, overflow, { authorizationScope: ["read"], schemaVersion: "schema-one" }),
    ).rejects.toMatchObject({
      code: "unsafe-materialization",
    });
    const truncated = fakeSource(descriptor(false), {
      queryAll: vi.fn().mockResolvedValue({ features: [feature({ OBJECTID: 1 })], exceededTransferLimit: true }),
    });
    await expect(
      executeQueryPlan(plan, truncated, { authorizationScope: ["read"], schemaVersion: "schema-one" }),
    ).rejects.toMatchObject({
      code: "unsafe-materialization",
    });
    await expect(
      executeQueryPlan(plan, overflow, { authorizationScope: ["other"], schemaVersion: "schema-one" }),
    ).rejects.toMatchObject({
      code: "plan-context-mismatch",
    });
    await expect(
      executeQueryPlan(plan, overflow, { authorizationScope: ["read"], schemaVersion: "schema-two" }),
    ).rejects.toMatchObject({ code: "plan-context-mismatch" });

    const tampered = { ...plan, warnings: ["changed"] } as typeof plan;
    await expect(
      executeQueryPlan(tampered, overflow, { authorizationScope: ["read"], schemaVersion: "schema-one" }),
    ).rejects.toBeInstanceOf(HonuaQueryPlanExecutionError);
  });

  it("enforces the optional runtime byte ceiling", async () => {
    const plan = explainQuery({
      descriptor: descriptor(false),
      query: { aggregation: { metrics: [{ fn: "count", field: "OBJECTID" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 10, maxBytes: 10 },
    });
    const source = fakeSource(descriptor(false), {
      queryAll: vi.fn().mockResolvedValue({ features: [feature({ OBJECTID: 1 })], exceededTransferLimit: false }),
    });

    await expect(executeQueryPlan(plan, source)).rejects.toMatchObject({ code: "unsafe-materialization" });
  });
});

function feature(attributes: Record<string, unknown>) {
  return { attributes };
}

function fakeSource(
  sourceDescriptor: SourceDescriptor,
  overrides: Partial<Pick<Source, "query" | "queryAll" | "queryAggregate">> = {},
): Source {
  const unsupported = async () => {
    throw new Error("not used");
  };
  return {
    descriptor: sourceDescriptor,
    capabilities: sourceDescriptor.capabilities,
    query: overrides.query ?? unsupported,
    queryAll: overrides.queryAll ?? unsupported,
    queryAggregate: overrides.queryAggregate ?? unsupported,
    queryExtent: unsupported,
    async *stream() {},
    queryObjectIds: unsupported,
    applyEdits: unsupported,
    queryRelated: unsupported,
    attachments: { query: unsupported, list: unsupported, add: unsupported, update: unsupported, delete: unsupported },
    protocol: () => undefined,
    adapter: () => undefined,
  };
}
