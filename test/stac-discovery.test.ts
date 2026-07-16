import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { HonuaAbortError, HonuaDiscoveryError, HonuaNetworkError, HonuaTimeoutError } from "../src/core/errors.js";
import { discoverStaticStac } from "../src/stac-discovery.js";
import type { DiscoverStaticStacOptions, StacDiscoveryFetch } from "../src/stac-discovery.js";

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stac-discovery");
const BASE_URL = "https://catalog.test/stac/catalog.json";
const FIXTURE_SCOPE = "fixture:static-stac:v1";

function discoverFixture(options: DiscoverStaticStacOptions) {
  return discoverStaticStac({ authorizationScopeFingerprint: FIXTURE_SCOPE, ...options });
}

describe("static STAC discovery", () => {
  it("normalizes catalog, collection, and item traversal with identity, extent, time, legal, and provenance", async () => {
    const fixture = await fixtureFetch();
    const result = await discoverStaticStac({
      endpoint: BASE_URL,
      authorizationScopeFingerprint: "public-catalog",
      fetchFn: fixture.fetchFn,
    });

    expect(result.documents.map((document) => [document.documentType, document.id])).toEqual([
      ["catalog", "fixture-root"],
      ["collection", "imagery"],
      ["catalog", "fixture-loop"],
      ["item", "scene-a"],
      ["item", "scene-b"],
    ]);
    expect(result.root.url).toBe(BASE_URL);
    expect(result.cacheIdentity.endpoint).toBe(BASE_URL);
    expect(result.cacheIdentity.key).not.toContain("public-catalog");
    const collection = result.documents.find((document) => document.id === "imagery")!;
    expect(collection.extent).toMatchObject({
      state: "known",
      boxes: [{ layout: "xy", bounds: [-160, 18, -154, 23] }],
      crs: { definition: { kind: "authority", authority: "OGC", code: "CRS84" } },
    });
    expect(collection.temporalExtent).toEqual(
      expect.objectContaining({
        state: "known",
        intervals: [
          [null, "2024-12-31T23:59:59Z"],
          ["2025-01-01T00:00:00Z", null],
        ],
      }),
    );
    expect(collection.license).toEqual({ expression: "CC-BY-4.0", links: [] });
    expect(collection.attribution).toBe("Fixture Imagery Program");
    expect(collection.providers[0]).toMatchObject({ name: "Fixture Survey", roles: ["producer", "licensor"] });
    expect(collection.provenance[0]).toMatchObject({
      method: "observed",
      protocol: "stac",
      source: "https://catalog.test/stac/collections/imagery.json",
      validator: { kind: "etag" },
    });
    const scene = result.documents.find((document) => document.id === "scene-a")!;
    expect(scene.collectionId).toBe("imagery");
    expect(scene.temporalExtent).toMatchObject({
      state: "known",
      intervals: [["2025-02-03T04:05:06Z", "2025-02-03T04:05:06Z"]],
    });
    expect(scene.license?.expression).toBe("CC-BY-4.0");
    expect(scene.providers[0]?.name).toBe("Fixture Survey");
    expect(result.statistics).toMatchObject({ documentsRead: 5, assetsRead: 11 });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["link-loop", "cross-origin-link", "unsupported-link-media-type"]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("attacker.example");
  });

  it("requires explicit cache scope for caller-controlled transport and preserves the safe public default", async () => {
    const catalog = JSON.stringify({
      type: "Catalog",
      stac_version: "1.1.0",
      id: "scope-catalog",
      description: "scope fixture",
      links: [],
    });
    const firstTransport = vi.fn<StacDiscoveryFetch>(
      async () => new Response(catalog, { headers: { "Content-Type": "application/json" } }),
    );
    const secondTransport = vi.fn<StacDiscoveryFetch>(
      async () => new Response(catalog, { headers: { "Content-Type": "application/json" } }),
    );

    await expect(discoverStaticStac({ endpoint: BASE_URL, fetchFn: firstTransport })).rejects.toMatchObject({
      code: "invalid-cache-identity",
    });
    await expect(
      discoverStaticStac({ endpoint: BASE_URL, authorizationScopeFingerprint: "public", fetchFn: secondTransport }),
    ).rejects.toMatchObject({ code: "invalid-cache-identity" });
    expect(firstTransport).not.toHaveBeenCalled();
    expect(secondTransport).not.toHaveBeenCalled();

    await expect(
      discoverStaticStac({ endpoint: BASE_URL, headers: { "X-Caller-Scope": "tenant-a" } }),
    ).rejects.toMatchObject({ code: "invalid-cache-identity" });
    await expect(
      discoverStaticStac({ endpoint: BASE_URL, allowedOrigins: ["https://metadata.test"] }),
    ).rejects.toMatchObject({ code: "invalid-cache-identity" });

    const first = await discoverStaticStac({
      endpoint: BASE_URL,
      authorizationScopeFingerprint: "tenant:a",
      fetchFn: firstTransport,
    });
    const second = await discoverStaticStac({
      endpoint: BASE_URL,
      authorizationScopeFingerprint: "tenant:b",
      fetchFn: secondTransport,
    });
    expect(first.cacheIdentity.key).not.toBe(second.cacheIdentity.key);

    const defaultFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(catalog, { headers: { "Content-Type": "application/json" } }));
    try {
      const implicitPublic = await discoverStaticStac({ endpoint: BASE_URL });
      const explicitPublic = await discoverStaticStac({ endpoint: BASE_URL, authorizationScopeFingerprint: "public" });
      expect(implicitPublic.cacheIdentity.key).toBe(explicitPublic.cacheIdentity.key);
      expect(defaultFetch).toHaveBeenCalledTimes(2);
    } finally {
      defaultFetch.mockRestore();
    }
  });

  it("classifies from declared evidence and bounded probes without using file extensions", async () => {
    const fixture = await fixtureFetch();
    const result = await discoverFixture({ endpoint: BASE_URL, fetchFn: fixture.fetchFn });
    const assets = Object.fromEntries(result.assets.map((asset) => [asset.key, asset]));

    expect(assets.cog).toMatchObject({
      classification: { state: "classified", format: "cog", confidence: "verified" },
      crs: { kind: "authority", authority: "EPSG", code: "32604" },
      extent: { state: "known", boxes: [{ bounds: [590000, 2330000, 640000, 2400000] }] },
      license: { expression: "CC-BY-4.0" },
    });
    expect(assets.cog?.source).toBeUndefined();
    expect(assets.geoparquet).toMatchObject({
      classification: { state: "classified", format: "geoparquet", confidence: "verified" },
      source: {
        protocol: "geoparquet",
        locator: { url: "https://catalog.test/stac/assets/places.bin" },
        requirement: "geoparquet-profiler",
      },
    });
    expect(assets.pmtiles).toMatchObject({
      classification: { state: "classified", format: "pmtiles", confidence: "verified" },
      source: { protocol: "pmtiles", requirement: "pmtiles-runtime" },
    });
    expect(assets.tilejson).toMatchObject({
      classification: {
        state: "classified",
        format: "tiles",
        tileLayout: "tilejson",
        tileContent: "vector",
      },
      source: {
        protocol: "maplibre-vector",
        locator: { url: "https://catalog.test/stac/tiles/{z}/{x}/{y}" },
      },
    });
    expect(assets.tilejson?.source?.locator.url).not.toContain("vector.json");
    expect(assets["vector-template"]).toMatchObject({
      classification: {
        state: "classified",
        format: "tiles",
        tileLayout: "template",
        tileContent: "vector",
        confidence: "declared",
      },
      source: { protocol: "maplibre-vector", locator: { url: "https://catalog.test/stac/tiles/{z}/{x}/{y}" } },
    });
    expect(assets.metadata?.classification).toMatchObject({ state: "classified", format: "metadata" });
    expect(assets["generic-geotiff"]?.classification).toMatchObject({
      state: "ambiguous",
      candidates: ["cog"],
    });
    expect(assets["mislabelled-pmtiles"]?.classification).toMatchObject({
      state: "ambiguous",
      candidates: ["pmtiles"],
    });
    expect(assets["suffix-only"]?.classification).toMatchObject({ state: "unsupported", candidates: [] });
    expect(assets["signed-pmtiles"]).toMatchObject({
      access: "resolver-required",
      href: "https://catalog.test/stac/assets/private.bin",
      classification: { state: "classified", format: "pmtiles", confidence: "declared" },
    });
    expect(assets["signed-pmtiles"]?.source).toBeUndefined();
    expect(JSON.stringify(assets["signed-pmtiles"])).not.toContain("top-secret");

    const requested = fixture.requests.map((request) => request.url);
    expect(requested.some((url) => url.endsWith("misleading.pmtiles"))).toBe(false);
    expect(requested.some((url) => url.includes("private.bin"))).toBe(false);
    expect(fixture.requests.filter((request) => request.range).length).toBe(8);
    expect(result.statistics.probeBytesRead).toBeGreaterThan(0);
  });

  it("requires an honored suffix range and structural GeoParquet footer before emitting a locator", async () => {
    const item = JSON.stringify({
      type: "Feature",
      stac_version: "1.1.0",
      id: "range-item",
      geometry: null,
      bbox: [0, 0, 1, 1],
      properties: { datetime: "2025-01-01T00:00:00Z" },
      links: [],
      assets: {
        table: {
          href: "./table.bin",
          type: "application/vnd.apache.parquet",
          roles: ["data"],
        },
      },
    });
    const parquet = geoparquetFixture();
    const discoverWith = async (assetResponse: () => Response) =>
      discoverFixture({
        endpoint: "https://catalog.test/item.json",
        fetchFn: async (input) =>
          String(input).endsWith("item.json")
            ? new Response(item, { headers: { "Content-Type": "application/geo+json" } })
            : assetResponse(),
      });

    const ignored = await discoverWith(() => new Response(parquet.buffer as ArrayBuffer, { status: 200 }));
    expect(ignored.assets[0]?.classification).toMatchObject({ state: "ambiguous", candidates: ["geoparquet"] });
    expect(ignored.assets[0]?.source).toBeUndefined();
    expect(ignored.assets[0]?.classification.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "probe-skipped", format: "geoparquet" })]),
    );

    const malformed = await discoverWith(
      () =>
        new Response(parquet.buffer as ArrayBuffer, {
          status: 206,
          headers: { "Content-Range": "not-a-byte-range" },
        }),
    );
    expect(malformed.assets[0]?.classification).toMatchObject({ state: "ambiguous", candidates: ["geoparquet"] });
    expect(malformed.assets[0]?.source).toBeUndefined();

    const substringOnly = new TextEncoder().encode(
      'PAR1\u0000geo\u0000{"version":"1.1.0","primary_column":"geometry","columns":{"geometry":{}}}\u0000PAR1',
    );
    const falsePositive = await discoverWith(
      () =>
        new Response(substringOnly.buffer as ArrayBuffer, {
          status: 206,
          headers: { "Content-Range": `bytes 0-${substringOnly.byteLength - 1}/${substringOnly.byteLength}` },
        }),
    );
    expect(falsePositive.assets[0]?.classification).toMatchObject({
      state: "ambiguous",
      candidates: ["geoparquet"],
    });
    expect(falsePositive.assets[0]?.source).toBeUndefined();
    expect(falsePositive.assets[0]?.classification.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "probe-conflict", format: "geoparquet" })]),
    );

    for (const geoMetadata of [
      { version: "1.1.0", primary_column: "geometry", columns: { geometry: {} } },
      {
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "made-up", geometry_types: [] } },
      },
      {
        version: "1.1.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "WKB", geometry_types: ["Point", "Point"] } },
      },
      {
        version: "1.0.0",
        primary_column: "geometry",
        columns: { geometry: { encoding: "point", geometry_types: ["Point"] } },
      },
    ]) {
      const mereGeoObject = geoparquetFixture(geoMetadata);
      const rejectedProfile = await discoverWith(
        () =>
          new Response(mereGeoObject.buffer as ArrayBuffer, {
            status: 206,
            headers: { "Content-Range": `bytes 0-${mereGeoObject.byteLength - 1}/${mereGeoObject.byteLength}` },
          }),
      );
      expect(rejectedProfile.assets[0]?.classification).toMatchObject({
        state: "ambiguous",
        candidates: ["geoparquet"],
      });
      expect(rejectedProfile.assets[0]?.source).toBeUndefined();
      expect(rejectedProfile.assets[0]?.classification.evidence).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "probe-conflict", format: "geoparquet" })]),
      );
    }
  });

  it("returns metadata-only ambiguity when probes are disabled", async () => {
    const fixture = await fixtureFetch();
    const result = await discoverFixture({ endpoint: BASE_URL, fetchFn: fixture.fetchFn, probeAssets: false });
    const assets = Object.fromEntries(result.assets.map((asset) => [asset.key, asset]));

    expect(assets.pmtiles?.classification).toMatchObject({
      state: "classified",
      format: "pmtiles",
      confidence: "declared",
    });
    expect(assets.geoparquet?.classification).toMatchObject({ state: "ambiguous", candidates: ["geoparquet"] });
    expect(fixture.requests.some((request) => request.range)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === "asset-probe-skipped")).toBe(true);
  });

  it("bounds loops, documents, depth, and response bytes deterministically", async () => {
    const fixture = await fixtureFetch();
    const depthBounded = await discoverFixture({
      endpoint: BASE_URL,
      fetchFn: fixture.fetchFn,
      probeAssets: false,
      limits: { maxDocuments: 128, maxDepth: 0, maxAssets: 1, maxLinksPerDocument: 2 },
    });
    expect(depthBounded.documents).toHaveLength(1);
    expect(depthBounded.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["link-limit", "depth-limit"]),
    );
    expect(fixture.requests).toHaveLength(1);

    const documentsFixture = await fixtureFetch();
    const documentBounded = await discoverFixture({
      endpoint: BASE_URL,
      fetchFn: documentsFixture.fetchFn,
      probeAssets: false,
      limits: { maxDocuments: 2 },
    });
    expect(documentBounded.documents).toHaveLength(2);
    expect(documentBounded.diagnostics.some((entry) => entry.code === "document-limit")).toBe(true);

    const assetsFixture = await fixtureFetch();
    const assetBounded = await discoverFixture({
      endpoint: BASE_URL,
      fetchFn: assetsFixture.fetchFn,
      probeAssets: false,
      limits: { maxAssets: 1 },
    });
    expect(assetBounded.assets).toHaveLength(1);
    expect(assetBounded.diagnostics.some((entry) => entry.code === "asset-limit")).toBe(true);

    await expect(
      discoverFixture({
        endpoint: "https://catalog.test/oversized.json",
        fetchFn: async () => new Response(JSON.stringify({ type: "Catalog", padding: "x".repeat(2_000) })),
        limits: { maxJsonBytes: 128 },
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });
  });

  it("follows same-origin redirects but refuses cross-origin replay of credentials", async () => {
    const requests: Array<{
      readonly url: string;
      readonly authorization: string | null;
      readonly callerContext: string | null;
    }> = [];
    const item = JSON.stringify({
      type: "Feature",
      stac_version: "1.1.0",
      id: "redirected-item",
      geometry: null,
      bbox: [0, 0, 1, 1],
      properties: { datetime: "2025-01-01T00:00:00Z" },
      links: [],
      assets: {},
    });
    const sameOrigin: StacDiscoveryFetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        authorization: headers.get("authorization"),
        callerContext: headers.get("x-caller-context"),
      });
      return url.endsWith("root.json")
        ? new Response(null, { status: 302, headers: { Location: "./item.json" } })
        : new Response(item, { headers: { "Content-Type": "application/geo+json" } });
    };
    const result = await discoverFixture({
      endpoint: "https://catalog.test/root.json",
      fetchFn: sameOrigin,
      headers: { Authorization: "Bearer never-retained", "X-Caller-Context": "root-only" },
    });
    expect(result.root.id).toBe("redirected-item");
    expect(requests).toEqual([
      {
        url: "https://catalog.test/root.json",
        authorization: "Bearer never-retained",
        callerContext: "root-only",
      },
      {
        url: "https://catalog.test/item.json",
        authorization: "Bearer never-retained",
        callerContext: "root-only",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("never-retained");

    const hostile = vi.fn<StacDiscoveryFetch>(
      async () => new Response(null, { status: 302, headers: { Location: "https://attacker.test/steal" } }),
    );
    await expect(
      discoverFixture({
        endpoint: "https://catalog.test/root.json",
        fetchFn: hostile,
        headers: { Authorization: "Bearer never-replayed" },
      }),
    ).rejects.toBeInstanceOf(HonuaNetworkError);
    expect(hostile).toHaveBeenCalledOnce();

    const crossOriginRequests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const allowedCrossOrigin: StacDiscoveryFetch = async (input, init) => {
      const url = String(input);
      crossOriginRequests.push({ url, headers: new Headers(init?.headers) });
      return url.includes("catalog.test")
        ? new Response(null, { status: 302, headers: { Location: "https://metadata.test/item.json" } })
        : new Response(item, { headers: { "Content-Type": "application/geo+json" } });
    };
    await discoverFixture({
      endpoint: "https://catalog.test/root.json",
      fetchFn: allowedCrossOrigin,
      allowedOrigins: ["https://metadata.test"],
      headers: { Authorization: "Bearer root-only", "X-Caller-Context": "root-only" },
    });
    expect(crossOriginRequests).toHaveLength(2);
    expect(crossOriginRequests[1]?.headers.get("authorization")).toBeNull();
    expect(crossOriginRequests[1]?.headers.get("x-caller-context")).toBeNull();
  });

  it("propagates caller cancellation and distinguishes request deadlines", async () => {
    const hangingFetch: StacDiscoveryFetch = async () => new Promise<Response>(() => undefined);
    const controller = new AbortController();
    const cancelled = discoverFixture({
      endpoint: BASE_URL,
      fetchFn: hangingFetch,
      signal: controller.signal,
      limits: { requestTimeoutMs: 1_000 },
    });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(HonuaAbortError);

    await expect(
      discoverFixture({
        endpoint: BASE_URL,
        fetchFn: hangingFetch,
        limits: { requestTimeoutMs: 5 },
      }),
    ).rejects.toBeInstanceOf(HonuaTimeoutError);

    const hangingBody: StacDiscoveryFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Intentionally leave the body open until the request deadline.
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    await expect(
      discoverFixture({
        endpoint: BASE_URL,
        fetchFn: hangingBody,
        limits: { requestTimeoutMs: 5 },
      }),
    ).rejects.toBeInstanceOf(HonuaTimeoutError);

    const uncancellableBody: StacDiscoveryFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: () => new Promise<void>(() => undefined),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    await expect(
      discoverFixture({
        endpoint: BASE_URL,
        fetchFn: uncancellableBody,
        limits: { requestTimeoutMs: 5 },
      }),
    ).rejects.toBeInstanceOf(HonuaTimeoutError);
  });

  it("rejects credential-bearing roots and structurally hostile JSON", async () => {
    await expect(
      discoverFixture({ endpoint: "https://user:password@catalog.test/root.json", fetchFn: vi.fn() }),
    ).rejects.toBeInstanceOf(HonuaDiscoveryError);
    await expect(
      discoverFixture({ endpoint: "https://catalog.test/root.json?token=secret", fetchFn: vi.fn() }),
    ).rejects.toBeInstanceOf(HonuaDiscoveryError);
    await expect(
      discoverFixture({
        endpoint: "https://catalog.test/root.json",
        fetchFn: async () =>
          new Response('{"type":"Catalog","stac_version":"1.1.0","id":"root","links":[],"__proto__":{}}', {
            headers: { "Content-Type": "application/json" },
          }),
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });
  });
});

