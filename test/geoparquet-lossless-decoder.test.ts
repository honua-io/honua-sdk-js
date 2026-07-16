import { tableFromArrays } from "apache-arrow";
import { describe, expect, it } from "vitest";

import type { AggregationSpec } from "../src/contract/types.js";
import {
  DuckDbLosslessDecodeError,
  compileDuckDbLosslessRowDecoder,
  compileDuckDbLosslessValueDecoder,
  decodeDuckDbLosslessValue,
  deriveDuckDbAggregateOutputFields,
  duckDbLosslessTransportKind,
} from "../src/geoparquet/lossless-decoder.js";

function littleEndian128(value: bigint): Uint8Array {
  const modulus = 1n << 128n;
  let encoded = value < 0n ? modulus + value : value;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  return bytes;
}

function expectFailure(action: () => unknown, code: DuckDbLosslessDecodeError["code"]): DuckDbLosslessDecodeError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DuckDbLosslessDecodeError);
    const failure = error as DuckDbLosslessDecodeError;
    expect(failure.code).toBe(code);
    return failure;
  }
  throw new Error("expected lossless decoder failure");
}

function nestedSingleton(depth: number, leaf: unknown): unknown {
  let value = leaf;
  for (let index = 0; index < depth; index++) value = [value];
  return value;
}

class Vector {
  public readonly length: number;
  public readonly get: (index: number) => unknown;

  public constructor(values: readonly unknown[]) {
    this.length = values.length;
    this.get = (index) => values[index];
  }
}

class StructRow {
  public constructor(private readonly entries: readonly (readonly [string, unknown])[]) {}

  public *[Symbol.iterator](): IterableIterator<readonly [string, unknown]> {
    yield* this.entries;
  }
}

class MapRow {
  public constructor(private readonly entries: readonly (readonly [unknown, unknown])[]) {}

  public *[Symbol.iterator](): IterableIterator<readonly [unknown, unknown]> {
    yield* this.entries;
  }
}

