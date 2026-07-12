import { describe, expect, it, vi } from "vitest";

import { type ConnectDiscoverySnapshot, connect } from "../src/connect.js";
import { HonuaAbortError } from "../src/core/errors.js";
import type { HonuaOgcTiles } from "../src/core/ogc-tiles.js";

const tilesLanding = {
  title: "City Basemap Tiles",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
    { rel: "self", href: "." },
  ],
};
const tilesConformance = {
  conformsTo: [
    "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/tileset",
    "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/mvt",
  ],
};
const tilesCollections = {
  collections: [
    {
      id: "buildings",
      title: "Building Footprints",
      description: "Vector building tiles",
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
    },
    { id: "roads", title: "Road Network" },
  ],
};

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rawTilesFetch(onRequest?: (request: Request) => void): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/tiles") return json(tilesLanding, { ETag: '"tiles-root-v1"' });
    if (url.pathname === "/tiles/conformance") return json(tilesConformance, { ETag: '"tiles-conf-v1"' });
    if (url.pathname === "/tiles/collections") return json(tilesCollections, { ETag: '"tiles-cols-v1"' });
    if (url.pathname === "/tiles/collections/buildings/tiles/WebMercatorQuad/0/0/0") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/vnd.mapbox-vector-tile" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("connect() — raw OGC API Tiles discovery", () => {
  it("threads the discovered service root through the Tiles adapter and fetches a raw tile", async () => {
    const requests: string[] = [];
    const fetchFn = rawTilesFetch((request) => requests.push(new URL(request.url).pathname));
    const connection = await connect({
      endpoint: "https://tiles.example/tiles",
      protocol: "ogc-tiles",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    // Three metadata requests against the discovered root — not the facade.
    expect(requests).toEqual(["/tiles", "/tiles/conformance", "/tiles/collections"]);
    expect(connection.inspection.protocol).toBe("ogc-tiles");
    expect(connection.inspection.endpoint).toBe("https://tiles.example/tiles");
    expect(connection.dataset.client.serverBaseUrl).toBe("https://tiles.example");
    expect(connection.dataset.sourceIds()).toEqual(["buildings", "roads"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();

    // Capabilities are the intersection of the render-only adapter surface and
    // advertised Tiles conformance, never PROTOCOL_DEFAULT_CAPABILITIES by fiat.
    expect([...connection.source("buildings").capabilities]).toEqual(["render", "tiles"]);
    expect(connection.inspection.sources[0]?.discovery).toBe("metadata");
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "https://tiles.example/tiles/conformance",
          validator: '"tiles-conf-v1"',
        }),
      ]),
    );
    expect(connection.inspection.sources[0]?.metadata?.crs).toEqual(["http://www.opengis.net/def/crs/OGC/1.3/CRS84"]);
    expect(connection.source("buildings").descriptor.locator).toMatchObject({
      url: "https://tiles.example",
      basePath: "/tiles",
      collectionId: "buildings",
    });

    // The reviewed descriptor exposes the render-only Tiles adapter through the
    // typed escape hatch; a tile fetch resolves against the raw root's tile
    // route — not the Honua `/ogc/tiles` facade.
    const tiles = connection.source("buildings").protocol("ogc-tiles") as HonuaOgcTiles;
    const tile = await tiles.tileset("buildings", "WebMercatorQuad").tile({ tileMatrix: 0, tileRow: 0, tileCol: 0 });
    expect(tile.bytes).toBeInstanceOf(Uint8Array);
    expect(requests.at(-1)).toBe("/tiles/collections/buildings/tiles/WebMercatorQuad/0/0/0");
    expect(requests.some((path) => path.startsWith("/ogc/tiles"))).toBe(false);
  });

  it("discovers no render capabilities when Tiles conformance is absent", async () => {
    const connection = await connect({
      endpoint: "https://tiles.example/tiles",
      protocol: "ogc-tiles",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname === "/tiles") return json(tilesLanding);
          if (url.pathname === "/tiles/conformance") return json({ conformsTo: [] });
          if (url.pathname === "/tiles/collections") return json(tilesCollections);
          return new Response("not found", { status: 404 });
        }),
      },
    });

    expect([...connection.source("buildings").capabilities]).toEqual([]);
    expect(connection.inspection.sources[0]?.capabilityDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "render", code: "not-advertised" }),
        expect.objectContaining({ capability: "tiles", code: "not-advertised" }),
      ]),
    );
  });

  it("rejects a Tiles service whose landing advertises no collections data link", async () => {
    const requested: string[] = [];
    await expect(
      connect({
        endpoint: "https://tiles.example/tiles",
        protocol: "ogc-tiles",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: vi.fn(async (input, init) => {
            const url = new URL(new Request(input, init).url);
            requested.push(url.pathname);
            if (url.pathname === "/tiles") return json({ title: "no data link", links: [{ rel: "self", href: "." }] });
            return json(tilesCollections);
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    // Only the landing was fetched before rejecting.
    expect(requested).toEqual(["/tiles"]);
  });

  it("caches raw Tiles discovery and reapplies capability policy on hit", async () => {
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache = {
      get: vi.fn((identity: { key: string }) => values.get(identity.key)),
      set: vi.fn((identity: { key: string }, snapshot: ConnectDiscoverySnapshot) => {
        values.set(identity.key, snapshot);
      }),
    };
    const fetchFn = rawTilesFetch();
    const options = {
      endpoint: "https://tiles.example/tiles",
      protocol: "ogc-tiles" as const,
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache,
    };

    const first = await connect(options);
    const hit = await connect(options);

    expect(first.inspection.cacheStatus).toBe("miss");
    expect(hit.inspection.cacheStatus).toBe("hit");
    expect(hit.dataset.sourceIds()).toEqual(["buildings", "roads"]);
    // Only the first connect() performed the three metadata requests.
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("cancels raw Tiles discovery between the landing and follow-up requests", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const fetchFn = vi.fn(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      requested.push(url.pathname);
      controller.abort();
      if (url.pathname === "/tiles") return json(tilesLanding);
      return json(tilesCollections);
    });
    await expect(
      connect({
        endpoint: "https://tiles.example/tiles",
        protocol: "ogc-tiles",
        authorizationScopeFingerprint: "anonymous",
        signal: controller.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(requested).toEqual(["/tiles"]);
  });
});
