/**
 * Backend-agnostic STAC. The same typed `Source.query()` runs against:
 *
 *  - a raw STAC API root (Earth Search at `.../v1`, `layout: "stac-api"`),
 *    where `/search` is mounted directly under the client baseUrl rather
 *    than behind the Honua `/stac` facade; and
 *  - a static `catalog.json` tree (`layout: "stac-static"`), which has no
 *    search endpoint and is walked via `rel="child"` / `rel="item"` links.
 *
 * Fixtures are recorded from live catalogs (see
 * `test/fixtures/backend-agnostic/`); no network is touched here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";
import { envelope, polygon, spatialContains, spatialIntersects } from "../../src/core/spatial-filter.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/backend-agnostic/", import.meta.url));
function fixture(rel: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${rel}`, "utf8"));
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function routeClient(
  baseUrl: string,
  routes: Array<[string, (url: URL, init: RequestInit | undefined) => unknown]>,
  onRequest?: (u: URL, init: RequestInit | undefined) => void,
): HonuaClient {
  return new HonuaClient({
    baseUrl,
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      onRequest?.(url, init);
      for (const [needle, make] of routes) {
        if (url.pathname === needle || url.pathname.endsWith(needle)) {
          const produced = make(url, init);
          return produced instanceof Response ? produced : jsonResponse(produced);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
}

describe("stac backend-agnostic / raw STAC API root (earth-search)", () => {
  it("queries /search directly under the API root (no /stac facade prefix)", async () => {
    const paths: string[] = [];
    const client = routeClient(
      "https://earth-search.aws.element84.com/v1",
      [["/v1/search", () => fixture("earth-search-stac/search.json")]],
      (u) => paths.push(u.pathname),
    );
    const source = createDataset({
      id: "es",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel",
          protocol: "stac",
          locator: {
            url: "https://earth-search.aws.element84.com/v1",
            collectionId: "sentinel-2-l2a",
            layout: "stac-api",
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source("sentinel")!;
    const result = await source.query({ pagination: { limit: 2 } });
    expect(result.features.length).toBe(2);
    // Hit the raw API path, NOT /stac/search.
    expect(paths).toContain("/v1/search");
    expect(paths.some((p) => p.includes("/stac/"))).toBe(false);
  });
});

/**
 * Search-method negotiation, opaque next-link paging, and geometry search.
 * The canonical `Source.query()` must POST when the API advertises a POST
 * search link, follow token cursors it cannot reconstruct, and pass a polygon
 * AOI through as STAC `intersects` instead of degrading it to an envelope.
 */
