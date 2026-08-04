/**
 * ArcGIS `Locator` / `@arcgis/core/rest/locator` compatibility, backed entirely
 * by the provider-pluggable geocoding contract in `src/geocoding/`.
 *
 * There is no Honua server dependency: the caller supplies a
 * {@link GeocodingProvider} (Nominatim / Photon / Pelias / Honua) once and the
 * shim projects ArcGIS-shaped parameters onto it and ArcGIS-shaped candidates
 * back out.
 *
 * Capability honesty is inherited from the geocoding layer rather than faked:
 * a provider that does not declare `suggest` (Nominatim) makes
 * {@link LocatorCompat.suggestLocations} throw `HonuaCapabilityNotSupportedError`
 * under the default `"strict"` policy, and makes the derived search source omit
 * its `suggest` hook entirely so the Search widget simply does not offer
 * typeahead. ArcGIS locator parameters the provider contract cannot express
 * (`searchExtent`, proximity `location`, `categories`, `magicKey`,
 * `locationType`) are rejected the same way instead of being silently dropped.
 *
 * @packageDocumentation
 */

import type { CapabilityPolicy } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import {
  type GeocodingProvenance,
  type GeocodingProvider,
  type ProviderGeocodeMatch,
  type ProviderReverseMatch,
  assertGeocodingCapability,
  supportsGeocodingCapability,
} from "../geocoding/provider.js";
import { CompatEventBus, safeInvokeCompatListener } from "./event-bus.js";
import type { SearchRequestCompat, SearchResultCompat, SearchSourceCompat, SearchSuggestionCompat } from "./search.js";

/** Structural `SpatialReference` accepted wherever ArcGIS takes one. */
export interface LocatorSpatialReferenceLike {
  wkid?: number;
  latestWkid?: number;
}

/** ArcGIS-shaped `Point` returned on every candidate. */
export interface LocatorPointCompat {
  x: number;
  y: number;
  longitude: number;
  latitude: number;
  spatialReference: { wkid: number };
}

/** ArcGIS-shaped `Extent` returned on every candidate. */
export interface LocatorExtentCompat {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference: { wkid: number };
}

/**
 * ArcGIS-shaped `AddressCandidate`, plus the geocoding provenance the host is
 * obliged to display (Honua addition — ArcGIS has no equivalent field).
 */
export interface LocatorAddressCandidateCompat {
  address: string;
  attributes: Record<string, string | null>;
  location: LocatorPointCompat;
  extent: LocatorExtentCompat;
  score: number;
  provenance: GeocodingProvenance;
}

/**
 * ArcGIS-shaped `SuggestionResult`. `magicKey` is always `""`: the geocoding
 * provider contract has no opaque re-resolution handle, so a suggestion is
 * re-resolved by its `text`.
 */
export interface LocatorSuggestionCompat {
  text: string;
  magicKey: string;
  isCollection: boolean;
  provenance: GeocodingProvenance;
}

/** ArcGIS multi-field address input; `SingleLine` is the supported form. */
export interface LocatorAddressInputCompat {
  SingleLine?: string;
  singleLine?: string;
  Address?: string;
  address?: string;
  City?: string;
  Region?: string;
  Postal?: string;
  CountryCode?: string;
  [key: string]: unknown;
}

/** Parameters for {@link LocatorCompat.addressToLocations}. */
export interface AddressToLocationsParamsCompat {
  address?: LocatorAddressInputCompat | string;
  countryCode?: string;
  maxLocations?: number;
  outFields?: readonly string[] | string;
  outSpatialReference?: LocatorSpatialReferenceLike | number;
  /** Unsupported by the provider contract; rejected under `"strict"`. */
  categories?: readonly string[] | string;
  /** Proximity bias — unsupported by the provider contract. */
  location?: unknown;
  /** Result-window filter — unsupported by the provider contract. */
  searchExtent?: unknown;
  /** Opaque suggestion handle — unsupported by the provider contract. */
  magicKey?: string;
}

