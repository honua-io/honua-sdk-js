/**
 * `@honua/sdk-js/geocoding` — `HonuaGeocodingClient` for forward / reverse
 * geocoding and typeahead suggestions over a Honua-hosted GeocodeServer.
 *
 * @example
 * ```ts
 * import { HonuaGeocodingClient } from "@honua/sdk-js/geocoding";
 *
 * const geo = new HonuaGeocodingClient({
 *   baseUrl: "https://your-honua-server.example",
 *   locatorName: "world-geocoder",
 * });
 *
 * const results = await geo.forwardGeocode("1 Honolulu Pl, HI");
 * // reverseGeocode is latitude-first, then longitude.
 * const here = await geo.reverseGeocode(21.30, -157.85);
 * const hints = await geo.suggest("honol");
 * ```
 *
 * @example Debounced typeahead
 * ```ts
 * let timer: ReturnType<typeof setTimeout> | undefined;
 * input.addEventListener("input", (event) => {
 *   clearTimeout(timer);
 *   const text = (event.target as HTMLInputElement).value;
 *   timer = setTimeout(async () => {
 *     render(await geo.suggest(text));
 *   }, 200);
 * });
 * ```
 *
 * @packageDocumentation
 */

import { HonuaAbortError, HonuaHttpError, HonuaNetworkError, HonuaTimeoutError } from "../core/errors.js";
import { encodeServiceIdPath, trimTrailingSlashes } from "../core/path-utils.js";

// ---------------------------------------------------------------------------
// Provider-pluggable geocoding (experimental)
// ---------------------------------------------------------------------------

export type { ProviderTransportOptions } from "./provider-http.js";
export type {
  CapabilityPolicy,
  GeocodingCapability,
  GeocodingProvenance,
  GeocodingProvider,
  ProviderGeocodeMatch,
  ProviderGeocodeOptions,
  ProviderReverseMatch,
  ProviderSuggestion,
  ProviderSuggestOptions,
} from "./provider.js";
export { assertGeocodingCapability, supportsGeocodingCapability } from "./provider.js";
export { type HonuaGeocodingProviderOptions, honuaGeocodingProvider } from "./providers/honua.js";
export { type NominatimProviderOptions, nominatimGeocodingProvider } from "./providers/nominatim.js";
export { type PeliasProviderOptions, peliasGeocodingProvider } from "./providers/pelias.js";
export { type PhotonProviderOptions, photonGeocodingProvider } from "./providers/photon.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeocodingClientOptions {
  baseUrl: string;
  locatorName?: string;
  apiKey?: string;
  bearerToken?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface ForwardGeocodeOptions {
  maxResults?: number;
  countryCodes?: string;
  spatialReferenceWkid?: number;
}

export interface ReverseGeocodeOptions {
  spatialReferenceWkid?: number;
}

export interface SuggestOptions {
  maxSuggestions?: number;
  countryCodes?: string;
}

export interface GeocodeResult {
  address: string;
  latitude: number;
  longitude: number;
  score: number;
  attributes: Record<string, string | null>;
}

export interface ReverseGeocodeResult {
  address: string;
  latitude: number;
  longitude: number;
  attributes: Record<string, string | null>;
}

export interface GeocodeSuggestion {
  text: string;
  magicKey: string;
  isCollection: boolean;
}

// ---------------------------------------------------------------------------
// Internal server response shapes
// ---------------------------------------------------------------------------

interface ServerCandidate {
  address: string;
  location: { x: number; y: number };
  score: number;
  attributes: Record<string, unknown>;
}

interface FindAddressCandidatesResponse {
  spatialReference?: Record<string, unknown>;
  candidates: ServerCandidate[];
  error?: ServerError;
}

interface ReverseGeocodeResponse {
  address: Record<string, unknown>;
  location: { x: number; y: number };
  error?: ServerError;
}

interface SuggestResponse {
  suggestions: Array<{
    text: string;
    magicKey: string;
    isCollection: boolean;
  }>;
  error?: ServerError;
}

