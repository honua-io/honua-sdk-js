import type { GeocodingQuickstartConfig } from "./types.js";

export const DEFAULT_GEOCODING_LOCATOR_NAME = "World";
export const DEFAULT_GEOCODING_INITIAL_QUERY = "Honolulu Hale";
export const DEFAULT_GEOCODING_COUNTRY_CODES = "US";
export const DEFAULT_GEOCODING_MAX_RESULTS = 5;
export const DEFAULT_GEOCODING_MAX_SUGGESTIONS = 5;

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function readPositiveIntegerWithFallback(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  description: string,
): number {
  const value = readOptional(env, key);
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${description} must be a positive integer.`);
  }
  return parsed;
}

export function resolveGeocodingQuickstartConfig(
  env: Record<string, string | undefined>,
  fallbackOrigin = globalThis.location?.origin ?? "",
): GeocodingQuickstartConfig {
  const explicitBaseUrl = readOptional(env, "VITE_HONUA_GEOCODING_BASE_URL");
  const honuaBaseUrl = normalizeBaseUrl(explicitBaseUrl ?? fallbackOrigin);

  return {
    honuaBaseUrl,
    apiKey: readOptional(env, "VITE_HONUA_GEOCODING_API_KEY"),
    bearerToken: readOptional(env, "VITE_HONUA_GEOCODING_BEARER_TOKEN"),
    locatorName: readOptional(env, "VITE_HONUA_GEOCODING_LOCATOR_NAME") ?? DEFAULT_GEOCODING_LOCATOR_NAME,
    initialQuery: readOptional(env, "VITE_HONUA_GEOCODING_INITIAL_QUERY") ?? DEFAULT_GEOCODING_INITIAL_QUERY,
    countryCodes: readOptional(env, "VITE_HONUA_GEOCODING_COUNTRY_CODES") ?? DEFAULT_GEOCODING_COUNTRY_CODES,
    maxResults: readPositiveIntegerWithFallback(
      env,
      "VITE_HONUA_GEOCODING_MAX_RESULTS",
      DEFAULT_GEOCODING_MAX_RESULTS,
      "A geocoding max result count",
    ),
    maxSuggestions: readPositiveIntegerWithFallback(
      env,
      "VITE_HONUA_GEOCODING_MAX_SUGGESTIONS",
      DEFAULT_GEOCODING_MAX_SUGGESTIONS,
      "A geocoding max suggestion count",
    ),
    mode: explicitBaseUrl ? "live" : "fixture-safe",
  };
}
