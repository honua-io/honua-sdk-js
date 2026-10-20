import { describe, expect, it, vi } from "vitest";
import { HonuaClient } from "../src/index.js";
import { esriGeometryToGeoJson, loadHonuaFeatureServiceGeoJson } from "../src/map/index.js";

const ring = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
];
const shapes = [
  [
    {
      points: [
        [1, 2],
        [3, 4],
      ],
    },
    {
      type: "MultiPoint",
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    },
  ],
  [
    {
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  ],
  [{ rings: [ring] }, { type: "Polygon", coordinates: [ring] }],
  [
    { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  ],
] as const;

describe.each([undefined, "esriGeometryNull"])("feature geometry with metadata %s", (metadata) => {
  it.each(shapes)("uses the actual nonpoint shape %j", (geometry, expected) => {
    expect(esriGeometryToGeoJson(geometry, metadata)).toEqual(expected);
  });

  it.each([
    { rings: [] },
    {
      rings: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    {
      rings: [
        [
          [0, 0],
          [1, 0],
          [1, Number.NaN],
          [0, 0],
        ],
      ],
    },
    {
      rings: [ring],
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    { rings: [ring], x: 1, y: 2 },
    { paths: [["bad"]] },
    { points: [[Number.POSITIVE_INFINITY, 0]] },
    { xmin: 2, ymin: 0, xmax: 1, ymax: 1 },
  ])("refuses ambiguous or malformed geometry %j", (geometry) => {
    expect(esriGeometryToGeoJson(geometry, metadata)).toBeNull();
  });
});

it("keeps unsupported explicitly declared geometry unsupported", () => {
  expect(esriGeometryToGeoJson({ rings: [ring] }, "esriGeometryMultipatch")).toBeNull();
});

it("preserves the polygon and attributes through the canonical feature-service loader with generic metadata", async () => {
  const client = new HonuaClient({ baseUrl: "https://gis.example.com" });
  vi.spyOn(client, "getLayerMetadata").mockResolvedValue({ id: 1, geometryType: "esriGeometryNull" } as never);
  vi.spyOn(client, "queryFeatures").mockResolvedValue({
    features: [{ attributes: { OBJECTID: 7, name: "buffer" }, geometry: { rings: [ring] } }],
    exceededTransferLimit: false,
  } as never);
  const result = await loadHonuaFeatureServiceGeoJson(
    client,
    "https://gis.example.com/rest/services/buffer/FeatureServer/1",
  );
  expect(result.data.features).toEqual([
    {
      type: "Feature",
      properties: { OBJECTID: 7, name: "buffer" },
      geometry: { type: "Polygon", coordinates: [ring] },
    },
  ]);
});
