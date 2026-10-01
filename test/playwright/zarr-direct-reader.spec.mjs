import { deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function json(value) {
  return Buffer.from(JSON.stringify(value));
}

function floats(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

function gridChunk(row0, col0) {
  const values = [];
  for (let row = row0; row < row0 + 2; row += 1) {
    for (let column = col0; column < col0 + 2; column += 1) values.push(row * 10 + column);
  }
  return deflateSync(floats(values));
}

function buildStore() {
  const objects = new Map();
  const group = {
    variables: ["temperature", "cube"],
    primary_variable: "temperature",
    crs_wkid: 4326,
    extent: [-2, -2, 2, 2],
    x_dimension: "x",
    y_dimension: "y",
    t_dimension: "time",
  };
  objects.set("/grid/.zgroup", json({ zarr_format: 2 }));
  objects.set("/grid/.zattrs", json(group));
  objects.set(
    "/grid/temperature/.zarray",
    json({
      zarr_format: 2,
      shape: [4, 4],
      chunks: [2, 2],
      dtype: "<f4",
      order: "C",
      fill_value: "NaN",
      filters: null,
      compressor: { id: "zlib", level: 1 },
      dimension_separator: ".",
    }),
  );
  objects.set("/grid/temperature/.zattrs", json({ _ARRAY_DIMENSIONS: ["y", "x"] }));
  objects.set("/grid/temperature/0.0", gridChunk(0, 0));
  objects.set("/grid/temperature/0.1", gridChunk(0, 2));
  objects.set("/grid/temperature/1.0", gridChunk(2, 0));
  objects.set(
    "/grid/cube/.zarray",
    json({
      zarr_format: 2,
      shape: [2, 2, 2, 2],
      chunks: [1, 1, 2, 2],
      dtype: "<f4",
      order: "C",
      fill_value: 0,
      filters: null,
      compressor: null,
    }),
  );
  objects.set("/grid/cube/.zattrs", json({ _ARRAY_DIMENSIONS: ["time", "band", "y", "x"] }));
  for (let time = 0; time < 2; time += 1) {
    for (let band = 0; band < 2; band += 1) {
      const sample = time * 100 + band;
      objects.set(`/grid/cube/${time}.${band}.0.0`, floats([sample, sample, sample, sample]));
    }
  }
  return objects;
}

function contentType(key) {
  if (key.endsWith(".js")) return "text/javascript";
  if (key.startsWith("/grid/") && (key.endsWith("json") || key.includes("/."))) return "application/json";
  return "application/octet-stream";
}

test("reads reviewed Zarr chunks from static HTTP without a server facade", async ({ page }) => {
  const objects = buildStore();
  const requests = [];
  let delayChunks = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>zarr</title>");
      return;
    }
    if (url.pathname === "/control/delay") {
      delayChunks = true;
      response.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith("/dist/")) {
      const file = path.resolve(repoRoot, url.pathname.slice(1));
      if (!file.startsWith(repoRoot)) {
        response.writeHead(400).end();
        return;
      }
      try {
        const bytes = await readFile(file);
        response.writeHead(200, {
          "content-type": contentType(url.pathname),
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
        });
        response.end(bytes);
      } catch {
        response.writeHead(404).end();
      }
      return;
    }
    const bytes = objects.get(url.pathname);
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    if (delayChunks && /\/temperature\/\d+\.\d+$/u.test(url.pathname)) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        request.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (response.writableEnded || request.destroyed) return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("static Zarr server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    await page.goto(origin + "/");
    const report = await page.evaluate(async (store) => {
      const { openDirectZarrStore, ZARR_DIRECT_CAPABILITY } = await import("/dist/src/zarr/index.js");
      const session = openDirectZarrStore({ url: store });
      const inspection = await session.inspect();
      const one = await session.readWindow({ pixel: { x: 0, y: 0, width: 2, height: 2 } });
      const banded = await session.readWindow({
        variable: "cube",
        bands: [2],
        time: { index: 1 },
        pixel: { x: 0, y: 0, width: 2, height: 2 },
      });
      const missing = await session.readWindow({ pixel: { x: 2, y: 2, width: 2, height: 2 } });
      const early = new AbortController();
      early.abort();
      let cancelled = false;
      try {
        await session.readWindow({ pixel: { x: 0, y: 0, width: 4, height: 4 } }, { signal: early.signal });
      } catch (error) {
        cancelled = error?.name === "HonuaAbortError";
      }
      const limited = openDirectZarrStore({ url: store, limits: { maxChunks: 1 } });
      let budget = null;
      try {
        await limited.readWindow({ pixel: { x: 0, y: 0, width: 4, height: 4 } });
      } catch (error) {
        budget = { name: error?.name ?? "", code: error?.code ?? "", refusal: error?.detail?.refusal ?? "" };
      }
      return {
        codecs: ZARR_DIRECT_CAPABILITY.codecs,
        refusedCodecs: ZARR_DIRECT_CAPABILITY.refusedCodecs,
        refusedLayouts: ZARR_DIRECT_CAPABILITY.refusedLayouts,
        axes: inspection.dimensions.map((dimension) => [dimension.name, dimension.role]),
        chunk: one.provenance.chunks,
        values: Array.from(one.bands[0].values),
        bandChunk: banded.provenance.chunks,
        bandValue: banded.bands[0].values[0],
        nodata: Array.from(missing.bands[0].values).every((value) => Number.isNaN(value)),
        cancelled,
        budget,
      };
    }, `${origin}/grid`);

    expect(report.codecs).toEqual(["uncompressed", "zlib", "gzip", "bytes-little-endian"]);
    expect(report.refusedCodecs).toContain("blosc");
    expect(report.refusedLayouts).toContain("fortran-order");
    expect(report.axes).toEqual([
      ["y", "y"],
      ["x", "x"],
    ]);
    expect(report.chunk).toEqual(["temperature/0.0"]);
    expect(report.values).toEqual([0, 1, 10, 11]);
    expect(report.bandChunk).toEqual(["cube/1.1.0.0"]);
    expect(report.bandValue).toBe(101);
    expect(report.nodata).toBe(true);
    expect(report.cancelled).toBe(true);
    expect(report.budget).toMatchObject({ code: "response-too-large", refusal: "budget" });
    expect(requests.some((pathname) => pathname === "/grid" || pathname === "/grid/")).toBe(false);

    const beforeDelay = requests.length;
    await page.evaluate(async (store) => {
      await fetch("/control/delay");
      const { openDirectZarrStore } = await import("/dist/src/zarr/index.js");
      const session = openDirectZarrStore({ url: store });
      const controller = new AbortController();
      const pending = session.readWindow({ pixel: { x: 0, y: 0, width: 4, height: 2 } }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 400);
      try {
        await pending;
        window.__zarrDelay = "completed";
      } catch (error) {
        window.__zarrDelay = error?.name ?? "error";
      }
    }, `${origin}/grid`);
    expect(await page.evaluate(() => window.__zarrDelay)).toBe("HonuaAbortError");
    const during = requests.slice(beforeDelay);
    expect(during.some((pathname) => pathname === "/grid/temperature/0.0")).toBe(true);
    expect(during.filter((pathname) => pathname === "/grid/temperature/0.1")).toEqual([]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
