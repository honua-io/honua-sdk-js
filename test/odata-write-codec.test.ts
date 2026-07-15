import { describe, expect, it } from "vitest";

import {
  HonuaOdataEdmEncodingError,
  encodeOdataEntityKey,
  encodeOdataWriteBody,
} from "../src/core/odata-write-codec.js";
import { parseOdataMetadata } from "../src/core/odata.js";

const metadata = parseOdataMetadata(`
  <Schema Namespace="Example">
    <ComplexType Name="Address">
      <Property Name="Street" Type="Edm.String" MaxLength="128"/>
      <Property Name="Limit" Type="Edm.Int64"/>
      <Property Name="Price" Type="Edm.Decimal" Precision="38" Scale="9"/>
      <Property Name="Reading" Type="Edm.Double"/>
    </ComplexType>
    <ComplexType Name="Measurement">
      <Property Name="Amount" Type="Edm.Decimal" Precision="38" Scale="9"/>
      <Property Name="Reading" Type="Edm.Single"/>
    </ComplexType>
    <ComplexType Name="Node">
      <Property Name="Amount" Type="Edm.Decimal" Precision="38" Scale="4"/>
      <Property Name="Next" Type="Example.Node"/>
    </ComplexType>
    <EntityType Name="Asset">
      <Key><PropertyRef Name="Tenant"/><PropertyRef Name="Id"/></Key>
      <Property Name="Tenant" Type="Edm.String" Nullable="false"/>
      <Property Name="Id" Type="Edm.Int64" Nullable="false"/>
      <Property Name="Amount" Type="Edm.Decimal" Precision="38" Scale="9"/>
      <Property Name="Ratio" Type="Edm.Double"/>
      <Property Name="Score" Type="Edm.Single"/>
      <Property Name="CorrelationId" Type="Edm.Guid"/>
      <Property Name="Address" Type="Example.Address"/>
      <Property Name="Measurements" Type="Collection(Example.Measurement)"/>
      <Property Name="Balances" Type="Collection(Edm.Decimal)" Precision="38" Scale="4"/>
      <Property Name="Root" Type="Example.Node"/>
      <Property Name="Nodes" Type="Collection(Example.Node)"/>
    </EntityType>
    <EntityType Name="LongKey">
      <Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.Int64" Nullable="false"/>
    </EntityType>
    <EntityType Name="StringKey">
      <Key><PropertyRef Name="Name"/></Key>
      <Property Name="Name" Type="Edm.String" Nullable="false" MaxLength="256"/>
    </EntityType>
    <EntityType Name="GuidKey">
      <Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.Guid" Nullable="false"/>
    </EntityType>
    <EntityContainer Name="Container">
      <EntitySet Name="Assets" EntityType="Example.Asset"/>
      <EntitySet Name="LongKeys" EntityType="Example.LongKey"/>
      <EntitySet Name="StringKeys" EntityType="Example.StringKey"/>
      <EntitySet Name="GuidKeys" EntityType="Example.GuidKey"/>
    </EntityContainer>
  </Schema>
`);

function encodingFailure(run: () => unknown): HonuaOdataEdmEncodingError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HonuaOdataEdmEncodingError);
    return error as HonuaOdataEdmEncodingError;
  }
  throw new Error("expected OData encoding to fail");
}

