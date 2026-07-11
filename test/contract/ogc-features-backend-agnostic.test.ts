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
