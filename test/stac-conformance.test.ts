import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import {
  HonuaStacConformanceError,
  STAC_CONFORMANCE_CLASS,
  hasStacConformance,
  stacSearchExtensionRequirements,
} from "../src/core/stac-conformance.js";
import { HonuaStacSearch } from "../src/core/stac.js";

const earthSearchLanding = JSON.parse(
  readFileSync(new URL("./fixtures/backend-agnostic/earth-search-stac/landing.json", import.meta.url), "utf8"),
) as { conformsTo: readonly string[]; links: readonly { rel?: string; method?: string }[] };

const EMPTY_COLLECTION = { type: "FeatureCollection", features: [], links: [] };

function mockClient(handler: (url: URL, init?: RequestInit) => Response): HonuaClient {
  return new HonuaClient({
    baseUrl: "https://stac.example.test/v1",
    fetchFn: async (input, init) => handler(new URL(String(input)), init),
  });
}

function searchClient(landing: unknown): { client: HonuaClient; paths: string[] } {
  const paths: string[] = [];
  const client = mockClient((url) => {
    paths.push(url.pathname);
    if (url.pathname.endsWith("/search")) return Response.json(EMPTY_COLLECTION);
    return Response.json(landing);
  });
  return { client, paths };
}

describe("STAC conformance predicates", () => {
  it("reads the Earth Search landing page as a subset: sort, fields, and query, not filter or CQL2", () => {
    const conformsTo = earthSearchLanding.conformsTo;
    expect(hasStacConformance(conformsTo, "core")).toBe(true);
    expect(hasStacConformance(conformsTo, "item-search")).toBe(true);
    expect(hasStacConformance(conformsTo, "sort")).toBe(true);
    expect(hasStacConformance(conformsTo, "fields")).toBe(true);
    expect(hasStacConformance(conformsTo, "query")).toBe(true);
    expect(hasStacConformance(conformsTo, "filter")).toBe(false);
    expect(hasStacConformance(conformsTo, "cql2-text")).toBe(false);
    expect(hasStacConformance(conformsTo, "cql2-json")).toBe(false);
    // A fragment class is not Item Search, and a non-default port is not the canonical origin.
    expect(hasStacConformance([STAC_CONFORMANCE_CLASS.filter], "item-search")).toBe(false);
    expect(hasStacConformance(["https://api.stacspec.org:444/v1.0.0/item-search"], "item-search")).toBe(false);
    expect(hasStacConformance(["https://attacker.example/api.stacspec.org/v1.0.0/core"], "core")).toBe(false);
    expect(hasStacConformance(["https://api.stacspec.org/v1.0.0/ogcapi-features#sort"], "sort")).toBe(true);
    expect(hasStacConformance(["https://www.opengis.net/spec/cql2/1.0/conf/cql2-text"], "cql2-text")).toBe(true);
    expect(stacSearchExtensionRequirements({ bbox: [-1, -1, 1, 1], limit: 1 })).toEqual([]);
  });
});

