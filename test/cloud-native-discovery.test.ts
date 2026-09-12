import { describe, expect, it, vi } from "vitest";

import {
  HonuaCloudNativeDiscoveryError,
  assertCloudNativeOperation,
  discoverCloudNativeSources,
  parseCloudNativeDiscovery,
  serializeCloudNativeDiscovery,
} from "../src/cloud-native-discovery/index.js";
import { HonuaAbortError, HonuaHttpError } from "../src/core/errors.js";

const PINNED_DEMO_MANIFEST = {
  format: "honua.demo-services.v1",
  schemaVersion: "1.0.0",
  baseUrl: "https://demo.honua.io",
  publishUrl: "https://demo.honua.io/demo-services.v1.json",
  services: [
    {
      id: "global-stac",
      title: "Global imagery",
      protocols: {
        stac: {
          path: "/api/stac",
          collectionsPath: "/api/stac/collections",
          searchPath: "/api/stac/search",
        },
      },
    },
    {
      id: "world-basemap",
      title: "World basemap",
      protocols: { pmtiles: { path: "/assets/world.pmtiles" } },
    },
    {
      id: "ordinary-feature-service",
      protocols: { featureServer: { path: "/rest/services/world/FeatureServer", layerId: 0 } },
    },
  ],
};

describe("cloud-native source capability discovery", () => {
  it("uses the pinned deployment manifest and only its authoritative source links", async () => {
    const requests: Array<{ url: string; accept: string | null; authorization: string | null; trace: string | null }> =
      [];
    const after = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: input.toString(),
        accept: headers.get("accept"),
        authorization: headers.get("authorization"),
        trace: headers.get("x-discovery-trace"),
      });
      return Response.json(PINNED_DEMO_MANIFEST);
    });

    const document = await discoverCloudNativeSources("https://demo.honua.io", {
      fetchFn,
      auth: async () => ({ bearerToken: "rotated-token" }),
      interceptors: [
        {
          before(context) {
            expect(context.init.headers).toBeDefined();
            return { init: { headers: { "x-discovery-trace": "contract-test" } } };
          },
          after,
        },
      ],
    });

    expect(requests).toEqual([
      {
        url: "https://demo.honua.io/demo-services.v1.json",
        accept: "application/json",
        authorization: "Bearer rotated-token",
        trace: "contract-test",
      },
    ]);
    expect(after).toHaveBeenCalledOnce();
    expect(document.sources).toEqual([
      expect.objectContaining({
        id: "global-stac:stac",
        kind: "stac",
        maturity: "supported",
        locator: {
          type: "stac-api",
          rootHref: "https://demo.honua.io/api/stac",
          collectionsHref: "https://demo.honua.io/api/stac/collections",
          searchHref: "https://demo.honua.io/api/stac/search",
        },
      }),
      expect.objectContaining({
        id: "world-basemap:pmtiles",
        kind: "pmtiles",
        maturity: "supported",
        locator: { type: "asset", href: "https://demo.honua.io/assets/world.pmtiles" },
      }),
    ]);
    expect(document.capabilities.find((capability) => capability.kind === "zarr")).toEqual({
      kind: "zarr",
      maturity: "unavailable",
      status: { client: "experimental", server: "unavailable", endToEnd: "unavailable" },
      advertised: false,
      sourceCount: 0,
    });
    expect(document.capabilities.find((capability) => capability.kind === "netcdf")?.status).toEqual({
      client: "unavailable",
      server: "unavailable",
      endToEnd: "unavailable",
    });
  });

  it("normalizes a direct cloud object without making a discovery request", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const document = await discoverCloudNativeSources("https://objects.example.test/maps/base.pmtiles", { fetchFn });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(document.sources).toEqual([
      expect.objectContaining({
        kind: "pmtiles",
        origin: "direct-asset",
        maturity: "supported",
        status: { client: "supported", server: "not-applicable", endToEnd: "supported" },
        locator: { type: "asset", href: "https://objects.example.test/maps/base.pmtiles" },
      }),
    ]);
  });

  it("requires explicit COG evidence instead of inferring it from a TIFF suffix", async () => {
    const fetchFn = vi.fn<typeof fetch>();

    await expect(
      discoverCloudNativeSources("https://objects.example.test/maps/ordinary.tif", { fetchFn }),
    ).rejects.toMatchObject({ code: "invalid-cloud-native-input" });
    expect(fetchFn).not.toHaveBeenCalled();

    const document = await discoverCloudNativeSources({
      type: "direct-asset",
      url: "https://objects.example.test/maps/verified-cog.tif",
      format: "cog",
    });
    expect(document.sources[0]).toMatchObject({
      kind: "cog",
      evidence: [{ type: "declared-format", value: "cog" }],
    });
  });

  it("refuses cross-origin manifest redirects before replaying credentials", async () => {
    const requests: Array<{ url: string; apiKey: string | null; redirect: RequestRedirect | undefined }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        url: input.toString(),
        apiKey: new Headers(init?.headers).get("x-api-key"),
        redirect: init?.redirect,
      });
      return new Response(null, { status: 302, headers: { location: "https://attacker.test/steal" } });
    });

    await expect(
      discoverCloudNativeSources("https://demo.honua.io", { apiKey: "secret-key", fetchFn }),
    ).rejects.toThrow(/cross-origin manifest redirect/i);

    expect(requests).toEqual([
      {
        url: "https://demo.honua.io/demo-services.v1.json",
        apiKey: "secret-key",
        redirect: "manual",
      },
    ]);
  });

  it("requires explicit opt-in before an experimental operation", async () => {
    const document = await discoverCloudNativeSources({
      type: "direct-asset",
      url: "https://objects.example.test/overture.parquet",
      format: "geoparquet",
    });
    const source = document.sources[0];
    if (!source) throw new Error("fixture source missing");

    expect(() => assertCloudNativeOperation(source, "query")).toThrow(HonuaCloudNativeDiscoveryError);
    try {
      assertCloudNativeOperation(source, "query");
    } catch (error) {
      expect(error).toMatchObject({ code: "cloud-native-operation-unavailable" });
    }
    expect(() => assertCloudNativeOperation(source, "query", { allowExperimental: true })).not.toThrow();
  });

  it("keeps Zarr and NetCDF unavailable without inventing execution", async () => {
    for (const [url, format, maturity] of [
      ["https://objects.example.test/climate.zarr", "zarr", "unavailable"],
      ["https://objects.example.test/climate.nc", "netcdf", "unavailable"],
    ] as const) {
      const document = await discoverCloudNativeSources({ type: "direct-asset", url, format });
      const source = document.sources[0];
      if (!source) throw new Error("fixture source missing");
      expect(source.maturity).toBe(maturity);
      expect(() => assertCloudNativeOperation(source, "inspect-metadata")).toThrow(HonuaCloudNativeDiscoveryError);
      expect(source.operations).toEqual(["discover", "inspect-metadata"]);
    }
  });

  it("preserves the unavailable Zarr end-to-end ceiling for an advertised source", async () => {
    const document = await discoverCloudNativeSources("https://demo.honua.io", {
      fetchFn: async () =>
        Response.json({
          format: "honua.demo-services.v1",
          schemaVersion: "1.0.0",
          baseUrl: "https://demo.honua.io",
          services: [{ id: "climate", protocols: { zarr: { path: "/assets/climate.zarr" } } }],
        }),
    });
    const source = document.sources[0];
    if (!source) throw new Error("fixture source missing");

    expect(source).toMatchObject({
      kind: "zarr",
      maturity: "unavailable",
      status: { client: "experimental", server: "experimental", endToEnd: "unavailable" },
      operations: ["discover", "inspect-metadata"],
    });
    expect(() => assertCloudNativeOperation(source, "inspect-metadata", { allowExperimental: true })).toThrow(
      HonuaCloudNativeDiscoveryError,
    );
  });

  it("honors cancellation before invoking fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn<typeof fetch>();

    await expect(
      discoverCloudNativeSources("https://demo.honua.io", { signal: controller.signal, fetchFn }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("preserves typed HTTP failures and notifies error interceptors", async () => {
    const onError = vi.fn();
    const after = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("not authorized", { status: 401 }));

    await expect(
      discoverCloudNativeSources("https://demo.honua.io", {
        fetchFn,
        interceptors: [{ after, error: onError }],
      }),
    ).rejects.toBeInstanceOf(HonuaHttpError);
    expect(after).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(HonuaHttpError) }));
  });

  it("refreshes provider credentials once after an unauthorized manifest response", async () => {
    const auth = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) => ({
      bearerToken: forceRefresh ? "fresh-token" : "stale-token",
    }));
    const authorizations: Array<string | null> = [];
    const after = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return authorizations.length === 1
        ? new Response("expired", { status: 401 })
        : Response.json(PINNED_DEMO_MANIFEST);
    });

    await discoverCloudNativeSources("https://demo.honua.io", {
      auth,
      fetchFn,
      interceptors: [{ after }],
    });

    expect(authorizations).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(auth).toHaveBeenNthCalledWith(1, { forceRefresh: false, reason: "initial" });
    expect(auth).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      previousCredentials: { bearerToken: "stale-token" },
      reason: "unauthorized",
    });
    expect(after).toHaveBeenCalledOnce();
  });

  it("rejects oversized and overpopulated deployment manifests", async () => {
    const oversizedFetch = vi.fn<typeof fetch>(async () =>
      Response.json(PINNED_DEMO_MANIFEST, { headers: { "content-length": "1048577" } }),
    );
    await expect(
      discoverCloudNativeSources("https://demo.honua.io", { fetchFn: oversizedFetch }),
    ).rejects.toMatchObject({ code: "invalid-cloud-native-manifest" });

    const crowdedManifest = {
      ...PINNED_DEMO_MANIFEST,
      services: Array.from({ length: 1_001 }, (_, index) => ({ id: `service-${index}`, protocols: {} })),
    };
    await expect(
      discoverCloudNativeSources("https://demo.honua.io", {
        fetchFn: async () => Response.json(crowdedManifest),
      }),
    ).rejects.toMatchObject({ code: "invalid-cloud-native-manifest" });
  });

  it("serializes deterministically and validates the version envelope", async () => {
    const document = await discoverCloudNativeSources("https://objects.example.test/maps/base.pmtiles");
    const first = serializeCloudNativeDiscovery(document);
    const second = serializeCloudNativeDiscovery(parseCloudNativeDiscovery(first));

    expect(second).toBe(first);
    expect(() => parseCloudNativeDiscovery('{"format":"wrong"}')).toThrow(HonuaCloudNativeDiscoveryError);
  });
});
