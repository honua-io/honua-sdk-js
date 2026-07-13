import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HonuaHttpError } from "../src/core/errors.js";
import {
  decodePolyline,
  honuaRoutingProvider,
  osrmRoutingProvider,
  routingProviderToCompatRouteProvider,
  supportsRoutingCapability,
  valhallaRoutingProvider,
} from "../src/routing/index.js";

const FIXTURES = path.resolve(fileURLToPath(import.meta.url), "../fixtures/providers");

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

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

const WAYPOINTS = [
  { longitude: -157.858, latitude: 21.306, name: "Honolulu Hale" },
  { longitude: -157.802, latitude: 21.262 },
];

// ---------------------------------------------------------------------------
// decodePolyline
// ---------------------------------------------------------------------------

describe("decodePolyline", () => {
  it("decodes a Valhalla 1e-6 precision shape into [lon, lat] pairs", () => {
    const decoded = decodePolyline("_hlsg@~k{alH~f^_uu@~tu@_uu@", 1e6);
    expect(decoded).toHaveLength(3);
    expect(decoded[0][0]).toBeCloseTo(-157.858, 6);
    expect(decoded[0][1]).toBeCloseTo(21.306, 6);
    expect(decoded[2][0]).toBeCloseTo(-157.802, 6);
    expect(decoded[2][1]).toBeCloseTo(21.262, 6);
  });

  it("throws on a truncated shape", () => {
    expect(() => decodePolyline("_hlsg", 1e6)).toThrowError(/truncated/);
  });
});

// ---------------------------------------------------------------------------
// OSRM
// ---------------------------------------------------------------------------

describe("osrmRoutingProvider", () => {
  it("declares the route capability and attribution metadata", () => {
    const provider = osrmRoutingProvider({ baseUrl: "https://osrm.example.test" });
    expect(provider.id).toBe("osrm");
    expect(supportsRoutingCapability(provider, "route")).toBe(true);
    expect(provider.attribution).toContain("OpenStreetMap contributors");
    expect(provider.usagePolicyUrl).toBeDefined();
  });

  it("normalizes /route/v1 responses with provenance", async () => {
    const { fetchFn, calls } = fixtureFetch("osrm-route.json");
    const provider = osrmRoutingProvider({ baseUrl: "https://osrm.example.test/", fetchFn });

    const result = await provider.route(WAYPOINTS);

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/route/v1/driving/-157.858,21.306;-157.802,21.262");
    expect(url.searchParams.get("geometries")).toBe("geojson");
    expect(url.searchParams.get("overview")).toBe("full");

    expect(result.distanceMeters).toBeCloseTo(9214.6, 3);
    expect(result.durationSeconds).toBeCloseTo(623.7, 3);
    expect(result.geometry).toEqual([
      [-157.858, 21.306],
      [-157.83, 21.29],
      [-157.802, 21.262],
    ]);
    expect(result.legs).toEqual([{ distanceMeters: 9214.6, durationSeconds: 623.7 }]);
    expect(result.provenance.provider).toBe("osrm");
    expect(result.provenance.attribution).toBe(provider.attribution);
  });

  it("uses the configured profile", async () => {
    const { fetchFn, calls } = fixtureFetch("osrm-route.json");
    const provider = osrmRoutingProvider({ baseUrl: "https://osrm.example.test", profile: "foot", fetchFn });
    await provider.route(WAYPOINTS);
    expect(new URL(calls[0].url).pathname).toContain("/route/v1/foot/");
  });

  it("maps a non-Ok OSRM code to HonuaHttpError", async () => {
    const { fetchFn } = fixtureFetch("osrm-route-error.json");
    const provider = osrmRoutingProvider({ baseUrl: "https://osrm.example.test", fetchFn });
    const error = await provider.route(WAYPOINTS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HonuaHttpError);
    expect((error as Error).message).toContain("NoRoute");
  });

  it("requires at least two waypoints and an explicit baseUrl", async () => {
    const provider = osrmRoutingProvider({ baseUrl: "https://osrm.example.test" });
    await expect(provider.route([WAYPOINTS[0]])).rejects.toThrowError(/two waypoints/);
    expect(() => osrmRoutingProvider({ baseUrl: "" })).toThrowError(/baseUrl/);
  });
});

// ---------------------------------------------------------------------------
// Valhalla
// ---------------------------------------------------------------------------

