import { describe, expect, it } from "vitest";

import type { Query, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import {
  HonuaQueryPlanningError,
  compileDuckDbQuery,
  compileGrpcQuery,
  createQueryIr,
  explainQuery,
} from "../src/query-planner/index.js";

function geoparquetDescriptor(): SourceDescriptor {
  return {
    id: "parcels",
    protocol: "geoparquet",
    locator: {
      url: "https://data.example.test/parcels.parquet",
      geoparquet: {
        geometryColumn: "geometry",
        geometryEncoding: "geoparquet-1.1-wkb",
        geometryExecution: "wkb",
        geometrySpatialRuntimeAvailable: true,
      },
    },
    capabilities: capabilities(["query", "queryAggregate", "stream"]),
    schema: { primaryKey: "id" },
  };
}

function grpcDescriptor(): SourceDescriptor {
  return {
    id: "incidents",
    protocol: "grpc",
    locator: { url: "grpc://user:secret@features.example.test", serviceId: "incidents", layerId: 0 },
    capabilities: capabilities(["query", "queryAggregate", "stream"]),
    schema: { primaryKey: "OBJECTID" },
  };
}

const envelope = {
  geometry: { xmin: -158, ymin: 20, xmax: -157, ymax: 21 },
  geometryType: "esriGeometryEnvelope" as const,
  spatialRel: "esriSpatialRelIntersects" as const,
};

describe("DuckDB SQL compiler", () => {
  it("compiles a filtered projection to golden read_parquet SQL", () => {
    const plan = explainQuery({
      descriptor: geoparquetDescriptor(),
      query: { where: "pop > 5", outFields: ["name", "pop"], returnGeometry: false, pagination: { limit: 10 } },
    });
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      operation: "query",
      pushdown: "full",
      compiled: {
        compiler: "duckdb-sql-v1",
        sources: ["https://data.example.test/parcels.parquet"],
        sql:
          'SELECT "name", "pop" FROM read_parquet(' +
          "'https://data.example.test/parcels.parquet', union_by_name = true, hive_partitioning = true) " +
          "WHERE (pop > 5) LIMIT 10",
      },
    });
  });

  it("pushes an envelope spatial filter down as ST_Intersects and projects geometry as GeoJSON", () => {
    const plan = explainQuery({
      descriptor: geoparquetDescriptor(),
      query: { spatialFilter: envelope, outFields: ["name"] },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote" || step.compiled.compiler !== "duckdb-sql-v1") {
      throw new Error("expected DuckDB remote step");
    }
    expect(step.compiled.sql).toContain(
      'ST_Intersects(ST_GeomFromWKB("geometry"), ST_MakeEnvelope(-158, 20, -157, 21))',
    );
    expect(step.compiled.sql).toContain('ST_AsGeoJSON(ST_GeomFromWKB("geometry")) AS "geometry"');
    expect(step.compiled.bboxApproximated).toBeUndefined();
  });

  it("compiles a bounded columnar spatial aggregation with GROUP BY", () => {
    const plan = explainQuery({
      descriptor: geoparquetDescriptor(),
      query: {
        spatialFilter: envelope,
        aggregation: { groupBy: ["region"], metrics: [{ fn: "count", field: "*", alias: "n" }] },
      },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote" || step.compiled.compiler !== "duckdb-sql-v1") {
      throw new Error("expected DuckDB aggregate step");
    }
    expect(step.operation).toBe("queryAggregate");
    expect(step.reason).toContain("spatial aggregation");
    expect(step.compiled.sql).toBe(
      'SELECT "region", count(*) AS "n" FROM read_parquet(' +
        "'https://data.example.test/parcels.parquet', union_by_name = true, hive_partitioning = true) " +
        'WHERE (ST_Intersects(ST_GeomFromWKB("geometry"), ST_MakeEnvelope(-158, 20, -157, 21))) GROUP BY "region"',
    );
  });

  it("marks a non-envelope spatial filter as a bbox approximation", () => {
    const plan = explainQuery({
      descriptor: geoparquetDescriptor(),
      query: {
        spatialFilter: {
          geometry: {
            rings: [
              [
                [-158, 20],
                [-157, 20],
                [-157, 21],
                [-158, 21],
                [-158, 20],
              ],
            ],
          },
          geometryType: "esriGeometryPolygon",
        },
        outFields: ["name"],
      },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote" || step.compiled.compiler !== "duckdb-sql-v1") {
      throw new Error("expected DuckDB remote step");
    }
    expect(step.compiled.bboxApproximated).toBe(true);
  });

  it("rejects a spatial filter with no geometry column and rejects outSr", () => {
    const noGeom: SourceDescriptor = {
      ...geoparquetDescriptor(),
      locator: { url: "https://data.example.test/parcels.parquet" },
    };
    expect(() => explainQuery({ descriptor: noGeom, query: { spatialFilter: envelope } })).toThrowError(
      expect.objectContaining({ code: "unsupported-query" }),
    );
    expect(() => explainQuery({ descriptor: geoparquetDescriptor(), query: { outSr: 3857 } })).toThrowError(
      expect.objectContaining({ code: "unsupported-query" }),
    );
  });

  it.each(["version-unsupported", "encoding-unsupported", "dimensions-unsupported"] as const)(
    "rejects %s geometry metadata before producing a DuckDB request",
    (reason) => {
      const blocked: SourceDescriptor = {
        ...geoparquetDescriptor(),
        locator: {
          url: "https://data.example.test/blocked.parquet",
          geoparquet: {
            geometryColumn: "geometry",
            geometryEncoding: "geoparquet-1.1-wkb",
            geometryUnsupportedReason: reason,
          },
        },
      };
      expect(() => explainQuery({ descriptor: blocked, query: { spatialFilter: envelope } })).toThrowError(
        expect.objectContaining({
          name: "HonuaQueryPlanningError",
          code: "unsupported-query",
          context: { reason },
        }),
      );
    },
  );

  it("requires an explicit executable identity instead of defaulting geometry to WKB", () => {
    const missingExecution: SourceDescriptor = {
      ...geoparquetDescriptor(),
      locator: {
        url: "https://data.example.test/missing-execution.parquet",
        geoparquet: { geometryColumn: "geometry", geometryEncoding: "geoparquet-1.1-wkb" },
      },
    };
    expect(() => explainQuery({ descriptor: missingExecution, query: {} })).toThrowError(
      expect.objectContaining({ context: { reason: "layout-unsupported" } }),
    );
  });

  it("preserves DuckDB-native SQL when versioned WKB was rehydrated by the runtime", () => {
    const rehydrated: SourceDescriptor = {
      ...geoparquetDescriptor(),
      locator: {
        url: "https://data.example.test/rehydrated.parquet",
        geoparquet: {
          geometryColumn: "geometry",
          geometryEncoding: "geoparquet-1.1-wkb",
          geometryExecution: "duckdb-native",
          geometrySpatialRuntimeAvailable: true,
        },
      },
    };
    const plan = explainQuery({ descriptor: rehydrated, query: { spatialFilter: envelope } });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote" || step.compiled.compiler !== "duckdb-sql-v1") {
      throw new Error("expected DuckDB remote step");
    }
    expect(step.compiled).toMatchObject({
      geometryEncoding: "geoparquet-1.1-wkb",
      geometryExecution: "duckdb-native",
    });
    expect(step.compiled.sql).toContain('ST_Intersects("geometry", ST_MakeEnvelope(-158, 20, -157, 21))');
    expect(step.compiled.sql).toContain('ST_AsGeoJSON("geometry") AS "geometry"');
    expect(step.compiled.sql).not.toContain("ST_GeomFromWKB");
  });

  it("does not accept a GeoParquet 1.1 native identity as DuckDB-native execution", () => {
    const native: SourceDescriptor = {
      ...geoparquetDescriptor(),
      locator: {
        url: "https://data.example.test/native.parquet",
        geoparquet: {
          geometryColumn: "geometry",
          geometryEncoding: "geoparquet-1.1-native-point",
          geometryExecution: "duckdb-native",
          geometrySpatialRuntimeAvailable: true,
        },
      },
    };
    expect(() => explainQuery({ descriptor: native, query: {} })).toThrowError(
      expect.objectContaining({ context: { reason: "encoding-unsupported" } }),
    );
  });

  it("plans bbox-only attributes without spatial functions and blocks geometry projection", () => {
    const bboxOnly: SourceDescriptor = {
      ...geoparquetDescriptor(),
      locator: {
        url: "https://data.example.test/bbox-only.parquet",
        geoparquet: {
          geometryColumn: "geometry",
          geometryEncoding: "geoparquet-1.1-wkb",
          geometryExecution: "wkb",
          geometrySpatialRuntimeAvailable: false,
          bboxColumn: "bbox",
        },
      },
    };
    const plan = explainQuery({
      descriptor: bboxOnly,
      query: { spatialFilter: envelope, returnGeometry: false },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote" || step.compiled.compiler !== "duckdb-sql-v1") {
      throw new Error("expected DuckDB remote step");
    }
    expect(step.compiled.sql).toContain('"bbox".xmin <= -157');
    expect(step.compiled.sql).not.toContain("ST_");
    expect(() => explainQuery({ descriptor: bboxOnly, query: { spatialFilter: envelope } })).toThrowError(
      expect.objectContaining({ context: { reason: "spatial-runtime-unavailable" } }),
    );
  });
});

describe("gRPC FeatureService compiler", () => {
  it("compiles filtering, projection, spatial predicate, sorting, and paging", () => {
    const plan = explainQuery({
      descriptor: grpcDescriptor(),
      query: {
        where: "status = 'A'",
        outFields: ["id", "status"],
        spatialFilter: envelope,
        orderBy: [{ field: "id", direction: "desc" }],
        pagination: { offset: 5, limit: 25 },
      },
    });
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      operation: "query",
      compiled: {
        compiler: "honua-grpc-query-features-v1",
        service: "honua.v1.FeatureService",
        method: "QueryFeatures",
        serviceId: "incidents",
        layerId: 0,
        where: "status = 'A'",
        outFields: ["id", "status"],
        orderBy: "id DESC",
        resultOffset: 5,
        resultRecordCount: 25,
        spatialFilter: {
          geometryType: "esriGeometryEnvelope",
          spatialRelationship: "SPATIAL_RELATIONSHIP_INTERSECTS",
        },
      },
    });
    expect(JSON.stringify(plan)).not.toContain("secret");
  });

  it("compiles a server-pushdown spatial aggregation to outStatistics + groupBy", () => {
    const plan = explainQuery({
      descriptor: grpcDescriptor(),
      query: {
        spatialFilter: envelope,
        aggregation: {
          groupBy: ["severity"],
          metrics: [{ fn: "count", field: "OBJECTID", alias: "incident_count" }],
        },
      },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote" || step.compiled.compiler !== "honua-grpc-query-features-v1") {
      throw new Error("expected gRPC aggregate step");
    }
    expect(step.operation).toBe("queryAggregate");
    expect(step.pushdown).toBe("full");
    expect(step.reason).toContain("spatial aggregation");
    expect(step.compiled).toMatchObject({
      returnGeometry: false,
      groupBy: ["severity"],
      outStatistics: [
        {
          statisticType: "STATISTIC_TYPE_COUNT",
          onStatisticField: "OBJECTID",
          outStatisticFieldName: "incident_count",
        },
      ],
      spatialFilter: { spatialRelationship: "SPATIAL_RELATIONSHIP_INTERSECTS" },
    });
  });

  it("guards protocol and required locator identity", () => {
    const grpc = createQueryIr({ descriptor: grpcDescriptor() });
    expect(() => compileDuckDbQuery(grpc.source, grpc.query)).toThrowError(
      expect.objectContaining({ code: "unsupported-compiler" }),
    );
    const geoparquet = createQueryIr({ descriptor: geoparquetDescriptor() });
    expect(() => compileGrpcQuery(geoparquet.source, geoparquet.query)).toThrowError(
      expect.objectContaining({ code: "unsupported-compiler" }),
    );
  });
});

describe("plan determinism across the new compilers", () => {
  it("produces identical fingerprints for identical inputs", () => {
    const build = (): Query => ({ where: "pop > 5", pagination: { limit: 3 } });
    const a = explainQuery({ descriptor: geoparquetDescriptor(), query: build() });
    const b = explainQuery({ descriptor: geoparquetDescriptor(), query: build() });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^sha256:/);
    expect(a.ir.source.geoparquet).toMatchObject({
      sources: ["https://data.example.test/parcels.parquet"],
      geometryColumn: "geometry",
      geometryEncoding: "geoparquet-1.1-wkb",
      geometryExecution: "wkb",
    });
  });

  it("throws HonuaQueryPlanningError instances, not bare errors", () => {
    expect(() => explainQuery({ descriptor: geoparquetDescriptor(), query: { outSr: 3857 } })).toThrow(
      HonuaQueryPlanningError,
    );
  });
});
