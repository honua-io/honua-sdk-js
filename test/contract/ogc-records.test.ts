/**
 * OGC API Records catalog support. Records expose metadata about resources
 * (services, collections, maps, STAC collections, source descriptors), so the
 * SDK keeps them distinct from STAC item search and protocol-native metadata.
 */

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import type { HonuaHttpError } from "../../src/core/errors.js";
import { HonuaOgcRecordCollection } from "../../src/core/ogc-records.js";
import { envelope } from "../../src/core/spatial-filter.js";

import { jsonResponse, makeMockClient } from "./shared.js";

interface RecordAttrs {
  type: string;
  title: string;
  externalIds?: readonly string[];
}

function recordsResponse(features = 2) {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: features }, (_, i) => ({
      type: "Feature",
      id: `record-${i + 1}`,
      geometry: { type: "Point", coordinates: [-157.8 + i, 21.3] },
      properties: {
        type: i === 0 ? "service" : "collection",
        title: `Catalog record ${i + 1}`,
        description: "Metadata record",
        externalIds: [`ext-${i + 1}`],
        links: [{ rel: "item", href: `https://mock/resources/${i + 1}` }],
      },
    })),
    numberMatched: features,
    numberReturned: features,
    links: [],
  };
}

describe("ogc-records / wire", () => {
  it("calls Records discovery, search, and detail endpoints with supported query parameters", async () => {
    const requestedUrls: string[] = [];
    const client = makeMockClient({
      routes: [
        [
          "/ogc/records",
          (url) => {
            requestedUrls.push(url.href);
            if (url.pathname.endsWith("/items/record-1")) {
              return jsonResponse(recordsResponse(1).features[0]);
            }
            if (url.pathname.endsWith("/items")) {
              return jsonResponse(recordsResponse());
            }
            if (url.pathname.endsWith("/collections/catalog")) {
              return jsonResponse({ id: "catalog", itemType: "record" });
            }
            if (url.pathname.endsWith("/collections")) {
              return jsonResponse({ collections: [{ id: "catalog", itemType: "record" }] });
            }
            if (url.pathname.endsWith("/conformance")) {
              return jsonResponse({ conformsTo: [] });
            }
            return jsonResponse({ title: "Records" });
          },
        ],
      ],
    });

    const records = client.ogcRecords();
    await records.landing({ responseFormat: "json" });
    await records.conformance({ responseFormat: "json" });
    await records.collections({ responseFormat: "json" });
    await records.collectionMetadata({ collectionId: "catalog", responseFormat: "json" });
    await records.search({
      collectionId: "catalog",
      responseFormat: "geojson",
      limit: 10,
      offset: 20,
      bbox: [-158, 21, -157, 22],
      datetime: "2025-01-01/2025-12-31",
      q: ["roads", "parcels"],
      ids: ["record-1", "record-2"],
      type: ["service", "collection"],
      externalIds: ["svc-a", "svc-b"],
      filter: "type = 'service'",
      filterLang: "cql2-text",
      filterCrs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
      properties: ["title", "type"],
      sortby: "-updated",
      profile: "record",
    });
    await records.record({ collectionId: "catalog", recordId: "record-1", responseFormat: "json" });

    expect(requestedUrls[0]).toBe("https://mock.honua.test/ogc/records?f=json");
    expect(requestedUrls[1]).toBe("https://mock.honua.test/ogc/records/conformance?f=json");
    expect(requestedUrls[2]).toBe("https://mock.honua.test/ogc/records/collections?f=json");
    expect(requestedUrls[3]).toBe("https://mock.honua.test/ogc/records/collections/catalog?f=json");

    const search = new URL(requestedUrls[4]);
    expect(search.pathname).toBe("/ogc/records/collections/catalog/items");
    expect(search.searchParams.get("f")).toBe("geojson");
    expect(search.searchParams.get("limit")).toBe("10");
    expect(search.searchParams.get("offset")).toBe("20");
    expect(search.searchParams.get("bbox")).toBe("-158,21,-157,22");
    expect(search.searchParams.get("datetime")).toBe("2025-01-01/2025-12-31");
    expect(search.searchParams.get("q")).toBe("roads,parcels");
    expect(search.searchParams.get("ids")).toBe("record-1,record-2");
    expect(search.searchParams.get("type")).toBe("service,collection");
    expect(search.searchParams.get("externalIds")).toBe("svc-a,svc-b");
    expect(search.searchParams.get("filter")).toBe("type = 'service'");
    expect(search.searchParams.get("filter-lang")).toBe("cql2-text");
    expect(search.searchParams.get("filter-crs")).toBe("http://www.opengis.net/def/crs/OGC/1.3/CRS84");
    expect(search.searchParams.get("properties")).toBe("title,type");
    expect(search.searchParams.get("sortby")).toBe("-updated");
    expect(search.searchParams.get("profile")).toBe("record");
    expect(requestedUrls[5]).toBe("https://mock.honua.test/ogc/records/collections/catalog/items/record-1?f=json");
  });

  it("returns raw Records responses through the shared auth/interceptor pipeline", async () => {
    const seen: string[] = [];
    let headers: HeadersInit | undefined;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      apiKey: "key-1",
      bearerToken: "token-1",
      interceptors: [
        {
          before: () => {
            seen.push("before");
          },
          after: () => {
            seen.push("after");
          },
        },
      ],
      fetchFn: async (_input, init) => {
        headers = init?.headers;
        return new Response("<html>record catalog</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      },
    });

    const response = await client.ogcRecords().collection("catalog").rawSearch({
      responseFormat: "html",
      accept: "text/html",
    });

    expect(await response.text()).toBe("<html>record catalog</html>");
    expect(headers).toMatchObject({
      Accept: "text/html",
      "X-API-Key": "key-1",
      Authorization: "Bearer token-1",
    });
    expect(seen).toEqual(["before", "after"]);
  });

  it("surfaces HTTP errors with normalized HonuaHttpError metadata", async () => {
    const client = makeMockClient({
      routes: [
        [
          "/ogc/records/collections/catalog/items",
          () => jsonResponse({ error: { message: "records unavailable" } }, { status: 503 }),
        ],
      ],
    });

    await expect(client.ogcRecords().search({ collectionId: "catalog" })).rejects.toMatchObject({
      name: "HonuaHttpError",
      statusCode: 503,
    } satisfies Partial<HonuaHttpError>);
  });

  it("searchAll() follows rel=next links with offset paging", async () => {
    let calls = 0;
    const observedOffsets: Array<string | null> = [];
    const client = makeMockClient({
      routes: [
        [
          "/ogc/records/collections/catalog/items",
          (url) => {
            calls += 1;
            observedOffsets.push(url.searchParams.get("offset"));
            const last = calls === 3;
            return jsonResponse({
              ...recordsResponse(2),
              links: last
                ? []
                : [{ rel: "next", href: `https://mock/ogc/records/collections/catalog/items?offset=${calls * 2}` }],
            });
          },
        ],
      ],
    });

    const records = await client.ogcRecords().searchAll({ collectionId: "catalog", limit: 2 });

    expect(records).toHaveLength(6);
    expect(calls).toBe(3);
    expect(observedOffsets).toEqual([null, "2", "4"]);
  });
});