describe("valhallaRoutingProvider", () => {
  it("normalizes /route trips, decoding 1e-6 leg shapes", async () => {
    const { fetchFn, calls } = fixtureFetch("valhalla-route.json");
    const provider = valhallaRoutingProvider({ baseUrl: "https://valhalla.example.test", fetchFn });

    const result = await provider.route(WAYPOINTS);

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/route");
    const request = JSON.parse(url.searchParams.get("json") ?? "{}");
    expect(request.costing).toBe("auto");
    expect(request.locations).toEqual([
      { lat: 21.306, lon: -157.858, name: "Honolulu Hale" },
      { lat: 21.262, lon: -157.802 },
    ]);

    expect(result.geometry).toHaveLength(3);
    expect(result.geometry[0][0]).toBeCloseTo(-157.858, 6);
    expect(result.geometry[0][1]).toBeCloseTo(21.306, 6);
    expect(result.geometry[2][0]).toBeCloseTo(-157.802, 6);
    expect(result.distanceMeters).toBeCloseTo(9215, 0);
    expect(result.durationSeconds).toBeCloseTo(634, 0);
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0].distanceMeters).toBeCloseTo(9215, 6);
    expect(result.legs[0].durationSeconds).toBe(634);
    expect(result.provenance.provider).toBe("valhalla");
    expect(result.provenance.attribution).toContain("OpenStreetMap contributors");
  });

  it("uses the configured costing model", async () => {
    const { fetchFn, calls } = fixtureFetch("valhalla-route.json");
    const provider = valhallaRoutingProvider({ baseUrl: "https://valhalla.example.test", costing: "bicycle", fetchFn });
    await provider.route(WAYPOINTS);
    const request = JSON.parse(new URL(calls[0].url).searchParams.get("json") ?? "{}");
    expect(request.costing).toBe("bicycle");
  });

  it("maps an error envelope to HonuaHttpError", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "No path could be found for input", error_code: 442 }), {
        status: 200,
      })) as typeof fetch;
    const provider = valhallaRoutingProvider({ baseUrl: "https://valhalla.example.test", fetchFn });
    const error = await provider.route(WAYPOINTS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HonuaHttpError);
    expect((error as Error).message).toContain("No path could be found");
  });
});

// ---------------------------------------------------------------------------
// Honua facade + compat bridge
// ---------------------------------------------------------------------------

describe("honuaRoutingProvider", () => {
  it("wraps a compat-shaped solver in the provider contract", async () => {
    const provider = honuaRoutingProvider(
      (stops) => ({
        path: stops.map((stop) => stop.location),
        totalLengthMeters: 9214.6,
        totalTimeSeconds: 623.7,
      }),
      { attribution: "Honua demo route service" },
    );

    expect(provider.id).toBe("honua");
    const result = await provider.route(WAYPOINTS);
    expect(result.geometry).toEqual([
      [-157.858, 21.306],
      [-157.802, 21.262],
    ]);
    expect(result.distanceMeters).toBe(9214.6);
    expect(result.legs).toEqual([{ distanceMeters: 9214.6, durationSeconds: 623.7 }]);
    expect(result.provenance).toEqual({ provider: "honua", attribution: "Honua demo route service" });
  });

  it("preserves one leg per waypoint segment on multi-waypoint routes", async () => {
    // Per-segment totals keyed by the segment's start longitude so each leg
    // gets distinct, verifiable values.
    const segmentTotals: Record<string, { m: number; s: number }> = {
      "-157.858": { m: 4000, s: 300 },
      "-157.83": { m: 5000, s: 400 },
    };
    const solverCalls: [number, number][][] = [];
    const provider = honuaRoutingProvider((stops) => {
      solverCalls.push(stops.map((stop) => stop.location));
      const totals = segmentTotals[String(stops[0].location[0])];
      return {
        path: stops.map((stop) => stop.location),
        totalLengthMeters: totals.m,
        totalTimeSeconds: totals.s,
      };
    });

    const result = await provider.route([
      { longitude: -157.858, latitude: 21.306, name: "A" },
      { longitude: -157.83, latitude: 21.29, name: "B" },
      { longitude: -157.802, latitude: 21.262, name: "C" },
    ]);

    // One solver call per consecutive waypoint pair.
    expect(solverCalls).toEqual([
      [
        [-157.858, 21.306],
        [-157.83, 21.29],
      ],
      [
        [-157.83, 21.29],
        [-157.802, 21.262],
      ],
    ]);

    // waypoints.length - 1 legs, matching the OSRM/Valhalla adapters.
    expect(result.legs).toEqual([
      { distanceMeters: 4000, durationSeconds: 300 },
      { distanceMeters: 5000, durationSeconds: 400 },
    ]);
    expect(result.distanceMeters).toBe(9000);
    expect(result.durationSeconds).toBe(700);

    // Stitched geometry drops the duplicated junction vertex.
    expect(result.geometry).toEqual([
      [-157.858, 21.306],
      [-157.83, 21.29],
      [-157.802, 21.262],
    ]);
  });
});

describe("routingProviderToCompatRouteProvider", () => {
  it("adapts a RoutingProvider into the esri-compat routeProvider shape", async () => {
    const { fetchFn } = fixtureFetch("osrm-route.json");
    const provider = osrmRoutingProvider({ baseUrl: "https://osrm.example.test", fetchFn });
    const compatSolve = routingProviderToCompatRouteProvider(provider);

    const solved = await compatSolve([
      { name: "A", location: [-157.858, 21.306] },
      { name: "B", location: [-157.802, 21.262] },
    ]);

    expect(solved.totalLengthMeters).toBeCloseTo(9214.6, 3);
    expect(solved.totalTimeSeconds).toBeCloseTo(623.7, 3);
    expect(solved.path[0]).toEqual([-157.858, 21.306]);
  });
});