interface FixtureRequest {
  readonly url: string;
  readonly range: string | null;
}

async function fixtureFetch(): Promise<{ readonly fetchFn: StacDiscoveryFetch; readonly requests: FixtureRequest[] }> {
  const documents = new Map<string, string>();
  for (const relative of [
    "catalog.json",
    "loop.json",
    "collections/imagery.json",
    "items/item-a.json",
    "items/item-b.json",
  ]) {
    documents.set(`/stac/${relative}`, await readFile(path.join(FIXTURE_ROOT, relative), "utf8"));
  }
  const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, ...new Array(28).fill(0)]);
  const pmtiles = Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 0x03, ...new Array(24).fill(0)]);
  const geoparquet = geoparquetFixture();
  const tilejson = JSON.stringify({
    tilejson: "3.0.0",
    tiles: ["https://catalog.test/stac/tiles/{z}/{x}/{y}"],
    vector_layers: [{ id: "places", fields: {} }],
  });
  const requests: FixtureRequest[] = [];
  const fetchFn: StacDiscoveryFetch = async (input, init) => {
    const url = new URL(String(input));
    const range = new Headers(init?.headers).get("range");
    requests.push({ url: url.toString(), range });
    const document = documents.get(url.pathname);
    if (document) {
      return new Response(document, {
        headers: {
          "Content-Type": url.pathname.includes("/items/") ? "application/geo+json" : "application/json",
          ETag: `"${path.basename(url.pathname)}-v1"`,
        },
      });
    }
    const body =
      url.pathname.endsWith("/assets/cog.bin") ||
      url.pathname.endsWith("/assets/generic-tiff.bin") ||
      url.pathname.endsWith("/assets/not-pmtiles.bin")
        ? tiff
        : url.pathname.endsWith("/assets/places.bin")
          ? geoparquet
          : url.pathname.endsWith("/assets/vector.json")
            ? tilejson
            : url.pathname.endsWith("/assets/basemap.bin") || url.pathname.endsWith("/assets/secondary.bin")
              ? pmtiles
              : undefined;
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(typeof body === "string" ? body : (body.buffer as ArrayBuffer), {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": typeof body === "string" ? "application/json" : "application/octet-stream",
        ...(range && typeof body !== "string"
          ? { "Content-Range": `bytes 0-${body.byteLength - 1}/${body.byteLength}` }
          : {}),
      },
    });
  };
  return { fetchFn, requests };
}

