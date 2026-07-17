import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ExecutableBoundingBox,
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  GeometryFieldSchema,
  LogicalField,
  SourceSchemaV2,
} from "../src/contract/schema.js";
import {
  compileSemanticGeoServicesQuery,
  compileSemanticOdataQuery,
  createSemanticQueryBuilder,
  defineSpatialNode,
  temporalLiteral,
} from "../src/query-planner/index.js";
import type {
  SemanticCompilationResult,
  SemanticGeoServicesCompiledQueryV1,
  SemanticOdataCompiledQueryV1,
  SemanticQuery,
  TemporalValue,
} from "../src/query-planner/index.js";
import { HonuaQueryPlanningError } from "../src/query-planner/types.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";

interface Incident {
  readonly id: number;
  readonly status: string;
  readonly zulu: string;
  readonly äther: string;
  readonly preciseAmount: string;
  readonly score: number;
  readonly optionalNote: string | null;
  readonly reportedDate: TemporalValue<"date">;
  readonly localTime: string;
  readonly elapsed: string;
  readonly trackingId: string;
  readonly observedAt: TemporalValue<"instant">;
  readonly offsetAt: TemporalValue<"instant">;
  readonly shape: ExecutableGeometryValue;
}

const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/query-planner/semantic-geoservices-odata.v1.json", import.meta.url), "utf8"),
) as {
  readonly kind: "honua.semantic-query-equivalence-corpus";
  readonly version: 1;
  readonly cases: {
    readonly hostileUnicodeText: string;
    readonly preciseDecimal: string;
    readonly smallFloat: number;
    readonly instant: string;
  };
};

const epsg4326: ExecutableCrsBinding = {
  definition: {
    kind: "authority",
    authority: "EPSG",
    code: "4326",
    definitionAxisOrder: {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "latitude", direction: "north", unit: "degree" },
        { name: "longitude", direction: "east", unit: "degree" },
      ],
    },
  },
  coordinateOrder: {
    state: "known",
    source: "encoding",
    axes: [
      { name: "longitude", direction: "east", unit: "degree" },
      { name: "latitude", direction: "north", unit: "degree" },
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
        { name: "easting", direction: "east", unit: "metre" },
        { name: "northing", direction: "north", unit: "metre" },
      ],
    },
  },
  coordinateOrder: {
    state: "known",
    source: "encoding",
    axes: [
      { name: "easting", direction: "east", unit: "metre" },
      { name: "northing", direction: "north", unit: "metre" },
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
        [-158, 21],
        [-157, 21],
        [-157, 22],
        [-158, 22],
        [-158, 21],
      ],
    ],
  },
  crs: epsg4326,
  layout: "xy",
};

const bbox: ExecutableBoundingBox = {
  box: { layout: "xy", bounds: [-158, 21, -157, 22] },
  crs: epsg4326,
};

const projectedPoint: ExecutableGeometryValue = {
  state: "present",
  geometry: { type: "Point", coordinates: [-17_575_317, 2_427_237] },
  crs: epsg3857,
  layout: "xy",
};

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

