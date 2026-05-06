import type { HonuaClientOptions } from "@honua/sdk-js/honua";

export interface ImageryCogConfig {
  readonly honuaBaseUrl: string;
  readonly apiKey?: string;
  readonly bearerToken?: string;
  readonly mode: "fixture-safe" | "live";
}

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveImageryCogConfig(
  env: Record<string, string | undefined>,
  fallbackOrigin = globalThis.location?.origin ?? "",
): ImageryCogConfig {
  const honuaBaseUrl = normalizeBaseUrl(readOptional(env, "VITE_HONUA_IMAGERY_BASE_URL") ?? fallbackOrigin);
  return {
    honuaBaseUrl,
    apiKey: readOptional(env, "VITE_HONUA_IMAGERY_API_KEY"),
    bearerToken: readOptional(env, "VITE_HONUA_IMAGERY_BEARER_TOKEN"),
    mode: readOptional(env, "VITE_HONUA_IMAGERY_BASE_URL") ? "live" : "fixture-safe",
  };
}

export function clientOptionsFromImageryConfig(config: ImageryCogConfig): HonuaClientOptions {
  return {
    baseUrl: config.honuaBaseUrl,
    fetchFn: globalThis.fetch.bind(globalThis),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.bearerToken ? { bearerToken: config.bearerToken } : {}),
  };
}

export function rasterRequestHeaders(config: ImageryCogConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (config.apiKey) headers["X-API-Key"] = config.apiKey;
  if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;
  return Object.keys(headers).length > 0 ? headers : undefined;
}
