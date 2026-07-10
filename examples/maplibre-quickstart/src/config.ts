export interface QuickstartConfig {
  mode: "fixture" | "live";
  honuaBaseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  serviceId: string;
  layerId: number;
  where: string;
  resultRecordCount: number;
  basemapStyle: string;
  dataVersion: string;
  capturedAt?: string;
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
export const QUICKSTART_FIXTURE_DATA_VERSION = "honolulu-operations-v1";
export const QUICKSTART_FIXTURE_CAPTURED_AT = "2026-07-01T00:00:00.000Z";

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
  dataVersion,
  capturedAt,
}: {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  serviceId: string;
  layerId: number;
  where: string;
  resultRecordCount: number;
  basemapStyle: string;
  dataVersion: string;
  capturedAt?: string;
}): QuickstartConfig {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  return {
    mode: normalizedBaseUrl.length > 0 ? "live" : "fixture",
    honuaBaseUrl: normalizedBaseUrl,
    apiKey,
    bearerToken,
    serviceId,
    layerId,
    where,
    resultRecordCount,
    basemapStyle,
    dataVersion,
    capturedAt,
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
  const baseUrl = readOptional(env, "VITE_HONUA_QUICKSTART_BASE_URL") ?? "";
  if (readOptional(env, "VITE_HONUA_QUICKSTART_API_KEY") || readOptional(env, "VITE_HONUA_QUICKSTART_BEARER_TOKEN")) {
    throw new Error(
      "The browser quickstart is intentionally secret-free. Use an anonymous live endpoint or a server-side proxy.",
    );
  }
  return createQuickstartConfig({
    baseUrl,
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
    dataVersion:
      readOptional(env, "VITE_HONUA_QUICKSTART_DATA_VERSION") ??
      (baseUrl.length > 0 ? "live-unversioned" : QUICKSTART_FIXTURE_DATA_VERSION),
    capturedAt:
      readOptional(env, "VITE_HONUA_QUICKSTART_CAPTURED_AT") ??
      (baseUrl.length > 0 ? undefined : QUICKSTART_FIXTURE_CAPTURED_AT),
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
    dataVersion: readOptional(env, "HONUA_STAGING_DATA_VERSION") ?? "live-unversioned",
    capturedAt: readOptional(env, "HONUA_STAGING_CAPTURED_AT"),
  });
}
