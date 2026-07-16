import { describe, expect, it, vi } from "vitest";

import { createDataset } from "../src/contract/source.js";
import type { Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { HonuaClient } from "../src/core/client.js";
import {
  compileOgcApiFeaturesQuery,
  createQueryIr,
  executeQueryPlan,
  explainQuery,
} from "../src/query-planner/index.js";

function descriptor(capabilityNames: readonly ("query" | "queryAggregate")[] = ["query"]): SourceDescriptor {
  return {
    id: "parcels",
    protocol: "ogc-features",
    locator: {
      url: "https://user:secret@features.example.test/api?token=secret#private",
      collectionId: "county/parcels",
    },
    capabilities: capabilities(capabilityNames),
    schema: { primaryKey: "parcel_id" },
  };
}

const query: Query = {
  where: "status = 'active'",
  outFields: ["parcel_id", "owner"],
  orderBy: [
    { field: "updated_at", direction: "desc" },
    { field: "parcel_id", direction: "asc" },
  ],
  spatialFilter: {
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelEnvelopeIntersects",
    geometry: { xmin: -158.4, ymin: 20.5, xmax: -157.6, ymax: 21.8 },
  },
  outSr: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
  pagination: { offset: 20, limit: 10 },
};

describe("OGC API Features query planner", () => {
  it("compiles the complete supported canonical request without I/O", () => {
    const plan = explainQuery({
      descriptor: descriptor(),
      query,
      sourceVersion: "snapshot-7",
      authorizationScope: ["features:read"],
    });

    expect(plan.pushdown).toBe("full");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      operation: "query",
      pushdown: "full",
      compiled: {
        compiler: "ogc-api-features-query-v1",
        collectionId: "county/parcels",
        filter: "status = 'active'",
        filterLang: "cql2-text",
        properties: ["parcel_id", "owner"],
        sortby: "-updated_at,parcel_id",
        bbox: "-158.4,20.5,-157.6,21.8",
        crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
        offset: 20,
        limit: 10,
      },
    });
    expect(plan.ir.source.endpoint).toBe("https://features.example.test/api");
    expect(JSON.stringify(plan)).not.toContain("secret");
  });

  it("produces a stable fingerprint for equivalent descriptor and query snapshots", () => {
    const first = explainQuery({ descriptor: descriptor(), query, authorizationScope: ["read", "inspect"] });
    const second = explainQuery({
      descriptor: descriptor(),
      query: structuredClone(query),
      authorizationScope: ["inspect", "read", "read"],
    });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.id).toBe(first.id);
  });

  it("executes the accepted plan unchanged and rejects source-context drift", async () => {
    const plan = explainQuery({ descriptor: descriptor(), query, sourceVersion: "v1" });
    const response: Result = { features: [], exceededTransferLimit: false };
    const execute = vi.fn().mockResolvedValue(response);
    const source = fakeSource(descriptor(), { query: execute });

    await expect(executeQueryPlan(plan, source, { sourceVersion: "v1" })).resolves.toMatchObject({
      planId: plan.id,
      fingerprint: plan.fingerprint,
      result: response,
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining(query));
    await expect(executeQueryPlan(plan, source, { sourceVersion: "v2" })).rejects.toMatchObject({
      code: "stale-plan",
      reason: "source-version-changed",
    });
  });

  it("supports bounded local aggregation while keeping OGC filtering and projection remote", () => {
    const plan = explainQuery({
      descriptor: descriptor(),
      query: {
        where: "status = 'active'",
        aggregation: {
          groupBy: ["district"],
          metrics: [{ fn: "count", field: "parcel_id", alias: "parcel_count" }],
        },
      },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 100 },
    });

    expect(plan.pushdown).toBe("partial");
    expect(plan.steps[0]).toMatchObject({
      operation: "queryAll",
      query: { pagination: { offset: 0, limit: 100 } },
      compiled: {
        compiler: "ogc-api-features-query-v1",
        collectionId: "county/parcels",
        filter: "status = 'active'",
        filterLang: "cql2-text",
        properties: ["district", "parcel_id"],
        offset: 0,
        limit: 101,
      },
    });
    expect(plan.steps[1]).toMatchObject({ operation: "aggregate", maxRows: 100 });
    expect(plan.warnings).toContainEqual(
      expect.objectContaining({
        code: "geometry-transfer-required",
        path: "$.steps[0].query.returnGeometry",
      }),
    );
  });

  it("keeps the bounded fallback explain request identical to the OGC wire lookahead", async () => {
    let observed: URL | undefined;
    const sourceDescriptor: SourceDescriptor = {
      ...descriptor(),
      locator: { url: "https://features.example.test", collectionId: "parcels" },
    };
    const client = new HonuaClient({
      baseUrl: sourceDescriptor.locator.url,
      fetchFn: vi.fn(async (input) => {
        observed = new URL(String(input));
        return new Response(
          JSON.stringify({
            type: "FeatureCollection",
            features: Array.from({ length: 101 }, (_, id) => ({
              type: "Feature",
              id,
              geometry: null,
              properties: { parcel_id: id, district: "a" },
            })),
          }),
          { status: 200, headers: { "content-type": "application/geo+json" } },
        );
      }),
    });
    const source = createDataset({
      id: "ogc",
      client,
      sources: [sourceDescriptor],
      skipCompatibilityCheck: true,
    }).source("parcels")!;
    const plan = explainQuery({
      descriptor: sourceDescriptor,
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 100 },
      query: {
        where: "status = 'active'",
        aggregation: { groupBy: ["district"], metrics: [{ fn: "count", field: "parcel_id" }] },
      },
    });

    await expect(executeQueryPlan(plan, source)).rejects.toMatchObject({ code: "unsafe-materialization" });
    expect(observed?.searchParams.get("limit")).toBe("101");
    expect(observed?.searchParams.get("filter-lang")).toBe("cql2-text");
    expect(plan.steps[0]).toMatchObject({
      query: { pagination: { limit: 100 } },
      compiled: { compiler: "ogc-api-features-query-v1", limit: 101 },
    });
  });

  it("rejects unsupported or weaker spatial semantics before execution", () => {
    const unsupportedGeometry = {
      ...query,
      spatialFilter: { geometryType: "esriGeometryPoint" as const, geometry: { x: -157, y: 21 } },
    };
    expect(() => explainQuery({ descriptor: descriptor(), query: unsupportedGeometry })).toThrowError(
      expect.objectContaining({ code: "unsupported-query" }),
    );

    const weakerRelationship = {
      ...query,
      spatialFilter: {
        geometryType: "esriGeometryEnvelope" as const,
        spatialRel: "esriSpatialRelWithin" as const,
        geometry: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
    };
    expect(() => explainQuery({ descriptor: descriptor(), query: weakerRelationship })).toThrowError(/cannot weaken/);

    const malformed = {
      ...query,
      spatialFilter: {
        geometryType: "esriGeometryEnvelope" as const,
        geometry: { xmin: 2, ymin: 0, xmax: 1, ymax: 1 },
      },
    };
    expect(() => explainQuery({ descriptor: descriptor(), query: malformed })).toThrowError(
      expect.objectContaining({ code: "invalid-query" }),
    );

    expect(() => explainQuery({ descriptor: descriptor(), query: { returnGeometry: false } })).toThrowError(
      /geometry-suppression/,
    );
    expect(() =>
      explainQuery({
        descriptor: descriptor(),
        query: {
          spatialFilter: {
            geometryType: "esriGeometryEnvelope",
            geometry: {
              xmin: 0,
              ymin: 0,
              xmax: 1,
              ymax: 1,
              spatialReference: { wkid: 3857 },
            },
          },
        },
      }),
    ).toThrowError(/default OGC bbox CRS/);

    expect(() =>
      explainQuery({
        descriptor: descriptor(),
        query: {
          spatialFilter: {
            geometryType: "esriGeometryEnvelope",
            geometry: {
              xmin: 0,
              ymin: 0,
              xmax: 1,
              ymax: 1,
              spatialReference: { wkid: 3857, latestWkid: 4326 },
            },
          },
        },
      }),
    ).toThrowError(/default OGC bbox CRS/);
  });

  it("rejects missing collection identity, the wrong compiler, and claimed remote aggregation", () => {
    const missingCollection = { ...descriptor(), locator: { url: "https://features.example.test" } };
    expect(() => explainQuery({ descriptor: missingCollection })).toThrowError(
      expect.objectContaining({ code: "invalid-query" }),
    );

    const geoservices = createQueryIr({
      descriptor: {
        id: "parcels",
        protocol: "geoservices-feature-service",
        locator: { url: "https://features.example.test", serviceId: "parcels", layerId: 0 },
        capabilities: capabilities(["query"]),
      },
    });
    expect(() => compileOgcApiFeaturesQuery(geoservices.source, geoservices.query)).toThrowError(
      expect.objectContaining({ code: "unsupported-compiler" }),
    );

    expect(() =>
      explainQuery({
        descriptor: descriptor(["query", "queryAggregate"]),
        query: { aggregation: { metrics: [{ fn: "count", field: "parcel_id" }] } },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-query" }));
  });
});

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