describe("stac backend-agnostic / search request assembly", () => {
  const ROOT = "https://stac.example.test/v1";

  interface RecordedRequest {
    path: string;
    method: string;
    search: URLSearchParams;
    body: Record<string, unknown> | undefined;
  }

  function requestRecorder(): {
    seen: RecordedRequest[];
    record: (url: URL, init: RequestInit | undefined) => void;
  } {
    const seen: RecordedRequest[] = [];
    return {
      seen,
      record(url, init) {
        seen.push({
          path: url.pathname,
          method: (init?.method ?? "GET").toUpperCase(),
          search: url.searchParams,
          body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
        });
      },
    };
  }

  function searches(seen: readonly RecordedRequest[]): RecordedRequest[] {
    return seen.filter((entry) => entry.path.endsWith("/search"));
  }

  /** Landing page advertising `rel="search"` once per supported method. */
  function landing(methods: readonly string[]): Record<string, unknown> {
    return {
      type: "Catalog",
      stac_version: "1.0.0",
      id: "example-catalog",
      description: "search method advertisement",
      conformsTo: ["https://api.stacspec.org/v1.0.0/core", "https://api.stacspec.org/v1.0.0/item-search"],
      links: [
        { rel: "self", type: "application/json", href: ROOT },
        ...methods.map((method) => ({
          rel: "search",
          type: "application/geo+json",
          href: `${ROOT}/search`,
          method,
        })),
      ],
    };
  }

  function item(id: string): Record<string, unknown> {
    return {
      type: "Feature",
      stac_version: "1.0.0",
      id,
      collection: "sentinel-2-l2a",
      geometry: { type: "Point", coordinates: [-157.9, 21.4] },
      properties: { datetime: "2024-04-01T00:00:00Z" },
    };
  }

  function itemCollection(ids: readonly string[], links: readonly unknown[] = []): Record<string, unknown> {
    return { type: "FeatureCollection", features: ids.map(item), links, numberReturned: ids.length };
  }

  function apiSource(client: HonuaClient) {
    return createDataset({
      id: "stac-api",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel",
          protocol: "stac",
          locator: { url: ROOT, collectionId: "sentinel-2-l2a", layout: "stac-api" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source("sentinel")!;
  }

  // Esri-shaped AOI (clockwise exterior ring) as the `polygon()` builder emits.
  const AOI_RINGS = [
    [
      [-158.5, 21.2],
      [-158.5, 21.7],
      [-157.6, 21.7],
      [-157.6, 21.2],
      [-158.5, 21.2],
    ],
  ];
  const AOI_VERTICES = JSON.stringify([...AOI_RINGS[0]].sort());

  it("issues POST /search with a JSON body when the landing page advertises a POST search link", async () => {
    const { seen, record } = requestRecorder();
    const client = routeClient(
      ROOT,
      [
        ["/v1/search", () => itemCollection(["a", "b"])],
        // Recorded from Earth Search: `rel="search"` advertised for GET and POST.
        ["/v1", () => fixture("earth-search-stac/landing.json")],
      ],
      record,
    );
    const result = await apiSource(client).query({
      pagination: { limit: 2 },
      spatialFilter: envelope(-158.5, 21.2, -157.6, 21.7),
    });

    expect(result.features).toHaveLength(2);
    const search = searches(seen);
    expect(search).toHaveLength(1);
    expect(search[0].method).toBe("POST");
    expect(search[0].body).toMatchObject({
      collections: ["sentinel-2-l2a"],
      limit: 2,
      bbox: [-158.5, 21.2, -157.6, 21.7],
    });
    // The filter never lands on the URL when POST is negotiated.
    expect(search[0].search.get("bbox")).toBeNull();
  });

  it("keeps GET /search when the landing page advertises only a GET search link", async () => {
    const { seen, record } = requestRecorder();
    const client = routeClient(
      ROOT,
      [
        ["/v1/search", () => itemCollection(["a"])],
        ["/v1", () => landing(["GET"])],
      ],
      record,
    );
    const result = await apiSource(client).query({
      pagination: { limit: 1 },
      spatialFilter: envelope(-158.5, 21.2, -157.6, 21.7),
    });

    expect(result.features).toHaveLength(1);
    const search = searches(seen);
    expect(search).toHaveLength(1);
    expect(search[0].method).toBe("GET");
    expect(search[0].body).toBeUndefined();
    expect(search[0].search.get("bbox")).toBe("-158.5,21.2,-157.6,21.7");
    expect(search[0].search.get("collections")).toBe("sentinel-2-l2a");
  });

  it("falls back to GET when an advertised POST search is refused", async () => {
    // An advertisement is not a guarantee: proxies, CORS policies, and
    // read-only fetch seams refuse POST for endpoints the catalog lists.
    const { seen, record } = requestRecorder();
    const client = routeClient(
      ROOT,
      [
        [
          "/v1/search",
          (_url, init) =>
            (init?.method ?? "GET").toUpperCase() === "POST"
              ? new Response("method not allowed", { status: 405 })
              : itemCollection(["a"]),
        ],
        ["/v1", () => landing(["GET", "POST"])],
      ],
      record,
    );

    const source = apiSource(client);
    expect((await source.query({ pagination: { limit: 1 } })).features).toHaveLength(1);
    // The refusal is remembered: the second query goes straight to GET.
    expect((await source.query({ pagination: { limit: 1 } })).features).toHaveLength(1);
    expect(searches(seen).map((entry) => entry.method)).toEqual(["POST", "GET", "GET"]);
  });

  it("drains opaque token cursors advertised on GET rel=next links", async () => {
    // pgstac / stac-fastapi page with `?token=next:…`; the token is server
    // state the client cannot reconstruct from offsets.
    const { seen, record } = requestRecorder();
    const pages: Record<string, Record<string, unknown>> = {
      "": itemCollection(["a"], [{ rel: "next", href: `${ROOT}/search?limit=1&token=next%3Apage-2` }]),
      "next:page-2": itemCollection(["b"], [{ rel: "next", href: `${ROOT}/search?limit=1&token=next%3Apage-3` }]),
      "next:page-3": itemCollection(["c"]),
    };
    const client = routeClient(
      ROOT,
      [
        ["/v1/search", (url) => pages[url.searchParams.get("token") ?? ""]],
        ["/v1", () => landing(["GET"])],
      ],
      record,
    );

    const result = await apiSource(client).queryAll({});
    expect(result.features).toHaveLength(3);
    expect(searches(seen).map((entry) => entry.search.get("token"))).toEqual([null, "next:page-2", "next:page-3"]);
  });

  it("drains POST body token cursors advertised on POST rel=next links", async () => {
    // The stac-fastapi POST pagination shape: the cursor rides in the link
    // body, not on the href.
    const { seen, record } = requestRecorder();
    const pages: Record<string, Record<string, unknown>> = {
      "": itemCollection(
        ["a"],
        [{ rel: "next", method: "POST", href: `${ROOT}/search`, body: { token: "next:page-2" }, merge: true }],
      ),
      "next:page-2": itemCollection(
        ["b"],
        [{ rel: "next", method: "POST", href: `${ROOT}/search`, body: { token: "next:page-3" }, merge: true }],
      ),
      "next:page-3": itemCollection(["c"]),
    };
    const client = routeClient(
      ROOT,
      [
        [
          "/v1/search",
          (_url, init) => {
            const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
            return pages[typeof body.token === "string" ? body.token : ""];
          },
        ],
        ["/v1", () => landing(["GET", "POST"])],
      ],
      record,
    );

    const result = await apiSource(client).queryAll({});
    expect(result.features).toHaveLength(3);
    const search = searches(seen);
    expect(search.map((entry) => entry.method)).toEqual(["POST", "POST", "POST"]);
    expect(search.map((entry) => entry.body?.token)).toEqual([undefined, "next:page-2", "next:page-3"]);
  });

  it("stops paging when the server keeps advertising the same next link", async () => {
    // A cursorless (or repeated) rel=next link must not loop: re-requesting
    // the same page would duplicate items until the page cap.
    const { seen, record } = requestRecorder();
    const client = routeClient(
      ROOT,
      [
        ["/v1/search", () => itemCollection(["a"], [{ rel: "next", href: `${ROOT}/search?limit=1&token=stuck` }])],
        ["/v1", () => landing(["GET"])],
      ],
      record,
    );

    const result = await apiSource(client).queryAll({});
    expect(searches(seen)).toHaveLength(2);
    expect(result.features).toHaveLength(2);
  });

  it("passes a polygon AOI through as STAC intersects on GET", async () => {
    const { seen, record } = requestRecorder();
    const client = routeClient(
      ROOT,
      [
        ["/v1/search", () => itemCollection(["a"])],
        ["/v1", () => landing(["GET"])],
      ],
      record,
    );

    const result = await apiSource(client).query({ spatialFilter: polygon(AOI_RINGS) });
    expect(result.features).toHaveLength(1);
    const search = searches(seen);
    expect(search[0].search.get("bbox")).toBeNull();
    const intersects = JSON.parse(search[0].search.get("intersects") ?? "null") as {
      type: string;
      coordinates: number[][][];
    };
    expect(intersects.type).toBe("Polygon");
    expect(intersects.coordinates).toHaveLength(1);
    expect(JSON.stringify([...intersects.coordinates[0]].sort())).toBe(AOI_VERTICES);
  });

  it("passes a polygon AOI through as STAC intersects on POST", async () => {
    const { seen, record } = requestRecorder();
    const client = routeClient(
      ROOT,
      [
        ["/v1/search", () => itemCollection(["a"])],
        ["/v1", () => landing(["GET", "POST"])],
      ],
      record,
    );

    await apiSource(client).query({ spatialFilter: spatialIntersects({ rings: AOI_RINGS }) });
    const body = searches(seen)[0].body as { intersects?: { type: string; coordinates: number[][][] } };
    expect(body.intersects?.type).toBe("Polygon");
    expect(JSON.stringify([...(body.intersects?.coordinates[0] ?? [])].sort())).toBe(AOI_VERTICES);
  });

  it("refuses a spatial relationship STAC intersects cannot express", async () => {
    const client = routeClient(ROOT, [
      ["/v1/search", () => itemCollection(["a"])],
      ["/v1", () => landing(["GET"])],
    ]);
    await expect(apiSource(client).query({ spatialFilter: spatialContains({ rings: AOI_RINGS }) })).rejects.toThrow(
      /spatialRel/,
    );
  });
});

describe("stac backend-agnostic / static catalog.json tree", () => {
  function staticRoutes(): Array<[string, () => unknown]> {
    return [
      ["/catalog.json", () => fixture("stac-static/catalog.json")],
      ["/imagery/collection.json", () => fixture("stac-static/imagery/collection.json")],
      ["/imagery/item-a.json", () => fixture("stac-static/imagery/item-a.json")],
      ["/imagery/item-b.json", () => fixture("stac-static/imagery/item-b.json")],
    ];
  }
  function staticSource() {
    const client = routeClient("https://static.example.test/catalog.json", staticRoutes());
    return createDataset({
      id: "static",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "imagery",
          protocol: "stac",
          locator: { url: "https://static.example.test/catalog.json", layout: "stac-static" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source<{ datetime: string; "eo:cloud_cover": number }>("imagery")!;
  }

  it("walks child + item links and returns the catalog's items as a Result", async () => {
    const result = await staticSource().query({});
    expect(result.features).toHaveLength(2);
    const ids = result.features.map((f) => f.attributes.datetime).sort();
    expect(ids).toEqual(["2024-04-01T00:00:00Z", "2024-04-02T00:00:00Z"]);
    expect(result.features[0].geometry).not.toBeNull();
  });

  it("applies a client-side limit over the traversed items", async () => {
    const result = await staticSource().query({ pagination: { limit: 1 } });
    expect(result.features).toHaveLength(1);
  });

  it("refuses an intersects geometry it cannot apply instead of returning an unfiltered superset", async () => {
    // Traversal only applies bbox / datetime / collection filters, so a
    // polygon AOI must fail loudly rather than come back silently unfiltered.
    await expect(
      staticSource().query({
        spatialFilter: polygon([
          [
            [-158.5, 21.2],
            [-158.5, 21.7],
            [-157.6, 21.7],
            [-157.6, 21.2],
            [-158.5, 21.2],
          ],
        ]),
      }),
    ).rejects.toThrow(/intersects/);
  });

  it("still applies an envelope spatial filter through the static bbox path", async () => {
    const result = await staticSource().query({ spatialFilter: envelope(-180, -90, 180, 90) });
    expect(result.features).toHaveLength(2);
  });

  it("projects item ids through queryObjectIds", async () => {
    const ids = await staticSource().queryObjectIds({});
    expect([...ids].sort()).toEqual(["scene-a", "scene-b"]);
  });

  it("binds runtime traversal to the locator's document budget", async () => {
    const paths: string[] = [];
    const client = routeClient("https://static.example.test/catalog.json", staticRoutes(), (url) =>
      paths.push(url.pathname),
    );
    const source = createDataset({
      id: "bounded-static",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "imagery",
          protocol: "stac",
          locator: {
            url: "https://static.example.test/catalog.json",
            layout: "stac-static",
            stacStatic: {
              maxDocuments: 2,
              maxDepth: 4,
              maxLinksPerDocument: 64,
              maxAssets: 256,
              maxAssetProbes: 8,
              maxDocumentBytes: 1024 * 1024,
            },
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source("imagery")!;

    const result = await source.query({});
    expect(result.features).toEqual([]);
    expect(paths).toEqual(["/catalog.json", "/imagery/collection.json"]);
  });

  it("does not fetch cross-origin traversal links and rejects an oversized root", async () => {
    const requestedOrigins: string[] = [];
    const crossOriginRoot = {
      stac_version: "1.0.0",
      type: "Catalog",
      id: "safe-root",
      description: "cross-origin link is metadata only",
      links: [{ rel: "child", href: "https://attacker.example/collection.json", type: "application/json" }],
    };
    const safeClient = new HonuaClient({
      baseUrl: "https://static.example.test/catalog.json",
      fetchFn: async (input) => {
        const url = new URL(String(input));
        requestedOrigins.push(url.origin);
        return jsonResponse(crossOriginRoot);
      },
    });
    const safeSource = createDataset({
      id: "cross-origin-static",
      client: safeClient,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "imagery",
          protocol: "stac",
          locator: { url: "https://static.example.test/catalog.json", layout: "stac-static" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source("imagery")!;
    expect((await safeSource.query({})).features).toEqual([]);
    expect(requestedOrigins).toEqual(["https://static.example.test"]);

    const oversizedRoot = {
      ...(fixture("stac-static/catalog.json") as Record<string, unknown>),
      description: "x".repeat(2048),
      links: [{ rel: "child", href: "https://attacker.example/collection.json", type: "application/json" }],
    };
    const client = new HonuaClient({
      baseUrl: "https://static.example.test/catalog.json",
      fetchFn: async () => {
        return jsonResponse(oversizedRoot);
      },
    });
    const source = createDataset({
      id: "safe-static",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "imagery",
          protocol: "stac",
          locator: {
            url: "https://static.example.test/catalog.json",
            layout: "stac-static",
            stacStatic: {
              maxDocuments: 4,
              maxDepth: 2,
              maxLinksPerDocument: 4,
              maxAssets: 16,
              maxAssetProbes: 0,
              maxDocumentBytes: 512,
            },
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source("imagery")!;

    await expect(source.query({})).rejects.toThrow(/512-byte limit/);
  });

  it("rejects a structurally hostile runtime document within the byte limit", async () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 65; depth += 1) nested = [nested];
    const client = new HonuaClient({
      baseUrl: "https://static.example.test/catalog.json",
      fetchFn: async () =>
        jsonResponse({
          stac_version: "1.0.0",
          type: "Catalog",
          id: "deep-runtime-root",
          description: "bounded bytes do not imply bounded structure",
          links: [],
          nested,
        }),
    });
    const source = createDataset({
      id: "deep-static",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "deep-runtime-root",
          protocol: "stac",
          locator: { url: "https://static.example.test/catalog.json", layout: "stac-static" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source("deep-runtime-root")!;

    await expect(source.query({})).rejects.toThrow(/64-level nesting limit/);
  });

  it("ignores rel=items and skips malformed linked Features under the same runtime policy", async () => {
    const paths: string[] = [];
    const redirectModes: Array<RequestRedirect | undefined> = [];
    const root = {
      stac_version: "1.0.0",
      type: "Catalog",
      id: "runtime-root",
      description: "runtime alignment",
      links: [
        { rel: "items", href: "./bulk.json", type: "application/geo+json" },
        { rel: "item", href: "./malformed.json", type: "application/geo+json" },
        { rel: "item", href: "./valid.json", type: "application/geo+json" },
      ],
    };
    const client = new HonuaClient({
      baseUrl: "https://static.example.test/catalog.json",
      fetchFn: async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        redirectModes.push(init?.redirect);
        if (path === "/catalog.json") return jsonResponse(root);
        if (path === "/malformed.json") {
          return jsonResponse({
            type: "Feature",
            id: "not-stac",
            geometry: null,
            properties: {},
            links: [],
            assets: {},
          });
        }
        if (path === "/valid.json") return jsonResponse(fixture("stac-static/imagery/item-a.json"));
        throw new Error(`unexpected runtime traversal ${path}`);
      },
    });
    const source = createDataset({
      id: "aligned-static",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "imagery",
          protocol: "stac",
          locator: { url: "https://static.example.test/catalog.json", layout: "stac-static" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source("imagery")!;

    expect((await source.query({})).features).toHaveLength(1);
    expect(paths).toEqual(["/catalog.json", "/malformed.json", "/valid.json"]);
    expect(redirectModes).toEqual(["error", "error", "error"]);
  });

  it("fails a malformed root Feature instead of returning an empty successful result", async () => {
    const client = new HonuaClient({
      baseUrl: "https://static.example.test/item.json",
      fetchFn: async () =>
        jsonResponse({ type: "Feature", id: "not-stac", geometry: null, properties: {}, links: [], assets: {} }),
    });
    const source = createDataset({
      id: "invalid-static-item",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "not-stac",
          protocol: "stac",
          locator: { url: "https://static.example.test/item.json", layout: "stac-static" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    }).source("not-stac")!;

    await expect(source.query({})).rejects.toThrow(/not a minimally valid STAC Item/);
  });
});
