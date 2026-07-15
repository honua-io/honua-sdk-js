import { describe, expect, it } from "vitest";

import type {
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  LogicalField,
  SourceSchemaV2,
  SourceSchemaV2Input,
} from "../src/contract/schema.js";
import { capabilities } from "../src/contract/types.js";
import {
  canonicalSemanticQueryBytes,
  createSemanticQueryBuilder,
  defineSpatialNode,
  hashSemanticQuery,
  legacyWhereToNativeFilter,
  semanticFilterFromCql2Json,
  semanticFilterToCql2Json,
  serializeCanonicalSemanticQuery,
  temporalLiteral,
} from "../src/query-planner/index.js";
import type { TemporalValue } from "../src/query-planner/index.js";
import { createQueryIr, queryFromCanonical } from "../src/query-planner/ir.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";

interface Incident {
  readonly id: number;
  readonly amount: number;
  readonly preciseAmount: string;
  readonly status: string;
  readonly score: number;
  readonly note: string;
  readonly observedAt: TemporalValue<"instant">;
  readonly shape: ExecutableGeometryValue;
}

const provenance = {
  method: "observed",
  protocol: "ogc-features",
  source: "https://example.test/ogc/collections/incidents",
} as const;

const crs84: ExecutableCrsBinding = {
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
  crs: crs84,
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

function schemaInput(openContent: SourceSchemaV2Input["openContent"] = "closed"): SourceSchemaV2Input {
  return {
    fields: [
      field(
        "id",
        { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
        {
          nullability: "non-nullable",
          roles: ["primary-key"],
        },
      ),
      field("amount", { kind: "decimal", precision: 8, scale: 2, jsonEncoding: "number" }),
      field("preciseAmount", { kind: "decimal", precision: 18, scale: 2, jsonEncoding: "string" }),
      field("status", { kind: "string" }),
      field("score", { kind: "float", bits: 64 }),
      field("note", { kind: "string" }),
      field("observedAt", { kind: "timestamp", unit: "millisecond", timezone: "utc" }, { roles: ["time-instant"] }),
      field("shape", { kind: "geometry" }, { roles: ["geometry"] }),
    ],
    key: { state: "known", fields: ["id"] },
    geometry: {
      state: "known",
      fields: [
        {
          field: "shape",
          geometryTypes: { state: "known", type: "Point" },
          crs: crs84,
          layout: "xy",
          allowsEmpty: false,
        },
      ],
      primaryField: { state: "known", field: "shape" },
    },
    temporal: { state: "instant", field: "observedAt" },
    openContent,
    provenance: [provenance],
  };
}

function schema(openContent: SourceSchemaV2Input["openContent"] = "closed"): SourceSchemaV2 {
  return createSourceSchemaV2(schemaInput(openContent));
}

describe("semantic canonical identity", () => {
  it("produces stable canonical bytes and domain-separated hashes", () => {
    const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
    const first = builder.features({
      select: ["id", "status"] as const,
      filter: builder.comparison("eq", builder.property("status"), "active"),
      sort: [{ field: "score", direction: "desc", nulls: "native" }],
      page: { kind: "first", limit: 100 },
    });
    const sameMeaningDifferentKeyOrder = {
      page: { limit: 100, kind: "first" },
      sort: [{ nulls: "native", direction: "desc", field: "score" }],
      filter: {
        right: { value: "active", kind: "literal" },
        left: { name: "status", kind: "property" },
        operator: "eq",
        kind: "comparison",
      },
      select: ["id", "status"],
      kind: "features",
    };
    const options = {
      schema: schema(),
      protocol: "ogc-features" as const,
      crsVersion: "epsg-db:2026.1",
      policyVersion: "query-policy:7",
    };

    expect(Array.from(canonicalSemanticQueryBytes(first, options))).toEqual(
      Array.from(canonicalSemanticQueryBytes(sameMeaningDifferentKeyOrder, options)),
    );
    expect(hashSemanticQuery(first, options)).toBe(hashSemanticQuery(sameMeaningDifferentKeyOrder, options));

    const serialized = JSON.parse(serializeCanonicalSemanticQuery(first, options)) as {
      identity: Record<string, unknown>;
    };
    expect(serialized.identity).toMatchObject({
      schemaFingerprint: options.schema.fingerprint,
      crsVersion: "epsg-db:2026.1",
      policyVersion: "query-policy:7",
      protocol: "ogc-features",
    });
    expect(hashSemanticQuery(first, options)).not.toBe(
      hashSemanticQuery(first, { ...options, policyVersion: "query-policy:8" }),
    );
    expect(hashSemanticQuery(first, options)).not.toBe(
      hashSemanticQuery(first, { ...options, crsVersion: "epsg-db:2026.2" }),
    );
    expect(hashSemanticQuery(first, options)).not.toBe(
      hashSemanticQuery(first, { ...options, schema: schema("open") }),
    );

    const withoutContext = JSON.parse(serializeCanonicalSemanticQuery(first)) as {
      identity: Record<string, unknown>;
    };
    expect(withoutContext.identity).toEqual({
      crsVersion: null,
      policyVersion: null,
      protocol: null,
      schemaFingerprint: null,
    });

    const mutableCopy = canonicalSemanticQueryBytes(first, options);
    mutableCopy[0] = 0;
    expect(canonicalSemanticQueryBytes(first, options)[0]).not.toBe(0);
  });

  it("normalizes equivalent optional defaults before canonical bytes and hashing", () => {
    const implicit = {
      kind: "features",
      filter: {
        kind: "pattern",
        operator: "like",
        operand: { kind: "property", name: "status" },
        pattern: "act%",
      },
      sort: [{ field: "score", direction: "desc" }],
    } as const;
    const explicit = {
      ...implicit,
      filter: { ...implicit.filter, caseSensitive: true },
      sort: [{ ...implicit.sort[0], nulls: "native" }],
    } as const;
    const options = { schema: schema(), protocol: "ogc-features" as const };

    expect(Array.from(canonicalSemanticQueryBytes(implicit, options))).toEqual(
      Array.from(canonicalSemanticQueryBytes(explicit, options)),
    );
    expect(hashSemanticQuery(implicit, options)).toBe(hashSemanticQuery(explicit, options));
  });
});

describe("CQL2 JSON semantic interchange", () => {
  it("round-trips comparison, boolean, list, range, null, pattern, and temporal nodes", () => {
    const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
    const filter = builder.and(
      builder.comparison("eq", builder.property("status"), "active"),
      builder.inList(builder.property("id"), [1, 2, 3]),
      builder.between(builder.property("score"), 20, 80),
      builder.isNull(builder.property("note"), "is-not-null"),
      builder.like(builder.property("status"), "act%", { caseSensitive: false }),
      builder.temporal(
        "time-intersects",
        builder.property("observedAt"),
        temporalLiteral("interval", ["2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z"]),
      ),
    );
    const options = { schema: schema(), protocol: "ogc-features" as const };
    const encoded = semanticFilterToCql2Json(filter, options);

    expect(encoded).toMatchObject({
      op: "and",
      args: [
        { op: "=", args: [{ property: "status" }, "active"] },
        { op: "in", args: [{ property: "id" }, [1, 2, 3]] },
        { op: "between", args: [{ property: "score" }, 20, 80] },
        { op: "not", args: [{ op: "isNull", args: [{ property: "note" }] }] },
        {
          op: "like",
          args: [
            { op: "casei", args: [{ property: "status" }] },
            { op: "casei", args: ["act%"] },
          ],
        },
        {
          op: "t_intersects",
          args: [{ property: "observedAt" }, { interval: ["2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z"] }],
        },
      ],
    });

    const decoded = semanticFilterFromCql2Json(JSON.stringify(encoded), options);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(semanticFilterToCql2Json(decoded, options)).toEqual(encoded);
  });

  it("round-trips number-encoded decimals and rejects only precision-losing string encodings", () => {
    const builder = createSemanticQueryBuilder<Incident, "ogc-features", "primary-geometry">();
    const options = { schema: schema(), protocol: "ogc-features" as const };
    const numberEncoded = builder.comparison("eq", builder.property("amount"), 12.34);
    const encoded = semanticFilterToCql2Json(numberEncoded, options);

    expect(encoded).toEqual({ op: "=", args: [{ property: "amount" }, 12.34] });
    expect(semanticFilterToCql2Json(semanticFilterFromCql2Json(encoded, options), options)).toEqual(encoded);

    const stringEncoded = builder.comparison("eq", builder.property("preciseAmount"), "9007199254740993.00");
    expect(() => semanticFilterToCql2Json(stringEncoded, options)).toThrow(/cannot preserve string-encoded/);
  });

  it("round-trips spatial literals only with explicit matching CRS context", () => {
    const spatial = defineSpatialNode<Incident, "primary-geometry">({
      kind: "spatial",
      operator: "intersects",
      property: { kind: "property", name: "shape" },
      geometry: point,
    });
    const options = { schema: schema(), protocol: "ogc-features" as const, filterCrs: crs84 };
    const encoded = semanticFilterToCql2Json(spatial, options);
    expect(encoded).toEqual({
      op: "s_intersects",
      args: [{ property: "shape" }, { type: "Point", coordinates: [-157.86, 21.31] }],
    });
    const decoded = semanticFilterFromCql2Json(encoded, options);
    expect(semanticFilterToCql2Json(decoded, options)).toEqual(encoded);

    expect(() => semanticFilterToCql2Json(spatial, { schema: schema() })).toThrow(/explicit filterCrs/);
    expect(() => semanticFilterFromCql2Json(encoded, { schema: schema() })).toThrow(/explicit filterCrs/);
    expect(() =>
      semanticFilterToCql2Json(spatial, {
        ...options,
        filterCrs: { ...crs84, provenance: { method: "declared" } },
      }),
    ).toThrow(/does not match the external filterCrs/);

    const bbox = defineSpatialNode<Incident, "primary-geometry">({
      kind: "spatial",
      operator: "bbox-intersects",
      property: { kind: "property", name: "shape" },
      bbox: { box: { layout: "xy", bounds: [-158, 21, -157, 22] }, crs: crs84 },
    });
    const encodedBbox = semanticFilterToCql2Json(bbox, options);
    expect(encodedBbox).toEqual({
      op: "s_intersects",
      args: [{ property: "shape" }, { bbox: [-158, 21, -157, 22] }],
    });
    expect(semanticFilterToCql2Json(semanticFilterFromCql2Json(encodedBbox, options), options)).toEqual(encodedBbox);

    const distance = defineSpatialNode<Incident, "primary-geometry">({
      kind: "spatial",
      operator: "within-distance",
      property: { kind: "property", name: "shape" },
      geometry: point,
      distance: { value: 5, unit: "kilometre", mode: "geodesic" },
    });
    expect(() => semanticFilterToCql2Json(distance, options)).toThrow(/outside standard CQL2/);
  });

  it("enforces the normative two-member CQL2 JSON GeometryCollection cardinality symmetrically", () => {
    const options = { schema: schema(), protocol: "ogc-features" as const, filterCrs: crs84 };
    const spatial = (geometries: ExecutableGeometryValue["geometry"][]) =>
      defineSpatialNode<Incident, "primary-geometry">({
        kind: "spatial",
        operator: "intersects",
        property: { kind: "property", name: "shape" },
        geometry: {
          state: "present",
          geometry: { type: "GeometryCollection", geometries },
          crs: crs84,
          layout: "xy",
        } as unknown as ExecutableGeometryValue,
      });
    const oneMember = { type: "GeometryCollection", geometries: [point.geometry] } as const;

    expect(() => semanticFilterToCql2Json(spatial([...oneMember.geometries]), options)).toThrow(/at least two/);
    expect(() =>
      semanticFilterFromCql2Json({ op: "s_intersects", args: [{ property: "shape" }, oneMember] }, options),
    ).toThrow(/at least two/);

    const twoMembers = {
      type: "GeometryCollection",
      geometries: [point.geometry, { type: "Point", coordinates: [-157.8, 21.4] }],
    } as const;
    const encoded = semanticFilterToCql2Json(spatial([...twoMembers.geometries]), options);
    expect(encoded).toEqual({ op: "s_intersects", args: [{ property: "shape" }, twoMembers] });
    expect(semanticFilterToCql2Json(semanticFilterFromCql2Json(encoded, options), options)).toEqual(encoded);
  });

  it("fails closed for ambiguous, unsupported, and malformed CQL2 JSON", () => {
    expect(() => semanticFilterFromCql2Json('{"op":"=","op":"<>","args":[]}')).toThrow(/duplicate object name/);
    expect(() =>
      semanticFilterFromCql2Json({
        op: "=",
        args: [{ property: "status" }, { property: "note" }],
      }),
    ).toThrow(/unsupported CQL2 scalar expression/);
    expect(() => semanticFilterFromCql2Json({ op: "custom", args: [] })).toThrow(/unsupported CQL2 function/);
    expect(() =>
      semanticFilterFromCql2Json({ op: "like", args: [{ op: "casei", args: [{ property: "status" }] }, "x%"] }),
    ).toThrow(/must apply casei/);
    expect(() =>
      semanticFilterFromCql2Json({
        op: "=",
        args: [{ property: "observedAt" }, { timestamp: "2026-07-15T00:00:00Z" }],
      }),
    ).toThrow(/requires schema context/);
    expect(() =>
      semanticFilterFromCql2Json({ op: "=", args: [{ property: "status" }, "active"], extra: true }),
    ).toThrow(/outside the supported CQL2 form/);
  });
});

describe("deprecated raw-where migration", () => {
  it("tags supported legacy text with its actual native dialect", () => {
    expect(legacyWhereToNativeFilter("geoservices-feature-service", "STATUS = 'OPEN'")).toEqual({
      kind: "native",
      dialect: "geoservices-sql92",
      payload: { format: "text", text: "STATUS = 'OPEN'" },
    });
    expect(legacyWhereToNativeFilter("ogc-features", "status = 'open'")).toMatchObject({
      dialect: "cql2-text",
    });
    expect(legacyWhereToNativeFilter("odata", "status eq 'open'")).toMatchObject({ dialect: "odata-4.0" });
    expect(legacyWhereToNativeFilter("geoparquet", 'status = "open"')).toMatchObject({ dialect: "duckdb-sql" });
    expect(Object.isFrozen(legacyWhereToNativeFilter("stac", "collection = 'landsat'"))).toBe(true);
    expect(() => legacyWhereToNativeFilter("wfs" as never, "status = 'open'")).toThrow(/no lossless/);
    expect(() => legacyWhereToNativeFilter("constructor" as never, "status = 'open'")).toThrow(/no lossless/);
    expect(() => legacyWhereToNativeFilter("odata", "   ")).toThrow(/non-empty/);
    expect(() => legacyWhereToNativeFilter("odata", "x".repeat(64 * 1024 + 1))).toThrow(/too large/);
  });

  it("keeps the v1 planner path explicitly source-native and reversible", () => {
    const ir = createQueryIr({
      descriptor: {
        id: "incidents",
        protocol: "geoservices-feature-service",
        locator: { url: "https://example.test/FeatureServer", serviceId: "incidents", layerId: 0 },
        capabilities: capabilities(["query"]),
      },
      query: { where: "STATUS = 'OPEN'" },
    });
    expect(ir.query.where).toEqual({ kind: "source-native", expression: "STATUS = 'OPEN'" });
    expect(queryFromCanonical(ir.query).where).toBe("STATUS = 'OPEN'");
  });
});
