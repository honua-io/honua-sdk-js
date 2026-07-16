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
    <EnumType Name="AssetStatus" UnderlyingType="Edm.Int16">
      <Member Name="Active" Value="1"/>
      <Member Name="Retired" Value="2"/>
    </EnumType>
    <EnumType Name="Permissions" UnderlyingType="Edm.Int64" IsFlags="true">
      <Member Name="Read" Value="1"/>
      <Member Name="Write" Value="2"/>
      <Member Name="Admin" Value="4"/>
    </EnumType>
    <EnumType Name="BrokenFlags" IsFlags="true">
      <Member Name="Implicit"/>
    </EnumType>
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
      <Property Name="Payload" Type="Edm.Binary" MaxLength="5"/>
      <Property Name="ObservedOn" Type="Edm.Date"/>
      <Property Name="ObservedAt" Type="Edm.DateTimeOffset" Precision="3"/>
      <Property Name="Elapsed" Type="Edm.Duration" Precision="3"/>
      <Property Name="LocalTime" Type="Edm.TimeOfDay" Precision="3"/>
      <Property Name="Status" Type="Example.AssetStatus"/>
      <Property Name="Permissions" Type="Example.Permissions"/>
      <Property Name="Broken" Type="Example.BrokenFlags"/>
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
    <EntityType Name="DateKey">
      <Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.Date" Nullable="false"/>
    </EntityType>
    <EntityType Name="DateTimeKey">
      <Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.DateTimeOffset" Nullable="false" Precision="3"/>
    </EntityType>
    <EntityType Name="DurationKey">
      <Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.Duration" Nullable="false" Precision="3"/>
    </EntityType>
    <EntityType Name="BinaryKey">
      <Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.Binary" Nullable="false" MaxLength="5"/>
    </EntityType>
    <EntityType Name="EnumKey">
      <Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Example.AssetStatus" Nullable="false"/>
    </EntityType>
    <EntityContainer Name="Container">
      <EntitySet Name="Assets" EntityType="Example.Asset"/>
      <EntitySet Name="LongKeys" EntityType="Example.LongKey"/>
      <EntitySet Name="StringKeys" EntityType="Example.StringKey"/>
      <EntitySet Name="GuidKeys" EntityType="Example.GuidKey"/>
      <EntitySet Name="DateKeys" EntityType="Example.DateKey"/>
      <EntitySet Name="DateTimeKeys" EntityType="Example.DateTimeKey"/>
      <EntitySet Name="DurationKeys" EntityType="Example.DurationKey"/>
      <EntitySet Name="BinaryKeys" EntityType="Example.BinaryKey"/>
      <EntitySet Name="EnumKeys" EntityType="Example.EnumKey"/>
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

