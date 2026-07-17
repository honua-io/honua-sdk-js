import type { Query } from "@honua/sdk-js";

import {
  DEFAULT_FIRST_MAP_MAX_FEATURES,
  type FirstMapConfigInput,
  type FirstMapMode,
  type FirstMapProtocol,
} from "./first-map-config.js";

export interface FirstMapShellConfig {
  readonly endpoint: string;
  readonly mode: FirstMapMode;
  readonly protocol: FirstMapProtocol;
  readonly sourceId?: string;
  readonly maxFeatures: number;
  readonly query: Readonly<Omit<Query<Record<string, unknown>>, "signal">>;
  readonly basemapStyle: string;
}

export interface FirstMapEnvironment {
  readonly VITE_HONUA_FIRST_MAP_BASEMAP_STYLE?: string | boolean;
  readonly VITE_HONUA_FIRST_MAP_FILTER?: string | boolean;
  readonly VITE_HONUA_FIRST_MAP_MAX_FEATURES?: string | boolean;
  readonly VITE_HONUA_FIRST_MAP_MODE?: string | boolean;
  readonly VITE_HONUA_FIRST_MAP_PROTOCOL?: string | boolean;
  readonly VITE_HONUA_FIRST_MAP_SOURCE_ID?: string | boolean;
  readonly VITE_HONUA_FIRST_MAP_URL?: string | boolean;
}

const FIXTURE_LAYER_PATH = "/rest/services/natural-earth/FeatureServer/0";
const FIXTURE_BASEMAP_PATH = "/__honua-quickstart__/basemap-style.json";
const PUBLIC_BASEMAP_STYLE = "https://demotiles.maplibre.org/style.json";
export const FIRST_MAP_RUNTIME_BUDGET_MS = 5_000;

export function evaluateFirstMapRuntime(
  mode: FirstMapMode,
  durationMs: number,
): { withinBudget: boolean; preserveSuccessfulMap: boolean } {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError("First Map runtime must be non-negative.");
  const withinBudget = durationMs <= FIRST_MAP_RUNTIME_BUDGET_MS;
  return { withinBudget, preserveSuccessfulMap: withinBudget || mode === "public-live" };
}

export function resolveFirstMapShellConfig(
  environment: FirstMapEnvironment,
  browserOrigin: string,
): FirstMapShellConfig {
  const origin = normalizedOrigin(browserOrigin);
  const endpoint = textValue(environment.VITE_HONUA_FIRST_MAP_URL) ?? `${origin}${FIXTURE_LAYER_PATH}`;
  const mode = resolveMode(environment.VITE_HONUA_FIRST_MAP_MODE, endpoint, origin);
  const protocol = resolveProtocol(environment.VITE_HONUA_FIRST_MAP_PROTOCOL);
  const sourceId = textValue(environment.VITE_HONUA_FIRST_MAP_SOURCE_ID);
  const maxFeatures = positiveInteger(environment.VITE_HONUA_FIRST_MAP_MAX_FEATURES, DEFAULT_FIRST_MAP_MAX_FEATURES);
  const where = normalizedFilter(environment.VITE_HONUA_FIRST_MAP_FILTER);
  const query = Object.freeze({
    returnGeometry: true,
    pagination: Object.freeze({ limit: maxFeatures }),
    ...(where ? { where } : {}),
  });
  const configuredStyle = textValue(environment.VITE_HONUA_FIRST_MAP_BASEMAP_STYLE);
  return Object.freeze({
    endpoint,
    mode,
    protocol,
    ...(sourceId ? { sourceId } : {}),
    maxFeatures,
    query,
    basemapStyle: publicAssetUrl(
      configuredStyle ?? (mode === "fixture" ? `${origin}${FIXTURE_BASEMAP_PATH}` : PUBLIC_BASEMAP_STYLE),
      origin,
    ),
  });
}

export function toFirstMapConfigInput(
  shell: FirstMapShellConfig,
  update: Readonly<{ endpoint: string; protocol: FirstMapProtocol; sourceId?: string }>,
): FirstMapConfigInput<Record<string, unknown>> {
  return {
    endpoint: update.endpoint,
    mode: endpointMode(update.endpoint, shell.mode, shell.endpoint),
    protocol: update.protocol,
    ...(update.sourceId ? { sourceId: update.sourceId } : {}),
    maxFeatures: shell.maxFeatures,
    query: shell.query,
  };
}

function resolveMode(value: string | boolean | undefined, endpoint: string, origin: string): FirstMapMode {
  if (value === "fixture" || value === "public-live") return value;
  if (value !== undefined && value !== "") throw new TypeError('First Map mode must be "fixture" or "public-live".');
  return new URL(endpoint).origin === origin ? "fixture" : "public-live";
}

function endpointMode(endpoint: string, configured: FirstMapMode, configuredEndpoint: string): FirstMapMode {
  if (endpoint === configuredEndpoint) return configured;
  return configured === "fixture" && new URL(endpoint).origin === new URL(configuredEndpoint).origin
    ? "fixture"
    : "public-live";
}

function resolveProtocol(value: string | boolean | undefined): FirstMapProtocol {
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "geoservices-feature-service" || value === "ogc-features") return value;
  throw new TypeError("First Map supports auto, GeoServices FeatureServer, or OGC API Features discovery.");
}

function normalizedFilter(value: string | boolean | undefined): string | undefined {
  const filter = textValue(value);
  if (!filter || /^\(?\s*1\s*=\s*1\s*\)?$/i.test(filter)) return undefined;
  return filter;
}

function positiveInteger(value: string | boolean | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new TypeError("First Map limits must be integers.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RangeError("First Map limit is invalid.");
  return parsed;
}

function textValue(value: string | boolean | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizedOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (!/^https?:/.test(origin)) throw new TypeError("First Map requires an HTTP(S) browser origin.");
  return origin;
}

function publicAssetUrl(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      "First Map basemap styles must be credential-free HTTP(S) URLs without query or fragment data.",
    );
  }
  return url.href;
}
