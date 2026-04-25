/**
 * STAC API search via the canonical Source surface. STAC piggy-backs on
 * OGC API Features for items, but adds a `/search` cross-collection
 * endpoint that the SDK exposes through the same `Source.query()`
 * vocabulary as every other tabular protocol.
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  createDataset,
  type SourceDescriptor,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { HonuaStacSearch } from "../../src/core/stac.js";

import { jsonResponse, makeMockClient } from "./shared.js";

interface StacFeatureAttrs {
  datetime: string;
  cloud_cover: number;
}

function stacItemsResponse(features = 2) {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: features }, (_, i) => ({
      type: "Feature",
      id: `item-${i + 1}`,
      collection: "sentinel-2",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { datetime: "2024-04-01T00:00:00Z", cloud_cover: i * 5 } as Record<string, unknown>,
      assets: { thumbnail: { href: `https://mock/${i + 1}.png`, type: "image/png" } },
    })),
    numberMatched: features,
    numberReturned: features,
    links: [],
  };
}

describe("stac / wire", () => {
  it("issues GET /search with serialized bbox / collections / filter", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          (url) => {
            observed = url.searchParams;
            return jsonResponse(stacItemsResponse());
          },
        ],
      ],
    });
    const stac = client.stac();
    const result = await stac.search({
      bbox: [-122, 37, -120, 38],
      collections: ["sentinel-2"],
      filter: "cloud_cover < 10",
      filterLang: "cql2-text",
      limit: 25,
    });
    expect(result.features).toHaveLength(2);
    expect(observed?.get("bbox")).toBe("-122,37,-120,38");
    expect(observed?.get("collections")).toBe("sentinel-2");
    expect(observed?.get("filter")).toBe("cloud_cover < 10");
    expect(observed?.get("filter-lang")).toBe("cql2-text");
    expect(observed?.get("limit")).toBe("25");
  });

  it("serializes intersects (JSON) and fields (CSV with `-` excludes) on GET /search", async () => {
    // honua-server's StacConstants.AllowedQueryParameters.SearchGet
    // accepts intersects and fields on GET. Serializing them onto the
    // POST body only would silently drop both inputs for the default
    // GET path.
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          (url) => {
            observed = url.searchParams;
            return jsonResponse(stacItemsResponse());
          },
        ],
      ],
    });
    const intersects = {
      type: "Polygon",
      coordinates: [[[-122, 37], [-120, 37], [-120, 38], [-122, 38], [-122, 37]]],
    };
    await client.stac().search({
      intersects,
      fields: { include: ["id", "properties.datetime"], exclude: ["assets.thumbnail"] },
    });
    const intersectsParam = observed?.get("intersects");
    expect(intersectsParam).toBe(JSON.stringify(intersects));
    expect(observed?.get("fields")).toBe("id,properties.datetime,-assets.thumbnail");
  });

  it("supports POST /search with a JSON body", async () => {
    let observedBody: unknown;
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          async (_url, init) => {
            observedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
            return jsonResponse(stacItemsResponse());
          },
        ],
      ],
    });
    await client.stac().search({
      usePost: true,
      bbox: [-122, 37, -120, 38],
      collections: ["sentinel-2"],
    });
    expect(observedBody).toMatchObject({
      bbox: [-122, 37, -120, 38],
      collections: ["sentinel-2"],
    });
  });

  it("forwards numeric `offset` paging on GET /search", async () => {
    // honua-server's GET handler binds [FromQuery] int? offset and
    // emits rel=next links with `?offset=N`; the SDK must mirror that.
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          (url) => {
            observed = url.searchParams;
            return jsonResponse(stacItemsResponse());
          },
        ],
      ],
    });
    await client.stac().search({ limit: 50, offset: 100 });
    expect(observed?.get("offset")).toBe("100");
  });
});

describe("stac / paging", () => {
  it("searchAll() follows rel=next links that carry `?offset=N`", async () => {
    // Three pages of two items each, advancing via Honua-style
    // `?offset=…` links. searchAll must drain every page.
    let calls = 0;
    const observedOffsets: Array<string | null> = [];
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          (url) => {
            observedOffsets.push(url.searchParams.get("offset"));
            calls += 1;
            const last = calls === 3;
            return jsonResponse({
              type: "FeatureCollection",
              features: Array.from({ length: 2 }, (_, i) => ({
                type: "Feature",
                id: `item-${calls}-${i}`,
                geometry: null,
                properties: { datetime: "2024-04-01T00:00:00Z", cloud_cover: 0 },
              })),
              numberMatched: 6,
              numberReturned: 2,
              links: last
                ? []
                : [
                    {
                      rel: "next",
                      href: `https://mock/stac/search?limit=2&offset=${calls * 2}`,
                    },
                  ],
            });
          },
        ],
      ],
    });
    const items = await client.stac().searchAll({ limit: 2 });
    expect(items).toHaveLength(6);
    expect(calls).toBe(3);
    // First request has no offset; subsequent ones follow the rel=next
    // offsets the server emitted.
    expect(observedOffsets[0]).toBeNull();
    expect(observedOffsets[1]).toBe("2");
    expect(observedOffsets[2]).toBe("4");
  });

  it("Source.queryAll() drives STAC paging through Query.pagination.offset → STAC offset", async () => {
    // Two pages of `pageSize` items, advancing via rel=next offset links.
    // The Source adapter wires `pagination.limit` → `pageSize` for
    // `searchAll`, so each page must be exactly `pageSize` items to keep
    // draining via rel=next; a partial page is the canonical exhaustion
    // signal for non-Honua STAC servers that omit rel=next.
    const pageSize = 3;
    let calls = 0;
    const observedOffsets: Array<string | null> = [];
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          (url) => {
            observedOffsets.push(url.searchParams.get("offset"));
            calls += 1;
            const last = calls === 2;
            return jsonResponse({
              type: "FeatureCollection",
              features: Array.from({ length: pageSize }, (_, i) => ({
                type: "Feature",
                id: `item-${calls}-${i}`,
                geometry: null,
                properties: { datetime: "2024-04-01T00:00:00Z", cloud_cover: i },
              })),
              numberMatched: 6,
              numberReturned: pageSize,
              links: last
                ? []
                : [{ rel: "next", href: `https://mock/stac/search?limit=${pageSize}&offset=${pageSize}` }],
            });
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "sentinel",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel-stac",
          protocol: "stac",
          locator: { url: "https://mock/", collectionId: "sentinel-2" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<StacFeatureAttrs>("sentinel-stac")!;
    const result = await source.queryAll({ pagination: { limit: pageSize, offset: 0 } });
    // limit=pageSize trims the materialized result to `pageSize` features
    // even though we drained two pages — the assertions below verify the
    // paging actually ran across both pages.
    expect(result.features).toHaveLength(pageSize);
    expect(result.exceededTransferLimit).toBe(true);
    expect(calls).toBe(2);
    // Source supplies the initial pagination.offset; subsequent pages
    // follow the rel=next link.
    expect(observedOffsets[0]).toBe("0");
    expect(observedOffsets[1]).toBe(String(pageSize));
  });

  it("falls back to the opaque `next` token when a server emits one instead of `offset`", async () => {
    // Some non-Honua STAC servers advertise a rel=next href like
    // `?next=opaque-token`. The SDK keeps optional support for them.
    let calls = 0;
    let observedNext: string | null = null;
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          (url) => {
            calls += 1;
            if (calls === 2) observedNext = url.searchParams.get("next");
            const last = calls === 2;
            return jsonResponse({
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  id: `item-${calls}`,
                  geometry: null,
                  properties: { datetime: "2024-04-01T00:00:00Z", cloud_cover: 0 },
                },
              ],
              numberMatched: 2,
              numberReturned: 1,
              links: last
                ? []
                : [{ rel: "next", href: "https://mock/stac/search?next=opaque-token" }],
            });
          },
        ],
      ],
    });
    const items = await client.stac().searchAll({ limit: 1 });
    expect(items).toHaveLength(2);
    expect(observedNext).toBe("opaque-token");
  });
});

describe("stac / Source adapter", () => {
  it("query() flows through the canonical Source surface and returns a Result envelope", async () => {
    const client = makeMockClient({
      routes: [["/stac/search", () => jsonResponse(stacItemsResponse(3))]],
    });
    const dataset = createDataset({
      id: "sentinel",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel-stac",
          protocol: "stac",
          locator: { url: "https://mock/", collectionId: "sentinel-2" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<StacFeatureAttrs>("sentinel-stac")!;
    const result = await source.query({ where: "cloud_cover < 50" });
    expect(result.features).toHaveLength(3);
    expect(result.features[0].attributes.datetime).toBe("2024-04-01T00:00:00Z");
    expect(result.totalCount).toBe(3);
    expect(source.descriptor.protocol).toBe("stac");
  });

  it("exposes the underlying STAC client through Source.adapter('stac')", () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "sentinel",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel-stac",
          protocol: "stac",
          locator: { url: "https://mock/" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("sentinel-stac")!;
    expect(source.adapter("stac")).toBeInstanceOf(HonuaStacSearch);
  });

  it("queryAggregate is not advertised; aggregation requests throw", async () => {
    const client = makeMockClient({ routes: [["/stac/search", () => jsonResponse(stacItemsResponse())]] });
    const dataset = createDataset({
      id: "sentinel",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel-stac",
          protocol: "stac",
          locator: { url: "https://mock/" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("sentinel-stac")!;
    await expect(
      source.query({ aggregation: { metrics: [{ fn: "sum", field: "cloud_cover" }] } }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("stream() yields paged Result envelopes", async () => {
    const client = makeMockClient({
      routes: [["/stac/search", () => jsonResponse(stacItemsResponse(2))]],
    });
    const dataset = createDataset({
      id: "sentinel",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel-stac",
          protocol: "stac",
          locator: { url: "https://mock/" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<StacFeatureAttrs>("sentinel-stac")!;
    const pages: number[] = [];
    for await (const page of source.stream({ pagination: { limit: 2 } })) {
      pages.push(page.features.length);
      if (pages.length >= 1) break;
    }
    expect(pages[0]).toBe(2);
  });

  it("queryAll({ limit }) caps STAC fetch at limit + 1 rows even when the catalog advertises more pages", async () => {
    // The shared contract promises queryAll fetches at most limit + 1
    // rows so the slice can stamp `exceededTransferLimit` honestly. STAC
    // search emits rel=next links for every additional page; without the
    // bounded paging helper, queryAll({ limit: 1 }) would scan the whole
    // catalog before slicing to one feature.
    let calls = 0;
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          () => {
            calls += 1;
            return jsonResponse({
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  id: `item-${calls}`,
                  geometry: null,
                  properties: { datetime: "2024-04-01T00:00:00Z", cloud_cover: calls },
                },
              ],
              numberMatched: 1000,
              numberReturned: 1,
              // Always advertises another page; only the bounded fetch
              // stops the loop.
              links: [{ rel: "next", href: `https://mock/stac/search?limit=1&offset=${calls}` }],
            });
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "sentinel",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel-stac",
          protocol: "stac",
          locator: { url: "https://mock/", collectionId: "sentinel-2" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<StacFeatureAttrs>("sentinel-stac")!;
    const result = await source.queryAll({ pagination: { limit: 1 } });
    expect(result.features).toHaveLength(1);
    expect(result.exceededTransferLimit).toBe(true);
    // limit + 1: two requests, then stop. Without the bounded helper this
    // would have followed the rel=next chain forever.
    expect(calls).toBe(2);
  });

  it("queryObjectIds({ limit }) caps STAC fetch at limit + 1 rows and slices IDs to limit", async () => {
    // Mirrors the queryAll contract for the ids-only projection. STAC
    // has no server-side ids endpoint, so the adapter drains items and
    // projects `id` — the bounded helper must keep that drain finite.
    let calls = 0;
    const client = makeMockClient({
      routes: [
        [
          "/stac/search",
          () => {
            calls += 1;
            return jsonResponse({
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  id: `item-${calls}`,
                  geometry: null,
                  properties: { datetime: "2024-04-01T00:00:00Z", cloud_cover: calls },
                },
              ],
              numberMatched: 1000,
              numberReturned: 1,
              links: [{ rel: "next", href: `https://mock/stac/search?limit=1&offset=${calls}` }],
            });
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "sentinel",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "sentinel-stac",
          protocol: "stac",
          locator: { url: "https://mock/", collectionId: "sentinel-2" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<StacFeatureAttrs>("sentinel-stac")!;
    const ids = await source.queryObjectIds({ pagination: { limit: 1 } });
    expect(ids).toEqual(["item-1"]);
    expect(calls).toBe(2);
  });
});
