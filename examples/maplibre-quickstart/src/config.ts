export interface QuickstartConfig {
  honuaBaseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  serviceId: string;
  layerId: number;
  where: string;
  resultRecordCount: number;
  basemapStyle: string;
  sourceId: string;
  layerIds: {
    fill: string;
    outline: string;
    line: string;
    circle: string;
  };
}

export const DEFAULT_QUICKSTART_BASEMAP_STYLE = "https://demotiles.maplibre.org/style.json";
export const DEFAULT_QUICKSTART_SERVICE_ID = "natural-earth";
export const DEFAULT_QUICKSTART_LAYER_ID = 0;
export const DEFAULT_QUICKSTART_WHERE = "1=1";
export const DEFAULT_QUICKSTART_RESULT_RECORD_COUNT = 25;

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readRequired(env: Record<string, string | undefined>, key: string, description: string): string {
  const value = readOptional(env, key);
  if (!value) {
    throw new Error(`${description} is required.`);
  }
  return value;
}

function readInteger(value: string, description: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${description} must be an integer.`);
  }
  return parsed;
}

function readPositiveIntegerWithFallback(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  description: string,
): number {
  const value = readOptional(env, key);
  if (!value) {
    return fallback;
  }
  const parsed = readInteger(value, description);
  if (parsed < 1) {
    throw new Error(`${description} must be greater than zero.`);
  }
  return parsed;
}

function readIntegerWithFallback(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  description: string,
): number {
  const value = readOptional(env, key);
  if (!value) {
    return fallback;
  }
  return readInteger(value, description);
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function createQuickstartConfig({
  baseUrl,
  apiKey,
  bearerToken,
  serviceId,
  layerId,
  where,
  resultRecordCount,
  basemapStyle,
}: {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  serviceId: string;
  layerId: number;
  where: string;
  resultRecordCount: number;
  basemapStyle: string;
}): QuickstartConfig {
  return {
    honuaBaseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    bearerToken,
    serviceId,
    layerId,
    where,
    resultRecordCount,
    basemapStyle,
    sourceId: "quickstart-features",
    layerIds: {
      fill: "quickstart-fill",
      outline: "quickstart-outline",
      line: "quickstart-line",
      circle: "quickstart-circle",
    },
  };
}

export function resolveQuickstartConfig(env: Record<string, string | undefined>): QuickstartConfig {
  return createQuickstartConfig({
    baseUrl: readOptional(env, "VITE_HONUA_QUICKSTART_BASE_URL") ?? "",
    apiKey: readOptional(env, "VITE_HONUA_QUICKSTART_API_KEY"),
    bearerToken: readOptional(env, "VITE_HONUA_QUICKSTART_BEARER_TOKEN"),
    serviceId: readOptional(env, "VITE_HONUA_QUICKSTART_SERVICE_ID") ?? DEFAULT_QUICKSTART_SERVICE_ID,
    layerId: readIntegerWithFallback(
      env,
      "VITE_HONUA_QUICKSTART_LAYER_ID",
      DEFAULT_QUICKSTART_LAYER_ID,
      "A quickstart layer id",
    ),
    where: readOptional(env, "VITE_HONUA_QUICKSTART_WHERE") ?? DEFAULT_QUICKSTART_WHERE,
    resultRecordCount: readPositiveIntegerWithFallback(
      env,
      "VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT",
      DEFAULT_QUICKSTART_RESULT_RECORD_COUNT,
      "A quickstart result record count",
    ),
    basemapStyle: readOptional(env, "VITE_HONUA_QUICKSTART_BASEMAP_STYLE") ?? DEFAULT_QUICKSTART_BASEMAP_STYLE,
  });
}

export function resolveQuickstartStagingConfig(env: Record<string, string | undefined>): QuickstartConfig {
  return createQuickstartConfig({
    baseUrl: readRequired(env, "HONUA_STAGING_BASE_URL", "HONUA_STAGING_BASE_URL"),
    apiKey: readOptional(env, "HONUA_STAGING_API_KEY"),
    bearerToken: readOptional(env, "HONUA_STAGING_BEARER_TOKEN"),
    serviceId: readRequired(env, "HONUA_STAGING_SERVICE_ID", "HONUA_STAGING_SERVICE_ID"),
    layerId: readInteger(
      readRequired(env, "HONUA_STAGING_LAYER_ID", "HONUA_STAGING_LAYER_ID"),
      "HONUA_STAGING_LAYER_ID",
    ),
    where: readOptional(env, "HONUA_STAGING_WHERE") ?? DEFAULT_QUICKSTART_WHERE,
    resultRecordCount: readPositiveIntegerWithFallback(
      env,
      "HONUA_STAGING_RESULT_RECORD_COUNT",
      DEFAULT_QUICKSTART_RESULT_RECORD_COUNT,
      "HONUA_STAGING_RESULT_RECORD_COUNT",
    ),
    basemapStyle: DEFAULT_QUICKSTART_BASEMAP_STYLE,
  });
}