describe("STAC search conformance gate", () => {
  it("preserves implicit POST JSON semantics on first and cached GET fallbacks", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const client = mockClient((url, init) => {
      if (!url.pathname.endsWith("/search")) {
        return Response.json({ conformsTo: [
          STAC_CONFORMANCE_CLASS["item-search"], STAC_CONFORMANCE_CLASS.filter, STAC_CONFORMANCE_CLASS["cql2-json"],
        ] });
      }
      requests.push({ url, init });
      return init?.method === "POST" ? new Response("POST unavailable", { status: 405 }) : Response.json(EMPTY_COLLECTION);
    });
    const filter = { op: "<", args: [{ property: "cloud_cover" }, 10] };
    const stac = new HonuaStacSearch({ client });
    await stac.search({ filter, usePost: true });
    await stac.search({ filter, usePost: true });
    expect(requests.map((request) => request.init?.method)).toEqual(["POST", "GET", "GET"]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ filter });
    for (const request of requests.slice(1)) {
      expect(request.url.searchParams.get("filter-lang")).toBe("cql2-json");
      expect(JSON.parse(request.url.searchParams.get("filter") ?? "null")).toEqual(filter);
    }
  });

  it("reads and caches conformance separately for each effective request base", async () => {
    const paths: string[] = [];
    const client = mockClient((url) => {
      paths.push(url.pathname);
      if (url.pathname.endsWith("/search")) return Response.json(EMPTY_COLLECTION);
      const extension = url.pathname === "/v1/alternate" ? "fields" : "sort";
      return Response.json({
        conformsTo: [STAC_CONFORMANCE_CLASS["item-search"], STAC_CONFORMANCE_CLASS[extension]],
        links: [],
      });
    });
    const stac = new HonuaStacSearch({ client });
    await stac.search({ sortby: "datetime" });
    await stac.search({ stacBasePath: "/alternate", fields: { include: ["id"] } });
    await expect(stac.search({ stacBasePath: "/alternate/", sortby: "datetime" })).rejects.toMatchObject({
      conformanceClass: STAC_CONFORMANCE_CLASS.sort,
    });
    await expect(stac.search({ fields: { include: ["id"] } })).rejects.toMatchObject({
      conformanceClass: STAC_CONFORMANCE_CLASS.fields,
    });
    expect(paths).toEqual(["/v1/stac", "/v1/stac/search", "/v1/alternate", "/v1/alternate/search"]);
  });

  it.each([false, true])("gates the implicit HTTP filter language for usePost=%s", async (usePost) => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const client = mockClient((url, init) => {
      requests.push({ url, init });
      return Response.json(EMPTY_COLLECTION);
    });
    const language = usePost ? "cql2-json" : "cql2-text";
    const otherLanguage = usePost ? "cql2-text" : "cql2-json";
    const filter = usePost ? { op: "<", args: [{ property: "cloud_cover" }, 10] } : "cloud_cover < 10";
    const conformsTo = [STAC_CONFORMANCE_CLASS["item-search"], STAC_CONFORMANCE_CLASS.filter];
    for (const declared of [conformsTo, [...conformsTo, STAC_CONFORMANCE_CLASS[otherLanguage]]]) {
      await expect(client.searchStac({ filter, usePost, conformsTo: declared })).rejects.toMatchObject({
        conformanceClass: STAC_CONFORMANCE_CLASS[language],
      });
    }
    expect(requests).toEqual([]);
    await client.searchStac({ filter, usePost, conformsTo: [...conformsTo, STAC_CONFORMANCE_CLASS[language]] });
    expect(requests).toHaveLength(1);
    if (usePost) {
      expect(requests[0]?.init?.method).toBe("POST");
      expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ filter });
      expect(JSON.parse(String(requests[0]?.init?.body))).not.toHaveProperty("filter-lang");
    } else {
      expect(requests[0]?.url.searchParams.get("filter")).toBe(filter);
      expect(requests[0]?.url.searchParams.has("filter-lang")).toBe(false);
    }
  });

  it("refuses an extension search on a catalog that declares no extensions, before /search", async () => {
    const { client, paths } = searchClient({
      conformsTo: [STAC_CONFORMANCE_CLASS.core],
      links: [],
    });
    const stac = new HonuaStacSearch({ client, basePath: "" });

    const error = await stac.search({ filter: "cloud_cover < 10", filterLang: "cql2-text" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(HonuaStacConformanceError);
    const conformance = error as HonuaStacConformanceError;
    expect(conformance.unread).toBe(false);
    expect(conformance.conformanceClass).toBe(STAC_CONFORMANCE_CLASS["item-search"]);
    expect(conformance.missing).toEqual([
      STAC_CONFORMANCE_CLASS["item-search"],
      STAC_CONFORMANCE_CLASS.filter,
      STAC_CONFORMANCE_CLASS["cql2-text"],
    ]);
    expect(conformance.message).toContain(STAC_CONFORMANCE_CLASS["item-search"]);
    expect(conformance.message).toContain("does not declare");
    expect(paths.some((path) => path.endsWith("/search"))).toBe(false);
  });

  it("allows Earth Search fields and sort, and names the missing filter and CQL2 classes", async () => {
    const { client, paths } = searchClient(earthSearchLanding);
    const stac = new HonuaStacSearch({ client, basePath: "" });

    const page = await stac.search({
      fields: { include: ["id"] },
      sortby: [{ field: "properties.datetime", direction: "desc" }],
    });
    expect(page.type).toBe("FeatureCollection");
    expect(paths.some((path) => path.endsWith("/search"))).toBe(true);

    const error = await stac
      .search({ filter: { op: "=", args: [{ property: "collection" }, "sentinel-2-l2a"] }, filterLang: "cql2-text" })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(HonuaStacConformanceError);
    const conformance = error as HonuaStacConformanceError;
    expect(conformance.conformanceClass).toBe(STAC_CONFORMANCE_CLASS.filter);
    expect(conformance.missing).toContain(STAC_CONFORMANCE_CLASS.filter);
    expect(conformance.missing).toContain(STAC_CONFORMANCE_CLASS["cql2-text"]);
    expect(conformance.message).toContain(STAC_CONFORMANCE_CLASS.filter);
    expect(conformance.message).toContain(STAC_CONFORMANCE_CLASS["cql2-text"]);
  });

  it("refuses cql2-text when the catalog only declares cql2-json", async () => {
    const { client } = searchClient({
      conformsTo: [
        STAC_CONFORMANCE_CLASS["item-search"],
        STAC_CONFORMANCE_CLASS.filter,
        STAC_CONFORMANCE_CLASS["cql2-json"],
      ],
      links: [],
    });
    const stac = new HonuaStacSearch({ client, basePath: "" });

    await expect(stac.search({ filter: "cloud_cover < 10", filterLang: "cql2-text" })).rejects.toMatchObject({
      conformanceClass: STAC_CONFORMANCE_CLASS["cql2-text"],
      unread: false,
    });
  });

  it("fails a direct searchStac extension call before any request when conformsTo was not read", async () => {
    let called = false;
    const client = new HonuaClient({
      baseUrl: "https://stac.example.test/v1",
      fetchFn: async () => {
        called = true;
        return Response.json(EMPTY_COLLECTION);
      },
    });

    await expect(client.searchStac({ filter: "cloud_cover < 10", filterLang: "cql2-json" })).rejects.toMatchObject({
      name: "HonuaStacConformanceError",
      unread: true,
      conformanceClass: STAC_CONFORMANCE_CLASS["item-search"],
    });
    expect(called).toBe(false);
  });

  it("treats an empty conformsTo list as read-and-absent", async () => {
    const client = new HonuaClient({
      baseUrl: "https://stac.example.test/v1",
      fetchFn: async () => Response.json(EMPTY_COLLECTION),
    });

    await expect(
      client.searchStac({ filter: "cloud_cover < 10", filterLang: "cql2-text", conformsTo: [] }),
    ).rejects.toMatchObject({
      unread: false,
      conformanceClass: STAC_CONFORMANCE_CLASS["item-search"],
    });
  });

  it("wraps an unreadable landing page instead of emitting filter-lang", async () => {
    const paths: string[] = [];
    const client = mockClient((url) => {
      paths.push(url.pathname);
      return new Response("nope", { status: 500 });
    });
    const stac = new HonuaStacSearch({ client, basePath: "" });

    const error = await stac.search({ sortby: "datetime" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HonuaStacConformanceError);
    expect((error as HonuaStacConformanceError).unread).toBe(true);
    expect((error as HonuaStacConformanceError).message).toContain(STAC_CONFORMANCE_CLASS.sort);
    expect((error as HonuaStacConformanceError).cause).toBeInstanceOf(Error);
    expect(paths.some((path) => path.endsWith("/search"))).toBe(false);
  });

  it("stays on GET when a POST search link is advertised without Item Search", async () => {
    const { client } = searchClient({
      conformsTo: [STAC_CONFORMANCE_CLASS.core],
      links: [{ rel: "search", href: "./search", method: "POST" }],
    });
    const stac = new HonuaStacSearch({ client, basePath: "" });
    await expect(stac.supportsPostSearch()).resolves.toBe(false);
  });

  it("uses POST when Earth Search declares Item Search and a POST search link", async () => {
    const { client } = searchClient(earthSearchLanding);
    const stac = new HonuaStacSearch({ client, basePath: "" });
    await expect(stac.supportsPostSearch()).resolves.toBe(true);
    expect(earthSearchLanding.links.some((link) => link.rel === "search" && link.method === "POST")).toBe(true);
  });
});
