import { describe, expect, it } from "vitest";

import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import {
  CompatEventBus,
  LocatorCompat,
  LocatorSearchSourceCompat,
  SearchCompat,
  locatorAddressToLocations,
  locatorLocationToAddress,
  locatorSuggestLocations,
} from "../src/esri-compat-entry.js";
import type {
  GeocodingCapability,
  GeocodingProvider,
  ProviderGeocodeMatch,
  ProviderGeocodeOptions,
  ProviderReverseMatch,
  ProviderSuggestOptions,
  ProviderSuggestion,
} from "../src/geocoding/provider.js";

const PROVENANCE = {
  provider: "stub",
  attribution: "Stub data",
  usagePolicyUrl: "https://example.test/policy",
} as const;

interface StubProviderCalls {
  geocode: Array<{ query: string; options?: ProviderGeocodeOptions }>;
  reverse: Array<{ latitude: number; longitude: number }>;
  suggest: Array<{ text: string; options?: ProviderSuggestOptions }>;
}

function stubProvider(
  options: {
    capabilities?: readonly GeocodingCapability[];
    matches?: readonly ProviderGeocodeMatch[];
    reverseMatch?: ProviderReverseMatch | null;
    suggestions?: readonly ProviderSuggestion[];
  } = {},
): { provider: GeocodingProvider; calls: StubProviderCalls } {
  const calls: StubProviderCalls = { geocode: [], reverse: [], suggest: [] };
  const capabilities = options.capabilities ?? (["geocode", "reverse", "suggest"] as const);
  const provider: GeocodingProvider = {
    id: "stub",
    capabilities: [...capabilities],
    attribution: PROVENANCE.attribution,
    usagePolicyUrl: PROVENANCE.usagePolicyUrl,
    async geocode(query, geocodeOptions) {
      calls.geocode.push({ query, options: geocodeOptions });
      return [...(options.matches ?? [])];
    },
    async reverse(latitude, longitude) {
      calls.reverse.push({ latitude, longitude });
      return options.reverseMatch === undefined ? null : options.reverseMatch;
    },
    async suggest(text, suggestOptions) {
      calls.suggest.push({ text, options: suggestOptions });
      return [...(options.suggestions ?? [])];
    },
  };
  return { provider, calls };
}

function match(overrides: Partial<ProviderGeocodeMatch> = {}): ProviderGeocodeMatch {
  return {
    address: "1 Honolulu Pl, HI",
    latitude: 21.3069,
    longitude: -157.8583,
    score: 0.82,
    attributes: { City: "Honolulu", Region: "HI" },
    provenance: PROVENANCE,
    ...overrides,
  };
}

