import { describe, expect, it } from "vitest";

import { HonuaImageService } from "@honua/sdk-js/honua";
import { createFixtureTerrainElevationDataset } from "../examples/terrain-rgb-elevation/src/fixtures.js";
import {
  buildTerrainRgbTileUrlTemplate,
  createFixtureElevationProfile,
  createTerrainRenderPlan,
  decodeTerrainRgbElevation,
  lookupTerrainElevation,
  profileDistanceMeters,
  queryTerrainElevationProfile,
  summarizeTerrainCache,
  summarizeTerrainCapabilities,
} from "../examples/terrain-rgb-elevation/src/model.js";
import { HonuaClient } from "../src/index.js";

describe("Terrain-RGB Elevation sample", () => {
  it("projects the ImageServer Terrain-RGB tileset into a MapLibre raster-dem source", () => {
    const client = new HonuaClient({ baseUrl: "https://honua.example.test" });
    const dataset = createFixtureTerrainElevationDataset();
    const plan = createTerrainRenderPlan(dataset, client);

    expect(plan.sourceSpec).toEqual({
      type: "raster-dem",
      tiles: ["https://honua.example.test/rest/services/OahuTerrain/ImageServer/tile/{z}/{y}/{x}?f=png"],
      tileSize: 256,
      encoding: "mapbox",
      minzoom: 6,
      maxzoom: 14,
      attribution: "Honua fixture Terrain-RGB DEM",
    });
    expect(plan.terrainExaggeration).toBeGreaterThan(1);
    expect(summarizeTerrainCache(dataset)).toBe("metadata ready / interactions uncached");
    expect(summarizeTerrainCapabilities(plan)).toBe("Terrain-RGB tiles, Elevation value API, Elevation profile API");
    expect(plan.auditRows.map((row) => row.sdkSurface)).toEqual([
      "HonuaImageService.tileUrl",
      "demo-local helper over HonuaClient.pipelineRequestJson (typed Terrain API gap)",
      "demo-local helper over HonuaClient.pipelineRequestJson (typed Terrain API gap)",
    ]);
  });

  it("builds Terrain-RGB tile templates from the SDK ImageServer tileUrl surface", () => {
    const client = new HonuaClient({ baseUrl: "https://honua.example.test/honua/" });
    const service = new HonuaImageService({ client, serviceId: "Terrain" });

    expect(buildTerrainRgbTileUrlTemplate(service, "png")).toBe(
      "https://honua.example.test/honua/rest/services/Terrain/ImageServer/tile/{z}/{y}/{x}?f=png",
    );
  });

  it("queries elevation value and profile endpoints through demo-local raw pipeline helpers", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({
        url,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });

      if (url.includes("/elevation/value")) {
        return jsonResponse({
          longitude: -157.84,
          latitude: 21.42,
          elevationMeters: 684.4,
          verticalDatum: "EGM96",
          resolutionMeters: 10,
          source: "fixture-terrain-rgb",
        });
      }

      return jsonResponse({
        samples: [
          { longitude: -157.9, latitude: 21.36, distanceMeters: 0, elevationMeters: 322 },
          { longitude: -157.86, latitude: 21.4, distanceMeters: 6200, elevationMeters: 711 },
          { longitude: -157.82, latitude: 21.43, distanceMeters: 12_400, elevationMeters: 548 },
        ],
        source: "fixture-terrain-rgb",
      });
    };
    const client = new HonuaClient({ baseUrl: "https://honua.example.test", fetchFn });
    const plan = createTerrainRenderPlan(createFixtureTerrainElevationDataset(), client);

    const sample = await lookupTerrainElevation(plan, client, [-157.84, 21.42]);
    const profile = await queryTerrainElevationProfile(plan, client, [
      [-157.9, 21.36],
      [-157.82, 21.43],
    ]);

    expect(sample.elevationMeters).toBe(684.4);
    expect(requests[0]?.url).toContain("/api/v1/terrain/OahuTerrain/elevation/value?longitude=-157.84");
    expect(requests[0]?.url).toContain("latitude=21.42");
    expect(requests[1]?.url).toBe("https://honua.example.test/api/v1/terrain/OahuTerrain/elevation/profile");
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.body).toContain('"type":"LineString"');
    expect(profile.samples).toHaveLength(3);
    expect(profile.gainMeters).toBe(389);
    expect(profile.lossMeters).toBe(163);
  });

  it("keeps fixture profiles deterministic and documents Terrain-RGB decoding math", () => {
    const dataset = createFixtureTerrainElevationDataset();
    const profile = createFixtureElevationProfile(dataset.profileLine);

    expect(decodeTerrainRgbElevation(1, 134, 160)).toBe(0);
    expect(profile.samples).toHaveLength(8);
    expect(profile.maxElevationMeters).toBeGreaterThan(profile.minElevationMeters);
    expect(profileDistanceMeters(profile)).toBeGreaterThan(10_000);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
