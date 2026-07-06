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
});
