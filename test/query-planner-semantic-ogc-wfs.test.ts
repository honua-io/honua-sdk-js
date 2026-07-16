import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ExecutableBoundingBox,
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  LogicalField,
  SourceSchemaV2,
} from "../src/contract/schema.js";
import {
  compileSemanticOgcApiFeaturesQuery,
  compileSemanticWfsQuery,
  createSemanticQueryBuilder,
  defineSpatialNode,
  temporalLiteral,
} from "../src/query-planner/index.js";
import type {
  SemanticCompilationResult,
  SemanticOgcApiFeaturesCompiledQueryV1,
  SemanticQuery,
  SemanticWfsCompiledQueryV1,
  TemporalValue,
  Wfs20FilterCapabilitiesEvidence,
} from "../src/query-planner/index.js";
import { bboxInDefinitionOrder } from "../src/query-planner/ogc-compiler.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";

interface Incident {
  readonly id: number;
  readonly status: string;
  readonly severity: number;
  readonly reportedDate: TemporalValue<"date">;
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

const bbox: ExecutableBoundingBox = {
  box: { layout: "xy", bounds: [-158, 21, -157, 22] },
  crs: epsg4326,
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
      field("severity", { kind: "integer", bits: 16, signed: true, jsonEncoding: "number" }),
      field("reportedDate", { kind: "date" }),
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

interface EquivalenceFixture {
  readonly version: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly value: string;
    readonly expectedCql2Text: string;
    readonly expectedFesText: string;
  }[];
}

const equivalenceFixture = JSON.parse(
  readFileSync(new URL("./fixtures/query-planner/semantic-ogc-wfs-equivalence.v1.json", import.meta.url), "utf8"),
) as EquivalenceFixture;

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

function richQuery(status: string): SemanticQuery<Incident, "ogc-features", "primary-geometry"> {
  const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
  return builder.features({
    select: ["id", "status"] as const,
    geometry: "include",
    filter: builder.and(
      builder.comparison("eq", builder.property("status"), status),
      builder.inList(builder.property("status"), ["open", "pending"]),
      builder.between(builder.property("severity"), 1, 5),
      builder.like(builder.property("status"), "%critical\\_%", { caseSensitive: false }),
      builder.not(builder.comparison("eq", builder.property("severity"), 0)),
      builder.comparison("eq", builder.property("reportedDate"), "2026-07-15" as TemporalValue<"date">),
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

function wfsSchema(statusPath: readonly string[] = ["inc:properties", "inc:status"]): SourceSchemaV2 {
  const wfsField = (name: string, type: LogicalField["type"], path: readonly string[] = [`inc:${name}`]) => ({
    ...field(name, type),
    native: [{ protocol: "wfs" as const, name: path.join("/"), path }],
  });
  return createSourceSchemaV2({
    fields: [
      {
        ...wfsField("id", { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" }),
        roles: [],
      },
      wfsField("status", { kind: "string" }, statusPath),
      wfsField("severity", { kind: "integer", bits: 16, signed: true, jsonEncoding: "number" }),
      wfsField("reportedDate", { kind: "date" }),
      {
        ...wfsField("observedAt", { kind: "timestamp", unit: "microsecond", timezone: "utc" }),
        roles: ["time-instant"],
      },
      wfsField("shape", { kind: "geometry" }),
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
    provenance: [{ method: "declared", protocol: "wfs", source: "test DescribeFeatureType" }],
  });
}

const fullWfsCapabilities = {
  version: "2.0.0",
  implementsAdHocQuery: true,
  implementsSorting: true,
  logicalOperators: true,
  comparisonOperators: [
    "PropertyIsBetween",
    "PropertyIsEqualTo",
    "PropertyIsGreaterThan",
    "PropertyIsGreaterThanOrEqualTo",
    "PropertyIsLessThan",
    "PropertyIsLessThanOrEqualTo",
    "PropertyIsLike",
    "PropertyIsNotEqualTo",
    "PropertyIsNull",
  ],
  geometryOperands: ["gml:Envelope", "gml:Point"],
  spatialOperators: [
    "BBOX",
    "Beyond",
    "Contains",
    "Crosses",
    "Disjoint",
    "DWithin",
    "Equals",
    "Intersects",
    "Overlaps",
    "Touches",
    "Within",
  ],
  temporalOperands: ["gml:TimeInstant", "gml:TimePeriod"],
  temporalOperators: ["After", "AnyInteracts", "Before", "During"],
  supportedFilterCrs: [epsg4326Uri],
  supportedOutputCrs: [epsg4326Uri],
} as const satisfies Wfs20FilterCapabilitiesEvidence;

const wfsNamespaces = {
  zed: "urn:example:zed",
  inc: "https://example.test/incidents",
} as const;

function wfsQuery(status: string): SemanticQuery<Incident, "wfs", "primary-geometry"> {
  const builder = createSemanticQueryBuilder<Incident, "wfs", "primary-geometry">();
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
    outputCrs: epsg4326.definition,
  });
}

function richWfsQuery(status: string): SemanticQuery<Incident, "wfs", "primary-geometry"> {
  const builder = createSemanticQueryBuilder<Incident, "wfs", "primary-geometry">();
  return builder.features({
    select: ["id", "status"] as const,
    geometry: "include",
    filter: builder.and(
      builder.comparison("eq", builder.property("status"), status),
      builder.inList(builder.property("status"), ["open", "pending"]),
      builder.between(builder.property("severity"), 1, 5),
      builder.like(builder.property("status"), "%critical\\_%", { caseSensitive: false }),
      builder.not(builder.comparison("eq", builder.property("severity"), 0)),
      builder.comparison("eq", builder.property("reportedDate"), "2026-07-15" as TemporalValue<"date">),
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
  });
}

function compileWfs(
  semanticQuery: SemanticQuery<Incident, "wfs", "primary-geometry"> = wfsQuery("open"),
  options: {
    readonly capabilities?: Wfs20FilterCapabilitiesEvidence;
    readonly sourceSchema?: SourceSchemaV2;
    readonly namespaces?: Readonly<Record<string, string>>;
  } = {},
) {
  return compileSemanticWfsQuery({
    query: semanticQuery,
    schema: options.sourceSchema ?? wfsSchema(),
    source: { typeName: "inc:Incident", namespaces: options.namespaces ?? wfsNamespaces },
    capabilities: options.capabilities ?? fullWfsCapabilities,
  });
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

describe("semantic WFS 2.0 FES compiler", () => {
  it("emits namespace-safe typed FES with executable axis order and stable identity", () => {
    const attack = "O'Reilly & </fes:Literal><fes:Or><fes:Literal>世界";
    const artifact = compiled(compileWfs(wfsQuery(attack)));
    expect(artifact).toMatchObject({
      compiler: "wfs-2.0-semantic-query-v1",
      version: "2.0.0",
      dialect: "fes-2.0",
      typeName: "inc:Incident",
      namespaces: wfsNamespaces,
      propertyName: ["inc:id", "inc:properties/inc:status", "inc:shape"],
      sortBy: "inc:id D",
      startIndex: 5,
      count: 25,
      srsName: epsg4326Uri,
      usesNativeFilter: false,
    });
    expect(artifact.filter).toMatch(
      /^<fes:Filter xmlns:fes="http:\/\/www\.opengis\.net\/fes\/2\.0" xmlns:gml="http:\/\/www\.opengis\.net\/gml\/3\.2" xmlns:xs="http:\/\/www\.w3\.org\/2001\/XMLSchema" xmlns:inc=/,
    );
    expect(artifact.filter).toContain('xmlns:inc="https://example.test/incidents" xmlns:zed="urn:example:zed"');
    expect(artifact.filter).toContain("<fes:ValueReference>inc:properties/inc:status</fes:ValueReference>");
    expect(artifact.filter).toContain(
      '<fes:Literal type="xs:string">O\'Reilly &amp; &lt;/fes:Literal&gt;&lt;fes:Or&gt;&lt;fes:Literal&gt;世界</fes:Literal>',
    );
    expect(artifact.filter).toContain("<gml:pos>21.31 -157.86</gml:pos>");
    expect(artifact.filter).toContain("<gml:timePosition>2026-07-15T12:34:56.123456Z</gml:timePosition>");
    expect(artifact.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const reversedCapabilities: Wfs20FilterCapabilitiesEvidence = {
      ...fullWfsCapabilities,
      comparisonOperators: [...fullWfsCapabilities.comparisonOperators].reverse(),
      geometryOperands: [...fullWfsCapabilities.geometryOperands].reverse(),
      spatialOperators: [...fullWfsCapabilities.spatialOperators].reverse(),
      temporalOperands: [...fullWfsCapabilities.temporalOperands].reverse(),
      temporalOperators: [...fullWfsCapabilities.temporalOperators].reverse(),
      supportedFilterCrs: [...fullWfsCapabilities.supportedFilterCrs].reverse(),
      supportedOutputCrs: [...fullWfsCapabilities.supportedOutputCrs].reverse(),
    };
    const reordered = compiled(
      compileWfs(wfsQuery(attack), {
        capabilities: reversedCapabilities,
        namespaces: { inc: wfsNamespaces.inc, zed: wfsNamespaces.zed },
      }),
    );
    expect(reordered.capabilityFingerprint).toBe(artifact.capabilityFingerprint);
    expect(reordered.requestFingerprint).toBe(artifact.requestFingerprint);
  });

  it("preserves bbox and planar-distance relationships with definition-axis coordinates", () => {
    const ogcBuilder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
    const ogcBbox = ogcBuilder.features({
      geometry: "include",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "bbox-intersects",
        property: ogcBuilder.property("shape"),
        bbox,
      }),
    });
    const cqlJson = compiled(compile(ogcBbox));
    const cqlText = compiled(compile(ogcBbox, { preferredFilterLanguage: "cql2-text" }));
    expect(cqlJson.filter).toContain('"bbox":[21,-158,22,-157]');
    expect(cqlText.filter).toContain("BBOX(21, -158, 22, -157)");

    const wfsBuilder = createSemanticQueryBuilder<Incident, "wfs", "primary-geometry">();
    const wfsBbox = wfsBuilder.features({
      geometry: "include",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "bbox-intersects",
        property: wfsBuilder.property("shape"),
        bbox,
      }),
    });
    const fesBbox = compiled(compileWfs(wfsBbox));
    expect(fesBbox.filter).toContain("<fes:BBOX>");
    expect(fesBbox.filter).toContain("<gml:lowerCorner>21 -158</gml:lowerCorner>");
    expect(fesBbox.filter).toContain("<gml:upperCorner>22 -157</gml:upperCorner>");

    const planarDistance = wfsBuilder.features({
      geometry: "include",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "within-distance",
        property: wfsBuilder.property("shape"),
        geometry: point,
        distance: { value: 10, unit: "metre", mode: "planar" },
      }),
    });
    const fesDistance = compiled(compileWfs(planarDistance));
    expect(fesDistance.filter).toContain("<fes:DWithin>");
    expect(fesDistance.filter).toContain('<fes:Distance uom="m">10</fes:Distance>');
    expect(fesDistance.filter).toContain("<gml:pos>21.31 -157.86</gml:pos>");
  });

  it("uses one adversarial corpus across CQL2 JSON, CQL2 text, and FES without changing predicates", () => {
    expect(equivalenceFixture.version).toBe(1);
    for (const fixture of equivalenceFixture.cases) {
      const cqlJson = compiled(compile(richQuery(fixture.value)));
      const cqlText = compiled(
        compile(richQuery(fixture.value), {
          preferredFilterLanguage: "cql2-text",
        }),
      );
      const fes = compiled(compileWfs(richWfsQuery(fixture.value)));
      const parsed = JSON.parse(cqlJson.filter ?? "") as { readonly op: string; readonly args: readonly unknown[] };
      expect(parsed.op, fixture.name).toBe("and");
      expect(parsed.args[0], fixture.name).toEqual({
        op: "=",
        args: [{ property: "status" }, fixture.value],
      });
      expect(cqlText.filter, fixture.name).toContain(`status = ${fixture.expectedCql2Text}`);
      expect(fes.filter, fixture.name).toContain(
        `<fes:Literal type="xs:string">${fixture.expectedFesText}</fes:Literal>`,
      );
      expect(cqlJson.filter, fixture.name).toContain('"op":"t_after"');
      expect(cqlJson.filter, fixture.name).toContain('"op":"s_intersects"');
      expect(cqlJson.filter, fixture.name).toContain('"op":"in"');
      expect(cqlJson.filter, fixture.name).toContain('"op":"between"');
      expect(cqlJson.filter, fixture.name).toContain('"op":"casei"');
      expect(cqlJson.filter, fixture.name).toContain('"date":"2026-07-15"');
      expect(cqlText.filter, fixture.name).toContain("T_AFTER(");
      expect(cqlText.filter, fixture.name).toContain("S_INTERSECTS(");
      expect(cqlText.filter, fixture.name).toContain(" IN (");
      expect(cqlText.filter, fixture.name).toContain(" BETWEEN ");
      expect(cqlText.filter, fixture.name).toContain("CASEI(");
      expect(cqlText.filter, fixture.name).toContain("DATE('2026-07-15')");
      expect(fes.filter, fixture.name).toContain("<fes:After>");
      expect(fes.filter, fixture.name).toContain("<fes:Intersects>");
      expect(fes.filter, fixture.name).toContain("<fes:PropertyIsBetween>");
      expect(fes.filter, fixture.name).toContain(
        '<fes:PropertyIsLike wildCard="%" singleChar="_" escapeChar="\\" matchCase="false">',
      );
      expect(fes.filter, fixture.name).toContain('<fes:Literal type="xs:date">2026-07-15</fes:Literal>');
    }
  });

  it("requires exact advertised operators, operands, CRS, and safe property QNames", () => {
    expect(
      compileWfs(wfsQuery("open"), {
        capabilities: {
          ...fullWfsCapabilities,
          spatialOperators: fullWfsCapabilities.spatialOperators.filter((name) => name !== "Intersects"),
        },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.filter.args[3]" }],
    });

    expect(
      compileWfs(wfsQuery("open"), {
        capabilities: { ...fullWfsCapabilities, supportedFilterCrs: [] },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-crs", path: "$.filter.args[3].geometry.crs" }],
    });

    expect(
      compileWfs(wfsQuery("open"), {
        capabilities: { ...fullWfsCapabilities, geometryOperands: ["gml:Envelope"] },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-geometry", path: "$.filter.args[3].geometry.geometry" }],
    });

    expect(
      compileWfs(wfsQuery("open"), {
        capabilities: { ...fullWfsCapabilities, temporalOperands: ["gml:TimePeriod"] },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-node", path: "$.filter.args[2].value" }],
    });

    expect(compileWfs(wfsQuery("open"), { sourceSchema: wfsSchema(["inc:status]", "inc:*["]) })).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-source", path: "$.filter.args[0].left.name.nativePath[0]" }],
    });

    expect(() => compileWfs(wfsQuery("open"), { namespaces: { fes: "https://attacker.invalid" } })).toThrow(
      "options.source.namespaces.fes is not a safe XML namespace prefix",
    );
  });

  it("isolates the matching native FES escape hatch and rejects unencoded distance semantics", () => {
    const builder = createSemanticQueryBuilder<Incident, "wfs", "primary-geometry">();
    const nativeXml =
      '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0"><fes:PropertyIsNull><fes:ValueReference>inc:status</fes:ValueReference></fes:PropertyIsNull></fes:Filter>';
    const nativeQuery = builder.features({
      select: ["id"] as const,
      geometry: "omit",
      filter: { kind: "native", dialect: "fes-2.0", payload: { format: "xml", text: nativeXml } },
    });
    const nativeArtifact = compiled(compileWfs(nativeQuery));
    expect(nativeArtifact.filter).toBe(nativeXml);
    expect(nativeArtifact.dialect).toBe("fes-2.0");
    expect(nativeArtifact.usesNativeFilter).toBe(true);

    const mismatchedNativeQuery = {
      ...nativeQuery,
      filter: {
        kind: "native",
        dialect: "cql2-text",
        payload: { format: "text", text: "status = 'open'" },
      },
    };
    expect(() =>
      compileSemanticWfsQuery({
        query: mismatchedNativeQuery as never,
        schema: wfsSchema(),
        source: { typeName: "inc:Incident", namespaces: wfsNamespaces },
        capabilities: fullWfsCapabilities,
      }),
    ).toThrow("$.filter.dialect dialect cql2-text is not valid for protocol wfs");

    const contradictoryProjection = builder.features({
      select: ["shape"] as const,
      geometry: "omit",
    });
    expect(compileWfs(contradictoryProjection)).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-projection", path: "$.select[0]" }],
    });

    const distanceQuery = builder.features({
      select: ["id"] as const,
      geometry: "include",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "within-distance",
        property: builder.property("shape"),
        geometry: point,
        distance: { value: 10, unit: "metre", mode: "geodesic" },
      }),
    });
    expect(compileWfs(distanceQuery)).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "unsupported-distance", path: "$.filter.distance.mode" }],
    });
  });

  it("rejects measured bounding boxes before CQL2 or FES can reinterpret their ordinates", () => {
    const measuredBbox = {
      box: { layout: "xym", bounds: [-158, 21, 7, -157, 22, 9] },
      crs: epsg4326,
    } as unknown as ExecutableBoundingBox;
    expect(() => bboxInDefinitionOrder(measuredBbox, "$.filter.bbox")).toThrowError(
      expect.objectContaining({
        diagnostic: expect.objectContaining({
          code: "unsupported-geometry",
          path: "$.filter.bbox.box.layout",
        }),
      }),
    );

    const rawOgcQuery = {
      kind: "features",
      geometry: "include",
      filter: {
        kind: "spatial",
        operator: "bbox-intersects",
        property: { kind: "property", name: "shape" },
        bbox: measuredBbox,
      },
    };
    for (const preferredFilterLanguage of ["cql2-json", "cql2-text"] as const) {
      expect(() =>
        compileSemanticOgcApiFeaturesQuery({
          query: rawOgcQuery as never,
          schema: schema(),
          source: { collectionId: "incidents" },
          conformance: { conformsTo: fullConformance, supportedFilterCrs: [epsg4326Uri] },
          preferredFilterLanguage,
        }),
      ).toThrow("$.filter.bbox.box.layout must be one of xy, xyz");
    }
    expect(() =>
      compileSemanticWfsQuery({
        query: rawOgcQuery as never,
        schema: wfsSchema(),
        source: { typeName: "inc:Incident", namespaces: wfsNamespaces },
        capabilities: fullWfsCapabilities,
      }),
    ).toThrow("$.filter.bbox.box.layout must be one of xy, xyz");
  });

  it("refuses CRS axis dimensions that do not exactly match the encoded coordinate layout", () => {
    const threeAxisCrs: ExecutableCrsBinding = {
      definition: {
        kind: "authority",
        authority: "EPSG",
        code: "4979",
        definitionAxisOrder: {
          state: "known",
          source: "crs-definition",
          axes: [
            { name: "geodetic latitude", direction: "north", unit: "degree" },
            { name: "geodetic longitude", direction: "east", unit: "degree" },
            { name: "ellipsoidal height", direction: "up", unit: "metre" },
          ],
        },
      },
      coordinateOrder: {
        state: "known",
        source: "encoding",
        axes: [
          { name: "longitude", direction: "east", unit: "degree" },
          { name: "latitude", direction: "north", unit: "degree" },
          { name: "height", direction: "up", unit: "metre" },
        ],
      },
      provenance: { method: "declared" },
    };
    const twoDimensionalTupleInThreeAxisCrs: ExecutableGeometryValue = {
      state: "present",
      geometry: { type: "Point", coordinates: [-157.86, 21.31] },
      crs: threeAxisCrs,
      layout: "xy",
    };

    const ogcBuilder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
    const ogcQuery = ogcBuilder.features({
      geometry: "include",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: ogcBuilder.property("shape"),
        geometry: twoDimensionalTupleInThreeAxisCrs,
      }),
    });
    expect(
      compile(ogcQuery, {
        conformsTo: fullConformance,
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "crs-transform-required", path: "$.filter.geometry.crs" }],
    });

    const wfsBuilder = createSemanticQueryBuilder<Incident, "wfs", "primary-geometry">();
    const wfsQueryWithMismatchedAxes = wfsBuilder.features({
      geometry: "include",
      filter: defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: wfsBuilder.property("shape"),
        geometry: twoDimensionalTupleInThreeAxisCrs,
      }),
    });
    expect(
      compileWfs(wfsQueryWithMismatchedAxes, {
        capabilities: {
          ...fullWfsCapabilities,
          supportedFilterCrs: ["http://www.opengis.net/def/crs/EPSG/0/4979"],
        },
      }),
    ).toMatchObject({
      outcome: "unsupported",
      diagnostics: [{ code: "crs-transform-required", path: "$.filter.geometry.crs" }],
    });
  });

  it("publishes the FES compiler result and artifact types", () => {
    expectTypeOf(compileWfs()).toEqualTypeOf<SemanticCompilationResult<SemanticWfsCompiledQueryV1>>();
  });
});