describe("ogc-records / Source adapter", () => {
  it("maps canonical Query fields to Records search parameters and parses record properties", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/records/collections/catalog/items",
          (url) => {
            observed = url.searchParams;
            return jsonResponse(recordsResponse(2));
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "catalog",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "records",
          protocol: "ogc-records",
          locator: { url: "https://mock/", collectionId: "catalog" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-records"],
        } satisfies SourceDescriptor,
      ],
    });

    const source = dataset.source<RecordAttrs>("records")!;
    const result = await source.query({
      where: "type = 'service'",
      spatialFilter: envelope(-158, 21, -157, 22),
      outFields: ["title", "type"],
      orderBy: [{ field: "updated", direction: "desc" }],
      pagination: { offset: 5, limit: 25 },
    });

    expect(observed?.get("filter")).toBe("type = 'service'");
    expect(observed?.get("filter-lang")).toBe("cql2-text");
    expect(observed?.get("bbox")).toBe("-158,21,-157,22");
    expect(observed?.get("properties")).toBe("title,type");
    expect(observed?.get("sortby")).toBe("-updated");
    expect(observed?.get("offset")).toBe("5");
    expect(observed?.get("limit")).toBe("25");
    expect(result.features).toHaveLength(2);
    expect(result.features[0].attributes.title).toBe("Catalog record 1");
    expect(result.features[0].attributes.externalIds).toEqual(["ext-1"]);
    expect(result.totalCount).toBe(2);
    expect(source.protocol("ogc-records")).toBeInstanceOf(HonuaOgcRecordCollection);
  });

  it("queryObjectIds({ limit }) caps Records paging and slices IDs", async () => {
    let calls = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/records/collections/catalog/items",
          () => {
            calls += 1;
            return jsonResponse({
              ...recordsResponse(1),
              features: [
                {
                  ...recordsResponse(1).features[0],
                  id: `record-${calls}`,
                },
              ],
              numberMatched: 1000,
              links: [{ rel: "next", href: `https://mock/ogc/records/collections/catalog/items?offset=${calls}` }],
            });
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "catalog",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "records",
          protocol: "ogc-records",
          locator: { url: "https://mock/", collectionId: "catalog" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-records"],
        } satisfies SourceDescriptor,
      ],
    });

    const ids = await dataset.source("records")!.queryObjectIds({ pagination: { limit: 1 } });

    expect(ids).toEqual(["record-1"]);
    expect(calls).toBe(2);
  });

  it("rejects aggregation because Records search is catalog metadata, not analytics", async () => {
    const client = makeMockClient({
      routes: [["/ogc/records/collections/catalog/items", () => jsonResponse(recordsResponse())]],
    });
    const dataset = createDataset({
      id: "catalog",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "records",
          protocol: "ogc-records",
          locator: { url: "https://mock/", collectionId: "catalog" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-records"],
        } satisfies SourceDescriptor,
      ],
    });

    await expect(
      dataset.source("records")!.query({ aggregation: { metrics: [{ fn: "count", field: "type" }] } }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});
