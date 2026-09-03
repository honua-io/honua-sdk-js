import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { HonuaCapabilityNotSupportedError, HonuaHttpError } from "../src/core/errors.js";
import {
  HonuaGeocodingClient,
  honuaGeocodingProvider,
  nominatimGeocodingProvider,
  peliasGeocodingProvider,
  photonGeocodingProvider,
  supportsGeocodingCapability,
} from "../src/geocoding/index.js";

const FIXTURES = path.resolve(fileURLToPath(import.meta.url), "../fixtures/providers");

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

/** Mock fetch that records the requested URL/init and returns the fixture. */
function fixtureFetch(name: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(fixture(name)), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

// ---------------------------------------------------------------------------
// Nominatim
// ---------------------------------------------------------------------------

describe("nominatimGeocodingProvider", () => {
  it("declares geocode + reverse but not suggest", () => {
    const provider = nominatimGeocodingProvider({ baseUrl: "https://nominatim.example.test" });
    expect(provider.id).toBe("nominatim");
    expect(supportsGeocodingCapability(provider, "geocode")).toBe(true);
    expect(supportsGeocodingCapability(provider, "reverse")).toBe(true);
    expect(supportsGeocodingCapability(provider, "suggest")).toBe(false);
  });

  it("normalizes /search results with provenance and attribution", async () => {
    const { fetchFn, calls } = fixtureFetch("nominatim-search.json");
    const provider = nominatimGeocodingProvider({
      baseUrl: "https://nominatim.example.test/",
      userAgent: "honua-sdk-test/1.0 (test@example.test)",
      fetchFn,
    });

    const results = await provider.geocode("Honolulu", { limit: 2, countryCodes: "us" });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin).toBe("https://nominatim.example.test");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("Honolulu");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.get("countrycodes")).toBe("us");
    expect((calls[0].init?.headers as Record<string, string>)["User-Agent"]).toBe(
      "honua-sdk-test/1.0 (test@example.test)",
    );

    expect(results).toHaveLength(2);
    expect(results[0].address).toBe("Honolulu, Honolulu County, Hawaii, United States");
    expect(results[0].latitude).toBeCloseTo(21.3069444, 6);
    expect(results[0].longitude).toBeCloseTo(-157.8583333, 6);
    expect(results[0].score).toBeCloseTo(0.6763936522651236, 8);
    expect(results[0].attributes.osm_type).toBe("relation");
    expect(results[0].provenance.provider).toBe("nominatim");
    expect(results[0].provenance.attribution).toContain("OpenStreetMap contributors");
    expect(results[0].provenance.usagePolicyUrl).toBe("https://operations.osmfoundation.org/policies/nominatim/");
    expect(provider.attribution).toBe(results[0].provenance.attribution);
  });

  it("normalizes /reverse results and maps the no-result envelope to null", async () => {
    const hit = fixtureFetch("nominatim-reverse.json");
    const provider = nominatimGeocodingProvider({
      baseUrl: "https://nominatim.example.test",
      fetchFn: hit.fetchFn,
    });
    const match = await provider.reverse(21.3059281, -157.8580063);
    const url = new URL(hit.calls[0].url);
    expect(url.pathname).toBe("/reverse");
    expect(url.searchParams.get("lat")).toBe("21.3059281");
    expect(url.searchParams.get("lon")).toBe("-157.8580063");
    expect(match?.address).toContain("Honolulu Hale");
    expect(match?.provenance.provider).toBe("nominatim");

    const miss = fixtureFetch("nominatim-reverse-empty.json");
    const missProvider = nominatimGeocodingProvider({
      baseUrl: "https://nominatim.example.test",
      fetchFn: miss.fetchFn,
    });
    await expect(missProvider.reverse(0, 0)).resolves.toBeNull();
  });

  it("throws the typed capability error for suggest under strict policy", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const provider = nominatimGeocodingProvider({ baseUrl: "https://nominatim.example.test", fetchFn });

    const error = await provider.suggest("honol").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect((error as HonuaCapabilityNotSupportedError).capability).toBe("suggest");
    expect((error as HonuaCapabilityNotSupportedError).protocol).toBe("nominatim");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("degrades suggest to an empty result under the degraded policy", async () => {
    const provider = nominatimGeocodingProvider({
      baseUrl: "https://nominatim.example.test",
      capabilityPolicy: "degraded",
    });
    await expect(provider.suggest("honol")).resolves.toEqual([]);
  });

  it("maps non-2xx responses to HonuaHttpError", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify(fixture("nominatim-reverse-empty.json")), {
        status: 429,
        headers: { "Retry-After": "4", "X-Request-ID": "provider-429" },
      });
    const provider = nominatimGeocodingProvider({ baseUrl: "https://nominatim.example.test", fetchFn });
    const error = await provider.geocode("Honolulu").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HonuaHttpError);
    expect((error as HonuaHttpError).statusCode).toBe(429);
    expect((error as HonuaHttpError).receipt.retryAfterMs).toBe(4_000);
    expect((error as HonuaHttpError).receipt.correlationId).toBe("provider-429");
  });

  it("requires an explicit baseUrl (no default third-party endpoint)", () => {
    expect(() => nominatimGeocodingProvider({ baseUrl: "" })).toThrowError(/baseUrl/);
  });
});

