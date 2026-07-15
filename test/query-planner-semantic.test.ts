import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MAX_SEMANTIC_QUERY_BYTES,
  createSemanticQueryBuilder,
  defineSemanticQuery,
  defineSpatialNode,
  parseSemanticQuery,
  temporalLiteral,
} from "../src/query-planner/index.js";
import type { SemanticFeatureQuery, TemporalValue } from "../src/query-planner/index.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";
import type {
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  LogicalField,
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

function assertCompileTimeRelationships(): void {
  const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
  // @ts-expect-error Unknown fields cannot enter a typed projection.
  builder.features({ select: ["missing"] as const });
  // @ts-expect-error A numeric field requires a numeric equality literal.
  builder.comparison("eq", builder.property("score"), "high");
  // @ts-expect-error Boolean fields are not ordered.
  builder.comparison("gt", builder.property("active"), true);
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

  it("bounds untrusted values and rejects cycles, accessors, and unexpected members", () => {
    const cyclic: Record<string, unknown> = { kind: "features" };
    cyclic.filter = cyclic;
    expect(() => parseSemanticQuery(cyclic)).toThrow(/cycles/);

    const accessor = { kind: "features" } as Record<string, unknown>;
    Object.defineProperty(accessor, "select", { enumerable: true, get: () => ["id"] });
    expect(() => parseSemanticQuery(accessor)).toThrow(/own data value/);
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
