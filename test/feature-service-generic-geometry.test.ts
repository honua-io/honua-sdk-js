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

describe.each([undefined, "esriGeometryNull"])("inferred multipart polygons with metadata %s", (metadata) => {
  const first = [
    [0, 0],
    [0, 4],
    [4, 4],
    [4, 0],
    [0, 0],
  ];
  const second = [
    [10, 0],
    [10, 4],
    [14, 4],
    [14, 0],
    [10, 0],
  ];
  const firstHole = [
    [1, 1],
    [3, 1],
    [3, 3],
    [1, 3],
    [1, 1],
  ];
  const secondHole = [
    [11, 1],
    [13, 1],
    [13, 3],
    [11, 3],
    [11, 1],
  ];
  const reversed = (ring: number[][]) => [...ring].reverse();

  it("preserves two independent exterior areas as MultiPolygon", () => {
    expect(esriGeometryToGeoJson({ rings: [first, second] }, metadata)).toEqual({
      type: "MultiPolygon",
      coordinates: [[reversed(first)], [reversed(second)]],
    });
  });

  it("assigns out-of-order holes to their containing exterior", () => {
    expect(esriGeometryToGeoJson({ rings: [secondHole, first, second, firstHole] }, metadata)).toEqual({
      type: "MultiPolygon",
      coordinates: [
        [reversed(first), reversed(firstHole)],
        [reversed(second), reversed(secondHole)],
      ],
    });
  });
});

it("uses canonical topology for metadata-declared polygon parts too", () => {
  const first = [
    [0, 0],
    [0, 4],
    [4, 4],
    [4, 0],
    [0, 0],
  ];
  const second = [
    [10, 0],
    [10, 4],
    [14, 4],
    [14, 0],
    [10, 0],
  ];
  expect(esriGeometryToGeoJson({ rings: [first, second] }, "esriGeometryPolygon")).toEqual({
    type: "MultiPolygon",
    coordinates: [[[...first].reverse()], [[...second].reverse()]],
  });
});

it("retains point elevation through the same canonical declared/inferred conversion", () => {
  for (const metadata of [undefined, "esriGeometryNull", "esriGeometryPoint"]) {
    expect(esriGeometryToGeoJson({ x: 1, y: 2, z: 3 }, metadata)).toEqual({ type: "Point", coordinates: [1, 2, 3] });
  }
});

// Optional Esri measures may be null. They must not erase an otherwise
// drawable geometry or appear as nonnumeric GeoJSON position elements.
describe.each([null, "bad", Number.NaN, Number.POSITIVE_INFINITY])(
  "unset or invalid optional ordinate %s",
  (optional) => {
    for (const position of [
      [1, 2, optional],
      [1, 2, 3, optional],
    ]) {
      it.each([
        ["esriGeometryMultipoint", { points: [position] }, { type: "MultiPoint", coordinates: [[1, 2]] }],
        [
          "esriGeometryPolyline",
          { paths: [[[0, 0, 0], position]] },
          {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 2],
            ],
          },
        ],
        [
          "esriGeometryPolygon",
          { rings: [[[0, 0, 0], [2, 0, 0], position, [0, 0, 0]]] },
          {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [2, 0],
                [1, 2],
                [0, 0],
              ],
            ],
          },
        ],
      ] as const)(
        `keeps ${position.length}D input drawable for %s without dimension metadata`,
        (declared, geometry, expected) => {
          for (const metadata of [undefined, "esriGeometryNull", declared] as const) {
            expect(esriGeometryToGeoJson(geometry, metadata)).toEqual(expected);
          }
        },
      );
    }
  },
);

it.each([undefined, "esriGeometryNull", "esriGeometryPoint"] as const)(
  "renders a point with absent Z and metadata %s",
  (metadata) => {
    expect(esriGeometryToGeoJson({ x: 1, y: 2, z: null, m: null }, metadata)).toEqual({
      type: "Point",
      coordinates: [1, 2],
    });
  },
);

it.each([
  ["esriGeometryMultipoint", { points: [[1, 2, 3, null]] }, { type: "MultiPoint", coordinates: [[1, 2, 3]] }],
  [
    "esriGeometryPolyline",
    {
      paths: [
        [
          [0, 0, 0, null],
          [1, 2, 3, null],
        ],
      ],
    },
    {
      type: "LineString",
      coordinates: [
        [0, 0, 0],
        [1, 2, 3],
      ],
    },
  ],
  [
    "esriGeometryPolygon",
    {
      rings: [
        [
          [0, 0, 0, null],
          [2, 0, 0, null],
          [1, 2, 3, null],
          [0, 0, 0, null],
        ],
      ],
    },
    {
      type: "Polygon",
      coordinates: [
        [
          [0, 0, 0],
          [2, 0, 0],
          [1, 2, 3],
          [0, 0, 0],
        ],
      ],
    },
  ],
] as const)("preserves declared Z and omits null M for %s", (declared, geometry, expected) => {
  for (const metadata of [undefined, "esriGeometryNull", declared] as const) {
    expect(esriGeometryToGeoJson({ ...geometry, hasZ: true, hasM: true }, metadata)).toEqual(expected);
  }
});

it("does not interpret an M-only position as altitude", () => {
  expect(esriGeometryToGeoJson({ points: [[1, 2, 99]], hasM: true }, "esriGeometryMultipoint")).toEqual({
    type: "MultiPoint",
    coordinates: [[1, 2]],
  });
});

it("passes the actual layer dimension context through authenticated feature loading", async () => {
  const client = new HonuaClient({ baseUrl: "https://gis.example.com" });
  vi.spyOn(client, "getLayerMetadata").mockResolvedValue({
    id: 1,
    geometryType: "esriGeometryNull",
    hasZ: true,
    hasM: true,
  } as never);
  vi.spyOn(client, "queryFeatures").mockResolvedValue({
    features: [{ attributes: { OBJECTID: 7 }, geometry: { points: [[1, 2, 3, null]] } }],
    exceededTransferLimit: false,
  } as never);
  const result = await loadHonuaFeatureServiceGeoJson(
    client,
    "https://gis.example.com/rest/services/measured/FeatureServer/1",
  );
  expect(result.data.features[0]).toEqual({
    type: "Feature",
    properties: { OBJECTID: 7 },
    geometry: { type: "MultiPoint", coordinates: [[1, 2, 3]] },
  });
});

it.each([undefined, "esriGeometryNull", "esriGeometryPolygon"] as const)(
  "closes every retained ordinate after Z projection for metadata %s",
  (metadata) => {
    const first = [
      [0, 0, 1],
      [2, 0, 2],
      [1, 2, 3],
      [0, 0, 9],
    ];
    const second = [
      [10, 10, 4],
      [12, 10, 5],
      [11, 12, 6],
      [10, 10, 8],
    ];
    const geometry = { hasZ: true, rings: [first] };
    const before = JSON.stringify(geometry);
    expect(esriGeometryToGeoJson(geometry, metadata)).toEqual({
      type: "Polygon",
      coordinates: [[...first, [0, 0, 1]]],
    });
    expect(JSON.stringify(geometry)).toBe(before);
    expect(esriGeometryToGeoJson({ hasZ: true, rings: [first, second] }, metadata)).toEqual({
      type: "MultiPolygon",
      coordinates: [[[...first, [0, 0, 1]]], [[...second, [10, 10, 4]]]],
    });
  },
);
