import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEOCODING_INITIAL_QUERY,
  DEFAULT_GEOCODING_LOCATOR_NAME,
  resolveGeocodingQuickstartConfig,
} from "../examples/geocoding-quickstart/src/config.js";
import {
  createGeocodingAuditRows,
  emptyGeocodingFeatureCollection,
  geocodeResultsToFeatures,
  geocodingClientOptionsFromConfig,
  reverseResultToFeature,
} from "../examples/geocoding-quickstart/src/model.js";

describe("Geocoding Quickstart sample", () => {
  it("resolves same-origin fixture defaults", () => {
    const config = resolveGeocodingQuickstartConfig({}, "http://127.0.0.1:4321/");

    expect(config.honuaBaseUrl).toBe("http://127.0.0.1:4321");
    expect(config.mode).toBe("fixture-safe");
    expect(config.locatorName).toBe(DEFAULT_GEOCODING_LOCATOR_NAME);
    expect(config.initialQuery).toBe(DEFAULT_GEOCODING_INITIAL_QUERY);
    expect(config.countryCodes).toBe("US");
    expect(config.maxResults).toBe(5);
    expect(config.maxSuggestions).toBe(5);
  });

  it("normalizes live overrides and forwards auth options into SDK client options", () => {
    const config = resolveGeocodingQuickstartConfig(
      {
        VITE_HONUA_GEOCODING_BASE_URL: "https://honua.example.test///",
        VITE_HONUA_GEOCODING_LOCATOR_NAME: "CampusLocator",
        VITE_HONUA_GEOCODING_INITIAL_QUERY: "Operations Center",
        VITE_HONUA_GEOCODING_COUNTRY_CODES: "US,CA",
        VITE_HONUA_GEOCODING_MAX_RESULTS: "7",
        VITE_HONUA_GEOCODING_MAX_SUGGESTIONS: "4",
        VITE_HONUA_GEOCODING_API_KEY: "demo-key",
        VITE_HONUA_GEOCODING_BEARER_TOKEN: "demo-token",
      },
      "http://127.0.0.1:4321",
    );
    const options = geocodingClientOptionsFromConfig(config);

    expect(config.mode).toBe("live");
    expect(config.honuaBaseUrl).toBe("https://honua.example.test");
    expect(config.locatorName).toBe("CampusLocator");
    expect(config.initialQuery).toBe("Operations Center");
    expect(config.countryCodes).toBe("US,CA");
    expect(config.maxResults).toBe(7);
    expect(config.maxSuggestions).toBe(4);
    expect(options).toMatchObject({
      baseUrl: "https://honua.example.test",
      locatorName: "CampusLocator",
      apiKey: "demo-key",
      bearerToken: "demo-token",
    });
    expect(options.fetchFn).toBeTypeOf("function");
  });

  it("documents SDK surface to GeocodeServer endpoint mappings", () => {
    const rows = createGeocodingAuditRows("World");

    expect(rows).toEqual([
      expect.objectContaining({
        capability: "Forward geocoding",
        sdkSurface: "HonuaGeocodingClient.forwardGeocode",
        endpoint: "/rest/services/World/GeocodeServer/findAddressCandidates",
      }),
      expect.objectContaining({
        capability: "Reverse geocoding",
        sdkSurface: "HonuaGeocodingClient.reverseGeocode",
        endpoint: "/rest/services/World/GeocodeServer/reverseGeocode",
      }),
      expect.objectContaining({
        capability: "Typeahead suggestions",
        sdkSurface: "HonuaGeocodingClient.suggest",
        endpoint: "/rest/services/World/GeocodeServer/suggest",
      }),
    ]);
  });

  it("projects forward and reverse SDK results into MapLibre point feature collections", () => {
    const forward = geocodeResultsToFeatures([
      {
        address: "Honolulu Hale, 530 S King St, Honolulu, HI 96813",
        latitude: 21.30455,
        longitude: -157.85833,
        score: 100,
        attributes: { Addr_type: "POI", City: "Honolulu" },
      },
    ]);
    const reverse = reverseResultToFeature({
      address: "Ala Moana Center, 1450 Ala Moana Blvd, Honolulu, HI 96814",
      latitude: 21.29118,
      longitude: -157.84365,
      attributes: { Addr_type: "POI", City: "Honolulu" },
    });

    expect(emptyGeocodingFeatureCollection()).toEqual({ type: "FeatureCollection", features: [] });
    expect(forward.features[0]).toMatchObject({
      geometry: { type: "Point", coordinates: [-157.85833, 21.30455] },
      properties: {
        kind: "forward",
        address: "Honolulu Hale, 530 S King St, Honolulu, HI 96813",
        subtitle: "POI",
        score: 100,
      },
    });
    expect(reverse.features[0]).toMatchObject({
      geometry: { type: "Point", coordinates: [-157.84365, 21.29118] },
      properties: {
        kind: "reverse",
        address: "Ala Moana Center, 1450 Ala Moana Blvd, Honolulu, HI 96814",
        subtitle: "POI",
      },
    });
  });
});
