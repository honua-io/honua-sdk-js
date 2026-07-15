import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MAX_SEMANTIC_QUERY_BYTES,
  createSemanticQueryBuilder,
  defineSemanticQuery,
  defineSpatialNode,
  parseSemanticQuery,
  temporalLiteral,
} from "../src/query-planner/index.js";
import type { SemanticFeatureQuery, TemporalLiteralNode, TemporalValue } from "../src/query-planner/index.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";
import type {
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  JsonValue,
  LogicalField,
  LogicalType,
  SourceSchemaV2,
  SourceSchemaV2Input,
} from "../src/source-schema.js";

interface Incident {
  readonly id: number;
  readonly status: string;
  readonly score: number;
  readonly active: boolean;
  readonly observedAt: TemporalValue<"instant">;
  readonly shape: ExecutableGeometryValue;
  readonly metadata: { readonly source: string };
}

const provenance = {
  method: "observed",
  protocol: "ogc-features",
  source: "https://example.test/ogc/collections/incidents",
} as const;

const crs: ExecutableCrsBinding = {
  definition: {
    kind: "authority",
    authority: "OGC",
    code: "CRS84",
    definitionAxisOrder: {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "longitude", abbreviation: "lon", direction: "east", unit: "degree" },
        { name: "latitude", abbreviation: "lat", direction: "north", unit: "degree" },
      ],
    },
  },
  coordinateOrder: {
    state: "known",
    source: "encoding",
    axes: [
      { name: "longitude", abbreviation: "lon", direction: "east", unit: "degree" },
      { name: "latitude", abbreviation: "lat", direction: "north", unit: "degree" },
    ],
  },
  provenance: { method: "standard-default" },
};

