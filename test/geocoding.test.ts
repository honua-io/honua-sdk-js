import { describe, expect, it } from "vitest";

import { HonuaHttpError, HonuaNetworkError, HonuaTimeoutError } from "../src/core/errors.js";
import {
  type GeocodeResult,
  type GeocodeSuggestion,
  HonuaGeocodingClient,
  type ReverseGeocodeResult,
} from "../src/geocoding/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://geocode.example.test";

/** Build a client with a mock fetchFn. */
function createClient(
  fetchFn: typeof fetch,
  opts?: { apiKey?: string; bearerToken?: string; locatorName?: string; timeoutMs?: number },
) {
  return new HonuaGeocodingClient({
    baseUrl: BASE_URL,
    fetchFn,
    ...opts,
  });
}

/** Return a mock fetchFn that resolves with the given JSON body. */
function jsonResponse(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Return a mock fetchFn that resolves with a non-JSON text body. */
function textResponse(text: string, status: number): typeof fetch {
  return async () => new Response(text, { status });
}

// ---------------------------------------------------------------------------
// Forward geocoding
// ---------------------------------------------------------------------------

describe("HonuaGeocodingClient", () => {
  describe("forwardGeocode", () => {
    it("returns mapped results on success", async () => {
      const serverPayload = {
        spatialReference: { wkid: 4326 },
        candidates: [
          {
            address: "380 New York St, Redlands, CA 92373",
            location: { x: -117.1956, y: 34.0564 },
            score: 100,
            attributes: { Addr_type: "PointAddress", City: "Redlands" },
          },
          {
            address: "123 Main St, Anytown, CA 90210",
            location: { x: -118.4, y: 34.1 },
            score: 85,
            attributes: { Addr_type: "StreetAddress", City: null },
          },
        ],
      };

      const client = createClient(jsonResponse(serverPayload));
      const results = await client.forwardGeocode("380 New York St, Redlands");

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual<GeocodeResult>({
        address: "380 New York St, Redlands, CA 92373",
        longitude: -117.1956,
        latitude: 34.0564,
        score: 100,
        attributes: { Addr_type: "PointAddress", City: "Redlands" },
      });
      expect(results[1].score).toBe(85);
      expect(results[1].attributes.City).toBeNull();
    });

    it("returns an empty array when there are no candidates", async () => {
      const client = createClient(jsonResponse({ candidates: [] }));
      const results = await client.forwardGeocode("xyznonexistent");
      expect(results).toEqual([]);
    });

    it("returns an empty array when candidates field is missing", async () => {
      const client = createClient(jsonResponse({}));
      const results = await client.forwardGeocode("xyznonexistent");
      expect(results).toEqual([]);
    });

    it("throws HonuaHttpError when the server payload contains an error object", async () => {
      const client = createClient(
        jsonResponse({
          error: { code: 400, message: "Unable to find address", details: [] },
          candidates: [],
        }),
      );

      await expect(client.forwardGeocode("bad input")).rejects.toThrow(HonuaHttpError);
      await expect(client.forwardGeocode("bad input")).rejects.toThrow(/Geocode server error/);
    });

    it("retains HTTP-200 transport, token protocol code, and response identity", async () => {
      const client = createClient(
        async () =>
          new Response(JSON.stringify({ error: { code: 498, message: "Token expired", details: [] } }), {
            status: 200,
            headers: { "X-Correlation-ID": "geo-498" },
          }),
      );

      const error = await client.forwardGeocode("test").catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(HonuaHttpError);
      expect((error as HonuaHttpError).receipt).toMatchObject({
        transportStatus: 200,
        protocolCode: 498,
        kind: "authentication",
        code: "authentication_required",
        correlationId: "geo-498",
      });
    });

    it("passes maxResults, countryCodes, and spatialReferenceWkid as query params", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (input) => {
        capturedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(JSON.stringify({ candidates: [] }));
      };

      const client = createClient(fetchFn);
      await client.forwardGeocode("test", {
        maxResults: 5,
        countryCodes: "US,CA",
        spatialReferenceWkid: 3857,
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("maxLocations")).toBe("5");
      expect(url.searchParams.get("countryCode")).toBe("US,CA");
      expect(url.searchParams.get("outSR")).toBe("3857");
      expect(url.searchParams.get("singleLine")).toBe("test");
      expect(url.searchParams.get("f")).toBe("json");
    });

    it("builds the correct service URL path with default locator", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (input) => {
        capturedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(JSON.stringify({ candidates: [] }));
      };

      const client = createClient(fetchFn);
      await client.forwardGeocode("test");

      expect(capturedUrl).toContain("/rest/services/World/GeocodeServer/findAddressCandidates");
    });

    it("builds the correct service URL path with custom locator", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (input) => {
        capturedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(JSON.stringify({ candidates: [] }));
      };

      const client = createClient(fetchFn, { locatorName: "MyLocator" });
      await client.forwardGeocode("test");

      expect(capturedUrl).toContain("/rest/services/MyLocator/GeocodeServer/findAddressCandidates");
    });

    it("stringifies non-string attribute values", async () => {
      // Simulate a raw server response where numeric and null values appear.
      // Note: JSON.stringify drops `undefined`, so we only test values that
      // survive serialisation (numbers, booleans, null).
      const serverPayload = {
        candidates: [
          {
            address: "test",
            location: { x: 0, y: 0 },
            score: 90,
            attributes: { Score: 90, Subregion: null, Flag: true },
          },
        ],
      };

      const client = createClient(jsonResponse(serverPayload));
      const results = await client.forwardGeocode("test");

      expect(results[0].attributes.Score).toBe("90");
      expect(results[0].attributes.Subregion).toBeNull();
      expect(results[0].attributes.Flag).toBe("true");
    });
  });

  // -------------------------------------------------------------------------
  // Reverse geocoding
  // -------------------------------------------------------------------------

  describe("reverseGeocode", () => {
    it("returns a mapped result on success", async () => {
      const serverPayload = {
        address: {
          Match_addr: "380 New York St, Redlands, CA 92373",
          LongLabel: "380 New York St, Redlands, CA 92373, USA",
          City: "Redlands",
        },
        location: { x: -117.1956, y: 34.0564 },
      };

      const client = createClient(jsonResponse(serverPayload));
      const result = await client.reverseGeocode(34.0564, -117.1956);

      expect(result).not.toBeNull();
      expect(result).toEqual<ReverseGeocodeResult>({
        address: "380 New York St, Redlands, CA 92373",
        longitude: -117.1956,
        latitude: 34.0564,
        attributes: {
          LongLabel: "380 New York St, Redlands, CA 92373, USA",
          City: "Redlands",
        },
      });
    });

    it("passes location and outSR as query params", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (input) => {
        capturedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(
          JSON.stringify({
            address: { Match_addr: "test" },
            location: { x: 10, y: 20 },
          }),
        );
      };

      const client = createClient(fetchFn);
      await client.reverseGeocode(20.5, 10.3, { spatialReferenceWkid: 3857 });

      const url = new URL(capturedUrl);
      // location param is "longitude,latitude"
      expect(url.searchParams.get("location")).toBe("10.3,20.5");
      expect(url.searchParams.get("outSR")).toBe("3857");
      expect(url.searchParams.get("f")).toBe("json");
    });

    it("returns null when the server-level error code is 400", async () => {
      const client = createClient(
        jsonResponse({
          error: { code: 400, message: "No address found" },
        }),
      );

      const result = await client.reverseGeocode(0, 0);
      expect(result).toBeNull();
    });

    it("returns null when the HTTP response is a 400 error", async () => {
      const client = createClient(textResponse("Bad Request", 400));
      const result = await client.reverseGeocode(0, 0);
      expect(result).toBeNull();
    });

    it("returns null when address or location is missing from response", async () => {
      const client = createClient(jsonResponse({}));
      const result = await client.reverseGeocode(34.0, -117.0);
      expect(result).toBeNull();
    });

    it("throws HonuaHttpError for non-400 server errors", async () => {
      const client = createClient(
        jsonResponse({
          error: { code: 500, message: "Internal server error" },
        }),
      );

      await expect(client.reverseGeocode(34.0, -117.0)).rejects.toThrow(HonuaHttpError);
      await expect(client.reverseGeocode(34.0, -117.0)).rejects.toThrow(/Reverse geocode server error/);
    });

    it("uses Match_addr as the address field and excludes it from attributes", async () => {
      const serverPayload = {
        address: {
          Match_addr: "123 Main St",
          City: "Anytown",
          Region: "CA",
        },
        location: { x: -118.0, y: 34.0 },
      };

      const client = createClient(jsonResponse(serverPayload));
      const result = await client.reverseGeocode(34.0, -118.0);

      expect(result!.address).toBe("123 Main St");
      expect(result!.attributes).not.toHaveProperty("Match_addr");
      expect(result!.attributes.City).toBe("Anytown");
      expect(result!.attributes.Region).toBe("CA");
    });

    it("defaults address to empty string when Match_addr is missing", async () => {
      const serverPayload = {
        address: { City: "Anytown" },
        location: { x: -118.0, y: 34.0 },
      };

      const client = createClient(jsonResponse(serverPayload));
      const result = await client.reverseGeocode(34.0, -118.0);

      expect(result!.address).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // Suggest / autocomplete
  // -------------------------------------------------------------------------

  describe("suggest", () => {
    it("returns mapped suggestions on success", async () => {
      const serverPayload = {
        suggestions: [
          { text: "380 New York St, Redlands, CA", magicKey: "abc123", isCollection: false },
          { text: "New York, NY", magicKey: "def456", isCollection: true },
        ],
      };

      const client = createClient(jsonResponse(serverPayload));
      const results = await client.suggest("380 New York");

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual<GeocodeSuggestion>({
        text: "380 New York St, Redlands, CA",
        magicKey: "abc123",
        isCollection: false,
      });
      expect(results[1]).toEqual<GeocodeSuggestion>({
        text: "New York, NY",
        magicKey: "def456",
        isCollection: true,
      });
    });

    it("returns an empty array when there are no suggestions", async () => {
      const client = createClient(jsonResponse({ suggestions: [] }));
      const results = await client.suggest("xyznonexistent");
      expect(results).toEqual([]);
    });

    it("returns an empty array when suggestions field is missing", async () => {
      const client = createClient(jsonResponse({}));
      const results = await client.suggest("xyznonexistent");
      expect(results).toEqual([]);
    });

    it("passes maxSuggestions and countryCodes as query params", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (input) => {
        capturedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(JSON.stringify({ suggestions: [] }));
      };

      const client = createClient(fetchFn);
      await client.suggest("test", { maxSuggestions: 3, countryCodes: "US" });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("text")).toBe("test");
      expect(url.searchParams.get("maxSuggestions")).toBe("3");
      expect(url.searchParams.get("countryCode")).toBe("US");
      expect(url.searchParams.get("f")).toBe("json");
    });

    it("throws HonuaHttpError when the server payload contains an error", async () => {
      const client = createClient(
        jsonResponse({
          error: { code: 500, message: "Server exploded" },
          suggestions: [],
        }),
      );

      await expect(client.suggest("test")).rejects.toThrow(HonuaHttpError);
      await expect(client.suggest("test")).rejects.toThrow(/Suggest server error/);
    });

    it("builds the correct URL path for suggest", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (input) => {
        capturedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(JSON.stringify({ suggestions: [] }));
      };

      const client = createClient(fetchFn);
      await client.suggest("test");

      expect(capturedUrl).toContain("/rest/services/World/GeocodeServer/suggest");
    });
  });

  // -------------------------------------------------------------------------
  // Auth header passing
  // -------------------------------------------------------------------------

  describe("auth headers", () => {
    it("sends X-API-Key header when apiKey is provided", async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchFn: typeof fetch = async (_input, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ candidates: [] }));
      };

      const client = createClient(fetchFn, { apiKey: "my-secret-key" });
      await client.forwardGeocode("test");

      expect(capturedHeaders["X-API-Key"]).toBe("my-secret-key");
    });

    it("sends Authorization bearer header when bearerToken is provided", async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchFn: typeof fetch = async (_input, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ candidates: [] }));
      };

      const client = createClient(fetchFn, { bearerToken: "tok_abc123" });
      await client.forwardGeocode("test");

      expect(capturedHeaders.Authorization).toBe("Bearer tok_abc123");
    });

    it("sends both headers when apiKey and bearerToken are provided", async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchFn: typeof fetch = async (_input, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ candidates: [] }));
      };

      const client = createClient(fetchFn, { apiKey: "key123", bearerToken: "tok_abc" });
      await client.forwardGeocode("test");

      expect(capturedHeaders["X-API-Key"]).toBe("key123");
      expect(capturedHeaders.Authorization).toBe("Bearer tok_abc");
    });

    it("sends no auth headers when neither apiKey nor bearerToken is provided", async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchFn: typeof fetch = async (_input, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ candidates: [] }));
      };

      const client = createClient(fetchFn);
      await client.forwardGeocode("test");

      expect(capturedHeaders).not.toHaveProperty("X-API-Key");
      expect(capturedHeaders).not.toHaveProperty("Authorization");
    });
  });

  // -------------------------------------------------------------------------
  // HTTP error responses
  // -------------------------------------------------------------------------

  describe("HTTP error responses", () => {
    it("throws HonuaHttpError with status 404", async () => {
      const client = createClient(textResponse("Not Found", 404));

      try {
        await client.forwardGeocode("test");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HonuaHttpError);
        expect((err as HonuaHttpError).statusCode).toBe(404);
        expect((err as HonuaHttpError).message).toContain("404");
      }
    });

    it("throws HonuaHttpError with status 500", async () => {
      const client = createClient(
        async () =>
          new Response("Internal Server Error", {
            status: 500,
            headers: { "Retry-After": "9", "X-Request-ID": "geo-500" },
          }),
      );

      try {
        await client.forwardGeocode("test");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HonuaHttpError);
        expect((err as HonuaHttpError).statusCode).toBe(500);
        expect((err as HonuaHttpError).receipt.retryAfterMs).toBe(9_000);
        expect((err as HonuaHttpError).receipt.correlationId).toBe("geo-500");
      }
    });

    it("throws HonuaHttpError with status 401 for unauthorized", async () => {
      const client = createClient(textResponse("Unauthorized", 401));

      await expect(client.suggest("test")).rejects.toThrow(HonuaHttpError);
    });

    it("throws HonuaHttpError with status 403 for forbidden", async () => {
      const client = createClient(textResponse("Forbidden", 403));

      await expect(client.reverseGeocode(34.0, -117.0)).rejects.toThrow(HonuaHttpError);
    });

    it("parses JSON error body when available on non-ok response", async () => {
      const errorBody = { error: { code: 500, message: "Something broke" } };
      const client = createClient(jsonResponse(errorBody, 500));

      try {
        await client.forwardGeocode("test");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HonuaHttpError);
        const httpErr = err as HonuaHttpError;
        expect(httpErr.statusCode).toBe(500);
        expect(httpErr.body).toEqual(errorBody);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Network errors
  // -------------------------------------------------------------------------

  describe("network errors", () => {
    it("throws HonuaNetworkError when fetch rejects with TypeError", async () => {
      const client = createClient(() => Promise.reject(new TypeError("Failed to fetch")));

      await expect(client.forwardGeocode("test")).rejects.toThrow(HonuaNetworkError);
    });

    it("wraps the original error as cause", async () => {
      const original = new TypeError("DNS resolution failed");
      const client = createClient(() => Promise.reject(original));

      try {
        await client.forwardGeocode("test");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HonuaNetworkError);
        expect((err as HonuaNetworkError).cause).toBe(original);
      }
    });

    it("does not leak the X-API-Key header to a cross-origin redirect target (issue #305)", async () => {
      const calls: { url: string; apiKey: string | undefined; redirect: RequestRedirect | undefined }[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, apiKey: headers.get("x-api-key") ?? undefined, redirect: init?.redirect });
        if (new URL(url).origin === new URL(BASE_URL).origin) {
          return new Response(null, { status: 302, headers: { location: "https://attacker.test/steal" } });
        }
        return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
      };
      const client = createClient(fetchFn, { apiKey: "super-secret-key" });

      await expect(client.forwardGeocode("test")).rejects.toThrow(/cross-origin/i);

      expect(calls[0]?.redirect).toBe("manual");
      expect(calls.some((call) => new URL(call.url).origin === "https://attacker.test")).toBe(false);
      expect(
        calls.some((call) => new URL(call.url).origin === "https://attacker.test" && call.apiKey !== undefined),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe("timeout", () => {
    it("throws HonuaTimeoutError when the request exceeds timeoutMs", async () => {
      const client = createClient(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              if (signal.aborted) {
                reject(signal.reason ?? new DOMException("aborted", "AbortError"));
                return;
              }
              signal.addEventListener("abort", () => {
                reject(signal.reason ?? new DOMException("aborted", "AbortError"));
              });
            }
          }),
        { timeoutMs: 50 },
      );

      await expect(client.forwardGeocode("test")).rejects.toThrow(HonuaTimeoutError);
    }, 10_000);
  });

  // -------------------------------------------------------------------------
  // Base URL normalization
  // -------------------------------------------------------------------------

  describe("base URL normalization", () => {
    it("strips trailing slashes from baseUrl", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (input) => {
        capturedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(JSON.stringify({ candidates: [] }));
      };

      const client = new HonuaGeocodingClient({
        baseUrl: "https://geocode.example.test///",
        fetchFn,
      });

      await client.forwardGeocode("test");

      expect(capturedUrl).toMatch(/^https:\/\/geocode\.example\.test\/rest\//);
      expect(capturedUrl).not.toContain("///");
    });
  });

  describe("default fetch binding", () => {
    // Browsers reject `window.fetch` invoked with any receiver other than
    // the global object — calling the stored default through
    // `this.fetchFn(...)` rebinds the receiver to the client instance and
    // throws "TypeError: Illegal invocation" (#272, same family as #269).
    // Emulate the browser receiver contract in Node with a strict double
    // so the regression fails when the default fetch is stored unbound.
    it("invokes the default global fetch with a globalThis-safe receiver, not the client instance", async () => {
      const realFetch = globalThis.fetch;
      const strictFetch = function (this: unknown, ..._args: Parameters<typeof fetch>): Promise<Response> {
        if (this !== undefined && this !== globalThis) {
          throw new TypeError("Illegal invocation");
        }
        return Promise.resolve(
          new Response(JSON.stringify({ candidates: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };
      globalThis.fetch = strictFetch as typeof fetch;
      try {
        const client = new HonuaGeocodingClient({ baseUrl: BASE_URL });
        await expect(client.forwardGeocode("380 New York St, Redlands")).resolves.toEqual([]);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
});