describe("OData lossless write body encoding", () => {
  it("recursively preserves exact integers and decimals and maps special floats", () => {
    const input = {
      Tenant: "north",
      Id: 9_223_372_036_854_775_807n,
      Amount: "12345678901234567890.123456789",
      Ratio: Number.POSITIVE_INFINITY,
      Score: Number.NaN,
      CorrelationId: "01234567-89ab-cdef-0123-456789abcdef",
      Address: {
        Street: "Main",
        Limit: "-9223372036854775808",
        Price: "99999999999999999999.000000001",
        Reading: Number.NEGATIVE_INFINITY,
      },
      Measurements: [
        { Amount: "0.000000001", Reading: "INF" },
        { Amount: 12.5, Reading: -3.25 },
      ],
      Balances: ["123456789012345678901234567890.1234", 0.25],
      Extension: { finite: 4, labels: ["a", null] },
    };

    const encoded = encodeOdataWriteBody(metadata, "Assets", input);

    expect(encoded).toEqual({
      body: {
        Tenant: "north",
        Id: "9223372036854775807",
        Amount: "12345678901234567890.123456789",
        Ratio: "INF",
        Score: "NaN",
        CorrelationId: "01234567-89ab-cdef-0123-456789abcdef",
        Address: {
          Street: "Main",
          Limit: "-9223372036854775808",
          Price: "99999999999999999999.000000001",
          Reading: "-INF",
        },
        Measurements: [
          { Amount: "0.000000001", Reading: "INF" },
          { Amount: "12.5", Reading: -3.25 },
        ],
        Balances: ["123456789012345678901234567890.1234", "0.25"],
        Extension: { finite: 4, labels: ["a", null] },
      },
      requiresIeee754Compatible: true,
    });
    expect(input.Id).toBe(9_223_372_036_854_775_807n);
    expect(input.Address.Limit).toBe("-9223372036854775808");
  });

  it("does not request IEEE754Compatible when no non-null Int64 or Decimal is present", () => {
    const encoded = encodeOdataWriteBody(metadata, "Assets", {
      Tenant: "north",
      Ratio: 1.5,
      Score: "-INF",
      CorrelationId: "01234567-89ab-cdef-0123-456789abcdef",
      Amount: null,
    });

    expect(encoded.requiresIeee754Compatible).toBe(false);
    expect(encoded.body).toEqual({
      Tenant: "north",
      Ratio: 1.5,
      Score: "-INF",
      CorrelationId: "01234567-89ab-cdef-0123-456789abcdef",
      Amount: null,
    });
  });

  it.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "INF"],
    [Number.NEGATIVE_INFINITY, "-INF"],
    ["NaN", "NaN"],
    ["INF", "INF"],
    ["-INF", "-INF"],
    ["1.25e2", 125],
  ] as const)("encodes Edm.Double input %s as the OData JSON lexical form", (input, expected) => {
    expect(encodeOdataWriteBody(metadata, "Assets", { Ratio: input }).body.Ratio).toBe(expected);
  });

  it.each([
    ["Id", "9223372036854775808"],
    ["Id", "-9223372036854775809"],
    ["Id", "01"],
    ["Id", "1.0"],
    ["Id", Number.MAX_SAFE_INTEGER + 1],
    ["Amount", "1e3"],
    ["Amount", "1.1234567890"],
    ["Amount", "123456789012345678901234567890123456789"],
    ["Amount", Number.NaN],
    ["Ratio", "Infinity"],
    ["Ratio", "01"],
  ])("rejects invalid exact or floating value for %s", (field, value) => {
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { [field]: value }));
    expect(error.code).toBe("invalid-value");
    expect(error.path).toBe(`$.${field}`);
  });

  it.each([
    "{01234567-89ab-cdef-0123-456789abcdef}",
    "0123456789abcdef0123456789abcdef",
    "01234567-89ab-cdef-0123-456789abcdeg",
    " 01234567-89ab-cdef-0123-456789abcdef",
  ])("strictly rejects non-canonical GUID %s without retaining it", (value) => {
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { CorrelationId: value }));
    expect(error.code).toBe("invalid-value");
    expect(error.message).not.toContain(value);
  });

  it("expands finite exponent numbers before encoding Edm.Decimal strings", () => {
    expect(
      encodeOdataWriteBody(metadata, "Assets", {
        Amount: 1e-7,
        Balances: [1e3],
      }).body,
    ).toEqual({ Amount: "0.0000001", Balances: ["1000"] });
  });
});