describe("OData primitive and enum admission", () => {
  it("admits canonical temporal, binary, and enum values without precision loss", () => {
    expect(
      encodeOdataWriteBody(metadata, "Assets", {
        Payload: "T0RhdGE",
        ObservedOn: "2024-02-29",
        ObservedAt: "2024-02-29T23:59:60.123+23:59",
        Elapsed: "+P1DT2H3M4.125S",
        LocalTime: "23:59:60.123",
        Status: "1",
        Permissions: "7",
      }).body,
    ).toEqual({
      Payload: "T0RhdGE",
      ObservedOn: "2024-02-29",
      ObservedAt: "2024-02-29T23:59:60.123+23:59",
      Elapsed: "+P1DT2H3M4.125S",
      LocalTime: "23:59:60.123",
      Status: "Active",
      Permissions: "Read,Write,Admin",
    });
  });

  it.each(["P1D", "PT0S", "-P2DT3H", "+PT4M", "P1DT2H3M4.125S"])(
    "admits the canonical day-time duration %s",
    (value) => {
      expect(encodeOdataWriteBody(metadata, "Assets", { Elapsed: value }).body.Elapsed).toBe(value);
    },
  );

  it.each(["P", "PT", "P1DT", "P1M", "PT.5S", "P1DT2.1234S", "1D", "P1D2H"])(
    "rejects malformed or over-precise day-time duration %s",
    (value) => {
      const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { Elapsed: value }));
      expect(error.code).toBe("invalid-value");
      expect(error.path).toBe("$.Elapsed");
      expect(error.message).not.toContain(value);
    },
  );

  it.each([
    ["ObservedOn", "2023-02-29"],
    ["ObservedOn", "1900-02-29"],
    ["ObservedOn", "2024-02-30"],
    ["ObservedOn", "2024-04-31"],
    ["ObservedOn", "2024-13-01"],
    ["ObservedAt", "2023-02-29T12:00:00Z"],
    ["ObservedAt", "2024-01-01T12:00:00.1234Z"],
    ["ObservedAt", "2024-01-01T24:00:00Z"],
    ["ObservedAt", "2024-01-01T12:00:00+24:00"],
    ["LocalTime", "12:00:00.1234"],
  ])("rejects impossible or over-precise temporal %s value", (field, value) => {
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { [field]: value }));
    expect(error.code).toBe("invalid-value");
    expect(error.path).toBe(`$.${field}`);
    expect(error.message).not.toContain(value);
  });

  it.each(["", "TQ", "TQ==", "TWE", "TWE=", "TWFu", "T0RhdGE"])("admits canonical base64url binary %s", (value) => {
    expect(encodeOdataWriteBody(metadata, "Assets", { Payload: value }).body.Payload).toBe(value);
  });

  it.each(["A", "AB", "ABC", "TQ=", "TWE==", "TWFu=", "TQ===", "T+/=", "T0RhdGEh"])(
    "rejects non-canonical, malformed, or over-length binary %s",
    (value) => {
      const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { Payload: value }));
      expect(error.code).toBe("invalid-value");
      expect(error.path).toBe("$.Payload");
      expect(error.message).not.toContain(value);
    },
  );

  it("validates declared enum names and flag combinations", () => {
    expect(
      encodeOdataWriteBody(metadata, "Assets", {
        Status: "Retired",
        Permissions: "Read,Admin",
      }).body,
    ).toEqual({ Status: "Retired", Permissions: "Read,Admin" });
  });

  it.each([
    ["Status", "Deleted", "invalid-value"],
    ["Status", "Active,Retired", "invalid-value"],
    ["Status", "32768", "invalid-value"],
    ["Permissions", "Read,Read", "invalid-value"],
    ["Permissions", "Read,Unknown", "invalid-value"],
    ["Permissions", "-1", "invalid-value"],
    ["Broken", "Implicit", "invalid-metadata"],
  ])("rejects undeclared or invalid enum %s value", (field, value, code) => {
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { [field]: value }));
    expect(error.code).toBe(code);
    expect(error.path).toBe(`$.${field}`);
    expect(error.message).not.toContain(value);
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
    ["DateKeys", "2024-02-29", "2024-02-29"],
    ["DateTimeKeys", "2024-02-29T12:30:00.123Z", "2024-02-29T12:30:00.123Z"],
    ["DurationKeys", "P1DT2H", "duration'P1DT2H'"],
    ["BinaryKeys", "TQ==", "binary'TQ=='"],
    ["EnumKeys", "Active", "Example.AssetStatus'Active'"],
    ["EnumKeys", "1", "Example.AssetStatus'Active'"],
  ])("formats an admitted %s primitive key", (entitySet, value, literal) => {
    expect(encodeOdataEntityKey(metadata, entitySet, value).literal).toBe(literal);
  });

  it.each([
    ["DateKeys", "2023-02-29"],
    ["DateTimeKeys", "2024-02-30T12:00:00Z"],
    ["DurationKeys", "P1DT"],
    ["BinaryKeys", "AB"],
    ["EnumKeys", "Unknown"],
  ])("rejects a malformed %s primitive key locally", (entitySet, value) => {
    const error = encodingFailure(() => encodeOdataEntityKey(metadata, entitySet, value));
    expect(error.code).toBe("invalid-value");
    expect(error.path).toBe("$.key.Id");
    expect(error.message).not.toContain(value);
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

  it.each([
    [
      "getPrototypeOf",
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("prototype-trap-secret");
            },
          },
        ),
    ],
    [
      "ownKeys",
      () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("own-keys-trap-secret");
            },
          },
        ),
    ],
    [
      "getOwnPropertyDescriptor",
      () =>
        new Proxy(
          { Id: "1" },
          {
            getOwnPropertyDescriptor() {
              throw new Error("descriptor-trap-secret");
            },
          },
        ),
    ],
  ])("contains a body Proxy %s trap behind a fixed redacted error", (_trap, bodyFactory) => {
    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", bodyFactory()));
    expect(error.code).toBe("invalid-value");
    expect(error.message).not.toContain("trap-secret");
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects collection element accessors without evaluating them", () => {
    let invoked = false;
    const balances: unknown[] = [];
    Object.defineProperty(balances, "0", {
      configurable: true,
      enumerable: true,
      get() {
        invoked = true;
        return "array-accessor-secret";
      },
    });
    balances.length = 1;

    const error = encodingFailure(() => encodeOdataWriteBody(metadata, "Assets", { Balances: balances }));
    expect(error.code).toBe("invalid-value");
    expect(error.path).toBe("$.Balances[0]");
    expect(invoked).toBe(false);
    expect(error.message).not.toContain("array-accessor-secret");
  });

  it("contains metadata Proxy traps as fixed invalid-metadata failures", () => {
    const trappedMetadata = new Proxy(metadata, {
      get(target, property, receiver) {
        if (property === "entitySets") throw new Error("metadata-trap-secret");
        return Reflect.get(target, property, receiver);
      },
    });

    const error = encodingFailure(() => encodeOdataWriteBody(trappedMetadata, "Assets", {}));
    expect(error.code).toBe("invalid-metadata");
    expect(error.path).toBe("$");
    expect(error.message).not.toContain("metadata-trap-secret");
    expect(error).not.toHaveProperty("cause");
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
