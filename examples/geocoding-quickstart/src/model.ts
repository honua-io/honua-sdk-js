import { type GeocodeResult, type GeocodingClientOptions, HonuaGeocodingClient } from "@honua/sdk-js/geocoding";

import type { GeocodingAuditRow, GeocodingPointFeatureCollection, GeocodingQuickstartConfig } from "./types.js";

export function geocodingClientOptionsFromConfig(config: GeocodingQuickstartConfig): GeocodingClientOptions {
  return {
    baseUrl: config.honuaBaseUrl,
    locatorName: config.locatorName,
    fetchFn: globalThis.fetch.bind(globalThis),
  };
}

export function createGeocodingClient(config: GeocodingQuickstartConfig): HonuaGeocodingClient {
  return new HonuaGeocodingClient(geocodingClientOptionsFromConfig(config));
}

export function createGeocodingAuditRows(config: GeocodingQuickstartConfig | string = "World"): GeocodingAuditRow[] {
  const locatorName = typeof config === "string" ? config : config.locatorName;
  const baseUrl = typeof config === "string" ? "" : config.honuaBaseUrl;
  return [
    {
      capability: "Forward geocoding",
      interaction: "Address selection",
      sdkSurface: "HonuaGeocodingClient.forwardGeocode",
      endpoint: `${baseUrl}/rest/services/${encodeURIComponent(locatorName)}/GeocodeServer/findAddressCandidates`,
      cachePolicy: "Committed fixture document; immutable for the built sample revision",
    },
  ];
}

export function emptyGeocodingFeatureCollection(): GeocodingPointFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function geocodeResultsToFeatures(results: readonly GeocodeResult[]): GeocodingPointFeatureCollection {
  return {
    type: "FeatureCollection",
    features: results.map((result, index) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [result.longitude, result.latitude],
      },
      properties: {
        kind: "forward",
        index,
        address: result.address,
        subtitle: result.attributes.PlaceName ?? result.attributes.Addr_type ?? "Address candidate",
        latitude: result.latitude,
        longitude: result.longitude,
        score: result.score,
      },
    })),
  };
}

export function formatCoordinate(value: number): string {
  return value.toFixed(5);
}
