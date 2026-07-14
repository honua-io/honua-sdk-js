import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { resolveQuickstartConfig } from "../examples/maplibre-quickstart/src/config.js";
import {
  buildQuickstartDataset,
  createQuickstartSourceDescriptor,
  loadQuickstartDataset,
} from "../examples/maplibre-quickstart/src/data.js";
import {
  convertEsriFeaturesToGeoJson,
  summarizeRenderableGeometryTypes,
} from "../examples/maplibre-quickstart/src/esri-geojson.js";
import type { Result } from "../src/contract/types.js";
import type { HonuaLayerMetadata } from "../src/core/types.js";
import { explainQuery } from "../src/query-planner/index.js";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "honua-quickstart-demo");

function readFixture<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, fileName), "utf8")) as T;
}

function buildFixtureDataset(features: Result["features"], queryDurationMs = 9) {
  const config = resolveQuickstartConfig({});
  const metadata = readFixture<HonuaLayerMetadata>("layer-metadata.json");
  const descriptor = createQuickstartSourceDescriptor(config, metadata);
  const query = {
    where: config.where,
    outFields: ["*"],
    returnGeometry: true,
    outSr: 4326,
    pagination: { limit: config.resultRecordCount },
  } as const;
  return buildQuickstartDataset({
    config,
    compatibility: { serverVersion: "1.2.0", releaseChannel: "stable" },
    metadata,
    descriptor,
    query,
    plan: explainQuery({ descriptor, query, sourceVersion: config.dataVersion }),
    result: { features, exceededTransferLimit: false },
    journey: [],
    queryDurationMs,
    observedAt: "2026-07-10T00:00:00.000Z",
  });
}