/** One row of a {@link LocatorCompat.addressesToLocations} batch. */
export interface LocatorBatchAddressCompat extends LocatorAddressInputCompat {
  OBJECTID?: number;
  objectId?: number;
}

/** Parameters for {@link LocatorCompat.addressesToLocations}. */
export interface AddressesToLocationsParamsCompat {
  addresses?: readonly LocatorBatchAddressCompat[];
  countryCode?: string;
  outFields?: readonly string[] | string;
  outSpatialReference?: LocatorSpatialReferenceLike | number;
  categories?: readonly string[] | string;
  searchExtent?: unknown;
}

/** Parameters for {@link LocatorCompat.locationToAddress}. */
export interface LocationToAddressParamsCompat {
  location?: unknown;
  outSpatialReference?: LocatorSpatialReferenceLike | number;
  outFields?: readonly string[] | string;
  /** ArcGIS rooftop/street-side selector — unsupported by the provider contract. */
  locationType?: string;
  /** ArcGIS search radius in meters — unsupported by the provider contract. */
  locationSearchRadius?: number;
}

/** Parameters for {@link LocatorCompat.suggestLocations}. */
export interface SuggestLocationsParamsCompat {
  text?: string;
  countryCode?: string;
  maxSuggestions?: number;
  categories?: readonly string[] | string;
  location?: unknown;
  searchExtent?: unknown;
}

export interface LocatorCompatOptions {
  /**
   * Original ArcGIS GeocodeServer URL. Retained for diagnostics only — it is
   * never fetched. Geocoding always runs through {@link provider}.
   */
  url?: string;
  /** Geocoding provider every operation is executed against. */
  provider?: GeocodingProvider;
  /** Accepted for ArcGIS constructor parity; diagnostics only (never sent). */
  apiKey?: string;
  /** Accepted for ArcGIS constructor parity; diagnostics only (never sent). */
  requestOptions?: Record<string, unknown>;
  /** Capability policy for provider capability misses; defaults to `"strict"`. */
  capabilityPolicy?: CapabilityPolicy;
  eventBus?: CompatEventBus;
  /** Default `maxLocations` when a call does not specify one. */
  maxLocations?: number;
  /**
   * Half-width, in degrees, of the square extent derived around a candidate
   * point when the provider surfaces no `Xmin`/`Ymin`/`Xmax`/`Ymax` attributes.
   * Defaults to `0.01` (roughly a 2 km box at the equator).
   */
  extentPaddingDegrees?: number;
}

export type LocatorLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface LocatorHandleCompat {
  remove(): void;
}

/** Options for {@link LocatorCompat.toSearchSource} / {@link LocatorSearchSourceCompat}. */
export interface LocatorSearchSourceCompatOptions {
  /** Pre-configured locator. When omitted, one is built from `url` / `provider`. */
  locator?: LocatorCompat;
  /** Geocoding provider, when constructing the locator inline. */
  provider?: GeocodingProvider;
  /** ArcGIS `LocatorSearchSource.url`; retained for diagnostics only. */
  url?: string;
  capabilityPolicy?: CapabilityPolicy;
  name?: string;
  placeholder?: string;
  maxResults?: number;
  maxSuggestions?: number;
  countryCode?: string;
  outFields?: readonly string[] | string;
}

const DEFAULT_MAX_LOCATIONS = 6;
const DEFAULT_SEARCH_SOURCE_MAX_RESULTS = 6;
const DEFAULT_SEARCH_SOURCE_MAX_SUGGESTIONS = 6;
const DEFAULT_EXTENT_PADDING_DEGREES = 0.01;
const WGS84_WKID = 4326;
const WEB_MERCATOR_WKIDS: ReadonlySet<number> = new Set([3857, 102100, 102113, 900913]);
const WEB_MERCATOR_HALF_CIRCUMFERENCE = 20037508.342789244;

