/**
 * Provider-pluggable geocoding contract: `GeocodingProvider` plus the
 * normalized result shapes every adapter maps into. The Honua facade
 * (`honuaGeocodingProvider`) and the open-source adapters (Nominatim, Photon,
 * Pelias) all implement this one interface so hosts can swap providers with
 * configuration only.
 *
 * Capability differences between providers are declared up front via
 * {@link GeocodingProvider.capabilities} and enforced with the SDK's existing
 * capability policy: an unsupported operation throws
 * `HonuaCapabilityNotSupportedError` under the default `"strict"` policy and
 * degrades to an empty result under `"degraded"`.
 *
 * @packageDocumentation
 */

import type { CapabilityPolicy } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";

/**
 * Operations a {@link GeocodingProvider} may support.
 *
 * @experimental
 */
export type GeocodingCapability = "geocode" | "reverse" | "suggest";

/**
 * Identifies which provider produced a result and carries that provider's
 * attribution / usage-policy obligations so hosts can surface them (for
 * example in a map attribution control).
 *
 * @experimental
 */
export interface GeocodingProvenance {
  /** Provider identifier, e.g. `"nominatim"`, `"photon"`, `"pelias"`, `"honua"`. */
  readonly provider: string;
  /** Human-readable data attribution the host is obliged to display. */
  readonly attribution: string;
  /** Usage/acceptable-use policy for the configured endpoint, when known. */
  readonly usagePolicyUrl?: string;
}

/**
 * Normalized forward-geocode candidate. Mirrors the contract shape of
 * `GeocodeResult` with provider provenance stamped on every result.
 *
 * @experimental
 */
export interface ProviderGeocodeMatch {
  /** Formatted address / place label. */
  address: string;
  latitude: number;
  longitude: number;
  /**
   * Provider-reported match quality when available (Nominatim `importance`,
   * Pelias `confidence`, Honua locator `score`). Scale is provider-specific.
   */
  score?: number;
  /** Provider-specific attributes, stringified to the contract shape. */
  attributes: Record<string, string | null>;
  provenance: GeocodingProvenance;
}

/**
 * Normalized reverse-geocode result.
 *
 * @experimental
 */
export interface ProviderReverseMatch {
  address: string;
  latitude: number;
  longitude: number;
  attributes: Record<string, string | null>;
  provenance: GeocodingProvenance;
}

/**
 * Normalized typeahead suggestion.
 *
 * @experimental
 */
export interface ProviderSuggestion {
  text: string;
  provenance: GeocodingProvenance;
}

/**
 * Options for {@link GeocodingProvider.geocode}.
 *
 * @experimental
 */
export interface ProviderGeocodeOptions {
  /** Maximum number of candidates to return. */
  limit?: number;
  /** Comma-separated ISO 3166-1 alpha-2 country codes, e.g. `"us,ca"`. */
  countryCodes?: string;
}

/**
 * Options for {@link GeocodingProvider.suggest}.
 *
 * @experimental
 */
export interface ProviderSuggestOptions {
  /** Maximum number of suggestions to return. */
  limit?: number;
  /** Comma-separated ISO 3166-1 alpha-2 country codes, e.g. `"us,ca"`. */
  countryCodes?: string;
}

/**
 * Provider-pluggable geocoding contract. All adapters normalize into the same
 * typed result shapes; capability differences are declared, not discovered at
 * runtime.
 *
 * Operations outside {@link capabilities} throw
 * `HonuaCapabilityNotSupportedError` under the `"strict"` capability policy
 * (the default) and resolve to an empty result under `"degraded"`.
 *
 * @experimental
 */
export interface GeocodingProvider {
  /** Stable provider identifier, e.g. `"nominatim"`. */
  readonly id: string;
  /** Operations this provider supports. */
  readonly capabilities: ReadonlyArray<GeocodingCapability>;
  /** Human-readable data attribution the host is obliged to display. */
  readonly attribution: string;
  /** Usage/acceptable-use policy for the configured endpoint, when known. */
  readonly usagePolicyUrl?: string;

  /** Forward-geocode a free-text query into candidate locations. */
  geocode(query: string, options?: ProviderGeocodeOptions): Promise<ProviderGeocodeMatch[]>;
  /** Reverse-geocode a latitude/longitude pair; `null` when nothing is found. */
  reverse(latitude: number, longitude: number): Promise<ProviderReverseMatch | null>;
  /** Typeahead suggestions for a partial query. */
  suggest(text: string, options?: ProviderSuggestOptions): Promise<ProviderSuggestion[]>;
}

/**
 * `true` when `provider` declares `capability`.
 *
 * @experimental
 */
export function supportsGeocodingCapability(provider: GeocodingProvider, capability: GeocodingCapability): boolean {
  return provider.capabilities.includes(capability);
}

/**
 * Enforce a capability declaration against the active capability policy.
 * Returns `true` when the capability is supported. When it is missing, throws
 * `HonuaCapabilityNotSupportedError` under `"strict"` (the default) or returns
 * `false` under `"degraded"` so callers can resolve to an empty result.
 *
 * @experimental
 */
export function assertGeocodingCapability(
  provider: Pick<GeocodingProvider, "id" | "capabilities">,
  capability: GeocodingCapability,
  policy: CapabilityPolicy = "strict",
): boolean {
  if (provider.capabilities.includes(capability)) {
    return true;
  }
  if (policy === "strict") {
    throw new HonuaCapabilityNotSupportedError(capability, provider.id);
  }
  return false;
}

/** Re-exported so provider hosts can type their policy without importing `/contract`. */
export type { CapabilityPolicy };
