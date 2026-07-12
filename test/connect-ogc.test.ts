import { describe, expect, it, vi } from "vitest";

import { type ConnectDiscoverySnapshot, connect } from "../src/connect.js";
import { HonuaAbortError } from "../src/core/errors.js";

const recordsLanding = {
  title: "Public Safety Catalog",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
    { rel: "self", href: "." },
  ],
};
const recordsConformance = {
  conformsTo: [
    "http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/records-api",
    "http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/record-core-query-parameters",
    "http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/json",
  ],
};
const recordsCollections = {
  collections: [
    {
      id: "incidents",
      title: "Incident Records",
      description: "Public-safety incident catalog",
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
    },
    { id: "facilities", title: "Facility Records" },
  ],
};

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rawRecordsFetch(onRequest?: (request: Request) => void): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/catalog") return json(recordsLanding, { ETag: '"records-root-v1"' });
    if (url.pathname === "/catalog/conformance") return json(recordsConformance, { ETag: '"records-conf-v1"' });
    if (url.pathname === "/catalog/collections") return json(recordsCollections, { ETag: '"records-cols-v1"' });
    if (url.pathname === "/catalog/collections/incidents/items") {
      return json({ type: "FeatureCollection", features: [], numberMatched: 0, links: [] });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("connect() — raw OGC API Records discovery", () => {
  it("threads the discovered service root through the Records adapter and round-trips a catalog search", async () => {
    const requests: string[] = [];
    const fetchFn = rawRecordsFetch((request) => requests.push(new URL(request.url).pathname));
    const connection = await connect({
      endpoint: "https://catalog.example/catalog",
      protocol: "ogc-records",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    // Three metadata requests against the discovered root — not the facade.
    expect(requests).toEqual(["/catalog", "/catalog/conformance", "/catalog/collections"]);
    expect(connection.inspection.protocol).toBe("ogc-records");
    expect(connection.inspection.endpoint).toBe("https://catalog.example/catalog");
    expect(connection.dataset.client.serverBaseUrl).toBe("https://catalog.example");
    expect(connection.dataset.sourceIds()).toEqual(["incidents", "facilities"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();

    // Capabilities are the intersection of the adapter surface and advertised
    // Records conformance, never PROTOCOL_DEFAULT_CAPABILITIES by fiat.
    expect([...connection.source("incidents").capabilities]).toEqual(["query", "queryObjectIds"]);
    expect(connection.inspection.sources[0]?.discovery).toBe("metadata");
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "https://catalog.example/catalog/conformance",
          validator: '"records-conf-v1"',
        }),
      ]),
    );
    expect(connection.inspection.sources[0]?.metadata?.crs).toEqual(["http://www.opengis.net/def/crs/OGC/1.3/CRS84"]);
    expect(connection.source("incidents").descriptor.locator).toMatchObject({
      url: "https://catalog.example",
      basePath: "/catalog",
      collectionId: "incidents",
    });

    // The reviewed descriptor executes a real catalog search against the raw
    // root's items path — not the Honua `/ogc/records` facade.
    const result = await connection.source("incidents").query({ pagination: { limit: 5 } });
    expect(result.features).toEqual([]);
    expect(requests.at(-1)).toBe("/catalog/collections/incidents/items");
    expect(requests.some((path) => path.startsWith("/ogc/records"))).toBe(false);
  });

  it("fails query and object-id capabilities closed when Records conformance is absent", async () => {
    const connection = await connect({
      endpoint: "https://catalog.example/catalog",
      protocol: "ogc-records",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname === "/catalog") return json(recordsLanding);
          if (url.pathname === "/catalog/conformance") return json({ conformsTo: [] });
          if (url.pathname === "/catalog/collections") return json(recordsCollections);
          return new Response("not found", { status: 404 });
        }),
      },
    });

    expect([...connection.source("incidents").capabilities]).toEqual([]);
    expect(connection.inspection.sources[0]?.capabilityDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "query", code: "not-advertised" }),
        expect.objectContaining({ capability: "queryObjectIds", code: "not-advertised" }),
      ]),
    );
  });

  it("rejects a Records service whose landing advertises no collections data link", async () => {
    const requested: string[] = [];
    await expect(
      connect({
        endpoint: "https://catalog.example/catalog",
        protocol: "ogc-records",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: vi.fn(async (input, init) => {
            const url = new URL(new Request(input, init).url);
            requested.push(url.pathname);
            if (url.pathname === "/catalog")
              return json({ title: "no data link", links: [{ rel: "self", href: "." }] });
            return json(recordsCollections);
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    // Only the landing was fetched before rejecting.
    expect(requested).toEqual(["/catalog"]);
  });

  it("caches raw Records discovery and reapplies capability policy on hit", async () => {
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache = {
      get: vi.fn((identity: { key: string }) => values.get(identity.key)),
      set: vi.fn((identity: { key: string }, snapshot: ConnectDiscoverySnapshot) => {
        values.set(identity.key, snapshot);
      }),
    };
    const fetchFn = rawRecordsFetch();
    const options = {
      endpoint: "https://catalog.example/catalog",
      protocol: "ogc-records" as const,
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache,
    };

    const first = await connect(options);
    const hit = await connect(options);

    expect(first.inspection.cacheStatus).toBe("miss");
    expect(hit.inspection.cacheStatus).toBe("hit");
    expect(hit.dataset.sourceIds()).toEqual(["incidents", "facilities"]);
    // Only the first connect() performed the three metadata requests.
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("cancels raw Records discovery between the landing and follow-up requests", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const fetchFn = vi.fn(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      requested.push(url.pathname);
      controller.abort();
      if (url.pathname === "/catalog") return json(recordsLanding);
      return json(recordsCollections);
    });
    await expect(
      connect({
        endpoint: "https://catalog.example/catalog",
        protocol: "ogc-records",
        authorizationScopeFingerprint: "anonymous",
        signal: controller.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(requested).toEqual(["/catalog"]);
  });
});
