/**
 * Cross-protocol conformance suite. The same canonical query / aggregation
 * / streaming scenarios are dispatched against each adapter's `Source`.
 *
 * Adding a new adapter (WFS / WMS / OData) means adding a `protocols`
 * entry below — every scenario then runs against the new adapter without
 * test-side changes.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  PROTOCOL_DEFAULT_CAPABILITIES,
  PROTOCOLS,
  capabilities,
  createDataset,
  type Dataset,
  type Protocol,
  type Query,
  type Source,
  type SourceDescriptor,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";

import {
  geoservicesAggregateResponse,
  geoservicesExtentResponse,
  geoservicesQueryResponse,
  jsonResponse,
  makeMockClient,
  ogcCollectionMetadata,
  ogcItemsResponse,
  PARCEL_FEATURES,
  type ParcelAttrs,
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
          { id: "a", protocol: "geoservices-feature-service", locator: { url: "u", serviceId: "S", layerId: 0 }, capabilities: capabilities([]) },
          { id: "a", protocol: "geoservices-feature-service", locator: { url: "u", serviceId: "S", layerId: 1 }, capabilities: capabilities([]) },
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
        { id: "wfs-1", protocol: "wfs", locator: { url: "u", typeName: "ns:foo" }, capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs },
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
        { id: "wfs-1", protocol: "wfs", locator: { url: "u", typeName: "ns:foo" }, capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs },
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
  }
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
