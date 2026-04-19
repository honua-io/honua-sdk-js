/**
 * Cross-protocol conformance suite. The same canonical query / aggregation
 * / streaming scenarios are dispatched against each adapter's `Source`.
 *
 * Adding a new adapter (WFS / WMS / OData) means adding a `protocols`
 * entry below — every scenario then runs against the new adapter without
 * test-side changes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  type Dataset,
  PROTOCOLS,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type Query,
  type Source,
  type SourceDescriptor,
  capabilities,
  createDataset,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import {
  HonuaFeatureLayer,
  type HonuaOgcCollectionItemsAllRequest,
  HonuaMapLayer,
  HonuaMapService,
  HonuaOgcFeatureCollection,
} from "../../src/core/surfaces.js";

import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  geoservicesAggregateResponse,
  geoservicesExtentResponse,
  geoservicesQueryResponse,
  jsonResponse,
  makeMockClient,
  ogcCollectionMetadata,
  ogcItemsResponse,
} from "./shared.js";

interface Harness {
  protocol: Protocol;
  build(): Dataset;
  sourceId: string;
}

const harnesses: Harness[] = [
  {
    protocol: "geoservices-feature-service",
    sourceId: "parcels-fs",
    build() {
      const client = makeMockClient({
        routes: [
          [
            "/rest/services/Parcels/FeatureServer/0/query",
            (url) => {
              const stats = url.searchParams.get("outStatistics");
              if (stats) return jsonResponse(geoservicesAggregateResponse());
              const returnExtent = url.searchParams.get("returnExtentOnly") === "true";
              if (returnExtent) return jsonResponse(geoservicesExtentResponse());
              return jsonResponse(geoservicesQueryResponse());
            },
          ],
        ],
      });
      return createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels-fs",
            protocol: "geoservices-feature-service",
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
          } satisfies SourceDescriptor,
        ],
      });
    },
  },
  {
    protocol: "geoservices-map-service",
    sourceId: "parcels-ms",
    build() {
      const client = makeMockClient({
        routes: [
          [
            "/rest/services/Parcels/MapServer/0/query",
            (url) => {
              const stats = url.searchParams.get("outStatistics");
              if (stats) return jsonResponse(geoservicesAggregateResponse());
              const returnExtent = url.searchParams.get("returnExtentOnly") === "true";
              if (returnExtent) return jsonResponse(geoservicesExtentResponse());
              return jsonResponse(geoservicesQueryResponse());
            },
          ],
        ],
      });
      return createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels-ms",
            protocol: "geoservices-map-service",
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-map-service"],
          } satisfies SourceDescriptor,
        ],
      });
    },
  },
  {
    protocol: "ogc-features",
    sourceId: "parcels-ogc",
    build() {
      const client = makeMockClient({
        routes: [
          ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
          ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
        ],
      });
      return createDataset({
        id: "parcels",
        client,
        capabilityPolicy: "degraded",
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels-ogc",
            protocol: "ogc-features",
            locator: { url: "https://mock/", collectionId: "parcels" },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
          } satisfies SourceDescriptor,
        ],
      });
    },
  },
];

describe("contract / Protocol enum", () => {
  it("includes all nine canonical protocols", () => {
    expect(PROTOCOLS).toEqual([
      "geoservices-feature-service",
      "geoservices-map-service",
      "ogc-features",
      "wfs",
      "wms",
      "odata",
      "maplibre-vector",
      "maplibre-raster",
      "maplibre-geojson",
    ]);
  });

  it("has a default capability set for every protocol", () => {
    for (const p of PROTOCOLS) {
      expect(PROTOCOL_DEFAULT_CAPABILITIES[p]).toBeInstanceOf(Set);
    }
  });

  it("ALL_CAPABILITIES contains exactly the declared CAPABILITIES", () => {
    expect(ALL_CAPABILITIES.size).toBe(CAPABILITIES.length);
    for (const c of CAPABILITIES) expect(ALL_CAPABILITIES.has(c)).toBe(true);
  });
});

describe("contract / Dataset", () => {
  it("rejects duplicate source ids", () => {
    const client = makeMockClient({ routes: [] });
    expect(() =>
      createDataset({
        id: "x",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "a",
            protocol: "geoservices-feature-service",
            locator: { url: "u", serviceId: "S", layerId: 0 },
            capabilities: capabilities([]),
          },
          {
            id: "a",
            protocol: "geoservices-feature-service",
            locator: { url: "u", serviceId: "S", layerId: 1 },
            capabilities: capabilities([]),
          },
        ],
      }),
    ).toThrow(/duplicate source id/);
  });

  it("source() returns undefined for unknown ids", () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "x",
      client,
      skipCompatibilityCheck: true,
      sources: [],
    });
    expect(dataset.source("missing")).toBeUndefined();
  });

  it("invokes resolveSource for unknown protocols and throws if resolver returns nothing", () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "x",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "wfs-1",
          protocol: "wfs",
          locator: { url: "u", typeName: "ns:foo" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
        },
      ],
    });
    expect(() => dataset.source("wfs-1")).toThrow(HonuaCapabilityNotSupportedError);
  });

  it("invokes resolveSource for adapter-wrapped protocols and uses the returned source", async () => {
    const client = makeMockClient({ routes: [] });
    const stubSource: Source = {
      descriptor: {
        id: "wfs-1",
        protocol: "wfs",
        locator: { url: "u", typeName: "ns:foo" },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
      },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
      query: async () => ({ features: [], exceededTransferLimit: false }),
      queryAll: async () => ({ features: [], exceededTransferLimit: false }),
      queryAggregate: async () => ({ features: [], exceededTransferLimit: false }),
      queryExtent: async () => ({ extent: null }),
      // eslint-disable-next-line @typescript-eslint/no-empty-function, require-yield
      stream: async function* () {},
      adapter: () => undefined,
    };
    const dataset = createDataset({
      id: "x",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "wfs-1",
          protocol: "wfs",
          locator: { url: "u", typeName: "ns:foo" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
        },
      ],
      resolveSource: () => stubSource,
    });
    const source = dataset.source("wfs-1");
    expect(source).toBe(stubSource);
    expect(await source!.query()).toEqual({ features: [], exceededTransferLimit: false });
  });
});

for (const harness of harnesses) {
  describe(`contract / Source / ${harness.protocol}`, () => {
    it("query returns canonical Result envelope with features", async () => {
      const dataset = harness.build();
      const source = dataset.source<ParcelAttrs>(harness.sourceId);
      expect(source).toBeDefined();
      const result = await source!.query({ where: "1=1" });
      expect(result.features).toHaveLength(PARCEL_FEATURES.length);
      const first = result.features[0];
      expect(first.attributes.OBJECTID).toBe(1);
      expect(first.geometry).toBeTruthy();
    });

    it("descriptor exposes the requested capabilities", () => {
      const dataset = harness.build();
      const source = dataset.source(harness.sourceId)!;
      const expected = PROTOCOL_DEFAULT_CAPABILITIES[harness.protocol];
      for (const cap of expected) expect(source.capabilities.has(cap)).toBe(true);
      expect(source.descriptor.protocol).toBe(harness.protocol);
    });

    it("queryExtent yields a HonuaExtent envelope", async () => {
      const dataset = harness.build();
      const source = dataset.source(harness.sourceId)!;
      const out = await source.queryExtent();
      if (out.extent) {
        expect(out.extent.xmin).toBeLessThanOrEqual(out.extent.xmax);
        expect(out.extent.ymin).toBeLessThanOrEqual(out.extent.ymax);
      }
    });

    it("queryAggregate returns aggregateRows under any policy that allows it", async () => {
      const dataset = harness.build();
      const source = dataset.source<ParcelAttrs>(harness.sourceId)!;
      if (!source.capabilities.has("queryAggregate")) {
        // Only verifiable under degraded policy; OGC harness uses degraded.
        if (harness.protocol === "ogc-features") {
          const result = await source.queryAggregate({
            aggregation: { groupBy: ["STATE"], metrics: [{ fn: "sum", field: "ACRES", alias: "SUM_ACRES" }] },
          });
          expect(result.aggregateRows).toBeDefined();
          expect(result.degraded?.[0]?.capability).toBe("queryAggregate");
          return;
        }
        return;
      }
      const result = await source.queryAggregate({
        aggregation: { groupBy: ["STATE"], metrics: [{ fn: "sum", field: "ACRES", alias: "SUM_ACRES" }] },
      });
      expect(result.aggregateRows).toBeDefined();
      expect(result.aggregateRows!.length).toBeGreaterThan(0);
    });

    it("stream emits at least one Result page", async () => {
      const dataset = harness.build();
      const source = dataset.source<ParcelAttrs>(harness.sourceId)!;
      const pages: Array<{ features: ReadonlyArray<unknown> }> = [];
      for await (const page of source.stream({ where: "1=1" })) {
        pages.push(page);
        if (pages.length >= 1) break;
      }
      expect(pages.length).toBeGreaterThan(0);
      expect(pages[0].features.length).toBeGreaterThan(0);
    });
  });
}

describe("contract / strict capability policy", () => {
  function buildStrictOgcDataset(): Dataset {
    const client = makeMockClient({
      routes: [
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
        ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
      ],
    });
    return createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "strict",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          // PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"] omits queryAggregate and queryExtent.
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        },
      ],
    });
  }

  it("throws HonuaCapabilityNotSupportedError when queryAggregate is missing", async () => {
    const source = buildStrictOgcDataset().source<ParcelAttrs>("parcels-ogc")!;
    await expect(
      source.queryAggregate({
        aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] },
      } as Query<ParcelAttrs> & { aggregation: { metrics: ReadonlyArray<{ fn: "sum"; field: string }> } }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("throws from query() when an aggregation is requested on a source without queryAggregate", async () => {
    const source = buildStrictOgcDataset().source<ParcelAttrs>("parcels-ogc")!;
    await expect(
      source.query({
        aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] },
      }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("throws from queryExtent() when queryExtent is not advertised", async () => {
    const source = buildStrictOgcDataset().source<ParcelAttrs>("parcels-ogc")!;
    await expect(source.queryExtent()).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  for (const variant of [
    {
      label: "geoservices-feature-service",
      path: "/rest/services/Parcels/FeatureServer/0/query",
      protocol: "geoservices-feature-service" as const,
    },
    {
      label: "geoservices-map-service",
      path: "/rest/services/Parcels/MapServer/0/query",
      protocol: "geoservices-map-service" as const,
    },
  ]) {
    it(`${variant.label}: throws from query() when aggregation is requested on a source without queryAggregate`, async () => {
      const client = makeMockClient({
        routes: [
          [
            variant.path,
            (url) => {
              const stats = url.searchParams.get("outStatistics");
              if (stats) return jsonResponse(geoservicesAggregateResponse());
              return jsonResponse(geoservicesQueryResponse());
            },
          ],
        ],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        capabilityPolicy: "strict",
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: capabilities(["query"]),
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      await expect(
        source.query({
          aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] },
        }),
      ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    });

    it(`${variant.label}: throws from query() when the source does not advertise query`, async () => {
      const client = makeMockClient({
        routes: [[variant.path, () => jsonResponse(geoservicesQueryResponse())]],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        capabilityPolicy: "strict",
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: capabilities([]),
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
      await expect(source.queryAll()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    });

    it(`${variant.label}: throws from stream() when the source does not advertise stream`, async () => {
      const client = makeMockClient({
        routes: [[variant.path, () => jsonResponse(geoservicesQueryResponse())]],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        capabilityPolicy: "strict",
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: capabilities(["query"]),
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      await expect(async () => {
        for await (const _page of source.stream()) {
          void _page;
          break;
        }
      }).rejects.toThrow(HonuaCapabilityNotSupportedError);
    });
  }

  it("ogc-features: throws from query()/queryAll() when query capability is missing", async () => {
    const client = makeMockClient({
      routes: [
        ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "strict",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: capabilities(["stream"]),
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryAll()).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("ogc-features: throws from stream() when stream capability is missing", async () => {
    const client = makeMockClient({
      routes: [
        ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "strict",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: capabilities(["query"]),
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    await expect(async () => {
      for await (const _page of source.stream()) {
        void _page;
        break;
      }
    }).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("contract / degraded capability policy", () => {
  // Under `degraded`, a missing capability may only be silently bypassed at
  // call sites that take a defined fallback path. GeoServices has none; OGC
  // has fallbacks for `queryAggregate` (client-side) and `queryExtent`
  // (metadata bbox). All other GeoServices / OGC paths must still throw.

  for (const variant of [
    {
      label: "geoservices-feature-service",
      path: "/rest/services/Parcels/FeatureServer/0/query",
      protocol: "geoservices-feature-service" as const,
    },
    {
      label: "geoservices-map-service",
      path: "/rest/services/Parcels/MapServer/0/query",
      protocol: "geoservices-map-service" as const,
    },
  ]) {
    function buildDegradedDataset(caps: ReadonlyArray<(typeof CAPABILITIES)[number]>): Dataset {
      const client = makeMockClient({
        routes: [
          [
            variant.path,
            (url) => {
              const stats = url.searchParams.get("outStatistics");
              if (stats) return jsonResponse(geoservicesAggregateResponse());
              const returnExtent = url.searchParams.get("returnExtentOnly") === "true";
              if (returnExtent) return jsonResponse(geoservicesExtentResponse());
              return jsonResponse(geoservicesQueryResponse());
            },
          ],
        ],
      });
      return createDataset({
        id: "parcels",
        client,
        capabilityPolicy: "degraded",
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: capabilities(caps),
          } satisfies SourceDescriptor,
        ],
      });
    }

    it(`${variant.label}: throws from query() when aggregation is requested and queryAggregate is not advertised`, async () => {
      const source = buildDegradedDataset(["query"]).source<ParcelAttrs>("parcels")!;
      await expect(
        source.query({
          aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] },
        }),
      ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    });

    it(`${variant.label}: throws from queryAggregate() when queryAggregate is not advertised`, async () => {
      const source = buildDegradedDataset(["query"]).source<ParcelAttrs>("parcels")!;
      await expect(
        source.queryAggregate({
          aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] },
        }),
      ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    });

    it(`${variant.label}: throws from query()/queryAll() when query is not advertised`, async () => {
      const source = buildDegradedDataset([]).source<ParcelAttrs>("parcels")!;
      await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
      await expect(source.queryAll()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    });

    it(`${variant.label}: throws from queryExtent() when queryExtent is not advertised`, async () => {
      const source = buildDegradedDataset(["query"]).source<ParcelAttrs>("parcels")!;
      await expect(source.queryExtent()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    });

    it(`${variant.label}: throws from stream() when stream is not advertised`, async () => {
      const source = buildDegradedDataset(["query"]).source<ParcelAttrs>("parcels")!;
      await expect(async () => {
        for await (const _page of source.stream()) {
          void _page;
          break;
        }
      }).rejects.toThrow(HonuaCapabilityNotSupportedError);
    });
  }

  function buildDegradedOgcDataset(caps: ReadonlyArray<(typeof CAPABILITIES)[number]>): Dataset {
    const client = makeMockClient({
      routes: [
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
        ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
      ],
    });
    return createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: capabilities(caps),
        },
      ],
    });
  }

  it("ogc-features: queryAggregate falls back to client-side aggregation and stamps degraded", async () => {
    const source = buildDegradedOgcDataset(["query"]).source<ParcelAttrs>("parcels-ogc")!;
    const result = await source.queryAggregate({
      aggregation: { groupBy: ["STATE"], metrics: [{ fn: "sum", field: "ACRES", alias: "SUM_ACRES" }] },
    });
    expect(result.aggregateRows).toBeDefined();
    expect(result.degraded?.[0]?.capability).toBe("queryAggregate");
  });

  it("ogc-features: queryExtent falls back to metadata bbox", async () => {
    const source = buildDegradedOgcDataset(["query"]).source<ParcelAttrs>("parcels-ogc")!;
    const out = await source.queryExtent();
    // Mock metadata advertises a bbox.
    if (out.extent) {
      expect(out.extent.xmin).toBeLessThanOrEqual(out.extent.xmax);
    }
  });

  it("ogc-features: stream still throws under degraded when stream is not advertised", async () => {
    const source = buildDegradedOgcDataset(["query"]).source<ParcelAttrs>("parcels-ogc")!;
    await expect(async () => {
      for await (const _page of source.stream()) {
        void _page;
        break;
      }
    }).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("ogc-features: query() and queryAll() throw under degraded when query is not advertised", async () => {
    const source = buildDegradedOgcDataset(["stream"]).source<ParcelAttrs>("parcels-ogc")!;
    await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryAll()).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("contract / GeoServices queryAll pagination limit", () => {
  for (const variant of [
    {
      label: "geoservices-feature-service",
      path: "/rest/services/Parcels/FeatureServer/0/query",
      protocol: "geoservices-feature-service" as const,
    },
    {
      label: "geoservices-map-service",
      path: "/rest/services/Parcels/MapServer/0/query",
      protocol: "geoservices-map-service" as const,
    },
  ]) {
    it(`${variant.label}: queryAll honors Query.pagination.limit`, async () => {
      const observedRecordCounts: string[] = [];
      const client = makeMockClient({
        routes: [
          [
            variant.path,
            (url) => {
              const recordCount = url.searchParams.get("resultRecordCount") ?? "";
              const offset = Number(url.searchParams.get("resultOffset") ?? "0");
              observedRecordCounts.push(recordCount);
              const clampedCount = recordCount ? Math.max(0, Number(recordCount)) : PARCEL_FEATURES.length;
              const slice = PARCEL_FEATURES.slice(offset, offset + clampedCount);
              return jsonResponse(geoservicesQueryResponse(slice));
            },
          ],
        ],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[variant.protocol],
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      const result = await source.queryAll({ pagination: { limit: 1 } });
      expect(result.features).toHaveLength(1);
      expect(result.totalCount).toBe(1);
      expect(observedRecordCounts[0]).toBe("1");
      // The core paging helper stops only on empty/short pages; without a
      // bounded maxPages the adapter would drain the full layer at
      // resultOffset=0,1,2,… Bounding keeps the network cost proportional to
      // `limit`: pageSize=1 + maxPages=2 ⇒ at most 2 requests, enough to
      // detect `exceededTransferLimit` via one lookahead row.
      expect(observedRecordCounts.length).toBeLessThanOrEqual(2);
      expect(result.exceededTransferLimit).toBe(true);
    });

    it(`${variant.label}: queryAll with unbounded limit drains the layer in one sweep`, async () => {
      const observedRecordCounts: string[] = [];
      const client = makeMockClient({
        routes: [
          [
            variant.path,
            (url) => {
              const recordCount = url.searchParams.get("resultRecordCount") ?? "";
              const offset = Number(url.searchParams.get("resultOffset") ?? "0");
              observedRecordCounts.push(recordCount);
              const clampedCount = recordCount ? Math.max(0, Number(recordCount)) : PARCEL_FEATURES.length;
              const slice = PARCEL_FEATURES.slice(offset, offset + clampedCount);
              return jsonResponse(geoservicesQueryResponse(slice));
            },
          ],
        ],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[variant.protocol],
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      const result = await source.queryAll();
      expect(result.features).toHaveLength(PARCEL_FEATURES.length);
      expect(result.exceededTransferLimit).toBe(false);
    });

    it(`${variant.label}: queryAll starts from Query.pagination.offset`, async () => {
      const observedOffsets: string[] = [];
      const client = makeMockClient({
        routes: [
          [
            variant.path,
            (url) => {
              observedOffsets.push(url.searchParams.get("resultOffset") ?? "");
              const offset = Number(url.searchParams.get("resultOffset") ?? "0");
              const recordCount = url.searchParams.get("resultRecordCount") ?? "";
              const clampedCount = recordCount ? Math.max(0, Number(recordCount)) : PARCEL_FEATURES.length;
              const slice = PARCEL_FEATURES.slice(offset, offset + clampedCount);
              return jsonResponse(geoservicesQueryResponse(slice));
            },
          ],
        ],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[variant.protocol],
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      const result = await source.queryAll({ pagination: { offset: 1, limit: 1 } });
      expect(result.features).toHaveLength(1);
      expect(result.features[0].attributes.OBJECTID).toBe(2);
      expect(observedOffsets[0]).toBe("1");
    });

    it(`${variant.label}: stream starts from Query.pagination.offset`, async () => {
      const observedOffsets: string[] = [];
      const client = makeMockClient({
        routes: [
          [
            variant.path,
            (url) => {
              observedOffsets.push(url.searchParams.get("resultOffset") ?? "");
              const offset = Number(url.searchParams.get("resultOffset") ?? "0");
              return jsonResponse(geoservicesQueryResponse(PARCEL_FEATURES.slice(offset, offset + 1)));
            },
          ],
        ],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[variant.protocol],
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      const pages: Array<ReadonlyArray<{ attributes: ParcelAttrs }>> = [];
      for await (const page of source.stream({ pagination: { offset: 1 } })) {
        pages.push(page.features as ReadonlyArray<{ attributes: ParcelAttrs }>);
        if (pages.length >= 1) break;
      }
      expect(pages.length).toBeGreaterThan(0);
      expect(pages[0][0].attributes.OBJECTID).toBe(2);
      expect(observedOffsets[0]).toBe("1");
    });
  }
});

describe("contract / GeoServices aggregation wire-level fields", () => {
  // Regression: the contract layer previously routed `outStatistics` /
  // `groupByFieldsForStatistics` through `extraParams`. The REST path
  // serialized them by accident (extraParams pass-through), but the gRPC
  // adapter only reads them from the root of `QueryFeaturesRequest`, so
  // grpc-web callers saw raw features instead of server aggregates. The
  // contract layer now writes them on the request root so both transports
  // observe them identically.
  for (const variant of [
    {
      label: "geoservices-feature-service",
      path: "/rest/services/Parcels/FeatureServer/0/query",
      protocol: "geoservices-feature-service" as const,
    },
    {
      label: "geoservices-map-service",
      path: "/rest/services/Parcels/MapServer/0/query",
      protocol: "geoservices-map-service" as const,
    },
  ]) {
    it(`${variant.label}: query({ aggregation }) passes outStatistics/groupBy on the request root`, async () => {
      const LayerClass =
        variant.protocol === "geoservices-feature-service" ? HonuaFeatureLayer : HonuaMapLayer;
      const spy = vi
        .spyOn(LayerClass.prototype, "queryFeatures")
        .mockResolvedValue(geoservicesAggregateResponse() as never);
      const client = makeMockClient({ routes: [] });
      const dataset = createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[variant.protocol],
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      await source.query({
        aggregation: { groupBy: ["STATE"], metrics: [{ fn: "sum", field: "ACRES", alias: "SUM_ACRES" }] },
      });
      await source.queryAggregate({
        aggregation: { metrics: [{ fn: "count", field: "OBJECTID", alias: "cnt" }] },
      });
      expect(spy).toHaveBeenCalledTimes(2);
      const first = spy.mock.calls[0][0] as {
        outStatistics?: unknown;
        groupByFieldsForStatistics?: unknown;
        returnGeometry?: unknown;
        extraParams?: { outStatistics?: unknown; groupByFieldsForStatistics?: unknown };
      };
      expect(Array.isArray(first.outStatistics)).toBe(true);
      expect(first.groupByFieldsForStatistics).toBe("STATE");
      expect(first.returnGeometry).toBe(false);
      // The wire-level fields must NOT leak back into extraParams; the gRPC
      // adapter whitelists extraParams keys and would drop them there.
      expect(first.extraParams?.outStatistics).toBeUndefined();
      expect(first.extraParams?.groupByFieldsForStatistics).toBeUndefined();
      const second = spy.mock.calls[1][0] as {
        outStatistics?: unknown;
        groupByFieldsForStatistics?: unknown;
        returnGeometry?: unknown;
      };
      expect(Array.isArray(second.outStatistics)).toBe(true);
      expect(second.groupByFieldsForStatistics).toBeUndefined();
      expect(second.returnGeometry).toBe(false);
      spy.mockRestore();
    });
  }
});

describe("contract / GeoServices stream honors Query.pagination.limit", () => {
  // Regression: the stream adapter previously dropped pagination.limit into
  // `resultRecordCount` only, which `queryFeaturesStream` then overwrote with
  // its own `pageSize` default (2000). source.stream({ pagination: { limit: 10 } })
  // should fetch 10-row pages, not 2000-row pages.
  for (const variant of [
    {
      label: "geoservices-feature-service",
      path: "/rest/services/Parcels/FeatureServer/0/query",
      protocol: "geoservices-feature-service" as const,
    },
    {
      label: "geoservices-map-service",
      path: "/rest/services/Parcels/MapServer/0/query",
      protocol: "geoservices-map-service" as const,
    },
  ]) {
    it(`${variant.label}: stream({ pagination: { limit: N } }) requests N-row pages`, async () => {
      const observedRecordCounts: string[] = [];
      const client = makeMockClient({
        routes: [
          [
            variant.path,
            (url) => {
              const recordCount = url.searchParams.get("resultRecordCount") ?? "";
              observedRecordCounts.push(recordCount);
              const offset = Number(url.searchParams.get("resultOffset") ?? "0");
              const take = recordCount ? Math.max(0, Number(recordCount)) : PARCEL_FEATURES.length;
              const slice = PARCEL_FEATURES.slice(offset, offset + take);
              return jsonResponse(geoservicesQueryResponse(slice));
            },
          ],
        ],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[variant.protocol],
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      const pages: Array<ReadonlyArray<{ attributes: ParcelAttrs }>> = [];
      for await (const page of source.stream({ pagination: { limit: 1 } })) {
        pages.push(page.features as ReadonlyArray<{ attributes: ParcelAttrs }>);
      }
      expect(pages.length).toBe(PARCEL_FEATURES.length);
      for (const count of observedRecordCounts) {
        expect(count).toBe("1");
      }
      for (const page of pages) {
        expect(page).toHaveLength(1);
      }
    });
  }
});

describe("contract / OGC queryAll pagination limit", () => {
  it("queryAll honors Query.pagination.limit and stamps exceededTransferLimit when more rows exist", async () => {
    const observedLimits: string[] = [];
    const client = makeMockClient({
      routes: [
        [
          "/ogc/features/collections/parcels/items",
          (url) => {
            const limit = url.searchParams.get("limit") ?? "";
            observedLimits.push(limit);
            const offset = Number(url.searchParams.get("offset") ?? "0");
            const take = limit ? Math.max(0, Number(limit)) : PARCEL_FEATURES.length;
            const slice = PARCEL_FEATURES.slice(offset, offset + take);
            return jsonResponse(ogcItemsResponse(slice));
          },
        ],
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    const result = await source.queryAll({ pagination: { limit: 1 } });
    expect(result.features).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    // The adapter must ask the server for one lookahead row (limit+1) so it
    // can distinguish "exactly `limit` rows matched" from "truncated".
    expect(observedLimits[0]).toBe("2");
    expect(result.exceededTransferLimit).toBe(true);
  });

  it("queryAll with limit equal to the full set reports exceededTransferLimit=false", async () => {
    const client = makeMockClient({
      routes: [
        [
          "/ogc/features/collections/parcels/items",
          (url) => {
            const limit = url.searchParams.get("limit") ?? "";
            const offset = Number(url.searchParams.get("offset") ?? "0");
            const take = limit ? Math.max(0, Number(limit)) : PARCEL_FEATURES.length;
            const slice = PARCEL_FEATURES.slice(offset, offset + take);
            return jsonResponse(ogcItemsResponse(slice));
          },
        ],
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    const result = await source.queryAll({ pagination: { limit: PARCEL_FEATURES.length } });
    expect(result.features).toHaveLength(PARCEL_FEATURES.length);
    expect(result.exceededTransferLimit).toBe(false);
  });
});

describe("contract / OGC materialized operations ignore Query.pagination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildDataset(): Dataset {
    const client = makeMockClient({ routes: [] });
    return createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
  }

  function mockItemsAllByRequest(): ReturnType<typeof vi.spyOn> {
    return vi
      .spyOn(HonuaOgcFeatureCollection.prototype, "itemsAll")
      .mockImplementation(async (request: HonuaOgcCollectionItemsAllRequest = {}) => {
        const offset = typeof request.offset === "number" ? request.offset : 0;
        const limit = typeof request.limit === "number" ? request.limit : PARCEL_FEATURES.length;
        return ogcItemsResponse(PARCEL_FEATURES.slice(offset, offset + limit)).features;
      });
  }

  it("queryAggregate drains the full match set even when pagination is supplied", async () => {
    const itemsAllSpy = mockItemsAllByRequest();
    const source = buildDataset().source<ParcelAttrs>("parcels-ogc")!;
    const result = await source.queryAggregate({
      pagination: { offset: 1, limit: 1 },
      aggregation: { groupBy: ["STATE"], metrics: [{ fn: "sum", field: "ACRES", alias: "SUM_ACRES" }] },
    });

    const request = itemsAllSpy.mock.calls[0][0] as HonuaOgcCollectionItemsAllRequest;
    expect(request.limit).toBeUndefined();
    expect(request.offset).toBeUndefined();
    expect(request.maxPages).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.features).toHaveLength(PARCEL_FEATURES.length);
    expect(result.aggregateRows).toEqual([
      { STATE: "CA", SUM_ACRES: 19.5 },
      { STATE: "OR", SUM_ACRES: 20 },
    ]);
  });

  it("queryExtent computes the filtered bbox from all matches even when pagination is supplied", async () => {
    const itemsAllSpy = mockItemsAllByRequest();
    const source = buildDataset().source<ParcelAttrs>("parcels-ogc")!;
    const out = await source.queryExtent({
      where: "1=1",
      pagination: { offset: 1, limit: 1 },
    });

    const request = itemsAllSpy.mock.calls[0][0] as HonuaOgcCollectionItemsAllRequest;
    expect(request.filter).toBe("1=1");
    expect(request.limit).toBeUndefined();
    expect(request.offset).toBeUndefined();
    expect(request.maxPages).toBe(Number.MAX_SAFE_INTEGER);
    expect(out).toEqual({
      extent: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
      count: PARCEL_FEATURES.length,
    });
  });
});

describe("contract / OGC queryExtent honors Query.outSr", () => {
  it("queryExtent({ outSr }) skips the metadata shortcut and drives through /items with crs set", async () => {
    let metadataCalls = 0;
    const observedCrs: string[] = [];
    const client = makeMockClient({
      routes: [
        [
          "/ogc/features/collections/parcels/items",
          (url) => {
            observedCrs.push(url.searchParams.get("crs") ?? "");
            // Return features with coordinates that would differ from the
            // metadata bbox if the adapter ever swapped to the shortcut.
            return jsonResponse(ogcItemsResponse());
          },
        ],
        [
          "/ogc/features/collections/parcels",
          () => {
            metadataCalls += 1;
            return jsonResponse(ogcCollectionMetadata());
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    const out = await source.queryExtent({ outSr: 3857 });
    // The bbox returned must come from the features, not the metadata bbox.
    expect(out.extent).toEqual({ xmin: -123, ymin: 37, xmax: -120, ymax: 45 });
    expect(metadataCalls).toBe(0);
    expect(observedCrs[0]).toBe("3857");
  });

  it("queryExtent() without outSr still takes the metadata shortcut", async () => {
    let itemsCalls = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/features/collections/parcels/items",
          () => {
            itemsCalls += 1;
            return jsonResponse(ogcItemsResponse());
          },
        ],
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    const out = await source.queryExtent();
    expect(out.extent).toEqual({ xmin: -123, ymin: 37, xmax: -120, ymax: 45 });
    // Shortcut path must avoid draining /items.
    expect(itemsCalls).toBe(0);
  });
});

describe("contract / Source.adapter() typed escape hatch", () => {
  it("narrows geoservices-feature-service to HonuaFeatureLayer at the type level", () => {
    const dataset = harnesses[0].build();
    const source = dataset.source("parcels-fs")!;
    const adapter = source.adapter("geoservices-feature-service");
    expect(adapter).toBeInstanceOf(HonuaFeatureLayer);
    // Compile-time assertion: AdapterFor<"geoservices-feature-service"> is HonuaFeatureLayer | undefined.
    const _typed: HonuaFeatureLayer | undefined = adapter;
    void _typed;
  });

  it("narrows geoservices-map-service to HonuaMapService and geoservices-map-layer to HonuaMapLayer", () => {
    const dataset = harnesses[1].build();
    const source = dataset.source("parcels-ms")!;
    const service = source.adapter("geoservices-map-service");
    const layer = source.adapter("geoservices-map-layer");
    expect(service).toBeInstanceOf(HonuaMapService);
    expect(layer).toBeInstanceOf(HonuaMapLayer);
    const _service: HonuaMapService | undefined = service;
    const _layer: HonuaMapLayer | undefined = layer;
    void _service;
    void _layer;
  });

  it("narrows ogc-features to HonuaOgcFeatureCollection", () => {
    const dataset = harnesses[2].build();
    const source = dataset.source("parcels-ogc")!;
    const adapter = source.adapter("ogc-features");
    expect(adapter).toBeInstanceOf(HonuaOgcFeatureCollection);
    const _typed: HonuaOgcFeatureCollection | undefined = adapter;
    void _typed;
  });
});

describe("contract / SourceDescriptor round-trip", () => {
  it("preserves identity, protocol, locator, and capabilities through a serializable shape", () => {
    const original: SourceDescriptor = {
      id: "parcels-fs",
      protocol: "geoservices-feature-service",
      locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
      attribution: "© Honua Test",
    };
    // Project to a SourceBinding-shaped object (sets serialized as sorted arrays).
    const wire = {
      id: original.id,
      protocol: original.protocol,
      locator: { ...original.locator },
      capabilities: [...original.capabilities].sort(),
      attribution: original.attribution,
    };
    // Re-import.
    const reimported: SourceDescriptor = {
      id: wire.id,
      protocol: wire.protocol,
      locator: { ...wire.locator },
      capabilities: capabilities(wire.capabilities as Array<(typeof CAPABILITIES)[number]>),
      attribution: wire.attribution,
    };
    expect(reimported.id).toBe(original.id);
    expect(reimported.protocol).toBe(original.protocol);
    expect(reimported.locator).toEqual(original.locator);
    expect([...reimported.capabilities].sort()).toEqual([...original.capabilities].sort());
    expect(reimported.attribution).toBe(original.attribution);
  });
});

async function* emptyAsyncGenerator(): AsyncGenerator<never, void, undefined> {}

describe("contract / queryAll + stream drain past the core default page cap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("geoservices-feature-service: queryAll overrides the 100-page core default", async () => {
    const spy = vi.spyOn(HonuaFeatureLayer.prototype, "queryFeaturesAll").mockResolvedValue([]);
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-fs",
          protocol: "geoservices-feature-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
        },
      ],
    });
    await dataset.source<ParcelAttrs>("parcels-fs")!.queryAll();
    const forwarded = spy.mock.calls[0][0] as { maxPages?: number } | undefined;
    expect(forwarded?.maxPages).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("geoservices-feature-service: stream overrides the 100-page core default", async () => {
    const spy = vi.spyOn(HonuaFeatureLayer.prototype, "queryFeaturesStream").mockImplementation(emptyAsyncGenerator);
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-fs",
          protocol: "geoservices-feature-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
        },
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;
    for await (const _page of source.stream()) {
      void _page;
    }
    const forwarded = spy.mock.calls[0][0] as { maxPages?: number } | undefined;
    expect(forwarded?.maxPages).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("geoservices-map-service: queryAll + stream override the 100-page core default", async () => {
    const allSpy = vi.spyOn(HonuaMapLayer.prototype, "queryFeaturesAll").mockResolvedValue([]);
    const streamSpy = vi.spyOn(HonuaMapLayer.prototype, "queryFeaturesStream").mockImplementation(emptyAsyncGenerator);
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ms",
          protocol: "geoservices-map-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-map-service"],
        },
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ms")!;
    await source.queryAll();
    for await (const _page of source.stream()) {
      void _page;
    }
    expect((allSpy.mock.calls[0][0] as { maxPages?: number }).maxPages).toBe(Number.MAX_SAFE_INTEGER);
    expect((streamSpy.mock.calls[0][0] as { maxPages?: number }).maxPages).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("ogc-features: queryAll + stream override the 100-page core default", async () => {
    const allSpy = vi.spyOn(HonuaOgcFeatureCollection.prototype, "itemsAll").mockResolvedValue([]);
    const streamSpy = vi
      .spyOn(HonuaOgcFeatureCollection.prototype, "itemsStream")
      .mockImplementation(emptyAsyncGenerator);
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        },
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    await source.queryAll();
    for await (const _page of source.stream()) {
      void _page;
    }
    expect((allSpy.mock.calls[0][0] as { maxPages?: number }).maxPages).toBe(Number.MAX_SAFE_INTEGER);
    expect((streamSpy.mock.calls[0][0] as { maxPages?: number }).maxPages).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("geoservices-feature-service: queryAll actually iterates past page 100 at runtime when unbounded", async () => {
    // The core helper's default `maxPages` is 100; without the contract
    // layer's unbounded override an unbounded `queryAll()` would silently
    // truncate at 100 pages. This test uses 101 full pages + a short page
    // to prove the adapter keeps paging until the source is exhausted when
    // the caller does not supply `pagination.limit`.
    const PAGE_SIZE = 2000;
    const TOTAL_PAGES = 101;
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      attributes: { OBJECTID: i + 1, STATE: "CA", ACRES: 1 } as ParcelAttrs,
      geometry: { x: 0, y: 0 },
    }));
    let fetchCount = 0;
    const client = makeMockClient({
      routes: [
        [
          "/rest/services/Parcels/FeatureServer/0/query",
          (url) => {
            fetchCount += 1;
            const offset = Number(url.searchParams.get("resultOffset") ?? "0");
            const page = Math.floor(offset / PAGE_SIZE);
            if (page >= TOTAL_PAGES) return jsonResponse(geoservicesQueryResponse([]));
            return jsonResponse(geoservicesQueryResponse(fullPage));
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-fs",
          protocol: "geoservices-feature-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
        },
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;
    const result = await source.queryAll();
    // 101 full pages + 1 empty terminator page = 102 fetches; the old
    // `maxPages=100` default would have stopped at exactly 100.
    expect(fetchCount).toBeGreaterThan(100);
    expect(result.features.length).toBe(TOTAL_PAGES * PAGE_SIZE);
  });
});

describe("contract / queryExtent forwards canonical filters", () => {
  for (const variant of [
    {
      label: "geoservices-feature-service",
      path: "/rest/services/Parcels/FeatureServer/0/query",
      protocol: "geoservices-feature-service" as const,
    },
    {
      label: "geoservices-map-service",
      path: "/rest/services/Parcels/MapServer/0/query",
      protocol: "geoservices-map-service" as const,
    },
  ]) {
    it(`${variant.label}: queryExtent forwards where + spatial filter + outSr`, async () => {
      const observed: URL[] = [];
      const client = makeMockClient({
        routes: [
          [
            variant.path,
            (url) => {
              observed.push(url);
              return jsonResponse(geoservicesExtentResponse());
            },
          ],
        ],
      });
      const dataset = createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels",
            protocol: variant.protocol,
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[variant.protocol],
          } satisfies SourceDescriptor,
        ],
      });
      const source = dataset.source<ParcelAttrs>("parcels")!;
      const out = await source.queryExtent({
        where: "STATE = 'CA'",
        outSr: 3857,
        spatialFilter: {
          geometryType: "esriGeometryEnvelope",
          geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
          spatialRel: "esriSpatialRelIntersects",
        },
      });
      expect(out.extent).toBeTruthy();
      expect(observed).toHaveLength(1);
      const hit = observed[0];
      expect(hit.searchParams.get("where")).toBe("STATE = 'CA'");
      expect(hit.searchParams.get("returnExtentOnly")).toBe("true");
      expect(hit.searchParams.get("returnGeometry")).toBe("false");
      expect(hit.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
      expect(hit.searchParams.get("spatialRel")).toBe("esriSpatialRelIntersects");
      expect(hit.searchParams.get("outSR")).toBe("3857");
      const rawGeometry = hit.searchParams.get("geometry");
      expect(rawGeometry).toBeTruthy();
      const parsed = JSON.parse(rawGeometry!) as { xmin: number; xmax: number };
      expect(parsed.xmin).toBe(-123);
      expect(parsed.xmax).toBe(-120);
    });
  }

  it("ogc-features degraded: queryExtent with a where filter computes bbox from matching items", async () => {
    const caMatches = PARCEL_FEATURES.filter((f) => f.attributes.STATE === "CA");
    let metadataHits = 0;
    let itemsHits = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/features/collections/parcels/items",
          () => {
            itemsHits += 1;
            return jsonResponse(ogcItemsResponse(caMatches));
          },
        ],
        [
          "/ogc/features/collections/parcels",
          () => {
            metadataHits += 1;
            return jsonResponse(ogcCollectionMetadata());
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    const out = await source.queryExtent({ where: "STATE = 'CA'" });
    // Must drain the items endpoint, not the collection metadata bbox.
    expect(itemsHits).toBeGreaterThanOrEqual(1);
    expect(metadataHits).toBe(0);
    expect(out.extent).toBeTruthy();
    // Features are CA only: x in {-120, -121}, y in {38, 37}.
    expect(out.extent!.xmin).toBe(-121);
    expect(out.extent!.xmax).toBe(-120);
    expect(out.extent!.ymin).toBe(37);
    expect(out.extent!.ymax).toBe(38);
  });

  it("ogc-features: rejects non-envelope spatialFilter rather than silently dropping it", async () => {
    let itemsHits = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/features/collections/parcels/items",
          () => {
            itemsHits += 1;
            return jsonResponse(ogcItemsResponse());
          },
        ],
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    // OGC only exposes bbox at /items; a polygon filter cannot be translated
    // without CQL2. The adapter must refuse rather than drop the constraint
    // and return unfiltered features.
    const polygonFilter = {
      geometryType: "esriGeometryPolygon" as const,
      geometry: {
        rings: [
          [
            [-121, 37],
            [-121, 38],
            [-120, 38],
            [-120, 37],
            [-121, 37],
          ],
        ],
      },
      spatialRel: "esriSpatialRelIntersects" as const,
    };
    await expect(source.query({ spatialFilter: polygonFilter })).rejects.toThrow(
      /geometryType "esriGeometryPolygon" is not supported/,
    );
    await expect(source.queryAll({ spatialFilter: polygonFilter })).rejects.toThrow(
      /geometryType "esriGeometryPolygon" is not supported/,
    );
    // No items call should have been issued; the error surfaces before
    // the request is dispatched.
    expect(itemsHits).toBe(0);
  });

  it("ogc-features: rejects non-intersects spatial relationships rather than collapsing them to bbox-intersects", async () => {
    let itemsHits = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/features/collections/parcels/items",
          () => {
            itemsHits += 1;
            return jsonResponse(ogcItemsResponse());
          },
        ],
        ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    // `contains` / `within` restrict the result set more strictly than bbox
    // intersects. Issuing the same /items?bbox=... request would silently
    // broaden the match; the adapter must refuse rather than drift.
    for (const rel of ["esriSpatialRelContains", "esriSpatialRelWithin", "esriSpatialRelCrosses"] as const) {
      await expect(
        source.query({
          spatialFilter: {
            geometryType: "esriGeometryEnvelope",
            geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
            spatialRel: rel,
          },
        }),
      ).rejects.toThrow(/spatialRel .* is not supported/);
    }
    // Envelope-intersects stays supported: bbox carries its semantics exactly.
    await source.query({
      spatialFilter: {
        geometryType: "esriGeometryEnvelope",
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        spatialRel: "esriSpatialRelEnvelopeIntersects",
      },
    });
    expect(itemsHits).toBeGreaterThanOrEqual(1);
  });

  it("ogc-features degraded: bare queryExtent() still uses the metadata bbox shortcut", async () => {
    let metadataHits = 0;
    let itemsHits = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/features/collections/parcels/items",
          () => {
            itemsHits += 1;
            return jsonResponse(ogcItemsResponse());
          },
        ],
        [
          "/ogc/features/collections/parcels",
          () => {
            metadataHits += 1;
            return jsonResponse(ogcCollectionMetadata());
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ogc",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    const out = await source.queryExtent();
    expect(metadataHits).toBe(1);
    expect(itemsHits).toBe(0);
    expect(out.extent).toBeTruthy();
  });
});
