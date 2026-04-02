import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createExampleConfig,
  createLiveQueryRequest,
  loadRouteSource,
  normalizeRoutePlaybackSource,
} from "../docs/examples/cesium-route-playback/data-path.mjs";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), "utf8")) as Record<string, unknown>;
}

const MULTI_FEATURE_QUERY_RESPONSE = {
  geometryType: "esriGeometryPolyline",
  features: [
    {
      attributes: {
        route_id: "dense-short",
        route_name: "Dense short connector",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-157.85825, 21.30695, 12],
            [-157.8582, 21.307, 12],
            [-157.85815, 21.30705, 12],
            [-157.8581, 21.3071, 12],
          ],
        ],
      },
    },
    {
      attributes: {
        route_id: "intended-long",
        route_name: "Intended long route",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-156.5, 21.3069, 12],
          ],
        ],
      },
    },
  ],
};

const MULTI_FEATURE_QUERY_RESPONSE_WITH_ALIAS_ROUTE_ID = {
  geometryType: "esriGeometryPolyline",
  features: [
    {
      attributes: {
        routeId: "dense-short",
        route_name: "Dense short connector",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-157.85825, 21.30695, 12],
            [-157.8582, 21.307, 12],
            [-157.85815, 21.30705, 12],
            [-157.8581, 21.3071, 12],
          ],
        ],
      },
    },
    {
      attributes: {
        routeId: "intended-long",
        route_name: "Intended long route",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-156.5, 21.3069, 12],
          ],
        ],
      },
    },
  ],
};

const MULTI_FEATURE_QUERY_RESPONSE_WITH_NUMERIC_ROUTE_ID = {
  geometryType: "esriGeometryPolyline",
  features: [
    {
      attributes: {
        route_id: 7,
        route_name: "Dense short connector",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-157.85825, 21.30695, 12],
            [-157.8582, 21.307, 12],
            [-157.85815, 21.30705, 12],
            [-157.8581, 21.3071, 12],
          ],
        ],
      },
    },
    {
      attributes: {
        route_id: 42,
        route_name: "Numeric route id",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-156.5, 21.3069, 12],
          ],
        ],
      },
    },
  ],
};

const MULTI_FEATURE_QUERY_RESPONSE_WITH_CUSTOM_ROUTE_ID = {
  geometryType: "esriGeometryPolyline",
  features: [
    {
      attributes: {
        custom_route: "dense-short",
        route_name: "Dense short connector",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-157.85825, 21.30695, 12],
            [-157.8582, 21.307, 12],
            [-157.85815, 21.30705, 12],
            [-157.8581, 21.3071, 12],
          ],
        ],
      },
    },
    {
      attributes: {
        custom_route: "intended-long",
        route_name: "Custom mapped route",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-156.5, 21.3069, 12],
          ],
        ],
      },
    },
  ],
};

const MULTI_FEATURE_QUERY_RESPONSE_WITH_CUSTOM_ROUTE_ID_ALIAS_CONFLICT = {
  geometryType: "esriGeometryPolyline",
  features: [
    {
      attributes: {
        custom_route: "dense-short",
        route_id: "intended-long",
        route_name: "Alias trap route",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-157.85825, 21.30695, 12],
            [-157.8582, 21.307, 12],
            [-157.85815, 21.30705, 12],
            [-157.8581, 21.3071, 12],
          ],
        ],
      },
    },
    {
      attributes: {
        custom_route: "intended-long",
        route_id: "other-alias",
        route_name: "Custom mapped route",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-156.5, 21.3069, 12],
          ],
        ],
      },
    },
  ],
};

const SINGLE_FEATURE_QUERY_RESPONSE_WITHOUT_ROUTE_ID = {
  geometryType: "esriGeometryPolyline",
  features: [
    {
      attributes: {
        route_name: "Route without explicit id",
      },
      geometry: {
        paths: [
          [
            [-157.8583, 21.3069, 12],
            [-157.8582, 21.307, 12],
            [-157.8581, 21.3071, 12],
          ],
        ],
      },
    },
  ],
};

type MockInterceptor = {
  after?: (context: { durationMs: number }) => void;
  error?: (context: { durationMs?: number }) => void;
};

type MockClientOptions = {
  baseUrl: string;
  fetchFn?: typeof fetch;
  interceptors?: MockInterceptor[];
};