/**
 * Drop-in replacement for ArcGIS `esri/tasks/Locator` /
 * `@arcgis/core/rest/locator`, executed against a caller-configured
 * {@link GeocodingProvider}.
 *
 * @example
 * ```ts
 * import { LocatorCompat } from "@honua/sdk-js/esri-compat";
 * import { photonGeocodingProvider } from "@honua/sdk-js/geocoding";
 *
 * const locator = new LocatorCompat({
 *   provider: photonGeocodingProvider({ baseUrl: "https://photon.example.org" }),
 * });
 * const candidates = await locator.addressToLocations({
 *   address: { SingleLine: "1 Honolulu Pl, HI" },
 *   maxLocations: 5,
 * });
 * ```
 */
export class LocatorCompat {
  public readonly url: string | undefined;
  /**
   * Geocoding provider every operation runs against. Mutable so a migrated app
   * can attach one after construction (`locator.provider = photonGeocodingProvider(...)`),
   * which is the single assisted step the codemod cannot perform for you.
   */
  public provider: GeocodingProvider | undefined;
  public readonly apiKey: string | undefined;
  public readonly requestOptions: Readonly<Record<string, unknown>> | undefined;
  public readonly capabilityPolicy: CapabilityPolicy;
  public readonly eventBus: CompatEventBus;
  public readonly maxLocations: number;
  public readonly extentPaddingDegrees: number;
  public loaded: boolean;
  public loadStatus: LocatorLoadStatusCompat;

  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;

  public constructor(options: LocatorCompatOptions | string = {}) {
    const resolved: LocatorCompatOptions = typeof options === "string" ? { url: options } : options;
    this.url = resolved.url;
    this.provider = resolved.provider;
    this.apiKey = resolved.apiKey;
    this.requestOptions = resolved.requestOptions ? { ...resolved.requestOptions } : undefined;
    this.capabilityPolicy = resolved.capabilityPolicy ?? "strict";
    this.eventBus = resolved.eventBus ?? new CompatEventBus();
    this.maxLocations = normalizeLimit(resolved.maxLocations, DEFAULT_MAX_LOCATIONS);
    this.extentPaddingDegrees =
      typeof resolved.extentPaddingDegrees === "number" &&
      Number.isFinite(resolved.extentPaddingDegrees) &&
      resolved.extentPaddingDegrees > 0
        ? resolved.extentPaddingDegrees
        : DEFAULT_EXTENT_PADDING_DEGREES;
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.watchListeners = new Map();
  }

  /** `true` when the configured provider declares the `suggest` capability. */
  public get supportsSuggest(): boolean {
    return this.provider !== undefined && supportsGeocodingCapability(this.provider, "suggest");
  }

