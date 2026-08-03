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
import { point } from "../src/core/spatial-filter.js";
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
    expect(parcels.descriptor.capabilities.has("query")).toBe(true);
    expect(imagery.descriptor.capabilities.has("render")).toBe(true);
    expect(imagery.descriptor.capabilities.has("query")).toBe(false);
    expect(imagery.descriptor.locator.featureInfo).toBeUndefined();
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
      featureInfo: {
        kind: "wms-kvp",
        url: "https://maps.example/ogc/feature-info?tenant=public",
        format: "application/geo+json",
        crs: ["EPSG:4326", "EPSG:3857", "CRS:84"],
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
      available: true,
      methods: ["GET"],
      formats: ["application/geo+json", "text/plain"],
      urls: ["https://maps.example/ogc/feature-info?tenant=public"],
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
      featureInfo: {
        kind: "wms-kvp",
        url: "https://maps.example/feature-info?tenant=public",
        format: "application/geo+json",
        crs: ["EPSG:4326", "EPSG:3857", "CRS:84"],
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("uses one canonical service identity for bare and GetCapabilities WMS locators", async () => {
    const fetchFn = capabilitiesFetch(WMS_CAPABILITIES);
    const snapshots = new Map<string, ConnectDiscoverySnapshot>();
    const identities: string[] = [];
    const cache = {
      get: (identity: { readonly key: string }) => {
        identities.push(identity.key);
        return snapshots.get(identity.key);
      },
      set: (identity: { readonly key: string }, snapshot: ConnectDiscoverySnapshot) => {
        identities.push(identity.key);
        snapshots.set(identity.key, snapshot);
      },
    };
    const base = {
      protocol: "wms" as const,
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache,
    };

    const capabilities = await connect({
      ...base,
      endpoint: "https://maps.example/dispatch?VERSION=1.3.0&tenant=public&REQUEST=GetCapabilities&SERVICE=WMS",
    });
    const bare = await connect({ ...base, endpoint: "https://maps.example/dispatch?tenant=public" });

    expect(capabilities.inspection.endpoint).toBe("https://maps.example/dispatch?tenant=public");
    expect(bare.inspection.endpoint).toBe(capabilities.inspection.endpoint);
    expect(bare.inspection.cacheStatus).toBe("hit");
    expect(new Set(identities).size).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("uses one canonical service identity for bare and GetCapabilities WMTS locators", async () => {
    const fetchFn = capabilitiesFetch(WMTS_CAPABILITIES);
    const snapshots = new Map<string, ConnectDiscoverySnapshot>();
    const identities: string[] = [];
    const cache = {
      get: (identity: { readonly key: string }) => {
        identities.push(identity.key);
        return snapshots.get(identity.key);
      },
      set: (identity: { readonly key: string }, snapshot: ConnectDiscoverySnapshot) => {
        identities.push(identity.key);
        snapshots.set(identity.key, snapshot);
      },
    };
    const base = {
      protocol: "wmts" as const,
      typeName: "imagery",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache,
    };

    const capabilities = await connect({
      ...base,
      endpoint: "https://tiles.example/dispatch?VERSION=1.0.0&tenant=public&REQUEST=GetCapabilities&SERVICE=WMTS",
    });
    const bare = await connect({ ...base, endpoint: "https://tiles.example/dispatch?tenant=public" });

    expect(capabilities.inspection.endpoint).toBe("https://tiles.example/dispatch?tenant=public");
    expect(bare.inspection.endpoint).toBe(capabilities.inspection.endpoint);
    expect(bare.inspection.cacheStatus).toBe("hit");
    expect(new Set(identities).size).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(["https://maps.example/ogc/wms?SERVICE=WMTS", "https://maps.example/ogc/wms?SERVICE=WMS&SERVICE=WMS"])(
    "rejects conflicting or duplicate raster protocol evidence in %s before fetch or cache access",
    async (endpoint) => {
      const fetchFn = vi.fn();
      const get = vi.fn();
      const set = vi.fn();

      await expect(
        connect({
          endpoint,
          protocol: "auto",
          authorizationScopeFingerprint: "anonymous",
          clientOptions: { fetchFn },
          cache: { get, set },
        }),
      ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });

      expect(fetchFn).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://user:password@maps.example/ogc/wms",
    "https://maps.example/ogc/wms?API_KEY=TOP-SECRET",
    "https://maps.example/ogc/wms?%41PI%5FKEY=TOP-SECRET",
    "https://maps.example/ogc/wms?%2574oken=TOP-SECRET",
    "https://maps.example/ogc/wms?accessToken=TOP-SECRET",
    "https://maps.example/ogc/wms?tenant=public&token=TOP-SECRET&TOKEN=SECOND-SECRET",
  ])("rejects credential-bearing WMS locator %s before fetch or cache access", async (endpoint) => {
    const fetchFn = vi.fn();
    const get = vi.fn();
    const set = vi.fn();

    const error = await connect({
      endpoint,
      protocol: "wms",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache: { get, set },
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(JSON.stringify(error)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(error)).not.toContain("SECOND-SECRET");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("retains advertised WMS CRS metadata but enables MapLibre raster only with exact Web Mercator evidence", async () => {
    const withoutWebMercator = WMS_CAPABILITIES.replace("<CRS>EPSG:3857</CRS>", "<CRS>EPSG:32604</CRS>");
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(withoutWebMercator) },
    });
    const source = connection.inspection.sources[0]!;

    expect(source.metadata?.crs).toContain("EPSG:32604");
    expect(source.metadata?.axisOrders).toContainEqual({ crs: "EPSG:32604", order: "unknown" });
    expect(source.metadata?.axisOrders).toHaveLength(source.metadata?.crs?.length ?? -1);
    expect(source.descriptor.capabilities.has("render")).toBe(false);
    expect(source.descriptor.capabilities.has("tiles")).toBe(false);
    expect(source.descriptor.locator.raster).toBeUndefined();
    expect(source.metadata?.operations?.render).toMatchObject({
      available: false,
      reason: "WMS layer does not advertise an exact EPSG:3857 CRS required by the current MapLibre raster adapter.",
    });
  });

  it("retains WMS metadata but refuses formats the raster adapter cannot execute", async () => {
    const unsupportedFormats = WMS_CAPABILITIES.replace(
      "<Format>image/png</Format>\n        <Format>image/jpeg</Format>\n        <Format>image/svg+xml</Format>",
      "<Format>image/tiff</Format>\n        <Format>image/svg+xml</Format>",
    );
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(unsupportedFormats) },
    });
    const source = connection.inspection.sources[0]!;

    expect(source.metadata?.formats?.render).toEqual(["image/tiff", "image/svg+xml"]);
    expect(source.descriptor.locator.raster).toBeUndefined();
    expect(source.metadata?.operations?.render).toMatchObject({
      available: false,
      reason: "WMS GetMap advertises no supported image format.",
    });
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

  it.each([
    ["CRS", "urn:ogc:def:crs:EPSG::3857", "urn:ogc:def:crs:EPSG::4326"],
    [
      "well-known scale set",
      "urn:ogc:def:wkss:OGC:1.0:GoogleMapsCompatible",
      "urn:ogc:def:wkss:OGC:1.0:GoogleMapsCompatibleExtended",
    ],
    ["origin", "-20037508.3427892 20037508.3427892", "-180 90"],
    ["scale progression", "279541132.0143589", "279541000"],
    ["matrix dimensions", "<MatrixWidth>2</MatrixWidth>", "<MatrixWidth>3</MatrixWidth>"],
    ["invalid numeric dimensions", "<MatrixWidth>1</MatrixWidth>", "<MatrixWidth>1.5</MatrixWidth>"],
  ] as const)("keeps WMTS metadata but fails closed for incoherent %s evidence", async (_case, before, after) => {
    const incoherent = WMTS_CAPABILITIES.replace(before, after);
    const connection = await connect({
      endpoint: "https://tiles.example/ogc/wmts",
      protocol: "wmts",
      typeName: "imagery",
      tileMatrixSetId: "WebMercatorQuad",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(incoherent) },
    });
    const source = connection.inspection.sources[0]!;

    expect(source.metadata?.tileMatrixSets?.find((matrixSet) => matrixSet.id === "WebMercatorQuad")).toBeDefined();
    expect(source.descriptor.capabilities.has("render")).toBe(false);
    expect(source.descriptor.capabilities.has("tiles")).toBe(false);
    expect(source.descriptor.locator.raster).toBeUndefined();
    expect(source.metadata?.operations?.tiles).toMatchObject({ available: false });
    expect(source.metadata?.partialReasons?.some((reason) => reason.includes("WebMercatorQuad"))).toBe(true);
  });

  it("retains canonical Honua WMS query execution only when discovery resolves a service id", async () => {
    const connection = await connect({
      endpoint: "https://maps.example/rest/services/Public/Map/MapServer/WMS",
      protocol: "auto",
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
      expect(refreshed.inspection.sources[0]?.descriptor.capabilities.has("query")).toBe(true);
    },
  );

  it("preserves an unmodified cached validator when a 304 refreshes only its sibling", async () => {
    const requests: Request[] = [];
    const lastModified = "Thu, 16 Jul 2026 12:00:00 GMT";
    const fetchFn = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        return xml(WMS_CAPABILITIES, { ETag: '"capabilities-v1"', "Last-Modified": lastModified });
      }
      if (requests.length === 2) return new Response(null, { status: 304, headers: { ETag: '"capabilities-v2"' } });
      return new Response(null, { status: 304 });
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
    await connect({ ...options, refresh: true });
    await connect({ ...options, refresh: true });

    expect(requests[2]?.headers.get("if-none-match")).toBe('"capabilities-v2"');
    expect(requests[2]?.headers.get("if-modified-since")).toBe(lastModified);
  });

  it.each([
    [206, { "Content-Range": "bytes 0-1023/2048" }],
    [200, { "Content-Range": "bytes 0-1023/2048" }],
  ] as const)(
    "rejects HTTP %s range metadata instead of caching it as a complete capabilities document",
    async (status, headers) => {
      let calls = 0;
      const fetchFn = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return xml(WMS_CAPABILITIES, { ETag: '"capabilities-v1"' });
        return new Response(WMS_CAPABILITIES, {
          status,
          headers: { "Content-Type": "application/xml", ...headers },
        });
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
      await expect(connect({ ...options, refresh: true })).rejects.toMatchObject({
        name: "HonuaDiscoveryError",
        code: "invalid-endpoint",
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["unsupported content type", { "Content-Type": "text/html" }],
    ["invalid Content-Length", { "Content-Type": "application/xml", "Content-Length": "not-a-number" }],
  ] as const)("cancels the response body after rejecting an %s", async (_case, headers) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchFn = vi.fn(async () => new Response(body, { status: 200, headers }));

    await expect(
      connect({
        endpoint: "https://maps.example/ogc/wms",
        protocol: "wms",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

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
          message: "WMS metadata retained 1 structured partial-discovery reason.",
        }),
      ]),
    );
  });

  it("rejects unsafe advertised URLs without retaining credentials or inventing render support", async () => {
    const unsafe = WMS_CAPABILITIES.replace('./render?tenant=public"', './render?%2541PI%255FKEY=TOP-SECRET"')
      .replace('./render-post?tenant=public"', './render-post?Authorization=TOP-SECRET"')
      .replace('./legends/outline.png"', './legends/outline.png?token=TOP-SECRET"')
      .replace('./legend?tenant=public"', './legend?x-amz-signature=TOP-SECRET"');
    let snapshot: ConnectDiscoverySnapshot | undefined;
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(unsafe) },
      cache: {
        get: () => undefined,
        set: (_identity, value) => {
          snapshot = value;
        },
      },
    });
    const source = connection.inspection.sources[0]!;

    expect(source.descriptor.capabilities.has("render")).toBe(false);
    expect(source.descriptor.capabilities.has("tiles")).toBe(false);
    expect(source.metadata?.operations?.render).toMatchObject({ available: false });
    expect(source.metadata?.operations?.render?.urls).toEqual([]);
    expect(source.metadata?.operations?.render?.methods).toEqual([]);
    expect(source.metadata?.styles?.find((style) => style.id === "outline")?.legendUrl).toBeUndefined();
    expect(source.metadata?.operations?.legend?.urls).toEqual([]);
    expect(JSON.stringify(connection.inspection)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(snapshot)).not.toContain("TOP-SECRET");
    expect(source.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "partial-discovery" })]),
    );

    const unsafeFetch = capabilitiesFetch(unsafe);
    const client = new HonuaClient({ baseUrl: "https://maps.example", fetchFn: unsafeFetch });
    const options = {
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms" as const,
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      client,
    };
    await connect(options);
    await connect(options);
    expect(unsafeFetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache capabilities containing an unparseable advertised URL", async () => {
    const invalid = WMS_CAPABILITIES.replace('./render?tenant=public"', 'https://[invalid?token=TOP-SECRET"');
    const fetchFn = capabilitiesFetch(invalid);
    const client = new HonuaClient({ baseUrl: "https://maps.example", fetchFn });
    const options = {
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms" as const,
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      client,
    };

    const first = await connect(options);
    await connect(options);

    expect(first.inspection.sources[0]?.metadata?.operations?.render?.urls).not.toContain(
      "https://[invalid?token=TOP-SECRET",
    );
    expect(JSON.stringify(first.inspection)).not.toContain("TOP-SECRET");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects same-origin operation URLs with non-HTTP schemes before advertising render support", async () => {
    const unsupportedScheme = WMS_CAPABILITIES.replace(
      './render?tenant=public"',
      'blob:https://maps.example/render-id"',
    );
    const fetchFn = capabilitiesFetch(unsupportedScheme);
    const client = new HonuaClient({ baseUrl: "https://maps.example", fetchFn });
    const options = {
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms" as const,
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      client,
    };
    const connection = await connect(options);
    await connect(options);
    const source = connection.inspection.sources[0]!;

    expect(source.descriptor.capabilities.has("render")).toBe(false);
    expect(source.descriptor.capabilities.has("tiles")).toBe(false);
    expect(source.descriptor.locator.raster).toBeUndefined();
    expect(source.metadata?.operations?.render).toMatchObject({
      available: false,
      methods: ["POST"],
      urls: ["https://maps.example/ogc/render-post?tenant=public"],
    });
    expect(source.metadata?.partialReasons).toContain(
      "WMS GetMap GET URL must use HTTP(S), remain same-origin, and contain no credentials or fragment.",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects credential-bearing WMTS operations, resources, and legends without leaking their values", async () => {
    const unsafe = WMTS_CAPABILITIES.replace('./kvp?tenant=public"', './kvp?%2541uthorization=TOP-SECRET"')
      .replace('./legends/day.png"', './legends/day.png?token=TOP-SECRET"')
      .replace('TileCol}.png?tenant=public"/>', 'TileCol}.png?x-goog-signature=TOP-SECRET"/>');
    let snapshot: ConnectDiscoverySnapshot | undefined;
    const connection = await connect({
      endpoint: "https://tiles.example/ogc/wmts",
      protocol: "wmts",
      typeName: "imagery",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(unsafe) },
      cache: {
        get: () => undefined,
        set: (_identity, value) => {
          snapshot = value;
        },
      },
    });
    const source = connection.inspection.sources[0]!;

    expect(source.descriptor.capabilities.has("render")).toBe(false);
    expect(source.descriptor.locator.raster).toBeUndefined();
    expect(source.metadata?.styles?.find((style) => style.id === "day")?.legendUrl).toBeUndefined();
    expect(JSON.stringify(connection.inspection)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(snapshot)).not.toContain("TOP-SECRET");
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

  it("reapplies caller limits before replaying a fresh capabilities cache entry", async () => {
    const fetchFn = capabilitiesFetch(WMS_CAPABILITIES);
    const client = new HonuaClient({ baseUrl: "https://maps.example", fetchFn });
    const options = {
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms" as const,
      authorizationScopeFingerprint: "anonymous",
      client,
    };

    await connect(options);
    await expect(connect({ ...options, capabilitiesLimits: { maxBytes: 128 } })).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    await expect(connect({ ...options, capabilitiesLimits: { maxBytes: 0 } })).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
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

  it("hands caller caches deeply frozen raster snapshots and replays an isolated owned copy", async () => {
    let snapshot: ConnectDiscoverySnapshot | undefined;
    const cache = {
      get: () => snapshot,
      set: (_identity: unknown, value: ConnectDiscoverySnapshot) => {
        snapshot = value;
      },
    };
    const options = {
      endpoint: "https://tiles.example/ogc/wmts",
      protocol: "wmts" as const,
      typeName: "imagery",
      authorizationScopeFingerprint: "anonymous",
      cache,
    };
    await connect({ ...options, clientOptions: { fetchFn: capabilitiesFetch(WMTS_CAPABILITIES) } });

    const source = snapshot!.sources[0]!;
    const raster = source.locator.raster!;
    const metadata = source.metadata!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(source.locator)).toBe(true);
    expect(Object.isFrozen(raster)).toBe(true);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.operations?.tiles)).toBe(true);
    expect(Object.isFrozen(metadata.operations?.tiles?.urls)).toBe(true);
    expect(Object.isFrozen(metadata.tileMatrixSets?.[0]?.matrices[0]?.topLeftCorner)).toBe(true);
    expect(() => {
      (raster as { url: string }).url = "https://tiles.example/changed";
    }).toThrow();

    const replay = await connect({ ...options, clientOptions: { fetchFn: vi.fn() } });
    expect(replay.inspection.cacheStatus).toBe("hit");
    expect(replay.source().descriptor.locator.raster).toEqual(raster);
    expect(replay.source().descriptor.locator.raster).not.toBe(raster);
    expect(Object.isFrozen(replay.source().descriptor.locator.raster)).toBe(true);
  });

  it("rejects cached WMS axis drift and percent-encoded credential state", async () => {
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

    const axisDrift = structuredClone(snapshot!);
    (axisDrift.sources[0]!.metadata!.axisOrders![0]! as { order: "xy" | "yx" | "unknown" }).order = "xy";
    await expect(
      connect({
        ...options,
        clientOptions: { fetchFn: vi.fn() },
        cache: { get: () => axisDrift, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });

    const credentialDrift = structuredClone(snapshot!);
    (credentialDrift.sources[0]!.metadata!.operations!.render!.urls as string[])[0] =
      "https://maps.example/render?%2574oken=TOP-SECRET";
    const error = await connect({
      ...options,
      clientOptions: { fetchFn: vi.fn() },
      cache: { get: () => credentialDrift, set: vi.fn() },
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    expect(JSON.stringify(error)).not.toContain("TOP-SECRET");
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, 3] as const)(
    "rejects cached WMTS executable matrix width %s",
    async (matrixWidth) => {
      let snapshot: ConnectDiscoverySnapshot | undefined;
      const options = {
        endpoint: "https://tiles.example/ogc/wmts",
        protocol: "wmts" as const,
        typeName: "imagery",
        authorizationScopeFingerprint: "anonymous",
      };
      await connect({
        ...options,
        clientOptions: { fetchFn: capabilitiesFetch(WMTS_CAPABILITIES) },
        cache: {
          get: () => undefined,
          set: (_identity, value) => {
            snapshot = value;
          },
        },
      });
      const tampered = structuredClone(snapshot!);
      (
        tampered.sources[0]!.metadata!.tileMatrixSets![0]!.matrices[1]! as {
          matrixWidth: number;
        }
      ).matrixWidth = matrixWidth;

      await expect(
        connect({
          ...options,
          clientOptions: { fetchFn: vi.fn() },
          cache: { get: () => tampered, set: vi.fn() },
        }),
      ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    },
  );

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

  it.each([
    ["CDATA outside the document root", `<![CDATA[TOP-SECRET]]>${WMS_CAPABILITIES}`],
    ["a multi-colon element QName", WMS_CAPABILITIES.replace("<WMS_Capabilities", "<bad:WMS:Capabilities")],
    ["a multi-colon attribute QName", WMS_CAPABILITIES.replace('version="1.3.0"', 'bad:version:name="1.3.0"')],
  ])("maps hostile capabilities XML with %s to a redacted discovery error", async (_name, body) => {
    const error = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(body) },
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(JSON.stringify(error)).not.toContain("TOP-SECRET");
  });
});

// ── Capabilities-driven GetFeatureInfo on third-party WMS (#952) ────────────

const FEATURE_INFO_FORMATS = "<Format>application/geo+json</Format>\n        <Format>text/plain</Format>";

const GEOJSON_FEATURE_INFO = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-157.9, 21.3] },
      properties: { PARCEL_ID: "TMK-1-2-3", ACRES: 0.42 },
    },
  ],
});

