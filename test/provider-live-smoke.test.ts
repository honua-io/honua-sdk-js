/**
 * Live provider smoke: hits PUBLIC third-party demo endpoints, so it is
 * strictly opt-in behind `HONUA_PROVIDER_LIVE_SMOKE=1` (scheduled lane), the
 * same env-gated pattern as the other live/integration suites. Skipped —
 * never failed — when the opt-in is absent.
 *
 * Respectful defaults per the endpoints' usage policies: exactly one request
 * per test, a real User-Agent for Nominatim, and no Pelias test unless a
 * private endpoint is supplied (there is no keyless public Pelias demo).
 *
 * Endpoint overrides:
 *   HONUA_LIVE_NOMINATIM_URL  (default https://nominatim.openstreetmap.org)
 *   HONUA_LIVE_PHOTON_URL     (default https://photon.komoot.io)
 *   HONUA_LIVE_OSRM_URL       (default https://router.project-osrm.org)
 *   HONUA_LIVE_VALHALLA_URL   (default https://valhalla1.openstreetmap.de)
 *   HONUA_LIVE_PELIAS_URL     (no default; test skipped when unset)
 */

import { describe, expect, it } from "vitest";

import {
  nominatimGeocodingProvider,
  peliasGeocodingProvider,
  photonGeocodingProvider,
} from "../src/geocoding/index.js";
import { osrmRoutingProvider, valhallaRoutingProvider } from "../src/routing/index.js";

const LIVE = process.env.HONUA_PROVIDER_LIVE_SMOKE === "1";
const USER_AGENT = "honua-sdk-js-live-smoke/0.1 (+https://github.com/honua-io/honua-sdk-js; mike@honua.io)";
const TIMEOUT_MS = 15_000;
const TEST_TIMEOUT = { timeout: 30_000 };

const WAYPOINTS = [
  { longitude: -157.858, latitude: 21.306 },
  { longitude: -157.802, latitude: 21.262 },
];

describe.skipIf(!LIVE)("live provider smoke (HONUA_PROVIDER_LIVE_SMOKE=1)", () => {
  it("nominatim geocodes Honolulu Hale (1 request)", TEST_TIMEOUT, async () => {
    const provider = nominatimGeocodingProvider({
      baseUrl: process.env.HONUA_LIVE_NOMINATIM_URL ?? "https://nominatim.openstreetmap.org",
      userAgent: USER_AGENT,
      timeoutMs: TIMEOUT_MS,
    });
    const results = await provider.geocode("Honolulu Hale, Honolulu", { limit: 1 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].latitude).toBeCloseTo(21.3, 0);
    expect(results[0].longitude).toBeCloseTo(-157.9, 0);
    expect(results[0].provenance.provider).toBe("nominatim");
    expect(results[0].provenance.attribution).toContain("OpenStreetMap");
  });

  it("photon suggests for a partial query (1 request)", TEST_TIMEOUT, async () => {
    const provider = photonGeocodingProvider({
      baseUrl: process.env.HONUA_LIVE_PHOTON_URL ?? "https://photon.komoot.io",
      timeoutMs: TIMEOUT_MS,
    });
    const suggestions = await provider.suggest("Honolul", { limit: 3 });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].text.length).toBeGreaterThan(0);
    expect(suggestions[0].provenance.provider).toBe("photon");
  });

  it.skipIf(!process.env.HONUA_LIVE_PELIAS_URL)(
    "pelias autocompletes when a private endpoint is configured (1 request)",
    TEST_TIMEOUT,
    async () => {
      const provider = peliasGeocodingProvider({
        baseUrl: process.env.HONUA_LIVE_PELIAS_URL as string,
        apiKey: process.env.HONUA_LIVE_PELIAS_API_KEY,
        timeoutMs: TIMEOUT_MS,
      });
      const suggestions = await provider.suggest("Honolul", { limit: 3 });
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].provenance.provider).toBe("pelias");
    },
  );

  it("osrm routes across Honolulu (1 request)", TEST_TIMEOUT, async () => {
    const provider = osrmRoutingProvider({
      baseUrl: process.env.HONUA_LIVE_OSRM_URL ?? "https://router.project-osrm.org",
      timeoutMs: TIMEOUT_MS,
    });
    const route = await provider.route(WAYPOINTS);
    expect(route.distanceMeters).toBeGreaterThan(1_000);
    expect(route.durationSeconds).toBeGreaterThan(0);
    expect(route.geometry.length).toBeGreaterThan(2);
    expect(route.provenance.provider).toBe("osrm");
  });

  it("valhalla routes across Honolulu (1 request)", TEST_TIMEOUT, async () => {
    const provider = valhallaRoutingProvider({
      baseUrl: process.env.HONUA_LIVE_VALHALLA_URL ?? "https://valhalla1.openstreetmap.de",
      timeoutMs: TIMEOUT_MS,
    });
    const route = await provider.route(WAYPOINTS);
    expect(route.distanceMeters).toBeGreaterThan(1_000);
    expect(route.geometry.length).toBeGreaterThan(2);
    expect(route.provenance.provider).toBe("valhalla");
  });
});
