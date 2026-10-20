import { deflateSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { HonuaAbortError } from "../src/core/errors.js";
import { directZarrSource, openRasterSession } from "../src/raster/index.js";
import {
  HonuaZarrError,
  ZARR_DIRECT_CAPABILITY,
  ZARR_DIRECT_LIMIT_CEILINGS,
  openDirectZarrStore,
} from "../src/zarr/index.js";

const STORE = "https://data.example/temperature.zarr";

interface Call {
  readonly url: string;
  readonly key: string;
  readonly range: string | null;
  readonly credentials: RequestCredentials | undefined;
  readonly authorization: string | null;
}

function floats(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function gridChunk(row0: number, col0: number): Uint8Array {
  const values: number[] = [];
  for (let row = row0; row < row0 + 2; row += 1) {
    for (let column = col0; column < col0 + 2; column += 1) values.push(row * 10 + column);
  }
  return floats(values);
}

function memoryFetch(
  objects: ReadonlyMap<string, Uint8Array>,
  hooks?: {
    readonly onChunk?: (key: string, signal: AbortSignal) => Promise<void>;
    readonly oversized?: ReadonlySet<string>;
    readonly omitLength?: ReadonlySet<string>;
  },
): { readonly fetchFn: typeof fetch; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const prefix = "/temperature.zarr/";
    const key = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : url.pathname;
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.href,
      key,
      range: headers.get("range"),
      credentials: init?.credentials,
      authorization: headers.get("authorization"),
    });
    if (
      hooks?.onChunk &&
      !key.startsWith(".") &&
      !key.endsWith(".json") &&
      !key.endsWith(".zarray") &&
      !key.endsWith(".zattrs") &&
      !key.endsWith(".zgroup") &&
      !key.endsWith(".zmetadata")
    ) {
      await hooks.onChunk(key, init?.signal ?? new AbortController().signal);
    }
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const bytes = objects.get(key);
    if (!bytes) return new Response(null, { status: 404 });
    if (hooks?.oversized?.has(key)) {
      const pulled = { value: false };
      const stream = new ReadableStream({
        pull(controller) {
          pulled.value = true;
          controller.enqueue(bytes);
          controller.close();
        },
      });
      Object.defineProperty(stream, "pulled", { value: pulled });
      return new Response(stream, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength + 1024), "content-type": "application/octet-stream" },
      });
    }
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const headersOut = new Headers({
      "content-type": key.endsWith("json") || key.startsWith(".") ? "application/json" : "application/octet-stream",
      etag: '"fixture"',
    });
    if (!hooks?.omitLength?.has(key)) headersOut.set("content-length", String(bytes.byteLength));
    return new Response(body, { status: 200, headers: headersOut });
  };
  return { fetchFn, calls };
}

function chunkCalls(calls: readonly Call[]): Call[] {
  return calls.filter((call) => /(?:^|\/)\d+(?:[./]\d+)+$/u.test(call.key) || /\/c(?:\/\d+)+$/u.test(call.key));
}

function v2Store(
  chunks: ReadonlyMap<string, Uint8Array>,
  arrayAttrs?: Record<string, unknown>,
  arrayDoc?: Record<string, unknown>,
): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>(chunks);
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  objects.set(".zgroup", json({ zarr_format: 2 }));
  objects.set(
    ".zattrs",
    json({
      variables: ["temperature"],
      primary_variable: "temperature",
      crs_wkid: 4326,
      extent: [-2, -2, 2, 2],
      x_dimension: "x",
      y_dimension: "y",
      ...(arrayAttrs?.group as object | undefined),
    }),
  );
  objects.set(
    "temperature/.zarray",
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
      ...arrayDoc,
    }),
  );
  objects.set(
    "temperature/.zattrs",
    json({ _ARRAY_DIMENSIONS: ["y", "x"], ...(arrayAttrs?.array as object | undefined) }),
  );
  return objects;
}

function zlibGrid(): Map<string, Uint8Array> {
  const chunks = new Map<string, Uint8Array>([
    ["temperature/0.0", deflateSync(gridChunk(0, 0))],
    ["temperature/0.1", deflateSync(gridChunk(0, 2))],
    ["temperature/1.0", deflateSync(gridChunk(2, 0))],
    ["temperature/1.1", deflateSync(gridChunk(2, 2))],
  ]);
  return v2Store(chunks);
}

