// The standalone data path — this is the code the quickstart is built to prove.
//
// Nothing here talks to a Honua server. It points the SDK at a public Esri
// GeoServices FeatureServer and gets back:
//   1. a ready-to-render MapLibre `geojson` source (via `@honua/sdk-js/map`), and
//   2. the same result through the drop-in Esri compatibility layer
//      (`FeatureLayerCompat`), proving an `esri-leaflet`-style API works against
//      services.arcgis.com URLs with zero server involvement.

export interface StandaloneGeoJsonFeature {
  type: "Feature";
  id?: string | number;
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

export interface StandaloneGeoJson {
  type: "FeatureCollection";
  features: StandaloneGeoJsonFeature[];
}

export interface StandaloneDataset {
  /** MapLibre `geojson` source spec produced by the SDK. */
  source: { type: "geojson"; data: StandaloneGeoJson };
  geojson: StandaloneGeoJson;
  featureCount: number;
  /** Feature count fetched through `FeatureLayerCompat` (the esri-compat proof). */
  compatFeatureCount: number;
  layerName: string;
  geometryType?: string;
  /** Visible non-fatal observations, such as metadata fallback. */
  degradationReasons: string[];
  /** `[west, south, east, north]` for `fitBounds`, when computable. */
  bounds?: [number, number, number, number];
  endpointHost: string;
}

export function describeHost(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  return "same-origin (recorded fixture)";
}

export function computeBounds(geojson: StandaloneGeoJson): [number, number, number, number] | undefined {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  const visit = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) {
      return;
    }
    if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
      const [lon, lat] = coordinates as [number, number];
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      return;
    }
    for (const child of coordinates) {
      visit(child);
    }
  };

  for (const feature of geojson.features) {
    if (feature.geometry) {
      visit(feature.geometry.coordinates);
    }
  }

  if (!Number.isFinite(west) || !Number.isFinite(east)) {
    return undefined;
  }
  return [west, south, east, north];
}
