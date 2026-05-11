import { describe, expect, it } from "vitest";

import {
  type QueryTileFeatureIdentityTarget,
  type Source,
  type SourceDescriptor,
  buildQueryTileCacheKey,
  buildQueryTileFeatureDetailQuery,
  capabilities,
  defineQueryTileSource,
  loadQueryTileFeatureDetail,
  mapQueryTileFeatureIdentity,
  normalizeQueryTileKey,
  queryTileKeyString,
} from "../../src/contract/index.js";

const sourceDescriptor: SourceDescriptor = {
  id: "parcels",
  protocol: "geoservices-feature-service",
  locator: {
    url: "https://gis.example.test/rest/services/Parcels/FeatureServer/0",
    serviceId: "Parcels",
    layerId: 0,
  },
  capabilities: capabilities(["query", "queryObjectIds"]),
  attribution: "Example County",
};

describe("query tile contract", () => {
  it("normalizes descriptors and tile/cache keys", () => {
    const descriptor = defineQueryTileSource({
      id: "parcels-query-tiles",
      source: sourceDescriptor,
      endpoint: { baseUrl: "https://tiles.example.test/query" },
      query: { where: "STATUS = 'open'", outFields: ["OBJECTID", "STATUS"], returnGeometry: true },
      projection: { fields: ["OBJECTID", "STATUS"] },
      cache: {
        maxEntries: 128,
        key: {
          sourceVersion: "version-7",
          authorizationScope: "tenant:alpha",
          styleFilters: { status: "open" },
        },
      },
      featureIdentity: { idProperty: "OBJECTID" },
    });

    expect(descriptor.kind).toBe("query-vector-tile");
    expect(descriptor.sourceId).toBe("parcels");
    expect(descriptor.protocol).toBe("geoservices-feature-service");
    expect(descriptor.format).toBe("mvt");
    expect(descriptor.attribution).toBe("Example County");

    expect(normalizeQueryTileKey({ z: 4, x: 20, y: -1 })).toEqual({ z: 4, x: 4, y: 0 });
    expect(queryTileKeyString({ tileMatrix: "4", tileCol: "20", tileRow: "-1" })).toBe("4/4/0");

    const a = buildQueryTileCacheKey(descriptor, { z: 4, x: 20, y: -1 });
    const b = buildQueryTileCacheKey(descriptor, { z: 4, x: 4, y: 0 });
    const c = buildQueryTileCacheKey(descriptor, { z: 4, x: 4, y: 0 }, { cache: { sourceVersion: "version-8" } });

    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(a).toContain("tenant:alpha");
    expect(a).toContain("version-7");
  });

  it("maps rendered tile features back to canonical feature identity", () => {
    const descriptor = defineQueryTileSource({
      id: "parcels-query-tiles",
      source: sourceDescriptor,
      endpoint: { urlTemplate: "https://tiles.example.test/{z}/{x}/{y}.mvt" },
      featureIdentity: {
        idProperty: ["canonical_id", "OBJECTID"],
        sourceIdProperty: "source_id",
        sourceLayerProperty: "layer_name",
      },
    });

    const target = mapQueryTileFeatureIdentity(descriptor, {
      id: "maplibre-id",
      sourceLayer: "fallback-layer",
      properties: {
        OBJECTID: 42,
        source_id: "parcels",
        layer_name: "parcels-fill",
      },
    });

    expect(target).toMatchObject<QueryTileFeatureIdentityTarget>({
      sourceId: "parcels",
      id: 42,
      sourceLayer: "parcels-fill",
    });
  });

  it("builds and executes selected-feature detail queries", async () => {
    let observedQuery: unknown;
    const source = {
      query: async (query: unknown) => {
        observedQuery = query;
        return {
          features: [{ attributes: { OBJECTID: 42, STATUS: "open" } }],
          exceededTransferLimit: false,
        };
      },
    } as unknown as Source<{ OBJECTID: number; STATUS: string }>;
    const target: QueryTileFeatureIdentityTarget = { sourceId: "parcels", id: 42 };
    const descriptor = defineQueryTileSource({
      id: "parcels-query-tiles",
      source: sourceDescriptor,
      endpoint: { baseUrl: "https://tiles.example.test/query" },
      featureIdentity: { idProperty: "OBJECTID" },
    });

    expect(
      buildQueryTileFeatureDetailQuery({
        source,
        target,
        descriptor,
        baseQuery: { where: "STATUS = 'open'" },
      }).where,
    ).toBe("(STATUS = 'open') AND (OBJECTID = 42)");

    const detail = await loadQueryTileFeatureDetail({
      source,
      target,
      descriptor,
      baseQuery: { where: "STATUS = 'open'", outFields: ["OBJECTID"] },
      outFields: ["OBJECTID", "STATUS"],
    });

    expect(detail?.attributes.STATUS).toBe("open");
    expect(observedQuery).toMatchObject({
      where: "(STATUS = 'open') AND (OBJECTID = 42)",
      outFields: ["OBJECTID", "STATUS"],
      returnGeometry: true,
      pagination: { limit: 1 },
    });
  });
});
