import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { type ConnectDiscoverySnapshot, connect } from "../src/connect.js";
import { HonuaClient } from "../src/core/client.js";
import {
  HonuaAbortError,
  HonuaCapabilityNotSupportedError,
  HonuaDiscoveryError,
  HonuaHttpError,
  HonuaNetworkError,
  HonuaTimeoutError,
} from "../src/core/errors.js";
import { projectRasterSourceToMapLibre } from "../src/map/raster-source-strategy.js";

const WMS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/wms/capabilities.xml", import.meta.url),
  "utf8",
);
const WMTS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/wmts/capabilities.xml", import.meta.url),
  "utf8",
);

function xml(body: string, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8", ...headers },
  });
}

function capabilitiesFetch(body: string, onRequest?: (request: Request) => void): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    onRequest?.(request);
    return xml(body, { ETag: '"capabilities-v1"' });
  });
}

describe("connect() — WMS/WMTS capabilities discovery", () => {
  it("discovers WMS layers, operations, formats, styles, dimensions, CRS axes, and capability truth", async () => {
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        apiKey: "test-key",
        fetchFn: capabilitiesFetch(WMS_CAPABILITIES, (request) => requests.push(request)),
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("x-api-key")).toBe("test-key");
    const requestUrl = new URL(requests[0]!.url);
    expect(requestUrl.pathname).toBe("/ogc/wms");
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      SERVICE: "WMS",
      REQUEST: "GetCapabilities",
      VERSION: "1.3.0",
    });

    expect(connection.inspection.protocol).toBe("wms");
    expect(connection.dataset.sourceIds()).toEqual(["parcels", "imagery"]);
    const parcels = connection.inspection.sources.find((source) => source.descriptor.id === "parcels")!;
    const imagery = connection.inspection.sources.find((source) => source.descriptor.id === "imagery")!;
    expect(parcels.descriptor.capabilities.has("render")).toBe(true);
    expect(parcels.descriptor.capabilities.has("tiles")).toBe(true);
    expect(parcels.descriptor.capabilities.has("query")).toBe(false);
    expect(imagery.descriptor.capabilities.has("render")).toBe(true);
    expect(imagery.descriptor.capabilities.has("query")).toBe(false);
    expect(imagery.metadata?.operations?.featureInfo).toMatchObject({
      available: false,
      reason: "The WMS layer is not queryable.",
    });

    expect(parcels.descriptor.locator).toEqual({
      url: "https://maps.example/ogc/wms",
      typeName: "parcels",
      raster: {
        kind: "wms-kvp",
        url: "https://maps.example/ogc/render?tenant=public",
        format: "image/png",
      },
    });
    expect(parcels.metadata?.protocolVersion).toBe("1.3.0");
    expect(parcels.metadata?.formats?.render).toEqual(["image/png", "image/jpeg", "image/svg+xml"]);
    expect(parcels.metadata?.styles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "outline", isDefault: false }),
        expect.objectContaining({ id: "night", isDefault: false }),
      ]),
    );
    expect(parcels.metadata?.dimensions?.[0]).toMatchObject({
      id: "time",
      units: "ISO8601",
      default: "2026-07-16T00:00:00Z",
    });
    expect(parcels.metadata?.axisOrders).toEqual(
      expect.arrayContaining([
        { crs: "EPSG:4326", order: "yx" },
        { crs: "EPSG:3857", order: "xy" },
        { crs: "CRS:84", order: "xy" },
      ]),
    );
    expect(parcels.metadata?.operations?.render).toMatchObject({
      available: true,
      methods: ["GET", "POST"],
      urls: ["https://maps.example/ogc/render?tenant=public", "https://maps.example/ogc/render-post?tenant=public"],
    });
    expect(parcels.metadata?.operations?.featureInfo).toMatchObject({
      available: false,
      reason: "Raw WMS GetFeatureInfo requires a Honua service binding for the existing canonical query adapter.",
    });
    expect(parcels.metadata?.operations?.legend).toMatchObject({
      available: true,
      formats: ["image/png"],
      methods: ["GET"],
      urls: ["https://maps.example/ogc/legend?tenant=public"],
    });
    const rawSource = connection.source("parcels");
    expect(rawSource.descriptor).toMatchObject({
      id: parcels.descriptor.id,
      protocol: parcels.descriptor.protocol,
      locator: parcels.descriptor.locator,
    });
    expect([...rawSource.capabilities]).toEqual([...parcels.descriptor.capabilities]);
    expect(rawSource.protocol("wms")).toBeUndefined();
    await expect(rawSource.query()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    const projection = projectRasterSourceToMapLibre(rawSource.descriptor);
    expect(projection.source.tiles[0]).toContain("https://maps.example/ogc/render?tenant=public&");
    expect(projection.source.tiles[0]).not.toContain("https://maps.example/ogc/wms?");
    expect(projection.source.tiles[0]).toContain("REQUEST=GetMap");
    expect(parcels.provenance[0]?.source).toContain("SERVICE=WMS");
    expect(parcels.provenance[0]?.validator).toBe('"capabilities-v1"');
  });

  it("normalizes standard capabilities KVP URLs for auto detection and supports explicit WMS style selection", async () => {
    const fetchFn = capabilitiesFetch(WMS_CAPABILITIES);
    const connection = await connect({
      endpoint: "https://maps.example/dispatch?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0",
      protocol: "auto",
      typeName: "parcels",
      styleId: "outline",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.inspection.endpoint).toBe("https://maps.example/dispatch");
    expect(connection.inspection.defaultSourceId).toBe("parcels");
    expect(connection.inspection.sources[0]?.descriptor.locator).toEqual({
      url: "https://maps.example/dispatch",
      typeName: "parcels",
      styleId: "outline",
      raster: {
        kind: "wms-kvp",
        url: "https://maps.example/render?tenant=public",
        format: "image/png",
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("discovers WMTS styles, dimensions, relative REST resources, and all linked tile matrices", async () => {
    const connection = await connect({
      endpoint: "https://tiles.example/ogc/wmts?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(WMTS_CAPABILITIES) },
    });

    expect(connection.inspection.endpoint).toBe("https://tiles.example/ogc/wmts");
    const source = connection.inspection.sources[0]!;
    expect(source.descriptor.locator).toEqual({
      url: "https://tiles.example/ogc/wmts",
      typeName: "imagery",
      styleId: "day",
      tileMatrixSetId: "WebMercatorQuad",
      raster: {
        kind: "wmts-template",
        url: "https://tiles.example/ogc/tiles/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png?tenant=public",
        format: "image/png",
        tileMatrixTemplate: "{z}",
      },
    });
    expect(source.descriptor.capabilities.has("render")).toBe(true);
    expect(source.descriptor.capabilities.has("tiles")).toBe(true);
    expect(source.descriptor.capabilities.has("query")).toBe(false);
    expect(source.metadata?.styles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "day", isDefault: true }),
        expect.objectContaining({ id: "night", isDefault: false }),
      ]),
    );
    expect(source.metadata?.dimensions?.[0]).toMatchObject({ id: "Time", current: true });
    expect(source.metadata?.tileMatrixSets?.map((matrixSet) => matrixSet.id)).toEqual([
      "WebMercatorQuad",
      "WorldCRS84Quad",
    ]);
    expect(source.metadata?.tileMatrixSets?.[0]?.matrices).toHaveLength(2);
    expect(source.metadata?.operations?.tiles).toMatchObject({ available: true });
    expect(source.metadata?.operations?.tiles?.methods).toEqual(["GET", "TEMPLATE"]);
    expect(source.metadata?.operations?.tiles?.urls).toContain(
      "https://tiles.example/ogc/tiles/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png?tenant=public",
    );
    expect(source.metadata?.operations?.featureInfo).toMatchObject({ available: true });
    expect(source.metadata?.operations?.featureInfo?.urls).toContain(
      "https://tiles.example/ogc/info/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}/{J}/{I}.json?tenant=public",
    );
    const rawSource = connection.source("imagery");
    expect(rawSource.protocol("wmts")).toBeUndefined();
    await expect(rawSource.query()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect(projectRasterSourceToMapLibre(rawSource.descriptor).source.tiles).toEqual([
      "https://tiles.example/ogc/tiles/day/WebMercatorQuad/{z}/{y}/{x}.png?tenant=public",
    ]);
  });

  it("preserves advertised WMTS matrix identifier prefixes in the existing MapLibre path", async () => {
    const prefixed = WMTS_CAPABILITIES.replace(
      "<ows:Identifier>0</ows:Identifier>",
      "<ows:Identifier>EPSG3857:0</ows:Identifier>",
    ).replace("<ows:Identifier>1</ows:Identifier>", "<ows:Identifier>EPSG3857:1</ows:Identifier>");
    const connection = await connect({
      endpoint: "https://tiles.example/ogc/wmts",
      protocol: "wmts",
      typeName: "imagery",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(prefixed) },
    });

    expect(connection.source().descriptor.locator.raster).toMatchObject({
      kind: "wmts-template",
      tileMatrixTemplate: "EPSG3857:{z}",
    });
    expect(projectRasterSourceToMapLibre(connection.source().descriptor).source.tiles[0]).toContain(
      "/EPSG3857%3A{z}/{y}/{x}.png?tenant=public",
    );
  });

  it("fails closed when advertised WMTS matrix identifiers cannot map exactly to MapLibre zooms", async () => {
    const nonExecutable = WMTS_CAPABILITIES.replace(
      "<ows:Identifier>0</ows:Identifier>",
      "<ows:Identifier>zero</ows:Identifier>",
    ).replace("<ows:Identifier>1</ows:Identifier>", "<ows:Identifier>one</ows:Identifier>");
    const connection = await connect({
      endpoint: "https://tiles.example/ogc/wmts",
      protocol: "wmts",
      typeName: "imagery",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(nonExecutable) },
    });
    const source = connection.inspection.sources[0]!;

    expect(source.descriptor.capabilities.has("render")).toBe(false);
    expect(source.descriptor.capabilities.has("tiles")).toBe(false);
    expect(source.descriptor.locator.raster).toBeUndefined();
    expect(source.metadata?.operations?.tiles).toMatchObject({
      available: false,
      reason: 'WMTS tile matrix set "WebMercatorQuad" has identifiers that cannot map exactly to MapLibre zoom levels.',
    });
  });

  it("retains canonical Honua WMS query execution only when discovery resolves a service id", async () => {
    const connection = await connect({
      endpoint: "https://maps.example/rest/services/Public/Map/MapServer/WMS",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(WMS_CAPABILITIES) },
    });
    const source = connection.source();

    expect(source.descriptor.locator.serviceId).toBe("Public/Map");
    expect(source.capabilities.has("query")).toBe(true);
    expect(source.protocol("wms")).toBeDefined();
  });

  it("shares cached capabilities across layer/style selections but isolates authorization scopes", async () => {
    const fetchFn = capabilitiesFetch(WMS_CAPABILITIES);
    const client = new HonuaClient({ baseUrl: "https://maps.example", fetchFn });
    await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "scope-a",
      client,
    });
    const style = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      styleId: "night",
      authorizationScopeFingerprint: "scope-a",
      client,
    });
    await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "scope-b",
      client,
    });

    expect(style.inspection.sources[0]?.descriptor.locator.styleId).toBe("night");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ETag", '"capabilities-v1"', "if-none-match"],
    ["Last-Modified", "Thu, 16 Jul 2026 12:00:00 GMT", "if-modified-since"],
  ] as const)(
    "revalidates cached capabilities with %s and accepts a valid 304",
    async (header, value, requestHeader) => {
      const requests: Request[] = [];
      const fetchFn = vi.fn(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (requests.length === 1) return xml(WMS_CAPABILITIES, { [header]: value });
        return new Response(null, { status: 304, headers: { [header]: value } });
      });
      const client = new HonuaClient({ baseUrl: "https://maps.example", fetchFn });
      const options = {
        endpoint: "https://maps.example/ogc/wms",
        protocol: "wms" as const,
        typeName: "parcels",
        authorizationScopeFingerprint: "anonymous",
        client,
      };
      await connect(options);
      const refreshed = await connect({ ...options, refresh: true });

      expect(requests).toHaveLength(2);
      expect(requests[1]?.headers.get(requestHeader)).toBe(value);
      expect(refreshed.inspection.sources[0]?.descriptor.capabilities.has("render")).toBe(true);
      expect(refreshed.inspection.sources[0]?.descriptor.capabilities.has("query")).toBe(false);
    },
  );

  it("degrades malformed optional metadata into structured partial-discovery reasons", async () => {
    const missingStyleName = WMS_CAPABILITIES.replace(
      "<Style><Name>night</Name><Title>Night</Title></Style>",
      "<Style><Title>Missing name</Title></Style>",
    );
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(missingStyleName) },
    });
    const source = connection.inspection.sources[0]!;

    expect(source.descriptor.capabilities.has("render")).toBe(true);
    expect(source.metadata?.styles?.map((style) => style.id)).toEqual(["outline"]);
    expect(source.metadata?.partialReasons).toContain("WMS Style metadata without a name was ignored.");
    expect(source.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "partial-discovery",
          message: "WMS metadata retained 2 structured partial-discovery reasons.",
        }),
      ]),
    );
  });

  it("rejects unsafe advertised URLs without retaining credentials or inventing render support", async () => {
    const unsafe = WMS_CAPABILITIES.replace(
      './render?tenant=public"',
      'https://evil.example/render?token=secret"',
    ).replace('./render-post?tenant=public"', 'https://evil.example/render-post?token=secret"');
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(unsafe) },
    });
    const source = connection.inspection.sources[0]!;

    expect(source.descriptor.capabilities.has("render")).toBe(false);
    expect(source.descriptor.capabilities.has("tiles")).toBe(false);
    expect(source.metadata?.operations?.render).toMatchObject({ available: false });
    expect(source.metadata?.operations?.render?.urls).toEqual([]);
    expect(source.metadata?.operations?.render?.methods).toEqual([]);
    expect(source.metadata?.partialReasons?.join(" ")).not.toContain("secret");
    expect(source.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "partial-discovery" })]),
    );
  });

  it("retains only methods backed by validated same-origin operation URLs", async () => {
    const unsafePost = WMS_CAPABILITIES.replace(
      './render-post?tenant=public"',
      'https://evil.example/render-post?token=secret"',
    );
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(unsafePost) },
    });

    expect(connection.inspection.sources[0]?.metadata?.operations?.render).toMatchObject({
      available: true,
      methods: ["GET"],
      urls: ["https://maps.example/ogc/render?tenant=public"],
    });
  });

  it("refuses cross-origin redirects before credentials can be replayed", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/capabilities" } }),
    );
    await expect(
      connect({
        endpoint: "https://maps.example/ogc/wms",
        protocol: "wms",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { apiKey: "secret", fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaNetworkError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("enforces caller cancellation, response-size limits, and the discovery deadline", async () => {
    const controller = new AbortController();
    const cancelledFetch = vi.fn(async (_input, init) => {
      controller.abort();
      throw new DOMException(init?.signal?.aborted ? "aborted" : "unexpected", "AbortError");
    });
    await expect(
      connect({
        endpoint: "https://maps.example/ogc/wms",
        protocol: "wms",
        authorizationScopeFingerprint: "anonymous",
        signal: controller.signal,
        clientOptions: { fetchFn: cancelledFetch },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);

    await expect(
      connect({
        endpoint: "https://maps.example/ogc/wms",
        protocol: "wms",
        authorizationScopeFingerprint: "anonymous",
        capabilitiesLimits: { maxBytes: 128 },
        clientOptions: { fetchFn: capabilitiesFetch(WMS_CAPABILITIES) },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });

    const hangingFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    await expect(
      connect({
        endpoint: "https://maps.example/ogc/wms",
        protocol: "wms",
        authorizationScopeFingerprint: "anonymous",
        capabilitiesLimits: { timeoutMs: 5 },
        clientOptions: { fetchFn: hangingFetch },
      }),
    ).rejects.toBeInstanceOf(HonuaTimeoutError);
  });

  it("does not use stale metadata for authorization failures", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return xml(WMS_CAPABILITIES, { ETag: '"capabilities-v1"' });
      return new Response("denied", { status: 401, headers: { "Content-Type": "text/plain" } });
    });
    const client = new HonuaClient({ baseUrl: "https://maps.example", fetchFn });
    const options = {
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms" as const,
      authorizationScopeFingerprint: "anonymous",
      client,
    };
    await connect(options);
    await expect(connect({ ...options, refresh: true })).rejects.toBeInstanceOf(HonuaHttpError);
  });

  it("does not read validators or stale metadata when the metadata cache is bypassed", async () => {
    const requests: Request[] = [];
    const fetchFn = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) return xml(WMS_CAPABILITIES, { ETag: '"capabilities-v1"' });
      return new Response("temporarily unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    });
    const client = new HonuaClient({
      baseUrl: "https://maps.example",
      fetchFn,
      retry: { maxRetries: 0 },
    });
    const options = {
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms" as const,
      authorizationScopeFingerprint: "anonymous",
      client,
    };
    await connect(options);
    await expect(connect({ ...options, metadata: { cache: "bypass" } })).rejects.toBeInstanceOf(HonuaHttpError);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("if-none-match")).toBeNull();
    expect(requests[1]?.headers.get("if-modified-since")).toBeNull();
    expect(requests[1]?.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects malformed XML and credential-bearing cached operation metadata", async () => {
    await expect(
      connect({
        endpoint: "https://maps.example/ogc/wms",
        protocol: "wms",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: capabilitiesFetch('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><WMS_Capabilities/>'),
        },
      }),
    ).rejects.toBeInstanceOf(HonuaDiscoveryError);

    let snapshot: ConnectDiscoverySnapshot | undefined;
    const options = {
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms" as const,
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
    };
    await connect({
      ...options,
      clientOptions: { fetchFn: capabilitiesFetch(WMS_CAPABILITIES) },
      cache: {
        get: () => undefined,
        set: (_identity, value) => {
          snapshot = value;
        },
      },
    });
    const tampered = structuredClone(snapshot!);
    const render = tampered.sources[0]!.metadata!.operations!.render!;
    (render.urls as string[])[0] = "https://maps.example/render?token=secret";
    await expect(
      connect({
        ...options,
        clientOptions: { fetchFn: vi.fn() },
        cache: { get: () => tampered, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
  });
});
