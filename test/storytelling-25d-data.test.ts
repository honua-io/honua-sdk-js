import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { resolveStoryDemoConfig } from "../examples/storytelling-25d-map/src/config.js";
import { buildStoryDataset, loadStoryDataset, normalizeAssets } from "../examples/storytelling-25d-map/src/data.js";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "honua-25d-demo");

function readFixture<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, fileName), "utf8")) as T;
}

describe("storytelling 2.5D demo data", () => {
  it("builds a deterministic story dataset from the fixture collections", () => {
    const config = resolveStoryDemoConfig({});
    const dataset = buildStoryDataset(
      config,
      readFixture("assets.json"),
      readFixture("route.json"),
      readFixture("stops.json"),
    );

    expect(dataset.summary.assetCount).toBe(5);
    expect(dataset.summary.priorityAssetCount).toBe(2);
    expect(dataset.summary.stopCount).toBe(3);
    expect(dataset.summary.routeLengthKm).toBeGreaterThan(2);
    expect(dataset.focusAssetId).toBe("asset-harbor-substation");
    expect(dataset.priorityAssetIds).toEqual(["asset-harbor-substation", "asset-kakaako-pump"]);
    expect(dataset.assets.features[0]?.properties.risk_bucket).toBe("severe");
  });

  it("uses asset-side linked stop ids for the asset-focus step when stop-side linkage is absent", () => {
    const config = resolveStoryDemoConfig({});
    const stops = readFixture<{
      type: "FeatureCollection";
      features: Array<{
        type: "Feature";
        id: string;
        properties: Record<string, unknown>;
        geometry: {
          type: "Point";
          coordinates: [number, number];
        };
      }>;
    }>("stops.json");

    const dataset = buildStoryDataset(config, readFixture("assets.json"), readFixture("route.json"), {
      ...stops,
      features: stops.features.map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          linked_asset_id: null,
        },
      })),
    });

    expect(dataset.focusAssetId).toBe("asset-harbor-substation");
    expect(dataset.focusStopId).toBe("stop-harbor");
  });

  it("fails fast when polygon features do not include numeric risk and height fields", () => {
    expect(() =>
      normalizeAssets({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "broken-asset",
            properties: {
              name: "Broken asset",
            },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-157.9, 21.3],
                  [-157.89, 21.3],
                  [-157.89, 21.29],
                  [-157.9, 21.29],
                  [-157.9, 21.3],
                ],
              ],
            },
          },
        ],
      }),
    ).toThrow("Assets collection requires a numeric risk field");
  });

  it("checks compatibility and loads collections through the OGC browser surface", async () => {
    const requests: string[] = [];
    const telemetry = {
      events: [],
      runtime: {},
      emit: vi.fn(),
      setSummary: vi.fn(),
    };

    const dataset = await loadStoryDataset(
      {
        ...resolveStoryDemoConfig({
          VITE_HONUA_25D_BASE_URL: "https://example.test",
        }),
      },
      {
        fetchFn: async (input) => {
          const url = new URL(String(input));
          requests.push(url.pathname);

          if (url.pathname === "/api/v1/admin/capabilities") {
            return new Response(fs.readFileSync(path.join(fixtureRoot, "capabilities.json")), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          if (url.pathname === "/ogc/features/collections/story-25d-assets/items") {
            return new Response(fs.readFileSync(path.join(fixtureRoot, "assets.json")), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          if (url.pathname === "/ogc/features/collections/story-25d-route/items") {
            return new Response(fs.readFileSync(path.join(fixtureRoot, "route.json")), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          if (url.pathname === "/ogc/features/collections/story-25d-stops/items") {
            return new Response(fs.readFileSync(path.join(fixtureRoot, "stops.json")), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          return new Response("Not found", { status: 404 });
        },
        telemetry: telemetry as never,
      },
    );

    expect(dataset.summary.assetCount).toBe(5);
    expect(requests).toContain("/api/v1/admin/capabilities");
    expect(requests).toContain("/ogc/features/collections/story-25d-assets/items");
    expect(requests).toContain("/ogc/features/collections/story-25d-route/items");
    expect(requests).toContain("/ogc/features/collections/story-25d-stops/items");
    expect(telemetry.emit).toHaveBeenCalledWith("compatibility-ok", expect.any(Object));
    expect(telemetry.emit).toHaveBeenCalledWith("data-loaded", expect.any(Object));
  });
});