describe("direct Zarr chunk reader", () => {
  it("separates reviewed structure from refused codecs and layouts", () => {
    expect(ZARR_DIRECT_CAPABILITY.versions).toEqual([2, 3]);
    expect(ZARR_DIRECT_CAPABILITY.codecs).toEqual(["uncompressed", "zlib", "gzip", "bytes-little-endian"]);
    expect(ZARR_DIRECT_CAPABILITY.refusedCodecs).toEqual(["blosc", "zstd", "sharding_indexed", "crc32c"]);
    expect(ZARR_DIRECT_CAPABILITY.refusedLayouts).toContain("fortran-order");
    expect(ZARR_DIRECT_CAPABILITY.serverExecution).toBe("separately-owned");
    expect(ZARR_DIRECT_LIMIT_CEILINGS.maxMetadataBytes).toBe(64 * 1024);
    expect(ZARR_DIRECT_LIMIT_CEILINGS.maxChunks).toBe(4096);
    expect(ZARR_DIRECT_LIMIT_CEILINGS.maxDecodedBytes).toBe(256 * 1024 * 1024);
    expect(ZARR_DIRECT_LIMIT_CEILINGS.maxRangeBytes).toBe(16 * 1024 * 1024);
  });

  it("selects only the chunks that intersect a pixel window and reports axes", async () => {
    const transport = memoryFetch(zlibGrid());
    const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn });
    const inspection = await session.inspect();
    expect(inspection.dimensions.map((dimension) => [dimension.name, dimension.role, dimension.chunk])).toEqual([
      ["y", "y", 2],
      ["x", "x", 2],
    ]);
    expect(inspection.bands).toEqual([
      expect.objectContaining({ index: 1, variable: "temperature", nodata: Number.NaN, dtype: "<f4" }),
    ]);
    expect(inspection.capability.selected).toMatchObject({
      structural: "supported",
      layout: "supported",
      codec: "supported",
    });
    const window = await session.readWindow({ pixel: { x: 0, y: 0, width: 2, height: 2 } });
    expect(Array.from(window.bands[0]?.values ?? [])).toEqual([0, 1, 10, 11]);
    expect(chunkCalls(transport.calls).map((call) => call.key)).toEqual(["temperature/0.0"]);
    expect(chunkCalls(transport.calls).every((call) => call.range === "bytes=0-8388607")).toBe(true);
    expect(
      transport.calls.filter((call) => call.key.endsWith(".zarray")).every((call) => call.range === "bytes=0-65535"),
    ).toBe(true);
    expect(transport.calls.every((call) => call.credentials === "omit" && call.authorization === null)).toBe(true);
    expect(transport.calls.some((call) => call.key === "" || call.key.endsWith("/"))).toBe(false);
    const full = await session.readWindow({ pixel: { x: 0, y: 0, width: 4, height: 4 } });
    expect(chunkCalls(transport.calls).map((call) => call.key)).toEqual([
      "temperature/0.0",
      "temperature/0.0",
      "temperature/0.1",
      "temperature/1.0",
      "temperature/1.1",
    ]);
    expect(Array.from(full.bands[0]?.values ?? [])).toEqual([
      0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33,
    ]);
    session.dispose();
  });

  it("maps a northeast bbox with north at row 0 and fills missing chunks with nodata", async () => {
    const objects = zlibGrid();
    objects.delete("temperature/1.1");
    const transport = memoryFetch(objects);
    const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn });
    const northeast = await session.readWindow({ bbox: [0, 0, 2, 2] });
    expect(northeast.pixel).toEqual({ x: 2, y: 0, width: 2, height: 2 });
    expect(Array.from(northeast.bands[0]?.values ?? [])).toEqual([2, 3, 12, 13]);
    const full = await session.readWindow({ pixel: { x: 0, y: 0, width: 4, height: 4 } });
    const values = Array.from(full.bands[0]?.values ?? []);
    expect(values[0]).toBe(0);
    expect(Number.isNaN(values[14])).toBe(true);
    expect(Number.isNaN(values[15])).toBe(true);
    expect(full.nodata).toBeNaN();
    const handoff = await session.toMapLibreHandoff(northeast);
    expect(handoff.coordinates).toEqual([
      [0, 2],
      [2, 2],
      [2, 0],
      [0, 0],
    ]);
    expect(handoff.fidelity).toMatchObject({
      source: "zarr-direct",
      samples: "native",
      presentation: "uint8-png",
      lossyPresentation: true,
      resampling: "nearest",
      crs: "EPSG:4326",
    });
    expect(handoff.url.startsWith("data:image/png;base64,")).toBe(true);
    const png = Uint8Array.from(atob(handoff.url.slice("data:image/png;base64,".length)), (char) => char.charCodeAt(0));
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(handoff.provenance.storeUrl).toBe(STORE);
    session.dispose();
  });

  it("reads one band and one time index without the other chunks", async () => {
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const objects = new Map<string, Uint8Array>([
      [".zgroup", json({ zarr_format: 2 })],
      [
        ".zattrs",
        json({
          variables: ["temperature"],
          primary_variable: "temperature",
          crs_wkid: 4326,
          extent: [-2, -2, 2, 2],
          x_dimension: "x",
          y_dimension: "y",
          t_dimension: "time",
          t_start: "2020-01-01T00:00:00Z",
          t_step_seconds: 3600,
        }),
      ],
      [
        "temperature/.zarray",
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
      ],
      ["temperature/.zattrs", json({ _ARRAY_DIMENSIONS: ["time", "band", "y", "x"] })],
    ]);
    for (let time = 0; time < 2; time += 1) {
      for (let band = 0; band < 2; band += 1) {
        const sample = time * 100 + band;
        objects.set(`temperature/${time}.${band}.0.0`, floats([sample, sample, sample, sample]));
      }
    }
    const transport = memoryFetch(objects);
    const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn });
    const inspection = await session.inspect();
    expect(inspection.dimensions.map((dimension) => dimension.role)).toEqual(["time", "band", "y", "x"]);
    expect(inspection.temporal?.dimension).toBe("time");
    const window = await session.readWindow({
      bands: [2],
      time: { index: 1 },
      pixel: { x: 0, y: 0, width: 2, height: 2 },
    });
    expect(chunkCalls(transport.calls).map((call) => call.key)).toEqual(["temperature/1.1.0.0"]);
    expect(window.bands[0]?.values[0]).toBe(101);
    session.dispose();
  });

  it("reads x-then-y storage into north-up row-major samples", async () => {
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const values: number[] = [];
    for (let x = 0; x < 4; x += 1) {
      for (let y = 0; y < 4; y += 1) values.push(x * 10 + y);
    }
    const objects = new Map<string, Uint8Array>([
      [".zgroup", json({ zarr_format: 2 })],
      [
        ".zattrs",
        json({
          variables: ["temperature"],
          primary_variable: "temperature",
          crs_wkid: 4326,
          extent: [-2, -2, 2, 2],
          x_dimension: "x",
          y_dimension: "y",
        }),
      ],
      [
        "temperature/.zarray",
        json({
          zarr_format: 2,
          shape: [4, 4],
          chunks: [4, 4],
          dtype: "<f4",
          order: "C",
          fill_value: 0,
          filters: null,
          compressor: null,
        }),
      ],
      ["temperature/.zattrs", json({ _ARRAY_DIMENSIONS: ["x", "y"] })],
      ["temperature/0.0", floats(values)],
    ]);
    const transport = memoryFetch(objects);
    const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn });
    const window = await session.readWindow({ pixel: { x: 0, y: 0, width: 4, height: 4 } });
    expect(Array.from(window.bands[0]?.values ?? []).slice(0, 5)).toEqual([0, 10, 20, 30, 1]);
    session.dispose();
  });

  it("cancels before chunk transfer and during the first chunk", async () => {
    const quiet = memoryFetch(zlibGrid());
    const aborted = new AbortController();
    aborted.abort();
    const session = openDirectZarrStore({ url: STORE, fetchFn: quiet.fetchFn });
    await expect(
      session.readWindow({ pixel: { x: 0, y: 0, width: 2, height: 2 } }, { signal: aborted.signal }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(quiet.calls).toHaveLength(0);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = memoryFetch(zlibGrid(), {
      onChunk: (_key, signal) =>
        new Promise((_resolve, reject) => {
          const finish = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (signal.aborted) finish();
          else signal.addEventListener("abort", finish, { once: true });
          void gate.then(() => undefined);
        }),
    });
    const live = openDirectZarrStore({ url: STORE, fetchFn: delayed.fetchFn });
    const controller = new AbortController();
    const pending = live.readWindow({ pixel: { x: 0, y: 0, width: 2, height: 2 } }, { signal: controller.signal });
    await viWaitForChunk(delayed.calls);
    controller.abort();
    release?.();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(chunkCalls(delayed.calls)).toHaveLength(1);
    live.dispose();
  });

  it("refuses chunk, pixel, and decoded-byte budgets before chunk transfer", async () => {
    for (const limits of [{ maxChunks: 1 }, { maxPixels: 4 }, { maxDecodedBytes: 8 }, { maxChunkRequests: 1 }]) {
      const transport = memoryFetch(zlibGrid());
      const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn, limits });
      await expect(session.readWindow({ pixel: { x: 0, y: 0, width: 4, height: 4 } })).rejects.toMatchObject({
        code: "response-too-large",
        detail: expect.objectContaining({ refusal: "budget" }),
      });
      expect(chunkCalls(transport.calls)).toHaveLength(0);
      session.dispose();
    }
  });

  it("fails unreviewed codecs and layouts before chunk transfer and accepts an injected codec", async () => {
    const blosc = v3Array("blosc");
    const transport = memoryFetch(blosc);
    const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn });
    await expect(session.inspect()).rejects.toMatchObject({
      code: "unsupported-codec",
      detail: expect.objectContaining({
        refusal: "unsupported-codec",
        structural: "supported",
        layout: "supported",
        codec: "unsupported",
      }),
    });
    expect(chunkCalls(transport.calls)).toHaveLength(0);

    const sharding = memoryFetch(v3Array("sharding_indexed"));
    await expect(openDirectZarrStore({ url: STORE, fetchFn: sharding.fetchFn }).inspect()).rejects.toMatchObject({
      code: "unsupported-codec",
    });
    expect(chunkCalls(sharding.calls)).toHaveLength(0);

    const fortran = v2Store(new Map(), undefined, { order: "F", compressor: null, filters: null });
    const fortranTransport = memoryFetch(fortran);
    await expect(
      openDirectZarrStore({ url: STORE, fetchFn: fortranTransport.fetchFn }).inspect(),
    ).rejects.toMatchObject({
      code: "invalid-request",
      detail: expect.objectContaining({ refusal: "unsupported-layout", codec: "supported" }),
    });
    expect(chunkCalls(fortranTransport.calls)).toHaveLength(0);

    const injectedObjects = v3Array("blosc");
    injectedObjects.set("temperature/c/0/0", gridChunk(0, 0));
    const injectedTransport = memoryFetch(injectedObjects);
    const injected = openDirectZarrStore({
      url: STORE,
      fetchFn: injectedTransport.fetchFn,
      codecs: [{ id: "blosc", decode: (input) => input }],
    });
    const window = await injected.readWindow({ pixel: { x: 0, y: 0, width: 2, height: 2 } });
    expect(Array.from(window.bands[0]?.values ?? [])).toEqual([0, 1, 10, 11]);
    expect(injectedTransport.calls.some((call) => call.key === "temperature/c/0/0")).toBe(true);
  });

  it("reads v3 gzip chunks and a static content-length response", async () => {
    const objects = v3Array("gzip");
    objects.set("temperature/c/0/0", gzipSync(gridChunk(0, 0)));
    const transport = memoryFetch(objects);
    const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn });
    const window = await session.readWindow({ pixel: { x: 0, y: 0, width: 2, height: 2 } });
    expect(Array.from(window.bands[0]?.values ?? [])).toEqual([0, 1, 10, 11]);
    expect(window.cacheIdentity.startsWith("zarr-direct|v1|3|")).toBe(true);
    const again = await session.inspect();
    expect(again.cacheIdentity).toBe(window.cacheIdentity);
    session.dispose();
  });

  it("refuses int64 raster windows before transfer and still returns subset bytes", async () => {
    const objects = v2Store(new Map(), undefined, {
      dtype: "<i8",
      compressor: null,
      fill_value: 0,
      shape: [4, 4],
      chunks: [4, 4],
    });
    const raw = new Uint8Array(4 * 4 * 8);
    new DataView(raw.buffer).setBigInt64(0, 7n, true);
    objects.set("temperature/0.0", raw);
    const transport = memoryFetch(objects);
    const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn });
    await expect(session.readWindow({ pixel: { x: 0, y: 0, width: 1, height: 1 } })).rejects.toMatchObject({
      code: "unsupported-dtype",
    });
    expect(chunkCalls(transport.calls)).toHaveLength(0);
    const subset = await session.readSubset({ start: [0, 0], stop: [1, 1] });
    expect(
      new DataView(subset.bytes.buffer, subset.bytes.byteOffset, subset.bytes.byteLength).getBigInt64(0, true),
    ).toBe(7n);
    session.dispose();
  });

  it("rejects credential-bearing URLs and keeps signatures out of recorded identity", async () => {
    const transport = memoryFetch(zlibGrid());
    expect(() =>
      openDirectZarrStore({ url: "https://user:secret@data.example/temperature.zarr", fetchFn: transport.fetchFn }),
    ).toThrow(HonuaZarrError);
    expect(transport.calls).toHaveLength(0);
    const signed = memoryFetch(zlibGrid());
    const session = openDirectZarrStore({
      url: `${STORE}?foo=keep&X-Amz-Signature=supersecret`,
      fetchFn: signed.fetchFn,
    });
    const inspection = await session.inspect();
    expect(inspection.url).toContain("foo=keep");
    expect(inspection.url).not.toContain("supersecret");
    expect(inspection.cacheIdentity).not.toContain("supersecret");
    expect(JSON.stringify(inspection.transfer)).not.toContain("supersecret");
    expect(JSON.stringify(inspection.capability)).not.toContain("supersecret");
    session.dispose();
  });

  it("does not read an oversized static body and refuses a window with no spatial bound", async () => {
    const objects = zlibGrid();
    const transport = memoryFetch(objects, { oversized: new Set(["temperature/0.0"]) });
    const session = openDirectZarrStore({ url: STORE, fetchFn: transport.fetchFn, limits: { maxRangeBytes: 8 } });
    await expect(session.readWindow({ pixel: { x: 0, y: 0, width: 2, height: 2 } })).rejects.toMatchObject({
      code: "response-too-large",
    });
    const plain = memoryFetch(zlibGrid());
    const open = openDirectZarrStore({ url: STORE, fetchFn: plain.fetchFn });
    await expect(open.readWindow({})).rejects.toMatchObject({ code: "invalid-request" });
    expect(chunkCalls(plain.calls)).toHaveLength(0);
    session.dispose();
    open.dispose();
  });

  it("hands a direct static store to the canonical raster adapter", async () => {
    const transport = memoryFetch(zlibGrid());
    const session = await openRasterSession(directZarrSource({ id: "temp", url: STORE }), {
      clientOptions: { fetchFn: transport.fetchFn },
    });
    expect(session.plan("read-window")).toMatchObject({
      sourceKind: "zarr",
      mode: "browser-range",
      decoder: "main-thread",
      bounded: true,
    });
    const result = await session.readWindow({ space: "pixel", x: 0, y: 0, width: 4, height: 1 });
    expect(result.kind).toBe("decoded-window");
    if (result.kind !== "decoded-window") return;
    expect(Array.from(result.bands[0]?.values ?? [])).toEqual([0, 1, 2, 3]);
    const image = session.toMapLibreImageSource(result);
    expect(image.type).toBe("image");
    expect(image.coordinates).toEqual([
      [-2, 2],
      [2, 2],
      [2, 1],
      [-2, 1],
    ]);
    expect(image.fidelity?.lossyPresentation).toBe(true);
    expect(image.provenance?.variable).toBe("temperature");
    expect(image.provenance?.storeUrl).not.toContain("api/v1");
    expect(transport.calls.every((call) => call.url.startsWith(`${STORE}/`))).toBe(true);
    const stats = await session.statistics({ space: "pixel", x: 0, y: 0, width: 2, height: 2 });
    expect(stats.bands[0]?.min).toBe(0);
    expect(stats.bands[0]?.max).toBe(11);
    await session.dispose();
  });
});

function v3Array(codec: string): Map<string, Uint8Array> {
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const codecs =
    codec === "gzip" || codec === "blosc" || codec === "sharding_indexed"
      ? [{ name: "bytes", configuration: { endian: "little" } }, { name: codec }]
      : [{ name: "bytes", configuration: { endian: "little" } }];
  return new Map<string, Uint8Array>([
    [
      "zarr.json",
      json({
        zarr_format: 3,
        node_type: "group",
        attributes: {
          variables: ["temperature"],
          primary_variable: "temperature",
          crs_wkid: 4326,
          extent: [-2, -2, 2, 2],
          x_dimension: "x",
          y_dimension: "y",
        },
      }),
    ],
    [
      "temperature/zarr.json",
      json({
        zarr_format: 3,
        node_type: "array",
        shape: [4, 4],
        data_type: "float32",
        chunk_grid: { name: "regular", configuration: { chunk_shape: [2, 2] } },
        chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
        fill_value: 0,
        codecs,
        dimension_names: ["y", "x"],
      }),
    ],
  ]);
}

async function viWaitForChunk(calls: Call[]): Promise<void> {
  const started = Date.now();
  while (chunkCalls(calls).length === 0) {
    if (Date.now() - started > 1000) throw new Error("chunk request did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