function createMockHonuaClient(queryResponse: Record<string, unknown>) {
  return class MockHonuaClient {
    interceptors: MockInterceptor[];

    constructor(options: MockClientOptions) {
      this.interceptors = options.interceptors ?? [];
    }

    async checkCompatibility() {
      return {
        supported: true,
        reasons: [],
      };
    }

    async queryFeatures() {
      for (const interceptor of this.interceptors) {
        interceptor.after?.({ durationMs: 12 });
      }
      return queryResponse;
    }
  };
}

describe("Cesium route playback example helpers", () => {
  it("defaults the live query bounds when URL parameters are omitted", () => {
    const config = createExampleConfig("?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0");

    expect(config.mode).toBe("live");
    expect(config.resultRecordCount).toBe(1);
    expect(config.routeId).toBe("");
    expect(config.routeIdField).toBe("");
    expect(config.speedMetersPerSecond).toBe(18);
  });

  it("builds a bounded live query request in WGS84 with returnZ enabled", () => {
    const request = createLiveQueryRequest({
      serviceId: "transport",
      layerId: 3,
      where: "route_id = 'demo-route'",
      resultRecordCount: 1,
      objectIds: "15",
    });

    expect(request).toEqual({
      serviceId: "transport",
      layerId: 3,
      where: "route_id = 'demo-route'",
      objectIds: "15",
      outFields: ["*"],
      outSr: 4326,
      returnGeometry: true,
      resultRecordCount: 1,
      extraParams: {
        outSr: 4326,
        returnZ: true,
      },
    });
  });

  it("normalizes a Honua polyline fixture into playback samples", () => {
    const manifest = readJson("../docs/examples/cesium-route-playback/fixtures/source-manifest.json");
    const queryResponse = readJson("../docs/examples/cesium-route-playback/fixtures/route-query-response.json");

    const normalized = normalizeRoutePlaybackSource(
      {
        sourceMode: "fixture",
        manifest,
        queryRequest: manifest.query,
        queryResponse,
      },
      { speedMetersPerSecond: 18 },
    );

    expect(normalized.routeName).toBe("Honolulu Ridge Shuttle");
    expect(normalized.routeId).toBe("route-playback-demo");
    expect(normalized.featureCount).toBe(1);
    expect(normalized.vertexCount).toBe(8);
    expect(normalized.hasZ).toBe(true);
    expect(normalized.playbackDurationSeconds).toBeGreaterThan(0);
    expect(normalized.totalDistanceMeters).toBeGreaterThan(0);
    expect(normalized.playbackSamples[0]).toMatchObject({
      longitude: -157.8583,
      latitude: 21.3069,
      sourceZ: 12,
      heightMeters: 12,
      distanceMeters: 0,
      secondsFromStart: 0,
    });
    expect(normalized.playbackSamples.at(-1)?.distanceMeters).toBeGreaterThan(0);
    expect(normalized.preprocessingSteps).toContain("Loaded a checked-in Honua FeatureServer/query fixture for deterministic playback.");
  });

  it("matches an explicit routeId in live multi-feature responses", async () => {
    const config = createExampleConfig(
      "?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0&routeId=intended-long&resultRecordCount=2",
    );
    const source = await loadRouteSource(config, {
      HonuaClient: createMockHonuaClient(MULTI_FEATURE_QUERY_RESPONSE),
    });

    const normalized = normalizeRoutePlaybackSource(source, config);

    expect(source.manifest).toMatchObject({
      query: {
        routeIdValue: "intended-long",
      },
    });
    expect(normalized.routeId).toBe("intended-long");
    expect(normalized.routeName).toBe("Intended long route");
    expect(normalized.vertexCount).toBe(2);
  });

  it("matches an explicit routeId against alias fields in live multi-feature responses", async () => {
    const config = createExampleConfig(
      "?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0&routeId=intended-long&resultRecordCount=2",
    );
    const source = await loadRouteSource(config, {
      HonuaClient: createMockHonuaClient(MULTI_FEATURE_QUERY_RESPONSE_WITH_ALIAS_ROUTE_ID),
    });

    const normalized = normalizeRoutePlaybackSource(source, config);

    expect(source.manifest).toMatchObject({
      fieldMapping: {
        routeId: null,
      },
      query: {
        routeIdValue: "intended-long",
      },
    });
    expect(normalized.routeId).toBe("intended-long");
    expect(normalized.routeName).toBe("Intended long route");
    expect(normalized.vertexCount).toBe(2);
  });

  it("matches an explicit routeId against numeric live route ids", async () => {
    const config = createExampleConfig(
      "?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0&routeId=42&resultRecordCount=2",
    );
    const source = await loadRouteSource(config, {
      HonuaClient: createMockHonuaClient(MULTI_FEATURE_QUERY_RESPONSE_WITH_NUMERIC_ROUTE_ID),
    });

    const normalized = normalizeRoutePlaybackSource(source, config);

    expect(normalized.routeId).toBe("42");
    expect(normalized.routeName).toBe("Numeric route id");
    expect(normalized.vertexCount).toBe(2);
  });

  it("matches an explicit routeId against a configured custom live route-id field", async () => {
    const config = createExampleConfig(
      "?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0&routeId=intended-long&routeIdField=custom_route&resultRecordCount=2",
    );
    const source = await loadRouteSource(config, {
      HonuaClient: createMockHonuaClient(MULTI_FEATURE_QUERY_RESPONSE_WITH_CUSTOM_ROUTE_ID),
    });

    const normalized = normalizeRoutePlaybackSource(source, config);

    expect(source.manifest).toMatchObject({
      fieldMapping: {
        routeId: "custom_route",
      },
      query: {
        routeIdValue: "intended-long",
      },
    });
    expect(normalized.routeId).toBe("intended-long");
    expect(normalized.routeName).toBe("Custom mapped route");
    expect(normalized.vertexCount).toBe(2);
  });

  it("treats a configured custom live route-id field as authoritative for matching", async () => {
    const config = createExampleConfig(
      "?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0&routeId=intended-long&routeIdField=custom_route&resultRecordCount=2",
    );
    const source = await loadRouteSource(config, {
      HonuaClient: createMockHonuaClient(MULTI_FEATURE_QUERY_RESPONSE_WITH_CUSTOM_ROUTE_ID_ALIAS_CONFLICT),
    });

    const normalized = normalizeRoutePlaybackSource(source, config);

    expect(normalized.routeId).toBe("intended-long");
    expect(normalized.routeName).toBe("Custom mapped route");
    expect(normalized.vertexCount).toBe(2);
  });

  it("throws instead of guessing across multiple live polyline features without routeId", async () => {
    const config = createExampleConfig("?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0&resultRecordCount=2");
    const source = await loadRouteSource(config, {
      HonuaClient: createMockHonuaClient(MULTI_FEATURE_QUERY_RESPONSE),
    });

    expect(() => normalizeRoutePlaybackSource(source, config)).toThrow(
      "The Honua query response contained 2 polyline features. Configure routeId or narrow the query so only one route remains.",
    );
  });

  it("leaves routeId null for single-feature live responses without route-id attributes", async () => {
    const config = createExampleConfig("?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0");
    const source = await loadRouteSource(config, {
      HonuaClient: createMockHonuaClient(SINGLE_FEATURE_QUERY_RESPONSE_WITHOUT_ROUTE_ID),
    });

    const normalized = normalizeRoutePlaybackSource(source, config);

    expect(normalized.routeId).toBeNull();
    expect(normalized.routeName).toBe("Route without explicit id");
    expect(normalized.vertexCount).toBe(3);
  });

  it("selects the physically longest path from a multipart polyline", () => {
    const normalized = normalizeRoutePlaybackSource(
      {
        sourceMode: "fixture",
        manifest: null,
        queryRequest: null,
        queryResponse: {
          geometryType: "esriGeometryPolyline",
          features: [
            {
              attributes: {
                route_id: "multipart-demo",
                route_name: "Multipart demo",
              },
              geometry: {
                paths: [
                  [
                    [-157.8583, 21.3069, 12],
                    [-157.8582, 21.307, 12],
                    [-157.8581, 21.3071, 12],
                  ],
                  [
                    [-157.8583, 21.3069, 12],
                    [-156.5, 21.3069, 12],
                  ],
                ],
              },
            },
          ],
        },
      },
      { speedMetersPerSecond: 18 },
    );

    expect(normalized.pathCount).toBe(2);
    expect(normalized.vertexCount).toBe(2);
    expect(normalized.positions).toEqual([
      {
        longitude: -157.8583,
        latitude: 21.3069,
        sourceZ: 12,
      },
      {
        longitude: -156.5,
        latitude: 21.3069,
        sourceZ: 12,
      },
    ]);
    expect(normalized.totalDistanceMeters).toBeGreaterThan(100_000);
    expect(normalized.preprocessingSteps).toContain(
      "Selected the longest path from a multi-part polyline before playback.",
    );
  });
});
