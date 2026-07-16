import { readFile } from "node:fs/promises";

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ExecutableBoundingBox,
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  LogicalField,
  SourceSchemaV2,
} from "../src/contract/schema.js";
import {
  compileSemanticDuckDbQuery,
  compileSemanticGrpcQuery,
  createGeoParquetResourceHandle,
  createSemanticQueryBuilder,
  defineSpatialNode,
  temporalLiteral,
} from "../src/query-planner/index.js";
import type {
  SemanticCompilationResult,
  SemanticDuckDbCompiledQueryV1,
  SemanticDuckDbOutputGeometry,
  SemanticGrpcCompiledQueryV1,
  SemanticQuery,
  TemporalValue,
} from "../src/query-planner/index.js";
import { HonuaQueryPlanningError } from "../src/query-planner/types.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";

interface Incident {
  readonly id: number;
  readonly status: string;
  readonly active: boolean;
  readonly amount: number;
  readonly ratio: number;
  readonly preciseAmount: string;
  readonly observedAt: TemporalValue<"instant">;
  readonly shape: ExecutableGeometryValue;
}

const epsg4326: ExecutableCrsBinding = {
  definition: {
    kind: "authority",
    authority: "EPSG",
    code: "4326",
    definitionAxisOrder: {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "geodetic latitude", abbreviation: "Lat", direction: "north", unit: "degree" },
        { name: "geodetic longitude", abbreviation: "Lon", direction: "east", unit: "degree" },
      ],
    },
  },
  coordinateOrder: {
    state: "known",
    source: "encoding",
    axes: [
      { name: "longitude", abbreviation: "x", direction: "east", unit: "degree" },
      { name: "latitude", abbreviation: "y", direction: "north", unit: "degree" },
    ],
  },
  provenance: { method: "declared" },
};

const epsg3857: ExecutableCrsBinding = {
  definition: {
    kind: "authority",
    authority: "EPSG",
    code: "3857",
    definitionAxisOrder: {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "easting", abbreviation: "X", direction: "east", unit: "metre" },
        { name: "northing", abbreviation: "Y", direction: "north", unit: "metre" },
      ],
    },
  },
  coordinateOrder: {
    state: "known",
    source: "encoding",
    axes: [
      { name: "easting", abbreviation: "x", direction: "east", unit: "metre" },
      { name: "northing", abbreviation: "y", direction: "north", unit: "metre" },
    ],
  },
  provenance: { method: "declared" },
};

const point: ExecutableGeometryValue = {
  state: "present",
  geometry: { type: "Point", coordinates: [-157.86, 21.31] },
  crs: epsg4326,
  layout: "xy",
};

const polygon: ExecutableGeometryValue = {
  state: "present",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-158, 20],
        [-157, 20],
        [-157, 21],
        [-158, 21],
        [-158, 20],
      ],
    ],
  },
  crs: epsg4326,
  layout: "xy",
};

const bbox: ExecutableBoundingBox = {
  box: { layout: "xy", bounds: [-158, 20, -157, 21] },
  crs: epsg4326,
};

const resource = createGeoParquetResourceHandle({
  resolver: "io.honua.tests",
  id: "incidents",
  authorizationContextId: "tenant:alpha",
  resourceVersion: "snapshot:7",
});

function field(name: string, type: LogicalField["type"], overrides: Partial<LogicalField> = {}): LogicalField {
  return {
    name,
    path: [name],
    type,
    nullability: "nullable",
    mutability: "read-only",
    roles: [],
    domain: { state: "none", reason: type.kind === "geometry" ? "not-applicable" : "unconstrained" },
    constraints: { state: "none" },
    native: [],
    ...overrides,
  };
}

