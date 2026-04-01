import type { StoryDemoConfig } from "./types.js";

const DEFAULT_BASEMAP_STYLE = "https://demotiles.maplibre.org/style.json";
const DEFAULT_COLLECTIONS = {
  assets: "story-25d-assets",
  route: "story-25d-route",
  stops: "story-25d-stops",
} as const;

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readRequiredWithFallback(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
  description: string,
): string {
  const value = readOptional(env, key) ?? fallback;
  if (value.length < 1) {
    throw new Error(`${description} is required.`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveStoryDemoConfig(env: Record<string, string | undefined>): StoryDemoConfig {
  const baseUrl = normalizeBaseUrl(readOptional(env, "VITE_HONUA_25D_BASE_URL") ?? "");

  return {
    honuaBaseUrl: baseUrl,
    apiKey: readOptional(env, "VITE_HONUA_25D_API_KEY"),
    basemapStyle: readRequiredWithFallback(
      env,
      "VITE_HONUA_25D_BASEMAP_STYLE",
      DEFAULT_BASEMAP_STYLE,
      "A basemap style URL",
    ),
    collections: {
      assets: readRequiredWithFallback(
        env,
        "VITE_HONUA_25D_ASSETS_COLLECTION",
        DEFAULT_COLLECTIONS.assets,
        "An assets collection id",
      ),
      route: readRequiredWithFallback(
        env,
        "VITE_HONUA_25D_ROUTE_COLLECTION",
        DEFAULT_COLLECTIONS.route,
        "A route collection id",
      ),
      stops: readRequiredWithFallback(
        env,
        "VITE_HONUA_25D_STOPS_COLLECTION",
        DEFAULT_COLLECTIONS.stops,
        "A stops collection id",
      ),
    },
    sourceIds: {
      assets: "story-assets",
      route: "story-route",
      routeProgress: "story-route-progress",
      routeMarker: "story-route-marker",
      stops: "story-stops",
    },
    priorityRiskThreshold: 70,
    routeAnimationMs: 4_800,
    initialPitch: 62,
    initialBearing: -18,
  };
}
