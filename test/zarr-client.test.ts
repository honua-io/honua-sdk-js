import { describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import { HonuaZarrError, createZarrClient } from "../src/zarr/index.js";
import type { ZarrStoreRegistration } from "../src/zarr/types.js";

const registration = {
  id: 41,
  layerId: 7,
  name: "temperature",
  description: "Daily temperature",
  provider: "AwsS3",
  bucket: "coverage-data",
  rootPath: "temperature/daily.zarr",
  zarrFormat: 3,
  srid: 4326,
  variableCount: 1,
  primaryVariable: "temperature",
  variables: [
    {
      name: "temperature",
      shape: [12, 256, 256],
      chunks: [1, 64, 64],
      dataType: "<f4",
      compressor: "gzip",
      dimensionNames: ["time", "y", "x"],
    },
  ],
  metadataScannedAt: "2026-08-13T00:00:00Z",
  createdAt: "2026-08-12T00:00:00Z",
} as const;
const readiness = { tileMatrixSrid: 4326 } as const;

function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(body).length) },
  });
}

describe("experimental Honua Zarr client", () => {
  it("uses the versioned registration contract through the shared auth pipeline", async () => {
    const requests: Request[] = [];
    const client = new HonuaClient({
      baseUrl: "https://zarr.example",
      apiKey: "fixture-key",
      fetchFn: vi.fn(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/api/v1/admin/zarr-stores") {
          expect(await request.json()).toMatchObject({ provider: "AwsS3", rootPath: "temperature/daily.zarr" });
          return json(registration, 201);
        }
        if (request.method === "GET" && url.pathname === "/api/v1/admin/zarr-stores") {
          expect(url.searchParams.get("layerId")).toBe("7");
          return json([registration]);
        }
        if (request.method === "POST" && url.pathname === "/api/v1/admin/zarr-stores/41/refresh") {
          return json(registration);
        }
        if (request.method === "DELETE" && url.pathname === "/api/v1/admin/zarr-stores/41") {
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      }),
    });
    const zarr = createZarrClient(client);

    expect(
      await zarr.register({
        layerId: 7,
        name: "temperature",
        provider: "AwsS3",
        bucket: "coverage-data",
        rootPath: "temperature/daily.zarr",
      }),
    ).toMatchObject({ id: 41, zarrFormat: 3, primaryVariable: "temperature" });
    expect(await zarr.list(7)).toHaveLength(1);
    expect(await zarr.refresh(41)).toMatchObject({ metadataScannedAt: "2026-08-13T00:00:00Z" });
    await expect(zarr.unregister(41)).resolves.toBeUndefined();
    expect(requests.every((request) => request.headers.get("X-API-Key") === "fixture-key")).toBe(true);
  });

  it("builds and fetches a bounded advertised datacube tile handoff", async () => {
    let requested: URL | undefined;
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const client = new HonuaClient({
      baseUrl: "https://zarr.example",
      fetchFn: vi.fn(async (input, init) => {
        const request = new Request(input, init);
        requested = new URL(request.url);
        return new Response(png, {
          headers: { "Content-Type": "image/png", "Content-Length": String(png.byteLength) },
        });
      }),
    });
    const zarr = createZarrClient(client);
    const result = await zarr.tile({
      layerId: 7,
      tileMatrixSetId: "WorldCRS84Quad",
      z: 3,
      x: 2,
      y: 4,
      variable: "temperature",
      datetime: "2026-08-13T00:00:00Z",
      elevation: 1,
      maxResponseBytes: 16,
    });

    expect(result.bytes).toEqual(png);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/png");
    expect(requested?.pathname).toBe("/api/v1/datacubes/7/tiles/WorldCRS84Quad/3/2/4");
    expect(requested?.searchParams.get("variable")).toBe("temperature");
    expect(requested?.searchParams.get("datetime")).toBe("2026-08-13T00:00:00Z");
    expect(requested?.searchParams.get("elevation")).toBe("1");
  });

  it("preserves the server's empty non-intersecting tile response", async () => {
    const client = new HonuaClient({
      baseUrl: "https://zarr.example",
      fetchFn: vi.fn(async () => new Response(null, { status: 204 })),
    });

    await expect(
      createZarrClient(client).tile({
        layerId: 7,
        tileMatrixSetId: "WorldCRS84Quad",
        z: 3,
        x: 2,
        y: 4,
      }),
    ).resolves.toMatchObject({ bytes: new Uint8Array(), contentType: null, status: 204 });
  });

  it("preserves a same-origin relative HonuaClient base path in generated tile URLs", () => {
    const client = new HonuaClient({ baseUrl: "/honua", fetchFn: vi.fn() });
    expect(
      createZarrClient(client).tileUrl({
        layerId: 7,
        tileMatrixSetId: "WebMercatorQuad",
        z: 0,
        x: 0,
        y: 0,
      }),
    ).toBe("/honua/api/v1/datacubes/7/tiles/WebMercatorQuad/0/0/0");
  });

  it("accepts layer zero across registration, listing, responses, and tile URLs", async () => {
    const layerZero = { ...registration, layerId: 0 };
    const requested: URL[] = [];
    const client = new HonuaClient({
      baseUrl: "https://zarr.example",
      fetchFn: vi.fn(async (input, init) => {
        const request = new Request(input, init);
        requested.push(new URL(request.url));
        return request.method === "POST" ? json(layerZero, 201) : json([layerZero]);
      }),
    });
    const zarr = createZarrClient(client);

    await expect(
      zarr.register({
        layerId: 0,
        name: "temperature",
        provider: "AwsS3",
        bucket: "coverage-data",
        rootPath: "temperature/daily.zarr",
      }),
    ).resolves.toMatchObject({ layerId: 0 });
    await expect(zarr.list(0)).resolves.toEqual([expect.objectContaining({ layerId: 0 })]);
    expect(requested[1]?.searchParams.get("layerId")).toBe("0");
    expect(zarr.tileUrl({ layerId: 0, tileMatrixSetId: "WebMercatorQuad", z: 0, x: 0, y: 0 })).toBe(
      "https://zarr.example/api/v1/datacubes/0/tiles/WebMercatorQuad/0/0/0",
    );
  });

  it("fails closed when tile bytes exceed the caller ceiling", async () => {
    const client = new HonuaClient({
      baseUrl: "https://zarr.example",
      fetchFn: vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4, 5]), {
            headers: { "Content-Type": "image/png", "Content-Length": "5" },
          }),
      ),
    });

    await expect(
      createZarrClient(client).tile({
        layerId: 7,
        tileMatrixSetId: "WebMercatorQuad",
        z: 0,
        x: 0,
        y: 0,
        maxResponseBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("reports metadata, codec, dtype, and dimension maturity failures explicitly", () => {
    const client = new HonuaClient({ baseUrl: "https://zarr.example", fetchFn: vi.fn() });
    const zarr = createZarrClient(client);
    expect(zarr.assess(registration as ZarrStoreRegistration, readiness)).toEqual({
      maturity: "experimental",
      metadata: "ready",
      serverTileHandoff: "ready",
      directObjectStoreRead: "unavailable",
      failures: [],
    });

    const pending = { ...registration, zarrFormat: null, variables: null } as unknown as ZarrStoreRegistration;
    expect(zarr.assess(pending, readiness).failures).toEqual([expect.objectContaining({ code: "metadata-pending" })]);
    expect(() => zarr.assertTileReady(pending, readiness)).toThrow(HonuaZarrError);

    const empty = { ...registration, variables: [] } as unknown as ZarrStoreRegistration;
    expect(zarr.assess(empty, readiness)).toMatchObject({
      metadata: "ready",
      serverTileHandoff: "unavailable",
      failures: [{ code: "no-tileable-variable" }],
    });
    expect(() => zarr.assertTileReady(empty, readiness)).toThrow(
      expect.objectContaining({ code: "no-tileable-variable" }),
    );

    const unreferenced = { ...registration, srid: null } as unknown as ZarrStoreRegistration;
    expect(zarr.assess(unreferenced, readiness).failures).toEqual([
      expect.objectContaining({ code: "missing-spatial-reference" }),
    ]);
    expect(() => zarr.assertTileReady(unreferenced, readiness)).toThrow(
      expect.objectContaining({ code: "missing-spatial-reference" }),
    );

    const unsupported = {
      ...registration,
      variables: [
        {
          ...registration.variables[0],
          chunks: [64, 64],
          dataType: ">f4",
          compressor: "blosc",
          dimensionNames: ["y"],
        },
      ],
    } as unknown as ZarrStoreRegistration;
    expect(zarr.assess(unsupported, readiness).failures.map((failure) => failure.code)).toEqual([
      "no-tileable-variable",
      "unsupported-codec",
      "unsupported-dtype",
      "ambiguous-dimensions",
    ]);
  });

  it("assesses the server-selected variable without blocking on auxiliary variables", () => {
    const auxiliary = {
      ...registration.variables[0],
      name: "quality",
      compressor: "blosc",
      dataType: "|f4",
      dimensionNames: ["time"],
      shape: [12],
      chunks: [1],
    };
    const multivariable = {
      ...registration,
      variables: [...registration.variables, auxiliary],
      variableCount: 2,
    } as unknown as ZarrStoreRegistration;
    const zarr = createZarrClient(new HonuaClient({ baseUrl: "https://zarr.example", fetchFn: vi.fn() }));

    expect(zarr.assess(multivariable, readiness).failures).toEqual([]);
    expect(
      zarr.assess(multivariable, { ...readiness, variable: "quality" }).failures.map((failure) => failure.code),
    ).toEqual(["no-tileable-variable", "unsupported-codec", "unsupported-dtype"]);
    expect(zarr.assess(multivariable, { ...readiness, variable: "missing" }).failures).toEqual([
      expect.objectContaining({ code: "no-tileable-variable" }),
    ]);
  });

  it.each(["<f1", "<b8", "|f4", ">f4", "f4"])("rejects non-tileable dtype %s", (dataType) => {
    const candidate = {
      ...registration,
      variables: [{ ...registration.variables[0], dataType }],
    } as unknown as ZarrStoreRegistration;
    const zarr = createZarrClient(new HonuaClient({ baseUrl: "https://zarr.example", fetchFn: vi.fn() }));

    expect(zarr.assess(candidate, readiness).failures).toEqual([
      expect.objectContaining({ code: "unsupported-dtype" }),
    ]);
  });

  it("requires the requested tile matrix SRID to match storage", () => {
    const zarr = createZarrClient(new HonuaClient({ baseUrl: "https://zarr.example", fetchFn: vi.fn() }));
    const scanned = registration as ZarrStoreRegistration;

    expect(zarr.assess(scanned, { tileMatrixSrid: 3857 }).failures).toEqual([
      expect.objectContaining({ code: "spatial-reference-mismatch" }),
    ]);
    expect(zarr.assess(scanned, undefined as never).failures).toEqual([
      expect.objectContaining({ code: "missing-spatial-reference" }),
    ]);
  });

  it("classifies unsupported server versions and accepts empty array dimensions", async () => {
    const responses = [
      { ...registration, zarrFormat: 4 },
      {
        ...registration,
        variables: [{ ...registration.variables[0], shape: [0, 256, 256] }],
      },
    ];
    const client = new HonuaClient({
      baseUrl: "https://zarr.example",
      fetchFn: vi.fn(async () => json(responses.shift())),
    });
    const zarr = createZarrClient(client);

    await expect(zarr.get(41)).rejects.toMatchObject({ code: "unsupported-version" });
    await expect(zarr.get(41)).resolves.toMatchObject({ variables: [{ shape: [0, 256, 256] }] });
  });

  it("rejects unversioned endpoints and unsafe registration paths before network I/O", async () => {
    const fetchFn = vi.fn();
    const client = new HonuaClient({ baseUrl: "https://zarr.example", fetchFn });
    expect(() => createZarrClient(client, { adminBasePath: "/admin/zarr-stores" })).toThrow(HonuaZarrError);
    await expect(
      createZarrClient(client).register({
        layerId: 7,
        name: "bad",
        provider: "Local",
        bucket: "local",
        rootPath: "../escape.zarr",
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
