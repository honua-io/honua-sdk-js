/**
 * GeocodeServer integration coverage. Exercises `HonuaGeocodingClient`
 * when the target seed advertises a locator service.
 *
 * @module
 */

import { HonuaGeocodingClient } from "@honua/sdk-js/geocoding";
import { expect, it } from "vitest";
import {
  integrationSuite,
  runWithDiagnostics,
  skippedIntegrationSuite,
  tryResolveIntegrationConfig,
} from "../harness.js";

const REASON = "HONUA_INTEGRATION_GEOCODING_LOCATOR unset; seeded GeocodeServer locator required";

const config = tryResolveIntegrationConfig();

if (config && !config.geocodingLocatorName) {
  skippedIntegrationSuite("Geocoding", "geocoding", REASON, () => {
    it.skip("forward geocodes against a seeded locator", () => {
      expect(true).toBe(true);
    });
  });
} else {
  integrationSuite("Geocoding", "geocoding", ({ context, config }) => {
    const geocoder = new HonuaGeocodingClient({
      baseUrl: config.baseUrl,
      locatorName: config.geocodingLocatorName,
      apiKey: config.apiKey,
      bearerToken: config.bearerToken,
      timeoutMs: config.timeoutMs,
    });

    it("forward geocodes a configured probe string", async () => {
      await runWithDiagnostics(context, "new HonuaGeocodingClient().forwardGeocode", async () => {
        const results = await geocoder.forwardGeocode(config.geocodingProbeText, { maxResults: 1 });
        expect(Array.isArray(results)).toBe(true);
      });
    });
  });
}
