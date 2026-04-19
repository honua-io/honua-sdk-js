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

  it("geoservices-feature-service: queryAll actually iterates past page 100 at runtime", async () => {
    // The core helper's default pageSize is 2000 and it terminates when a
    // page returns fewer than pageSize features. Returning full pages for
    // 101 iterations (plus an empty terminator) forces the >100-page loop.
    // The result is clipped to the caller's limit so the test asserts on
    // the fetch count rather than materializing all features.
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
    const result = await source.queryAll({ pagination: { limit: PAGE_SIZE } });
    // 101 full pages + 1 empty terminator page = 102 fetches; the old
    // code would have stopped at exactly 100.
    expect(fetchCount).toBeGreaterThan(100);
    expect(result.features.length).toBe(PAGE_SIZE);
  });
});
