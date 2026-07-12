import { describe, expect, it, vi } from "vitest";

import { type ConnectDiscoverySnapshot, connect } from "../src/connect.js";
import { HonuaAbortError } from "../src/core/errors.js";
import type { HonuaOgcCollectionMap } from "../src/core/ogc-maps.js";

const mapsLanding = {
  title: "County Map Renderer",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
    { rel: "self", href: "." },
  ],
};
const mapsConformance = {
  conformsTo: [
    "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/collection-map",
    "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/png",
  ],
};
const mapsCollections = {
  collections: [
    {
      id: "counties",
      title: "County Boundaries",
      description: "Renderable county polygons",
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
    },
    { id: "rivers", title: "Rivers" },
  ],
};

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rawMapsFetch(onRequest?: (request: Request) => void): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/maps") return json(mapsLanding, { ETag: '"maps-root-v1"' });
    if (url.pathname === "/maps/conformance") return json(mapsConformance, { ETag: '"maps-conf-v1"' });
    if (url.pathname === "/maps/collections") return json(mapsCollections, { ETag: '"maps-cols-v1"' });
    if (url.pathname === "/maps/collections/counties/map") {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("connect() — raw OGC API Maps discovery", () => {
  it("threads the discovered service root through the Maps adapter and renders a raw map", async () => {
    const requests: string[] = [];
    const fetchFn = rawMapsFetch((request) => requests.push(new URL(request.url).pathname));
    const connection = await connect({
      endpoint: "https://maps.example/maps",
      protocol: "ogc-maps",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    // Three metadata requests against the discovered root — not the facade.
    expect(requests).toEqual(["/maps", "/maps/conformance", "/maps/collections"]);
    expect(connection.inspection.protocol).toBe("ogc-maps");
    expect(connection.inspection.endpoint).toBe("https://maps.example/maps");
    expect(connection.dataset.client.serverBaseUrl).toBe("https://maps.example");
    expect(connection.dataset.sourceIds()).toEqual(["counties", "rivers"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();

    // Capabilities are the intersection of the render-only adapter surface and
    // advertised Maps conformance, never PROTOCOL_DEFAULT_CAPABILITIES by fiat.
    expect([...connection.source("counties").capabilities]).toEqual(["render"]);
    expect(connection.inspection.sources[0]?.discovery).toBe("metadata");
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "https://maps.example/maps/conformance",
          validator: '"maps-conf-v1"',
        }),
      ]),
    );
    expect(connection.source("counties").descriptor.locator).toMatchObject({
      url: "https://maps.example",
      basePath: "/maps",
      collectionId: "counties",
    });

    // The reviewed descriptor exposes the render-only Maps adapter through the
    // typed escape hatch; a render resolves against the raw root's map route —
    // not the Honua `/ogc/maps` facade.
    const maps = connection.source("counties").protocol("ogc-maps") as HonuaOgcCollectionMap;
    const image = await maps.map({ bbox: [-158, 21, -157, 22], width: 256, height: 256, format: "png" });
    expect(image.bytes).toBeInstanceOf(Uint8Array);
    expect(requests.at(-1)).toBe("/maps/collections/counties/map");
    expect(requests.some((path) => path.startsWith("/ogc/maps"))).toBe(false);
  });

  it("discovers no render capability when Maps conformance is absent", async () => {
    const connection = await connect({
      endpoint: "https://maps.example/maps",
      protocol: "ogc-maps",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname === "/maps") return json(mapsLanding);
          if (url.pathname === "/maps/conformance") return json({ conformsTo: [] });
          if (url.pathname === "/maps/collections") return json(mapsCollections);
          return new Response("not found", { status: 404 });
        }),
      },
    });

    expect([...connection.source("counties").capabilities]).toEqual([]);
    expect(connection.inspection.sources[0]?.capabilityDecisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "render", code: "not-advertised" })]),
    );
  });

  it("rejects a Maps service whose landing advertises no collections data link", async () => {
    const requested: string[] = [];
    await expect(
      connect({
        endpoint: "https://maps.example/maps",
        protocol: "ogc-maps",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: vi.fn(async (input, init) => {
            const url = new URL(new Request(input, init).url);
            requested.push(url.pathname);
            if (url.pathname === "/maps") return json({ title: "no data link", links: [{ rel: "self", href: "." }] });
            return json(mapsCollections);
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(requested).toEqual(["/maps"]);
  });

  it("caches raw Maps discovery and reapplies capability policy on hit", async () => {
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache = {
      get: vi.fn((identity: { key: string }) => values.get(identity.key)),
      set: vi.fn((identity: { key: string }, snapshot: ConnectDiscoverySnapshot) => {
        values.set(identity.key, snapshot);
      }),
    };
    const fetchFn = rawMapsFetch();
    const options = {
      endpoint: "https://maps.example/maps",
      protocol: "ogc-maps" as const,
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache,
    };

    const first = await connect(options);
    const hit = await connect(options);

    expect(first.inspection.cacheStatus).toBe("miss");
    expect(hit.inspection.cacheStatus).toBe("hit");
    expect(hit.dataset.sourceIds()).toEqual(["counties", "rivers"]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("cancels raw Maps discovery between the landing and follow-up requests", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const fetchFn = vi.fn(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      requested.push(url.pathname);
      controller.abort();
      if (url.pathname === "/maps") return json(mapsLanding);
      return json(mapsCollections);
    });
    await expect(
      connect({
        endpoint: "https://maps.example/maps",
        protocol: "ogc-maps",
        authorizationScopeFingerprint: "anonymous",
        signal: controller.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(requested).toEqual(["/maps"]);
  });
});
