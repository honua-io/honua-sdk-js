/**
 * Nominatim adapter for the {@link GeocodingProvider} contract.
 *
 * Supports `geocode` and `reverse`; Nominatim has no typeahead endpoint, so
 * `suggest` is declared unsupported and throws
 * `HonuaCapabilityNotSupportedError` under the strict capability policy.
 *
 * There is no default endpoint: pass the `baseUrl` of an instance you are
 * entitled to use. If you point at the public
 * `https://nominatim.openstreetmap.org` service you MUST follow the OSMF
 * Nominatim usage policy — at most 1 request/second, a real `userAgent`
 * identifying your application, and no heavy typeahead-style traffic.
 *
 * @packageDocumentation
 */

import type { CapabilityPolicy } from "../../contract/types.js";
import {
  type ProviderTransportOptions,
  providerGetJson,
  stringifyProviderAttributes,
  trimProviderBaseUrl,
} from "../provider-http.js";
import {
  type GeocodingCapability,
  type GeocodingProvenance,
  type GeocodingProvider,
  type ProviderGeocodeMatch,
  type ProviderGeocodeOptions,
  type ProviderReverseMatch,
  type ProviderSuggestion,
  assertGeocodingCapability,
} from "../provider.js";

/** Options for {@link nominatimGeocodingProvider}. @experimental */
export interface NominatimProviderOptions extends ProviderTransportOptions {
  /**
   * Base URL of the Nominatim instance, e.g. `https://nominatim.example.org`.
   * Required — no third-party default is baked in (usage-policy safety).
   */
  baseUrl: string;
  /**
   * Value for the `User-Agent` header. The OSMF usage policy requires a real
   * application identifier when using the public instance. Only settable in
   * non-browser runtimes; browsers control their own `User-Agent`.
   */
  userAgent?: string;
  /** Contact email forwarded as the `email` query parameter (public-instance etiquette). */
  email?: string;
  /** Capability policy; `"strict"` (default) throws on `suggest`. */
  capabilityPolicy?: CapabilityPolicy;
  /** Override the default attribution string (self-hosted instances). */
  attribution?: string;
  /** Override the default usage-policy URL (self-hosted instances). */
  usagePolicyUrl?: string;
}

interface NominatimPlace {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  display_name?: string;
  category?: string;
  type?: string;
  importance?: number;
  error?: string;
}

const NOMINATIM_ATTRIBUTION = "Data © OpenStreetMap contributors, ODbL 1.0";
const NOMINATIM_USAGE_POLICY_URL = "https://operations.osmfoundation.org/policies/nominatim/";
const NOMINATIM_CAPABILITIES: ReadonlyArray<GeocodingCapability> = ["geocode", "reverse"];

/**
 * Create a {@link GeocodingProvider} backed by a Nominatim instance.
 *
 * @experimental
 */
export function nominatimGeocodingProvider(options: NominatimProviderOptions): GeocodingProvider {
  const baseUrl = trimProviderBaseUrl(options.baseUrl);
  const policy = options.capabilityPolicy ?? "strict";
  const headers: Record<string, string> = {};
  if (options.userAgent) {
    headers["User-Agent"] = options.userAgent;
  }
  const provenance: GeocodingProvenance = Object.freeze({
    provider: "nominatim",
    attribution: options.attribution ?? NOMINATIM_ATTRIBUTION,
    usagePolicyUrl: options.usagePolicyUrl ?? NOMINATIM_USAGE_POLICY_URL,
  });

  const request = <T>(path: string, params: URLSearchParams, label: string): Promise<T> => {
    params.set("format", "jsonv2");
    if (options.email) {
      params.set("email", options.email);
    }
    return providerGetJson<T>(`${baseUrl}${path}?${params.toString()}`, {
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      headers,
      label,
    });
  };

  const toMatch = (place: NominatimPlace): ProviderGeocodeMatch => ({
    address: place.display_name ?? "",
    latitude: Number(place.lat),
    longitude: Number(place.lon),
    score: place.importance,
    attributes: stringifyProviderAttributes({
      place_id: place.place_id,
      osm_type: place.osm_type,
      osm_id: place.osm_id,
      category: place.category,
      type: place.type,
    }),
    provenance,
  });

  return {
    id: "nominatim",
    capabilities: NOMINATIM_CAPABILITIES,
    attribution: provenance.attribution,
    usagePolicyUrl: provenance.usagePolicyUrl,

    async geocode(query: string, geocodeOptions?: ProviderGeocodeOptions): Promise<ProviderGeocodeMatch[]> {
      assertGeocodingCapability({ id: "nominatim", capabilities: NOMINATIM_CAPABILITIES }, "geocode", policy);
      const params = new URLSearchParams({ q: query });
      if (geocodeOptions?.limit !== undefined) {
        params.set("limit", String(geocodeOptions.limit));
      }
      if (geocodeOptions?.countryCodes !== undefined) {
        params.set("countrycodes", geocodeOptions.countryCodes);
      }
      const places = await request<NominatimPlace[]>("/search", params, "nominatim geocode");
      return (places ?? []).map(toMatch);
    },

    async reverse(latitude: number, longitude: number): Promise<ProviderReverseMatch | null> {
      assertGeocodingCapability({ id: "nominatim", capabilities: NOMINATIM_CAPABILITIES }, "reverse", policy);
      const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
      const place = await request<NominatimPlace>("/reverse", params, "nominatim reverse");
      // Nominatim reports "no result" as `{ "error": "Unable to geocode" }`.
      if (!place || place.error !== undefined || place.lat === undefined) {
        return null;
      }
      const match = toMatch(place);
      return {
        address: match.address,
        latitude: match.latitude,
        longitude: match.longitude,
        attributes: match.attributes,
        provenance,
      };
    },

    async suggest(): Promise<ProviderSuggestion[]> {
      // Declared capability miss: Nominatim's usage policy forbids
      // autocomplete-style traffic and it exposes no suggest endpoint.
      assertGeocodingCapability({ id: "nominatim", capabilities: NOMINATIM_CAPABILITIES }, "suggest", policy);
      return [];
    },
  };
}
