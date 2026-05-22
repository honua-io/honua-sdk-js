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
 * const results = await geo.findAddressCandidates({ singleLine: "1 Honolulu Pl, HI" });
 * const here = await geo.reverseGeocode({ location: { x: -157.85, y: 21.30 } });
 * const hints = await geo.suggest({ text: "honol" });
 * ```
 *
 * @example Streaming typeahead with AbortSignal
 * ```ts
 * const controller = new AbortController();
 * input.addEventListener("input", async (event) => {
 *   controller.abort();
 *   const hints = await geo.suggest({ text: event.target.value, signal: controller.signal });
 *   render(hints);
 * });
 * ```
 *
 * @packageDocumentation
 */

import { HonuaAbortError, HonuaHttpError, HonuaNetworkError, HonuaTimeoutError } from "../core/errors.js";

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

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
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
    this.fetchFn = options.fetchFn ?? fetch;
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
    const data = await this.request<FindAddressCandidatesResponse>(url);

    if (data.error) {
      throw new HonuaHttpError(data.error.code, `Geocode server error: ${data.error.message}`, data.error);
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
    try {
      data = await this.request<ReverseGeocodeResponse>(url);
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
      throw new HonuaHttpError(data.error.code, `Reverse geocode server error: ${data.error.message}`, data.error);
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
    const data = await this.request<SuggestResponse>(url);

    if (data.error) {
      throw new HonuaHttpError(data.error.code, `Suggest server error: ${data.error.message}`, data.error);
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
    return `${this.baseUrl}/rest/services/${encodeURIComponent(this.locatorName)}/GeocodeServer`;
  }

  private async request<T>(url: string): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (this.timeoutMs !== undefined) {
      timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
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
      throw new HonuaHttpError(response.status, `Geocoding request failed with status ${response.status}`, body);
    }

    return (await response.json()) as T;
  }
}
