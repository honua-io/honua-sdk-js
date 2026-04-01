import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createExampleConfig,
  createLiveQueryRequest,
  normalizeRoutePlaybackSource,
} from "../docs/examples/cesium-route-playback/data-path.mjs";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("Cesium route playback example helpers", () => {
  it("defaults the live query bounds when URL parameters are omitted", () => {
    const config = createExampleConfig("?mode=live&baseUrl=/mock-honua&serviceId=transport&layerId=0");

    expect(config.mode).toBe("live");
    expect(config.resultRecordCount).toBe(1);
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
