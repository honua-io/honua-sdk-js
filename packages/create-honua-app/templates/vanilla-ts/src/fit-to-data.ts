import type { Map as MapLibreMap } from "maplibre-gl";

/** West, south, east, north in WGS84 degrees. */
export type DataBounds = readonly [number, number, number, number];
type Position = readonly [number, number];

const MAX_LONGITUDE = 180;
const MAX_LATITUDE = 90;
const GEOMETRY_ARRAY_KEYS = ["coordinates", "points", "paths", "rings"] as const;

function wgs84Position(x: unknown, y: unknown): Position[] {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return [];
  return Math.abs(x) <= MAX_LONGITUDE && Math.abs(y) <= MAX_LATITUDE ? [[x, y]] : [];
}

/** Flattens GeoJSON `coordinates` and GeoServices `points`, `paths` and `rings` arrays. */
function nestedPositions(value: unknown): Position[] {
  if (!Array.isArray(value)) return [];
  if (typeof value[0] === "number") return wgs84Position(value[0], value[1]);
  return value.flatMap(nestedPositions);
}

function geometryPositions(geometry: unknown): Position[] {
  if (!geometry || typeof geometry !== "object") return [];
  const shape = geometry as Record<string, unknown>;
  return [
    ...wgs84Position(shape["x"], shape["y"]),
    ...GEOMETRY_ARRAY_KEYS.flatMap((key) => nestedPositions(shape[key])),
  ];
}

/** Bounds of WGS84 feature geometries, or `undefined` when none carry coordinates. */
export function dataBounds(features: readonly { readonly geometry?: unknown }[]): DataBounds | undefined {
  const positions = features.flatMap((feature) => geometryPositions(feature.geometry));
  const [first, ...rest] = positions;
  if (!first) return undefined;
  // Reduce rather than Math.min(...xs): large polygon results would overflow the argument limit.
  return rest.reduce<DataBounds>(
    ([west, south, east, north], [x, y]) => [
      Math.min(west, x),
      Math.min(south, y),
      Math.max(east, x),
      Math.max(north, y),
    ],
    [first[0], first[1], first[0], first[1]],
  );
}

/**
 * Live-lane camera: frame the bounded query result so data outside the starter's
 * default view is visible. The fixture lane keeps its fixed view.
 */
export function fitMapToData(map: MapLibreMap, features: readonly { readonly geometry?: unknown }[]): boolean {
  const bounds = dataBounds(features);
  if (!bounds) return false;
  const [west, south, east, north] = bounds;
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: 32, maxZoom: 16, animate: false },
  );
  return true;
}