function geoparquetFixture(
  geoMetadata: unknown = {
    version: "1.1.0",
    primary_column: "geometry",
    columns: { geometry: { encoding: "WKB", geometry_types: [], crs: null } },
  },
): Uint8Array {
  const geo = JSON.stringify(geoMetadata);
  const schemaElement = bytes(0x48, ...compactString("schema"), 0x15, 0x00, 0x00);
  const keyValue = bytes(0x18, ...compactString("geo"), 0x18, ...compactString(geo), 0x00);
  const metadata = bytes(
    0x15,
    0x02,
    0x19,
    0x1c,
    ...schemaElement,
    0x16,
    0x00,
    0x19,
    0x0c,
    0x19,
    0x1c,
    ...keyValue,
    0x00,
  );
  const footerLength = new Uint8Array(4);
  new DataView(footerLength.buffer).setUint32(0, metadata.byteLength, true);
  return bytes(...new TextEncoder().encode("PAR1"), ...metadata, ...footerLength, ...new TextEncoder().encode("PAR1"));
}

function compactString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return bytes(...unsignedVarint(encoded.byteLength), ...encoded);
}

function unsignedVarint(value: number): Uint8Array {
  const encoded: number[] = [];
  let remaining = value;
  do {
    const next = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    encoded.push(remaining > 0 ? next | 0x80 : next);
  } while (remaining > 0);
  return Uint8Array.from(encoded);
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}
