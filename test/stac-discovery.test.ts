import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { HonuaAbortError, HonuaDiscoveryError, HonuaNetworkError, HonuaTimeoutError } from "../src/core/errors.js";
import { discoverStaticStac } from "../src/stac-discovery.js";
import type { StacDiscoveryFetch } from "../src/stac-discovery.js";

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stac-discovery");
const BASE_URL = "https://catalog.test/stac/catalog.json";

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

  it("classifies from declared evidence and bounded probes without using file extensions", async () => {
    const fixture = await fixtureFetch();
    const result = await discoverStaticStac({ endpoint: BASE_URL, fetchFn: fixture.fetchFn });
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
      source: { protocol: "maplibre-vector" },
    });
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
    expect(fixture.requests.filter((request) => request.range).length).toBe(7);
    expect(result.statistics.probeBytesRead).toBeGreaterThan(0);
  });

  it("returns metadata-only ambiguity when probes are disabled", async () => {
    const fixture = await fixtureFetch();
    const result = await discoverStaticStac({ endpoint: BASE_URL, fetchFn: fixture.fetchFn, probeAssets: false });
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
    const bounded = await discoverStaticStac({
      endpoint: BASE_URL,
      fetchFn: fixture.fetchFn,
      probeAssets: false,
      limits: { maxDocuments: 1, maxDepth: 0, maxAssets: 1, maxLinksPerDocument: 2 },
    });
    expect(bounded.documents).toHaveLength(1);
    expect(bounded.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["link-limit", "depth-limit"]),
    );
    expect(fixture.requests).toHaveLength(1);

    await expect(
      discoverStaticStac({
        endpoint: "https://catalog.test/oversized.json",
        fetchFn: async () => new Response(JSON.stringify({ type: "Catalog", padding: "x".repeat(2_000) })),
        limits: { maxJsonBytes: 128 },
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });
  });

  it("follows same-origin redirects but refuses cross-origin replay of credentials", async () => {
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
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
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return url.endsWith("root.json")
        ? new Response(null, { status: 302, headers: { Location: "./item.json" } })
        : new Response(item, { headers: { "Content-Type": "application/geo+json" } });
    };
    const result = await discoverStaticStac({
      endpoint: "https://catalog.test/root.json",
      fetchFn: sameOrigin,
      headers: { Authorization: "Bearer never-retained" },
    });
    expect(result.root.id).toBe("redirected-item");
    expect(requests).toEqual([
      { url: "https://catalog.test/root.json", authorization: "Bearer never-retained" },
      { url: "https://catalog.test/item.json", authorization: "Bearer never-retained" },
    ]);
    expect(JSON.stringify(result)).not.toContain("never-retained");

    const hostile = vi.fn<StacDiscoveryFetch>(
      async () => new Response(null, { status: 302, headers: { Location: "https://attacker.test/steal" } }),
    );
    await expect(
      discoverStaticStac({
        endpoint: "https://catalog.test/root.json",
        fetchFn: hostile,
        headers: { Authorization: "Bearer never-replayed" },
      }),
    ).rejects.toBeInstanceOf(HonuaNetworkError);
    expect(hostile).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation and distinguishes request deadlines", async () => {
    const hangingFetch: StacDiscoveryFetch = async () => new Promise<Response>(() => undefined);
    const controller = new AbortController();
    const cancelled = discoverStaticStac({
      endpoint: BASE_URL,
      fetchFn: hangingFetch,
      signal: controller.signal,
      limits: { requestTimeoutMs: 1_000 },
    });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(HonuaAbortError);

    await expect(
      discoverStaticStac({
        endpoint: BASE_URL,
        fetchFn: hangingFetch,
        limits: { requestTimeoutMs: 5 },
      }),
    ).rejects.toBeInstanceOf(HonuaTimeoutError);
  });

  it("rejects credential-bearing roots and structurally hostile JSON", async () => {
    await expect(
      discoverStaticStac({ endpoint: "https://user:password@catalog.test/root.json", fetchFn: vi.fn() }),
    ).rejects.toBeInstanceOf(HonuaDiscoveryError);
    await expect(
      discoverStaticStac({ endpoint: "https://catalog.test/root.json?token=secret", fetchFn: vi.fn() }),
    ).rejects.toBeInstanceOf(HonuaDiscoveryError);
    await expect(
      discoverStaticStac({
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
  const geoparquet = new TextEncoder().encode(
    'PAR1\u0000geo\u0000{"version":"1.1.0","primary_column":"geometry","columns":{}}\u0000PAR1',
  );
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
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { "Content-Type": typeof body === "string" ? "application/json" : "application/octet-stream" },
    });
  };
  return { fetchFn, requests };
}