  public async load(): Promise<LocatorCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("locator.loading", { url: this.url }, this);
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("locator.loaded", { url: this.url, provider: this.provider?.id }, this);
    return this;
  }

  public async when(callback?: (locator: LocatorCompat) => void): Promise<LocatorCompat> {
    const locator = await this.load();
    if (callback) {
      callback(locator);
    }
    return locator;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): LocatorHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);

    return {
      remove: () => {
        listeners?.delete(listener);
      },
    };
  }

  /** Forward-geocode a single address into ArcGIS-shaped candidates. */
  public async addressToLocations(
    params: AddressToLocationsParamsCompat = {},
  ): Promise<LocatorAddressCandidateCompat[]> {
    const provider = this.requireProvider("addressToLocations");
    this.rejectUnsupportedParams(provider, params, ["categories", "location", "searchExtent"]);
    if (typeof params.magicKey === "string" && params.magicKey !== "") {
      this.rejectUnsupportedCapability(provider, "addressToLocations.magicKey");
    }

    const query = readSingleLineAddress(params.address);
    const wkid = resolveOutWkid(params.outSpatialReference, provider);
    const limit = normalizeLimit(params.maxLocations, this.maxLocations);
    this.eventBus.emit("locator.address-to-locations-started", { address: query, maxLocations: limit }, this);

    if (query === "") {
      this.eventBus.emit("locator.address-to-locations-completed", { address: query, candidateCount: 0 }, this);
      return [];
    }

    try {
      if (!assertGeocodingCapability(provider, "geocode", this.capabilityPolicy)) {
        this.eventBus.emit("locator.address-to-locations-completed", { address: query, candidateCount: 0 }, this);
        return [];
      }
      const matches = await provider.geocode(query, { limit, countryCodes: params.countryCode });
      const candidates = matches
        .slice(0, limit)
        .map((match) => this.toCandidate(match, wkid, params.outFields, provider));
      this.eventBus.emit(
        "locator.address-to-locations-completed",
        { address: query, candidateCount: candidates.length },
        this,
      );
      return candidates;
    } catch (error) {
      this.eventBus.emit("locator.address-to-locations-error", { address: query, error }, this);
      throw error;
    }
  }

  /**
   * Client-side batch geocode. ArcGIS `addressesToLocations` posts one batch to
   * a locator; the provider contract has no batch endpoint, so each address is
   * geocoded individually and the best candidate is returned with `ResultID`
   * carried through from `OBJECTID`.
   */
  public async addressesToLocations(
    params: AddressesToLocationsParamsCompat = {},
  ): Promise<LocatorAddressCandidateCompat[]> {
    const provider = this.requireProvider("addressesToLocations");
    this.rejectUnsupportedParams(provider, params, ["categories", "searchExtent"]);

    const addresses = params.addresses ?? [];
    this.eventBus.emit("locator.addresses-to-locations-started", { addressCount: addresses.length }, this);

    try {
      const resolved = await Promise.all(
        addresses.map(async (address, index) => {
          const candidates = await this.addressToLocations({
            address,
            countryCode: params.countryCode,
            outFields: params.outFields,
            outSpatialReference: params.outSpatialReference,
            maxLocations: 1,
          });
          const best = candidates[0];
          if (!best) {
            return undefined;
          }
          const resultId = readObjectId(address) ?? index + 1;
          const withResultId: LocatorAddressCandidateCompat = {
            ...best,
            attributes: { ...best.attributes, ResultID: String(resultId) },
          };
          return withResultId;
        }),
      );
      const candidates = resolved.filter((candidate): candidate is LocatorAddressCandidateCompat => Boolean(candidate));
      this.eventBus.emit(
        "locator.addresses-to-locations-completed",
        { addressCount: addresses.length, candidateCount: candidates.length },
        this,
      );
      return candidates;
    } catch (error) {
      this.eventBus.emit("locator.addresses-to-locations-error", { addressCount: addresses.length, error }, this);
      throw error;
    }
  }

  /**
   * Reverse-geocode a point. Mirrors ArcGIS by rejecting when the provider
   * finds no address rather than resolving to `null`.
   */
  public async locationToAddress(params: LocationToAddressParamsCompat = {}): Promise<LocatorAddressCandidateCompat> {
    const provider = this.requireProvider("locationToAddress");
    this.rejectUnsupportedParams(provider, params, ["locationType", "locationSearchRadius"]);

    const point = readLngLat(params.location);
    if (!point) {
      throw new Error("LocatorCompat.locationToAddress requires a location with numeric x/y or longitude/latitude.");
    }
    const wkid = resolveOutWkid(params.outSpatialReference, provider);
    const [longitude, latitude] = point;
    this.eventBus.emit("locator.location-to-address-started", { longitude, latitude }, this);

    try {
      if (!assertGeocodingCapability(provider, "reverse", this.capabilityPolicy)) {
        throw new Error(
          `LocatorCompat.locationToAddress: provider "${provider.id}" does not support reverse geocoding.`,
        );
      }
      const match = await provider.reverse(latitude, longitude);
      if (!match) {
        throw new Error(`No address found for location ${longitude}, ${latitude}.`);
      }
      const candidate = this.toCandidate(toGeocodeMatch(match), wkid, params.outFields, provider);
      this.eventBus.emit("locator.location-to-address-completed", { address: candidate.address }, this);
      return candidate;
    } catch (error) {
      this.eventBus.emit("locator.location-to-address-error", { longitude, latitude, error }, this);
      throw error;
    }
  }

  /**
   * Typeahead suggestions. Providers without the `suggest` capability throw
   * `HonuaCapabilityNotSupportedError` under `"strict"` and resolve to `[]`
   * under `"degraded"` — the miss is never faked with a forward geocode.
   */
  public async suggestLocations(params: SuggestLocationsParamsCompat = {}): Promise<LocatorSuggestionCompat[]> {
    const provider = this.requireProvider("suggestLocations");
    this.rejectUnsupportedParams(provider, params, ["categories", "location", "searchExtent"]);

    const text = typeof params.text === "string" ? params.text.trim() : "";
    const limit = normalizeLimit(params.maxSuggestions, this.maxLocations);
    this.eventBus.emit("locator.suggest-locations-started", { text, maxSuggestions: limit }, this);

    try {
      if (!assertGeocodingCapability(provider, "suggest", this.capabilityPolicy)) {
        this.eventBus.emit("locator.suggest-locations-completed", { text, suggestionCount: 0 }, this);
        return [];
      }
      if (text === "") {
        this.eventBus.emit("locator.suggest-locations-completed", { text, suggestionCount: 0 }, this);
        return [];
      }
      const suggestions = await provider.suggest(text, { limit, countryCodes: params.countryCode });
      const projected = suggestions.slice(0, limit).map((suggestion) => ({
        text: suggestion.text,
        magicKey: "",
        isCollection: false,
        provenance: suggestion.provenance,
      }));
      this.eventBus.emit("locator.suggest-locations-completed", { text, suggestionCount: projected.length }, this);
      return projected;
    } catch (error) {
      this.eventBus.emit("locator.suggest-locations-error", { text, error }, this);
      throw error;
    }
  }

  /**
   * Project this locator as a `SearchCompat` source — the honua-maplibre
   * replacement for the ArcGIS `LocatorSearchSource` Search backend.
   */
  public toSearchSource(options: Omit<LocatorSearchSourceCompatOptions, "locator"> = {}): LocatorSearchSourceCompat {
    return new LocatorSearchSourceCompat({ ...options, locator: this });
  }

  public destroy(): void {
    this.watchListeners.clear();
  }

  private requireProvider(operation: string): GeocodingProvider {
    if (!this.provider) {
      const migratedUrl = this.url ? `; the migrated ArcGIS locator URL was ${this.url}` : "";
      throw new Error(
        [
          `LocatorCompat.${operation} requires a geocoding provider.`,
          'Set `locator.provider` or construct it with `new LocatorCompat({ provider })` using a provider from "@honua/sdk-js/geocoding"',
          `(nominatimGeocodingProvider, photonGeocodingProvider, peliasGeocodingProvider, honuaGeocodingProvider)${migratedUrl}.`,
        ].join(" "),
      );
    }
    return this.provider;
  }

  private rejectUnsupportedParams(provider: GeocodingProvider, params: object, keys: readonly string[]): void {
    const record = params as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value) && value.length === 0) {
        continue;
      }
      this.rejectUnsupportedCapability(provider, `locator.${key}`);
    }
  }

  private rejectUnsupportedCapability(provider: GeocodingProvider, capability: string): void {
    if (this.capabilityPolicy === "strict") {
      throw new HonuaCapabilityNotSupportedError(capability, provider.id, this.url);
    }
  }

  private toCandidate(
    match: ProviderGeocodeMatch,
    wkid: number,
    outFields: readonly string[] | string | undefined,
    provider: GeocodingProvider,
  ): LocatorAddressCandidateCompat {
    const [x, y] = projectLngLat(match.longitude, match.latitude, wkid, provider, this.url);
    return {
      address: match.address,
      attributes: selectOutFields(match.attributes, outFields),
      location: {
        x,
        y,
        longitude: match.longitude,
        latitude: match.latitude,
        spatialReference: { wkid },
      },
      extent: this.resolveExtent(match, wkid, provider),
      score: typeof match.score === "number" && Number.isFinite(match.score) ? match.score : 0,
      provenance: match.provenance,
    };
  }

  /**
   * Prefer the ArcGIS locator display extent when the provider surfaces
   * `Xmin`/`Ymin`/`Xmax`/`Ymax` attributes; otherwise derive a square box around
   * the candidate point so `view.goTo(candidate.extent)` still behaves.
   */
  private resolveExtent(match: ProviderGeocodeMatch, wkid: number, provider: GeocodingProvider): LocatorExtentCompat {
    const reported = readAttributeExtent(match.attributes);
    const [xmin, ymin, xmax, ymax] = reported ?? [
      match.longitude - this.extentPaddingDegrees,
      match.latitude - this.extentPaddingDegrees,
      match.longitude + this.extentPaddingDegrees,
      match.latitude + this.extentPaddingDegrees,
    ];
    const [projectedMinX, projectedMinY] = projectLngLat(xmin, ymin, wkid, provider, this.url);
    const [projectedMaxX, projectedMaxY] = projectLngLat(xmax, ymax, wkid, provider, this.url);
    return {
      xmin: projectedMinX,
      ymin: projectedMinY,
      xmax: projectedMaxX,
      ymax: projectedMaxY,
      spatialReference: { wkid },
    };
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}