describe("GeoParquet lossless DuckDB value decoder", () => {
  const scalarCases: ReadonlyArray<{
    readonly label: string;
    readonly type: string;
    readonly value: unknown;
    readonly expected: unknown;
  }> = [
    {
      label: "BIGINT above Number.MAX_SAFE_INTEGER",
      type: "BIGINT",
      value: 9_007_199_254_740_993n,
      expected: "9007199254740993",
    },
    {
      label: "maximum BIGINT",
      type: "BIGINT",
      value: 9_223_372_036_854_775_807n,
      expected: "9223372036854775807",
    },
    {
      label: "minimum HUGEINT Arrow bytes",
      type: "HUGEINT",
      value: littleEndian128(-(1n << 127n)),
      expected: "-170141183460469231731687303715884105728",
    },
    {
      label: "maximum HUGEINT Arrow bytes",
      type: "HUGEINT",
      value: littleEndian128((1n << 127n) - 1n),
      expected: "170141183460469231731687303715884105727",
    },
    {
      label: "maximum UBIGINT",
      type: "UBIGINT",
      value: 18_446_744_073_709_551_615n,
      expected: "18446744073709551615",
    },
    {
      label: "positive decimal Arrow bytes",
      type: "DECIMAL(29,9)",
      value: littleEndian128(12_345_678_901_234_567_890_123_456_789n),
      expected: "12345678901234567890.123456789",
    },
    {
      label: "negative decimal Arrow bytes and declared trailing scale",
      type: "NUMERIC(20,6)",
      value: littleEndian128(-12_345_600n),
      expected: "-12.345600",
    },
    {
      label: "canonical decimal string padded to declared scale",
      type: "DECIMAL(8,4)",
      value: "12.3",
      expected: "12.3000",
    },
    {
      label: "DATE from Arrow epoch milliseconds",
      type: "DATE",
      value: Date.UTC(2024, 1, 29),
      expected: "2024-02-29",
    },
    {
      label: "TIME from Arrow epoch microseconds",
      type: "TIME",
      value: 86_399_123_456n,
      expected: "23:59:59.123456",
    },
    {
      label: "TIME WITH TIME ZONE retains an explicit offset",
      type: "TIME WITH TIME ZONE",
      value: "12:34:56.1234+05:30",
      expected: "12:34:56.123400+05:30",
    },
    {
      label: "TIMESTAMP_S",
      type: "TIMESTAMP_S",
      value: 1_704_164_645_000,
      expected: "2024-01-02T03:04:05",
    },
    {
      label: "TIMESTAMP_MS",
      type: "TIMESTAMP_MS",
      value: 1_704_164_645_123,
      expected: "2024-01-02T03:04:05.123",
    },
    {
      label: "TIMESTAMP microseconds from Arrow fractional milliseconds",
      type: "TIMESTAMP",
      value: 1_704_164_645_123.456,
      expected: "2024-01-02T03:04:05.123456",
    },
    {
      label: "TIMESTAMP_NS from exact epoch nanoseconds",
      type: "TIMESTAMP_NS",
      value: 1_704_164_645_123_456_789n,
      expected: "2024-01-02T03:04:05.123456789",
    },
    {
      label: "TIMESTAMPTZ normalizes an offset to UTC",
      type: "TIMESTAMPTZ",
      value: "2024-01-02 03:04:05.123456+05:30",
      expected: "2024-01-01T21:34:05.123456Z",
    },
    {
      label: "TIMESTAMP WITH TIME ZONE from Arrow fractional milliseconds",
      type: "TIMESTAMP WITH TIME ZONE",
      value: 1_704_144_845_123.456,
      expected: "2024-01-01T21:34:05.123456Z",
    },
    {
      label: "BLOB base64",
      type: "BLOB",
      value: new Uint8Array([0, 255, 65]),
      expected: "AP9B",
    },
  ];

  for (const fixture of scalarCases) {
    it(`decodes ${fixture.label}`, () => {
      const decoded = decodeDuckDbLosslessValue(fixture.type, fixture.value, "value");
      expect(decoded).toEqual(fixture.expected);
      expect(() => JSON.stringify(decoded)).not.toThrow();
    });
  }

  it("compiles and reuses one effective-type decoder", () => {
    const decoder = compileDuckDbLosslessValueDecoder("BIGINT");
    expect(decoder.declaredType).toBe("BIGINT");
    expect(decoder.decode(1n, "first")).toBe("1");
    expect(decoder.decode(2n, "second")).toBe("2");
    expect(Object.isFrozen(decoder)).toBe(true);
  });

  it("compiles a strict row decoder and classifies exact Arrow transports", () => {
    const decoder = compileDuckDbLosslessRowDecoder([
      { name: "id", type: "BIGINT" },
      { name: "amount", type: "DECIMAL(10,2)" },
    ]);
    expect(decoder.decode({ id: 9_007_199_254_740_993n, amount: "12.30" })).toEqual({
      id: "9007199254740993",
      amount: "12.30",
    });
    expect(duckDbLosslessTransportKind("BIGINT")).toBe("text");
    expect(duckDbLosslessTransportKind("TIMESTAMPTZ")).toBe("utc-timestamp-text");
    expect(duckDbLosslessTransportKind("STRUCT(id BIGINT)")).toBe("native");
  });

  it("recursively decodes arrays, lists, quoted structs, maps, and Arrow-shaped wrappers", () => {
    const decoder = compileDuckDbLosslessValueDecoder(
      'STRUCT("asset id" BIGINT, amounts DECIMAL(10,2)[], flags BOOLEAN[2], metadata MAP(VARCHAR, HUGEINT))',
    );
    const decoded = decoder.decode(
      new StructRow([
        ["asset id", 9_007_199_254_740_993n],
        ["amounts", new Vector([littleEndian128(123n), littleEndian128(-450n)])],
        ["flags", new Vector([true, false])],
        [
          "metadata",
          new MapRow([
            ["maximum", littleEndian128((1n << 127n) - 1n)],
            ["minimum", littleEndian128(-(1n << 127n))],
          ]),
        ],
      ]),
      "attributes",
    );

    expect(decoded).toEqual({
      "asset id": "9007199254740993",
      amounts: ["1.23", "-4.50"],
      flags: [true, false],
      metadata: [
        { key: "maximum", value: "170141183460469231731687303715884105727" },
        { key: "minimum", value: "-170141183460469231731687303715884105728" },
      ],
    });
    const serialized = JSON.stringify(decoded);
    expect(serialized).not.toContain("bigint");
    expect(serialized).not.toContain("Uint8Array");
  });

  it("decodes real Apache Arrow 17 Vector and StructRow wrappers without a runtime import", () => {
    const table = tableFromArrays({
      items: [[9_007_199_254_740_993n, 9_223_372_036_854_775_807n]],
      record: [{ id: 9_007_199_254_740_994n, label: "parcel" }],
    });
    const row = table.toArray()[0];
    expect(row).toBeDefined();
    expect(
      decodeDuckDbLosslessValue("STRUCT(items BIGINT[], record STRUCT(id BIGINT, label VARCHAR))", row, "attributes"),
    ).toEqual({
      items: ["9007199254740993", "9223372036854775807"],
      record: { id: "9007199254740994", label: "parcel" },
    });
  });

  it("represents MAP as ordered key/value entries without string-key collisions", () => {
    expect(
      decodeDuckDbLosslessValue(
        "MAP(BIGINT, VARCHAR)",
        new Map<unknown, unknown>([
          [1n, "integer"],
          [2n, "second"],
        ]),
      ),
    ).toEqual([
      { key: "1", value: "integer" },
      { key: "2", value: "second" },
    ]);
  });

  const invalidCases: ReadonlyArray<{
    readonly label: string;
    readonly type: string;
    readonly value: unknown;
    readonly code: DuckDbLosslessDecodeError["code"];
  }> = [
    {
      label: "unsafe integer number",
      type: "BIGINT",
      value: Number.MAX_SAFE_INTEGER + 1,
      code: "GEOPARQUET_LOSSLESS_PRECISION_LOSS",
    },
    {
      label: "out-of-range unsigned integer",
      type: "UBIGINT",
      value: -1n,
      code: "GEOPARQUET_LOSSLESS_INVALID_VALUE",
    },
    {
      label: "decimal number wrapper",
      type: "DECIMAL(10,2)",
      value: 1.23,
      code: "GEOPARQUET_LOSSLESS_PRECISION_LOSS",
    },
    {
      label: "decimal precision overflow",
      type: "DECIMAL(5,2)",
      value: "1234.56",
      code: "GEOPARQUET_LOSSLESS_INVALID_VALUE",
    },
    {
      label: "unsafe Arrow nanosecond timestamp number",
      type: "TIMESTAMP_NS",
      value: 1_704_164_645_123.4568,
      code: "GEOPARQUET_LOSSLESS_PRECISION_LOSS",
    },
    {
      label: "timezone-less TIME wrapper for TIME WITH TIME ZONE",
      type: "TIME WITH TIME ZONE",
      value: 12_345_678n,
      code: "GEOPARQUET_LOSSLESS_PRECISION_LOSS",
    },
    {
      label: "impossible calendar date",
      type: "DATE",
      value: "2023-02-29",
      code: "GEOPARQUET_LOSSLESS_INVALID_VALUE",
    },
    {
      label: "non-finite floating point",
      type: "DOUBLE",
      value: Number.POSITIVE_INFINITY,
      code: "GEOPARQUET_LOSSLESS_INVALID_VALUE",
    },
    {
      label: "ambiguous scalar wrapper",
      type: "BIGINT",
      value: { value: 1n },
      code: "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER",
    },
    {
      label: "wrong fixed ARRAY length",
      type: "INTEGER[2]",
      value: [1],
      code: "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER",
    },
  ];

  for (const fixture of invalidCases) {
    it(`fails closed for ${fixture.label}`, () => {
      expectFailure(() => decodeDuckDbLosslessValue(fixture.type, fixture.value, "secret-field"), fixture.code);
    });
  }

  it("detects cycles at their bounded field path", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const error = expectFailure(
      () => decodeDuckDbLosslessValue("BIGINT[][]", cycle, "values"),
      "GEOPARQUET_LOSSLESS_CYCLE",
    );
    expect(error.path).toBe("$.values[0]");
  });

  it("rejects data accessors without invoking them", () => {
    let reads = 0;
    const value: unknown[] = [];
    Object.defineProperty(value, "0", {
      enumerable: true,
      get() {
        reads++;
        return 1n;
      },
    });
    Object.defineProperty(value, "length", { value: 1, writable: true });
    const error = expectFailure(
      () => decodeDuckDbLosslessValue("BIGINT[]", value, "values"),
      "GEOPARQUET_LOSSLESS_ACCESSOR",
    );
    expect(error.path).toBe("$.values[0]");
    expect(reads).toBe(0);
  });

  it("contains hostile proxy ownKeys, descriptor, and prototype traps in redacted errors", () => {
    const secrets = ["ownkeys-secret", "descriptor-secret", "prototype-secret"];
    const values = [
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error(secrets[0]);
          },
        },
      ),
      new Proxy(
        { id: 1n },
        {
          getOwnPropertyDescriptor() {
            throw new Error(secrets[1]);
          },
        },
      ),
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error(secrets[2]);
          },
        },
      ),
    ];

    const actions = [
      () => decodeDuckDbLosslessValue("STRUCT(id BIGINT)", values[0], "row"),
      () => decodeDuckDbLosslessValue("STRUCT(id BIGINT)", values[1], "row"),
      () => decodeDuckDbLosslessValue("MAP(VARCHAR, BIGINT)", values[2], "row"),
    ];
    for (const action of actions) {
      const error = expectFailure(action, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER");
      const serialized = JSON.stringify(error);
      for (const secret of secrets) {
        expect(error.message).not.toContain(secret);
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it("bounds recursive values and error paths", () => {
    const type = `BIGINT${"[]".repeat(33)}`;
    const error = expectFailure(
      () => decodeDuckDbLosslessValue(type, nestedSingleton(33, 1n), "x".repeat(1_000)),
      "GEOPARQUET_LOSSLESS_DEPTH_LIMIT",
    );
    expect(error.path.length).toBeLessThanOrEqual(512);
    expect(error.declaredType.length).toBeLessThanOrEqual(160);
  });

  it("rejects malformed and unsupported declared types with fixed codes", () => {
    expectFailure(() => compileDuckDbLosslessValueDecoder("DECIMAL(4,5)"), "GEOPARQUET_LOSSLESS_INVALID_TYPE");
    expectFailure(() => decodeDuckDbLosslessValue("INTERVAL", "P1D"), "GEOPARQUET_LOSSLESS_UNSUPPORTED_TYPE");
    expectFailure(() => decodeDuckDbLosslessValue("INTERVAL", null), "GEOPARQUET_LOSSLESS_UNSUPPORTED_TYPE");
  });

  it("does not retain or report rejected scalar values", () => {
    const rejected = "credential-value-that-must-not-escape";
    const error = expectFailure(
      () => decodeDuckDbLosslessValue("BIGINT", rejected, "identifier"),
      "GEOPARQUET_LOSSLESS_INVALID_VALUE",
    );
    expect(error.message).not.toContain(rejected);
    expect(JSON.stringify(error)).not.toContain(rejected);
  });
});

describe("DuckDB aggregate output type derivation", () => {
  const fields = [
    { name: "category", type: "VARCHAR", nullable: false },
    { name: "small", type: "INTEGER" },
    { name: "large", type: "BIGINT" },
    { name: "unsigned", type: "UBIGINT" },
    { name: "amount", type: "DECIMAL(20,5)" },
    { name: "observed_at", type: "TIMESTAMP_NS" },
    { name: "ratio", type: "REAL" },
  ] as const;

  it("derives group, count, widened sum, min/max, and statistical output types", () => {
    const aggregation: AggregationSpec = {
      groupBy: ["category"],
      metrics: [
        { fn: "count", field: "*" },
        { fn: "sum", field: "small" },
        { fn: "sum", field: "large", alias: "large_total" },
        { fn: "sum", field: "unsigned" },
        { fn: "sum", field: "amount" },
        { fn: "min", field: "observed_at" },
        { fn: "max", field: "large" },
        { fn: "avg", field: "amount" },
        { fn: "stddev", field: "small" },
        { fn: "var", field: "ratio" },
      ],
    };

    expect(deriveDuckDbAggregateOutputFields(aggregation, fields)).toEqual([
      { name: "category", type: "VARCHAR", nullable: false, source: "group" },
      { name: "count_all", type: "BIGINT", source: "metric" },
      { name: "sum_small", type: "HUGEINT", source: "metric" },
      { name: "large_total", type: "HUGEINT", source: "metric" },
      { name: "sum_unsigned", type: "HUGEINT", source: "metric" },
      { name: "sum_amount", type: "DECIMAL(38,5)", source: "metric" },
      { name: "min_observed_at", type: "TIMESTAMP_NS", source: "metric" },
      { name: "max_large", type: "BIGINT", source: "metric" },
      { name: "avg_amount", type: "DOUBLE", source: "metric" },
      { name: "stddev_small", type: "DOUBLE", source: "metric" },
      { name: "var_ratio", type: "DOUBLE", source: "metric" },
    ]);
  });

  const invalidAggregates: readonly AggregationSpec[] = [
    { metrics: [] },
    { groupBy: ["missing"], metrics: [{ fn: "count", field: "*" }] },
    { metrics: [{ fn: "sum", field: "missing" }] },
    { metrics: [{ fn: "sum", field: "*" }] },
    {
      groupBy: ["category"],
      metrics: [{ fn: "count", field: "*", alias: "category" }],
    },
    { metrics: [{ fn: "sum", field: "category" }] },
  ];

  for (const [index, aggregation] of invalidAggregates.entries()) {
    it(`rejects invalid aggregate projection ${index + 1}`, () => {
      expectFailure(() => deriveDuckDbAggregateOutputFields(aggregation, fields), "GEOPARQUET_LOSSLESS_AGGREGATE_TYPE");
    });
  }
});