const GML_FEATURE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml" xmlns:pub="https://maps.example/public">
  <gml:featureMember>
    <pub:parcels fid="parcels.42">
      <gml:boundedBy><gml:Box><gml:coordinates>-157.91,21.29 -157.89,21.31</gml:coordinates></gml:Box></gml:boundedBy>
      <pub:PARCEL_ID>TMK-1-2-3</pub:PARCEL_ID>
      <pub:ACRES>0.42</pub:ACRES>
      <pub:the_geom><gml:Point><gml:coordinates>-157.9,21.3</gml:coordinates></gml:Point></pub:the_geom>
    </pub:parcels>
  </gml:featureMember>
</wfs:FeatureCollection>`;

const MAPSERVER_GML_FEATURE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<msGMLOutput xmlns:gml="http://www.opengis.net/gml">
  <parcels_layer>
    <gml:name>parcels</gml:name>
    <parcels_feature>
      <PARCEL_ID>TMK-9-9-9</PARCEL_ID>
    </parcels_feature>
  </parcels_layer>
</msGMLOutput>`;

/**
 * Serve the capabilities document for `GetCapabilities` and delegate every
 * other request (the GetFeatureInfo lane) to `respond`, recording it.
 */
function featureInfoFetch(
  capabilities: string,
  requests: Request[],
  respond: (request: Request) => Response,
): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).searchParams.get("REQUEST") === "GetCapabilities") {
      return xml(capabilities, { ETag: '"capabilities-v1"' });
    }
    requests.push(request);
    return respond(request);
  }) as unknown as typeof fetch;
}