/**
 * Drop-in replacement for the ArcGIS `LocatorSearchSource` Search-widget
 * backend. `suggest` is only defined when the underlying provider declares the
 * `suggest` capability, so `SearchCompat` skips typeahead for providers that
 * do not have it rather than throwing on every keystroke.
 */
export class LocatorSearchSourceCompat implements SearchSourceCompat {
  public readonly locator: LocatorCompat;
  public readonly name: string;
  public readonly placeholder: string;
  public readonly maxResults: number;
  public readonly maxSuggestions: number;
  public readonly countryCode: string | undefined;
  public readonly outFields: readonly string[] | string | undefined;

  /**
   * Present only while the configured provider declares the `suggest`
   * capability. `SearchCompat` gates typeahead on `typeof source.suggest ===
   * "function"`, so a provider without it (Nominatim) simply contributes no
   * suggestions instead of throwing on every keystroke. Evaluated per access so
   * a late-attached `locator.provider` is honored.
   */
  public get suggest(): ((request: SearchRequestCompat) => Promise<SearchSuggestionCompat[]>) | undefined {
    return this.locator.supportsSuggest ? this.suggestFromLocator : undefined;
  }

  private readonly suggestFromLocator: (request: SearchRequestCompat) => Promise<SearchSuggestionCompat[]>;

