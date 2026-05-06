import type { GeocodingPolygonFeature } from "./types.js";

export const GEOCODING_FIXTURE_CENTER: [number, number] = [-157.8583, 21.3045];
export const GEOCODING_FIXTURE_ZOOM = 11.6;

export const OAHU_URBAN_CORE_OUTLINE: GeocodingPolygonFeature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-157.958, 21.331],
        [-157.921, 21.365],
        [-157.846, 21.355],
        [-157.777, 21.322],
        [-157.754, 21.272],
        [-157.808, 21.247],
        [-157.885, 21.268],
        [-157.958, 21.331],
      ],
    ],
  },
  properties: {
    name: "Honolulu urban geocoding fixture area",
  },
};
