import { describe, expect, it, vi } from "vitest";

import {
  collectFirstMapBounds,
  combineFirstMapLayerFilter,
  createFirstMapCode,
  createFirstMapFilterChoices,
  createIdempotentAsyncDispose,
  filterFirstMapFeatures,
  findFirstMapFeature,
  observeFirstMapTiming,
  summarizeFirstMapFeatures,
} from "../examples/maplibre-quickstart/src/first-map-presentation.js";

const features = [
  {
    attributes: { OBJECTID: 1, NAME: "Civic center", STATUS: "Monitoring", CATEGORY: "Operations" },
    geometry: {
      rings: [
        [
          [-157.866, 21.311],
          [-157.856, 21.302],
        ],
      ],
    },
  },
  {
    attributes: { OBJECTID: 2, NAME: "Harbor", STATUS: "Ready", CATEGORY: "Maritime" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-157.891, 21.304],
          [-157.879, 21.294],
          [-157.891, 21.304],
        ],
      ],
    },
  },
] as const;

describe("First Map presentation contract", () => {
  it("summarizes canonical GeoServices and OGC feature geometry without adapting the SDK mount", () => {
    const summaries = summarizeFirstMapFeatures(features);

    expect(summaries).toMatchObject([
      { id: "1", title: "Civic center", subtitle: "Monitoring", geometryKind: "polygon" },
      { id: "2", title: "Harbor", subtitle: "Ready", geometryKind: "polygon" },
    ]);
    expect(collectFirstMapBounds(summaries)).toEqual({
      minX: -157.891,
      minY: 21.294,
      maxX: -157.856,
      maxY: 21.311,
    });
  });

  it("gives the governed Maui census tract a stable human-readable label", () => {
    const [tract] = summarizeFirstMapFeatures([
      {
        attributes: {
          OBJECTID: 1,
          GEOID: "15009030100",
          NAME: "301",
          NAMELSAD: "Census Tract 301",
          ALAND: 555_261_920,
          AWATER: 25_398_370,
        },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [-156.48, 20.89],
                [-156.47, 20.9],
                [-156.48, 20.89],
              ],
            ],
            [
              [
                [-156.46, 20.88],
                [-156.45, 20.89],
                [-156.46, 20.88],
              ],
            ],
          ],
        },
      },
    ]);

    expect(tract).toMatchObject({
      id: "1",
      title: "Census Tract 301",
      subtitle: "GEOID 15009030100",
      geometryKind: "polygon",
    });
  });

  it("anchors programmatic MultiPolygon selection inside its largest surface", () => {
    const [summary] = summarizeFirstMapFeatures([
      {
        attributes: { OBJECTID: 3, NAMELSAD: "Census Tract 316.01" },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
            [
              [
                [10, 0],
                [14, 0],
                [14, 4],
                [10, 4],
                [10, 0],
              ],
            ],
          ],
        },
      },
    ]);

    expect(summary?.center).toEqual([12, 2]);
  });

  it("drives table and MapLibre filters from the same deterministic choice", () => {
    const summaries = summarizeFirstMapFeatures(features);
    const choices = createFirstMapFilterChoices(summaries);
    const ready = choices.find(({ field, value }) => field === "STATUS" && value === "Ready");

    expect(ready).toMatchObject({ fieldLabel: "Status", label: "Ready" });
    expect(filterFirstMapFeatures(summaries, ready).map(({ id }) => id)).toEqual(["2"]);
    expect(combineFirstMapLayerFilter(["==", ["geometry-type"], "Polygon"], ready)).toEqual([
      "all",
      ["==", ["geometry-type"], "Polygon"],
      ["==", ["get", "STATUS"], "Ready"],
    ]);
    expect(combineFirstMapLayerFilter(["base"], undefined)).toEqual(["base"]);
  });

  it("links rendered selection by promoted id or canonical properties", () => {
    const summaries = summarizeFirstMapFeatures(features);

    expect(findFirstMapFeature(summaries, 2, undefined)?.title).toBe("Harbor");
    expect(findFirstMapFeature(summaries, undefined, { OBJECTID: 1 })?.title).toBe("Civic center");
  });

  it("reports exact budget variance at, under, and over the boundary", () => {
    expect(observeFirstMapTiming(99.4, 100)).toEqual({
      elapsedMs: 99,
      budgetMs: 100,
      varianceMs: 1,
      withinBudget: true,
    });
    expect(observeFirstMapTiming(100, 100).withinBudget).toBe(true);
    expect(observeFirstMapTiming(100.4, 100)).toMatchObject({ varianceMs: 0, withinBudget: false });
    expect(observeFirstMapTiming(101, 100)).toMatchObject({ varianceMs: -1, withinBudget: false });
    expect(() => observeFirstMapTiming(-1, 100)).toThrow(/non-negative/);
  });

  it("provides an idempotent asynchronous cleanup boundary", async () => {
    const action = vi.fn(async () => undefined);
    const dispose = createIdempotentAsyncDispose(action);

    await Promise.all([dispose(), dispose(), dispose()]);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("renders a copyable public-SDK workflow call site with no embedded credentials", () => {
    const code = createFirstMapCode({
      endpoint: "https://geo.example.test/ogc/features",
      mode: "public-live",
      protocol: "ogc-features",
      maxFeatures: 500,
    });

    expect(code).toContain('from "./workflow"');
    expect(code).toContain('maplibre-gl-worker.mjs?worker&url"');
    expect(code).toContain("maplibregl.setWorkerUrl(maplibreWorkerUrl)");
    expect(code).toContain('"protocol": "ogc-features"');
    expect(code).toContain('result.state !== "ready"');
    expect(code).not.toContain("apiKey");
    expect(code).not.toContain("bearerToken");
  });
});
