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

const FIXTURES = fileURLToPath(new URL("../fixtures/backend-agnostic/", import.meta.url));
function fixture(rel: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${rel}`, "utf8"));
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function routeClient(
  baseUrl: string,
  routes: Array<[string, () => unknown]>,
  onRequest?: (u: URL) => void,
): HonuaClient {
  return new HonuaClient({
    baseUrl,
    fetchFn: async (input) => {
      const url = new URL(String(input));
      onRequest?.(url);
      for (const [needle, make] of routes) {
        if (url.pathname === needle || url.pathname.endsWith(needle)) return jsonResponse(make());
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
