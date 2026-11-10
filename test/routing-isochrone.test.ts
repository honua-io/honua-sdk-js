import { describe, expect, it, vi } from "vitest";
import {
  HonuaAbortError,
  HonuaCapabilityNotSupportedError,
  HonuaHttpError,
  HonuaTimeoutError,
} from "../src/core/errors.js";
import {
  type IsochroneRequest,
  osrmRoutingProvider,
  requestIsochrone,
  valhallaRoutingProvider,
} from "../src/routing/index.js";

const request: IsochroneRequest = { origin: { longitude: -156.47, latitude: 20.88 }, minutes: [15, 5] };
const ring = [
  [-156.5, 20.8],
  [-156.4, 20.8],
  [-156.4, 20.9],
  [-156.5, 20.8],
];
const feature = (minutes: number) => ({
  type: "Feature",
  properties: { contour: minutes, metric: "time" },
  geometry: { type: "Polygon", coordinates: [ring] },
});
const response = () => ({ type: "FeatureCollection", features: [feature(15), feature(5)] });
function setup(data: unknown = response()) {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(data)));
  return {
    fetchFn,
    provider: valhallaRoutingProvider({
      baseUrl: "https://routing.example.test/",
      fetchFn,
      attribution: "Configured county routing data",
    }),
  };
}

describe("provider travel-time polygons", () => {
  it("encodes origin, sorted minutes and travel mode; normalizes polygons with attribution", async () => {
    const { provider, fetchFn } = setup();
    const result = await requestIsochrone(provider, { ...request, travelMode: "pedestrian" });
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.pathname).toBe("/isochrone");
    expect(JSON.parse(url.searchParams.get("json")!)).toEqual({
      locations: [{ lon: -156.47, lat: 20.88 }],
      costing: "pedestrian",
      contours: [{ time: 5 }, { time: 15 }],
      polygons: true,
    });
    expect(result.contours.map((contour) => contour.minutes)).toEqual([5, 15]);
    expect(result.contours[0].geometry).toEqual(feature(5).geometry);
    expect(result.provenance).toMatchObject({ provider: "valhalla", attribution: "Configured county routing data" });
  });

  it("supports MultiPolygon and the configured costing model", async () => {
    const data = response();
    const multi = { ...feature(5), geometry: { type: "MultiPolygon", coordinates: [[ring]] } };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ...data, features: [feature(15), multi] })));
    const provider = valhallaRoutingProvider({ baseUrl: "https://routing.example.test", costing: "bicycle", fetchFn });
    expect((await provider.isochrone(request)).contours[0].geometry.type).toBe("MultiPolygon");
    expect(JSON.parse(new URL(String(fetchFn.mock.calls[0][0])).searchParams.get("json")!).costing).toBe("bicycle");
  });

  it("rejects an unsupported provider without a network request", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const provider = osrmRoutingProvider({ baseUrl: "https://routing.example.test", fetchFn });
    await expect(requestIsochrone(provider, request)).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(
    [[], [0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY], [5, 5], [1, 2, 3, 4, 5]].map((minutes) => ({ minutes })),
  )("rejects invalid thresholds %j before fetching", async ({ minutes }) => {
    const { provider, fetchFn } = setup();
    await expect(provider.isochrone({ ...request, minutes })).rejects.toThrow(/minutes/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { longitude: 181, latitude: 0 },
    { longitude: 0, latitude: 91 },
    { longitude: Number.NaN, latitude: 0 },
  ])("rejects invalid origin %j", async (origin) => {
    const { provider, fetchFn } = setup();
    await expect(provider.isochrone({ ...request, origin })).rejects.toThrow(/WGS84/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { error: "No suitable edges" },
    { type: "FeatureCollection", features: [] },
    { type: "FeatureCollection", features: [feature(5), feature(5)] },
    { type: "FeatureCollection", features: [feature(5), feature(10)] },
    {
      type: "FeatureCollection",
      features: [{ ...feature(5), properties: { contour: 5, metric: "distance" } }, feature(15)],
    },
    {
      type: "FeatureCollection",
      features: [{ ...feature(5), geometry: { type: "LineString", coordinates: ring } }, feature(15)],
    },
    {
      type: "FeatureCollection",
      features: [{ ...feature(5), geometry: { type: "Polygon", coordinates: [ring.slice(0, 3)] } }, feature(15)],
    },
  ])("rejects missing, clamped or malformed contours", async (data) => {
    await expect(setup(data).provider.isochrone(request)).rejects.toBeInstanceOf(HonuaHttpError);
  });

  it("maps an HTTP failure without returning an empty area", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 429 }));
    const provider = valhallaRoutingProvider({ baseUrl: "https://routing.example.test", fetchFn });
    await expect(provider.isochrone(request)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("cancels before fetching and during a request, independently of timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, fetchFn } = setup();
    await expect(provider.isochrone({ ...request, signal: controller.signal })).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();
    const active = new AbortController();
    const pendingFetch = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    const cancellable = valhallaRoutingProvider({
      baseUrl: "https://routing.example.test",
      fetchFn: pendingFetch,
      timeoutMs: 1000,
    });
    const pending = cancellable.isochrone({ ...request, signal: active.signal });
    active.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
  });

  it("maps an expired timeout", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    const provider = valhallaRoutingProvider({ baseUrl: "https://routing.example.test", fetchFn, timeoutMs: 1 });
    await expect(provider.isochrone(request)).rejects.toBeInstanceOf(HonuaTimeoutError);
  });
});