  public constructor(options: LocatorSearchSourceCompatOptions = {}) {
    this.locator =
      options.locator ??
      new LocatorCompat({
        url: options.url,
        provider: options.provider,
        capabilityPolicy: options.capabilityPolicy,
      });
    this.name = options.name ?? this.locator.provider?.id ?? "Locator";
    this.placeholder = options.placeholder ?? "Find address or place";
    this.maxResults = normalizeLimit(options.maxResults, DEFAULT_SEARCH_SOURCE_MAX_RESULTS);
    this.maxSuggestions = normalizeLimit(options.maxSuggestions, DEFAULT_SEARCH_SOURCE_MAX_SUGGESTIONS);
    this.countryCode = options.countryCode;
    this.outFields = options.outFields;

    this.suggestFromLocator = async ({ searchTerm }: SearchRequestCompat): Promise<SearchSuggestionCompat[]> => {
      const suggestions = await this.locator.suggestLocations({
        text: searchTerm,
        countryCode: this.countryCode,
        maxSuggestions: this.maxSuggestions,
      });
      return suggestions.map((suggestion) => ({
        text: suggestion.text,
        key: suggestion.magicKey,
        source: this,
      }));
    };
  }

  public async search({ searchTerm }: SearchRequestCompat): Promise<SearchResultCompat[]> {
    const candidates = await this.locator.addressToLocations({
      address: { SingleLine: searchTerm },
      countryCode: this.countryCode,
      maxLocations: this.maxResults,
      outFields: this.outFields,
    });
    return candidates.map((candidate) => ({
      name: candidate.address,
      feature: {
        attributes: candidate.attributes,
        geometry: candidate.location,
      },
      location: { x: candidate.location.x, y: candidate.location.y },
      extent: {
        xmin: candidate.extent.xmin,
        ymin: candidate.extent.ymin,
        xmax: candidate.extent.xmax,
        ymax: candidate.extent.ymax,
        spatialReference: { ...candidate.extent.spatialReference },
      },
      source: this,
    }));
  }
}

