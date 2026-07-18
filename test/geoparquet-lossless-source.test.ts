import { describe, expect, it } from "vitest";

import type { SourceDescriptor } from "../src/contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { HonuaAbortError } from "../src/core/errors.js";
import type { DuckDbDriver, DuckRow } from "../src/geoparquet/driver.js";
import {
  DuckDbLosslessDecodeError,
  GeoparquetRuntime,
  geoparquetResolver,
  geoparquetSource,
} from "../src/geoparquet/index.js";
import type { SourceProfileField } from "../src/geoparquet/metadata.js";

const URL = "lossless.parquet";

const LOSSLESS_DESCRIBE = [
  { column_name: "group_key", column_type: "BIGINT", null: "NO" },
  { column_name: "int_value", column_type: "INTEGER", null: "NO" },
  { column_name: "big_value", column_type: "BIGINT", null: "NO" },
  { column_name: "unsigned_value", column_type: "UBIGINT", null: "NO" },
  { column_name: "amount", column_type: "DECIMAL(20,5)", null: "NO" },
  { column_name: "event_date", column_type: "DATE", null: "NO" },
  { column_name: "event_time", column_type: "TIME", null: "NO" },
  { column_name: "event_ts", column_type: "TIMESTAMP_NS", null: "NO" },
  { column_name: "payload", column_type: "BLOB", null: "NO" },
  { column_name: "nested", column_type: "STRUCT(ids BIGINT[], amount DECIMAL(20,5))", null: "NO" },
] as const;

const LOSSLESS_FEATURE_ROW = {
  group_key: "9007199254740993",
  int_value: 7,
  big_value: "9223372036854775807",
  unsigned_value: "18446744073709551615",
  amount: "123456789012345.67890",
  event_date: "2026-07-15",
  event_time: "12:34:56.123456",
  event_ts: "2026-07-15 12:34:56.123456789",
  payload: new Uint8Array([0, 255, 128]),
  nested: { ids: [9007199254740993n, 9223372036854775807n], amount: "0.00001" },
} satisfies DuckRow;

const LOSSLESS_EFFECTIVE_SCHEMA: readonly SourceProfileField[] = LOSSLESS_DESCRIBE.map((field) => ({
  name: field.column_name,
  type: field.column_type,
  nullable: (field.null as string) === "YES",
}));

function descriptor(): SourceDescriptor {
  return {
    id: "lossless",
    protocol: "geoparquet",
    locator: { url: URL },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
  };
}

interface HarnessOptions {
  readonly describe?: readonly DuckRow[];
  readonly query: (sql: string) => readonly DuckRow[];
  readonly stream?: (sql: string) => AsyncIterable<readonly DuckRow[]>;
}

function harness(options: HarnessOptions): {
  readonly runtime: GeoparquetRuntime;
  readonly scans: string[];
} {
  const scans: string[] = [];
  const driver: DuckDbDriver = {
    async run() {},
    async query(sql) {
      if (sql.startsWith("DESCRIBE")) return [...(options.describe ?? LOSSLESS_DESCRIBE)];
      if (sql.includes("parquet_kv_metadata")) return [];
      if (sql.includes("parquet_file_metadata")) return [{ row_estimate: 1n }];
      scans.push(sql);
      return [...options.query(sql)];
    },
    ...(options.stream
      ? {
          async *streamQuery(sql: string) {
            scans.push(sql);
            for await (const rows of options.stream!(sql)) yield [...rows];
          },
        }
      : {}),
    async registerFileBuffer() {},
    async close() {},
  };
  return { runtime: new GeoparquetRuntime({ driverFactory: async () => driver }), scans };
}

