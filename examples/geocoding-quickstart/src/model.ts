import {
  type GeocodeResult,
  type GeocodingClientOptions,
  HonuaGeocodingClient,
  type ReverseGeocodeResult,
} from "@honua/sdk-js/geocoding";

import type {
  GeocodingAuditRow,
  GeocodingPointFeature,
  GeocodingPointFeatureCollection,
  GeocodingQuickstartConfig,
} from "./types.js";

export function geocodingClientOptionsFromConfig(config: GeocodingQuickstartConfig): GeocodingClientOptions {
  return {
    baseUrl: config.honuaBaseUrl,
    locatorName: config.locatorName,
    fetchFn: globalThis.fetch.bind(globalThis),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.bearerToken ? { bearerToken: config.bearerToken } : {}),
  };
}

export function createGeocodingClient(config: GeocodingQuickstartConfig): HonuaGeocodingClient {
  return new HonuaGeocodingClient(geocodingClientOptionsFromConfig(config));
}

export function createGeocodingAuditRows(config: GeocodingQuickstartConfig | string = "World"): GeocodingAuditRow[] {
  const locatorName = typeof config === "string" ? config : config.locatorName;
  const baseUrl = typeof config === "string" ? "" : config.honuaBaseUrl;
  const basePath = `${baseUrl}/rest/services/${encodeURIComponent(locatorName)}/GeocodeServer`;
  return [
    {
      capability: "Forward geocoding",
      interaction: "Address search",
      sdkSurface: "HonuaGeocodingClient.forwardGeocode",
      endpoint: `${basePath}/findAddressCandidates`,
      cachePolicy: "Ad hoc search result; do not cache across user input",
    },
    {
      capability: "Reverse geocoding",
      interaction: "Map click",
      sdkSurface: "HonuaGeocodingClient.reverseGeocode",
      endpoint: `${basePath}/reverseGeocode`,
      cachePolicy: "Ad hoc point lookup; do not cache across clicked coordinates",
    },
    {
      capability: "Typeahead suggestions",
      interaction: "Search input",
      sdkSurface: "HonuaGeocodingClient.suggest",
      endpoint: `${basePath}/suggest`,
      cachePolicy: "Short-lived UI hint; fixture lane serves deterministic responses",
    },
  ];
}

export function emptyGeocodingFeatureCollection(): GeocodingPointFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function geocodeResultsToFeatures(results: readonly GeocodeResult[]): GeocodingPointFeatureCollection {
  return {
    type: "FeatureCollection",
    features: results.map((result) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [result.longitude, result.latitude],
      },
      properties: {
        kind: "forward",
        address: result.address,
        subtitle: result.attributes.Addr_type ?? `Score ${Math.round(result.score)}`,
        latitude: result.latitude,
        longitude: result.longitude,
        score: result.score,
      },
    })),
  };
}

export function reverseResultToFeature(result: ReverseGeocodeResult | null): GeocodingPointFeatureCollection {
  if (!result) return emptyGeocodingFeatureCollection();
  const feature: GeocodingPointFeature = {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [result.longitude, result.latitude],
    },
    properties: {
      kind: "reverse",
      address: result.address,
      subtitle: result.attributes.Addr_type ?? result.attributes.City ?? "Nearest address",
      latitude: result.latitude,
      longitude: result.longitude,
    },
  };
  return {
    type: "FeatureCollection",
    features: [feature],
  };
}

export function formatCoordinate(value: number): string {
  return value.toFixed(5);
}
