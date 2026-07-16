import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ExecutableCrsBinding,
  ExecutableGeometryValue,
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
  readonly preciseAmount: string;
  readonly score: number;
  readonly optionalNote: string | null;
  readonly observedAt: TemporalValue<"instant">;
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

const point: ExecutableGeometryValue = {
  state: "present",
  geometry: { type: "Point", coordinates: [-157.86, 21.31] },
  crs: epsg4326,
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

function geoServicesSchema(): SourceSchemaV2 {
  return createSourceSchemaV2({
    fields: [
      field(
        "id",
        { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
        { path: ["OBJECTID"], nullability: "non-nullable", roles: ["primary-key", "feature-id"] },
      ),
      field("status", { kind: "string" }, { path: ['statüs"physical'] }),
      field(
        "preciseAmount",
        { kind: "decimal", precision: 18, scale: 4, jsonEncoding: "string" },
        { path: ["precise_amount"] },
      ),
      field("score", { kind: "float", bits: 64 }, { path: ["score_value"] }),
      field("optionalNote", { kind: "string" }, { path: ["optional_note"] }),
      field(
        "observedAt",
        { kind: "timestamp", unit: "microsecond", timezone: "utc" },
        { path: ["observed_at"], roles: ["time-instant"] },
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
          layout: "xy",
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
        protocol: "geoservices-feature-service",
        source: "FeatureServer/0",
      },
    ],
  });
}

function odataSchema(geometryNative = true): SourceSchemaV2 {
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
      field("status", { kind: "string" }, { path: ["Details", "Stātus"] }),
      field(
        "preciseAmount",
        { kind: "decimal", precision: 18, scale: 4, jsonEncoding: "string" },
        { path: ["PreciseAmount"] },
      ),
      field("score", { kind: "float", bits: 64 }, { path: ["Metrics", "Score"] }),
      field("optionalNote", { kind: "string" }, { path: ["Details", "OptionalNote"] }),
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
            ? [{ protocol: "odata", name: "Edm.GeographyPoint", path: ["Incident", "Location"] }]
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
          geometryTypes: { state: "known", type: "Point" },
          crs: epsg4326,
          layout: "xy",
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
      outFields: ["OBJECTID", 'statüs"physical', "precise_amount", "score_value", "optional_note"],
      returnGeometry: false,
      orderByFields: '"precise_amount" DESC',
      resultOffset: 7,
      resultRecordCount: 25,
      usesNativeFilter: false,
    });
    expect(artifact.where).toBe(
      '("statüs""physical" = \'Mālama\'\' OR 1=1 -- 東京\') AND ("precise_amount" = 1234567890123.5000) AND ("score_value" = 0.0000001) AND ("observed_at" > TIMESTAMP \'2026-07-14 12:34:56.123456\') AND ("optional_note" IS NULL)',
    );
    expect(artifact.fieldMappings).toEqual([
      { logicalField: "id", physicalPath: ["OBJECTID"], requestField: "OBJECTID" },
      { logicalField: "observedAt", physicalPath: ["observed_at"], requestField: "observed_at" },
      { logicalField: "optionalNote", physicalPath: ["optional_note"], requestField: "optional_note" },
      { logicalField: "preciseAmount", physicalPath: ["precise_amount"], requestField: "precise_amount" },
      { logicalField: "score", physicalPath: ["score_value"], requestField: "score_value" },
      { logicalField: "status", physicalPath: ['statüs"physical'], requestField: 'statüs"physical' },
    ]);
    const q = createSemanticQueryBuilder<Incident, "geoservices-feature-service", "primary-geometry">();
    const unfiltered = compiled(compileGeo(q.features({ select: ["id"] as const, geometry: "omit" })));
    expect(unfiltered.where).toBeUndefined();
    expect(JSON.stringify(unfiltered)).not.toContain("1=1");
    expect(Object.isFrozen(artifact)).toBe(true);
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
      "(Details/Stātus eq 'Mālama'' OR 1=1 -- 東京') and (PreciseAmount eq 1234567890123.5000) and (Metrics/Score eq 0.0000001) and (ObservedAt gt 2026-07-14T12:34:56.123456Z) and (Details/OptionalNote eq null)",
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
  });

  it("requires Edm geometry type, property CRS/layout, and geo.intersects source evidence", () => {
    const q = createSemanticQueryBuilder<Incident, "odata", "primary-geometry">();
    const query = q.features({
      select: ["id", "shape"] as const,
      geometry: { field: "shape" },
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: q.property("shape"),
        geometry: point,
      }),
      outputCrs: epsg4326.definition,
    });
    const artifact = compiled(compileOdata(query));
    expect(artifact).toMatchObject({
      select: ["IncidentId", "Location"],
      filter: "geo.intersects(Location,geography'SRID=4326;POINT (-157.86 21.31)')",
      outputGeometry: {
        field: "shape",
        propertyPath: "Location",
        spatialType: "geography",
        crs: epsg4326,
        layout: "xy",
      },
    });

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
        geometry: point,
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
});
