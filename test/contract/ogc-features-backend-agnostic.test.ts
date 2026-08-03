/**
 * Backend-agnostic OGC API Features. The headline claim: the same typed
 * `Query` runs against a raw pygeoapi collection and the Honua Server facade
 * and produces an identical `Result` shape.
 *
 * The layout is discovered from the landing page's `rel="data"` /
 * `rel="conformance"` links (OGC API - Common); per-collection item paths
 * follow the mandated `{collections}/{collectionId}/items` template. Fixtures
 * are recorded from the live demo servers (see
 * `test/fixtures/backend-agnostic/`); no network is touched here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";
import { honuaFacadeFeaturesLayout, ogcApiFeaturesLayout } from "../../src/core/ogc-endpoint-layout.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/backend-agnostic/", import.meta.url));
function fixture(rel: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${rel}`, "utf8"));
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

interface RouteClientOptions {
  baseUrl: string;
  routes: Array<[string, () => unknown]>;
  onRequest?: (url: URL) => void;
}
function routeClient(options: RouteClientOptions): HonuaClient {
  return new HonuaClient({
    baseUrl: options.baseUrl,
    fetchFn: async (input) => {
      const url = new URL(String(input));
      options.onRequest?.(url);
      for (const [needle, make] of options.routes) {
        if (url.pathname === needle || url.pathname.endsWith(needle)) return jsonResponse(make());
      }
      return new Response("not found", { status: 404 });
    },
  });
}

interface LakeAttrs {
  id: number;
  name: string;
  featureclass: string;
}

describe("ogc-features backend-agnostic / layout resolver", () => {
  it("honua facade layout builds the fixed /ogc/features paths without discovery", () => {
    const layout = honuaFacadeFeaturesLayout();
    expect(layout.mode).toBe("honua-facade");
    expect(layout.landing()).toBe("/ogc/features");
    expect(layout.collections()).toBe("/ogc/features/collections");
    expect(layout.items("lakes")).toBe("/ogc/features/collections/lakes/items");
    expect(layout.item("lakes", "0")).toBe("/ogc/features/collections/lakes/items/0");
  });

  it("ogc-api layout derives item paths from the discovered collections URL", () => {
    const layout = ogcApiFeaturesLayout({
      landingUrl: "https://demo.pygeoapi.io/master",
      collectionsUrl: "https://demo.pygeoapi.io/master/collections",
      conformanceUrl: "https://demo.pygeoapi.io/master/conformance",
    });
    expect(layout.mode).toBe("ogc-api");
    expect(layout.items("lakes")).toBe("https://demo.pygeoapi.io/master/collections/lakes/items");
    expect(layout.collection("lakes")).toBe("https://demo.pygeoapi.io/master/collections/lakes");
  });

  it("discovers the raw pygeoapi layout from the landing page links", async () => {
    const client = routeClient({
      baseUrl: "https://demo.pygeoapi.io/master",
      routes: [["/master", () => fixture("pygeoapi/landing.json")]],
    });
    // resolveOgcFeaturesLayout is the client-level memoized entry point.
    const layout = await client.resolveOgcFeaturesLayout("ogc-api");
    expect(layout.mode).toBe("ogc-api");
    expect(layout.collections()).toBe("https://demo.pygeoapi.io/master/collections");
    expect(layout.conformance()).toBe("https://demo.pygeoapi.io/master/conformance");
    expect(layout.items("lakes")).toBe("https://demo.pygeoapi.io/master/collections/lakes/items");
  });

  it("auto mode falls back to landing-page discovery when the facade probe fails", async () => {
    const client = routeClient({
      baseUrl: "https://demo.pygeoapi.io/master",
      // No /ogc/features route: the facade probe 404s, so discovery runs.
      routes: [["/master", () => fixture("pygeoapi/landing.json")]],
    });
    const resolved = await client.resolveOgcFeaturesLayout("auto");
    expect(resolved.mode).toBe("ogc-api");
    expect(resolved.items("lakes")).toBe("https://demo.pygeoapi.io/master/collections/lakes/items");
  });
});

describe("ogc-features backend-agnostic / identical Result across layouts", () => {
  it("labels canonical where expressions as CQL2 text on the wire", async () => {
    let observed: URL | undefined;
    const client = routeClient({
      baseUrl: "https://facade.honua.test",
      onRequest: (url) => {
        observed = url;
      },
      routes: [["/ogc/features/collections/lakes/items", () => fixture("pygeoapi/items-lakes.json")]],
    });
    const source = createDataset({
      id: "facade",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "lakes",
          protocol: "ogc-features",
          locator: { url: "https://facade.honua.test", collectionId: "lakes" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    }).source("lakes")!;

    await source.query({ where: "featureclass = 'Lake'", pagination: { limit: 3 } });

    expect(observed?.searchParams.get("filter")).toBe("featureclass = 'Lake'");
    expect(observed?.searchParams.get("filter-lang")).toBe("cql2-text");
  });

  function facadeSource() {
    const client = routeClient({
      baseUrl: "https://facade.honua.test",
      routes: [["/ogc/features/collections/lakes/items", () => fixture("pygeoapi/items-lakes.json")]],
    });
    return createDataset({
      id: "facade",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "lakes",
          protocol: "ogc-features",
          locator: { url: "https://facade.honua.test", collectionId: "lakes" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    }).source<LakeAttrs>("lakes")!;
  }

  function rawPygeoapiSource() {
    const client = routeClient({
      baseUrl: "https://demo.pygeoapi.io/master",
      routes: [
        ["/master", () => fixture("pygeoapi/landing.json")],
        ["/master/collections/lakes/items", () => fixture("pygeoapi/items-lakes.json")],
      ],
    });
    return createDataset({
      id: "pygeoapi",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "lakes",
          protocol: "ogc-features",
          locator: { url: "https://demo.pygeoapi.io/master", collectionId: "lakes", layout: "ogc-api" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    }).source<LakeAttrs>("lakes")!;
  }

  it("same typed Query yields an identical Result shape on the facade and raw pygeoapi", async () => {
    const query = { where: "featureclass = 'Lake'", pagination: { limit: 3 } };
    const facadeResult = await facadeSource().query(query);
    const rawResult = await rawPygeoapiSource().query(query);

    expect(rawResult).toEqual(facadeResult);
    expect(rawResult.features).toHaveLength(3);
    expect(rawResult.features[0].attributes.name).toBe("Lake Baikal");
    expect(rawResult.features[0].geometry).not.toBeNull();
    expect(rawResult.totalCount).toBe(25);
  });

  it("raw pygeoapi requests hit the discovered items URL, not the /ogc/features facade", async () => {
    const paths: string[] = [];
    const client = routeClient({
      baseUrl: "https://demo.pygeoapi.io/master",
      onRequest: (url) => paths.push(url.pathname),
      routes: [
        ["/master", () => fixture("pygeoapi/landing.json")],
        ["/master/collections/lakes/items", () => fixture("pygeoapi/items-lakes.json")],
      ],
    });
    const source = createDataset({
      id: "pygeoapi",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "lakes",
          protocol: "ogc-features",
          locator: { url: "https://demo.pygeoapi.io/master", collectionId: "lakes", layout: "ogc-api" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    }).source<LakeAttrs>("lakes")!;
    await source.query({ pagination: { limit: 1 } });
    expect(paths).toContain("/master/collections/lakes/items");
    expect(paths.some((p) => p.includes("/ogc/features"))).toBe(false);
  });
});

describe("ogc-features backend-agnostic / items paging", () => {
  const PAGING_BASE_URL = "https://paging.honua.test";
  const ITEMS_PATH = "/ogc/features/collections/lakes/items";

  function lakeFeature(id: number): Record<string, unknown> {
    return {
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [id, id] },
      properties: { id, name: `Lake ${id}`, featureclass: "Lake" },
    };
  }

  function itemsUrl(params: Record<string, string>): string {
    const url = new URL(`${PAGING_BASE_URL}${ITEMS_PATH}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /** A `Source` over a fixture server, capturing every request URL. */
  function pagingSource(handler: (url: URL) => unknown) {
    const calls: URL[] = [];
    const client = new HonuaClient({
      baseUrl: PAGING_BASE_URL,
      fetchFn: async (input) => {
        const url = new URL(String(input));
        calls.push(url);
        return jsonResponse(handler(url));
      },
    });
    const source = createDataset({
      id: "paging",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "lakes",
          protocol: "ogc-features",
          locator: { url: PAGING_BASE_URL, collectionId: "lakes" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    }).source<LakeAttrs>("lakes")!;
    return { source, calls };
  }

  /**
   * pgstac / pygeoapi-style cursor paging: the page position lives in an
   * opaque `token` the server only ever hands back on its `rel=next` link,
   * and every page is short relative to the requested `limit`.
   *
   * Two details model what these servers actually do:
   * - the `rel=next` link is built by preserving the query string of the
   *   request being answered and appending the token, so it carries a stale
   *   `offset` / `startindex` from the drain's first request;
   * - a start position wins over the token when both arrive, so replaying that
   *   stale offset alongside the cursor silently re-reads the first page.
   */
  function tokenPagingServer(url: URL): unknown {
    const pages: Record<string, { ids: number[]; next?: string }> = {
      "": { ids: [1, 2], next: "page-2" },
      "page-2": { ids: [3, 4], next: "page-3" },
      "page-3": { ids: [5] },
    };
    const positioned = url.searchParams.has("offset") || url.searchParams.has("startindex");
    const token = positioned ? "" : (url.searchParams.get("token") ?? "");
    const page = pages[token];
    if (!page) return { type: "FeatureCollection", features: [] };
    const nextHref = (format: string) =>
      itemsUrl({ f: format, limit: "3", offset: "0", startindex: "0", token: page.next ?? "" });
    return {
      type: "FeatureCollection",
      numberMatched: 5,
      features: page.ids.map(lakeFeature),
      links: page.next
        ? [
            { rel: "self", type: "application/geo+json", href: itemsUrl({ f: "json" }) },
            // The HTML alternate carries the same cursor; the drain must
            // follow the data link, and must not replay `f` / `limit`.
            { rel: "next", type: "text/html", href: nextHref("html") },
            { rel: "next", type: "application/geo+json", href: nextHref("json") },
          ]
        : [{ rel: "self", type: "application/geo+json", href: itemsUrl({ f: "json" }) }],
    };
  }

  it("queryAll follows rel=next cursors on a token-paging server", async () => {
    const { source, calls } = pagingSource(tokenPagingServer);

    const result = await source.queryAll();

    expect(result.features.map((f) => f.attributes.id)).toEqual([1, 2, 3, 4, 5]);
    expect(calls.map((url) => url.searchParams.get("token"))).toEqual([null, "page-2", "page-3"]);
    // The cursor carries the server's own position. Neither the drain's own
    // offset nor the stale `offset` / `startindex` the server echoed onto its
    // next link may ride along: on a server that honors both, that is exactly
    // what re-reads or skips a page.
    expect(calls.slice(1).map((url) => url.searchParams.get("offset"))).toEqual([null, null]);
    expect(calls.slice(1).map((url) => url.searchParams.get("startindex"))).toEqual([null, null]);
    // `f` and `limit` stay the drain's / caller's choice, not the link's.
    expect(calls.map((url) => url.searchParams.get("f"))).toEqual(["json", "json", "json"]);
    expect(calls.map((url) => url.searchParams.get("limit"))).toEqual(["100", "100", "100"]);
  });

  it("stream follows rel=next cursors and yields every page", async () => {
    const { source, calls } = pagingSource(tokenPagingServer);

    const pages: number[][] = [];
    for await (const page of source.stream()) {
      pages.push(page.features.map((f) => f.attributes.id));
    }

    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
    expect(calls).toHaveLength(3);
  });

  it("falls back to offset arithmetic when the server advertises no next link", async () => {
    const data = [1, 2, 3, 4, 5];
    const { source, calls } = pagingSource((url) => {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      return {
        type: "FeatureCollection",
        features: data.slice(offset, offset + limit).map(lakeFeature),
      };
    });

    const pages: number[][] = [];
    for await (const page of source.stream({ pagination: { limit: 2 } })) {
      pages.push(page.features.map((f) => f.attributes.id));
    }

    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
    expect(calls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "2", "4"]);
  });

  it("follows an offset-style next link that advances past a short page", async () => {
    const data = [1, 2, 3, 4, 5];
    const { source, calls } = pagingSource((url) => {
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      // pygeoapi / ldproxy shape: a real `offset` cursor on the link, echoed
      // filters beside it, and pages shorter than the requested `limit`.
      const ids = data.slice(offset, offset + 1);
      const advanced = offset + ids.length;
      return {
        type: "FeatureCollection",
        features: ids.map(lakeFeature),
        links:
          advanced < data.length
            ? [
                {
                  rel: "next",
                  type: "application/geo+json",
                  href: itemsUrl({ f: "json", limit: "2", offset: String(advanced), bbox: "-180,-90,180,90" }),
                },
              ]
            : [],
      };
    });

    const pages: number[][] = [];
    for await (const page of source.stream({ pagination: { limit: 2 } })) {
      pages.push(page.features.map((f) => f.attributes.id));
    }

    expect(pages).toEqual([[1], [2], [3], [4], [5]]);
    expect(calls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("ignores a next link that only echoes the offset just requested", async () => {
    const data = [1, 2, 3, 4, 5];
    const { source, calls } = pagingSource((url) => {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      return {
        type: "FeatureCollection",
        features: data.slice(offset, offset + limit).map(lakeFeature),
        // A next link that never advances: it repeats the offset just sent and
        // otherwise only echoes the query, so following it would re-read the
        // page just returned. Offset arithmetic must stay in charge.
        links: [
          {
            rel: "next",
            type: "application/geo+json",
            href: itemsUrl({ f: "json", limit: String(limit), offset: String(offset), bbox: "-180,-90,180,90" }),
          },
        ],
      };
    });

    const pages: number[][] = [];
    for await (const page of source.stream({ pagination: { limit: 2 } })) {
      pages.push(page.features.map((f) => f.attributes.id));
    }

    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
    expect(calls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "2", "4"]);
  });

  it("stops the drain when the server repeats a page it already returned", async () => {
    const { source, calls } = pagingSource(() => ({
      type: "FeatureCollection",
      features: [1, 2].map(lakeFeature),
      links: [{ rel: "next", type: "application/geo+json", href: itemsUrl({ f: "json", token: "stuck" }) }],
    }));

    const result = await source.queryAll();

    // The repeated page is dropped rather than appended, and the drain stops
    // instead of following the same cursor forever.
    expect(result.features.map((f) => f.attributes.id)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  it("stops the drain when the server repeats a next-link cursor", async () => {
    let call = 0;
    const { source, calls } = pagingSource(() => {
      call += 1;
      return {
        type: "FeatureCollection",
        features: [call * 2 - 1, call * 2].map(lakeFeature),
        links: [{ rel: "next", type: "application/geo+json", href: itemsUrl({ f: "json", token: "stuck" }) }],
      };
    });

    const result = await source.queryAll();

    expect(result.features.map((f) => f.attributes.id)).toEqual([1, 2, 3, 4]);
    expect(calls).toHaveLength(2);
  });
});

describe("ogc-features backend-agnostic / ldproxy raw layout", () => {
  it("discovers the ldproxy layout and queries the discovered items path", async () => {
    const paths: string[] = [];
    const client = routeClient({
      baseUrl: "https://demo.ldproxy.net/vineyards",
      onRequest: (url) => paths.push(url.pathname),
      routes: [
        ["/vineyards", () => fixture("ldproxy/landing.json")],
        ["/vineyards/collections/vineyards/items", () => fixture("ldproxy/items-vineyards.json")],
      ],
    });
    const source = createDataset({
      id: "ldproxy",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "vineyards",
          protocol: "ogc-features",
          locator: { url: "https://demo.ldproxy.net/vineyards", collectionId: "vineyards", layout: "ogc-api" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    }).source("vineyards")!;
    const result = await source.query({ pagination: { limit: 2 } });
    expect(result.features.length).toBeGreaterThan(0);
    expect(paths).toContain("/vineyards/collections/vineyards/items");
  });
});
