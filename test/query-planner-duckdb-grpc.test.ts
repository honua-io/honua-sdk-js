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
      geoparquet: { geometryColumn: "geometry", geometryEncoding: "wkb" },
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

  it("refuses a hostile raw where before it reaches the plan artifact", () => {
    const marker = "duckdb-plan-where-marker";
    for (const where of [
      `name = '${marker}'; DROP TABLE parcels`,
      `name = '${marker}' OR 1=1 --`,
      `1=1 UNION SELECT '${marker}'`,
    ]) {
      let thrown: unknown;
      try {
        explainQuery({ descriptor: geoparquetDescriptor(), query: { where } });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, where).toBeInstanceOf(HonuaQueryPlanningError);
      expect((thrown as HonuaQueryPlanningError).code).toBe("invalid-query");
      expect(String(thrown)).toContain("GEOPARQUET_WHERE_");
      expect(String(thrown)).not.toContain(marker);
    }
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
      geometryEncoding: "wkb",
    });
  });

  it("throws HonuaQueryPlanningError instances, not bare errors", () => {
    expect(() => explainQuery({ descriptor: geoparquetDescriptor(), query: { outSr: 3857 } })).toThrow(
      HonuaQueryPlanningError,
    );
  });
});
