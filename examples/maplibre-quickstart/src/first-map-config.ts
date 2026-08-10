import type { ConnectProtocolHint, Query } from "@honua/sdk-js";

export type FirstMapMode = "fixture" | "public-live";
export type FirstMapProtocol = Extract<ConnectProtocolHint, "auto" | "geoservices-feature-service" | "ogc-features">;

export const PUBLIC_FIRST_MAP_ENDPOINT = "https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1";
export const SAME_ORIGIN_FIRST_MAP_FIXTURE = "honua:first-map-fixture";
export const FIRST_MAP_FIXTURE_GEOSERVICES_PATH = "/rest/services/natural-earth/FeatureServer/0";
export const FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH = "/ogc/features/collections/maui-census-tracts-2025";

const FIRST_MAP_FIXTURE_OGC_ROOT_PATH = "/ogc/features";

export interface FirstMapConfig<T = Record<string, unknown>> {
  readonly endpoint: string;
  readonly mode: FirstMapMode;
  readonly protocol: FirstMapProtocol;
  readonly sourceId?: string;
  readonly maxFeatures: number;
  readonly query: Readonly<Omit<Query<T>, "signal">>;
}

export interface FirstMapConfigInput<T = Record<string, unknown>> {
  readonly endpoint: string | URL;
  readonly mode?: FirstMapMode;
  readonly protocol?: FirstMapProtocol;
  readonly sourceId?: string;
  readonly maxFeatures?: number;
  readonly query?: Readonly<Omit<Query<T>, "signal">>;
}

export const DEFAULT_FIRST_MAP_MAX_FEATURES = 5_000;
export const MAX_FIRST_MAP_FEATURES = 10_000;

/** Keep canonical OGC collection URLs in the form while connecting through their service root plus collection scope. */
export function firstMapConnectLocator(config: Pick<FirstMapConfig, "endpoint" | "protocol">) {
  if (config.protocol !== "ogc-features") return { url: config.endpoint, protocol: config.protocol };
  const parsed = new URL(config.endpoint);
  const marker = parsed.pathname.toLowerCase().indexOf("/collections/");
  if (marker < 0) return { url: config.endpoint, protocol: config.protocol };
  const collectionId = parsed.pathname.slice(marker + "/collections/".length).split("/")[0];
  if (!collectionId) return { url: config.endpoint, protocol: config.protocol };
  return {
    url: `${parsed.origin}${parsed.pathname.slice(0, marker)}`,
    protocol: config.protocol,
    collectionId,
  };
}

/** Switch only the known same-origin fixture endpoint when its protocol control changes. */
export function endpointForFirstMapProtocol(
  endpoint: string,
  protocol: FirstMapProtocol,
  fixtureOrigin: string,
): string {
  if (protocol === "auto") return endpoint;
  let current: URL;
  let origin: URL;
  try {
    current = new URL(endpoint);
    origin = new URL(fixtureOrigin);
  } catch {
    return endpoint;
  }
  const pathname = current.pathname.replace(/\/+$/, "") || "/";
  if (
    current.origin !== origin.origin ||
    current.search ||
    current.hash ||
    ![
      FIRST_MAP_FIXTURE_GEOSERVICES_PATH,
      FIRST_MAP_FIXTURE_OGC_ROOT_PATH,
      FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH,
    ].includes(pathname)
  ) {
    return endpoint;
  }
  const targetPath =
    protocol === "ogc-features" ? FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH : FIRST_MAP_FIXTURE_GEOSERVICES_PATH;
  return new URL(targetPath, `${origin.origin}/`).href;
}

export function resolveFirstMapConfig<T = Record<string, unknown>>(input: FirstMapConfigInput<T>): FirstMapConfig<T> {
  const endpoint = normalizePublicEndpoint(input.endpoint);
  if (input.mode !== undefined && input.mode !== "fixture" && input.mode !== "public-live") {
    throw new TypeError('First Map mode must be "fixture" or "public-live".');
  }
  if (
    input.protocol !== undefined &&
    input.protocol !== "auto" &&
    input.protocol !== "geoservices-feature-service" &&
    input.protocol !== "ogc-features"
  ) {
    throw new TypeError("First Map supports GeoServices FeatureServer and OGC API Features endpoints.");
  }
  const maxFeatures = input.maxFeatures ?? DEFAULT_FIRST_MAP_MAX_FEATURES;
  if (!Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > MAX_FIRST_MAP_FEATURES) {
    throw new RangeError(`First Map maxFeatures must be between 1 and ${MAX_FIRST_MAP_FEATURES}.`);
  }
  if (input.sourceId !== undefined && (!input.sourceId || input.sourceId.trim() !== input.sourceId)) {
    throw new TypeError("First Map sourceId must be a non-empty, trimmed advertised identifier.");
  }
  const requestedLimit = input.query?.pagination?.limit ?? maxFeatures;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new RangeError("First Map query pagination.limit must be a positive safe integer.");
  }
  const query = Object.freeze({
    ...input.query,
    returnGeometry: true,
    pagination: Object.freeze({ ...input.query?.pagination, limit: Math.min(requestedLimit, maxFeatures) }),
  }) as Readonly<Omit<Query<T>, "signal">>;
  return Object.freeze({
    endpoint,
    mode: input.mode ?? "public-live",
    protocol: input.protocol ?? "auto",
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    maxFeatures,
    query,
  });
}

function normalizePublicEndpoint(value: string | URL): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("First Map requires an absolute HTTP(S) endpoint URL.");
  }
  if (!/^https?:$/.test(endpoint.protocol)) throw new TypeError("First Map supports only HTTP(S) endpoint URLs.");
  const removableFormat =
    endpoint.searchParams.size > 0 &&
    [...endpoint.searchParams].every(
      ([name, value]) =>
        (name.toLowerCase() === "f" || name.toLowerCase() === "format") &&
        (value.toLowerCase() === "json" || value.toLowerCase() === "pjson"),
    );
  if (endpoint.username || endpoint.password || (endpoint.search && !removableFormat) || endpoint.hash) {
    throw new TypeError("First Map endpoint URLs cannot contain credentials, query parameters, or fragments.");
  }
  if (removableFormat) endpoint.search = "";
  return endpoint.href.replace(/\/$/, "");
}
