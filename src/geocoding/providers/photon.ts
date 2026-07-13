/**
 * Photon adapter for the {@link GeocodingProvider} contract.
 *
 * Photon (komoot) is typeahead-first, so it supports all three operations:
 * `geocode`, `reverse`, and `suggest` (suggest reuses the search endpoint,
 * which is designed for as-you-type queries).
 *
 * There is no default endpoint: pass the `baseUrl` of an instance you are
 * entitled to use (e.g. a self-hosted Photon, or `https://photon.komoot.io`
 * within its fair-use terms).
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

/** Options for {@link photonGeocodingProvider}. @experimental */
export interface PhotonProviderOptions extends ProviderTransportOptions {
  /**
   * Base URL of the Photon instance, e.g. `https://photon.example.org`.
   * Required — no third-party default is baked in (usage-policy safety).
   */
  baseUrl: string;
  /** BCP-47 language for results, forwarded as `lang` when set. */
  language?: string;
  /** Capability policy; Photon supports all declared operations. */
  capabilityPolicy?: CapabilityPolicy;
  /** Override the default attribution string (self-hosted instances). */
  attribution?: string;
  /** Override the default usage-policy URL (self-hosted instances). */
  usagePolicyUrl?: string;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    housenumber?: string;
    street?: string;
    postcode?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
  };
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

const PHOTON_ATTRIBUTION = "Data © OpenStreetMap contributors, ODbL 1.0";
const PHOTON_USAGE_POLICY_URL = "https://photon.komoot.io/";
const PHOTON_CAPABILITIES: ReadonlyArray<GeocodingCapability> = ["geocode", "reverse", "suggest"];

function photonLabel(feature: PhotonFeature): string {
  const p = feature.properties ?? {};
  const streetLine = p.housenumber && p.street ? `${p.street} ${p.housenumber}` : p.street;
  const parts = [p.name, streetLine, p.city, p.state, p.country].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  // Photon repeats `name` for street-level results; drop consecutive duplicates.
  return parts.filter((part, index) => part !== parts[index - 1]).join(", ");
}

/**
 * Create a {@link GeocodingProvider} backed by a Photon instance.
 *
 * @experimental
 */
export function photonGeocodingProvider(options: PhotonProviderOptions): GeocodingProvider {
  const baseUrl = trimProviderBaseUrl(options.baseUrl);
  const policy = options.capabilityPolicy ?? "strict";
  const provenance: GeocodingProvenance = Object.freeze({
    provider: "photon",
    attribution: options.attribution ?? PHOTON_ATTRIBUTION,
    usagePolicyUrl: options.usagePolicyUrl ?? PHOTON_USAGE_POLICY_URL,
  });

  const request = (path: string, params: URLSearchParams, label: string): Promise<PhotonResponse> => {
    if (options.language) {
      params.set("lang", options.language);
    }
    return providerGetJson<PhotonResponse>(`${baseUrl}${path}?${params.toString()}`, {
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      label,
    });
  };

  const toMatch = (feature: PhotonFeature): ProviderGeocodeMatch => {
    const [longitude, latitude] = feature.geometry?.coordinates ?? [Number.NaN, Number.NaN];
    const p = feature.properties ?? {};
    return {
      address: photonLabel(feature),
      latitude,
      longitude,
      attributes: stringifyProviderAttributes({
        osm_id: p.osm_id,
        osm_type: p.osm_type,
        osm_key: p.osm_key,
        osm_value: p.osm_value,
        postcode: p.postcode,
        type: p.type,
      }),
      provenance,
    };
  };

  const search = async (query: string, limit: number | undefined, label: string): Promise<ProviderGeocodeMatch[]> => {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }
    const data = await request("/api", params, label);
    return (data.features ?? []).map(toMatch);
  };

  return {
    id: "photon",
    capabilities: PHOTON_CAPABILITIES,
    attribution: provenance.attribution,
    usagePolicyUrl: provenance.usagePolicyUrl,

    async geocode(query: string, geocodeOptions?: ProviderGeocodeOptions): Promise<ProviderGeocodeMatch[]> {
      assertGeocodingCapability({ id: "photon", capabilities: PHOTON_CAPABILITIES }, "geocode", policy);
      return search(query, geocodeOptions?.limit, "photon geocode");
    },

    async reverse(latitude: number, longitude: number): Promise<ProviderReverseMatch | null> {
      assertGeocodingCapability({ id: "photon", capabilities: PHOTON_CAPABILITIES }, "reverse", policy);
      const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
      const data = await request("/reverse", params, "photon reverse");
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
      assertGeocodingCapability({ id: "photon", capabilities: PHOTON_CAPABILITIES }, "suggest", policy);
      const matches = await search(text, suggestOptions?.limit, "photon suggest");
      return matches.map((match) => ({ text: match.address, provenance }));
    },
  };
}
