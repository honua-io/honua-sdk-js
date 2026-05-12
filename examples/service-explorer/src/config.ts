import type { ServiceExplorerConfig, ServiceExplorerDataMode } from "./types.js";

export const DEFAULT_SERVICE_EXPLORER_BASE_URL = "https://cloud.honua.io";
export const DEFAULT_SERVICE_EXPLORER_SERVICE_ID = "natural-earth";
export const DEFAULT_SERVICE_EXPLORER_LAYER_ID = 0;
export const DEFAULT_SERVICE_EXPLORER_WHERE = "1=1";
export const DEFAULT_SERVICE_EXPLORER_RESULT_RECORD_COUNT = 100;
export const DEFAULT_SERVICE_EXPLORER_MAP_MOVE_DEBOUNCE_MS = 160;
const BROWSER_BEARER_TOKEN_OPT_IN = "VITE_HONUA_ALLOW_BROWSER_BEARER_TOKEN";

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readInteger(value: string, description: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${description} must be an integer.`);
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
  return value ? readInteger(value, description) : fallback;
}

function readPositiveIntegerWithFallback(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  description: string,
): number {
  const parsed = readIntegerWithFallback(env, key, fallback, description);
  if (parsed < 1) {
    throw new Error(`${description} must be greater than zero.`);
  }
  return parsed;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function readBrowserBearerToken(env: Record<string, string | undefined>, key: string): string | undefined {
  const token = readOptional(env, key);
  if (!token) return undefined;
  if (typeof globalThis.window === "undefined" || readOptional(env, BROWSER_BEARER_TOKEN_OPT_IN) === "true") {
    return token;
  }
  console.warn(`${key} is ignored in browser demos unless ${BROWSER_BEARER_TOKEN_OPT_IN}=true is set.`);
  return undefined;
}

function readDataMode(env: Record<string, string | undefined>): ServiceExplorerDataMode {
  const mode = readOptional(env, "VITE_HONUA_SERVICE_EXPLORER_MODE") ?? "auto";
  if (mode === "auto" || mode === "cloud" || mode === "fixture") return mode;
  throw new Error("VITE_HONUA_SERVICE_EXPLORER_MODE must be one of auto, cloud, or fixture.");
}

export function hasCloudCredentials(config: Pick<ServiceExplorerConfig, "apiKey" | "bearerToken">): boolean {
  return Boolean(config.apiKey || config.bearerToken);
}

export function shouldUseFixtureData(config: ServiceExplorerConfig): boolean {
  return config.mode === "fixture" || (config.mode === "auto" && !hasCloudCredentials(config));
}

export function resolveServiceExplorerConfig(env: Record<string, string | undefined>): ServiceExplorerConfig {
  return {
    honuaBaseUrl: normalizeBaseUrl(
      readOptional(env, "VITE_HONUA_SERVICE_EXPLORER_BASE_URL") ?? DEFAULT_SERVICE_EXPLORER_BASE_URL,
    ),
    apiKey: readOptional(env, "VITE_HONUA_SERVICE_EXPLORER_API_KEY"),
    bearerToken: readBrowserBearerToken(env, "VITE_HONUA_SERVICE_EXPLORER_BEARER_TOKEN"),
    mode: readDataMode(env),
    serviceId: readOptional(env, "VITE_HONUA_SERVICE_EXPLORER_SERVICE_ID") ?? DEFAULT_SERVICE_EXPLORER_SERVICE_ID,
    layerId: readIntegerWithFallback(
      env,
      "VITE_HONUA_SERVICE_EXPLORER_LAYER_ID",
      DEFAULT_SERVICE_EXPLORER_LAYER_ID,
      "A service explorer layer id",
    ),
    where: readOptional(env, "VITE_HONUA_SERVICE_EXPLORER_WHERE") ?? DEFAULT_SERVICE_EXPLORER_WHERE,
    resultRecordCount: readPositiveIntegerWithFallback(
      env,
      "VITE_HONUA_SERVICE_EXPLORER_RESULT_RECORD_COUNT",
      DEFAULT_SERVICE_EXPLORER_RESULT_RECORD_COUNT,
      "A service explorer result record count",
    ),
    mapMoveDebounceMs: readPositiveIntegerWithFallback(
      env,
      "VITE_HONUA_SERVICE_EXPLORER_MAP_MOVE_DEBOUNCE_MS",
      DEFAULT_SERVICE_EXPLORER_MAP_MOVE_DEBOUNCE_MS,
      "A service explorer map movement debounce",
    ),
    selectedSourceId: readOptional(env, "VITE_HONUA_SERVICE_EXPLORER_SOURCE_ID"),
  };
}