function body(payload: string, contentType: string): Response {
  return new Response(payload, { status: 200, headers: { "Content-Type": contentType } });
}

function numericBbox(url: URL): number[] {
  return url.searchParams.get("BBOX")!.split(",").map(Number);
}

describe("connect() — capabilities-driven WMS GetFeatureInfo", () => {
  it("queries a third-party WMS through the advertised GetFeatureInfo URL and decodes GeoJSON", async () => {
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        apiKey: "test-key",
        fetchFn: featureInfoFetch(WMS_CAPABILITIES, requests, () => body(GEOJSON_FEATURE_INFO, "application/geo+json")),
      },
    });
    const source = connection.source();

    expect(source.descriptor.locator.serviceId).toBeUndefined();
    expect(source.capabilities.has("query")).toBe(true);
    expect(source.descriptor.locator.featureInfo).toEqual({
      kind: "wms-kvp",
      url: "https://maps.example/ogc/feature-info?tenant=public",
      format: "application/geo+json",
      crs: ["EPSG:4326", "EPSG:3857", "CRS:84"],
    });

    const result = await source.query({ spatialFilter: point(-157.9, 21.3), pagination: { limit: 5 } });

    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://maps.example/ogc/feature-info");
    expect(requests[0]!.headers.get("x-api-key")).toBe("test-key");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      // Vendor query state advertised on the operation URL survives.
      tenant: "public",
      SERVICE: "WMS",
      VERSION: "1.3.0",
      REQUEST: "GetFeatureInfo",
      LAYERS: "parcels",
      QUERY_LAYERS: "parcels",
      CRS: "CRS:84",
      WIDTH: "1",
      HEIGHT: "1",
      I: "0",
      J: "0",
      INFO_FORMAT: "application/geo+json",
      FEATURE_COUNT: "5",
    });
    const bbox = numericBbox(url);
    // CRS:84 is longitude/latitude, so the canonical envelope is not transposed.
    expect(bbox[0]).toBeCloseTo(-157.9001, 9);
    expect(bbox[1]).toBeCloseTo(21.2999, 9);
    expect(bbox[2]).toBeCloseTo(-157.8999, 9);
    expect(bbox[3]).toBeCloseTo(21.3001, 9);
    expect(result.exceededTransferLimit).toBe(false);
    expect(result.features).toEqual([
      {
        attributes: { PARCEL_ID: "TMK-1-2-3", ACRES: 0.42 },
        geometry: { type: "Point", coordinates: [-157.9, 21.3] },
      },
    ]);
  });

  it("falls back to an advertised GML format when the endpoint offers no JSON output", async () => {
    const gmlOnly = WMS_CAPABILITIES.replace(
      FEATURE_INFO_FORMATS,
      "<Format>text/plain</Format>\n        <Format>application/vnd.ogc.gml</Format>",
    );
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: featureInfoFetch(gmlOnly, requests, () => body(GML_FEATURE_INFO, "application/vnd.ogc.gml")),
      },
    });
    const source = connection.source();

    expect(source.capabilities.has("query")).toBe(true);
    expect(source.descriptor.locator.featureInfo?.format).toBe("application/vnd.ogc.gml");

    const result = await source.query({ spatialFilter: point(-157.9, 21.3) });

    expect(new URL(requests[0]!.url).searchParams.get("INFO_FORMAT")).toBe("application/vnd.ogc.gml");
    // Leaf property elements become attributes; gml:boundedBy and the complex
    // geometry property are skipped rather than flattened.
    expect(result.features).toEqual([{ attributes: { PARCEL_ID: "TMK-1-2-3", ACRES: "0.42" }, geometry: null }]);
  });

  it("decodes the MapServer msGMLOutput feature container", async () => {
    const gmlOnly = WMS_CAPABILITIES.replace(
      FEATURE_INFO_FORMATS,
      "<Format>text/plain</Format>\n        <Format>application/vnd.ogc.gml</Format>",
    );
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: featureInfoFetch(gmlOnly, requests, () => body(MAPSERVER_GML_FEATURE_INFO, "application/vnd.ogc.gml")),
      },
    });

    const result = await connection.source().query({ spatialFilter: point(-157.9, 21.3) });

    expect(result.features).toEqual([{ attributes: { PARCEL_ID: "TMK-9-9-9" }, geometry: null }]);
  });

  it("transposes the point envelope for an axis-order-sensitive advertised CRS", async () => {
    const latLonOnly = WMS_CAPABILITIES.replace("      <CRS>CRS:84</CRS>\n", "");
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: featureInfoFetch(latLonOnly, requests, () => body(GEOJSON_FEATURE_INFO, "application/geo+json")),
      },
    });
    const source = connection.source();

    expect(source.descriptor.locator.featureInfo?.crs).toEqual(["EPSG:4326", "EPSG:3857"]);

    // No spatial reference on the geometry: the canonical (lon, lat) point is
    // satisfied by the advertised EPSG:4326 spelling, whose WMS 1.3 axis order
    // is latitude/longitude on the wire.
    await source.query({ spatialFilter: point(-157.9, 21.3) });
    const latLon = new URL(requests[0]!.url);
    expect(latLon.searchParams.get("CRS")).toBe("EPSG:4326");
    const transposed = numericBbox(latLon);
    expect(transposed[0]).toBeCloseTo(21.2999, 9);
    expect(transposed[1]).toBeCloseTo(-157.9001, 9);
    expect(transposed[2]).toBeCloseTo(21.3001, 9);
    expect(transposed[3]).toBeCloseTo(-157.8999, 9);

    // An explicitly stamped projected CRS the layer advertises stays in x/y.
    await source.query({ spatialFilter: point(-17580000, 2430000, { wkid: 3857 }) });
    const webMercator = new URL(requests[1]!.url);
    expect(webMercator.searchParams.get("CRS")).toBe("EPSG:3857");
    expect(numericBbox(webMercator)[0]).toBeCloseTo(-17580000.0001, 4);

    // A CRS the layer never advertised fails closed instead of guessing.
    await expect(source.query({ spatialFilter: point(300000, 100000, { wkid: 27700 }) })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(requests).toHaveLength(2);
  });

  it("keeps query disabled for a non-queryable layer without issuing a request", async () => {
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "imagery",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: featureInfoFetch(WMS_CAPABILITIES, requests, () => body(GEOJSON_FEATURE_INFO, "application/geo+json")),
      },
    });
    const source = connection.source();

    expect(source.capabilities.has("query")).toBe(false);
    expect(source.descriptor.locator.featureInfo).toBeUndefined();
    expect(connection.inspection.sources[0]?.metadata?.operations?.featureInfo).toMatchObject({
      available: false,
      reason: "The WMS layer is not queryable.",
    });
    await expect(source.query({ spatialFilter: point(-157.9, 21.3) })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(requests).toHaveLength(0);
  });

  it("keeps query disabled when only unstructured info formats are advertised", async () => {
    const unstructured = WMS_CAPABILITIES.replace(
      FEATURE_INFO_FORMATS,
      "<Format>text/plain</Format>\n        <Format>text/html</Format>",
    );
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: featureInfoFetch(unstructured, requests, () => body("Results for 'parcels'", "text/plain")),
      },
    });
    const source = connection.source();

    expect(source.capabilities.has("query")).toBe(false);
    expect(source.descriptor.locator.featureInfo).toBeUndefined();
    expect(connection.inspection.sources[0]?.metadata?.operations?.featureInfo).toMatchObject({
      available: false,
      reason: "WMS GetFeatureInfo advertises no supported GeoJSON, JSON, or GML feature format.",
    });
    await expect(source.query({ spatialFilter: point(-157.9, 21.3) })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(requests).toHaveLength(0);
  });

  it("keeps query disabled when GetFeatureInfo advertises no safe same-origin GET URL", async () => {
    const crossOrigin = WMS_CAPABILITIES.replace(
      '<GetFeatureInfo>\n        <Format>application/geo+json</Format>\n        <Format>text/plain</Format>\n        <DCPType><HTTP><Get><OnlineResource xlink:href="./feature-info?tenant=public"/></Get></HTTP></DCPType>',
      '<GetFeatureInfo>\n        <Format>application/geo+json</Format>\n        <Format>text/plain</Format>\n        <DCPType><HTTP><Get><OnlineResource xlink:href="https://elsewhere.example/feature-info"/></Get></HTTP></DCPType>',
    );
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: capabilitiesFetch(crossOrigin) },
    });
    const source = connection.source();

    expect(source.capabilities.has("query")).toBe(false);
    expect(source.descriptor.locator.featureInfo).toBeUndefined();
    expect(connection.inspection.sources[0]?.metadata?.operations?.featureInfo).toMatchObject({
      available: false,
      reason: "WMS GetFeatureInfo did not advertise a safe GET URL.",
    });
  });

  it("fails closed when GetFeatureInfo answers with an exception report instead of features", async () => {
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://maps.example/ogc/wms",
      protocol: "wms",
      typeName: "parcels",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: featureInfoFetch(WMS_CAPABILITIES, requests, () =>
          body(
            '<?xml version="1.0"?><ServiceExceptionReport><ServiceException code="LayerNotQueryable"/></ServiceExceptionReport>',
            "application/vnd.ogc.se_xml",
          ),
        ),
      },
    });

    await expect(connection.source().query({ spatialFilter: point(-157.9, 21.3) })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(requests).toHaveLength(1);
  });

  it("replays a cached WMS feature-info binding and rejects tampered cached bindings", async () => {
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

    const replay = await connect({
      ...options,
      clientOptions: { fetchFn: vi.fn() },
      cache: { get: () => snapshot, set: vi.fn() },
    });
    expect(replay.inspection.cacheStatus).toBe("hit");
    expect(replay.source().descriptor.locator.featureInfo?.url).toBe(
      "https://maps.example/ogc/feature-info?tenant=public",
    );
    expect(Object.isFrozen(replay.source().descriptor.locator.featureInfo)).toBe(true);

    const tampered = structuredClone(snapshot!);
    (tampered.sources[0]!.locator.featureInfo as { url: string }).url = "https://maps.example/ogc/not-advertised";
    await expect(
      connect({
        ...options,
        clientOptions: { fetchFn: vi.fn() },
        cache: { get: () => tampered, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });

    const unprojectable = structuredClone(snapshot!);
    (unprojectable.sources[0]!.locator.featureInfo as { format: string }).format = "text/plain";
    await expect(
      connect({
        ...options,
        clientOptions: { fetchFn: vi.fn() },
        cache: { get: () => unprojectable, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
  });
});
