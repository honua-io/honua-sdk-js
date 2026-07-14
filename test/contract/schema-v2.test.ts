import { describe, expect, it } from "vitest";

import type { ExecutableBoundingBox, IsoInstant, SchemaIdentityFor, SourceSchemaV2 } from "../../src/contract/index.js";
import {
  cloneSourceSchemaV2,
  createSourceSchemaV2,
  parseSourceSchemaV2,
  serializeSourceSchemaV2,
  sourceSchemaIdentity,
} from "../../src/source-schema.js";
import type {
  CrsDefinition,
  GeometryTypeKnowledge,
  JsonObject,
  LogicalField,
  MetadataProvenance,
  SourceSchemaV2Input,
} from "../../src/source-schema.js";

const provenance: MetadataProvenance = {
  method: "observed",
  protocol: "odata",
  source: "https://example.test/odata/$metadata",
  observedAt: "2026-07-13T00:00:00Z",
};

function integerField(overrides: Partial<LogicalField> = {}): LogicalField {
  return {
    name: "Count",
    path: ["Count"],
    type: { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
    nullability: "nullable",
    mutability: "unknown",
    roles: [],
    domain: { state: "none", reason: "unconstrained" },
    constraints: { state: "none" },
    native: [{ protocol: "odata", name: "Edm.Int32", path: ["Example.Count"] }],
    ...overrides,
  };
}

function tabularInput(overrides: Partial<SourceSchemaV2Input> = {}): SourceSchemaV2Input {
  return {
    fields: [integerField()],
    key: { state: "none" },
    geometry: { state: "none", reason: "no-geometry-fields" },
    temporal: { state: "none" },
    openContent: "closed",
    provenance: [provenance],
    ...overrides,
  };
}

function spatialInput(definition: CrsDefinition): SourceSchemaV2Input {
  return {
    fields: [
      {
        name: "geometry",
        path: ["geometry"],
        type: { kind: "geometry" },
        nullability: "nullable",
        mutability: "unknown",
        roles: ["geometry"],
        domain: { state: "none", reason: "not-applicable" },
        constraints: { state: "none" },
        native: [],
      },
    ],
    key: { state: "none" },
    geometry: {
      state: "known",
      fields: [
        {
          field: "geometry",
          geometryTypes: { state: "known", type: "Point" },
          crs: {
            definition,
            coordinateOrder: {
              state: "known",
              source: "encoding",
              axes: [
                { name: "x", direction: "east", unit: "degree" },
                { name: "y", direction: "north", unit: "degree" },
              ],
            },
            provenance: { method: "metadata" },
          },
          layout: "xy",
          allowsEmpty: true,
        },
      ],
      primaryField: { state: "known", field: "geometry" },
    },
    temporal: { state: "none" },
    openContent: "closed",
    provenance: [provenance],
  };
}

function nestedStructType(
  levels: number,
  parentPath: readonly [string, ...string[]] = ["Count"],
): LogicalField["type"] {
  if (levels === 0) return { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" };
  const name = `level_${levels - 1}`;
  const path = [...parentPath, name] as [string, ...string[]];
  return {
    kind: "struct",
    fields: [integerField({ name, path, type: nestedStructType(levels - 1, path), native: [] })],
  };
}

function geodeticCrs(name = "WGS 84"): JsonObject {
  return {
    type: "GeographicCRS",
    name,
    datum: {
      type: "GeodeticReferenceFrame",
      name: "World Geodetic System 1984",
      ellipsoid: {
        type: "Ellipsoid",
        name: "WGS 84",
        semi_major_axis: 6378137,
        inverse_flattening: 298.257223563,
      },
    },
  };
}

function cartesianCoordinateSystem(): JsonObject {
  return {
    subtype: "Cartesian",
    axis: [
      { name: "Easting", abbreviation: "E", direction: "east", unit: "metre" },
      { name: "Northing", abbreviation: "N", direction: "north", unit: "metre" },
    ],
  };
}

function conversion(name = "Derivation"): JsonObject {
  return { type: "Conversion", name, method: { name: "PROJ method" } };
}

function baseCrsForDerived(type: string): JsonObject {
  switch (type) {
    case "DerivedGeographicCRS":
    case "DerivedGeodeticCRS":
      return geodeticCrs();
    case "DerivedVerticalCRS":
      return {
        type: "VerticalCRS",
        name: "Mean sea level",
        datum: { type: "VerticalReferenceFrame", name: "Mean sea level" },
      };
    case "DerivedEngineeringCRS":
      return {
        type: "EngineeringCRS",
        name: "Local engineering grid",
        datum: { type: "EngineeringDatum", name: "Local origin" },
      };
    case "DerivedTemporalCRS":
      return {
        type: "TemporalCRS",
        name: "Civil time",
        datum: { type: "TemporalDatum", name: "Unix epoch", calendar: "proleptic Gregorian" },
      };
    case "DerivedParametricCRS":
      return {
        type: "ParametricCRS",
        name: "Pressure",
        datum: { type: "ParametricDatum", name: "Pressure datum" },
      };
    case "DerivedProjectedCRS":
      return {
        type: "ProjectedCRS",
        name: "Base projected CRS",
        base_crs: geodeticCrs(),
        conversion: conversion("Projection"),
        coordinate_system: cartesianCoordinateSystem(),
      };
    default:
      throw new Error(`Unexpected derived CRS type ${type}`);
  }
}

describe("SourceSchemaV2 canonical contract", () => {
  it("exports the accepted instant, executable bbox, and typed schema identity contracts", () => {
    const instant: IsoInstant = "2026-07-13T00:00:00Z";
    const bbox: ExecutableBoundingBox = {
      box: { layout: "xy", bounds: [-180, -90, 180, 90] },
      crs: {
        definition: {
          kind: "authority",
          authority: "OGC",
          code: "CRS84",
          definitionAxisOrder: {
            state: "known",
            source: "crs-definition",
            axes: [
              { name: "longitude", direction: "east", unit: "degree" },
              { name: "latitude", direction: "north", unit: "degree" },
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
        provenance: { method: "standard-default" },
      },
    };
    const schema = createSourceSchemaV2(tabularInput());
    const identity: SchemaIdentityFor<{ readonly state: "known"; readonly value: SourceSchemaV2 }> = {
      state: "known",
      fingerprint: schema.fingerprint,
    };

    expect(instant).toBe("2026-07-13T00:00:00Z");
    expect(bbox.crs.definition.kind).toBe("authority");
    expect(identity).toEqual({ state: "known", fingerprint: schema.fingerprint });
  });

  it("serializes canonically and preserves identity through parse and clone", () => {
    const schema = createSourceSchemaV2(tabularInput());
    const serialized = serializeSourceSchemaV2(schema);
    const parsed = parseSourceSchemaV2(serialized);
    const cloned = cloneSourceSchemaV2(schema);
    const transported = parseSourceSchemaV2(structuredClone(schema));

    expect(serialized).toBe(serializeSourceSchemaV2(parsed));
    expect(parsed).toEqual(schema);
    expect(cloned).toEqual(schema);
    expect(transported).toEqual(schema);
    expect(Object.isFrozen(cloned.fields[0]?.type)).toBe(true);
    expect(Object.isFrozen(transported.fields[0]?.type)).toBe(true);
    expect(sourceSchemaIdentity({ state: "known", value: schema })).toEqual({
      state: "known",
      fingerprint: schema.fingerprint,
    });
    expect(schema.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.fields)).toBe(true);
    expect(Object.isFrozen(schema.fields[0]?.type)).toBe(true);
    expect(() => {
      (schema.fields as LogicalField[])[0] = integerField({ name: "mutated" });
    }).toThrow();
  });

  it("hashes the accepted semantic projection, excluding presentation, native definitions, and observation fields", () => {
    const first = createSourceSchemaV2(tabularInput());
    const equivalent = createSourceSchemaV2({
      ...tabularInput(),
      fields: [
        integerField({
          title: "Presentation changed",
          description: "Also excluded",
          native: [
            {
              protocol: "geoparquet",
              name: "INTEGER",
              path: ["Count"],
              definition: { physical: "INT32", observation: "different" },
            },
          ],
        }),
      ],
      provenance: [
        {
          method: "observed",
          protocol: "geoparquet",
          source: "https://different.example/count.parquet",
          observedAt: "2030-01-01T00:00:00Z",
        },
      ],
    });
    const changed = createSourceSchemaV2({
      ...tabularInput(),
      fields: [integerField({ type: { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" } })],
    });

    expect(equivalent.fingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    // Golden fixture: detects accidental projection/domain-separator drift.
    expect(first.fingerprint).toBe("sha256:a2c9cb525692cf2e224b088147f1b23ae99bce3c974ba023ab4898f28bc79aa8");
  });

  it("retains bounded native-reference identity for unknown domain/constraint knowledge without hashing payloads", () => {
    const withFirstPayload = createSourceSchemaV2({
      ...tabularInput(),
      fields: [
        integerField({
          domain: {
            state: "unknown",
            reason: "unrecognized",
            native: { protocol: "odata", name: "Example.Validation", path: ["Count"], definition: { value: 1 } },
          },
        }),
      ],
    });
    const withOtherPayload = createSourceSchemaV2({
      ...tabularInput(),
      fields: [
        integerField({
          domain: {
            state: "unknown",
            reason: "unrecognized",
            native: { protocol: "odata", name: "Example.Validation", path: ["Count"], definition: { value: 2 } },
          },
        }),
      ],
    });
    const withOtherIdentity = createSourceSchemaV2({
      ...tabularInput(),
      fields: [
        integerField({
          domain: {
            state: "unknown",
            reason: "unrecognized",
            native: { protocol: "odata", name: "Example.OtherValidation", path: ["Count"] },
          },
        }),
      ],
    });

    expect(withOtherPayload.fingerprint).toBe(withFirstPayload.fingerprint);
    expect(withOtherIdentity.fingerprint).not.toBe(withFirstPayload.fingerprint);
  });

  it("rejects unsupported versions, extra members, and fingerprint tampering", () => {
    const schema = createSourceSchemaV2(tabularInput());
    expect(() => parseSourceSchemaV2({ ...schema, version: "3.0" })).toThrow(/Unsupported source schema/);
    expect(() => parseSourceSchemaV2({ ...schema, extra: true })).toThrow(/not part of SourceSchemaV2/);
    expect(() => parseSourceSchemaV2({ ...schema, fingerprint: `sha256:${"0".repeat(64)}` })).toThrow(
      /fingerprint does not match/,
    );
  });

  it("revalidates known schema identity instead of trusting a supplied fingerprint", () => {
    const schema = createSourceSchemaV2(tabularInput());
    const forged = { ...schema, fingerprint: `sha256:${"0".repeat(64)}` };
    expect(() => sourceSchemaIdentity({ state: "known", value: forged as typeof schema })).toThrow(
      /fingerprint does not match/,
    );

    const malformed = {
      ...schema,
      fields: [{ ...schema.fields[0], type: { kind: "vendor-injected" } }],
    };
    expect(() => sourceSchemaIdentity({ state: "known", value: malformed as unknown as typeof schema })).toThrow(
      /recognized logical type/,
    );
  });

  it("sorts identity-bearing sets by stable UTF-8 bytes", () => {
    const names = ["\u{10000}", "\uE000", "é"];
    const fields = names.map((name) => integerField({ name, path: [name], native: [] }));
    const first = createSourceSchemaV2(tabularInput({ fields }));
    const reordered = createSourceSchemaV2(tabularInput({ fields: [...fields].reverse() }));

    expect(first.fields.map((field) => field.name)).toEqual(["é", "\uE000", "\u{10000}"]);
    expect(serializeSourceSchemaV2(reordered)).toBe(serializeSourceSchemaV2(first));
    expect(reordered.fingerprint).toBe(first.fingerprint);
  });

  it("enforces logical-type depth without double-counting struct field wrappers", () => {
    const accepted = createSourceSchemaV2(
      tabularInput({ fields: [integerField({ type: nestedStructType(31), native: [] })] }),
    );
    expect(accepted.fields[0]?.type.kind).toBe("struct");

    expect(() =>
      createSourceSchemaV2(tabularInput({ fields: [integerField({ type: nestedStructType(32), native: [] })] })),
    ).toThrow(/maximum logical-type depth 32/);
  });

  it("fails closed when geometry is nested below a top-level field path", () => {
    const nestedGeometry = integerField({
      name: "record",
      path: ["record"],
      type: {
        kind: "struct",
        fields: [
          integerField({
            name: "shape",
            path: ["record", "shape"],
            type: { kind: "geometry" },
            roles: ["geometry"],
            domain: { state: "none", reason: "not-applicable" },
            native: [],
          }),
        ],
      },
      native: [],
    });
    const validInput = tabularInput({
      fields: [nestedGeometry],
      geometry: { state: "unknown", reason: "unrecognized" },
    });
    const valid = createSourceSchemaV2(validInput);
    expect(valid.geometry).toEqual({ state: "unknown", reason: "unrecognized" });

    for (const geometry of [
      { state: "none", reason: "no-geometry-fields" } as const,
      spatialInput({
        kind: "unknown",
        reason: "missing",
      }).geometry,
    ]) {
      expect(() => createSourceSchemaV2({ ...validInput, geometry })).toThrow(/below a top-level field path/);
    }
    expect(() => parseSourceSchemaV2({ ...valid, geometry: { state: "none", reason: "no-geometry-fields" } })).toThrow(
      /below a top-level field path/,
    );

    const struct = nestedGeometry.type;
    if (struct.kind !== "struct") throw new Error("expected nested struct fixture");
    const child = struct.fields[0]!;
    expect(() =>
      createSourceSchemaV2({
        ...validInput,
        fields: [
          {
            ...nestedGeometry,
            type: { ...struct, fields: [{ ...child, roles: ["geometry", "primary-key"] }] },
          },
        ],
      }),
    ).toThrow(/Nested field record\.shape cannot carry primary-key/);
    expect(() =>
      createSourceSchemaV2({
        ...validInput,
        fields: [{ ...nestedGeometry, type: { ...struct, fields: [{ ...child, roles: [] }] } }],
      }),
    ).toThrow(/Nested field record\.shape geometry type and role must agree/);
  });

  it.each(["nullable", "unknown"] as const)("rejects a known key with %s nullability", (nullability) => {
    const id = integerField({
      name: "Id",
      path: ["Id"],
      nullability,
      roles: ["primary-key"],
    });
    expect(() => createSourceSchemaV2(tabularInput({ fields: [id], key: { state: "known", fields: ["Id"] } }))).toThrow(
      /Known key field Id must be non-nullable/,
    );
  });

  it.each([
    { name: "list", type: { kind: "list", element: { kind: "string" } } as const },
    {
      name: "struct",
      type: {
        kind: "struct",
        fields: [integerField({ name: "part", path: ["Id", "part"], native: [] })],
      } as const,
    },
    { name: "json", type: { kind: "json" } as const },
    { name: "unknown", type: { kind: "unknown", reason: "unrecognized" } as const },
  ])("rejects a known $name key that cannot produce FeatureIdentityValue", ({ type }) => {
    const id = integerField({
      name: "Id",
      path: ["Id"],
      type,
      nullability: "non-nullable",
      roles: ["primary-key"],
      native: [],
    });
    expect(() => createSourceSchemaV2(tabularInput({ fields: [id], key: { state: "known", fields: ["Id"] } }))).toThrow(
      /cannot produce a FeatureIdentityValue/,
    );
  });

  it.each(["instant", "interval", "mixed"] as const)("rejects duration as a temporal %s position", (state) => {
    const start = integerField({
      name: "Start",
      path: ["Start"],
      type: { kind: "duration", unit: "second" },
      roles: state === "interval" ? ["time-start"] : ["time-instant"],
    });
    const end = integerField({
      name: "End",
      path: ["End"],
      type: { kind: "duration", unit: "second" },
      roles: ["time-end"],
    });
    const temporal =
      state === "instant"
        ? ({ state, field: "Start" } as const)
        : state === "interval"
          ? ({ state, startField: "Start", endField: "End" } as const)
          : ({ state, fields: ["Start"] } as const);
    expect(() =>
      createSourceSchemaV2(tabularInput({ fields: state === "interval" ? [start, end] : [start], temporal })),
    ).toThrow(/not an instant or endpoint type/);
  });

  it.each([
    { name: "unrelated root", childPath: ["other", "value"] },
    { name: "parent path itself", childPath: ["record"] },
  ] as const)("rejects a struct descendant path with $name", ({ childPath }) => {
    const record = integerField({
      name: "record",
      path: ["record"],
      type: {
        kind: "struct",
        fields: [integerField({ name: "value", path: childPath, native: [] })],
      },
      native: [],
    });

    expect(() => createSourceSchemaV2(tabularInput({ fields: [record] }))).toThrow(/must strictly extend parent path/);
  });

  it("rejects nested paths that collide with another simultaneously addressable field", () => {
    const record = integerField({
      name: "record",
      path: ["record"],
      type: {
        kind: "struct",
        fields: [integerField({ name: "value", path: ["record", "value"], native: [] })],
      },
      native: [],
    });
    const shadow = integerField({ name: "shadow", path: ["record", "value"], native: [] });

    expect(() => createSourceSchemaV2(tabularInput({ fields: [record, shadow] }))).toThrow(
      /collides with another simultaneously addressable field/,
    );
  });

  it("allows one absolute path to be reused by mutually exclusive union struct branches", () => {
    const branchField = (type: LogicalField["type"]): LogicalField =>
      integerField({ name: "value", path: ["variant", "value"], type, native: [] });
    const variant = integerField({
      name: "variant",
      path: ["variant"],
      type: {
        kind: "union",
        members: [
          {
            kind: "struct",
            fields: [branchField({ kind: "integer", bits: 32, signed: true, jsonEncoding: "number" })],
          },
          { kind: "struct", fields: [branchField({ kind: "string" })] },
        ],
      },
      native: [],
    });

    const schema = createSourceSchemaV2(tabularInput({ fields: [variant] }));
    expect(schema.fields[0]?.type.kind).toBe("union");
  });

  it("traverses every union branch when enforcing path ancestry and external collisions", () => {
    const branch = (childPath: readonly [string, ...string[]], type: LogicalField["type"]): LogicalField["type"] => ({
      kind: "struct",
      fields: [integerField({ name: "value", path: childPath, type, native: [] })],
    });
    const variant = (members: readonly [LogicalField["type"], LogicalField["type"]]): LogicalField =>
      integerField({ name: "variant", path: ["variant"], type: { kind: "union", members }, native: [] });

    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          fields: [
            variant([
              branch(["variant", "value"], { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" }),
              branch(["wrong", "value"], { kind: "string" }),
            ]),
          ],
        }),
      ),
    ).toThrow(/must strictly extend parent path/);

    const collidingPath = ["variant", "value"] as const;
    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          fields: [
            variant([
              branch(collidingPath, { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" }),
              branch(collidingPath, { kind: "string" }),
            ]),
            integerField({ name: "shadow", path: collidingPath, native: [] }),
          ],
        }),
      ),
    ).toThrow(/collides with another simultaneously addressable field/);
  });

  it("canonicalizes and uniquely identifies partial-constraint native evidence", () => {
    const firstNative = {
      protocol: "odata" as const,
      name: "Example.FirstConstraint",
      path: ["Count"],
      definition: { annotation: 1 },
    };
    const secondNative = {
      protocol: "odata" as const,
      name: "Example.SecondConstraint",
      path: ["Count"],
      definition: { annotation: 2 },
    };
    const withNative = (
      native: [typeof firstNative, typeof secondNative] | [typeof secondNative, typeof firstNative],
    ) =>
      createSourceSchemaV2(
        tabularInput({
          fields: [
            integerField({
              constraints: { state: "partial", values: [{ kind: "unique" }], reason: "unrecognized", native },
            }),
          ],
        }),
      );

    const forward = withNative([firstNative, secondNative]);
    const reversed = withNative([secondNative, firstNative]);
    expect(serializeSourceSchemaV2(reversed)).toBe(serializeSourceSchemaV2(forward));
    expect(reversed.fingerprint).toBe(forward.fingerprint);

    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          fields: [
            integerField({
              constraints: {
                state: "partial",
                values: [{ kind: "unique" }],
                reason: "unrecognized",
                native: [firstNative, { ...firstNative, definition: { annotation: "other payload" } }],
              },
            }),
          ],
        }),
      ),
    ).toThrow(/native identities must not contain duplicates/);
  });

  it.each([
    {
      name: "string coded value with numeric encoding",
      field: integerField({
        type: { kind: "string" },
        domain: { state: "coded", values: [{ value: 1 }], openness: "closed" },
      }),
    },
    {
      name: "boolean range",
      field: integerField({
        type: { kind: "boolean" },
        domain: { state: "range", minimum: { value: 0, inclusive: true } },
      }),
    },
    {
      name: "out-of-range 8-bit integer",
      field: integerField({
        type: { kind: "integer", bits: 8, signed: true, jsonEncoding: "number" },
        domain: { state: "coded", values: [{ value: 128 }], openness: "closed" },
      }),
    },
    {
      name: "noncanonical int64 string",
      field: integerField({
        type: { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" },
        domain: { state: "coded", values: [{ value: "01" }], openness: "closed" },
      }),
    },
    {
      name: "noncanonical decimal string",
      field: integerField({
        type: { kind: "decimal", precision: 6, scale: 2, jsonEncoding: "string" },
        defaultValue: "01.20",
      }),
    },
    {
      name: "decimal beyond declared scale",
      field: integerField({
        type: { kind: "decimal", precision: 6, scale: 2, jsonEncoding: "string" },
        domain: { state: "range", minimum: { value: "1.234", inclusive: true } },
      }),
    },
    {
      name: "invalid calendar date",
      field: integerField({ type: { kind: "date" }, defaultValue: "2026-02-30" }),
    },
    {
      name: "timestamp with incompatible timezone encoding",
      field: integerField({
        type: { kind: "timestamp", unit: "millisecond", timezone: "utc" },
        defaultValue: "2026-07-13T00:00:00+01:00",
      }),
    },
  ])("rejects incompatible $name", ({ field }) => {
    expect(() => createSourceSchemaV2(tabularInput({ fields: [field] }))).toThrow(/incompatible|range/);
  });

  it("accepts the normative scale-bearing decimal range", () => {
    const schema = createSourceSchemaV2(
      tabularInput({
        fields: [
          integerField({
            type: { kind: "decimal", precision: 18, scale: 2, jsonEncoding: "string" },
            domain: {
              state: "range",
              minimum: { value: "0.00", inclusive: true },
              maximum: { value: "9999999999999999.99", inclusive: true },
              unit: "USD",
            },
          }),
        ],
      }),
    );
    expect(schema.fields[0]?.domain).toMatchObject({
      state: "range",
      minimum: { value: "0.00" },
      maximum: { value: "9999999999999999.99" },
    });
  });

  it.each([
    { minimumInclusive: false, maximumInclusive: true },
    { minimumInclusive: true, maximumInclusive: false },
    { minimumInclusive: false, maximumInclusive: false },
  ])(
    "rejects an empty equal-endpoint range ($minimumInclusive/$maximumInclusive)",
    ({ minimumInclusive, maximumInclusive }) => {
      expect(() =>
        createSourceSchemaV2(
          tabularInput({
            fields: [
              integerField({
                domain: {
                  state: "range",
                  minimum: { value: 5, inclusive: minimumInclusive },
                  maximum: { value: 5, inclusive: maximumInclusive },
                },
              }),
            ],
          }),
        ),
      ).toThrow(/equal endpoints must both be inclusive/);
    },
  );

  it("orders timestamp ranges exactly through nanoseconds and UTC offsets", () => {
    const field = (minimum: string, maximum: string, timezone: "offset" | "unknown" = "offset") =>
      integerField({
        type: { kind: "timestamp", unit: "nanosecond", timezone },
        domain: {
          state: "range",
          minimum: { value: minimum, inclusive: true },
          maximum: { value: maximum, inclusive: true },
        },
      });

    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          fields: [field("2026-07-13T00:00:00.000000002Z", "2026-07-13T00:00:00.000000001Z")],
        }),
      ),
    ).toThrow(/minimum must not exceed maximum/);

    expect(
      createSourceSchemaV2(
        tabularInput({
          fields: [field("2026-07-13T00:00:00.000000001+01:00", "2026-07-13T00:00:00.000000001Z")],
        }),
      ).fields[0]?.domain.state,
    ).toBe("range");

    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          fields: [field("2026-07-13T00:00:00.000000001", "2026-07-13T00:00:00.000000002Z", "unknown")],
        }),
      ),
    ).toThrow(/cannot be ordered deterministically/);
  });

  it("orders RFC 3339 leap seconds between the prior second and next UTC minute", () => {
    const field = (minimum: string, maximum: string) =>
      integerField({
        type: { kind: "timestamp", unit: "nanosecond", timezone: "offset" },
        domain: {
          state: "range",
          minimum: { value: minimum, inclusive: true },
          maximum: { value: maximum, inclusive: true },
        },
      });

    for (const [minimum, maximum] of [
      ["2016-12-31T23:59:59.999999999Z", "2016-12-31T23:59:60Z"],
      ["2016-12-31T23:59:60.999999999Z", "2017-01-01T00:00:00Z"],
      ["2017-01-01T00:59:60+01:00", "2017-01-01T00:00:00Z"],
    ] as const) {
      expect(createSourceSchemaV2(tabularInput({ fields: [field(minimum, maximum)] })).fields[0]?.domain.state).toBe(
        "range",
      );
    }

    expect(() =>
      createSourceSchemaV2(tabularInput({ fields: [field("2017-01-01T00:00:00Z", "2016-12-31T23:59:60.999999999Z")] })),
    ).toThrow(/minimum must not exceed maximum/);

    const schema = createSourceSchemaV2(
      tabularInput({ fields: [field("2016-12-31T23:59:60Z", "2017-01-01T00:00:00Z")] }),
    );
    const reparsed = parseSourceSchemaV2(serializeSourceSchemaV2(schema));
    expect(reparsed.fingerprint).toBe(schema.fingerprint);
    expect(serializeSourceSchemaV2(reparsed)).toBe(serializeSourceSchemaV2(schema));
  });

  it.each([
    {
      name: "numeric strings with reversed numeric order",
      minimum: { value: "10", inclusive: true } as const,
      maximum: { value: "2", inclusive: true } as const,
    },
    {
      name: "mixed endpoint encodings",
      minimum: { value: "1", inclusive: true } as const,
      maximum: { value: 2, inclusive: true } as const,
    },
  ])("rejects ambiguous union range: $name", ({ minimum, maximum }) => {
    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          fields: [
            integerField({
              type: {
                kind: "union",
                members: [{ kind: "integer", bits: 64, signed: true, jsonEncoding: "string" }, { kind: "string" }],
              },
              domain: { state: "range", minimum, maximum },
            }),
          ],
        }),
      ),
    ).toThrow(/range is incompatible/);
  });

  it.each([
    {
      name: "undeclared struct member",
      type: {
        kind: "struct" as const,
        fields: [integerField({ name: "required", path: ["record", "required"], nullability: "non-nullable" })],
      },
      value: { required: 1, extra: true },
    },
    {
      name: "missing non-nullable struct member",
      type: {
        kind: "struct" as const,
        fields: [integerField({ name: "required", path: ["record", "required"], nullability: "non-nullable" })],
      },
      value: {},
    },
    { name: "noncanonical UUID", type: { kind: "uuid" as const }, value: "550E8400-E29B-41D4-A716-446655440000" },
    { name: "invalid base64", type: { kind: "binary" as const, encoding: "base64" as const }, value: "%%%=" },
    {
      name: "noncanonical binary URL",
      type: { kind: "binary" as const, encoding: "url" as const },
      value: "https://example.test/blob#",
    },
  ])("rejects incompatible default: $name", ({ type, value }) => {
    expect(() =>
      createSourceSchemaV2(
        tabularInput({ fields: [integerField({ type, defaultValue: value as LogicalField["defaultValue"] })] }),
      ),
    ).toThrow(/defaultValue is incompatible/);
  });

  it("accepts exact canonical geometry defaults and rejects malformed shapes", () => {
    const inputFor = (defaultValue: LogicalField["defaultValue"]): SourceSchemaV2Input => {
      const input = spatialInput({
        kind: "authority",
        authority: "EPSG",
        code: "4326",
        definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
      });
      if (input.geometry.state !== "known") throw new Error("expected known geometry fixture");
      return {
        ...input,
        fields: [{ ...input.fields[0]!, defaultValue }],
        geometry: {
          ...input.geometry,
          fields: [
            {
              ...input.geometry.fields[0]!,
              geometryTypes: { state: "unknown", reason: "missing" },
            },
          ],
        },
      };
    };
    const valid = {
      type: "GeometryCollection",
      geometries: [
        { type: "Point", coordinates: [1, 2] },
        {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      ],
    } as JsonObject;
    expect(createSourceSchemaV2(inputFor(valid)).fields[0]?.defaultValue).toEqual(valid);

    const invalid = [
      {},
      { type: "Point", coordinates: [1] },
      { type: "Point", coordinates: [1, 2], bbox: [1, 2, 1, 2] },
      { type: "MultiPoint", coordinates: [] },
      { type: "LineString", coordinates: [[0, 0]] },
      { type: "MultiLineString", coordinates: [] },
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1, 1],
        ],
      },
      {
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [0, 0] },
          { type: "Point", coordinates: [1, 1, 1] },
        ],
      },
      { type: "MultiPolygon", coordinates: [] },
      { type: "GeometryCollection", geometries: [] },
      { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1] }] },
    ];
    for (const defaultValue of invalid) {
      expect(() => createSourceSchemaV2(inputFor(defaultValue as LogicalField["defaultValue"]))).toThrow(
        /defaultValue is incompatible/,
      );
    }

    expect(() => createSourceSchemaV2(inputFor({ type: "Point", coordinates: [1, 2, 3] }))).toThrow(
      /ordinate arity does not match declared xy layout/,
    );

    const withDeclaredTypes = (geometryTypes: GeometryTypeKnowledge): SourceSchemaV2Input => {
      const input = inputFor({ type: "Point", coordinates: [1, 2] });
      if (input.geometry.state !== "known") throw new Error("expected known geometry fixture");
      return {
        ...input,
        geometry: {
          ...input.geometry,
          fields: [{ ...input.geometry.fields[0]!, geometryTypes }],
        },
      };
    };
    expect(() => createSourceSchemaV2(withDeclaredTypes({ state: "known", type: "Polygon" }))).toThrow(
      /defaultValue type Point does not match declared Polygon/,
    );
    expect(() => createSourceSchemaV2(withDeclaredTypes({ state: "mixed", types: ["LineString", "Polygon"] }))).toThrow(
      /defaultValue type Point is not in the declared mixed types/,
    );
    expect(
      createSourceSchemaV2(withDeclaredTypes({ state: "mixed", types: ["Point", "Polygon"] })).fields[0]?.defaultValue,
    ).toEqual({ type: "Point", coordinates: [1, 2] });
  });

  it("preserves JSON scalar domains for unknown logical types", () => {
    const schema = createSourceSchemaV2(
      tabularInput({
        fields: [
          integerField({
            type: { kind: "unknown", reason: "unrecognized" },
            defaultValue: { vendor: [1, true, "raw"] },
            domain: { state: "coded", values: [{ value: true }, { value: 3 }, { value: "3" }], openness: "unknown" },
          }),
        ],
      }),
    );
    expect(schema.fields[0]?.domain).toMatchObject({ state: "coded", values: expect.any(Array) });
  });

  it("rejects explicit non-JSON values instead of silently dropping them", () => {
    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          extensions: { "com.example.undefined": undefined } as unknown as SourceSchemaV2Input["extensions"],
        }),
      ),
    ).toThrow(/unsupported undefined/);
    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          extensions: { "com.example.function": () => true } as unknown as SourceSchemaV2Input["extensions"],
        }),
      ),
    ).toThrow(/unsupported function/);
    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          extensions: { "com.example.symbol": Symbol("value") } as unknown as SourceSchemaV2Input["extensions"],
        }),
      ),
    ).toThrow(/unsupported symbol/);
  });

  it("bounds raw parse input, normalized schema size, and nested JSON surfaces", () => {
    expect(() => parseSourceSchemaV2(" ".repeat(4 * 1024 * 1024 + 1))).toThrow(/Serialized.*byte bound/);
    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          fields: [integerField({ title: "x".repeat(4 * 1024 * 1024 + 1) })],
        }),
      ),
    ).toThrow(/byte bound/);

    const schema = createSourceSchemaV2(tabularInput());
    const oversized = {
      ...schema,
      fields: [{ ...schema.fields[0], title: "x".repeat(4 * 1024 * 1024) }],
    };
    expect(() => parseSourceSchemaV2(oversized)).toThrow(/byte bound/);

    let nested: JsonObject = { value: true };
    for (let index = 0; index < 40; index++) nested = { nested };
    expect(() =>
      createSourceSchemaV2(tabularInput({ fields: [integerField({ type: { kind: "json" }, defaultValue: nested })] })),
    ).toThrow(/maximum JSON nesting depth 32/);
  });

  it("rejects oversized sparse arrays before iterating their declared length", () => {
    const sparse: unknown[] = [];
    sparse.length = 0xffff_ffff;
    expect(() =>
      createSourceSchemaV2(
        tabularInput({
          extensions: { "com.example.sparse": sparse } as unknown as SourceSchemaV2Input["extensions"],
        }),
      ),
    ).toThrow(/bounded JSON array length/);
  });

  it.each(["\ud800", "\udc00"])("rejects unpaired Unicode surrogate %j in values and object keys", (surrogate) => {
    expect(() => createSourceSchemaV2(tabularInput({ fields: [integerField({ title: surrogate })] }))).toThrow(
      /unpaired .* Unicode surrogate/,
    );
    expect(() =>
      createSourceSchemaV2(
        tabularInput({ extensions: { [`com.example.${surrogate}`]: true } as SourceSchemaV2Input["extensions"] }),
      ),
    ).toThrow(/unpaired .* Unicode surrogate/);

    const serialized = serializeSourceSchemaV2(createSourceSchemaV2(tabularInput()));
    const escaped = surrogate === "\ud800" ? "\\ud800" : "\\udc00";
    expect(() => parseSourceSchemaV2(serialized.replace("Count", escaped))).toThrow(/unpaired .* Unicode surrogate/);
    expect(() => parseSourceSchemaV2(`${serialized.slice(0, -1)},"${escaped}":true}`)).toThrow(
      /unpaired .* Unicode surrogate/,
    );
  });

  it("rejects duplicate JSON object names after escape decoding at every nesting level", () => {
    const serialized = serializeSourceSchemaV2(createSourceSchemaV2(tabularInput()));
    const duplicateTopLevel = serialized.replace(
      '"kind":"honua.source-schema"',
      '"kind":"honua.source-schema","\\u006bind":"honua.source-schema"',
    );
    const duplicateNested = serialized.replace('"method":"observed"', '"method":"observed","\\u006dethod":"observed"');

    expect(() => parseSourceSchemaV2(duplicateTopLevel)).toThrow(/duplicate object name/);
    expect(() => parseSourceSchemaV2(duplicateNested)).toThrow(/duplicate object name/);
  });

  it("redacts native credentials without destroying semantic metadata or placeholders", () => {
    const secrets = [
      "http-password",
      "http-access-token",
      "wss-password",
      "wss-client-secret",
      "s3-password",
      "s3-signature",
      "bearer-secret",
      "literal-client-secret",
      "embedded-password",
      "embedded-token",
      "malformed-password",
      "malformed-token",
      "private-material",
      "AKIA1234567890ABCDEF",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ",
    ];
    const schema = createSourceSchemaV2(
      tabularInput({
        fields: [
          integerField({
            native: [
              {
                protocol: "geoservices-feature-service",
                name: "esriFieldTypeInteger",
                path: ["fields", "Status"],
                definition: {
                  domain: {
                    codedValues: [{ code: 1, name: "Active" }],
                    key: "status-code",
                    policy: "merge-preserve",
                    expires: "metadata-lifecycle",
                  },
                  urls: [
                    "http://user:http-password@example.test/path?accessToken=http-access-token",
                    "wss://socket:wss-password@example.test/live?clientSecret=wss-client-secret",
                    "s3://access:s3-password@bucket/key?X-Amz-Signature=s3-signature&policy=signed-policy",
                  ],
                  nested: [
                    { value: "Bearer bearer-secret" },
                    { value: "clientSecret=literal-client-secret" },
                    {
                      value: "endpoint=http://embedded:embedded-password@example.test/path?refreshToken=embedded-token",
                    },
                    {
                      value: "endpoint=http://malformed:malformed-password@example.test:bad/path?token=malformed-token",
                    },
                    { value: secrets[13] },
                    { value: secrets[14] },
                    { value: "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----" },
                  ],
                  config: {
                    token: "${TOKEN}",
                    apiKey: "<API_KEY>",
                    example: "clientSecret={{CLIENT_SECRET}}",
                    documentation: "Use [TOKEN] from the environment",
                  },
                },
              },
            ],
          }),
        ],
      }),
    );
    const definition = schema.fields[0]?.native[0]?.definition as JsonObject;
    const serialized = serializeSourceSchemaV2(schema);

    expect(definition.domain).toEqual({
      codedValues: [{ code: 1, name: "Active" }],
      key: "status-code",
      policy: "merge-preserve",
      expires: "metadata-lifecycle",
    });
    expect(serialized).toContain("${TOKEN}");
    expect(serialized).toContain("<API_KEY>");
    expect(serialized).toContain("{{CLIENT_SECRET}}");
    expect(serialized).toContain("[TOKEN]");
    expect(serialized).toContain("[REDACTED]");
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("signed-policy");
    expect(serialized).not.toContain("user:");
    expect(serialized).not.toContain("socket:");
    expect(serialized).not.toContain("access:");
  });

  it("sanitizes provenance text while preserving identity-bearing validators", () => {
    const validator = '"opaque-etag-v1"';
    const schema = createSourceSchemaV2(
      tabularInput({
        provenance: [
          {
            method: "observed",
            protocol: "odata",
            source: "https://source-user:source-password@example.test/$metadata?X-Amz-Signature=source-signature",
            validator: { kind: "etag", value: validator },
            detail: "Bearer detail-token from bare-user:bare-password@example.test/resource",
          },
        ],
      }),
    );
    const serialized = serializeSourceSchemaV2(schema);

    expect(schema.provenance[0]?.validator?.value).toBe(validator);
    expect(serialized).toContain("opaque-etag-v1");
    for (const secret of [
      "source-user",
      "source-password",
      "source-signature",
      "detail-token",
      "bare-user",
      "bare-password",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  it("preserves hostile native object keys as inert JSON data through create and parse", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"safe":"value"}',
    ) as JsonObject;
    const created = createSourceSchemaV2(
      tabularInput({
        fields: [
          integerField({
            native: [{ protocol: "odata", name: "Edm.Int32", definition: hostile }],
          }),
        ],
      }),
    );
    const parsed = parseSourceSchemaV2(serializeSourceSchemaV2(created));

    for (const schema of [created, parsed]) {
      const definition = schema.fields[0]?.native[0]?.definition as JsonObject;
      expect(Object.getPrototypeOf(definition)).toBeNull();
      expect(Object.hasOwn(definition, "__proto__")).toBe(true);
      expect(Object.hasOwn(definition, "constructor")).toBe(true);
      expect(definition.__proto__).toEqual({ polluted: true });
      expect(definition.constructor).toEqual({ prototype: { polluted: true } });
      expect(definition.safe).toBe("value");
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("validates provenance and reprojection observation metadata", () => {
    expect(() =>
      createSourceSchemaV2(tabularInput({ provenance: [{ ...provenance, observedAt: "13 July 2026" }] })),
    ).toThrow(/RFC 3339/);

    const authority: CrsDefinition = {
      kind: "authority",
      authority: "EPSG",
      code: "4326",
      definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
    };
    const input = spatialInput(authority);
    if (input.geometry.state !== "known") throw new Error("expected known geometry fixture");
    const knownGeometry = input.geometry;
    const field = knownGeometry.fields[0]!;
    const reprojection = (accuracyMeters: number, transformedAt: string): SourceSchemaV2Input => ({
      ...input,
      geometry: {
        ...knownGeometry,
        fields: [
          {
            ...field,
            crs: {
              ...field.crs,
              provenance: {
                method: "reprojected",
                reprojection: { source: authority, target: authority, engine: "PROJ", accuracyMeters, transformedAt },
              },
            },
          },
        ],
      },
    });
    expect(() => createSourceSchemaV2(reprojection(-1, "2026-07-13T00:00:00Z"))).toThrow(/non-negative/);
    expect(() => createSourceSchemaV2(reprojection(1, "yesterday"))).toThrow(/RFC 3339/);
    const mismatchedTarget = reprojection(1, "2026-07-13T00:00:00Z");
    if (mismatchedTarget.geometry.state !== "known") throw new Error("expected known geometry fixture");
    const mismatchedGeometry = mismatchedTarget.geometry;
    expect(() =>
      createSourceSchemaV2({
        ...mismatchedTarget,
        geometry: {
          ...mismatchedGeometry,
          fields: [
            {
              ...mismatchedGeometry.fields[0]!,
              crs: {
                ...mismatchedGeometry.fields[0]!.crs,
                provenance: {
                  method: "reprojected",
                  reprojection: {
                    source: authority,
                    target: { ...authority, code: "3857" },
                    engine: "PROJ",
                  },
                },
              },
            },
          ],
        },
      }),
    ).toThrow(/definition must semantically match provenance\.reprojection\.target/);

    const epochInput = spatialInput(authority);
    if (epochInput.geometry.state !== "known") throw new Error("expected known geometry fixture");
    const epochGeometry = epochInput.geometry;
    const negativeEpoch = createSourceSchemaV2({
      ...epochInput,
      geometry: {
        ...epochGeometry,
        fields: [
          {
            ...epochGeometry.fields[0],
            crs: { ...epochGeometry.fields[0].crs, coordinateEpoch: -1 },
          },
          ...epochGeometry.fields.slice(1),
        ],
      },
    });
    expect(negativeEpoch.geometry).toMatchObject({ state: "known", fields: [{ crs: { coordinateEpoch: -1 } }] });
  });

  it("accepts only offset-normalized June or December RFC 3339 leap-second boundaries", () => {
    for (const observedAt of [
      "2015-06-30T23:59:60.123456789Z",
      "2016-12-31T23:59:60Z",
      "2017-01-01T00:59:60+01:00",
      "2016-12-31T18:59:60-05:00",
    ]) {
      const schema = createSourceSchemaV2(tabularInput({ provenance: [{ ...provenance, observedAt }] }));
      expect(schema.provenance[0]?.observedAt).toBe(observedAt);
    }

    for (const observedAt of [
      "2016-12-30T23:59:60Z",
      "2016-12-31T23:59:60+01:00",
      "2017-01-01T00:00:60Z",
      "2016-12-31T23:59:61Z",
      "2016-12-31T23:59:60",
    ]) {
      expect(() => createSourceSchemaV2(tabularInput({ provenance: [{ ...provenance, observedAt }] }))).toThrow(
        /RFC 3339/,
      );
    }
  });

  it.each([
    "https://user:secret@example.test/crs",
    "https://example.test/crs#axis",
    "https://example.test/crs#",
    "javascript:alert(1)",
    "file:///tmp/crs.json",
    "https://EXAMPLE.test/crs",
    "https://example.test/%7Ecrs",
    "https://example.test/%2fcrs",
    "https://example.test/%zz",
  ])("rejects unsafe or non-canonical CRS URI %s", (uri) => {
    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "uri",
          uri,
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ),
    ).toThrow(/URI|user-info|fragment|scheme|percent|canonical/);
  });

  it("accepts canonical HTTPS and URN CRS identifiers", () => {
    expect(
      createSourceSchemaV2(
        spatialInput({
          kind: "uri",
          uri: "https://www.opengis.net/def/crs/EPSG/0/4326",
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ).geometry.state,
    ).toBe("known");
    expect(
      createSourceSchemaV2(
        spatialInput({
          kind: "uri",
          uri: "urn:ogc:def:crs:EPSG::4326",
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ).geometry.state,
    ).toBe("known");
  });

  it("accepts only bounded PROJJSON v0.7 vocabulary", () => {
    const valid: JsonObject = {
      $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
      ...geodeticCrs(),
    };
    expect(
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson: valid,
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ).geometry.state,
    ).toBe("known");

    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson: { ...valid, $schema: "https://proj.org/schemas/v0.6/projjson.schema.json" },
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ),
    ).toThrow(/v0\.7/);
    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson: { ...valid, type: "VendorCRS" },
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ),
    ).toThrow(/v0\.7 CRS root/);
  });

  it.each([
    "DerivedGeographicCRS",
    "DerivedGeodeticCRS",
    "DerivedVerticalCRS",
    "DerivedEngineeringCRS",
    "DerivedTemporalCRS",
    "DerivedParametricCRS",
    "DerivedProjectedCRS",
  ])("accepts the supported PROJJSON v0.7 derived CRS root %s", (type) => {
    const projjson: JsonObject = {
      $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
      type,
      name: "Derived CRS",
      base_crs: baseCrsForDerived(type),
      conversion: conversion(),
      coordinate_system: cartesianCoordinateSystem(),
    };
    expect(
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson,
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ).geometry.state,
    ).toBe("known");
  });

  it("rejects non-CRS and structurally incomplete PROJJSON roots", () => {
    const definitionAxisOrder = { state: "unknown", reason: "unrecognized" } as const;
    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson: { type: "Conversion", name: "Not a CRS", method: { name: "noop" } },
          definitionAxisOrder,
        }),
      ),
    ).toThrow(/CRS root/);
    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson: { type: "ProjectedCRS", name: "Missing required containers" },
          definitionAxisOrder,
        }),
      ),
    ).toThrow(/base_crs/);
    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson: {
            ...geodeticCrs("Unexpected root member"),
            executable: true,
          },
          definitionAxisOrder,
        }),
      ),
    ).toThrow(/official PROJJSON v0\.7.*must NOT have additional properties/);
    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson: {
            type: "BoundCRS",
            source_crs: {
              ...geodeticCrs(),
            },
            target_crs: {
              ...geodeticCrs(),
            },
            transformation: { name: "Incomplete", method: { name: "Longitude rotation" } },
          },
          definitionAxisOrder,
        }),
      ),
    ).toThrow(/transformation\.parameters/);
  });

  it.each([
    {
      name: "geodetic datum without an ellipsoid",
      projjson: {
        type: "GeographicCRS",
        name: "Incomplete geodetic CRS",
        datum: { type: "GeodeticReferenceFrame", name: "Missing ellipsoid" },
      },
    },
    {
      name: "coordinate-system axis without an abbreviation",
      projjson: {
        ...geodeticCrs(),
        coordinate_system: {
          subtype: "ellipsoidal",
          axis: [
            { name: "Latitude", direction: "north", unit: "degree" },
            { name: "Longitude", abbreviation: "Lon", direction: "east", unit: "degree" },
          ],
        },
      },
    },
    {
      name: "ellipsoid with mutually exclusive dimensions",
      projjson: {
        type: "GeographicCRS",
        name: "Ambiguous ellipsoid",
        datum: {
          type: "GeodeticReferenceFrame",
          name: "Ambiguous datum",
          ellipsoid: {
            type: "Ellipsoid",
            name: "Ambiguous",
            semi_major_axis: 6378137,
            semi_minor_axis: 6356752,
            inverse_flattening: 298.257223563,
          },
        },
      },
    },
  ])("rejects official-PROJJSON violation: $name", ({ projjson }) => {
    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson: projjson as JsonObject,
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ),
    ).toThrow(/official PROJJSON v0\.7/);
  });

  it("rejects deeply nested PROJJSON deterministically before recursive serialization", () => {
    let nested: JsonObject = { leaf: true };
    for (let index = 0; index < 40; index++) nested = { nested };
    const projjson = {
      $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
      type: "GeographicCRS",
      name: "Too deep",
      nested,
    } as JsonObject;

    expect(() =>
      createSourceSchemaV2(
        spatialInput({
          kind: "projjson",
          projjson,
          definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
        }),
      ),
    ).toThrow(/maximum JSON nesting depth 32/);
  });
});
