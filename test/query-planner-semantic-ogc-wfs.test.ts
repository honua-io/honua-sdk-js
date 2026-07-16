import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  LogicalField,
  SourceSchemaV2,
} from "../src/contract/schema.js";
import {
  compileSemanticOgcApiFeaturesQuery,
  createSemanticQueryBuilder,
  defineSpatialNode,
  temporalLiteral,
} from "../src/query-planner/index.js";
import type {
  SemanticCompilationResult,
  SemanticOgcApiFeaturesCompiledQueryV1,
  SemanticQuery,
  TemporalValue,
} from "../src/query-planner/index.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";

interface Incident {
  readonly id: number;
  readonly status: string;
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

const point: ExecutableGeometryValue = {
  state: "present",
  geometry: { type: "Point", coordinates: [-157.86, 21.31] },
  crs: epsg4326,
  layout: "xy",
};

function field(name: string, type: LogicalField["type"], path = name): LogicalField {
  return {
    name,
    path: [path],
    type,
    nullability: "nullable",
    mutability: "read-only",
    roles: type.kind === "geometry" ? ["geometry"] : [],
    domain: { state: "none", reason: type.kind === "geometry" ? "not-applicable" : "unconstrained" },
    constraints: { state: "none" },
    native: [],
  };
}

function schema(statusPath = "status"): SourceSchemaV2 {
  return createSourceSchemaV2({
    fields: [
      { ...field("id", { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" }), roles: [] },
      field("status", { kind: "string" }, statusPath),
      { ...field("observedAt", { kind: "timestamp", unit: "microsecond", timezone: "utc" }), roles: ["time-instant"] },
      field("shape", { kind: "geometry" }),
    ],
    key: { state: "none" },
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
    provenance: [{ method: "declared", protocol: "ogc-features", source: "test queryables" }],
  });
}

const baseConformance = [
  "http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/features-filter",
  "http://www.opengis.net/spec/cql2/1.0/conf/basic-cql2",
] as const;

const fullConformance = [
  ...baseConformance,
  "http://www.opengis.net/spec/cql2/1.0/conf/cql2-json",
  "http://www.opengis.net/spec/cql2/1.0/conf/cql2-text",
  "http://www.opengis.net/spec/cql2/1.0/conf/advanced-comparison-operators",
  "http://www.opengis.net/spec/cql2/1.0/conf/case-insensitive-comparison",
  "http://www.opengis.net/spec/cql2/1.0/conf/basic-spatial-functions",
  "http://www.opengis.net/spec/cql2/1.0/conf/spatial-functions",
  "http://www.opengis.net/spec/cql2/1.0/conf/temporal-functions",
] as const;

const epsg4326Uri = "http://www.opengis.net/def/crs/EPSG/0/4326";

function query(status: string): SemanticQuery<Incident, "ogc-features", "primary-geometry"> {
  const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
  return builder.features({
    select: ["id", "status"] as const,
    geometry: "include",
    filter: builder.and(
      builder.comparison("eq", builder.property("status"), status),
      builder.isNull(builder.property("status"), "is-not-null"),
      builder.temporal(
        "after",
        builder.property("observedAt"),
        temporalLiteral("instant", "2026-07-15T12:34:56.123456Z"),
      ),
      defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: builder.property("shape"),
        geometry: point,
      }),
    ),
    sort: [{ field: "id", direction: "desc", nulls: "native" }],
    page: { kind: "offset", offset: 5, limit: 25 },
  });
}

function compile(
  semanticQuery: SemanticQuery<Incident, "ogc-features", "primary-geometry"> = query("open"),
  options: {
    readonly preferredFilterLanguage?: "cql2-json" | "cql2-text";
    readonly conformsTo?: readonly string[];
    readonly sourceSchema?: SourceSchemaV2;
  } = {},
) {
  return compileSemanticOgcApiFeaturesQuery({
    query: semanticQuery,
    schema: options.sourceSchema ?? schema(),
    source: { collectionId: "incidents" },
    conformance: {
      conformsTo: options.conformsTo ?? fullConformance,
      supportedFilterCrs: [epsg4326Uri],
    },
    ...(options.preferredFilterLanguage ? { preferredFilterLanguage: options.preferredFilterLanguage } : {}),
  });
}

function compiled<T>(result: SemanticCompilationResult<T>): T {
  expect(result.outcome, JSON.stringify(result)).toBe("compiled");
  if (result.outcome !== "compiled") throw new Error(result.diagnostics[0].message);
  return result.artifact;
}

describe("semantic OGC API Features CQL2 compiler", () => {
  it("uses only explicit conformance and chooses canonical JSON deterministically", () => {
    const artifact = compiled(compile(query("x' OR 1=1 --")));
    expect(artifact).toMatchObject({
      compiler: "ogc-api-features-semantic-query-v1",
      dialect: "cql2-json",
      collectionId: "incidents",
      filterLang: "cql2-json",
      filterCrs: epsg4326Uri,
      properties: ["id", "status"],
      sortby: "-id",
      offset: 5,
      limit: 25,
      usesNativeFilter: false,
    });
    const parsed = JSON.parse(artifact.filter ?? "") as Record<string, unknown>;
    expect(JSON.stringify(parsed)).toContain("x' OR 1=1 --");
    expect(artifact.filter).toContain('"coordinates":[21.31,-157.86]');
    expect(artifact.filter).toContain('"timestamp":"2026-07-15T12:34:56.123456Z"');
    expect(artifact.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const reordered = compiled(compile(query("open"), { conformsTo: [...fullConformance].reverse() }));
    expect(reordered.capabilityFingerprint).toBe(compiled(compile(query("open"))).capabilityFingerprint);
    expect(reordered.requestFingerprint).toBe(compiled(compile(query("open"))).requestFingerprint);
  });

  it("emits escaped CQL2 text while keeping values and Unicode as data", () => {
    const artifact = compiled(compile(query("O'Reilly\\line\nMālama 世界"), { preferredFilterLanguage: "cql2-text" }));
    expect(artifact.dialect).toBe("cql2-text");
    expect(artifact.filter).toContain("status = 'O''Reilly\\\\line\\nMālama 世界'");
    expect(artifact.filter).toContain("TIMESTAMP('2026-07-15T12:34:56.123456Z')");
    expect(artifact.filter).toContain("POINT (21.31 -157.86)");
  });

  it("keeps adversarial property names structural in JSON and refuses them in text", () => {
    const unsafeSchema = schema('status" ) OR TRUE OR ( "x');
    const json = compiled(compile(query("open"), { sourceSchema: unsafeSchema }));
    const parsed = JSON.parse(json.filter ?? "") as { readonly op: string; readonly args: readonly unknown[] };
    expect(parsed.op).toBe("and");
    expect(parsed.args[0]).toEqual({
      op: "=",
      args: [{ property: 'status" ) OR TRUE OR ( "x' }, "open"],
    });
    expect(compile(query("open"), { sourceSchema: unsafeSchema, preferredFilterLanguage: "cql2-text" })).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.filter.args[0].left.name" }],
    });
  });

  it("fails closed when encoding, optional operator, CRS, or native dialect evidence is absent", () => {
    expect(compile(query("open"), { conformsTo: baseConformance })).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ path: "options.conformance.conformsTo" }],
    });

    const noTemporal = fullConformance.filter((entry) => !entry.endsWith("/temporal-functions"));
    expect(compile(query("open"), { conformsTo: noTemporal })).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.filter.args[2]" }],
    });

    const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
    const nativeText = builder.features({
      geometry: "include",
      filter: { kind: "native", dialect: "cql2-text", payload: { format: "text", text: "status = 'open'" } },
    });
    expect(
      compile(nativeText, {
        conformsTo: fullConformance.filter((entry) => !entry.endsWith("/cql2-text")),
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-native-filter", path: "$.filter.dialect" }],
    });

    const unsupportedCrs = compileSemanticOgcApiFeaturesQuery({
      query: query("open"),
      schema: schema(),
      source: { collectionId: "incidents" },
      conformance: { conformsTo: fullConformance },
    });
    expect(unsupportedCrs).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-crs", path: "$.filter.crs" }],
    });
  });

  it("publishes the compiler result and artifact types", () => {
    expectTypeOf(compile()).toEqualTypeOf<SemanticCompilationResult<SemanticOgcApiFeaturesCompiledQueryV1>>();
  });
});
