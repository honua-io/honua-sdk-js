import { describe, expect, it, vi } from "vitest";

import type { QueryTileSourceDescriptor, Source } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { createQueryTileDetailLoader, hitTestMap, normalizeHitTestFeatures } from "../src/index.js";
import type { HonuaHitTestMap } from "../src/index.js";
import { HonuaMap } from "../src/map/index.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, HonuaMapRuntime, type MaplibreMap } from "../src/runtime/index.js";

const queryTileDescriptor: QueryTileSourceDescriptor = {
  kind: "query-vector-tile",
  id: "incidents-tiles",
  sourceId: "incidents",
  protocol: "geoservices-feature-service",
  source: {
    id: "incidents",
    protocol: "geoservices-feature-service",
    locator: { url: "https://server.example.com/FeatureServer/0" },
    capabilities: new Set(),
  },
  featureIdentity: {
    idProperty: "incident_id",
    sourceLayerProperty: "source_layer",
  },
};

describe("hit-test normalization", () => {
  it("returns an unsupported degraded state when the renderer cannot query rendered features", async () => {
    const hit = await hitTestMap({ unproject: () => ({ lng: -157.8, lat: 21.3 }) }, { point: [10, 20] });

    expect(hit).toMatchObject({
      point: { x: 10, y: 20 },
      lngLat: [-157.8, 21.3],
      features: [],
      degraded: [{ reason: "renderer-unsupported" }],
    });
  });

  it("normalizes multiple rendered features with source-qualified identities and max results", () => {
    const hits = normalizeHitTestFeatures(
      [
        {
          id: 101,
          layer: { id: "parcels-fill", source: "parcels", "source-layer": "parcel-polygons" },
          properties: { name: "A" },
          geometry: { type: "Polygon" },
        },
        {
          layer: { id: "assets-circle", source: "assets" },
          properties: { OBJECTID: 7 },
          geometry: { type: "Point" },
        },
      ],
      { maxResults: 2 },
    );

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      layerId: "parcels-fill",
      sourceId: "parcels",
      sourceLayer: "parcel-polygons",
      featureId: 101,
      selectionTarget: { sourceId: "parcels", id: 101, sourceLayer: "parcel-polygons" },
    });
    expect(hits[1]).toMatchObject({
      sourceId: "assets",
      featureId: 7,
      selectionTarget: { sourceId: "assets", id: 7 },
    });
  });

  it("surfaces degraded states for missing source bindings, ids, geometry, and lngLat", async () => {
    const map: HonuaHitTestMap = {
      queryRenderedFeatures: () => [{ layer: { id: "orphan" }, properties: { name: "No id" } }],
    };
    const hit = await hitTestMap(map, { point: { x: 5, y: 6 } });

    expect(hit.degraded.map((entry) => entry.reason)).toContain("lnglat-unavailable");
    expect(hit.features[0].degraded.map((entry) => entry.reason)).toEqual([
      "source-binding-unavailable",
      "feature-id-unavailable",
      "geometry-unavailable",
    ]);
  });

  it("maps query-tile identities and composes selected feature detail loading", async () => {
    const source = {
      query: vi.fn(async (query) => ({
        features: [
          { id: "inc-42", attributes: { incident_id: "inc-42", status: "open" }, geometry: { type: "Point" } },
        ],
        totalCount: 1,
        query,
      })),
    } as unknown as Source;
    const detailLoader = createQueryTileDetailLoader({ incidents: source }, { incidents: queryTileDescriptor });

    const hit = await hitTestMap(
      {
        unproject: () => [-157.8, 21.3],
        queryRenderedFeatures: () => [
          {
            layer: { id: "incidents-symbol", source: "incidents" },
            properties: { incident_id: "inc-42", source_layer: "incidents" },
            geometry: { type: "Point" },
          },
        ],
      },
      { point: [100, 120] },
      {
        loadDetails: true,
        queryTileSources: { incidents: queryTileDescriptor },
        detailLoader,
      },
    );

    expect(hit.features[0]).toMatchObject({
      sourceId: "incidents",
      sourceLayer: "incidents",
      featureId: "inc-42",
      detail: { id: "inc-42" },
    });
    expect(source.query).toHaveBeenCalledWith(
      expect.objectContaining({
        where: "incident_id = 'inc-42'",
        returnGeometry: true,
        pagination: { limit: 1 },
      }),
    );
  });
});

describe("HonuaMapRuntime hitTest", () => {
  it("queries a MapLibre-like renderer with layer context from the current style", async () => {
    const map = makeRuntimeMap([
      {
        layer: { id: "incidents-symbol" },
        properties: { incident_id: "inc-42" },
        geometry: { type: "Point" },
      },
    ]);
    const runtime = new HonuaMapRuntime({
      map,
      honuaMap: new HonuaMap({ client: makeClient() }),
      dataset: { source: () => undefined } as never,
      composedStyle: {
        version: 8,
        sources: { incidents: { type: "vector" } },
        layers: [{ id: "incidents-symbol", type: "circle", source: "incidents", "source-layer": "live" }],
      },
      packageRef: {
        current: {
          mapPackageId: "pkg-hit-test",
          format: HONUA_MAP_PACKAGE_FORMAT_V1,
          sourceBindings: [
            {
              sourceId: "incidents",
              protocol: "geoservices_feature_service",
              locator: { url: "https://server.example.com/FeatureServer/0" },
            },
          ],
          mapSpec: { version: 8, sources: {}, layers: [] },
        },
      },
      styleSpecValidationMode: "renderer-deferred",
      reload: async () => {
        throw new Error("not used");
      },
    });

    const hit = await runtime.hitTest(
      { point: { x: 11, y: 12 } },
      { layers: ["incidents-symbol"], featureIdProperty: "incident_id", tolerance: 4 },
    );

    expect(map.queries[0]).toEqual({
      geometry: [
        { x: 7, y: 8 },
        { x: 15, y: 16 },
      ],
      options: { layers: ["incidents-symbol"] },
    });
    expect(hit.lngLat).toEqual([-157.8, 21.3]);
    expect(hit.features[0]).toMatchObject({
      layerId: "incidents-symbol",
      sourceId: "incidents",
      sourceLayer: "live",
      featureId: "inc-42",
    });
  });
});

function makeClient(): HonuaClient {
  return new HonuaClient({
    baseUrl: "https://mock.honua.test",
    fetchFn: async () => new Response("not used", { status: 200 }),
  });
}

function makeRuntimeMap(features: readonly unknown[]): MaplibreMap & {
  queries: Array<{ geometry: unknown; options: unknown }>;
} {
  const queries: Array<{ geometry: unknown; options: unknown }> = [];
  return {
    queries,
    setStyle() {},
    setFeatureState() {},
    getFeatureState() {
      return {};
    },
    removeFeatureState() {},
    on() {},
    off() {},
    queryRenderedFeatures(geometry: unknown, options: unknown) {
      queries.push({ geometry, options });
      return features;
    },
    unproject() {
      return { lng: -157.8, lat: 21.3 };
    },
  };
}
