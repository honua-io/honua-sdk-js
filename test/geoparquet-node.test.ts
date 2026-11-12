import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { DuckDBConnection, DuckDBInstance, DuckDBResult } from "@duckdb/node-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { envelope } from "../src/core/spatial-filter.js";
import type { DuckDbDriver } from "../src/geoparquet/driver.js";
import { GeoparquetRuntime, geoparquetSource } from "../src/geoparquet/index.js";
import { createNodeDuckDbDriver } from "../src/geoparquet/node.js";

const fixture = fileURLToPath(new URL("./fixtures/geoparquet/places-geoparquet.parquet", import.meta.url));
const drivers: DuckDbDriver[] = [];
async function driver() {
  const instance = await createNodeDuckDbDriver({ loadSpatial: false });
  drivers.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((instance) => instance.close()));
});

describe("native Node GeoParquet driver", () => {
  it("reads local files through the shared Source planner and decoder", async () => {
    const instance = await driver();
    const runtime = new GeoparquetRuntime({ driverFactory: async () => instance });
    const source = geoparquetSource(
      {
        id: "places",
        protocol: "geoparquet",
        locator: { url: fixture },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
      },
      { runtime },
    );
    const result = await source.query({ returnGeometry: false, outFields: ["id", "name"], pagination: { limit: 3 } });
    expect(result.features).toHaveLength(3);
    expect(result.features[0]?.attributes).toHaveProperty("name");
    expect(result.exceededTransferLimit).toBe(true);
    await runtime.dispose();
  });

  it.each(["local", "http"])(
    "queries %s GeoParquet geometry through the default spatial driver",
    async (transport) => {
      const bytes = await readFile(fixture);
      const server = createServer((request, response) => {
        response.setHeader("Content-Type", "application/vnd.apache.parquet");
        response.setHeader("Accept-Ranges", "bytes");
        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (range) {
          response.statusCode = 206;
          response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
        }
        response.setHeader("Content-Length", end - start + 1);
        response.end(request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const url = transport === "local" ? fixture : `http://127.0.0.1:${address.port}/places.parquet`;
      const runtime = new GeoparquetRuntime({ driverFactory: createNodeDuckDbDriver });
      try {
        const source = geoparquetSource(
          {
            id: "places",
            protocol: "geoparquet",
            locator: { url },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
          },
          { runtime },
        );
        const result = await source.query({});
        expect(result.features).toHaveLength(8);
        expect(
          result.features.every(
            (feature) => feature.geometry && "type" in feature.geometry && feature.geometry.type === "Point",
          ),
        ).toBe(true);
        const filtered = await source.query({
          spatialFilter: envelope(-157.86, 21.25, -157.8, 21.3),
        });
        expect(filtered.features.length).toBeGreaterThan(0);
        expect(filtered.features.length).toBeLessThan(8);
      } finally {
        await runtime.dispose();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    },
    60000,
  );

  it("rejects byte registration explicitly, binds parameters and preserves native values", async () => {
    const instance = await driver();
    await expect(instance.registerFileBuffer("places.parquet", await readFile(fixture))).rejects.toThrow(
      "absolute path",
    );
    expect(await instance.query("SELECT count(*) AS n FROM read_parquet(?)", { parameters: [fixture] })).toEqual([
      { n: 8n },
    ]);
    expect(await instance.query("SELECT ? AS value", { parameters: ["O'ahu"] })).toEqual([{ value: "O'ahu" }]);
    await expect(instance.registerFileBuffer("../escape.parquet", new Uint8Array())).rejects.toThrow("unsupported");
  });

  it("streams parameterized batches and releases the connection on early exit", async () => {
    const instance = await driver();
    let count = 0;
    for await (const rows of instance.streamQuery!("SELECT * FROM range(?)", { parameters: [10000] })) {
      count += rows.length;
      break;
    }
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10000);
    expect(await instance.query("SELECT 42 AS n")).toEqual([{ n: 42 }]);
  });

  it("interrupts a running query without poisoning subsequent queries", async () => {
    const instance = await driver();
    const controller = new AbortController();
    const query = instance.query("SELECT sum(a.i * b.i) FROM range(1000000) a(i), range(1000000) b(i)", {
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      await expect(query).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
    expect(await instance.query("SELECT 1 AS n")).toEqual([{ n: 1 }]);
  });

  it("closes while a streaming consumer is paused", async () => {
    const instance = await driver();
    const stream = instance.streamQuery!("SELECT * FROM range(10000)")[Symbol.asyncIterator]();
    expect((await stream.next()).done).toBe(false);
    await instance.close();
    await expect(stream.next()).rejects.toThrow("closed");
  });

  it("aborts a paused stream and immediately releases its connection", async () => {
    const instance = await driver();
    const controller = new AbortController();
    const stream = instance.streamQuery!("SELECT * FROM range(10000)", { signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    await stream.next();
    controller.abort();
    expect(await instance.query("SELECT 7 AS n")).toEqual([{ n: 7 }]);
    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a queued query promptly while preserving the active stream and queue order", async () => {
    const instance = await driver();
    const stream = instance.streamQuery!("SELECT * FROM range(10000)")[Symbol.asyncIterator]();
    await stream.next();
    const controller = new AbortController();
    const cancelled = instance.query("SELECT 2 AS n", { signal: controller.signal });
    let laterFinished = false;
    const later = instance.query("SELECT 3 AS n").then((rows) => {
      laterFinished = true;
      return rows;
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(laterFinished).toBe(false);
    expect((await stream.next()).done).toBe(false);
    await stream.return?.();
    expect(await later).toEqual([{ n: 3 }]);
  });

  it("releases the connection and abort listener when native result cleanup throws", async () => {
    const instance = await driver();
    const controller = new AbortController();
    const close = DuckDBResult.prototype.closeSync;
    const cleanup = vi.spyOn(DuckDBResult.prototype, "closeSync").mockImplementationOnce(function (this: DuckDBResult) {
      close.call(this);
      throw new Error("result cleanup failure");
    });
    const interrupt = vi.spyOn(DuckDBConnection.prototype, "interrupt");
    try {
      await expect(instance.query("SELECT 1", { signal: controller.signal })).rejects.toThrow("result cleanup failure");
      controller.abort();
      expect(interrupt).not.toHaveBeenCalled();
      expect(await instance.query("SELECT 2 AS n")).toEqual([{ n: 2 }]);
    } finally {
      cleanup.mockRestore();
      interrupt.mockRestore();
    }
  });

  it.each(["return", "abort"])(
    "preserves the %s outcome when stream cleanup fails and releases the queue",
    async (exit) => {
      const instance = await driver();
      const controller = new AbortController();
      const stream = instance.streamQuery!("SELECT * FROM range(10000)", { signal: controller.signal })[
        Symbol.asyncIterator
      ]();
      await stream.next();
      const close = DuckDBResult.prototype.closeSync;
      const cleanup = vi.spyOn(DuckDBResult.prototype, "closeSync").mockImplementationOnce(function (
        this: DuckDBResult,
      ) {
        close.call(this);
        throw new Error("stream cleanup failure");
      });
      try {
        if (exit === "return") {
          await expect(stream.return?.()).rejects.toThrow("stream cleanup failure");
        } else {
          controller.abort();
          await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
        }
        expect(await instance.query("SELECT 2 AS n")).toEqual([{ n: 2 }]);
      } finally {
        cleanup.mockRestore();
      }
    },
  );

  it("still closes the database when native connection cleanup throws", async () => {
    const instance = await createNodeDuckDbDriver({ loadSpatial: false });
    const close = DuckDBConnection.prototype.closeSync;
    const connection = vi.spyOn(DuckDBConnection.prototype, "closeSync").mockImplementationOnce(function (
      this: DuckDBConnection,
    ) {
      close.call(this);
      throw new Error("connection cleanup failure");
    });
    const database = vi.spyOn(DuckDBInstance.prototype, "closeSync");
    try {
      await expect(instance.close()).rejects.toThrow("native DuckDB cleanup failed");
      expect(database).toHaveBeenCalledOnce();
    } finally {
      connection.mockRestore();
      database.mockRestore();
    }
  });

  it("rejects pre-aborted initialization and closes idempotently", async () => {
    await expect(createNodeDuckDbDriver({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    const instance = await driver();
    const closing = instance.close();
    expect(instance.close()).toBe(closing);
    await closing;
    await expect(instance.query("SELECT 1")).rejects.toThrow("closed");
  });
});