/**
 * `@arcgis/core/rest/locator` module form of
 * {@link LocatorCompat.addressToLocations}. The first argument is a configured
 * {@link LocatorCompat} (or its options) rather than an ArcGIS locator URL,
 * because the shim geocodes through a provider instead of a GeocodeServer.
 */
export function locatorAddressToLocations(
  locator: LocatorCompat | LocatorCompatOptions | string,
  params?: AddressToLocationsParamsCompat,
): Promise<LocatorAddressCandidateCompat[]> {
  return resolveLocator(locator).addressToLocations(params);
}

/** `@arcgis/core/rest/locator` module form of {@link LocatorCompat.addressesToLocations}. */
export function locatorAddressesToLocations(
  locator: LocatorCompat | LocatorCompatOptions | string,
  params?: AddressesToLocationsParamsCompat,
): Promise<LocatorAddressCandidateCompat[]> {
  return resolveLocator(locator).addressesToLocations(params);
}

/** `@arcgis/core/rest/locator` module form of {@link LocatorCompat.locationToAddress}. */
export function locatorLocationToAddress(
  locator: LocatorCompat | LocatorCompatOptions | string,
  params?: LocationToAddressParamsCompat,
): Promise<LocatorAddressCandidateCompat> {
  return resolveLocator(locator).locationToAddress(params);
}

/** `@arcgis/core/rest/locator` module form of {@link LocatorCompat.suggestLocations}. */
export function locatorSuggestLocations(
  locator: LocatorCompat | LocatorCompatOptions | string,
  params?: SuggestLocationsParamsCompat,
): Promise<LocatorSuggestionCompat[]> {
  return resolveLocator(locator).suggestLocations(params);
}

