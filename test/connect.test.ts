import { describe, expect, it, vi } from "vitest";

import {
  type ConnectDiscoveryCache,
  type ConnectDiscoverySnapshot,
  HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
  connect,
} from "../src/connect.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaAbortError } from "../src/core/errors.js";

const landing = {
  title: "Test API",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
  ],
};
const conformance = {
  conformsTo: [
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/create-replace-delete",
  ],
};
const collections = {
  collections: [
    { id: "parcels", title: "Parcels", crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"] },
    { id: "roads", title: "Roads" },
  ],
};

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function discoveryFetch(onRequest?: (request: Request) => void): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/api") return json(landing, { ETag: '"landing-v1"' });
    if (url.pathname === "/api/conformance") return json(conformance, { ETag: '"conf-v1"' });
    if (url.pathname === "/api/collections") return json(collections, { ETag: '"collections-v1"' });
    return new Response("not found", { status: 404 });
  });
}

describe("connect", () => {
  it("discovers reviewed OGC Features descriptors without inventing adapter defaults", async () => {
    const fetchFn = discoveryFetch();
    const connection = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(connection.dataset.sourceIds()).toEqual(["parcels", "roads"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();
    expect([...connection.inspection.sources[0]!.descriptor.capabilities]).toEqual([
      "query",
      "queryObjectIds",
      "applyEdits",
    ]);
    expect(connection.inspection.sources[0]?.descriptor.capabilities.has("stream")).toBe(false);
    expect(connection.inspection.sources[0]?.discovery).toBe("metadata");
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ validator: '"conf-v1"' })]),
    );
    expect(() => connection.source()).toThrowError(
      expect.objectContaining({ name: "HonuaDiscoveryError", code: "ambiguous-source" }),
    );
    expect(connection.source("parcels").descriptor.locator.layout).toBe("ogc-api");
  });

  it("restricts discovery to an explicitly selected collection", async () => {
    const connection = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      collectionId: "roads",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: discoveryFetch() },
    });

    expect(connection.inspection.defaultSourceId).toBe("roads");
    expect(connection.source().descriptor.id).toBe("roads");
    expect(connection.dataset.sourceIds()).toEqual(["roads"]);
  });

  it("auto-detects canonical FeatureServer URLs and projects layer metadata truth", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/arcgis/rest/services/Public/Parcels/FeatureServer") {
        return json({
          capabilities: "Query,Create,Update,Delete",
          layers: [{ id: 0, name: "Parcels" }],
          tables: [{ id: 3, name: "Owners" }],
        });
      }
      if (url.pathname.endsWith("/FeatureServer/0")) {
        return json(
          {
            id: 0,
            name: "Parcels",
            capabilities: "Query,Create,Update,Delete",
            supportsAttachments: true,
            supportsStatistics: true,
            useStandardizedQueries: true,
            supportedQueryFormats: "JSON, geoJSON, PBF",
            relationships: [{ id: 1, relatedTableId: 3 }],
            fields: [
              { name: "OBJECTID", type: "esriFieldTypeOID" },
              { name: "STATUS", type: "esriFieldTypeString" },
            ],
          },
          { ETag: '"parcels-v2"' },
        );
      }
      if (url.pathname.endsWith("/FeatureServer/3")) {
        return json({ id: 3, name: "Owners", capabilities: "Query", fields: [] });
      }
      return new Response("not found", { status: 404 });
    });

    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Public/Parcels/FeatureServer?f=pjson",
      protocol: "auto",
      authorizationScopeFingerprint: "role:viewer:v1",
      clientOptions: { fetchFn },
    });

    expect(connection.inspection.protocol).toBe("geoservices-feature-service");
    expect(connection.inspection.endpoint).toBe(
      "https://example.test/arcgis/rest/services/Public/Parcels/FeatureServer",
    );
    expect(connection.dataset.client.serverBaseUrl).toBe("https://example.test/arcgis");
    expect(connection.dataset.sourceIds()).toEqual(["0", "3"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();
    expect(connection.inspection.sources[0]?.descriptor).toMatchObject({
      id: "0",
      protocol: "geoservices-feature-service",
      locator: {
        url: "https://example.test/arcgis",
        serviceId: "Public/Parcels",
        layerId: 0,
      },
      schema: { primaryKey: "OBJECTID" },
    });
    expect([...connection.inspection.sources[0]!.descriptor.capabilities]).toEqual(
      expect.arrayContaining([
        "query",
        "queryAggregate",
        "queryExtent",
        "queryObjectIds",
        "queryRelated",
        "applyEdits",
        "attachments",
        "sql",
        "stream",
        "pbf",
      ]),
    );
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ validator: '"parcels-v2"' })]),
    );
    expect(requests).toHaveLength(3);
  });

  it("auto-detects a selected MapServer layer without probing other protocols", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.pathname);
      return json({ id: 2, name: "Cities", capabilities: "Map,Query", fields: [] });
    });
    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Maps/Cities/MapServer/2",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(requests).toEqual(["/arcgis/rest/services/Maps/Cities/MapServer/2"]);
    expect(connection.inspection.protocol).toBe("geoservices-map-service");
    expect(connection.inspection.defaultSourceId).toBe("2");
    expect([...connection.source().capabilities]).toEqual(
      expect.arrayContaining(["query", "queryExtent", "queryObjectIds", "render", "stream"]),
    );
    expect(connection.source().capabilities.has("tiles")).toBe(false);
  });

  it("combines MapServer service tile-cache truth with layer capability metadata", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/MapServer")) {
        return json({
          capabilities: "Map,Query",
          singleFusedMapCache: true,
          layers: [{ id: 2, name: "Cities" }],
        });
      }
      return json({ id: 2, name: "Cities", capabilities: "Map,Query", fields: [] });
    });
    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Maps/Cities/MapServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.source().capabilities.has("render")).toBe(true);
    expect(connection.source().capabilities.has("tiles")).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not substitute adapter defaults when GeoServices capability metadata is absent", async () => {
    const connection = await connect({
      endpoint: "https://example.test/rest/services/Parcels/FeatureServer/0",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: vi.fn(async () => json({ id: 0, name: "Parcels", fields: [] })) },
    });

    expect([...connection.source().capabilities]).toEqual([]);
    expect(connection.inspection.sources[0]?.discovery).toBe("unavailable");
    expect(connection.inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "discovery-unavailable" }),
    );
  });

  it("rejects mismatched GeoServices hints before auth, fetch, or cache hooks", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const auth = vi.fn(async () => "secret");
    const get = vi.fn();
    await expect(
      connect({
        endpoint: "https://example.test/rest/services/Parcels/FeatureServer",
        protocol: "geoservices-map-service",
        authorizationScopeFingerprint: "scope-a",
        clientOptions: { fetchFn, auth },
        cache: { get, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("retains service-level truth and diagnostics when optional layer metadata fails", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/FeatureServer")) {
        return json({ capabilities: "Query", layers: [{ id: 7, name: "Roads" }] });
      }
      return new Response("temporarily unavailable", { status: 503 });
    });
    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Roads/FeatureServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.source().capabilities.has("query")).toBe(true);
    expect(connection.source().capabilities.has("applyEdits")).toBe(false);
    expect(connection.inspection.sources[0]?.discovery).toBe("mixed");
    expect(connection.inspection.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["discovery-unavailable", "partial-discovery"]),
    );
  });

  it("bounds service-root layer metadata discovery to four concurrent requests", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/FeatureServer")) {
        return json({
          capabilities: "Query",
          layers: Array.from({ length: 6 }, (_, id) => ({ id, name: `Layer ${id}` })),
        });
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active -= 1;
      const id = Number.parseInt(url.pathname.split("/").at(-1) ?? "", 10);
      return json({ id, name: `Layer ${id}`, capabilities: "Query", fields: [] });
    });

    const connection = await connect({
      endpoint: "https://example.test/rest/services/Many/FeatureServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.dataset.sourceIds()).toHaveLength(6);
    expect(maxActive).toBe(4);
  });

  it("rejects ambiguous auto and unsupported protocols before auth, fetch, or cache hooks run", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const auth = vi.fn(async () => "secret");
    const get = vi.fn();
    const set = vi.fn();
    const base = {
      endpoint: "https://example.test/api",
      authorizationScopeFingerprint: "scope-a",
      clientOptions: { fetchFn, auth },
      cache: { get, set },
    };

    await expect(connect({ ...base, protocol: "auto" })).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "ambiguous-protocol",
    });
    await expect(connect({ ...base, protocol: "wfs" })).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "unsupported-protocol",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("keys caller cache hooks by auth scope and reapplies policy on cache hits", async () => {
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache: ConnectDiscoveryCache = {
      get: vi.fn((identity) => values.get(identity.key)),
      set: vi.fn((identity, snapshot) => {
        values.set(identity.key, snapshot);
      }),
    };
    const fetchFn = discoveryFetch();
    const first = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      collectionId: "parcels",
      authorizationScopeFingerprint: "role:viewer:v1",
      clientOptions: { fetchFn },
      cache,
    });
    const hit = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      collectionId: "parcels",
      authorizationScopeFingerprint: "role:viewer:v1",
      clientOptions: { fetchFn },
      capabilityPolicy: { deny: ["applyEdits"] },
      cache,
    });
    const anotherScope = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      collectionId: "parcels",
      authorizationScopeFingerprint: "role:editor:v1",
      clientOptions: { fetchFn },
      cache,
    });

    expect(first.inspection.cacheIdentity.endpoint).toBe("https://example.test/api");
    expect(hit.inspection.cacheStatus).toBe("hit");
    expect(hit.source().capabilities.has("applyEdits")).toBe(false);
    expect(anotherScope.inspection.cacheStatus).toBe("miss");
    expect(first.inspection.cacheIdentity.key).not.toBe(anotherScope.inspection.cacheIdentity.key);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("skips cache reads on refresh and forwards refresh semantics to metadata requests", async () => {
    const requestHeaders: Headers[] = [];
    const cache: ConnectDiscoveryCache = { get: vi.fn(), set: vi.fn() };
    const result = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      refresh: true,
      cache,
      clientOptions: { fetchFn: discoveryFetch((request) => requestHeaders.push(request.headers)) },
    });

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledOnce();
    expect(result.inspection.cacheStatus).toBe("refreshed");
    expect(requestHeaders.every((headers) => headers.get("cache-control") === "no-cache")).toBe(true);
  });

  it("honors cancellation before network and after asynchronous cache hooks", async () => {
    const fetchFn = discoveryFetch();
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        signal: preAborted.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();

    const duringCache = new AbortController();
    const cache: ConnectDiscoveryCache = {
      get: async () => {
        duringCache.abort();
        return undefined;
      },
      set: vi.fn(),
    };
    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        signal: duringCache.signal,
        clientOptions: { fetchFn },
        cache,
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects query-bearing endpoints and mismatched injected clients before hooks or network", async () => {
    const fetchFn = discoveryFetch();
    const cache: ConnectDiscoveryCache = { get: vi.fn(), set: vi.fn() };
    await expect(
      connect({
        endpoint: "https://example.test/api?tenant=a",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache,
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });

    const client = new HonuaClient({ baseUrl: "https://example.test/another-api", fetchFn });
    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        client,
        cache,
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("settles cancellation when a caller cache hook ignores its signal", async () => {
    const controller = new AbortController();
    const fetchFn = discoveryFetch();
    const pending = connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      signal: controller.signal,
      clientOptions: { fetchFn },
      cache: { get: () => new Promise<ConnectDiscoverySnapshot | undefined>(() => {}), set: vi.fn() },
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects stale or cross-identity cache values without touching the network", async () => {
    const fetchFn = discoveryFetch();
    const cache: ConnectDiscoveryCache = {
      get: () =>
        ({
          version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
          identityKey: "another-identity",
          endpoint: "https://example.test/api",
          protocol: "ogc-features",
          retrievedAt: new Date().toISOString(),
          evidence: [{ kind: "metadata", capabilities: ["query"] }],
          sources: [
            {
              id: "parcels",
              locator: { url: "https://example.test/api", collectionId: "parcels", layout: "ogc-api" },
            },
          ],
        }) satisfies ConnectDiscoverySnapshot,
      set: vi.fn(),
    };

    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache,
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not follow cross-origin advertised metadata links with configured credentials", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      if (url.pathname === "/api") {
        return json({
          links: [
            { rel: "data", href: "https://attacker.test/collections" },
            { rel: "conformance", href: "https://attacker.test/conformance" },
          ],
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "user-a",
        clientOptions: { apiKey: "secret", fetchFn },
      }),
    ).rejects.toThrow("Cross-origin request URL is not allowed");
    expect(requests).toEqual(["https://example.test/api?f=json"]);
  });

  it("normalizes advertised format queries before metadata wire parameters are added", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      if (url.pathname === "/api") {
        return json({
          links: [
            { rel: "data", href: "./collections?f=json" },
            { rel: "conformance", href: "./conformance?format=json" },
          ],
        });
      }
      if (url.pathname === "/api/conformance") return json(conformance);
      if (url.pathname === "/api/collections") return json(collections);
      return new Response("unexpected", { status: 500 });
    });

    await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });
    expect(requests).toHaveLength(3);
    expect(requests).toEqual(
      expect.arrayContaining([
        "https://example.test/api?f=json",
        "https://example.test/api/conformance?f=json",
        "https://example.test/api/collections?f=json",
      ]),
    );
  });
});
