/**
 * Honua facade adapter: wraps the existing {@link HonuaGeocodingClient}
 * (Honua-hosted GeocodeServer locator) in the provider-pluggable
 * {@link GeocodingProvider} contract, making the Honua facade one provider
 * among several.
 *
 * @packageDocumentation
 */

import type { CapabilityPolicy } from "../../contract/types.js";
import type { HonuaGeocodingClient } from "../index.js";
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

/** Options for {@link honuaGeocodingProvider}. @experimental */
export interface HonuaGeocodingProviderOptions {
  /** Capability policy; the Honua locator supports all declared operations. */
  capabilityPolicy?: CapabilityPolicy;
  /** Override the default attribution string for your deployment's data. */
  attribution?: string;
  /** Usage-policy URL for your deployment, when applicable. */
  usagePolicyUrl?: string;
}

const HONUA_ATTRIBUTION = "Honua-hosted locator service";
const HONUA_CAPABILITIES: ReadonlyArray<GeocodingCapability> = ["geocode", "reverse", "suggest"];

/**
 * Wrap a {@link HonuaGeocodingClient} in the {@link GeocodingProvider}
 * contract.
 *
 * @experimental
 */
export function honuaGeocodingProvider(
  client: HonuaGeocodingClient,
  options: HonuaGeocodingProviderOptions = {},
): GeocodingProvider {
  const policy = options.capabilityPolicy ?? "strict";
  const provenance: GeocodingProvenance = Object.freeze({
    provider: "honua",
    attribution: options.attribution ?? HONUA_ATTRIBUTION,
    ...(options.usagePolicyUrl !== undefined ? { usagePolicyUrl: options.usagePolicyUrl } : {}),
  });

  return {
    id: "honua",
    capabilities: HONUA_CAPABILITIES,
    attribution: provenance.attribution,
    usagePolicyUrl: provenance.usagePolicyUrl,

    async geocode(query: string, geocodeOptions?: ProviderGeocodeOptions): Promise<ProviderGeocodeMatch[]> {
      assertGeocodingCapability({ id: "honua", capabilities: HONUA_CAPABILITIES }, "geocode", policy);
      const results = await client.forwardGeocode(query, {
        maxResults: geocodeOptions?.limit,
        countryCodes: geocodeOptions?.countryCodes,
      });
      return results.map((result) => ({
        address: result.address,
        latitude: result.latitude,
        longitude: result.longitude,
        score: result.score,
        attributes: result.attributes,
        provenance,
      }));
    },

    async reverse(latitude: number, longitude: number): Promise<ProviderReverseMatch | null> {
      assertGeocodingCapability({ id: "honua", capabilities: HONUA_CAPABILITIES }, "reverse", policy);
      const result = await client.reverseGeocode(latitude, longitude);
      if (!result) {
        return null;
      }
      return {
        address: result.address,
        latitude: result.latitude,
        longitude: result.longitude,
        attributes: result.attributes,
        provenance,
      };
    },

    async suggest(text: string, suggestOptions?: ProviderSuggestOptions): Promise<ProviderSuggestion[]> {
      assertGeocodingCapability({ id: "honua", capabilities: HONUA_CAPABILITIES }, "suggest", policy);
      const suggestions = await client.suggest(text, {
        maxSuggestions: suggestOptions?.limit,
        countryCodes: suggestOptions?.countryCodes,
      });
      return suggestions.map((suggestion) => ({ text: suggestion.text, provenance }));
    },
  };
}