function resolveLocator(locator: LocatorCompat | LocatorCompatOptions | string): LocatorCompat {
  return locator instanceof LocatorCompat ? locator : new LocatorCompat(locator);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function readSingleLineAddress(address: LocatorAddressInputCompat | string | undefined): string {
  if (typeof address === "string") {
    return address.trim();
  }
  if (!address || typeof address !== "object") {
    return "";
  }

  const singleLine = address.SingleLine ?? address.singleLine;
  if (typeof singleLine === "string" && singleLine.trim() !== "") {
    return singleLine.trim();
  }

  // Multi-field input: join the ArcGIS field order into the single-line form
  // every provider accepts.
  const parts: string[] = [];
  for (const key of ["Address", "address", "City", "Region", "Postal", "CountryCode"] as const) {
    const value = address[key];
    if (typeof value === "string" && value.trim() !== "") {
      parts.push(value.trim());
    }
  }
  return parts.join(", ");
}

function readObjectId(address: LocatorBatchAddressCompat): number | undefined {
  const objectId = address.OBJECTID ?? address.objectId;
  return typeof objectId === "number" && Number.isFinite(objectId) ? objectId : undefined;
}

function readLngLat(location: unknown): [number, number] | undefined {
  if (Array.isArray(location) && location.length >= 2) {
    const [x, y] = location;
    return typeof x === "number" && typeof y === "number" ? [x, y] : undefined;
  }
  if (!location || typeof location !== "object") {
    return undefined;
  }
  const point = location as Record<string, unknown>;
  const longitude = typeof point.longitude === "number" ? point.longitude : point.x;
  const latitude = typeof point.latitude === "number" ? point.latitude : point.y;
  if (typeof longitude !== "number" || typeof latitude !== "number") {
    return undefined;
  }
  return [longitude, latitude];
}

function resolveOutWkid(
  outSpatialReference: LocatorSpatialReferenceLike | number | undefined,
  provider: GeocodingProvider,
): number {
  if (outSpatialReference === undefined || outSpatialReference === null) {
    return WGS84_WKID;
  }
  const wkid =
    typeof outSpatialReference === "number"
      ? outSpatialReference
      : (outSpatialReference.wkid ?? outSpatialReference.latestWkid);
  if (typeof wkid !== "number" || !Number.isFinite(wkid)) {
    return WGS84_WKID;
  }
  if (wkid === WGS84_WKID || WEB_MERCATOR_WKIDS.has(wkid)) {
    return wkid;
  }
  throw new HonuaCapabilityNotSupportedError(`locator.outSpatialReference:${wkid}`, provider.id);
}

function projectLngLat(
  longitude: number,
  latitude: number,
  wkid: number,
  provider: GeocodingProvider,
  sourceId: string | undefined,
): [number, number] {
  if (wkid === WGS84_WKID) {
    return [longitude, latitude];
  }
  if (!WEB_MERCATOR_WKIDS.has(wkid)) {
    throw new HonuaCapabilityNotSupportedError(`locator.outSpatialReference:${wkid}`, provider.id, sourceId);
  }
  const clampedLatitude = Math.max(Math.min(latitude, 89.99999), -89.99999);
  const x = (longitude * WEB_MERCATOR_HALF_CIRCUMFERENCE) / 180;
  const y =
    (Math.log(Math.tan(((90 + clampedLatitude) * Math.PI) / 360)) / (Math.PI / 180)) *
    (WEB_MERCATOR_HALF_CIRCUMFERENCE / 180);
  return [x, y];
}

function selectOutFields(
  attributes: Record<string, string | null>,
  outFields: readonly string[] | string | undefined,
): Record<string, string | null> {
  if (outFields === undefined) {
    return { ...attributes };
  }
  const requested = (typeof outFields === "string" ? outFields.split(",") : outFields)
    .map((field) => field.trim())
    .filter((field) => field !== "");
  if (requested.length === 0 || requested.includes("*")) {
    return { ...attributes };
  }

  const wanted = new Set(requested.map((field) => field.toLowerCase()));
  const selected: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (wanted.has(key.toLowerCase())) {
      selected[key] = value;
    }
  }
  return selected;
}

function readAttributeExtent(attributes: Record<string, string | null>): [number, number, number, number] | undefined {
  const lookup = new Map<string, string | null>();
  for (const [key, value] of Object.entries(attributes)) {
    lookup.set(key.toLowerCase(), value);
  }

  const xmin = readNumericAttribute(lookup, "xmin");
  const ymin = readNumericAttribute(lookup, "ymin");
  const xmax = readNumericAttribute(lookup, "xmax");
  const ymax = readNumericAttribute(lookup, "ymax");
  if (xmin === undefined || ymin === undefined || xmax === undefined || ymax === undefined) {
    return undefined;
  }
  return [Math.min(xmin, xmax), Math.min(ymin, ymax), Math.max(xmin, xmax), Math.max(ymin, ymax)];
}

function readNumericAttribute(lookup: Map<string, string | null>, key: string): number | undefined {
  const raw = lookup.get(key);
  if (raw === null || raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toGeocodeMatch(match: ProviderReverseMatch): ProviderGeocodeMatch {
  return {
    address: match.address,
    latitude: match.latitude,
    longitude: match.longitude,
    score: 100,
    attributes: match.attributes,
    provenance: match.provenance,
  };
}