describe("maplibre quickstart data", () => {
  it("converts Esri JSON features to renderable GeoJSON geometry kinds", () => {
    const geojson = convertEsriFeaturesToGeoJson([
      {
        attributes: { OBJECTID: 1, NAME: "Point feature" },
        geometry: { x: -157.86, y: 21.3 },
      },
      {
        attributes: { OBJECTID: 2, NAME: "Line feature" },
        geometry: {
          paths: [
            [
              [-157.86, 21.3],
              [-157.85, 21.31],
            ],
          ],
        },
      },
      {
        attributes: { OBJECTID: 3, NAME: "Polygon feature" },
        geometry: {
          rings: [
            [
              [-157.87, 21.31],
              [-157.86, 21.31],
              [-157.86, 21.3],
              [-157.87, 21.3],
              [-157.87, 21.31],
            ],
          ],
        },
      },
    ]);

    expect(geojson.features).toHaveLength(3);
    expect(summarizeRenderableGeometryTypes(geojson)).toEqual(["point", "line", "polygon"]);
  });

  it("treats empty points, paths, and rings as non-renderable geometry", () => {
    const features = [
      {
        attributes: { OBJECTID: 1, NAME: "Empty point set" },
        geometry: { points: [] },
      },
      {
        attributes: { OBJECTID: 2, NAME: "Empty path set" },
        geometry: { paths: [] },
      },
      {
        attributes: { OBJECTID: 3, NAME: "Empty ring set" },
        geometry: { rings: [] },
      },
    ];
    const geojson = convertEsriFeaturesToGeoJson(features);

    expect(geojson.features.map((feature) => feature.geometry)).toEqual([null, null, null]);
    expect(summarizeRenderableGeometryTypes(geojson)).toEqual([]);
    expect(() => buildFixtureDataset(features)).toThrow(
      "The feature query returned 3 feature(s), but none included renderable geometry.",
    );
  });

  it("keeps disjoint Esri outer rings as a GeoJSON multipolygon", () => {
    const outerRingA = [
      [0, 4],
      [4, 4],
      [4, 0],
      [0, 0],
      [0, 4],
    ] as const;
    const holeRingA = [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
      [1, 1],
    ] as const;
    const outerRingB = [
      [10, 4],
      [14, 4],
      [14, 0],
      [10, 0],
      [10, 4],
    ] as const;

    const geojson = convertEsriFeaturesToGeoJson([
      {
        attributes: { OBJECTID: 7, NAME: "Multipart polygon" },
        geometry: {
          rings: [outerRingA, holeRingA, outerRingB],
        },
      },
    ]);

    // The SDK converter rewinds rings to RFC 7946 (CCW exterior, CW holes), so
    // the clockwise Esri exteriors and CCW hole flip relative to the input.
    expect(geojson.features[0]?.geometry).toEqual({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 4],
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
          ],
          [
            [1, 1],
            [1, 3],
            [3, 3],
            [3, 1],
            [1, 1],
          ],
        ],
        [
          [
            [10, 4],
            [10, 0],
            [14, 0],
            [14, 4],
            [10, 4],
          ],
        ],
      ],
    });
  });

  it("assigns hole-first Esri rings to the containing polygon", () => {
    const outerRing = [
      [0, 4],
      [4, 4],
      [4, 0],
      [0, 0],
      [0, 4],
    ] as const;
    const holeRing = [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
      [1, 1],
    ] as const;

    const geojson = convertEsriFeaturesToGeoJson([
      {
        attributes: { OBJECTID: 8, NAME: "Hole-first polygon" },
        geometry: {
          rings: [holeRing, outerRing],
        },
      },
    ]);

    // Rewound to RFC 7946: CCW exterior, CW hole.
    expect(geojson.features[0]?.geometry).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [0, 4],
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
        [
          [1, 1],
          [1, 3],
          [3, 3],
          [3, 1],
          [1, 1],
        ],
      ],
    });
  });

  it("builds a deterministic quickstart dataset from the query fixture", () => {
    const response = readFixture<{ features: Result["features"] }>("query-features.json");
    const dataset = buildFixtureDataset(response.features, 18);

    expect(dataset.featureCount).toBe(3);
    expect(dataset.renderableFeatureCount).toBe(3);
    expect(dataset.geometryTypes).toEqual(["polygon"]);
    expect(dataset.featureSummaries[1]?.title).toBe("Harbor response district");
    expect(dataset.bounds?.minX).toBeLessThan(-157.88);
    expect(dataset.bounds?.maxY).toBeGreaterThan(21.3);
    expect(dataset.evidence).toMatchObject({
      mode: "fixture",
      auth: "none",
      dataVersion: "honolulu-operations-v1",
      freshness: "snapshot captured 2026-07-01T00:00:00.000Z",
    });
    expect(dataset.plan.pushdown).toBe("full");
    expect(dataset.evidence.capabilities).toEqual(["query"]);
    expect(dataset.evidence.capabilities).not.toContain("attachments");
    expect(dataset.evidence.capabilities).not.toContain("applyEdits");
  });

  it("checks compatibility and queries the configured FeatureServer path", async () => {
    const requests: string[] = [];
    const telemetry = {
      events: [],
      runtime: {},
      emit: vi.fn(),
      patchRuntime: vi.fn(),
    };

    const dataset = await loadQuickstartDataset(
      {
        ...resolveQuickstartConfig({
          VITE_HONUA_QUICKSTART_BASE_URL: "https://example.test",
          VITE_HONUA_QUICKSTART_SERVICE_ID: "natural-earth",
          VITE_HONUA_QUICKSTART_LAYER_ID: "0",
        }),
      },
      {
        fetchFn: async (input) => {
          const url = new URL(String(input));
          requests.push(`${url.pathname}?${url.searchParams.toString()}`);

          if (url.pathname === "/api/v1/admin/capabilities") {
            return new Response(fs.readFileSync(path.join(fixtureRoot, "capabilities.json")), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          if (url.pathname === "/rest/services/natural-earth/FeatureServer/0") {
            return new Response(fs.readFileSync(path.join(fixtureRoot, "layer-metadata.json")), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          if (url.pathname === "/rest/services/natural-earth/FeatureServer/0/query") {
            return new Response(fs.readFileSync(path.join(fixtureRoot, "query-features.json")), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          return new Response("Not found", { status: 404 });
        },
        telemetry: telemetry as never,
      },
    );

    expect(dataset.featureCount).toBe(3);
    expect(requests).toContain("/api/v1/admin/capabilities?");
    expect(requests).toContain("/rest/services/natural-earth/FeatureServer/0?f=json");
    expect(requests.some((request) => request.startsWith("/rest/services/natural-earth/FeatureServer/0/query?"))).toBe(
      true,
    );
    expect(
      requests.some(
        (request) =>
          request.includes("outSR=4326") &&
          request.includes("returnGeometry=true") &&
          request.includes("resultRecordCount=25"),
      ),
    ).toBe(true);
    expect(telemetry.emit).toHaveBeenCalledWith("compatibility-ok", expect.any(Object));
    expect(telemetry.emit).toHaveBeenCalledWith("plan-explained", expect.any(Object));
    expect(telemetry.emit).toHaveBeenCalledWith("query-finished", expect.any(Object));
  });

  it("surfaces compatibility failures before querying the layer", async () => {
    await expect(
      loadQuickstartDataset(resolveQuickstartConfig({ VITE_HONUA_QUICKSTART_BASE_URL: "https://example.test" }), {
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                compatibility: {
                  serverVersion: "0.9.0",
                  releaseChannel: "stable",
                  controlPlaneApi: {
                    major: 1,
                    basePath: "/api/v1/admin",
                    deprecated: false,
                  },
                  metadataSchemas: [],
                  features: {
                    metadataResources: true,
                    manifestExport: true,
                    manifestApply: true,
                    manifestDryRun: true,
                    manifestPrune: true,
                  },
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      }),
    ).rejects.toThrow("Server version 0.9.0 is older than the minimum supported 1.0.0.");
  });

  it("wraps query failures with the requested service and layer", async () => {
    await expect(
      loadQuickstartDataset(
        resolveQuickstartConfig({
          VITE_HONUA_QUICKSTART_BASE_URL: "https://example.test",
          VITE_HONUA_QUICKSTART_SERVICE_ID: "ops",
          VITE_HONUA_QUICKSTART_LAYER_ID: "9",
        }),
        {
          fetchFn: async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/v1/admin/capabilities") {
              return new Response(fs.readFileSync(path.join(fixtureRoot, "capabilities.json")), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (url.pathname === "/rest/services/ops/FeatureServer/9") {
              return new Response(fs.readFileSync(path.join(fixtureRoot, "layer-metadata.json")), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response("Layer unavailable", { status: 503 });
          },
        },
      ),
    ).rejects.toThrow('Failed to query service "ops" layer 9: HTTP 503: Request failed');
  });

  it("fails fast when the query response does not include renderable geometry", () => {
    expect(() =>
      buildFixtureDataset(
        [
          {
            attributes: {
              OBJECTID: 1,
              NAME: "Broken feature",
            },
            geometry: null,
          },
        ],
        12,
      ),
    ).toThrow("The feature query returned 1 feature(s), but none included renderable geometry.");
  });
});
