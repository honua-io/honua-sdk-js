import { createFixtureCogFetch } from "./fixture-range-fetch.js";

export interface ImageryCogConfig {
  honuaBaseUrl: string;
  mode: "fixture-safe" | "live";
}
type ImageryCogEnvironment = Record<string, string | boolean | undefined>;

export function resolveImageryCogConfig(
  environment: ImageryCogEnvironment,
  fallbackOrigin = globalThis.location?.origin ?? "http://127.0.0.1",
): ImageryCogConfig {
  const configured =
    typeof environment.VITE_HONUA_IMAGERY_BASE_URL === "string" ? environment.VITE_HONUA_IMAGERY_BASE_URL.trim() : "";
  if (!configured) return { honuaBaseUrl: fallbackOrigin, mode: "fixture-safe" };
  const resolved = new URL(configured, fallbackOrigin);
  if (resolved.origin !== new URL(fallbackOrigin).origin) {
    throw new Error("VITE_HONUA_IMAGERY_BASE_URL must resolve through a same-origin proxy.");
  }
  if (resolved.username || resolved.password || resolved.search || resolved.hash) {
    throw new Error(
      "VITE_HONUA_IMAGERY_BASE_URL must be a credential-free path without query parameters or fragments.",
    );
  }
  if (resolved.pathname.length > 2_048) {
    throw new Error("VITE_HONUA_IMAGERY_BASE_URL paths must not exceed 2048 characters.");
  }
  return { honuaBaseUrl: resolved.href.replace(/\/$/, ""), mode: "live" };
}

export function clientOptionsFromImageryConfig(config: ImageryCogConfig): { baseUrl: string; fetchFn: typeof fetch } {
  if (config.mode === "live") return { baseUrl: config.honuaBaseUrl, fetchFn: globalThis.fetch.bind(globalThis) };
  const originalFetch = globalThis.fetch.bind(globalThis);
  const appRootUrl = new URL(config.honuaBaseUrl.endsWith("/") ? config.honuaBaseUrl : `${config.honuaBaseUrl}/`);
  const fixtureRootUrl = new URL("./fixtures/cog/", globalThis.location?.href ?? `${config.honuaBaseUrl}/`);
  const fetchFn = createFixtureCogFetch({ appRootUrl, fixtureRootUrl, fetchImpl: originalFetch });
  if (typeof window !== "undefined") globalThis.fetch = fetchFn;
  return { baseUrl: config.honuaBaseUrl, fetchFn };
}
