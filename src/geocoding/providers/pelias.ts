/**
 * Pelias adapter for the {@link GeocodingProvider} contract.
 *
 * Supports `geocode` (`/v1/search`), `reverse` (`/v1/reverse`), and `suggest`
 * via the dedicated `/v1/autocomplete` endpoint.
 *
 * There is no default endpoint: pass the `baseUrl` of an instance you are
 * entitled to use (self-hosted Pelias or a hosted service such as
 * geocode.earth, whose terms and API key requirements you must follow).
 * Attribution depends on the datasets the instance is built from — override
 * `attribution` to match your instance's obligations.
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
  type ProviderSuggestOptions,
  type ProviderSuggestion,
  assertGeocodingCapability,
} from "../provider.js";

/** Options for {@link peliasGeocodingProvider}. @experimental */
export interface PeliasProviderOptions extends ProviderTransportOptions {
  /**
   * Base URL of the Pelias instance, e.g. `https://pelias.example.org`.
   * Required — no third-party default is baked in (usage-policy safety).
   */
  baseUrl: string;
  /** API key forwarded as the `api_key` query parameter (hosted instances). */
  apiKey?: string;
  /** Capability policy; Pelias supports all declared operations. */
  capabilityPolicy?: CapabilityPolicy;
  /** Override the default attribution string to match your instance's datasets. */
  attribution?: string;
  /** Override the default usage-policy URL (hosted/self-hosted instances). */
  usagePolicyUrl?: string;
}

interface PeliasFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    gid?: string;
    layer?: string;
    source?: string;
    name?: string;
    label?: string;
    confidence?: number;
    country_code?: string;
    postalcode?: string;
  };
}

interface PeliasResponse {
  features?: PeliasFeature[];
}

const PELIAS_ATTRIBUTION = "Geocoding by Pelias; data © OpenStreetMap contributors and other dataset licensors";
const PELIAS_USAGE_POLICY_URL = "https://github.com/pelias/documentation/blob/master/data-licenses.md";
const PELIAS_CAPABILITIES: ReadonlyArray<GeocodingCapability> = ["geocode", "reverse", "suggest"];

/**
 * Create a {@link GeocodingProvider} backed by a Pelias instance.
 *
 * @experimental
 */
export function peliasGeocodingProvider(options: PeliasProviderOptions): GeocodingProvider {
  const baseUrl = trimProviderBaseUrl(options.baseUrl);
  const policy = options.capabilityPolicy ?? "strict";
  const provenance: GeocodingProvenance = Object.freeze({
    provider: "pelias",
    attribution: options.attribution ?? PELIAS_ATTRIBUTION,
    usagePolicyUrl: options.usagePolicyUrl ?? PELIAS_USAGE_POLICY_URL,
  });

  const request = (path: string, params: URLSearchParams, label: string): Promise<PeliasResponse> => {
    if (options.apiKey) {
      params.set("api_key", options.apiKey);
    }
    return providerGetJson<PeliasResponse>(`${baseUrl}${path}?${params.toString()}`, {
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      label,
    });
  };

  const toMatch = (feature: PeliasFeature): ProviderGeocodeMatch => {
    const [longitude, latitude] = feature.geometry?.coordinates ?? [Number.NaN, Number.NaN];
    const p = feature.properties ?? {};
    return {
      address: p.label ?? p.name ?? "",
      latitude,
      longitude,
      score: p.confidence,
      attributes: stringifyProviderAttributes({
        gid: p.gid,
        layer: p.layer,
        source: p.source,
        country_code: p.country_code,
        postalcode: p.postalcode,
      }),
      provenance,
    };
  };

  const applyCountryFilter = (params: URLSearchParams, countryCodes: string | undefined): void => {
    if (countryCodes !== undefined) {
      params.set("boundary.country", countryCodes);
    }
  };

  return {
    id: "pelias",
    capabilities: PELIAS_CAPABILITIES,
    attribution: provenance.attribution,
    usagePolicyUrl: provenance.usagePolicyUrl,

    async geocode(query: string, geocodeOptions?: ProviderGeocodeOptions): Promise<ProviderGeocodeMatch[]> {
      assertGeocodingCapability({ id: "pelias", capabilities: PELIAS_CAPABILITIES }, "geocode", policy);
      const params = new URLSearchParams({ text: query });
      if (geocodeOptions?.limit !== undefined) {
        params.set("size", String(geocodeOptions.limit));
      }
      applyCountryFilter(params, geocodeOptions?.countryCodes);
      const data = await request("/v1/search", params, "pelias geocode");
      return (data.features ?? []).map(toMatch);
    },

    async reverse(latitude: number, longitude: number): Promise<ProviderReverseMatch | null> {
      assertGeocodingCapability({ id: "pelias", capabilities: PELIAS_CAPABILITIES }, "reverse", policy);
      const params = new URLSearchParams({
        "point.lat": String(latitude),
        "point.lon": String(longitude),
      });
      const data = await request("/v1/reverse", params, "pelias reverse");
      const feature = data.features?.[0];
      if (!feature) {
        return null;
      }
      const match = toMatch(feature);
      return {
        address: match.address,
        latitude: match.latitude,
        longitude: match.longitude,
        attributes: match.attributes,
        provenance,
      };
    },

    async suggest(text: string, suggestOptions?: ProviderSuggestOptions): Promise<ProviderSuggestion[]> {
      assertGeocodingCapability({ id: "pelias", capabilities: PELIAS_CAPABILITIES }, "suggest", policy);
      const params = new URLSearchParams({ text });
      if (suggestOptions?.limit !== undefined) {
        params.set("size", String(suggestOptions.limit));
      }
      applyCountryFilter(params, suggestOptions?.countryCodes);
      const data = await request("/v1/autocomplete", params, "pelias suggest");
      return (data.features ?? []).map((feature) => ({
        text: feature.properties?.label ?? feature.properties?.name ?? "",
        provenance,
      }));
    },
  };
}