// ---------------------------------------------------------------------------
// Photon
// ---------------------------------------------------------------------------

describe("photonGeocodingProvider", () => {
  it("declares all three capabilities", () => {
    const provider = photonGeocodingProvider({ baseUrl: "https://photon.example.test" });
    expect(provider.capabilities).toEqual(["geocode", "reverse", "suggest"]);
  });

  it("normalizes GeoJSON /api results with provenance", async () => {
    const { fetchFn, calls } = fixtureFetch("photon-search.json");
    const provider = photonGeocodingProvider({ baseUrl: "https://photon.example.test", fetchFn });

    const results = await provider.geocode("Honolulu", { limit: 2 });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api");
    expect(url.searchParams.get("q")).toBe("Honolulu");
    expect(url.searchParams.get("limit")).toBe("2");

    expect(results).toHaveLength(2);
    expect(results[0].address).toBe("Honolulu, Hawaii, United States");
    expect(results[0].longitude).toBeCloseTo(-157.8583333, 6);
    expect(results[0].latitude).toBeCloseTo(21.3069444, 6);
    expect(results[1].address).toBe("Honolulu Hale, South King Street 530, Honolulu, Hawaii, United States");
    expect(results[1].attributes.osm_key).toBe("building");
    expect(results[0].provenance.provider).toBe("photon");
    expect(results[0].provenance.attribution).toContain("OpenStreetMap contributors");
  });

  it("suggest reuses the typeahead search endpoint and stamps provenance", async () => {
    const { fetchFn, calls } = fixtureFetch("photon-search.json");
    const provider = photonGeocodingProvider({ baseUrl: "https://photon.example.test", fetchFn });

    const suggestions = await provider.suggest("honol", { limit: 5 });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(suggestions.map((s) => s.text)).toContain("Honolulu, Hawaii, United States");
    expect(suggestions[0].provenance.provider).toBe("photon");
  });

  it("reverse returns the nearest feature or null", async () => {
    const hit = fixtureFetch("photon-reverse.json");
    const provider = photonGeocodingProvider({ baseUrl: "https://photon.example.test", fetchFn: hit.fetchFn });
    const match = await provider.reverse(21.3059281, -157.8580063);
    const url = new URL(hit.calls[0].url);
    expect(url.pathname).toBe("/reverse");
    expect(url.searchParams.get("lat")).toBe("21.3059281");
    expect(url.searchParams.get("lon")).toBe("-157.8580063");
    expect(match?.address).toContain("Honolulu Hale");

    const emptyFetch = (async () =>
      new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { status: 200 })) as typeof fetch;
    const missProvider = photonGeocodingProvider({ baseUrl: "https://photon.example.test", fetchFn: emptyFetch });
    await expect(missProvider.reverse(0, 0)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pelias
// ---------------------------------------------------------------------------

describe("peliasGeocodingProvider", () => {
  it("normalizes /v1/search results with confidence as score", async () => {
    const { fetchFn, calls } = fixtureFetch("pelias-search.json");
    const provider = peliasGeocodingProvider({ baseUrl: "https://pelias.example.test", fetchFn, apiKey: "k123" });

    const results = await provider.geocode("530 South King Street Honolulu", { limit: 10, countryCodes: "US" });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/search");
    expect(url.searchParams.get("text")).toBe("530 South King Street Honolulu");
    expect(url.searchParams.get("size")).toBe("10");
    expect(url.searchParams.get("boundary.country")).toBe("US");
    expect(url.searchParams.get("api_key")).toBe("k123");

    expect(results).toHaveLength(1);
    expect(results[0].address).toBe("530 South King Street, Honolulu, HI, USA");
    expect(results[0].score).toBe(1);
    expect(results[0].attributes.layer).toBe("address");
    expect(results[0].attributes.source).toBe("openaddresses");
    expect(results[0].provenance.provider).toBe("pelias");
  });

  it("suggest uses the dedicated /v1/autocomplete endpoint", async () => {
    const { fetchFn, calls } = fixtureFetch("pelias-autocomplete.json");
    const provider = peliasGeocodingProvider({ baseUrl: "https://pelias.example.test", fetchFn });

    const suggestions = await provider.suggest("honol", { limit: 5 });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/autocomplete");
    expect(url.searchParams.get("text")).toBe("honol");
    expect(url.searchParams.get("size")).toBe("5");
    expect(suggestions.map((s) => s.text)).toEqual(["Honolulu, HI, USA", "Honolulu County, HI, USA"]);
    expect(suggestions[0].provenance.provider).toBe("pelias");
  });

  it("reverse uses point.lat/point.lon", async () => {
    const { fetchFn, calls } = fixtureFetch("pelias-reverse.json");
    const provider = peliasGeocodingProvider({ baseUrl: "https://pelias.example.test", fetchFn });

    const match = await provider.reverse(21.305928, -157.858006);

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/reverse");
    expect(url.searchParams.get("point.lat")).toBe("21.305928");
    expect(url.searchParams.get("point.lon")).toBe("-157.858006");
    expect(match?.address).toBe("530 South King Street, Honolulu, HI, USA");
    expect(match?.provenance.provider).toBe("pelias");
  });

  it("supports attribution overrides for instance-specific obligations", () => {
    const provider = peliasGeocodingProvider({
      baseUrl: "https://pelias.example.test",
      attribution: "© Example City GIS",
      usagePolicyUrl: "https://gis.example.test/terms",
    });
    expect(provider.attribution).toBe("© Example City GIS");
    expect(provider.usagePolicyUrl).toBe("https://gis.example.test/terms");
  });
});

// ---------------------------------------------------------------------------
// Honua facade provider
// ---------------------------------------------------------------------------

describe("honuaGeocodingProvider", () => {
  it("wraps HonuaGeocodingClient in the provider contract with provenance", async () => {
    const body = {
      candidates: [
        {
          address: "530 S King St, Honolulu",
          location: { x: -157.858006, y: 21.305928 },
          score: 98.7,
          attributes: { Match_addr: "530 S King St" },
        },
      ],
    };
    const fetchFn = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const client = new HonuaGeocodingClient({ baseUrl: "https://honua.example.test", fetchFn });
    const provider = honuaGeocodingProvider(client);

    expect(provider.id).toBe("honua");
    expect(provider.capabilities).toEqual(["geocode", "reverse", "suggest"]);

    const results = await provider.geocode("530 S King St", { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].address).toBe("530 S King St, Honolulu");
    expect(results[0].score).toBe(98.7);
    expect(results[0].provenance.provider).toBe("honua");
    expect(results[0].provenance.attribution).toBe(provider.attribution);
  });

  it("wraps suggest and stamps provenance", async () => {
    const body = { suggestions: [{ text: "Honolulu", magicKey: "m1", isCollection: false }] };
    const fetchFn = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const client = new HonuaGeocodingClient({ baseUrl: "https://honua.example.test", fetchFn });
    const provider = honuaGeocodingProvider(client, { attribution: "Demo locator data" });

    const suggestions = await provider.suggest("honol", { limit: 3 });
    expect(suggestions).toEqual([
      { text: "Honolulu", provenance: { provider: "honua", attribution: "Demo locator data" } },
    ]);
  });
});