interface ServerError {
  code: number;
  message: string;
  details?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Redirect status codes that carry a `Location` header. */
const GEOCODING_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Maximum number of redirects {@link HonuaGeocodingClient} will follow. */
const GEOCODING_MAX_REDIRECTS = 20;

function isAbsoluteHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function normalizeBaseUrl(url: string): string {
  return trimTrailingSlashes(url);
}

function stringifyAttributes(attrs: Record<string, unknown>): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) {
      result[key] = null;
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HonuaGeocodingClient {
  private readonly baseUrl: string;
  private readonly locatorName: string;
  private readonly fetchFn: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number | undefined;

  public constructor(options: GeocodingClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.locatorName = options.locatorName ?? "World";
    // Bind to `globalThis` at assignment: invoking an unbound `window.fetch`
    // as `this.fetchFn(...)` throws "TypeError: Illegal invocation" in
    // browsers. Binding is a no-op for Node's undici fetch and for
    // caller-supplied wrappers.
    this.fetchFn = (options.fetchFn ?? fetch).bind(globalThis);
    this.timeoutMs = options.timeoutMs;

    const headers: Record<string, string> = {};
    if (options.apiKey) {
      headers["X-API-Key"] = options.apiKey;
    }
    if (options.bearerToken) {
      headers.Authorization = `Bearer ${options.bearerToken}`;
    }
    this.defaultHeaders = headers;
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  /**
   * Forward-geocode a single-line address string into one or more candidate
   * locations.
   */
  public async forwardGeocode(address: string, options?: ForwardGeocodeOptions): Promise<GeocodeResult[]> {
    const params = new URLSearchParams();
    params.set("singleLine", address);
    params.set("f", "json");

    if (options?.maxResults !== undefined) {
      params.set("maxLocations", String(options.maxResults));
    }
    if (options?.countryCodes !== undefined) {
      params.set("countryCode", options.countryCodes);
    }
    if (options?.spatialReferenceWkid !== undefined) {
      params.set("outSR", String(options.spatialReferenceWkid));
    }

    const url = `${this.serviceBasePath()}/findAddressCandidates?${params.toString()}`;
    const { data, responseHeaders } = await this.request<FindAddressCandidatesResponse>(url);

    if (data.error) {
      throw this.geoServicesError(data.error, "Geocode", responseHeaders);
    }

    return (data.candidates ?? []).map((c) => ({
      address: c.address,
      longitude: c.location.x,
      latitude: c.location.y,
      score: c.score,
      attributes: stringifyAttributes(c.attributes ?? {}),
    }));
  }

  /**
   * Reverse-geocode a latitude/longitude pair to the nearest address.
   * Returns `null` when the server cannot find an address for the given
   * coordinates.
   */
  public async reverseGeocode(
    latitude: number,
    longitude: number,
    options?: ReverseGeocodeOptions,
  ): Promise<ReverseGeocodeResult | null> {
    const params = new URLSearchParams();
    params.set("location", `${longitude},${latitude}`);
    params.set("f", "json");

    if (options?.spatialReferenceWkid !== undefined) {
      params.set("outSR", String(options.spatialReferenceWkid));
    }

    const url = `${this.serviceBasePath()}/reverseGeocode?${params.toString()}`;

    let data: ReverseGeocodeResponse;
    let responseHeaders: Headers | undefined;
    try {
      ({ data, responseHeaders } = await this.request<ReverseGeocodeResponse>(url));
    } catch (err) {
      // Some geocode servers return an HTTP error when no address is found.
      if (err instanceof HonuaHttpError && err.statusCode === 400) {
        return null;
      }
      throw err;
    }

    if (data.error) {
      // Server-level "no result" errors are not exceptional.
      if (data.error.code === 400) {
        return null;
      }
      throw this.geoServicesError(data.error, "Reverse geocode", responseHeaders);
    }

    if (!data.address || !data.location) {
      return null;
    }

    const { Match_addr, ...rest } = data.address as Record<string, unknown> & {
      Match_addr?: string;
    };

    return {
      address: (Match_addr as string) ?? "",
      longitude: data.location.x,
      latitude: data.location.y,
      attributes: stringifyAttributes(rest),
    };
  }

  /**
   * Retrieve type-ahead suggestions for a partial address string.
   */
  public async suggest(text: string, options?: SuggestOptions): Promise<GeocodeSuggestion[]> {
    const params = new URLSearchParams();
    params.set("text", text);
    params.set("f", "json");

    if (options?.maxSuggestions !== undefined) {
      params.set("maxSuggestions", String(options.maxSuggestions));
    }
    if (options?.countryCodes !== undefined) {
      params.set("countryCode", options.countryCodes);
    }

    const url = `${this.serviceBasePath()}/suggest?${params.toString()}`;
    const { data, responseHeaders } = await this.request<SuggestResponse>(url);

    if (data.error) {
      throw this.geoServicesError(data.error, "Suggest", responseHeaders);
    }

    return (data.suggestions ?? []).map((s) => ({
      text: s.text,
      magicKey: s.magicKey,
      isCollection: s.isCollection,
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private serviceBasePath(): string {
    return `${this.baseUrl}/rest/services/${encodeServiceIdPath(this.locatorName)}/GeocodeServer`;
  }

  /**
   * Fetch with `redirect: "manual"`, only following a redirect when its target
   * stays on the configured base origin. The geocoding client attaches its API
   * key as a custom `X-API-Key` header that the runtime does not strip across a
   * cross-origin redirect, so auto-following one would leak the key to the
   * redirect target's host. Cross-origin (or origin-unverifiable) redirects
   * throw instead of replaying the credentialed request off-origin.
   */
  private async fetchWithSafeRedirects(url: string, init: RequestInit): Promise<Response> {
    const baseOrigin = isAbsoluteHttpUrl(this.baseUrl) ? new URL(this.baseUrl).origin : undefined;
    let currentUrl = url;
    for (let redirects = 0; ; redirects += 1) {
      const response = await this.fetchFn(currentUrl, { ...init, redirect: "manual" });

      if (response.type === "opaqueredirect") {
        throw new HonuaNetworkError(
          "Refusing to follow an opaque cross-origin redirect; the geocoding API key would be leaked to the redirect target.",
          undefined,
        );
      }

      if (!GEOCODING_REDIRECT_STATUSES.has(response.status)) {
        return response;
      }

      if (redirects >= GEOCODING_MAX_REDIRECTS) {
        throw new HonuaNetworkError(`Exceeded the maximum of ${GEOCODING_MAX_REDIRECTS} redirects.`, undefined);
      }

      const location = response.headers.get("location");
      if (!location) {
        throw new HonuaNetworkError("Redirect response is missing a Location header.", undefined);
      }
      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch {
        throw new HonuaNetworkError(`Redirect response has an invalid Location header: ${location}`, undefined);
      }
      if (baseOrigin === undefined || target.origin !== baseOrigin) {
        throw new HonuaNetworkError(
          `Refusing to follow a cross-origin redirect to ${target.origin}; the geocoding API key would be leaked.`,
          undefined,
        );
      }
      currentUrl = target.toString();
      await response.body?.cancel().catch(() => undefined);
    }
  }

  private geoServicesError(error: ServerError, operation: string, responseHeaders?: Headers): HonuaHttpError {
    return new HonuaHttpError(
      error.code,
      `${operation} server error: ${error.message}`,
      { error },
      {
        transportStatus: 200,
        protocolCode: error.code,
        ...(responseHeaders ? { responseHeaders } : {}),
      },
    );
  }

  private async request<T>(url: string): Promise<{ data: T; responseHeaders: Headers }> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (this.timeoutMs !== undefined) {
      timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetchWithSafeRedirects(url, {
        method: "GET",
        headers: this.defaultHeaders,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        if (this.timeoutMs !== undefined) {
          throw new HonuaTimeoutError(this.timeoutMs);
        }
        throw new HonuaAbortError();
      }
      throw new HonuaNetworkError(
        err instanceof Error
          ? `Geocoding request failed: ${err.message}`
          : "Geocoding request failed due to a network error",
        err,
      );
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      throw new HonuaHttpError(response.status, `Geocoding request failed with status ${response.status}`, body, {
        responseHeaders: response.headers,
      });
    }

    return { data: (await response.json()) as T, responseHeaders: response.headers };
  }
}
