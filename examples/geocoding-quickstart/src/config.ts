import type { GeocodingQuickstartConfig } from "./types.js";

export const DEFAULT_GEOCODING_LOCATOR_NAME = "World";
export const DEFAULT_GEOCODING_INITIAL_QUERY = "Honolulu civic landmarks";
export const DEFAULT_GEOCODING_MAX_RESULTS = 4;

/**
 * The public example is intentionally fixture-only. A relative base keeps the
 * committed GeocodeServer document inside the sample bundle on root and nested
 * static hosts without inventing a public geocoder.
 */
export function resolveGeocodingQuickstartConfig(baseUrl = "."): GeocodingQuickstartConfig {
  return {
    honuaBaseUrl: baseUrl.replace(/\/+$/, "") || ".",
    locatorName: DEFAULT_GEOCODING_LOCATOR_NAME,
    initialQuery: DEFAULT_GEOCODING_INITIAL_QUERY,
    maxResults: DEFAULT_GEOCODING_MAX_RESULTS,
    mode: "fixture-only",
  };
}