const point: ExecutableGeometryValue = {
  state: "present",
  geometry: { type: "Point", coordinates: [-157.86, 21.31] },
  crs,
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

function schemaInput(): SourceSchemaV2Input {
  const fields: readonly LogicalField[] = [
    field(
      "id",
      { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
      {
        nullability: "non-nullable",
        roles: ["primary-key", "feature-id"],
      },
    ),
    field(
      "status",
      { kind: "string", maxLength: 16 },
      {
        domain: {
          state: "coded",
          openness: "closed",
          values: [{ value: "active" }, { value: "closed" }],
        },
      },
    ),
    field(
      "score",
      { kind: "float", bits: 64 },
      {
        domain: {
          state: "range",
          minimum: { value: 0, inclusive: true },
          maximum: { value: 100, inclusive: true },
        },
      },
    ),
    field("active", { kind: "boolean" }),
    field(
      "observedAt",
      { kind: "timestamp", unit: "millisecond", timezone: "utc" },
      {
        roles: ["time-instant"],
      },
    ),
    field("shape", { kind: "geometry" }, { roles: ["geometry"] }),
    field("metadata", {
      kind: "struct",
      fields: [field("source", { kind: "string" }, { path: ["metadata", "source"] })],
    }),
  ];
  return {
    fields,
    key: { state: "known", fields: ["id"] },
    geometry: {
      state: "known",
      fields: [
        {
          field: "shape",
          geometryTypes: { state: "known", type: "Point" },
          crs,
          layout: "xy",
          allowsEmpty: true,
        },
      ],
      primaryField: { state: "known", field: "shape" },
    },
    temporal: { state: "instant", field: "observedAt" },
    openContent: "closed",
    provenance: [provenance],
  };
}

function incidentSchema(): SourceSchemaV2 {
  return createSourceSchemaV2(schemaInput());
}

function scalarSchema(type: LogicalType, overrides: Partial<LogicalField> = {}): SourceSchemaV2 {
  return createSourceSchemaV2({
    fields: [field("value", type, overrides)],
    key: { state: "none" },
    geometry: { state: "none", reason: "no-geometry-fields" },
    temporal: { state: "none" },
    openContent: "closed",
    provenance: [provenance],
  });
}

function equalityQuery(value: JsonValue, name = "value") {
  return {
    kind: "features",
    filter: {
      kind: "comparison",
      operator: "eq",
      left: { kind: "property", name },
      right: { kind: "literal", value },
    },
  } as const;
}

function schemaDefaultAccepts(type: LogicalType, value: JsonValue): boolean {
  try {
    scalarSchema(type, { defaultValue: value });
    return true;
  } catch {
    return false;
  }
}

function semanticLiteralAccepts(type: LogicalType, value: JsonValue, overrides: Partial<LogicalField> = {}): boolean {
  try {
    parseSemanticQuery(equalityQuery(value), { schema: scalarSchema(type, overrides) });
    return true;
  } catch {
    return false;
  }
}

function assertCompileTimeRelationships(): void {
  const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
  // @ts-expect-error Unknown fields cannot enter a typed projection.
  builder.features({ select: ["missing"] as const });
  // @ts-expect-error A numeric field requires a numeric equality literal.
  builder.comparison("eq", builder.property("score"), "high");
  // @ts-expect-error Boolean fields are not ordered.
  builder.comparison("gt", builder.property("active"), true);
  // @ts-expect-error Branded temporal strings do not accept string-pattern operators.
  builder.like(builder.property("observedAt"), "2026-%");
  // @ts-expect-error Numeric metrics cannot target a string field.
  builder.aggregate({ groupBy: [], metrics: [{ fn: "avg", field: "status", as: "mean" }] });
  // @ts-expect-error An OGC source cannot carry a GeoServices native filter.
  builder.native("geoservices-sql92", { format: "text", text: "1=1" });
}

describe("semantic query AST", () => {
  it("builds immutable property/literal and boolean nodes with schema-typed fields", () => {
    const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
    const status = builder.property("status");
    const filter = builder.and(
      builder.comparison("eq", status, builder.literal("active")),
      builder.between(builder.property("score"), 20, 80),
      builder.inList(builder.property("id"), [1, 2, 3]),
      builder.like(status, "act%", { caseSensitive: false }),
      builder.isNull(builder.property("metadata")),
      builder.temporal("after", builder.property("observedAt"), temporalLiteral("instant", "2026-07-13T00:00:00Z")),
    );
    const query = builder.features({
      select: ["id", "status", "score"] as const,
      geometry: "omit",
      filter,
      sort: [{ field: "score", direction: "desc", nulls: "last" }],
      page: { kind: "first", limit: 100 },
    });
    const parsed = defineSemanticQuery(query, { schema: incidentSchema(), protocol: "ogc-features" });

    expect(parsed).toEqual(query);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.filter)).toBe(true);
    expect(Object.isFrozen(status)).toBe(true);
    expectTypeOf(parsed).toMatchTypeOf<
      SemanticFeatureQuery<Incident, "ogc-features", "primary-geometry", readonly ["id", "status", "score"], "omit">
    >();
  });

  it("validates spatial and temporal operands against schema truth", () => {
    const spatial = defineSpatialNode<Incident, "primary-geometry">({
      kind: "spatial",
      operator: "within-distance",
      geometry: point,
      distance: { value: 5, unit: "kilometre", mode: "geodesic" },
    });
    const query = parseSemanticQuery(
      {
        kind: "features",
        filter: spatial,
        select: ["id", "shape"],
        geometry: { field: "shape" },
      },
      { schema: incidentSchema(), protocol: "ogc-features" },
    );

    expect(query.filter).toMatchObject({ kind: "spatial", operator: "within-distance" });
    expect(() =>
      parseSemanticQuery(
        {
          kind: "features",
          filter: {
            kind: "temporal",
            operator: "during",
            operand: { kind: "property", name: "observedAt" },
            value: temporalLiteral("instant", "2026-07-13T00:00:00Z"),
          },
        },
        { schema: incidentSchema() },
      ),
    ).toThrow(/during requires an interval/);
    expect(() =>
      defineSpatialNode({
        kind: "spatial",
        operator: "within-distance",
        geometry: point,
        distance: { value: 0, unit: "metre", mode: "planar" },
      }),
    ).toThrow(/greater than zero/);

    const webMercator = {
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
    } as const;
    const mismatchedReprojection = {
      ...point,
      crs: {
        ...crs,
        provenance: {
          method: "reprojected",
          reprojection: {
            source: webMercator,
            target: webMercator,
            engine: "test-engine",
          },
        },
      },
    };
    expect(() =>
      parseSemanticQuery({
        kind: "features",
        filter: { kind: "spatial", operator: "intersects", geometry: mismatchedReprojection },
      }),
    ).toThrow(/must semantically match/);

    const malformedNativeProvenance = {
      ...point,
      crs: {
        ...crs,
        provenance: {
          method: "declared",
          native: { protocol: "ogc-features", name: "crs", unexpected: true },
        },
      },
    };
    expect(() =>
      parseSemanticQuery({
        kind: "features",
        filter: { kind: "spatial", operator: "intersects", geometry: malformedNativeProvenance },
      }),
    ).toThrow(/unexpected/);
  });

  it("validates temporal predicate values against timestamp precision and timezone truth", () => {
    const temporalQuery = (operator: "after" | "during", value: TemporalLiteralNode) => ({
      kind: "features",
      filter: {
        kind: "temporal",
        operator,
        operand: { kind: "property", name: "observedAt" },
        value,
      },
    });

    expect(() =>
      parseSemanticQuery(temporalQuery("after", temporalLiteral("instant", "2026-07-13T00:00:00.123456789Z")), {
        schema: incidentSchema(),
      }),
    ).toThrow(/incompatible with observedAt:timestamp/);
    expect(() =>
      parseSemanticQuery(temporalQuery("after", temporalLiteral("instant", "2026-07-13T00:00:00.123+01:00")), {
        schema: incidentSchema(),
      }),
    ).toThrow(/incompatible with observedAt:timestamp/);
    expect(() =>
      parseSemanticQuery(
        temporalQuery(
          "during",
          temporalLiteral("interval", ["2026-07-13T00:00:00.123Z", "2026-07-13T00:00:01.123456789Z"]),
        ),
        { schema: incidentSchema() },
      ),
    ).toThrow(/incompatible with observedAt:timestamp/);
    expect(() =>
      parseSemanticQuery(temporalQuery("after", temporalLiteral("instant", "2026-07-13T00:00:00.123Z")), {
        schema: incidentSchema(),
      }),
    ).not.toThrow();
  });

  it("fails closed for unknown fields, incompatible literals, domains, ranges, and query fields", () => {
    const schema = incidentSchema();
    const comparison = (name: string, value: unknown) => ({
      kind: "features",
      filter: {
        kind: "comparison",
        operator: "eq",
        left: { kind: "property", name },
        right: { kind: "literal", value },
      },
    });

    expect(() => parseSemanticQuery(comparison("missing", 1), { schema })).toThrow(/unknown schema field/);
    expect(() => parseSemanticQuery(comparison("score", "high"), { schema })).toThrow(/incompatible/);
    expect(() => parseSemanticQuery(comparison("id", 2_147_483_648), { schema })).toThrow(/incompatible/);
    expect(() => parseSemanticQuery(comparison("status", "retired"), { schema })).toThrow(/closed coded domain/);
    expect(() => parseSemanticQuery(comparison("score", 101), { schema })).toThrow(/declared maximum/);
    expect(() => parseSemanticQuery({ kind: "features", select: ["id", "id"] }, { schema })).toThrow(
      /duplicate projection field/,
    );
    expect(() =>
      parseSemanticQuery({ kind: "features", sort: [{ field: "active", direction: "asc" }] }, { schema }),
    ).toThrow(/not orderable/);
    expect(() =>
      parseSemanticQuery(
        {
          kind: "aggregate",
          groupBy: ["metadata"],
          metrics: [{ fn: "avg", field: "status", as: "mean" }],
        },
        { schema },
      ),
    ).toThrow(/not scalar\/groupable/);
    expect(() =>
      parseSemanticQuery(
        { kind: "aggregate", groupBy: [], metrics: [{ fn: "avg", field: "status", as: "mean" }] },
        { schema },
      ),
    ).toThrow(/not avg-compatible/);
    expect(() =>
      parseSemanticQuery(
        {
          kind: "aggregate",
          groupBy: ["status"],
          metrics: [
            { fn: "count", as: "total" },
            { fn: "count", as: "total" },
          ],
        },
        { schema },
      ),
    ).toThrow(/duplicate metric alias/);
  });

  it.each([
    {
      name: "valid padded base64",
      type: { kind: "binary", encoding: "base64" },
      value: "QQ==",
      accepted: true,
    },
    {
      name: "invalid base64 alphabet",
      type: { kind: "binary", encoding: "base64" },
      value: "%%%==",
      accepted: false,
    },
    {
      name: "non-absolute binary URL",
      type: { kind: "binary", encoding: "url" },
      value: "relative/blob.bin",
      accepted: false,
    },
    {
      name: "millisecond time precision",
      type: { kind: "time", unit: "millisecond" },
      value: "12:34:56.123",
      accepted: true,
    },
    {
      name: "excess time precision",
      type: { kind: "time", unit: "millisecond" },
      value: "12:34:56.1234",
      accepted: false,
    },
    {
      name: "zoned time-of-day",
      type: { kind: "time", unit: "second" },
      value: "12:34:56Z",
      accepted: false,
    },
    {
      name: "excess timestamp precision",
      type: { kind: "timestamp", unit: "millisecond", timezone: "utc" },
      value: "2026-07-15T12:34:56.1234Z",
      accepted: false,
    },
    {
      name: "local timestamp for unknown timezone",
      type: { kind: "timestamp", unit: "second", timezone: "unknown" },
      value: "2026-07-15T12:34:56",
      accepted: true,
    },
    {
      name: "negative-zero integer string",
      type: { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" },
      value: "-0",
      accepted: false,
    },
    {
      name: "exponential decimal number",
      type: { kind: "decimal", precision: 8, scale: 7, jsonEncoding: "number" },
      value: 1e-7,
      accepted: true,
    },
    {
      name: "decimal integer digits exceed precision minus scale",
      type: { kind: "decimal", precision: 3, scale: 2, jsonEncoding: "number" },
      value: 12.3,
      accepted: false,
    },
  ] as const)("matches canonical SourceSchemaV2 value semantics for $name", ({ type, value, accepted }) => {
    expect(schemaDefaultAccepts(type, value)).toBe(accepted);
    expect(semanticLiteralAccepts(type, value)).toBe(accepted);
  });

  it("orders temporal literals, range bounds, and schema domains without millisecond truncation", () => {
    const intervalQuery = (start: string, end: string) => ({
      kind: "features",
      filter: {
        kind: "temporal",
        operator: "during",
        operand: { kind: "property", name: "observedAt" },
        value: { kind: "temporal-literal", valueType: "interval", value: [start, end] },
      },
    });

    for (const [start, end] of [
      ["2026-07-15T00:00:00.000002Z", "2026-07-15T00:00:00.000001Z"],
      ["2026-07-15T00:00:00.000000002Z", "2026-07-15T00:00:00.000000001Z"],
    ] as const) {
      expect(() => parseSemanticQuery(intervalQuery(start, end))).toThrow(/start must not be after end/);
    }

    const timestampType = { kind: "timestamp", unit: "nanosecond", timezone: "utc" } as const;
    const timestampSchema = scalarSchema(timestampType);
    expect(() =>
      parseSemanticQuery(
        {
          kind: "features",
          filter: {
            kind: "range",
            operator: "between",
            operand: { kind: "property", name: "value" },
            lower: { kind: "literal", value: "2026-07-15T00:00:00.000000002Z" },
            upper: { kind: "literal", value: "2026-07-15T00:00:00.000000001Z" },
          },
        },
        { schema: timestampSchema },
      ),
    ).toThrow(/range lower bound must not exceed its upper bound/);

    const timeSchema = scalarSchema({ kind: "time", unit: "microsecond" });
    expect(() =>
      parseSemanticQuery(
        {
          kind: "features",
          filter: {
            kind: "range",
            operator: "between",
            operand: { kind: "property", name: "value" },
            lower: { kind: "literal", value: "12:00:00.000002" },
            upper: { kind: "literal", value: "12:00:00.000001" },
          },
        },
        { schema: timeSchema },
      ),
    ).toThrow(/range lower bound must not exceed its upper bound/);

    const unknownTimezoneSchema = scalarSchema({ kind: "timestamp", unit: "nanosecond", timezone: "unknown" });
    expect(() =>
      parseSemanticQuery(
        {
          kind: "features",
          filter: {
            kind: "range",
            operator: "between",
            operand: { kind: "property", name: "value" },
            lower: { kind: "literal", value: "2026-07-15T00:00:00.000000001" },
            upper: { kind: "literal", value: "2026-07-15T00:00:00.000000002Z" },
          },
        },
        { schema: unknownTimezoneSchema },
      ),
    ).toThrow(/cannot be ordered deterministically/);

    const domain = {
      state: "range",
      minimum: { value: "2026-07-15T00:00:00.000000002Z", inclusive: true },
      maximum: { value: "2026-07-15T00:00:00.000000010Z", inclusive: true },
    } as const;
    expect(semanticLiteralAccepts(timestampType, "2026-07-15T00:00:00.000000001Z", { domain })).toBe(false);
    expect(semanticLiteralAccepts(timestampType, "2026-07-15T00:00:00.000000002Z", { domain })).toBe(true);
  });

  it("accepts valid offset-normalized RFC 3339 leap seconds and orders them exactly", () => {
    const intervalQuery = (start: string, end: string) => ({
      kind: "features",
      filter: {
        kind: "temporal",
        operator: "during",
        operand: { kind: "property", name: "observedAt" },
        value: { kind: "temporal-literal", valueType: "interval", value: [start, end] },
      },
    });

    for (const [start, end] of [
      ["2016-12-31T23:59:59.999999999Z", "2016-12-31T23:59:60Z"],
      ["2016-12-31T23:59:60.999999999Z", "2017-01-01T00:00:00Z"],
      ["2017-01-01T00:59:60+01:00", "2017-01-01T00:00:00Z"],
    ] as const) {
      expect(() => parseSemanticQuery(intervalQuery(start, end))).not.toThrow();
    }

    expect(() => parseSemanticQuery(intervalQuery("2017-01-01T00:00:00Z", "2016-12-31T23:59:60.999999999Z"))).toThrow(
      /start must not be after end/,
    );
    expect(() => parseSemanticQuery(intervalQuery("2016-12-30T23:59:60Z", "2017-01-01T00:00:00Z"))).toThrow(
      /RFC 3339 full-date or instant/,
    );
  });

  it.each([
    {
      name: "large string integer",
      type: { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" },
      step: 3,
      accepted: "9007199254740993",
      rejected: "9007199254740992",
    },
    {
      name: "string decimal",
      type: { kind: "decimal", precision: 8, scale: 7, jsonEncoding: "string" },
      step: 3e-7,
      accepted: "0.0000009",
      rejected: "0.0000010",
    },
  ] as const)("enforces multiple-of exactly for $name", ({ type, step, accepted, rejected }) => {
    const overrides = {
      constraints: { state: "known", values: [{ kind: "multiple-of", value: step }] },
    } as const;
    expect(semanticLiteralAccepts(type, accepted, overrides)).toBe(true);
    expect(semanticLiteralAccepts(type, rejected, overrides)).toBe(false);
  });

  it("validates protocol options even when the query contains no native filter", () => {
    expect(() => parseSemanticQuery({ kind: "features" }, { protocol: "not-a-protocol" as never })).toThrow(
      /options\.protocol.*built-in or namespaced/,
    );
    expect(() => parseSemanticQuery({ kind: "features" }, { protocol: " \t" as never })).toThrow(
      /options\.protocol.*non-empty/,
    );
    expect(() => parseSemanticQuery({ kind: "features" }, { protocol: 7 as never })).toThrow(
      /options\.protocol.*string/,
    );
    expect(() => parseSemanticQuery({ kind: "features" }, { protocol: "com.example.features" })).not.toThrow();
  });

  it.each([
    ["property", equalityQuery(1, " \t")],
    ["projection", { kind: "features", select: [" \n"] }],
    ["sort", { kind: "features", sort: [{ field: " ", direction: "asc" }] }],
    ["group", { kind: "aggregate", groupBy: ["\t"], metrics: [{ fn: "count", as: "count" }] }],
    ["metric field", { kind: "aggregate", groupBy: [], metrics: [{ fn: "sum", field: " ", as: "sum" }] }],
    ["metric alias", { kind: "aggregate", groupBy: [], metrics: [{ fn: "count", as: "\n" }] }],
    ["geometry field", { kind: "features", geometry: { field: " " } }],
    [
      "native text payload",
      {
        kind: "features",
        filter: { kind: "native", dialect: "cql2-text", payload: { format: "text", text: " \t" } },
      },
    ],
    [
      "native XML payload",
      {
        kind: "features",
        filter: { kind: "native", dialect: "fes-2.0", payload: { format: "xml", text: "\n" } },
      },
    ],
  ] as const)("rejects blank %s text", (_name, query) => {
    expect(() => parseSemanticQuery(query)).toThrow(/non-empty string/);
  });

  it("normalizes semantically equivalent optional defaults before freezing", () => {
    const pattern = {
      kind: "pattern",
      operator: "like",
      operand: { kind: "property", name: "status" },
      pattern: "act%",
    } as const;
    const implicitPattern = parseSemanticQuery({ kind: "features", filter: pattern });
    const explicitPattern = parseSemanticQuery({
      kind: "features",
      filter: { ...pattern, caseSensitive: true },
    });
    expect(implicitPattern).toEqual(explicitPattern);
    expect(implicitPattern.filter).toMatchObject({ caseSensitive: true });

    const implicitNulls = parseSemanticQuery({
      kind: "features",
      sort: [{ field: "score", direction: "desc" }],
    });
    const explicitNulls = parseSemanticQuery({
      kind: "features",
      sort: [{ field: "score", direction: "desc", nulls: "native" }],
    });
    expect(implicitNulls).toEqual(explicitNulls);
    expect(implicitNulls.sort).toEqual([{ field: "score", direction: "desc", nulls: "native" }]);
  });

  it("defers schema patterns without narrowing or executing ECMA-262", () => {
    const patternedInput = schemaInput();
    const comparison = (name: string, value: unknown) => ({
      kind: "features",
      filter: {
        kind: "comparison",
        operator: "eq",
        left: { kind: "property", name },
        right: { kind: "literal", value },
      },
    });
    const patternSchema = (expression: string) =>
      createSourceSchemaV2({
        ...patternedInput,
        fields: patternedInput.fields.map((candidate) =>
          candidate.name === "status"
            ? {
                ...candidate,
                type: { kind: "string" },
                domain: { state: "none", reason: "unconstrained" },
                constraints: {
                  state: "known",
                  values: [{ kind: "pattern", syntax: "ecma-262", expression }],
                },
              }
            : candidate,
        ),
      });

    for (const [expression, value] of [
      ["^[A-Z]{2}$", "HI"],
      ["^(open|closed)$", "open"],
      ["^[A-Z]+$", "ACTIVE"],
    ] as const) {
      expect(parseSemanticQuery(comparison("status", value), { schema: patternSchema(expression) })).toMatchObject({
        kind: "features",
      });
    }

    // A schema pattern is metadata at this boundary. In particular, the
    // parser must never run a catastrophic expression against hostile input.
    expect(
      parseSemanticQuery(comparison("status", `${"a".repeat(4096)}!`), {
        schema: patternSchema("^(a+)+$"),
      }),
    ).toMatchObject({ kind: "features" });
  });

  it("binds native payload form and dialect to the source protocol", () => {
    expect(
      parseSemanticQuery(
        {
          kind: "features",
          filter: {
            kind: "native",
            dialect: "cql2-json",
            payload: { format: "json", value: { op: "=", args: [{ property: "status" }, "active"] } },
          },
        },
        { protocol: "ogc-features" },
      ).filter,
    ).toMatchObject({ kind: "native", dialect: "cql2-json" });

    expect(() =>
      parseSemanticQuery(
        {
          kind: "features",
          filter: {
            kind: "native",
            dialect: "geoservices-sql92",
            payload: { format: "text", text: "STATUS = 'active'" },
          },
        },
        { protocol: "ogc-features" },
      ),
    ).toThrow(/not valid for protocol ogc-features/);
    expect(() =>
      parseSemanticQuery({
        kind: "features",
        filter: {
          kind: "native",
          dialect: "cql2-json",
          payload: { format: "text", text: "status = 'active'" },
        },
      }),
    ).toThrow(/requires json/);
  });

  it.each([
    {
      kind: "boolean",
      operator: "and",
      args: [{ kind: "native", dialect: "cql2-text", payload: { format: "text", text: "1=1" } }],
    },
    {
      kind: "not",
      arg: { kind: "native", dialect: "cql2-text", payload: { format: "text", text: "1=1" } },
    },
  ] as const)("rejects nested native filters before dialect compilation", (filter) => {
    expect(() => parseSemanticQuery({ kind: "features", filter }, { protocol: "ogc-features" })).toThrow(
      /native filters must be the complete top-level filter/,
    );
  });

  it("bounds untrusted values and rejects cycles, accessors, and unexpected members", () => {
    const cyclic: Record<string, unknown> = { kind: "features" };
    cyclic.filter = cyclic;
    expect(() => parseSemanticQuery(cyclic)).toThrow(/cycles/);

    const accessor = { kind: "features" } as Record<string, unknown>;
    Object.defineProperty(accessor, "select", { enumerable: true, get: () => ["id"] });
    expect(() => parseSemanticQuery(accessor)).toThrow(/own data value/);
    expect(() => parseSemanticQuery('{"kind":"features","k\\u0069nd":"aggregate"}')).toThrow(
      /duplicate object name "kind"/,
    );

    const extraArray = ["id"] as Array<string> & { extra?: boolean };
    extraArray.extra = true;
    expect(() => parseSemanticQuery({ kind: "features", select: extraArray })).toThrow(/extra/);

    const hiddenArray = ["id"];
    Object.defineProperty(hiddenArray, "hidden", { value: true });
    expect(() => parseSemanticQuery({ kind: "features", select: hiddenArray })).toThrow(/extra/);

    const nonEnumerableIndex: string[] = [];
    Object.defineProperty(nonEnumerableIndex, "0", { value: "id", enumerable: false });
    expect(() => parseSemanticQuery({ kind: "features", select: nonEnumerableIndex })).toThrow(/enumerable/);

    const symbolArray = ["id"];
    Object.defineProperty(symbolArray, Symbol("hidden"), { value: true });
    expect(() => parseSemanticQuery({ kind: "features", select: symbolArray })).toThrow(/symbol/);

    const trapText = "do-not-reflect-proxy-trap-details";
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(trapText);
        },
      },
    );
    try {
      parseSemanticQuery(proxy);
      expect.unreachable("proxy input must be rejected");
    } catch (error) {
      expect(String(error)).toMatch(/could not be inspected safely as JSON data/);
      expect(String(error)).not.toContain(trapText);
    }
    expect(() => parseSemanticQuery({ kind: "features", where: "1=1" })).toThrow(/not part/);
    expect(() => parseSemanticQuery("x".repeat(MAX_SEMANTIC_QUERY_BYTES + 1))).toThrow(/byte bound/);
    expect(() =>
      parseSemanticQuery({ kind: "features", select: Array.from({ length: 5 }, () => "x".repeat(60_000)) }),
    ).toThrow(/byte bound/);
  });

  it("enforces field and dialect relationships at compile time", () => {
    expect(assertCompileTimeRelationships).toBeTypeOf("function");
  });
});
