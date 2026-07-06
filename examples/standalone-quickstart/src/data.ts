// The standalone data path — this is the code the quickstart is built to prove.
//
// Nothing here talks to a Honua server. It points the SDK at a public Esri
// GeoServices FeatureServer and gets back:
//   1. a ready-to-render MapLibre `geojson` source (via `@honua/sdk-js/map`), and
//   2. the same result through the drop-in Esri compatibility layer
//      (`FeatureLayerCompat`), proving an `esri-leaflet`-style API works against
//      services.arcgis.com URLs with zero server involvement.

import { FeatureLayerCompat, parseFeatureLayerUrl } from "@honua/sdk-js/esri-compat";
import { HonuaClient } from "@honua/sdk-js/honua";
import { loadHonuaFeatureServiceGeoJson } from "@honua/sdk-js/map";

import type { StandaloneConfig } from "./config.js";

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
  /** `[west, south, east, north]` for `fitBounds`, when computable. */
  bounds?: [number, number, number, number];
  endpointHost: string;
}

function describeHost(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  return "same-origin (recorded fixture)";
}

function computeBounds(geojson: StandaloneGeoJson): [number, number, number, number] | undefined {
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

export async function loadStandaloneDataset(config: StandaloneConfig): Promise<StandaloneDataset> {
  const parsed = parseFeatureLayerUrl(config.featureLayerUrl);
  const client = new HonuaClient({ baseUrl: parsed.baseUrl });

  // (1) One SDK call: public FeatureServer URL -> MapLibre `geojson` source.
  const source = (await loadHonuaFeatureServiceGeoJson(client, config.featureLayerUrl, {
    definitionExpression: config.where,
    outFields: config.outFields,
    maxPages: config.maxPages,
  })) as { type: "geojson"; data: StandaloneGeoJson };
  const geojson = source.data;

  // Typed layer metadata (name/geometry) — same client, same public endpoint.
  const metadata = await client.getLayerMetadata(parsed.serviceId, parsed.layerId).catch(() => undefined);

  // (2) The esri-compat drop-in against the identical URL. This is the migration
  // proof: `esri-leaflet`-shaped code runs standalone.
  const featureLayer = new FeatureLayerCompat({ url: config.featureLayerUrl, client });
  const compatResponse = await featureLayer.queryFeatures({
    where: config.where,
    outFields: config.outFields,
    returnGeometry: false,
  });

  return {
    source,
    geojson,
    featureCount: geojson.features.length,
    compatFeatureCount: compatResponse.features?.length ?? 0,
    layerName: metadata?.name ?? parsed.serviceId,
    geometryType: metadata?.geometryType,
    bounds: computeBounds(geojson),
    endpointHost: describeHost(config.featureLayerUrl),
  };
}
