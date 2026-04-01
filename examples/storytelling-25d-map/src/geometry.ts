import type {
  GeoJsonGeometry,
  GeoJsonLineString,
  GeoJsonMultiLineString,
  GeoJsonPoint,
  GeoJsonPolygon,
} from "@honua/sdk-js/honua";

import type { StoryBounds, StoryCoordinate, StoryRouteMetrics } from "./types.js";

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function mergeBounds(bounds: StoryBounds[]): StoryBounds {
  if (bounds.length < 1) {
    return {
      minLng: -157.88,
      minLat: 21.29,
      maxLng: -157.84,
      maxLat: 21.32,
      center: [-157.86, 21.305],
    };
  }

  const minLng = Math.min(...bounds.map((entry) => entry.minLng));
  const minLat = Math.min(...bounds.map((entry) => entry.minLat));
  const maxLng = Math.max(...bounds.map((entry) => entry.maxLng));
  const maxLat = Math.max(...bounds.map((entry) => entry.maxLat));

  return {
    minLng,
    minLat,
    maxLng,
    maxLat,
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
  };
}

export function toLngLatBounds(bounds: StoryBounds): [StoryCoordinate, StoryCoordinate] {
  return [
    [bounds.minLng, bounds.minLat],
    [bounds.maxLng, bounds.maxLat],
  ];
}

function boundsFromCoordinates(coordinates: StoryCoordinate[]): StoryBounds {
  const lngs = coordinates.map((entry) => entry[0]);
  const lats = coordinates.map((entry) => entry[1]);

  const minLng = Math.min(...lngs);
  const minLat = Math.min(...lats);
  const maxLng = Math.max(...lngs);
  const maxLat = Math.max(...lats);

  return {
    minLng,
    minLat,
    maxLng,
    maxLat,
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
  };
}

export function flattenGeometryCoordinates(geometry: GeoJsonGeometry | null): StoryCoordinate[] {
  if (!geometry) {
    return [];
  }

  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates as StoryCoordinate];
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates as StoryCoordinate[];
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.flat() as StoryCoordinate[];
    case "MultiPolygon":
      return geometry.coordinates.flat(2) as StoryCoordinate[];
    default:
      return [];
  }
}

export function getBoundsForGeometry(geometry: GeoJsonGeometry | null): StoryBounds {
  const coordinates = flattenGeometryCoordinates(geometry);
  if (coordinates.length < 1) {
    return {
      minLng: -157.88,
      minLat: 21.29,
      maxLng: -157.84,
      maxLat: 21.32,
      center: [-157.86, 21.305],
    };
  }
  return boundsFromCoordinates(coordinates);
}

export function getCenterForGeometry(geometry: GeoJsonGeometry | null): StoryCoordinate {
  return getBoundsForGeometry(geometry).center;
}

export function flattenRouteCoordinates(geometry: GeoJsonLineString | GeoJsonMultiLineString): StoryCoordinate[] {
  if (geometry.type === "LineString") {
    return geometry.coordinates as StoryCoordinate[];
  }

  const coordinates: StoryCoordinate[] = [];
  for (const line of geometry.coordinates) {
    for (const coordinate of line as StoryCoordinate[]) {
      const previous = coordinates.at(-1);
      if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
        coordinates.push(coordinate);
      }
    }
  }
  return coordinates;
}

export function pointDistanceMeters(from: StoryCoordinate, to: StoryCoordinate): number {
  const earthRadiusMeters = 6_371_000;
  const lat1 = toRadians(from[1]);
  const lat2 = toRadians(to[1]);
  const deltaLat = toRadians(to[1] - from[1]);
  const deltaLng = toRadians(to[0] - from[0]);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

export function buildRouteMetrics(coordinates: StoryCoordinate[]): StoryRouteMetrics {
  if (coordinates.length < 2) {
    throw new Error("Route geometry must contain at least two coordinates.");
  }

  const cumulativeMeters = [0];
  let totalMeters = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    totalMeters += pointDistanceMeters(coordinates[index - 1], coordinates[index]);
    cumulativeMeters.push(totalMeters);
  }

  return {
    coordinates,
    cumulativeMeters,
    totalMeters,
  };
}

function interpolateCoordinate(from: StoryCoordinate, to: StoryCoordinate, ratio: number): StoryCoordinate {
  return [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio];
}

export function getCoordinateAtProgress(metrics: StoryRouteMetrics, progress: number): StoryCoordinate {
  const normalizedProgress = clampProgress(progress);
  const targetMeters = metrics.totalMeters * normalizedProgress;

  for (let index = 1; index < metrics.cumulativeMeters.length; index += 1) {
    const segmentStartMeters = metrics.cumulativeMeters[index - 1];
    const segmentEndMeters = metrics.cumulativeMeters[index];

    if (targetMeters <= segmentEndMeters) {
      const segmentMeters = segmentEndMeters - segmentStartMeters;
      const ratio = segmentMeters === 0 ? 0 : (targetMeters - segmentStartMeters) / segmentMeters;
      return interpolateCoordinate(metrics.coordinates[index - 1], metrics.coordinates[index], ratio);
    }
  }

  return metrics.coordinates.at(-1) ?? metrics.coordinates[0];
}

export function sliceRouteAtProgress(metrics: StoryRouteMetrics, progress: number): StoryCoordinate[] {
  const normalizedProgress = clampProgress(progress);
  const targetMeters = metrics.totalMeters * normalizedProgress;
  const sliced: StoryCoordinate[] = [metrics.coordinates[0]];

  for (let index = 1; index < metrics.cumulativeMeters.length; index += 1) {
    const segmentStartMeters = metrics.cumulativeMeters[index - 1];
    const segmentEndMeters = metrics.cumulativeMeters[index];
    const segmentCoordinate = metrics.coordinates[index];

    if (targetMeters >= segmentEndMeters) {
      sliced.push(segmentCoordinate);
      continue;
    }

    const segmentMeters = segmentEndMeters - segmentStartMeters;
    const ratio = segmentMeters === 0 ? 0 : (targetMeters - segmentStartMeters) / segmentMeters;
    sliced.push(interpolateCoordinate(metrics.coordinates[index - 1], segmentCoordinate, ratio));
    break;
  }

  if (sliced.length === 1) {
    sliced.push(metrics.coordinates[0]);
  }

  return sliced;
}

export function toLineFeature(coordinates: StoryCoordinate[], id: string): GeoJsonLineString {
  if (coordinates.length < 2) {
    const coordinate = coordinates[0] ?? [0, 0];
    return {
      type: "LineString",
      coordinates: [coordinate, coordinate],
    } as GeoJsonLineString;
  }

  return {
    type: "LineString",
    coordinates,
  } as GeoJsonLineString;
}

export function toPointFeature(coordinate: StoryCoordinate): GeoJsonPoint {
  return {
    type: "Point",
    coordinates: coordinate,
  } as GeoJsonPoint;
}

export function getPolygonCenter(geometry: GeoJsonPolygon): StoryCoordinate {
  return getCenterForGeometry(geometry);
}