function geoServicesSchema(
  geometryLayout: "xy" | "xyz" | "xym" | "xyzm" | "unknown" = "xy",
  statusPath = "statüs_physical",
  temporalNative = true,
): SourceSchemaV2 {
  return createSourceSchemaV2({
    fields: [
      field(
        "id",
        { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
        { path: ["OBJECTID"], nullability: "non-nullable", roles: ["primary-key", "feature-id"] },
      ),
      field("status", { kind: "string" }, { path: [statusPath] }),
      field("zulu", { kind: "string" }, { path: ["zulu_value"] }),
      field("äther", { kind: "string" }, { path: ["aether_value"] }),
      field(
        "preciseAmount",
        { kind: "decimal", precision: 18, scale: 4, jsonEncoding: "string" },
        { path: ["precise_amount"] },
      ),
      field("score", { kind: "float", bits: 64 }, { path: ["score_value"] }),
      field("optionalNote", { kind: "string" }, { path: ["optional_note"] }),
      field(
        "reportedDate",
        { kind: "date" },
        {
          path: ["reported_date"],
          native: temporalNative
            ? [
                {
                  protocol: "geoservices-feature-service",
                  name: "esriFieldTypeDateOnly",
                  path: ["FeatureServer", "0", "reported_date"],
                },
              ]
            : [],
        },
      ),
      field(
        "localTime",
        { kind: "time", unit: "microsecond" },
        {
          path: ["local_time"],
          native: temporalNative
            ? [
                {
                  protocol: "geoservices-feature-service",
                  name: "esriFieldTypeTimeOnly",
                  path: ["FeatureServer", "0", "local_time"],
                },
              ]
            : [],
        },
      ),
      field(
        "observedAt",
        { kind: "timestamp", unit: "microsecond", timezone: "utc" },
        {
          path: ["observed_at"],
          roles: ["time-instant"],
          native: temporalNative
            ? [
                {
                  protocol: "geoservices-feature-service",
                  name: "esriFieldTypeDate",
                  path: ["FeatureServer", "0", "observed_at"],
                },
              ]
            : [],
        },
      ),
      field(
        "offsetAt",
        { kind: "timestamp", unit: "microsecond", timezone: "offset" },
        {
          path: ["offset_at"],
          roles: ["time-instant"],
          native: temporalNative
            ? [
                {
                  protocol: "geoservices-feature-service",
                  name: "esriFieldTypeTimestampOffset",
                  path: ["FeatureServer", "0", "offset_at"],
                },
              ]
            : [],
        },
      ),
      field("shape", { kind: "geometry" }, { path: ["SHAPE"], roles: ["geometry"] }),
    ],
    key: { state: "known", fields: ["id"] },
    geometry: {
      state: "known",
      fields: [
        {
          field: "shape",
          geometryTypes: { state: "known", type: "Point" },
          crs: epsg4326,
          layout: geometryLayout,
          allowsEmpty: false,
        },
      ],
      primaryField: { state: "known", field: "shape" },
    },
    temporal: { state: "mixed", fields: ["observedAt", "offsetAt"] },
    openContent: "closed",
    provenance: [
      {
        method: "declared",
        protocol: "geoservices-feature-service",
        source: "FeatureServer/0",
      },
    ],
  });
}

function odataSchema(
  geometryNative = true,
  statusPath: readonly [string, ...string[]] = ["Details", "Stātus"],
  geometryNativeType = "Edm.GeographyPoint",
  geometryTypes: GeometryFieldSchema["geometryTypes"] = { state: "known", type: "Point" },
  geometryCrs: ExecutableCrsBinding = epsg4326,
  geometryLayout: GeometryFieldSchema["layout"] = "xy",
): SourceSchemaV2 {
  return createSourceSchemaV2({
    fields: [
      field(
        "id",
        { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
        {
          path: ["IncidentId"],
          nullability: "non-nullable",
          roles: ["primary-key", "feature-id"],
          native: [{ protocol: "odata", name: "Edm.Int32", path: ["Incident", "IncidentId"] }],
        },
      ),
      field("status", { kind: "string" }, { path: statusPath }),
      field("zulu", { kind: "string" }, { path: ["Details", "Zulu"] }),
      field("äther", { kind: "string" }, { path: ["Details", "Äther"] }),
      field(
        "preciseAmount",
        { kind: "decimal", precision: 18, scale: 4, jsonEncoding: "string" },
        { path: ["PreciseAmount"] },
      ),
      field("score", { kind: "float", bits: 64 }, { path: ["Metrics", "Score"] }),
      field("optionalNote", { kind: "string" }, { path: ["Details", "OptionalNote"] }),
      field("reportedDate", { kind: "date" }, { path: ["ReportedDate"] }),
      field("localTime", { kind: "time", unit: "second" }, { path: ["LocalTime"] }),
      field("elapsed", { kind: "duration", unit: "second" }, { path: ["Elapsed"] }),
      field("trackingId", { kind: "uuid" }, { path: ["TrackingId"] }),
      field(
        "observedAt",
        { kind: "timestamp", unit: "microsecond", timezone: "offset" },
        { path: ["ObservedAt"], roles: ["time-instant"] },
      ),
      field(
        "shape",
        { kind: "geometry" },
        {
          path: ["Location"],
          roles: ["geometry"],
          native: geometryNative
            ? [{ protocol: "odata", name: geometryNativeType, path: ["Incident", "Location"] }]
            : [],
        },
      ),
    ],
    key: { state: "known", fields: ["id"] },
    geometry: {
      state: "known",
      fields: [
        {
          field: "shape",
          geometryTypes,
          crs: geometryCrs,
          layout: geometryLayout,
          allowsEmpty: false,
        },
      ],
      primaryField: { state: "known", field: "shape" },
    },
    temporal: { state: "instant", field: "observedAt" },
    openContent: "closed",
    provenance: [{ method: "declared", protocol: "odata", source: "$metadata#Incidents" }],
  });
}

function geoQuery(status: string): SemanticQuery<Incident, "geoservices-feature-service", "primary-geometry"> {
  const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
  return q.features({
    select: ["id", "status", "preciseAmount", "score", "optionalNote"] as const,
    geometry: "omit",
    filter: q.and(
      q.comparison("eq", q.property("status"), status),
      q.comparison("eq", q.property("preciseAmount"), corpus.cases.preciseDecimal),
      q.comparison("eq", q.property("score"), corpus.cases.smallFloat),
      q.temporal("after", q.property("observedAt"), temporalLiteral("instant", corpus.cases.instant)),
      q.isNull(q.property("optionalNote"), "is-null"),
    ),
    sort: [{ field: "preciseAmount", direction: "desc", nulls: "native" }],
    page: { kind: "offset", offset: 7, limit: 25 },
  });
}

function compiled<T>(result: SemanticCompilationResult<T>): T {
  expect(result.outcome).toBe("compiled");
  if (result.outcome !== "compiled") throw new Error(result.diagnostics[0].message);
  return result.artifact;
}

function compileGeo(
  query: SemanticQuery<Incident, "geoservices-feature-service", "primary-geometry"> = geoQuery("open"),
  sourceVersion = "etag:7",
) {
  return compileSemanticGeoServicesQuery({
    query,
    schema: geoServicesSchema(),
    source: {
      protocol: "geoservices-feature-service",
      serviceId: "incidents",
      layerId: 0,
      sourceVersion,
      supportedSpatialRelationships: ["esriSpatialRelIntersects"],
      supportsAdvancedQueries: true,
      supportsPagination: true,
      supportsStatistics: true,
      supportsPaginationOnAggregatedQueries: true,
    },
  });
}

function odataQuery(status: string): SemanticQuery<Incident, "odata", "primary-geometry"> {
  const q = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
  return q.features({
    select: ["id", "status", "preciseAmount", "score", "optionalNote"] as const,
    geometry: "omit",
    filter: q.and(
      q.comparison("eq", q.property("status"), status),
      q.comparison("eq", q.property("preciseAmount"), corpus.cases.preciseDecimal),
      q.comparison("eq", q.property("score"), corpus.cases.smallFloat),
      q.temporal("after", q.property("observedAt"), temporalLiteral("instant", corpus.cases.instant)),
      q.isNull(q.property("optionalNote"), "is-null"),
    ),
    sort: [{ field: "score", direction: "asc", nulls: "native" }],
    page: { kind: "offset", offset: 7, limit: 25 },
  });
}

function compileOdata(
  query: SemanticQuery<Incident, "odata", "primary-geometry"> = odataQuery("open"),
  sourceVersion = "etag:7",
) {
  return compileSemanticOdataQuery({
    query,
    schema: odataSchema(),
    source: {
      entitySet: "Incidents",
      sourceVersion,
      supportedSpatialFunctions: ["geo.intersects"],
    },
  });
}

describe("semantic GeoServices and OData compilers", () => {
  it("quotes GeoServices identifiers and literals without changing the public-to-physical mapping", () => {
    expect(corpus).toMatchObject({ kind: "honua.semantic-query-equivalence-corpus", version: 1 });
    const hostile = corpus.cases.hostileUnicodeText;
    const artifact = compiled(compileGeo(geoQuery(hostile)));

    expect(artifact).toMatchObject({
      compiler: "geoservices-sql92-semantic-query-v1",
      dialect: "geoservices-sql92",
      serviceId: "incidents",
      layerId: 0,
      sourceVersion: "etag:7",
      sqlFormat: "standard",
      outFields: ["OBJECTID", "statüs_physical", "precise_amount", "score_value", "optional_note"],
      returnGeometry: false,
      orderByFields: '"precise_amount" DESC',
      resultOffset: 7,
      resultRecordCount: 25,
      usesNativeFilter: false,
    });
    expect(artifact.where).toBe(
      '("statüs_physical" = \'Mālama\'\' OR 1=1 -- 東京\') AND ("precise_amount" = 1234567890123.5000) AND ("score_value" = 0.0000001) AND ("observed_at" > TIMESTAMP \'2026-07-14 12:34:56\') AND ("optional_note" IS NULL)',
    );
    expect(artifact.fieldMappings).toEqual([
      { logicalField: "id", physicalPath: ["OBJECTID"], requestField: "OBJECTID" },
      { logicalField: "observedAt", physicalPath: ["observed_at"], requestField: "observed_at" },
      { logicalField: "optionalNote", physicalPath: ["optional_note"], requestField: "optional_note" },
      { logicalField: "preciseAmount", physicalPath: ["precise_amount"], requestField: "precise_amount" },
      { logicalField: "score", physicalPath: ["score_value"], requestField: "score_value" },
      { logicalField: "status", physicalPath: ["statüs_physical"], requestField: "statüs_physical" },
    ]);
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const unfiltered = compiled(compileGeo(q.features({ select: ["id"] as const, geometry: "omit" })));
    expect(unfiltered.where).toBeUndefined();
    expect(JSON.stringify(unfiltered)).not.toContain("1=1");
    expect(Object.isFrozen(artifact)).toBe(true);
  });

  it("gates GeoServices sorting, pagination, and statistics on exact layer evidence", () => {
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const featureQuery = q.features({
      select: ["id"] as const,
      geometry: "omit",
      sort: [{ field: "id", direction: "asc", nulls: "native" }],
      page: { kind: "offset", offset: 2, limit: 10 },
    });
    const source = {
      protocol: "geoservices-feature-service" as const,
      serviceId: "incidents",
      layerId: 0,
      supportsAdvancedQueries: true,
      supportsPagination: true,
      supportsStatistics: true,
      supportsPaginationOnAggregatedQueries: true,
    };

    expect(
      compileSemanticGeoServicesQuery({
        query: featureQuery,
        schema: geoServicesSchema(),
        source: { ...source, supportsAdvancedQueries: false },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.sort" }],
    });
    expect(
      compileSemanticGeoServicesQuery({
        query: featureQuery,
        schema: geoServicesSchema(),
        source: { ...source, supportsPagination: false },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.page" }],
    });

    const aggregateQuery = q.aggregate({
      groupBy: ["status"] as const,
      metrics: [{ fn: "count", field: "id", as: "incident_count" }],
      sort: [{ field: "status", direction: "asc", nulls: "native" }],
      page: { kind: "first", limit: 5 },
    });
    expect(
      compileSemanticGeoServicesQuery({
        query: aggregateQuery,
        schema: geoServicesSchema(),
        source: { ...source, supportsStatistics: false },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.metrics" }],
    });
    expect(
      compileSemanticGeoServicesQuery({
        query: aggregateQuery,
        schema: geoServicesSchema(),
        source: { ...source, supportsPaginationOnAggregatedQueries: false },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.page" }],
    });

    const artifact = compiled(
      compileSemanticGeoServicesQuery({ query: aggregateQuery, schema: geoServicesSchema(), source }),
    );
    expect(artifact).toMatchObject({
      returnGeometry: false,
      orderByFields: '"statüs_physical" ASC',
      resultRecordCount: 5,
      groupByFieldsForStatistics: "statüs_physical",
      outStatistics: [
        {
          statisticType: "count",
          onStatisticField: "OBJECTID",
          outStatisticFieldName: "incident_count",
        },
      ],
    });
    expect(Object.isFrozen(artifact.outStatistics)).toBe(true);
    expect(Object.isFrozen(artifact.outStatistics?.[0])).toBe(true);
  });

  it("uses exact GeoServices native temporal types and standardized literal forms", () => {
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const temporalQuery = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: q.and(
        q.comparison("eq", q.property("reportedDate"), "2026-07-14" as TemporalValue<"date">),
        q.comparison("eq", q.property("localTime"), "21:00:00"),
        q.temporal("after", q.property("offsetAt"), temporalLiteral("instant", "2003-01-25T14:35:00.927-08:00")),
      ),
    });
    const source = {
      protocol: "geoservices-feature-service" as const,
      serviceId: "incidents",
      layerId: 0,
    };
    const artifact = compiled(
      compileSemanticGeoServicesQuery({ query: temporalQuery, schema: geoServicesSchema(), source }),
    );
    expect(artifact.where).toBe(
      "(\"reported_date\" = DATE '2026-07-14') AND (\"local_time\" = TIME '21:00:00') AND (\"offset_at\" > TIMESTAMP '2003-01-25 14:35:00.927 -08:00')",
    );

    const noNativeEvidence = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: q.temporal("after", q.property("observedAt"), temporalLiteral("instant", "2026-07-14T12:34:56Z")),
    });
    expect(
      compileSemanticGeoServicesQuery({
        query: noNativeEvidence,
        schema: geoServicesSchema("xy", "statüs_physical", false),
        source,
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.filter.value.value" }],
    });

    const fidelityCases = [
      {
        query: q.features({
          select: ["id"] as const,
          geometry: "omit",
          filter: q.temporal("after", q.property("observedAt"), temporalLiteral("instant", "2026-07-14T12:34:56.123Z")),
        }),
        path: "$.filter.value.value",
      },
      {
        query: q.features({
          select: ["id"] as const,
          geometry: "omit",
          filter: q.temporal(
            "after",
            q.property("offsetAt"),
            temporalLiteral("instant", "2026-07-14T12:34:56.123456Z"),
          ),
        }),
        path: "$.filter.value.value",
      },
      {
        query: q.features({
          select: ["id"] as const,
          geometry: "omit",
          filter: q.comparison("eq", q.property("localTime"), "21:00:00.123"),
        }),
        path: "$.filter.right.value",
      },
    ];
    for (const fidelityCase of fidelityCases) {
      expect(
        compileSemanticGeoServicesQuery({ query: fidelityCase.query, schema: geoServicesSchema(), source }),
      ).toMatchObject({
        outcome: "unsupported",
        diagnostics: [{ code: "unsupported-field-type", path: fidelityCase.path }],
      });
    }
  });

  it("requires explicit spatial relationship, geometry-property, CRS, and layout evidence", () => {
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const query = q.features({
      select: ["id", "status"] as const,
      geometry: "include",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: q.property("shape"),
        geometry: point,
      }),
    });
    const supported = compiled(compileGeo(query));
    expect(supported).toMatchObject({
      geometry: { x: -157.86, y: 21.31 },
      geometryType: "esriGeometryPoint",
      inSr: { wkid: 4326 },
      spatialRel: "esriSpatialRelIntersects",
      returnGeometry: true,
    });

    const missingEvidence = compileSemanticGeoServicesQuery({
      query,
      schema: geoServicesSchema(),
      source: {
        protocol: "geoservices-feature-service",
        serviceId: "incidents",
        layerId: 0,
      },
    });
    expect(missingEvidence).toEqual({
      outcome: "unsupported",
      fidelity: "unsupported",
      diagnostics: [
        {
          code: "unsupported-source",
          path: "$.filter.operator",
          message: "Layer metadata does not explicitly advertise esriSpatialRelIntersects",
        },
      ],
    });

    const mismatchedCrs = compileGeo(
      q.features({
        select: ["id"] as const,
        geometry: "omit",
        filter: defineSpatialNode<Incident, "primary-geometry">({
          kind: "spatial",
          operator: "intersects",
          property: q.property("shape"),
          geometry: { ...point, crs: epsg3857 },
        }),
      }),
    );
    expect(mismatchedCrs).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "crs-transform-required", path: "$.filter.geometry.crs" }],
    });
  });

  it("preserves every known GeoServices output coordinate layout and rejects unknown layout", () => {
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const query = q.features({ select: ["id"] as const, geometry: "include" });
    const source = {
      protocol: "geoservices-feature-service" as const,
      serviceId: "incidents",
      layerId: 0,
    };
    for (const [layout, returnZ, returnM] of [
      ["xy", false, false],
      ["xyz", true, false],
      ["xym", false, true],
      ["xyzm", true, true],
    ] as const) {
      expect(
        compiled(compileSemanticGeoServicesQuery({ query, schema: geoServicesSchema(layout), source })),
      ).toMatchObject({ returnGeometry: true, returnZ, returnM });
    }
    expect(compileSemanticGeoServicesQuery({ query, schema: geoServicesSchema("unknown"), source })).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-projection", path: "$.geometry" }],
    });
  });

  it("allows only identity GeoServices output CRS without explicit transformation evidence", () => {
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const identity = compiled(
      compileGeo(
        q.features({
          select: ["id"] as const,
          geometry: "include",
          outputCrs: epsg4326.definition,
        }),
      ),
    );
    expect(identity).toMatchObject({ outSr: { wkid: 4326 }, returnGeometry: true, returnZ: false, returnM: false });

    const transform = compileGeo(
      q.features({
        select: ["id"] as const,
        geometry: "include",
        outputCrs: epsg3857.definition,
      }),
    );
    expect(transform).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "crs-transform-required", path: "$.outputCrs" }],
    });
  });

  it("quotes SQL-only physical fields but rejects ambiguous raw REST field parameters", () => {
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const source = {
      protocol: "geoservices-feature-service" as const,
      serviceId: "incidents",
      layerId: 0,
    };
    const sqlOnly = compiled(
      compileSemanticGeoServicesQuery({
        query: q.features({
          select: ["id"] as const,
          geometry: "omit",
          filter: q.comparison("eq", q.property("status"), "open"),
        }),
        schema: geoServicesSchema("xy", 'status"raw'),
        source,
      }),
    );
    expect(sqlOnly.where).toBe('"status""raw" = \'open\'');

    for (const physicalName of ['status"raw', "status,OBJECTID", "status DESC", "status other", "status\nother"]) {
      expect(
        compileSemanticGeoServicesQuery({
          query: q.features({ select: ["status"] as const, geometry: "omit" }),
          schema: geoServicesSchema("xy", physicalName),
          source,
        }),
      ).toMatchObject({
        outcome: "unsupported",
        diagnostics: [{ code: "unsupported-source", path: "$.select[0]" }],
      });
    }
  });

  it("fails closed for predicates GeoServices request parameters cannot preserve", () => {
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const caseInsensitive = compileGeo(
      q.features({
        select: ["id"] as const,
        geometry: "omit",
        filter: q.like(q.property("status"), "open%", { caseSensitive: false }),
      }),
    );
    expect(caseInsensitive).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.filter.caseSensitive" }],
    });

    const spatialOr = compileGeo(
      q.features({
        select: ["id"] as const,
        geometry: "omit",
        filter: q.or(
          q.comparison("eq", q.property("status"), "open"),
          defineSpatialNode<Incident, "primary-geometry">({
            kind: "spatial",
            operator: "intersects",
            geometry: point,
          }),
        ),
      }),
    );
    expect(spatialOr).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.filter" }],
    });
  });

  it("preserves only the matching native dialect and exposes canonical request identity", () => {
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const native = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: q.native("geoservices-sql92", { format: "text", text: "\"STATUS\" = 'OPEN'" }),
    });
    const first = compiled(compileGeo(native, "etag:7"));
    const repeated = compiled(compileGeo(native, "etag:7"));
    const changedVersion = compiled(compileGeo(native, "etag:8"));
    expect(first.where).toBe("\"STATUS\" = 'OPEN'");
    expect(first.usesNativeFilter).toBe(true);
    expect(first.requestFingerprint).toBe(repeated.requestFingerprint);
    expect(first.requestFingerprint).not.toBe(changedVersion.requestFingerprint);
    expect(first.queryFingerprint).toBe(changedVersion.queryFingerprint);

    const controlText = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: q.native("geoservices-sql92", { format: "text", text: "\"STATUS\" = 'OPEN'\n" }),
    });
    expect(compileGeo(controlText)).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-native-filter", path: "$.filter.payload.text" }],
    });

    expect(() =>
      compileSemanticGeoServicesQuery({
        query: {
          ...native,
          filter: { kind: "native", dialect: "odata-4.0", payload: { format: "text", text: "x" } },
        } as never,
        schema: geoServicesSchema(),
        source: {
          protocol: "geoservices-feature-service",
          serviceId: "incidents",
          layerId: 0,
        },
      }),
    ).toThrowError(HonuaQueryPlanningError);
  });

  it("compiles the shared adversarial corpus to exact nested OData paths and literals", () => {
    const artifact = compiled(compileOdata(odataQuery(corpus.cases.hostileUnicodeText)));

    expect(artifact).toMatchObject({
      compiler: "odata-v4-semantic-query-v1",
      dialect: "odata-4.0",
      entitySet: "Incidents",
      sourceVersion: "etag:7",
      select: ["IncidentId", "Details/Stātus", "PreciseAmount", "Metrics/Score", "Details/OptionalNote"],
      orderBy: ["Metrics/Score asc"],
      skip: 7,
      top: 25,
      usesNativeFilter: false,
    });
    expect(artifact.filter).toBe(
      "(Details/Stātus eq 'Mālama'' OR 1=1 -- 東京') and (PreciseAmount eq 1234567890123.5000) and (Metrics/Score eq 0.0000001) and (ObservedAt gt 2026-07-14T12:34:56Z) and (Details/OptionalNote eq null)",
    );
    expect(artifact.fieldMappings).toEqual([
      { logicalField: "id", physicalPath: ["IncidentId"], requestField: "IncidentId" },
      { logicalField: "observedAt", physicalPath: ["ObservedAt"], requestField: "ObservedAt" },
      {
        logicalField: "optionalNote",
        physicalPath: ["Details", "OptionalNote"],
        requestField: "Details/OptionalNote",
      },
      { logicalField: "preciseAmount", physicalPath: ["PreciseAmount"], requestField: "PreciseAmount" },
      { logicalField: "score", physicalPath: ["Metrics", "Score"], requestField: "Metrics/Score" },
      { logicalField: "status", physicalPath: ["Details", "Stātus"], requestField: "Details/Stātus" },
    ]);
    expect(Object.isFrozen(artifact)).toBe(true);

    const q = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
    const unfiltered = compiled(compileOdata(q.features({ select: ["id"] as const, geometry: "omit" })));
    expect(unfiltered.filter).toBeUndefined();
    expect(JSON.stringify(unfiltered)).not.toMatch(/(?:1\s+eq\s+1|true)/i);
  });

  it("fails closed for temporal-topology operators without native protocol equivalents", () => {
    const interval = temporalLiteral("interval", ["2026-07-14T00:00:00Z", "2026-07-15T00:00:00Z"]);
    const geo = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const odata = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();

    for (const operator of ["during", "time-intersects"] as const) {
      const geoResult = compileGeo(
        geo.features({
          select: ["id"] as const,
          geometry: "omit",
          filter: geo.temporal(operator, geo.property("observedAt"), interval),
        }),
      );
      const odataResult = compileOdata(
        odata.features({
          select: ["id"] as const,
          geometry: "omit",
          filter: odata.temporal(operator, odata.property("observedAt"), interval),
        }),
      );

      expect(geoResult).toMatchObject({
        outcome: "unsupported",
        diagnostics: [{ code: "unsupported-node", path: "$.filter.operator" }],
      });
      expect(odataResult).toMatchObject({
        outcome: "unsupported",
        diagnostics: [{ code: "unsupported-node", path: "$.filter.operator" }],
      });
    }
  });

  it("preserves OData v4.0 primitive literals and rejects non-v4 timestamps", () => {
    const q = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
    const literalQuery = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: q.and(
        q.comparison("eq", q.property("reportedDate"), "2026-07-14" as TemporalValue<"date">),
        q.comparison("eq", q.property("localTime"), "21:00:00"),
        q.comparison("eq", q.property("elapsed"), "PT1S"),
        q.comparison("eq", q.property("trackingId"), "123e4567-e89b-12d3-a456-426614174000"),
        q.temporal("after", q.property("observedAt"), temporalLiteral("instant", "2026-07-14T12:34:56.123456-10:00")),
      ),
    });
    const artifact = compiled(compileOdata(literalQuery));
    expect(artifact.filter).toBe(
      "(ReportedDate eq 2026-07-14) and (LocalTime eq 21:00:00) and (Elapsed eq duration'PT1S') and (TrackingId eq 123e4567-e89b-12d3-a456-426614174000) and (ObservedAt gt 2026-07-14T12:34:56.123456-10:00)",
    );

    const leapSecond = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: q.temporal("after", q.property("observedAt"), temporalLiteral("instant", "2016-12-31T23:59:60Z")),
    });
    expect(compileOdata(leapSecond)).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-field-type", path: "$.filter.value.value" }],
    });
  });

  it("orders Unicode field evidence by scalar value without locale-dependent collation", () => {
    const geo = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const geoArtifact = compiled(
      compileGeo(geo.features({ select: ["äther", "zulu", "status"] as const, geometry: "omit" })),
    );
    const odata = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
    const odataArtifact = compiled(
      compileOdata(odata.features({ select: ["äther", "zulu", "status"] as const, geometry: "omit" })),
    );

    expect(geoArtifact.fieldMappings.map((mapping) => mapping.logicalField)).toEqual(["status", "zulu", "äther"]);
    expect(odataArtifact.fieldMappings.map((mapping) => mapping.logicalField)).toEqual(["status", "zulu", "äther"]);
  });

  it("emits only the exact OData Point,Polygon geo.intersects signatures", () => {
    const q = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
    const query = q.features({
      select: ["id", "shape"] as const,
      geometry: { field: "shape" },
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: q.property("shape"),
        geometry: polygon,
      }),
      outputCrs: epsg4326.definition,
    });
    const artifact = compiled(compileOdata(query));
    expect(artifact).toMatchObject({
      select: ["IncidentId", "Location"],
      filter: "geo.intersects(Location,geography'SRID=4326;POLYGON ((-158 21, -157 21, -157 22, -158 22, -158 21))')",
      outputGeometry: {
        field: "shape",
        propertyPath: "Location",
        spatialType: "geography",
        crs: epsg4326,
        layout: "xy",
      },
    });
    expect(Object.isFrozen(artifact.outputGeometry)).toBe(true);
    expect(Object.isFrozen(artifact.outputGeometry?.crs)).toBe(true);

    const polygonPropertyQuery = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: q.property("shape"),
        geometry: point,
      }),
    });
    const polygonProperty = compiled(
      compileSemanticOdataQuery({
        query: polygonPropertyQuery,
        schema: odataSchema(true, ["Details", "Stātus"], "Edm.GeographyPolygon", { state: "known", type: "Polygon" }),
        source: { entitySet: "Incidents", supportedSpatialFunctions: ["geo.intersects"] },
      }),
    );
    expect(polygonProperty.filter).toBe("geo.intersects(geography'SRID=4326;POINT (-157.86 21.31)',Location)");

    const projectedPolygonProperty = compiled(
      compileSemanticOdataQuery({
        query: q.features({
          select: ["id"] as const,
          geometry: "omit",
          filter: defineSpatialNode<Incident, "primary-geometry">({
            kind: "spatial",
            operator: "intersects",
            property: q.property("shape"),
            geometry: projectedPoint,
          }),
        }),
        schema: odataSchema(
          true,
          ["Details", "Stātus"],
          "Edm.GeometryPolygon",
          { state: "known", type: "Polygon" },
          epsg3857,
        ),
        source: { entitySet: "Incidents", supportedSpatialFunctions: ["geo.intersects"] },
      }),
    );
    expect(projectedPolygonProperty.filter).toBe(
      "geo.intersects(geometry'SRID=3857;POINT (-17575317 2427237)',Location)",
    );

    const bboxQuery = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "bbox-intersects",
        property: q.property("shape"),
        bbox,
      }),
    });
    expect(compiled(compileOdata(bboxQuery)).filter).toBe(
      "geo.intersects(Location,geography'SRID=4326;POLYGON ((-158 21, -157 21, -157 22, -158 22, -158 21))')",
    );

    const missingFunction = compileSemanticOdataQuery({
      query,
      schema: odataSchema(),
      source: { entitySet: "Incidents" },
    });
    expect(missingFunction).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.filter.operator" }],
    });

    const filterOnly = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: q.property("shape"),
        geometry: polygon,
      }),
    });
    const missingNativeType = compileSemanticOdataQuery({
      query: filterOnly,
      schema: odataSchema(false),
      source: { entitySet: "Incidents", supportedSpatialFunctions: ["geo.intersects"] },
    });
    expect(missingNativeType).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.filter.property.name" }],
    });

    for (const schema of [
      odataSchema(true, ["Details", "Stātus"], "Edm.GeographyEvil"),
      odataSchema(true, ["Details", "Stātus"], "Edm.GeographyPolygon"),
    ]) {
      expect(
        compileSemanticOdataQuery({
          query: filterOnly,
          schema,
          source: { entitySet: "Incidents", supportedSpatialFunctions: ["geo.intersects"] },
        }),
      ).toMatchObject({
        outcome: "unsupported",
        diagnostics: [{ code: "unsupported-source", path: "$.filter.property.name" }],
      });
    }

    const mismatchedCrs = compileOdata(
      q.features({
        select: ["id"] as const,
        geometry: "omit",
        filter: defineSpatialNode<Incident, "primary-geometry">({
          kind: "spatial",
          operator: "intersects",
          property: q.property("shape"),
          geometry: { ...polygon, crs: epsg3857 },
        }),
      }),
    );
    expect(mismatchedCrs).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "crs-transform-required", path: "$.filter.geometry.crs" }],
    });
  });

  it("rejects OData spatial category, shape, layout, and ambiguous schema mismatches", () => {
    const q = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
    const source = { entitySet: "Incidents", supportedSpatialFunctions: ["geo.intersects"] as const };
    const spatialQuery = (geometry: ExecutableGeometryValue) =>
      q.features({
        select: ["id"] as const,
        geometry: "omit",
        filter: defineSpatialNode<Incident, "primary-geometry">({
          kind: "spatial",
          operator: "intersects",
          property: q.property("shape"),
          geometry,
        }),
      });

    for (const [query, schema, code, path] of [
      [spatialQuery(point), odataSchema(), "unsupported-geometry", "$.filter.geometry.geometry"],
      [
        spatialQuery(polygon),
        odataSchema(true, ["Details", "Stātus"], "Edm.GeographyPolygon", { state: "known", type: "Polygon" }),
        "unsupported-geometry",
        "$.filter.geometry.geometry",
      ],
      [
        spatialQuery(polygon),
        odataSchema(true, ["Details", "Stātus"], "Edm.Geography"),
        "unsupported-source",
        "$.filter.property.name",
      ],
      [
        spatialQuery(polygon),
        odataSchema(true, ["Details", "Stātus"], "Edm.GeographyPoint", { state: "mixed", types: ["Point", "Polygon"] }),
        "unsupported-source",
        "$.filter.property.name",
      ],
      [
        spatialQuery(polygon),
        odataSchema(true, ["Details", "Stātus"], "Edm.GeographyPoint", { state: "known", type: "Point" }, epsg3857),
        "unsupported-crs",
        "$.filter.property",
      ],
      [
        spatialQuery(polygon),
        odataSchema(true, ["Details", "Stātus"], "Edm.GeometryPoint", { state: "known", type: "Point" }, epsg4326),
        "unsupported-crs",
        "$.filter.property",
      ],
      [
        spatialQuery(polygon),
        odataSchema(
          true,
          ["Details", "Stātus"],
          "Edm.GeographyPoint",
          { state: "known", type: "Point" },
          epsg4326,
          "xym",
        ),
        "unsupported-geometry",
        "$.filter.property",
      ],
    ] as const) {
      expect(compileSemanticOdataQuery({ query, schema, source })).toMatchObject({
        outcome: "unsupported",
        diagnostics: [{ code, path }],
      });
    }

    const polygonBbox = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "bbox-intersects",
        property: q.property("shape"),
        bbox,
      }),
    });
    expect(
      compileSemanticOdataQuery({
        query: polygonBbox,
        schema: odataSchema(true, ["Details", "Stātus"], "Edm.GeographyPolygon", { state: "known", type: "Polygon" }),
        source,
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-geometry", path: "$.filter.property.name" }],
    });
  });

  it("keeps OData geometry output broader than exact spatial filtering", () => {
    const q = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
    const output = q.features({ select: ["id", "shape"] as const, geometry: { field: "shape" } });
    const generic = compiled(
      compileSemanticOdataQuery({
        query: output,
        schema: odataSchema(true, ["Details", "Stātus"], "Edm.Geography", {
          state: "mixed",
          types: ["Point", "Polygon"],
        }),
        source: { entitySet: "Incidents" },
      }),
    );
    expect(generic.outputGeometry).toMatchObject({ spatialType: "geography", crs: epsg4326, layout: "xy" });

    expect(
      compileSemanticOdataQuery({
        query: output,
        schema: odataSchema(true, ["Details", "Stātus"], "Edm.GeographyPoint", {
          state: "mixed",
          types: ["Point", "Polygon"],
        }),
        source: { entitySet: "Incidents" },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.select[1]" }],
    });

    const projected = compiled(
      compileSemanticOdataQuery({
        query: output,
        schema: odataSchema(
          true,
          ["Details", "Stātus"],
          "Edm.GeometryPoint",
          { state: "known", type: "Point" },
          epsg3857,
        ),
        source: { entitySet: "Incidents" },
      }),
    );
    expect(projected.outputGeometry).toMatchObject({ spatialType: "geometry", crs: epsg3857, layout: "xy" });
    expect(projected.requestFingerprint).not.toBe(generic.requestFingerprint);
    expect(projected.schemaFingerprint).not.toBe(generic.schemaFingerprint);
  });

  it("fails OData closed for always-true patterns, aggregation, and cross-dialect native text", () => {
    const q = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
    const pattern = compileOdata(
      q.features({
        select: ["id"] as const,
        geometry: "omit",
        filter: q.like(q.property("status"), "%"),
      }),
    );
    expect(pattern).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.filter.pattern" }],
    });

    const aggregate = compileOdata(
      q.aggregate({ groupBy: ["status"] as const, metrics: [{ fn: "count", field: "id", as: "count" }] }),
    );
    expect(aggregate).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.kind" }],
    });

    const unsafePhysicalPath = compileSemanticOdataQuery({
      query: odataQuery("open"),
      schema: odataSchema(true, ["Details", "status) or true"]),
      source: { entitySet: "Incidents" },
    });
    expect(unsafePhysicalPath).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.select[1]" }],
    });
    const oversizedPhysicalPath = compileSemanticOdataQuery({
      query: odataQuery("open"),
      schema: odataSchema(true, ["Details", `S${"t".repeat(128)}`]),
      source: { entitySet: "Incidents" },
    });
    expect(oversizedPhysicalPath).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.select[1]" }],
    });

    const native = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: q.native("odata-4.0", { format: "text", text: "Status eq 'OPEN'" }),
    });
    const first = compiled(compileOdata(native, "etag:7"));
    const repeated = compiled(compileOdata(native, "etag:7"));
    const changedVersion = compiled(compileOdata(native, "etag:8"));
    expect(first.filter).toBe("Status eq 'OPEN'");
    expect(first.usesNativeFilter).toBe(true);
    expect(first.requestFingerprint).toBe(repeated.requestFingerprint);
    expect(first.requestFingerprint).not.toBe(changedVersion.requestFingerprint);
    expect(first.queryFingerprint).toBe(changedVersion.queryFingerprint);

    const controlText = q.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: q.native("odata-4.0", { format: "text", text: "Status eq 'OPEN'\n" }),
    });
    expect(compileOdata(controlText)).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-native-filter", path: "$.filter.payload.text" }],
    });

    expect(() =>
      compileSemanticOdataQuery({
        query: {
          ...native,
          filter: {
            kind: "native",
            dialect: "geoservices-sql92",
            payload: { format: "text", text: "STATUS = 'OPEN'" },
          },
        } as never,
        schema: odataSchema(),
        source: { entitySet: "Incidents" },
      }),
    ).toThrowError(HonuaQueryPlanningError);
  });

  it("publishes the GeoServices artifact type from the query-planner surface", () => {
    expectTypeOf(compiled(compileGeo())).toMatchTypeOf<SemanticGeoServicesCompiledQueryV1>();
    expectTypeOf(compiled(compileOdata())).toMatchTypeOf<SemanticOdataCompiledQueryV1>();
  });

  it("keeps runtime peers out of both open-protocol semantic compiler modules", () => {
    const runtimePeerImport = /(?:from\s+|import\s*\(\s*)["'](?:@bufbuild\/|@connectrpc\/|@duckdb\/|maplibre-gl["'])/;
    for (const sourceUrl of [
      new URL("../src/query-planner/geoservices.ts", import.meta.url),
      new URL("../src/query-planner/odata.ts", import.meta.url),
      new URL("../src/query-planner/semantic-literals.ts", import.meta.url),
    ]) {
      expect(readFileSync(sourceUrl, "utf8")).not.toMatch(runtimePeerImport);
    }
  });
});
