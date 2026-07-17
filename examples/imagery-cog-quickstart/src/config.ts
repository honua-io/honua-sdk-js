import type { HonuaClientOptions } from "@honua/sdk-js/honua";

export interface ImageryCogConfig {
  readonly honuaBaseUrl: string;
  readonly mode: "fixture-safe" | "live";
}

const MAX_BASE_URL_LENGTH = 2_048;

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string, fallbackOrigin: string): string {
  if (value.length > MAX_BASE_URL_LENGTH || fallbackOrigin.length > MAX_BASE_URL_LENGTH) {
    throw new Error(`Honua base URLs must not exceed ${MAX_BASE_URL_LENGTH} characters.`);
  }
  const fallback = new URL(fallbackOrigin);
  if (!["http:", "https:"].includes(fallback.protocol) || fallback.username || fallback.password) {
    throw new Error("The browser fallback origin must be an HTTP(S) origin without embedded credentials.");
  }
  const resolved = new URL(value, fallback);
  if (!["http:", "https:"].includes(resolved.protocol) || resolved.origin !== fallback.origin) {
    throw new Error(
      "VITE_HONUA_IMAGERY_BASE_URL must use the browser origin; expose authenticated Honua through a same-origin proxy or session.",
    );
  }
  if (resolved.username || resolved.password || resolved.search || resolved.hash) {
    throw new Error(
      "VITE_HONUA_IMAGERY_BASE_URL must be a credential-free path without URL userinfo, query parameters, or fragments.",
    );
  }
  return resolved.toString().replace(/\/+$/, "");
}

export function resolveImageryCogConfig(
  env: Record<string, string | undefined>,
  fallbackOrigin = globalThis.location?.origin ?? "http://127.0.0.1",
): ImageryCogConfig {
  const configured = readOptional(env, "VITE_HONUA_IMAGERY_BASE_URL");
  return {
    honuaBaseUrl: normalizeBaseUrl(configured ?? fallbackOrigin, fallbackOrigin),
    mode: configured ? "live" : "fixture-safe",
  };
}

export function clientOptionsFromImageryConfig(config: ImageryCogConfig): HonuaClientOptions {
  return {
    baseUrl: config.honuaBaseUrl,
    fetchFn: globalThis.fetch.bind(globalThis),
  };
}
