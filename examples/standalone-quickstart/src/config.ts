// Runtime configuration for the standalone quickstart.
//
// The whole point of this example is that it needs *zero* Honua infrastructure:
// the defaults below point at a public Esri GeoServices FeatureServer on
// services.arcgis.com. Override the `VITE_STANDALONE_*` vars (see `.env.example`)
// to aim it at any other public GeoServices endpoint.
//
// In the deterministic mock lane the fixture server rebuilds the app with
// `VITE_STANDALONE_FEATURE_LAYER_URL` pointed at a same-origin relative path so
// the recorded fixtures are replayed instead of the live endpoint.

export interface StandaloneConfig {
  /** Full GeoServices FeatureServer *layer* URL (`.../FeatureServer/{layerId}`). */
  featureLayerUrl: string;
  /** Server-side WHERE clause. */
  where: string;
  /** Fields to request; `["*"]` for all. */
  outFields: string[];
  /** Max pages the paginated query drains. */
  maxPages: number;
  /** MapLibre basemap style URL. */
  basemapStyle: string;
  /** MapLibre source id for the queried features. */
  sourceId: string;
}

export const DEFAULT_FEATURE_LAYER_URL =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";
export const DEFAULT_WHERE = "1=1";
export const DEFAULT_MAX_PAGES = 4;
export const DEFAULT_BASEMAP_STYLE = "https://demotiles.maplibre.org/style.json";

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseOutFields(value: string | undefined): string[] {
  if (!value) {
    return ["*"];
  }
  const fields = value
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  return fields.length > 0 ? fields : ["*"];
}

export function resolveStandaloneConfig(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): StandaloneConfig {
  const featureLayerUrl = readOptional(env, "VITE_STANDALONE_FEATURE_LAYER_URL") ?? DEFAULT_FEATURE_LAYER_URL;
  const where = readOptional(env, "VITE_STANDALONE_WHERE") ?? DEFAULT_WHERE;
  const outFields = parseOutFields(readOptional(env, "VITE_STANDALONE_OUT_FIELDS"));
  const maxPagesRaw = readOptional(env, "VITE_STANDALONE_MAX_PAGES");
  const maxPages = maxPagesRaw ? Math.max(1, Number.parseInt(maxPagesRaw, 10) || DEFAULT_MAX_PAGES) : DEFAULT_MAX_PAGES;
  const basemapStyle = readOptional(env, "VITE_STANDALONE_BASEMAP_STYLE") ?? DEFAULT_BASEMAP_STYLE;

  return {
    featureLayerUrl,
    where,
    outFields,
    maxPages,
    basemapStyle,
    sourceId: "standalone-features",
  };
}
