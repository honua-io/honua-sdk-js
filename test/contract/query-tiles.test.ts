import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  QUERY_TILE_SERVER_CONTRACT_VERSION,
  QUERY_TILE_SERVER_ROUTE_PREFIX,
  type QueryTileFeatureIdentityTarget,
  type QueryTileServerContractFixture,
  type Source,
  type SourceDescriptor,
  buildQueryTileCacheKey,
  buildQueryTileFeatureDetailQuery,
  buildQueryTileServerPath,
  buildQueryTileServerUrl,
  capabilities,
  defineQueryTileSource,
  loadQueryTileFeatureDetail,
  mapQueryTileFeatureIdentity,
  normalizeQueryTileKey,
  parseQueryTileFeatureDetailResponse,
  parseQueryTileJson,
  parseQueryTileServerErrorResponse,
  queryTileKeyString,
  queryTileServerRequestParamsFromDescriptor,
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

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/sdk-contract");
const queryTileFixture = JSON.parse(
  readFileSync(resolve(fixturesDir, "query-tile-server.v1.json"), "utf8"),
) as QueryTileServerContractFixture<{ id: string; severity: number; status: string }>;

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

  it("defines canonical server routes and request parameters", () => {
    const descriptor = defineQueryTileSource({
      id: "incidents-query-tiles",
      source: {
        id: "incidents",
        protocol: "ogc-features",
        locator: { url: "https://honua.example.test/ogc/collections/incidents" },
        capabilities: capabilities(["query", "queryObjectIds"]),
      },
      endpoint: { baseUrl: "https://honua.example.test/query-tiles" },
      tileMatrixSet: "WebMercatorQuad",
      query: { where: "severity >= 3", outFields: ["id", "severity", "status"], returnGeometry: true, outSr: 3857 },
      projection: { fields: ["id", "severity", "status"], returnGeometry: true, simplifyTolerance: 1.5 },
      featureIdentity: { idProperty: "id", promoteId: "id" },
    });

    expect(QUERY_TILE_SERVER_CONTRACT_VERSION).toBe(1);
    expect(QUERY_TILE_SERVER_ROUTE_PREFIX).toBe("query-tiles");
    expect(buildQueryTileServerPath("tilejson", { sourceId: "incidents" })).toBe(
      "/query-tiles/sources/incidents/tilejson.json",
    );
    expect(buildQueryTileServerPath("tile", { sourceId: "incidents" })).toBe(
      "/query-tiles/sources/incidents/tiles/{z}/{x}/{y}.mvt",
    );
    expect(buildQueryTileServerPath("feature-detail", { sourceId: "incidents" })).toBe(
      "/query-tiles/sources/incidents/features/{featureId}",
    );

    const tileUrl = new URL(
      buildQueryTileServerUrl("tile", {
        baseUrl: "https://honua.example.test",
        sourceId: "incidents",
        tileKey: { z: 6, x: 9, y: 23 },
        query: descriptor.query,
        projection: descriptor.projection,
        params: {
          tileMatrixSet: descriptor.tileMatrixSet,
          extent: [-158.3, 21.2, -157.6, 21.8],
          extentSr: 4326,
          maxFeatures: 500,
        },
      }),
    );

    expect(tileUrl.pathname).toBe("/query-tiles/sources/incidents/tiles/6/9/23.mvt");
    expect(tileUrl.searchParams.get("where")).toBe("severity >= 3");
    expect(tileUrl.searchParams.get("outFields")).toBe("id,severity,status");
    expect(tileUrl.searchParams.get("returnGeometry")).toBe("true");
    expect(tileUrl.searchParams.get("outSr")).toBe("3857");
    expect(tileUrl.searchParams.get("tileMatrixSet")).toBe("WebMercatorQuad");
    expect(tileUrl.searchParams.get("projection")).toBe("id,severity,status");
    expect(tileUrl.searchParams.get("simplifyTolerance")).toBe("1.5");
    expect(tileUrl.searchParams.get("maxFeatures")).toBe("500");

    expect(queryTileServerRequestParamsFromDescriptor(descriptor)).toMatchObject({
      where: "severity >= 3",
      outFields: ["id", "severity", "status"],
      outSr: 3857,
      tileMatrixSet: "WebMercatorQuad",
      projection: ["id", "severity", "status"],
      simplifyTolerance: 1.5,
    });
  });

  it("validates the reusable query tile server contract fixture", () => {
    expect(queryTileFixture.schemaVersion).toBe(1);
    expect(queryTileFixture.routePrefix).toBe("/query-tiles");
    expect(queryTileFixture.routes).toEqual({
      tilejson: "/query-tiles/sources/{sourceId}/tilejson.json",
      tile: "/query-tiles/sources/{sourceId}/tiles/{z}/{x}/{y}.mvt",
      "feature-detail": "/query-tiles/sources/{sourceId}/features/{featureId}",
    });

    const tilejson = parseQueryTileJson(queryTileFixture.tilejsonResponse);
    expect(tilejson["honua:queryTiles"]).toMatchObject({
      contractVersion: 1,
      sourceId: "incidents",
      tileMatrixSet: "WebMercatorQuad",
      format: "mvt",
      featureIdentity: { sourceId: "incidents", idProperty: "id" },
      limits: { maxFeaturesPerTile: 500 },
    });
    expect(tilejson.tiles[0]).toContain("/query-tiles/sources/incidents/tiles/{z}/{x}/{y}.mvt");

    const detail = parseQueryTileFeatureDetailResponse(queryTileFixture.detailResponse);
    expect(detail.identity).toMatchObject({ sourceId: "incidents", id: "incident-42" });
    expect(detail.feature?.attributes.status).toBe("open");
    expect(detail.cache?.etag).toBe('"incident-42-v7"');

    const error = parseQueryTileServerErrorResponse(queryTileFixture.errorResponse);
    expect(error.error).toMatchObject({
      code: "max-features-exceeded",
      status: 422,
    });
    expect(error.error.degraded?.[0]).toMatchObject({
      code: "max-features-exceeded",
      maxFeatures: 500,
      omittedFeatures: 37,
    });
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