function schema(
  statusPath = 'status"raw',
  timestampUnit: "second" | "millisecond" | "microsecond" | "nanosecond" = "microsecond",
  geometryLayout: "xy" | "xyz" | "xym" | "xyzm" | "unknown" = "xy",
): SourceSchemaV2 {
  return createSourceSchemaV2({
    fields: [
      field(
        "id",
        { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
        {
          path: ["id_col"],
          nullability: "non-nullable",
          roles: ["primary-key", "feature-id"],
        },
      ),
      field("status", { kind: "string" }, { path: [statusPath] }),
      field("active", { kind: "boolean" }),
      field("amount", { kind: "decimal", precision: 12, scale: 2, jsonEncoding: "number" }),
      field("ratio", { kind: "float", bits: 64 }),
      field(
        "preciseAmount",
        { kind: "decimal", precision: 18, scale: 4, jsonEncoding: "string" },
        {
          path: ["precise_amount"],
        },
      ),
      field(
        "observedAt",
        { kind: "timestamp", unit: timestampUnit, timezone: "utc" },
        {
          path: ["observed_at"],
          roles: ["time-instant"],
        },
      ),
      field("shape", { kind: "geometry" }, { path: ['geom"wkb'], roles: ["geometry"] }),
    ],
    key: { state: "known", fields: ["id"] },
    geometry: {
      state: "known",
      fields: [
        {
          field: "shape",
          geometryTypes: { state: "mixed", types: ["Point", "Polygon"] },
          crs: epsg4326,
          layout: geometryLayout,
          allowsEmpty: false,
        },
      ],
      primaryField: { state: "known", field: "shape" },
    },
    temporal: { state: "instant", field: "observedAt" },
    openContent: "closed",
    provenance: [
      {
        method: "declared",
        protocol: "grpc",
        source: "honua.v1.FeatureService/QueryFeatures",
      },
    ],
  });
}

function nonSpatialSchema(fields: readonly LogicalField[]): SourceSchemaV2 {
  return createSourceSchemaV2({
    fields,
    key: { state: "none" },
    geometry: { state: "none", reason: "no-geometry-fields" },
    temporal: { state: "none" },
    openContent: "closed",
    provenance: [{ method: "declared", protocol: "grpc", source: "honua.v1.FeatureService/QueryFeatures" }],
  });
}

function attributeQuery<TProtocol extends "geoparquet" | "grpc">(status: string) {
  const query = createSemanticQueryBuilder<Incident, TProtocol, "primary-geometry">();
  return query.features({
    select: ["id", "status", "preciseAmount"] as const,
    geometry: "omit",
    filter: query.and(
      query.comparison("eq", query.property("status"), status),
      query.comparison("eq", query.property("preciseAmount"), "1234567890123.5000"),
      query.temporal("after", query.property("observedAt"), temporalLiteral("instant", "2026-07-14T12:34:56.123456Z")),
    ),
    sort: [{ field: "amount", direction: "desc", nulls: "native" }],
    page: { kind: "offset", offset: 7, limit: 25 },
  });
}

function spatialQuery<TProtocol extends "geoparquet" | "grpc">(geometry: ExecutableGeometryValue) {
  const query = createSemanticQueryBuilder<Incident, TProtocol, "primary-geometry">();
  return query.features({
    select: ["id", "status"] as const,
    geometry: "include",
    filter: defineSpatialNode<Incident, "primary-geometry">({
      kind: "spatial",
      operator: "intersects",
      property: query.property("shape"),
      geometry,
    }),
  });
}

function compiled<T>(result: SemanticCompilationResult<T>): T {
  expect(result.outcome).toBe("compiled");
  if (result.outcome !== "compiled") throw new Error(result.diagnostics[0].message);
  return result.artifact;
}

function duckDb(
  query: SemanticQuery<Incident, "geoparquet", "primary-geometry"> = attributeQuery<"geoparquet">("open"),
) {
  return compileSemanticDuckDbQuery({
    query,
    schema: schema(),
    resource,
    geometry: { field: "shape", encoding: "wkb", bboxColumn: "bbox" },
  });
}

function grpc(query: SemanticQuery<Incident, "grpc", "primary-geometry"> = attributeQuery<"grpc">("open")) {
  return compileSemanticGrpcQuery({
    query,
    schema: schema(),
    source: { serviceId: "incidents", layerId: 0 },
  });
}

describe("semantic DuckDB and Honua gRPC compilers", () => {
  it("compiles shared predicates without allowing literal values to change SQL or request grammar", () => {
    const adversarial = "x' OR 1=1 --";
    const safeDuckDb = compiled(duckDb(attributeQuery<"geoparquet">("open")));
    const hostileDuckDb = compiled(duckDb(attributeQuery<"geoparquet">(adversarial)));

    expect(hostileDuckDb.sqlTemplate).toBe(safeDuckDb.sqlTemplate);
    expect(hostileDuckDb.sqlTemplate).not.toContain(adversarial);
    expect(hostileDuckDb.sqlTemplate).toContain('"status""raw" = ?');
    expect(hostileDuckDb.sqlTemplate).toContain('"precise_amount" = CAST(? AS DECIMAL(18, 4))');
    expect(hostileDuckDb.sqlTemplate).toContain('"observed_at" > CAST(? AS TIMESTAMPTZ)');
    expect(hostileDuckDb.sqlTemplate).toContain("LIMIT 25 OFFSET 7");
    expect(hostileDuckDb.parameters.map((parameter) => parameter.value)).toEqual([
      adversarial,
      "1234567890123.5000",
      "2026-07-14T12:34:56.123456Z",
    ]);
    expect(hostileDuckDb.resource).toEqual(resource);
    expect(JSON.stringify(hostileDuckDb)).not.toContain("https://");

    const safeGrpc = compiled(grpc(attributeQuery<"grpc">("open")));
    const hostileGrpc = compiled(grpc(attributeQuery<"grpc">(adversarial)));
    expect(hostileGrpc).toMatchObject({
      compiler: "honua-grpc-semantic-query-v1",
      service: "honua.v1.FeatureService",
      method: "QueryFeatures",
      serviceId: "incidents",
      layerId: 0,
      outFields: ["id", "status", "preciseAmount"],
      returnGeometry: false,
      orderBy: "amount DESC",
      resultOffset: 7,
      resultRecordCount: 25,
      usesNativeFilter: false,
    });
    expect(hostileGrpc.where).toBe(
      "status = 'x'' OR 1=1 --' AND preciseAmount = 1234567890123.5000 AND observedAt > '2026-07-14T12:34:56.123456Z'",
    );
    expect(hostileGrpc.where?.replace("x'' OR 1=1 --", "open")).toBe(safeGrpc.where);
    expect(Object.keys(hostileGrpc).filter((key) => key !== "where" && key !== "queryFingerprint")).toEqual(
      Object.keys(safeGrpc).filter((key) => key !== "where" && key !== "queryFingerprint"),
    );
    expect(Object.isFrozen(hostileGrpc)).toBe(true);
  });

  it("emits public field names in the exact bounded grammar accepted by Honua Server", () => {
    const query = createSemanticQueryBuilder<Incident, "grpc", "primary-geometry">();
    const result = compileSemanticGrpcQuery({
      query: query.features({
        select: ["id", "status", "preciseAmount"] as const,
        geometry: "omit",
        filter: query.and(
          query.comparison("eq", query.property("status"), "open"),
          query.and(
            query.between(query.property("amount"), 10, 20),
            query.isNull(query.property("preciseAmount"), "is-not-null"),
          ),
          query.like(query.property("status"), "op%", { caseSensitive: true }),
          query.temporal(
            "during",
            query.property("observedAt"),
            temporalLiteral("interval", ["2026-07-14T00:00:00Z", "2026-07-15T00:00:00Z"]),
          ),
        ),
        sort: [{ field: "amount", direction: "asc", nulls: "native" }],
      }),
      schema: schema(),
      source: { serviceId: "incidents", layerId: 0 },
    });
    const artifact = compiled(result);

    expect(artifact.outFields).toEqual(["id", "status", "preciseAmount"]);
    expect(artifact.orderBy).toBe("amount ASC");
    expect(artifact.where).toBe(
      "status = 'open' AND amount >= 10 AND amount <= 20 AND preciseAmount IS NOT NULL AND status LIKE 'op%' AND observedAt >= '2026-07-14T00:00:00Z' AND observedAt <= '2026-07-15T00:00:00Z'",
    );
    const comparison =
      /^[a-zA-Z_][a-zA-Z0-9_]*\s*(?:NOT\s+LIKE|LIKE|>=|<=|!=|<>|=|>|<)\s*(?:'(?:''|[^'])*'|-?\d+(?:\.\d+)?)$/i;
    const nullCheck = /^[a-zA-Z_][a-zA-Z0-9_]*\s+IS\s+(?:NOT\s+)?NULL$/i;
    for (const clause of artifact.where?.split(" AND ") ?? []) {
      expect(comparison.test(clause) || nullCheck.test(clause)).toBe(true);
    }
    expect(artifact.where).not.toContain('"');
    expect(artifact.where).not.toContain("(");
    expect(artifact.where?.length).toBeLessThanOrEqual(4_000);
  });

  it("fails closed for semantic nodes and literals outside the server where grammar", () => {
    const query = createSemanticQueryBuilder<Incident, "grpc", "primary-geometry">();
    const statusOpen = query.comparison("eq", query.property("status"), "open");
    const cases = [
      { filter: query.inList(query.property("status"), ["open", "closed"]), path: "$.filter" },
      {
        filter: query.or(statusOpen, query.comparison("eq", query.property("status"), "closed")),
        path: "$.filter",
      },
      { filter: query.not(statusOpen), path: "$.filter" },
      { filter: query.like(query.property("status"), "op%", { caseSensitive: false }), path: "$.filter.caseSensitive" },
      { filter: query.comparison("eq", query.property("active"), true), path: "$.filter.right.value" },
      { filter: query.comparison("eq", query.property("ratio"), 1e21), path: "$.filter.right.value" },
      { filter: query.comparison("eq", query.property("status"), "open\nclosed"), path: "$.filter.right.value" },
    ] as const;

    for (const entry of cases) {
      expect(
        compileSemanticGrpcQuery({
          query: query.features({ geometry: "omit", filter: entry.filter as never }),
          schema: schema(),
          source: { serviceId: "incidents", layerId: 0 },
        }),
      ).toMatchObject({ outcome: "unsupported", diagnostics: [{ path: entry.path }] });
    }

    expect(
      compileSemanticGrpcQuery({
        query: query.features({
          geometry: "omit",
          filter: query.comparison("eq", query.property("status"), "x".repeat(4_000)),
        }),
        schema: schema(),
        source: { serviceId: "incidents", layerId: 0 },
      }),
    ).toMatchObject({ outcome: "unsupported", diagnostics: [{ code: "unsupported-node", path: "$.filter" }] });
  });

  it("rejects public names and aggregate shapes the server cannot resolve", () => {
    interface UnsafeRecord {
      readonly "unsafe-name": string;
    }
    const unsafeQuery = createSemanticQueryBuilder<UnsafeRecord, "grpc", "non-spatial">();
    const unsafe = compileSemanticGrpcQuery({
      query: unsafeQuery.features({ select: ["unsafe-name"] as const, geometry: "omit" }),
      schema: nonSpatialSchema([field("unsafe-name", { kind: "string" }, { path: ["safe_storage_name"] })]),
      source: { serviceId: "unsafe", layerId: 0 },
    });
    expect(unsafe).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.select[0]" }],
    });

    interface AmbiguousRecord {
      readonly Status: string;
      readonly status: string;
    }
    const ambiguousQuery = createSemanticQueryBuilder<AmbiguousRecord, "grpc", "non-spatial">();
    const ambiguous = compileSemanticGrpcQuery({
      query: ambiguousQuery.features({ select: ["status"] as const, geometry: "omit" }),
      schema: nonSpatialSchema([
        field("Status", { kind: "string" }, { path: ["status_upper"] }),
        field("status", { kind: "string" }, { path: ["status_lower"] }),
      ]),
      source: { serviceId: "ambiguous", layerId: 0 },
    });
    expect(ambiguous).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.select[0]" }],
    });

    interface ReservedRecord {
      readonly select: string;
    }
    const reservedQuery = createSemanticQueryBuilder<ReservedRecord, "grpc", "non-spatial">();
    const reserved = compileSemanticGrpcQuery({
      query: reservedQuery.features({
        geometry: "omit",
        filter: reservedQuery.comparison("eq", reservedQuery.property("select"), "value"),
      }),
      schema: nonSpatialSchema([field("select", { kind: "string" })]),
      source: { serviceId: "reserved", layerId: 0 },
    });
    expect(reserved).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.filter.left.name" }],
    });

    const aggregate = createSemanticQueryBuilder<Incident, "grpc", "primary-geometry">();
    expect(
      compileSemanticGrpcQuery({
        query: aggregate.aggregate({ groupBy: [], metrics: [{ fn: "count", as: "rows" }] as const }),
        schema: schema(),
        source: { serviceId: "incidents", layerId: 0 },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.metrics[0].field" }],
    });
    expect(
      compileSemanticGrpcQuery({
        query: aggregate.aggregate({
          groupBy: ["status"] as const,
          metrics: [{ fn: "count", field: "id", as: "Status" }] as const,
        }),
        schema: schema(),
        source: { serviceId: "incidents", layerId: 0 },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.metrics[0].as" }],
    });
  });

  it("preserves equivalent aggregation, grouping, filtering, and paging semantics", () => {
    const duck = createSemanticQueryBuilder<Incident, "geoparquet", "primary-geometry">();
    const honua = createSemanticQueryBuilder<Incident, "grpc", "primary-geometry">();
    const duckQuery = duck.aggregate({
      groupBy: ["status"] as const,
      metrics: [
        { fn: "count", field: "id", as: "incidents" },
        { fn: "avg", field: "amount", as: "meanAmount" },
      ] as const,
      filter: duck.comparison("eq", duck.property("status"), "open"),
      sort: [{ field: "status", direction: "asc", nulls: "native" }],
      page: { kind: "first", limit: 10 },
    });
    const grpcQuery = honua.aggregate({
      groupBy: ["status"] as const,
      metrics: [
        { fn: "count", field: "id", as: "incidents" },
        { fn: "avg", field: "amount", as: "meanAmount" },
      ] as const,
      filter: honua.comparison("eq", honua.property("status"), "open"),
      sort: [{ field: "status", direction: "asc", nulls: "native" }],
      page: { kind: "first", limit: 10 },
    });

    const duckArtifact = compiled(duckDb(duckQuery));
    const grpcArtifact = compiled(grpc(grpcQuery));
    expect(duckArtifact.sqlTemplate).toContain(
      'SELECT "status""raw" AS "status", count("id_col") AS "incidents", avg("amount") AS "meanAmount"',
    );
    expect(duckArtifact.sqlTemplate).toContain('WHERE "status""raw" = ? GROUP BY "status""raw"');
    expect(duckArtifact.sqlTemplate).toContain('ORDER BY "status""raw" ASC LIMIT 10');
    expect(grpcArtifact).toMatchObject({
      where: "status = 'open'",
      returnGeometry: false,
      orderBy: "status ASC",
      resultRecordCount: 10,
      groupBy: ["status"],
      outStatistics: [
        {
          statisticType: "STATISTIC_TYPE_COUNT",
          onStatisticField: "id",
          outStatisticFieldName: "incidents",
        },
        {
          statisticType: "STATISTIC_TYPE_AVG",
          onStatisticField: "amount",
          outStatisticFieldName: "meanAmount",
        },
      ],
    });

    expect(duckDb({ ...duckQuery, outputCrs: epsg4326.definition })).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-projection", path: "$.outputCrs" }],
    });
  });

  it("preserves exact geometry encoding, CRS, and topological relationship semantics", () => {
    const duckResult = compileSemanticDuckDbQuery({
      query: spatialQuery<"geoparquet">(point),
      schema: schema(),
      resource,
      geometry: { field: "shape", encoding: "wkb" },
    });
    const grpcResult = compileSemanticGrpcQuery({
      query: spatialQuery<"grpc">(point),
      schema: schema(),
      source: { serviceId: "incidents", layerId: 0 },
    });
    expect(duckResult).toMatchObject({
      outcome: "compiled",
      fidelity: "exact",
      losses: [],
      artifact: {
        outputGeometry: {
          sourceField: "shape",
          sourceEncoding: "wkb",
          resultField: "geometry",
          resultEncoding: "geojson",
          crs: epsg4326,
          layout: "xy",
        },
        spatial: [{ path: "$.filter", field: "shape", encoding: "wkb", strategy: "exact", crs: epsg4326 }],
        parameters: [{ position: 1, role: "geometry", logicalType: "geometry-json" }],
      },
    });
    const duckArtifact = compiled(duckResult);
    expect(duckArtifact.sqlTemplate).toContain('ST_AsGeoJSON(ST_GeomFromWKB("geom""wkb")) AS "geometry"');
    expect(duckArtifact.sqlTemplate).toContain('ST_Intersects(ST_GeomFromWKB("geom""wkb"), ST_GeomFromGeoJSON(?))');
    expect(duckArtifact.parameters[0]?.value).toBe(JSON.stringify(point.geometry));

    expect(grpcResult).toMatchObject({
      outcome: "compiled",
      fidelity: "exact",
      losses: [],
      artifact: {
        returnGeometry: true,
        spatialFilter: {
          geometry: { point: { x: -157.86, y: 21.31 } },
          spatialRelationship: "SPATIAL_RELATIONSHIP_INTERSECTS",
          spatialReference: { wkid: 4326 },
          crs: epsg4326,
        },
      },
    });
  });

  it("retains output geometry encoding and CRS even when no spatial predicate exists", () => {
    const query = createSemanticQueryBuilder<Incident, "geoparquet", "primary-geometry">();
    const artifact = compiled(
      compileSemanticDuckDbQuery({
        query: query.features({ select: ["id"] as const, geometry: "include" }),
        schema: schema(),
        resource,
        geometry: { field: "shape", encoding: "wkb" },
      }),
    );

    expect(artifact.spatial).toEqual([]);
    expect(artifact.outputGeometry).toEqual({
      sourceField: "shape",
      sourceEncoding: "wkb",
      resultField: "geometry",
      resultEncoding: "geojson",
      crs: epsg4326,
      layout: "xy",
    });
    expect(Object.isFrozen(artifact.outputGeometry)).toBe(true);
    expect(artifact.sqlTemplate).toContain('ST_AsGeoJSON(ST_GeomFromWKB("geom""wkb")) AS "geometry"');

    const omitted = compiled(
      compileSemanticDuckDbQuery({
        query: query.features({ select: ["id"] as const, geometry: "omit" }),
        schema: schema(),
        resource,
        geometry: { field: "shape", encoding: "wkb" },
      }),
    );
    expect(omitted).not.toHaveProperty("outputGeometry");
  });

  it("does not label measured or unknown DuckDB GeoJSON output layouts as exact", () => {
    const query = createSemanticQueryBuilder<Incident, "geoparquet", "primary-geometry">();
    for (const layout of ["xym", "xyzm", "unknown"] as const) {
      expect(
        compileSemanticDuckDbQuery({
          query: query.features({ select: ["id"] as const, geometry: "include" }),
          schema: schema('status"raw', "microsecond", layout),
          resource,
          geometry: { field: "shape", encoding: "wkb" },
        }),
      ).toMatchObject({
        outcome: "unsupported",
        diagnostics: [{ code: "unsupported-geometry", path: "$.geometry" }],
      });
    }
  });

  it("makes every opt-in geometry-envelope reduction an explicit fidelity loss", () => {
    const result = compileSemanticDuckDbQuery({
      query: spatialQuery<"geoparquet">(polygon),
      schema: schema(),
      resource,
      geometry: { field: "shape", encoding: "wkb", bboxColumn: "bbox" },
      spatialStrategy: "bbox-envelope",
    });
    expect(result).toMatchObject({
      outcome: "compiled",
      fidelity: "approximate",
      losses: [
        {
          code: "spatial-envelope-reduction",
          path: "$.filter",
        },
      ],
      artifact: {
        spatial: [{ field: "shape", encoding: "wkb", strategy: "bbox-envelope", crs: epsg4326 }],
        parameters: [
          { position: 1, role: "bbox", value: -158 },
          { position: 2, role: "bbox", value: 20 },
          { position: 3, role: "bbox", value: -157 },
          { position: 4, role: "bbox", value: 21 },
        ],
      },
    });
    const artifact = compiled(result);
    expect(artifact.sqlTemplate).toContain(
      '("bbox".xmax >= ? AND "bbox".ymax >= ? AND "bbox".xmin <= ? AND "bbox".ymin <= ?)',
    );
    expect(artifact.sqlTemplate).not.toContain("ST_GeomFromGeoJSON");
  });

  it("keeps a bbox predicate exact when a bbox covering column is only a prefilter", () => {
    const query = createSemanticQueryBuilder<Incident, "geoparquet", "primary-geometry">();
    const result = compileSemanticDuckDbQuery({
      query: query.features({
        geometry: "omit",
        filter: defineSpatialNode<Incident, "primary-geometry">({
          kind: "spatial",
          operator: "bbox-intersects",
          property: query.property("shape"),
          bbox,
        }),
      }),
      schema: schema(),
      resource,
      geometry: { field: "shape", encoding: "wkb", bboxColumn: "bbox" },
    });
    expect(result).toMatchObject({ outcome: "compiled", fidelity: "exact", losses: [] });
    const artifact = compiled(result);
    expect(artifact.parameters.map((parameter) => parameter.value)).toEqual([-158, 20, -157, 21, -158, 20, -157, 21]);
    expect(artifact.sqlTemplate).toContain(
      'AND ST_Intersects(ST_GeomFromWKB("geom""wkb"), ST_MakeEnvelope(?, ?, ?, ?))',
    );
  });

  it("returns stable path diagnostics instead of fabricating unsupported gRPC spatial requests", () => {
    const query = createSemanticQueryBuilder<Incident, "grpc", "primary-geometry">();
    const bboxResult = compileSemanticGrpcQuery({
      query: query.features({
        filter: defineSpatialNode<Incident, "primary-geometry">({
          kind: "spatial",
          operator: "bbox-intersects",
          property: query.property("shape"),
          bbox,
        }),
      }),
      schema: schema(),
      source: { serviceId: "incidents", layerId: 0 },
    });
    expect(bboxResult).toEqual({
      outcome: "unsupported",
      fidelity: "unsupported",
      diagnostics: [
        {
          code: "unsupported-geometry",
          path: "$.filter",
          message: "QueryFeatures has no envelope geometry message; bbox is not fabricated as a polygon",
        },
      ],
    });

    const mismatch = compileSemanticGrpcQuery({
      query: spatialQuery<"grpc">({
        state: "present",
        geometry: { type: "Point", coordinates: [-17_575_000, 2_425_000] },
        crs: epsg3857,
        layout: "xy",
      }),
      schema: schema(),
      source: { serviceId: "incidents", layerId: 0 },
    });
    expect(mismatch).toMatchObject({
      outcome: "unsupported",
      fidelity: "unsupported",
      diagnostics: [{ code: "crs-transform-required", path: "$.filter.geometry.crs" }],
    });
  });

  it("rejects spatial composition and pagination the QueryFeatures message cannot preserve", () => {
    const query = createSemanticQueryBuilder<Incident, "grpc", "primary-geometry">();
    const spatial = defineSpatialNode<Incident, "primary-geometry">({
      kind: "spatial",
      operator: "intersects",
      property: query.property("shape"),
      geometry: point,
    });
    const orResult = compileSemanticGrpcQuery({
      query: query.features({
        filter: query.or(spatial, query.comparison("eq", query.property("status"), "open")),
      }),
      schema: schema(),
      source: { serviceId: "incidents", layerId: 0 },
    });
    expect(orResult).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.filter" }],
    });

    const pageResult = compileSemanticGrpcQuery({
      query: query.features({ geometry: "omit", page: { kind: "offset", offset: 2_147_483_648 } }),
      schema: schema(),
      source: { serviceId: "incidents", layerId: 0 },
    });
    expect(pageResult).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.page.offset" }],
    });
  });

  it("retains matching native escape hatches but rejects cross-dialect expressions", () => {
    const duck = createSemanticQueryBuilder<Incident, "geoparquet", "primary-geometry">();
    const honua = createSemanticQueryBuilder<Incident, "grpc", "primary-geometry">();
    const duckResult = duckDb(
      duck.features({ geometry: "omit", filter: duck.native("duckdb-sql", { format: "text", text: "amount > 0" }) }),
    );
    const grpcResult = grpc(
      honua.features({
        geometry: "omit",
        filter: honua.native("honua-grpc", { format: "json", value: { where: "amount > 0" } }),
      }),
    );
    expect(compiled(duckResult)).toMatchObject({ usesNativeFilter: true });
    expect(compiled(duckResult).sqlTemplate).toContain("WHERE (amount > 0)");
    expect(compiled(grpcResult)).toMatchObject({ usesNativeFilter: true, where: "amount > 0" });

    const quotedAnd = grpc(
      honua.features({
        geometry: "omit",
        filter: honua.native("honua-grpc", {
          format: "json",
          value: { where: "status = 'x'' AND y' AND amount > 0" },
        }),
      }),
    );
    expect(compiled(quotedAnd)).toMatchObject({
      usesNativeFilter: true,
      where: "status = 'x'' AND y' AND amount > 0",
    });

    for (const where of [
      '"amount" > 0',
      "amount IN (1, 2)",
      "amount > 0 OR amount < 2",
      "amount > 1e3",
      "unknown > 0",
      "amount > 0\n",
    ]) {
      expect(
        grpc(
          honua.features({
            geometry: "omit",
            filter: honua.native("honua-grpc", { format: "json", value: { where } }),
          }),
        ),
      ).toMatchObject({ outcome: "unsupported", diagnostics: [{ code: "unsupported-native-filter" }] });
    }

    expect(() =>
      compileSemanticGrpcQuery({
        query: {
          kind: "features",
          geometry: "omit",
          filter: { kind: "native", dialect: "duckdb-sql", payload: { format: "text", text: "1=1" } },
        } as never,
        schema: schema(),
        source: { serviceId: "incidents", layerId: 0 },
      }),
    ).toThrow(HonuaQueryPlanningError);
  });

  it("fails malformed schema, resource, source, and options before constructing artifacts", () => {
    const query = attributeQuery<"geoparquet">("open");
    const forgedSchema = { ...schema(), fingerprint: `sha256:${"0".repeat(64)}` } as SourceSchemaV2;
    expect(() => compileSemanticDuckDbQuery({ query, schema: forgedSchema, resource })).toThrowError(
      expect.objectContaining({ code: "invalid-query" }),
    );
    expect(() =>
      compileSemanticDuckDbQuery({ query, schema: schema(), resource: { kind: "raw-url" } as never }),
    ).toThrowError(expect.objectContaining({ code: "invalid-query" }));
    expect(() =>
      compileSemanticDuckDbQuery({ query, schema: schema(), resource, spatialStrategy: "fast" as never }),
    ).toThrowError(expect.objectContaining({ code: "invalid-query" }));
    expect(() =>
      compileSemanticGrpcQuery({
        query: attributeQuery<"grpc">("open"),
        schema: schema(),
        source: { serviceId: "incidents\nother", layerId: 0 },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-query" }));

    expect(
      compileSemanticDuckDbQuery({
        query,
        schema: schema("status\nraw"),
        resource,
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.select[1]" }],
    });

    const honua = createSemanticQueryBuilder<Incident, "grpc", "primary-geometry">();
    expect(
      compiled(
        compileSemanticGrpcQuery({
          query: honua.features({ select: ["status"] as const, geometry: "omit" }),
          schema: schema("status.raw"),
          source: { serviceId: "incidents", layerId: 0 },
        }),
      ),
    ).toMatchObject({ outFields: ["status"] });

    expect(
      compileSemanticDuckDbQuery({
        query,
        schema: schema('status"raw', "nanosecond"),
        resource,
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-field-type", path: "$.filter.args[2].value.value" }],
    });
  });

  it("exposes discriminated, immutable compiler artifacts without runtime-peer types", () => {
    const duckResult = duckDb();
    const grpcResult = grpc();
    expectTypeOf(duckResult).toEqualTypeOf<SemanticCompilationResult<SemanticDuckDbCompiledQueryV1>>();
    expectTypeOf(grpcResult).toEqualTypeOf<SemanticCompilationResult<SemanticGrpcCompiledQueryV1>>();
    expectTypeOf<
      NonNullable<SemanticDuckDbCompiledQueryV1["outputGeometry"]>
    >().toEqualTypeOf<SemanticDuckDbOutputGeometry>();
    expect(Object.isFrozen(duckResult)).toBe(true);
    expect(Object.isFrozen(grpcResult)).toBe(true);
    if (duckResult.outcome === "compiled") {
      expect(Object.isFrozen(duckResult.artifact.parameters)).toBe(true);
      expect(Object.isFrozen(duckResult.artifact.resource)).toBe(true);
    }
  });

  it("keeps protobuf, Connect, and DuckDB runtimes out of the semantic compiler graph", async () => {
    const runtimePeerImport = /(?:from\s+|import\s*\(\s*)["'](?:@bufbuild|@connectrpc|@duckdb)\//;
    for (const sourceUrl of [
      new URL("../src/query-planner/duckdb.ts", import.meta.url),
      new URL("../src/query-planner/grpc.ts", import.meta.url),
      new URL("../src/query-planner/semantic-compiler.ts", import.meta.url),
    ]) {
      expect(await readFile(sourceUrl, "utf8")).not.toMatch(runtimePeerImport);
    }
  });
});
