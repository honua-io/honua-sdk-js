// Endpoint-to-map demo configuration. Secret-free by design: the demo talks
// to a public Esri Living Atlas FeatureServer (live lane) or to same-origin
// recorded fixtures (mock lane). Override with `VITE_ENDPOINT_TO_MAP_*` vars.

export interface EndpointToMapConfig {
  mode: "fixture" | "live";
  /** Full GeoServices FeatureServer *layer* URL (`…/FeatureServer/{layerId}`). */
  featureLayerUrl: string;
  basemapStyle: string;
  maxFeatures: number;
  popupFields: readonly string[];
  /** WHERE clauses offered by the live-filter dropdown. */
  filters: ReadonlyArray<{ label: string; where: string }>;
}

export const DEFAULT_ENDPOINT_TO_MAP_URL =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";
export const DEFAULT_ENDPOINT_TO_MAP_BASEMAP = "https://demotiles.maplibre.org/style.json";

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function assertSecretFreeUrl(value: string): void {
  const url = new URL(value, "http://127.0.0.1");
  if (url.username || url.password) {
    throw new Error("The endpoint-to-map demo is secret-free; the endpoint URL must not carry credentials.");
  }
}

export function resolveEndpointToMapConfig(env: Record<string, string | undefined>): EndpointToMapConfig {
  const rawUrl = readOptional(env, "VITE_ENDPOINT_TO_MAP_URL") ?? DEFAULT_ENDPOINT_TO_MAP_URL;
  assertSecretFreeUrl(rawUrl);
  // The mock lane rebuilds with a same-origin relative path; connect() needs
  // an absolute URL, so resolve against the page origin in the browser.
  const featureLayerUrl =
    rawUrl.startsWith("/") && typeof window !== "undefined" ? new URL(rawUrl, window.location.origin).href : rawUrl;
  const maxFeaturesRaw = readOptional(env, "VITE_ENDPOINT_TO_MAP_MAX_FEATURES");
  const maxFeatures = maxFeaturesRaw ? Number.parseInt(maxFeaturesRaw, 10) : 5000;
  if (!Number.isInteger(maxFeatures) || maxFeatures < 1) {
    throw new Error("VITE_ENDPOINT_TO_MAP_MAX_FEATURES must be a positive integer.");
  }
  return {
    mode: rawUrl.startsWith("/") ? "fixture" : "live",
    featureLayerUrl,
    basemapStyle: readOptional(env, "VITE_ENDPOINT_TO_MAP_BASEMAP_STYLE") ?? DEFAULT_ENDPOINT_TO_MAP_BASEMAP,
    maxFeatures,
    popupFields: ["NAME", "Total_Pop_2020", "Seats_2020"],
    filters: [
      { label: "All states", where: "" },
      { label: "10+ House seats", where: "Seats_2020 >= 10" },
      { label: "Population over 10M", where: "Total_Pop_2020 > 10000000" },
    ],
  };
}
