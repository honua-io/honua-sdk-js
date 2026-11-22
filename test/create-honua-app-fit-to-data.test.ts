import { readFileSync } from "node:fs";
import type { Map as MapLibreMap } from "maplibre-gl";
import { expect, it, vi } from "vitest";

import { dataBounds, fitMapToData } from "../packages/create-honua-app/templates/vanilla-ts/src/fit-to-data.js";

const TEMPLATE_COPIES = [
  "packages/create-honua-app/templates/vanilla-ts/src/fit-to-data.ts",
  "packages/create-honua-app/templates/react-ts/src/fit-to-data.ts",
];

it("fit-to-data bounds GeoServices points, paths and rings", () => {
  const features = [
    { geometry: { x: -156.5, y: 20.7 } },
    {
      geometry: {
        paths: [
          [
            [-156.4, 20.6],
            [-156.3, 20.9],
          ],
        ],
      },
    },
    {
      geometry: {
        rings: [
          [
            [-156.2, 20.5],
            [-156.1, 20.5],
            [-156.1, 20.8],
            [-156.2, 20.5],
          ],
        ],
      },
    },
    { geometry: { points: [[-156.6, 20.65]] } },
  ];
  expect(dataBounds(features)).toEqual([-156.6, 20.5, -156.1, 20.9]);
});

it("fit-to-data bounds GeoJSON coordinates at any nesting depth", () => {
  const features = [
    { geometry: { type: "Point", coordinates: [10, 50] } },
    {
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [11, 49],
              [12, 49],
              [12, 51],
              [11, 49],
            ],
          ],
        ],
      },
    },
  ];
  expect(dataBounds(features)).toEqual([10, 49, 12, 51]);
});

it("fit-to-data ignores missing, non-finite and projected coordinates", () => {
  const features = [
    { geometry: null },
    {},
    { geometry: { x: Number.NaN, y: 1 } },
    { geometry: { x: -17_571_000, y: 2_425_000 } },
  ];
  expect(dataBounds(features)).toBeUndefined();
});

it("fit-to-data fits the map only when the result carries coordinates", () => {
  const fitBounds = vi.fn();
  const map = { fitBounds } as unknown as MapLibreMap;
  expect(fitMapToData(map, [])).toBe(false);
  expect(fitBounds).not.toHaveBeenCalled();
  expect(fitMapToData(map, [{ geometry: { x: -156.5, y: 20.7 } }])).toBe(true);
  expect(fitBounds).toHaveBeenCalledWith(
    [
      [-156.5, 20.7],
      [-156.5, 20.7],
    ],
    { padding: 32, maxZoom: 16, animate: false },
  );
});

it("fit-to-data ships one identical helper in every starter", () => {
  const [first, ...rest] = TEMPLATE_COPIES.map((path) => readFileSync(path, "utf8"));
  for (const copy of rest) expect(copy).toBe(first);
});
