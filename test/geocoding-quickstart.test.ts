import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEOCODING_INITIAL_QUERY,
  DEFAULT_GEOCODING_LOCATOR_NAME,
  DEFAULT_GEOCODING_MAX_RESULTS,
  resolveGeocodingQuickstartConfig,
} from "../examples/geocoding-quickstart/src/config.js";
import {
  createGeocodingAuditRows,
  emptyGeocodingFeatureCollection,
  geocodeResultsToFeatures,
  geocodingClientOptionsFromConfig,
} from "../examples/geocoding-quickstart/src/model.js";

describe("Geocoding Quickstart sample", () => {
  it("resolves a bundle-relative fixture-only configuration without credentials", () => {
    const config = resolveGeocodingQuickstartConfig("./");
    const options = geocodingClientOptionsFromConfig(config);

    expect(config).toEqual({
      honuaBaseUrl: ".",
      locatorName: DEFAULT_GEOCODING_LOCATOR_NAME,
      initialQuery: DEFAULT_GEOCODING_INITIAL_QUERY,
      maxResults: DEFAULT_GEOCODING_MAX_RESULTS,
      mode: "fixture-only",
    });
    expect(options).toMatchObject({ baseUrl: ".", locatorName: "World" });
    expect(options.apiKey).toBeUndefined();
    expect(options.bearerToken).toBeUndefined();
    expect(options.fetchFn).toBeTypeOf("function");
  });

  it("documents the single SDK surface and its exact bundled route", () => {
    expect(createGeocodingAuditRows("World")).toEqual([
      expect.objectContaining({
        capability: "Forward geocoding",
        interaction: "Address selection",
        sdkSurface: "HonuaGeocodingClient.forwardGeocode",
        endpoint: "/rest/services/World/GeocodeServer/findAddressCandidates",
      }),
    ]);
  });

  it("projects standardized SDK candidates into indexed MapLibre point features", () => {
    const forward = geocodeResultsToFeatures([
      {
        address: "530 S King St, Honolulu, HI 96813, USA",
        latitude: 21.30455,
        longitude: -157.85833,
        score: 100,
        attributes: { Addr_type: "PointAddress", PlaceName: "Honolulu Hale" },
      },
    ]);

    expect(emptyGeocodingFeatureCollection()).toEqual({ type: "FeatureCollection", features: [] });
    expect(forward.features[0]).toMatchObject({
      geometry: { type: "Point", coordinates: [-157.85833, 21.30455] },
      properties: {
        kind: "forward",
        index: 0,
        address: "530 S King St, Honolulu, HI 96813, USA",
        subtitle: "Honolulu Hale",
        score: 100,
      },
    });
  });
});