describe("OData metadata-typed key encoding", () => {
  it.each([
    ["9223372036854775807", "9223372036854775807"],
    [-9_223_372_036_854_775_808n, "-9223372036854775808"],
    [42, "42"],
  ] as const)("keeps the Int64 key %s exact and unquoted", (input, expected) => {
    expect(encodeOdataEntityKey(metadata, "LongKeys", input)).toEqual({
      literal: expected,
      pathSegment: expected,
    });
  });

  it("escapes string literals and emits a single path-safe segment", () => {
    expect(encodeOdataEntityKey(metadata, "StringKeys", "O'Neil/a,b=c?#%")).toEqual({
      literal: "'O''Neil/a,b=c?#%'",
      pathSegment: "%27O%27%27Neil%2Fa%2Cb%3Dc%3F%23%25%27",
    });
  });

  it("formats composite components in CSDL key order", () => {
    expect(
      encodeOdataEntityKey(metadata, "Assets", {
        Id: "9223372036854775807",
        Tenant: "x/y,O'Neil",
      }),
    ).toEqual({
      literal: "Tenant='x/y,O''Neil',Id=9223372036854775807",
      pathSegment: "Tenant%3D%27x%2Fy%2CO%27%27Neil%27%2CId%3D9223372036854775807",
    });
  });

  it("accepts the unqualified suffix of a navigation-shaped entity-set path", () => {
    expect(encodeOdataEntityKey(metadata, "Layers(7)/LongKeys", { Id: "17" }).literal).toBe("17");
  });

  it("keeps canonical GUID keys unquoted", () => {
    const guid = "01234567-89AB-CDEF-0123-456789ABCDEF";
    expect(encodeOdataEntityKey(metadata, "GuidKeys", guid)).toEqual({ literal: guid, pathSegment: guid });
  });

  it.each([
    ["GuidKeys", "{01234567-89ab-cdef-0123-456789abcdef}", "invalid-value"],
    ["LongKeys", Number.MAX_SAFE_INTEGER + 1, "invalid-value"],
    ["Assets", "Tenant=north,Id=3", "missing-key"],
    ["Assets", { Tenant: "north" }, "missing-key"],
  ])("rejects malformed key input for %s", (entitySet, key, code) => {
    const error = encodingFailure(() => encodeOdataEntityKey(metadata, entitySet, key));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(String(key));
  });
});

describe("OData codec adversarial bounds and redaction", () => {
  it("bounds recursive complex values at the configured depth", () => {
    const body = {
      Root: {
        Amount: "1.0",
        Next: {
          Amount: "2.0",
          Next: { Amount: "credential-value-that-must-not-appear" },
        },
      },
    };
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", body, { maxDepth: 2 }));

    expect(error.code).toBe("max-depth-exceeded");
    expect(error.path).toBe("$.Root.Next.Next");
    expect(error.message).not.toContain("credential-value-that-must-not-appear");
  });

  it("counts both collection and complex containers toward the bound", () => {
    const error = encodingFailure(() =>
      encodeOdataWriteBody(metadata, "Assets", { Nodes: [{ Amount: "1.0" }] }, { maxDepth: 1 }),
    );
    expect(error.code).toBe("max-depth-exceeded");
    expect(error.path).toBe("$.Nodes[0]");
  });

  it("detects object cycles without retaining the body", () => {
    const node: Record<string, unknown> = { Amount: "1.0" };
    node.Next = node;
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { Root: node }));

    expect(error.code).toBe("cyclic-value");
    expect(error.path).toBe("$.Root.Next");
    expect(error).not.toHaveProperty("value");
    expect(error).not.toHaveProperty("body");
  });

  it("rejects accessors without evaluating them", () => {
    let invoked = false;
    const body: Record<string, unknown> = {};
    Object.defineProperty(body, "Id", {
      enumerable: true,
      get() {
        invoked = true;
        return "credential-value-that-must-not-appear";
      },
    });

    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", body));
    expect(error.code).toBe("invalid-value");
    expect(invoked).toBe(false);
    expect(error.message).not.toContain("credential-value-that-must-not-appear");
  });

  it("escapes and bounds hostile property names in diagnostic paths", () => {
    const hostileName = `line\nbreak-${"x".repeat(500)}`;
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { [hostileName]: 1n }));

    expect(error.code).toBe("invalid-value");
    expect(error.message).not.toContain("\n");
    expect(error.path.length).toBeLessThan(100);
    expect(error.path).toContain("…");
  });

  it.each([-1, 1.5, 33, Number.POSITIVE_INFINITY])("rejects an unbounded maxDepth option", (maxDepth) => {
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", {}, { maxDepth }));
    expect(error.code).toBe("invalid-options");
    expect(error.path).toBe("$.options.maxDepth");
  });

  it("fails locally when the metadata snapshot does not declare the entity set", () => {
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Secrets", {}));
    expect(error.code).toBe("unknown-entity-set");
    expect(error.message).not.toContain("Secrets");
  });
});