function readCount(sql: string): number {
  return sql.match(/read_parquet\(/g)?.length ?? 0;
}

describe("GeoParquet lossless-json source wiring", () => {
  it("normalizes feature, queryAll, and stream rows without a second scan", async () => {
    const h = harness({
      query: () => [LOSSLESS_FEATURE_ROW],
      async *stream() {
        yield [LOSSLESS_FEATURE_ROW];
      },
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });

    const queried = await source.query({ returnGeometry: false });
    const all = await source.queryAll({ returnGeometry: false });
    const streamed = [];
    for await (const page of source.stream({ returnGeometry: false })) streamed.push(page);

    for (const result of [queried, all, streamed[0]!]) {
      expect(result.features[0]?.attributes).toEqual({
        group_key: "9007199254740993",
        int_value: 7,
        big_value: "9223372036854775807",
        unsigned_value: "18446744073709551615",
        amount: "123456789012345.67890",
        event_date: "2026-07-15",
        event_time: "12:34:56.123456",
        event_ts: "2026-07-15T12:34:56.123456789",
        payload: "AP+A",
        nested: { ids: ["9007199254740993", "9223372036854775807"], amount: "0.00001" },
      });
      expect(() => JSON.stringify(result)).not.toThrow();
    }
    expect(all.totalCount).toBe(1);
    expect(h.scans).toHaveLength(3);
    for (const sql of h.scans) {
      expect(sql).toContain("FROM (SELECT");
      expect(readCount(sql)).toBe(1);
    }
    await h.runtime.dispose();
  });

  it("uses widened aggregate output types and retains an exact grouped key", async () => {
    const h = harness({
      query: (sql) => {
        expect(sql).toContain('CAST("n" AS VARCHAR)');
        expect(sql).toContain('CAST("int_sum" AS VARCHAR)');
        expect(sql).toContain('CAST("amount_sum" AS VARCHAR)');
        return [
          {
            group_key: "9007199254740993",
            n: "2",
            int_sum: "4294967294",
            big_sum: "18446744073709551614",
            unsigned_sum: "36893488147419103230",
            amount_sum: "246913578024691.35780",
          },
        ];
      },
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const result = await source.queryAggregate({
      aggregation: {
        groupBy: ["group_key"],
        metrics: [
          { fn: "count", field: "*", alias: "n" },
          { fn: "sum", field: "int_value", alias: "int_sum" },
          { fn: "sum", field: "big_value", alias: "big_sum" },
          { fn: "sum", field: "unsigned_value", alias: "unsigned_sum" },
          { fn: "sum", field: "amount", alias: "amount_sum" },
        ],
      },
    });

    expect(result.aggregateRows).toEqual([
      {
        group_key: "9007199254740993",
        n: "2",
        int_sum: "4294967294",
        big_sum: "18446744073709551614",
        unsigned_sum: "36893488147419103230",
        amount_sum: "246913578024691.35780",
      },
    ]);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(h.scans).toHaveLength(1);
    expect(readCount(h.scans[0]!)).toBe(1);
    await h.runtime.dispose();
  });

  it("preserves default result bytes and resolver defaults", async () => {
    const h = harness({
      describe: [{ column_name: "id", column_type: "BIGINT", null: "NO" }],
      query: () => [{ id: 9007199254740993n }],
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime });
    expect(JSON.stringify(await source.query({ returnGeometry: false }))).toBe(
      '{"features":[{"attributes":{"id":9007199254740992}}],"exceededTransferLimit":false}',
    );
    expect(h.scans[0]).not.toContain('AS "__honua_lossless"');

    const resolver = geoparquetResolver({ runtime: h.runtime });
    const resolved = resolver(descriptor(), {} as never)!;
    expect(JSON.stringify(await resolved.query({ returnGeometry: false }))).toContain('"id":9007199254740992');
    await resolver.dispose();
  });

  it("rejects every non-canonical result encoding through direct and resolver construction", async () => {
    for (const resultEncoding of [null, "", "LOSSLESS", 1]) {
      expect(() => geoparquetSource(descriptor(), { resultEncoding: resultEncoding as never })).toThrowError(
        /resultEncoding must be "legacy" or "lossless-json"/,
      );
      const resolver = geoparquetResolver({ resultEncoding: resultEncoding as never });
      expect(() => resolver(descriptor(), {} as never)).toThrowError(
        /resultEncoding must be "legacy" or "lossless-json"/,
      );
      await resolver.dispose();
    }
  });

  it("fails closed before executing an opaque planned query whose effective schema is unavailable", async () => {
    const h = harness({ query: () => [LOSSLESS_FEATURE_ROW] });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const handle = source.protocol("geoparquet")!;
    await expect(
      handle.executeResolvedQuery({
        sources: ["resolved-lossless.parquet"],
        operation: "query",
        query: { returnGeometry: false },
        sourceId: "resolved-lossless",
      }),
    ).rejects.toMatchObject({
      code: "GEOPARQUET_LOSSLESS_SCHEMA_REQUIRED",
      path: "$.resolvedQuery",
      declaredType: "EFFECTIVE_SCHEMA",
    });
    expect(h.scans).toEqual([]);
    await h.runtime.dispose();
  });

  it("decodes an opaque planned feature query losslessly from a bound effective schema (#627)", async () => {
    const h = harness({ query: () => [LOSSLESS_FEATURE_ROW] });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const handle = source.protocol("geoparquet")!;
    const result = await handle.executeResolvedQuery({
      sources: ["resolved-lossless.parquet"],
      operation: "query",
      query: { returnGeometry: false },
      sourceId: "resolved-lossless",
      effectiveSchema: LOSSLESS_EFFECTIVE_SCHEMA,
    });
    expect(result.features[0]?.attributes).toEqual({
      group_key: "9007199254740993",
      int_value: 7,
      big_value: "9223372036854775807",
      unsigned_value: "18446744073709551615",
      amount: "123456789012345.67890",
      event_date: "2026-07-15",
      event_time: "12:34:56.123456",
      event_ts: "2026-07-15T12:34:56.123456789",
      payload: "AP+A",
      nested: { ids: ["9007199254740993", "9223372036854775807"], amount: "0.00001" },
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(h.scans).toHaveLength(1);
    expect(h.scans[0]).toContain("FROM (SELECT");
    expect(readCount(h.scans[0]!)).toBe(1);
    await h.runtime.dispose();
  });

  it("decodes an opaque planned aggregate query with widened output types from a bound effective schema (#627)", async () => {
    const h = harness({
      query: (sql) => {
        expect(sql).toContain('CAST("n" AS VARCHAR)');
        expect(sql).toContain('CAST("int_sum" AS VARCHAR)');
        return [{ group_key: "9007199254740993", n: "2", int_sum: "4294967294" }];
      },
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const handle = source.protocol("geoparquet")!;
    const result = await handle.executeResolvedQuery({
      sources: ["resolved-lossless.parquet"],
      operation: "queryAggregate",
      query: {
        aggregation: {
          groupBy: ["group_key"],
          metrics: [
            { fn: "count", field: "*", alias: "n" },
            { fn: "sum", field: "int_value", alias: "int_sum" },
          ],
        },
      },
      sourceId: "resolved-lossless",
      effectiveSchema: LOSSLESS_EFFECTIVE_SCHEMA,
    });
    expect(result.aggregateRows).toEqual([{ group_key: "9007199254740993", n: "2", int_sum: "4294967294" }]);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(h.scans).toHaveLength(1);
    expect(readCount(h.scans[0]!)).toBe(1);
    await h.runtime.dispose();
  });

  it("fails closed before executing when the bound effective schema is malformed (#627)", async () => {
    const h = harness({ query: () => [LOSSLESS_FEATURE_ROW] });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const handle = source.protocol("geoparquet")!;
    const malformedCases: readonly unknown[] = [
      [],
      [{ name: "value" }],
      [
        { name: "value", type: "INTEGER" },
        { name: "value", type: "BIGINT" },
      ],
      [{ name: "value", type: "INTEGER", nullable: "maybe" }],
      "not-an-array",
    ];
    for (const effectiveSchema of malformedCases) {
      await expect(
        handle.executeResolvedQuery({
          sources: ["resolved-lossless.parquet"],
          operation: "query",
          query: { returnGeometry: false },
          sourceId: "resolved-lossless",
          effectiveSchema: effectiveSchema as never,
        }),
      ).rejects.toMatchObject({
        code: "GEOPARQUET_LOSSLESS_SCHEMA_REQUIRED",
        path: "$.resolvedQuery",
        declaredType: "EFFECTIVE_SCHEMA",
      });
    }
    expect(h.scans).toEqual([]);
    await h.runtime.dispose();
  });

  it("fails closed without invoking caller-supplied schema accessors (#627)", async () => {
    const h = harness({ query: () => [LOSSLESS_FEATURE_ROW] });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const handle = source.protocol("geoparquet")!;
    let getterInvocations = 0;
    const hostileField = Object.defineProperty({ type: "INTEGER" }, "name", {
      enumerable: true,
      get() {
        getterInvocations += 1;
        throw new Error("accessor side effect escaped the fail-closed boundary");
      },
    });
    await expect(
      handle.executeResolvedQuery({
        sources: ["resolved-lossless.parquet"],
        operation: "query",
        query: { returnGeometry: false },
        sourceId: "resolved-lossless",
        effectiveSchema: [hostileField] as never,
      }),
    ).rejects.toMatchObject({
      code: "GEOPARQUET_LOSSLESS_SCHEMA_REQUIRED",
      path: "$.resolvedQuery",
      declaredType: "EFFECTIVE_SCHEMA",
    });
    expect(getterInvocations).toBe(0);
    expect(h.scans).toEqual([]);
    await h.runtime.dispose();
  });

  it("preserves the profiled outFields error taxonomy for a bound effective schema that omits a requested field (#627)", async () => {
    const h = harness({ query: () => [LOSSLESS_FEATURE_ROW] });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const handle = source.protocol("geoparquet")!;
    const error = await handle
      .executeResolvedQuery({
        sources: ["resolved-lossless.parquet"],
        operation: "query",
        query: { returnGeometry: false, outFields: ["not_a_real_column"] },
        sourceId: "resolved-lossless",
        effectiveSchema: LOSSLESS_EFFECTIVE_SCHEMA,
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DuckDbLosslessDecodeError);
    expect(error).toMatchObject({ code: "GEOPARQUET_LOSSLESS_INVALID_TYPE", path: "$.outFields[0]" });
    expect(h.scans).toEqual([]);
    await h.runtime.dispose();
  });

  it("invalidates compiled decoders when the effective profile changes", async () => {
    let row: DuckRow = { value: 7 };
    const h = harness({
      describe: [{ column_name: "value", column_type: "INTEGER", null: "NO" }],
      query: () => [row],
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    expect((await source.query({ returnGeometry: false })).features[0]?.attributes).toEqual({ value: 7 });

    const profile = await h.runtime.profile([URL]);
    (profile as { fields?: readonly SourceProfileField[] }).fields = [
      { name: "value", type: "VARCHAR", nullable: false },
    ];
    row = { value: "seven" };
    expect((await source.query({ returnGeometry: false })).features[0]?.attributes).toEqual({ value: "seven" });
    await h.runtime.dispose();
  });

  it("fails hostile row traps with a fixed, path-safe error", async () => {
    const hostile = new Proxy(Object.create(null) as DuckRow, {
      ownKeys() {
        throw new Error("secret should not escape");
      },
    });
    const h = harness({
      describe: [{ column_name: "value", column_type: "VARCHAR", null: "NO" }],
      query: () => [hostile],
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const error = await source.query({ returnGeometry: false }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DuckDbLosslessDecodeError);
    expect(error).toMatchObject({ code: "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path: "$" });
    expect(String(error)).not.toContain("secret should not escape");
    await h.runtime.dispose();
  });

  it("honors cancellation after query completion before touching row values", async () => {
    const abort = new AbortController();
    let accessed = false;
    const row = Object.create(null) as DuckRow;
    Object.defineProperty(row, "value", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("must not run");
      },
    });
    const h = harness({
      describe: [{ column_name: "value", column_type: "VARCHAR", null: "NO" }],
      query: () => {
        abort.abort();
        return [row];
      },
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    await expect(source.query({ returnGeometry: false, signal: abort.signal })).rejects.toBeInstanceOf(HonuaAbortError);
    expect(accessed).toBe(false);
    await h.runtime.dispose();
  });

  it("redacts a driver failure when cancellation wins the query boundary", async () => {
    const abort = new AbortController();
    const h = harness({
      describe: [{ column_name: "value", column_type: "VARCHAR", null: "NO" }],
      query: () => {
        abort.abort();
        throw new Error("cancelled-driver-secret");
      },
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const error = await source.query({ returnGeometry: false, signal: abort.signal }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HonuaAbortError);
    expect(String(error)).not.toContain("cancelled-driver-secret");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    await h.runtime.dispose();
  });

  it("stops waiting on a shared profile when the caller aborts", async () => {
    let releaseDescribe!: (rows: readonly DuckRow[]) => void;
    const describeRows = new Promise<readonly DuckRow[]>((resolve) => {
      releaseDescribe = resolve;
    });
    const scans: string[] = [];
    const driver: DuckDbDriver = {
      async run() {},
      async query(sql) {
        if (sql.startsWith("DESCRIBE")) return [...(await describeRows)];
        if (sql.includes("parquet_kv_metadata")) return [];
        if (sql.includes("parquet_file_metadata")) return [{ row_estimate: 1n }];
        scans.push(sql);
        return [{ value: "unreachable" }];
      },
      async registerFileBuffer() {},
      async close() {},
    };
    const runtime = new GeoparquetRuntime({ driverFactory: async () => driver });
    const source = geoparquetSource(descriptor(), { runtime, resultEncoding: "lossless-json" });
    const abort = new AbortController();
    const pending = source.query({ returnGeometry: false, signal: abort.signal });
    abort.abort();

    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(scans).toEqual([]);

    releaseDescribe([{ column_name: "value", column_type: "VARCHAR", null: "NO" }]);
    await runtime.profile([URL]);
    await runtime.dispose();
  });

  it("stops a stream between batches without decoding the next batch", async () => {
    const abort = new AbortController();
    let accessed = false;
    const hostile = Object.create(null) as DuckRow;
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("must not run");
      },
    });
    const h = harness({
      describe: [{ column_name: "value", column_type: "VARCHAR", null: "NO" }],
      query: () => [],
      async *stream() {
        yield [{ value: "first" }];
        abort.abort();
        yield [hostile];
      },
    });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    const iterator = source.stream({ returnGeometry: false, signal: abort.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.features[0]?.attributes).toEqual({ value: "first" });
    await expect(iterator.next()).rejects.toBeInstanceOf(HonuaAbortError);
    expect(accessed).toBe(false);
    await h.runtime.dispose();
  });

  it("fails unknown opt-in projections before scanning", async () => {
    const h = harness({ query: () => [LOSSLESS_FEATURE_ROW] });
    const source = geoparquetSource(descriptor(), { runtime: h.runtime, resultEncoding: "lossless-json" });
    await expect(source.query({ outFields: ["missing"], returnGeometry: false })).rejects.toMatchObject({
      code: "GEOPARQUET_LOSSLESS_INVALID_TYPE",
      path: "$.outFields[0]",
      declaredType: "ROW",
    });
    expect(h.scans).toEqual([]);
    await h.runtime.dispose();
  });
});