describe("LocatorCompat", () => {
  it("projects provider matches into ArcGIS-shaped candidates with score, extent, and attributes", async () => {
    const { provider, calls } = stubProvider({ matches: [match()] });
    const locator = new LocatorCompat({ provider, url: "https://geocode.example.test/GeocodeServer" });

    const candidates = await locator.addressToLocations({
      address: { SingleLine: "1 Honolulu Pl, HI" },
      maxLocations: 3,
      countryCode: "us",
    });

    expect(calls.geocode).toEqual([{ query: "1 Honolulu Pl, HI", options: { limit: 3, countryCodes: "us" } }]);
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate.address).toBe("1 Honolulu Pl, HI");
    expect(candidate.score).toBe(0.82);
    expect(candidate.attributes).toEqual({ City: "Honolulu", Region: "HI" });
    expect(candidate.location).toEqual({
      x: -157.8583,
      y: 21.3069,
      longitude: -157.8583,
      latitude: 21.3069,
      spatialReference: { wkid: 4326 },
    });
    // No provider-reported display extent: a square box is derived around the point.
    expect(candidate.extent.xmin).toBeCloseTo(-157.8683, 6);
    expect(candidate.extent.xmax).toBeCloseTo(-157.8483, 6);
    expect(candidate.extent.ymin).toBeCloseTo(21.2969, 6);
    expect(candidate.extent.ymax).toBeCloseTo(21.3169, 6);
    expect(candidate.provenance).toEqual(PROVENANCE);
  });

  it("prefers the ArcGIS Xmin/Ymin/Xmax/Ymax display extent when the provider reports one", async () => {
    const { provider } = stubProvider({
      matches: [
        match({
          attributes: { Xmin: "-158", Ymin: "21", Xmax: "-157.5", Ymax: "21.5" },
        }),
      ],
    });
    const locator = new LocatorCompat({ provider });

    const [candidate] = await locator.addressToLocations({ address: "anything" });

    expect(candidate.extent).toEqual({
      xmin: -158,
      ymin: 21,
      xmax: -157.5,
      ymax: 21.5,
      spatialReference: { wkid: 4326 },
    });
  });

  it("projects to Web Mercator on request and rejects spatial references it cannot honor", async () => {
    const { provider } = stubProvider({ matches: [match({ latitude: 0, longitude: 90 })] });
    const locator = new LocatorCompat({ provider });

    const [candidate] = await locator.addressToLocations({
      address: "anything",
      outSpatialReference: { wkid: 102100 },
    });
    expect(candidate.location.x).toBeCloseTo(10018754.171, 3);
    expect(candidate.location.y).toBeCloseTo(0, 6);
    expect(candidate.location.longitude).toBe(90);
    expect(candidate.location.spatialReference).toEqual({ wkid: 102100 });

    await expect(
      locator.addressToLocations({ address: "anything", outSpatialReference: { wkid: 27700 } }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("filters candidate attributes down to outFields", async () => {
    const { provider } = stubProvider({ matches: [match()] });
    const locator = new LocatorCompat({ provider });

    const [selected] = await locator.addressToLocations({ address: "anything", outFields: ["city"] });
    expect(selected.attributes).toEqual({ City: "Honolulu" });

    const [all] = await locator.addressToLocations({ address: "anything", outFields: ["*"] });
    expect(all.attributes).toEqual({ City: "Honolulu", Region: "HI" });
  });

  it("joins multi-field ArcGIS address input into the single-line form providers accept", async () => {
    const { provider, calls } = stubProvider({ matches: [] });
    const locator = new LocatorCompat({ provider });

    await locator.addressToLocations({
      address: { Address: "1 Honolulu Pl", City: "Honolulu", Region: "HI", Postal: "96813" },
    });

    expect(calls.geocode[0].query).toBe("1 Honolulu Pl, Honolulu, HI, 96813");
  });

  it("batch geocodes client-side and carries OBJECTID through as ResultID", async () => {
    const { provider, calls } = stubProvider({ matches: [match()] });
    const locator = new LocatorCompat({ provider });

    const candidates = await locator.addressesToLocations({
      addresses: [{ OBJECTID: 7, SingleLine: "first" }, { SingleLine: "second" }],
    });

    expect(calls.geocode.map((call) => call.query)).toEqual(["first", "second"]);
    expect(calls.geocode.every((call) => call.options?.limit === 1)).toBe(true);
    expect(candidates.map((candidate) => candidate.attributes.ResultID)).toEqual(["7", "2"]);
  });

  it("reverse-geocodes and rejects when the provider finds no address (ArcGIS semantics)", async () => {
    const { provider: found, calls } = stubProvider({
      reverseMatch: {
        address: "Ala Moana Blvd",
        latitude: 21.29,
        longitude: -157.85,
        attributes: { City: "Honolulu" },
        provenance: PROVENANCE,
      },
    });
    const locator = new LocatorCompat({ provider: found });

    const candidate = await locator.locationToAddress({ location: { x: -157.85, y: 21.29 } });
    expect(calls.reverse).toEqual([{ latitude: 21.29, longitude: -157.85 }]);
    expect(candidate.address).toBe("Ala Moana Blvd");
    expect(candidate.location.longitude).toBe(-157.85);

    const { provider: empty } = stubProvider({ reverseMatch: null });
    await expect(
      new LocatorCompat({ provider: empty }).locationToAddress({ location: { longitude: 0, latitude: 0 } }),
    ).rejects.toThrow(/No address found/);
  });

  it("surfaces a provider suggest capability miss through the capability policy rather than faking it", async () => {
    const { provider, calls } = stubProvider({ capabilities: ["geocode", "reverse"] });

    const strict = new LocatorCompat({ provider });
    expect(strict.supportsSuggest).toBe(false);
    await expect(strict.suggestLocations({ text: "hono" })).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);

    const degraded = new LocatorCompat({ provider, capabilityPolicy: "degraded" });
    await expect(degraded.suggestLocations({ text: "hono" })).resolves.toEqual([]);

    // The miss is never papered over with a forward geocode.
    expect(calls.geocode).toEqual([]);
    expect(calls.suggest).toEqual([]);
  });

  it("returns ArcGIS-shaped suggestions when the provider declares the capability", async () => {
    const { provider, calls } = stubProvider({
      suggestions: [
        { text: "Honolulu, HI", provenance: PROVENANCE },
        { text: "Honokaa, HI", provenance: PROVENANCE },
      ],
    });
    const locator = new LocatorCompat({ provider });

    const suggestions = await locator.suggestLocations({ text: " hono ", maxSuggestions: 5 });

    expect(calls.suggest).toEqual([{ text: "hono", options: { limit: 5, countryCodes: undefined } }]);
    expect(suggestions).toEqual([
      { text: "Honolulu, HI", magicKey: "", isCollection: false, provenance: PROVENANCE },
      { text: "Honokaa, HI", magicKey: "", isCollection: false, provenance: PROVENANCE },
    ]);
  });

  it("rejects ArcGIS locator parameters the provider contract cannot express", async () => {
    const { provider } = stubProvider({ matches: [match()] });
    const strict = new LocatorCompat({ provider });

    await expect(strict.addressToLocations({ address: "a", categories: ["POI"] })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    await expect(
      strict.addressToLocations({ address: "a", searchExtent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(strict.addressToLocations({ address: "a", magicKey: "abc" })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    await expect(
      strict.locationToAddress({ location: { x: 0, y: 0 }, locationType: "rooftop" }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);

    // An empty magicKey (what our own suggestions carry) is not a capability miss.
    await expect(strict.addressToLocations({ address: "a", magicKey: "" })).resolves.toHaveLength(1);

    const degraded = new LocatorCompat({ provider, capabilityPolicy: "degraded" });
    await expect(degraded.addressToLocations({ address: "a", categories: ["POI"] })).resolves.toHaveLength(1);
  });

  it("fails with an actionable error when no geocoding provider is configured", async () => {
    const locator = new LocatorCompat({ url: "https://geocode.example.test/GeocodeServer" });

    await expect(locator.addressToLocations({ address: "a" })).rejects.toThrow(
      /requires a geocoding provider.*https:\/\/geocode\.example\.test\/GeocodeServer/s,
    );
  });

  it("supports the ArcGIS load()/when()/watch() lifecycle and emits compat events", async () => {
    const eventBus = new CompatEventBus();
    const seen: string[] = [];
    eventBus.onAny((event) => {
      seen.push(event.type);
    });
    const { provider } = stubProvider({ matches: [match()] });
    const locator = new LocatorCompat({ provider, eventBus });

    const loadStatuses: unknown[] = [];
    const handle = locator.watch("loadStatus", (value) => {
      loadStatuses.push(value);
    });

    let callbackTarget: LocatorCompat | undefined;
    const loaded = await locator.when((resolved) => {
      callbackTarget = resolved;
    });
    await locator.addressToLocations({ address: "a" });
    handle.remove();
    await locator.load();

    expect(callbackTarget).toBe(locator);
    expect(loaded.loaded).toBe(true);
    expect(loaded.loadStatus).toBe("loaded");
    expect(loadStatuses).toEqual(["loading", "loaded"]);
    expect(seen).toEqual([
      "locator.loading",
      "locator.loaded",
      "locator.address-to-locations-started",
      "locator.address-to-locations-completed",
    ]);

    locator.destroy();
  });

  it("emits an error event and rethrows when the provider fails", async () => {
    const failure = new Error("upstream down");
    const provider: GeocodingProvider = {
      id: "stub",
      capabilities: ["geocode"],
      attribution: "Stub",
      geocode: async () => {
        throw failure;
      },
      reverse: async () => null,
      suggest: async () => [],
    };
    const eventBus = new CompatEventBus();
    const errors: unknown[] = [];
    eventBus.on("locator.address-to-locations-error", (event) => {
      errors.push((event.payload as { error: unknown }).error);
    });

    await expect(new LocatorCompat({ provider, eventBus }).addressToLocations({ address: "a" })).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
  });
});

describe("LocatorSearchSourceCompat", () => {
  it("drives SearchCompat address search through the locator", async () => {
    const { provider } = stubProvider({ matches: [match()] });
    const locator = new LocatorCompat({ provider });
    const search = new SearchCompat({
      sources: [locator.toSearchSource({ name: "Addresses", placeholder: "Find a place" })],
      includeDefaultSources: false,
    });

    const [source] = search.sources as LocatorSearchSourceCompat[];
    expect(source.name).toBe("Addresses");
    expect(source.placeholder).toBe("Find a place");
    expect(source.locator).toBe(locator);

    const response = await search.search("1 Honolulu Pl");
    expect(response.results).toHaveLength(1);
    expect(response.results[0].name).toBe("1 Honolulu Pl, HI");
    expect(response.results[0].location).toEqual({ x: -157.8583, y: 21.3069 });
    expect(response.results[0].extent?.spatialReference).toEqual({ wkid: 4326 });

    const suggestResponse = await search.suggest("1 Hono");
    expect(suggestResponse.suggestions).toEqual([]);
  });

  it("omits the suggest hook entirely when the provider does not declare suggest", () => {
    const { provider: withSuggest } = stubProvider();
    const { provider: withoutSuggest } = stubProvider({ capabilities: ["geocode", "reverse"] });

    expect(
      typeof new LocatorSearchSourceCompat({ locator: new LocatorCompat({ provider: withSuggest }) }).suggest,
    ).toBe("function");
    expect(new LocatorSearchSourceCompat({ locator: new LocatorCompat({ provider: withoutSuggest }) }).suggest).toBe(
      undefined,
    );
  });

  it("forwards suggestions to SearchCompat when the provider supports them", async () => {
    const { provider } = stubProvider({
      suggestions: [{ text: "Honolulu, HI", provenance: PROVENANCE }],
    });
    const search = new SearchCompat({
      sources: [new LocatorSearchSourceCompat({ provider, maxSuggestions: 4 })],
      includeDefaultSources: false,
    });

    const response = await search.suggest("hono");
    expect(response.suggestions.map((suggestion) => suggestion.text)).toEqual(["Honolulu, HI"]);
  });

  it("builds its own locator from url/provider options (ArcGIS LocatorSearchSource shape)", () => {
    const { provider } = stubProvider();
    const source = new LocatorSearchSourceCompat({ url: "https://geocode.example.test/GeocodeServer", provider });

    expect(source.locator.url).toBe("https://geocode.example.test/GeocodeServer");
    expect(source.locator.provider).toBe(provider);
    expect(source.name).toBe("stub");
  });
});

describe("rest/locator module helpers", () => {
  it("accept a configured locator, its options, or a bare url", async () => {
    const { provider } = stubProvider({
      matches: [match()],
      reverseMatch: {
        address: "Ala Moana Blvd",
        latitude: 21.29,
        longitude: -157.85,
        attributes: {},
        provenance: PROVENANCE,
      },
      suggestions: [{ text: "Honolulu, HI", provenance: PROVENANCE }],
    });
    const locator = new LocatorCompat({ provider });

    await expect(locatorAddressToLocations(locator, { address: "a" })).resolves.toHaveLength(1);
    await expect(locatorSuggestLocations({ provider }, { text: "hono" })).resolves.toHaveLength(1);
    await expect(locatorLocationToAddress({ provider }, { location: [-157.85, 21.29] })).resolves.toMatchObject({
      address: "Ala Moana Blvd",
    });

    // The migrated call site keeps its GeocodeServer URL until a provider is
    // attached; the failure names the fix rather than silently returning [].
    await expect(
      locatorAddressToLocations("https://geocode.example.test/GeocodeServer", { address: "a" }),
    ).rejects.toThrow(/requires a geocoding provider/);
  });
});
