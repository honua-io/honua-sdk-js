import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  type ConnectDiscoveryCache,
  type ConnectDiscoverySnapshot,
  type StacAssetCandidate,
  connect,
} from "../src/connect.js";
import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "../src/contract/index.js";
import { HonuaAbortError } from "../src/core/errors.js";
import { geoparquetResolver } from "../src/geoparquet/index.js";

const catalog = fixture("catalog.json");
const collection = fixture("collection.json");
const item = fixture("item.json");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/stac-static/${name}`, import.meta.url), "utf8")) as unknown;
}

function json(value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function staticFetch(requests: Request[] = []): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (request.method === "HEAD") {
      const contentType =
        url.pathname === "/assets/image.tif"
          ? "image/tiff; application=geotiff; profile=cloud-optimized"
          : url.pathname === "/assets/table.parquet"
            ? "application/vnd.apache.parquet"
            : url.pathname.startsWith("/tiles/")
              ? "application/vnd.mapbox-vector-tile"
              : url.pathname === "/assets/metadata.json"
                ? "application/json"
                : url.pathname === "/assets/regular.tif"
                  ? "image/tiff; application=geotiff"
                  : url.pathname === "/assets/mislabelled.tif"
                    ? "application/vnd.pmtiles"
                    : url.pathname === "/assets/archive.zip"
                      ? "application/zip"
                      : "application/octet-stream";
      return new Response(null, { status: 200, headers: { "Content-Type": contentType } });
    }
    if (url.pathname === "/catalog.json") return json(catalog, { ETag: '"catalog-v1"' });
    if (url.pathname === "/collection.json") return json(collection, { ETag: '"collection-v1"' });
    if (url.pathname === "/item.json") return json(item, { ETag: '"item-v1"' });
    return new Response("not found", { status: 404 });
  });
}

function byKey(candidates: readonly StacAssetCandidate[], key: string): StacAssetCandidate {
  const candidate = candidates.find((entry) => entry.assetKey === key);
  if (!candidate) throw new Error(`missing candidate ${key}`);
  return candidate;
}

describe("connect static STAC discovery", () => {
  it("walks a bounded relative tree, classifies assets from evidence, and skips hostile traversal links", async () => {
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://static.example/catalog.json",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: staticFetch(requests) },
    });

    expect(connection.inspection.protocol).toBe("stac");
    expect(connection.source().descriptor).toMatchObject({
      id: "oahu-root",
      protocol: "stac",
      locator: { url: "https://static.example/catalog.json", layout: "stac-static" },
    });
    expect([...connection.source().capabilities]).toEqual(["query", "queryObjectIds", "stream"]);

    const inspection = connection.inspection.stacStatic;
    expect(inspection?.root).toMatchObject({ type: "catalog", id: "oahu-root", validator: '"catalog-v1"' });
    expect(inspection?.documents.map((document) => document.id)).toEqual([
      "oahu-root",
      "oahu-observations",
      "observation-001",
    ]);
    expect(inspection?.treeFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(inspection?.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["cross-origin-link-skipped", "unsafe-link-skipped", "non-json-link-skipped"]),
    );

    const candidates = inspection?.assetCandidates ?? [];
    const cog = byKey(candidates, "cog");
    expect(cog).toMatchObject({
      state: "classified",
      kind: "cog",
      confidence: "high",
    });
    expect(cog.source).toBeUndefined();
    expect(byKey(candidates, "geoparquet")).toMatchObject({
      state: "classified",
      kind: "geoparquet",
      source: {
        protocol: "geoparquet",
        locator: { url: "https://static.example/assets/table.parquet", geoparquet: { geometryColumn: "geometry" } },
      },
      metadata: {
        crs: ["EPSG:4326"],
        license: "CC-BY-4.0",
        attribution: "Honua fixture program",
        datetime: "2026-04-12T21:19:01Z",
      },
    });
    expect(byKey(candidates, "pmtiles")).toMatchObject({
      state: "classified",
      kind: "pmtiles",
      confidence: "medium",
      href: "https://cdn.example/basemap.pmtiles",
      source: { protocol: "pmtiles", locator: { url: "https://cdn.example/basemap.pmtiles" } },
    });
    expect(byKey(candidates, "vector-tiles")).toMatchObject({
      state: "classified",
      kind: "tile",
      source: {
        protocol: "maplibre-vector",
        locator: { url: "https://static.example/tiles/{z}/{x}/{y}.pbf" },
      },
    });
    expect(byKey(candidates, "metadata")).toMatchObject({ state: "classified", kind: "metadata" });
    const regularGeotiff = byKey(candidates, "regular-geotiff");
    expect(regularGeotiff).toMatchObject({
      state: "ambiguous",
    });
    expect(regularGeotiff.kind).toBeUndefined();
    expect(regularGeotiff.source).toBeUndefined();
    const mislabelled = byKey(candidates, "mislabelled");
    expect(mislabelled).toMatchObject({
      state: "ambiguous",
    });
    expect(mislabelled.kind).toBeUndefined();
    expect(mislabelled.source).toBeUndefined();
    const unsupported = byKey(candidates, "unsupported");
    expect(unsupported.state).toBe("unsupported");
    expect(unsupported.source).toBeUndefined();
    const suffixOnly = byKey(candidates, "suffix-only");
    expect(suffixOnly).toMatchObject({
      state: "ambiguous",
    });
    expect(suffixOnly.kind).toBeUndefined();
    expect(suffixOnly.mediaType).toBeUndefined();
    expect(suffixOnly.source).toBeUndefined();
    const unsafeSigned = byKey(candidates, "unsafe-signed");
    expect(unsafeSigned).toMatchObject({
      state: "unsupported",
      kind: "pmtiles",
    });
    expect(unsafeSigned.href).toBeUndefined();
    expect(unsafeSigned.source).toBeUndefined();

    const requestedOrigins = requests.map((request) => new URL(request.url).origin);
    expect(requestedOrigins).not.toContain("https://attacker.example");
    expect(requestedOrigins).not.toContain("https://cdn.example");
    expect(requests.some((request) => request.url.includes("token="))).toBe(false);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(3);
    expect(requests.filter((request) => request.method === "HEAD")).toHaveLength(8);
  });

  it("projects PMTiles and GeoParquet candidates through their existing Source resolvers", async () => {
    const connection = await connect({
      endpoint: "https://static.example/catalog.json",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: staticFetch() },
    });
    const candidates = connection.inspection.stacStatic?.assetCandidates ?? [];
    const pmtiles = byKey(candidates, "pmtiles").source!;
    const geoparquet = byKey(candidates, "geoparquet").source!;
    const resolver = geoparquetResolver();
    try {
      const dataset = createDataset({
        id: "classified-assets",
        client: connection.dataset.client,
        resolveSource: resolver,
        sources: [
          {
            id: "basemap",
            protocol: pmtiles.protocol,
            locator: pmtiles.locator,
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[pmtiles.protocol],
          },
          {
            id: "observations",
            protocol: geoparquet.protocol,
            locator: geoparquet.locator,
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[geoparquet.protocol],
          },
        ],
        skipCompatibilityCheck: true,
      });
      expect(dataset.source("basemap")?.descriptor.protocol).toBe("pmtiles");
      expect(dataset.source("observations")?.descriptor.locator.geoparquet?.geometryColumn).toBe("geometry");
    } finally {
      await resolver.dispose();
    }
  });

  it("starts from an Item and follows only its Collection metadata without expanding the collection tree", async () => {
    const requests: Request[] = [];
    const connection = await connect({
      endpoint: "https://static.example/item.json",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: staticFetch(requests) },
    });

    expect(connection.inspection.stacStatic?.documents.map((document) => document.id)).toEqual([
      "observation-001",
      "oahu-observations",
    ]);
    expect(connection.source().descriptor.locator).toMatchObject({
      url: "https://static.example/item.json",
      layout: "stac-static",
      collectionId: "oahu-observations",
    });
    expect(
      requests.filter((request) => request.method === "GET").map((request) => new URL(request.url).pathname),
    ).toEqual(["/item.json", "/collection.json"]);
  });

  it("selects an explicitly requested static Collection from the bounded tree", async () => {
    const connection = await connect({
      endpoint: "https://static.example/catalog.json",
      protocol: "stac",
      collectionId: "oahu-observations",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: staticFetch() },
    });

    expect(connection.dataset.sourceIds()).toEqual(["oahu-observations"]);
    expect(connection.source().descriptor).toMatchObject({
      id: "oahu-observations",
      locator: { collectionId: "oahu-observations", layout: "stac-static" },
    });
  });

  it("gives conformsTo precedence when an API landing page also looks like a Catalog", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/api") {
        return json({
          stac_version: "1.0.0",
          type: "Catalog",
          id: "api-root",
          description: "API landing",
          conformsTo: ["https://api.stacspec.org/v1.0.0/core"],
          links: [{ rel: "data", href: "./collections" }],
        });
      }
      return json({ collections: [{ id: "imagery" }] });
    });
    const connection = await connect({
      endpoint: "https://static.example/api",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(requests).toEqual(["/api", "/api/collections"]);
    expect(connection.inspection.stacStatic).toBeUndefined();
    expect(connection.source().descriptor.locator.layout).toBe("stac-api");
  });

  it("rejects an oversized root while treating an oversized linked object as a structured skip", async () => {
    await expect(
      connect({
        endpoint: "https://static.example/catalog.json",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        stac: { maxDocumentBytes: 64 },
        clientOptions: { fetchFn: staticFetch() },
      }),
    ).rejects.toThrow(/64-byte limit/);

    const smallRoot = {
      stac_version: "1.1.0",
      type: "Catalog",
      id: "small",
      description: "small",
      links: [{ rel: "child", href: "./large.json", type: "application/json" }],
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/small.json") return json(smallRoot);
      return json({ ...smallRoot, id: "large", description: "x".repeat(2048), links: [] });
    });
    const connection = await connect({
      endpoint: "https://static.example/small.json",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      stac: { maxDocumentBytes: 512 },
      clientOptions: { fetchFn },
    });
    expect(connection.inspection.stacStatic?.documents).toHaveLength(1);
    expect(connection.inspection.stacStatic?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "linked-document-unavailable" }),
    );
  });

  it("round-trips a linked-document diagnostic through caller cache", async () => {
    const root = {
      stac_version: "1.1.0",
      type: "Catalog",
      id: "diagnostic-root",
      description: "small",
      links: [{ rel: "child", href: "./large.json", type: "application/json" }],
    };
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache: ConnectDiscoveryCache = {
      get: (identity) => values.get(identity.key),
      set: (identity, snapshot) => {
        values.set(identity.key, snapshot);
      },
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.pathname === "/root.json"
        ? json(root)
        : json({ ...root, id: "large", description: "x".repeat(2048), links: [] });
    });
    const options = {
      endpoint: "https://static.example/root.json",
      protocol: "stac" as const,
      authorizationScopeFingerprint: "anonymous",
      stac: { maxDocumentBytes: 512 },
      cache,
    };

    const first = await connect({ ...options, clientOptions: { fetchFn } });
    const second = await connect({
      ...options,
      clientOptions: { fetchFn: vi.fn(async () => new Response("must not fetch", { status: 500 })) },
    });

    expect(first.inspection.stacStatic?.diagnostics[0]).toMatchObject({
      code: "linked-document-unavailable",
      documentUrl: "https://static.example/root.json",
    });
    expect(second.inspection.cacheStatus).toBe("hit");
    expect(second.inspection.stacStatic?.diagnostics).toEqual(first.inspection.stacStatic?.diagnostics);
  });

  it("records the canonical root and collapses duplicate linked document aliases", async () => {
    const root = {
      stac_version: "1.1.0",
      type: "Catalog",
      id: "canonical-root",
      description: "canonical",
      links: [
        { rel: "child", href: "./child.json", type: "application/json" },
        { rel: "child", href: "https://static.example/catalog/child.json", type: "application/json" },
      ],
    };
    const child = {
      stac_version: "1.1.0",
      type: "Collection",
      id: "one-child",
      description: "one object behind duplicate aliases",
      license: "proprietary",
      extent: {
        spatial: { bbox: [[-180, -90, 180, 90]] },
        temporal: { interval: [[null, null]] },
      },
      links: [],
    };
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/catalog/root.json") return json(root);
      if (url.pathname === "/catalog/child.json") return json(child);
      return new Response("not found", { status: 404 });
    });

    const connection = await connect({
      endpoint: "https://static.example/catalog/root.json",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.inspection.stacStatic).toMatchObject({
      rootRequestUrl: "https://static.example/catalog/root.json",
      root: { url: "https://static.example/catalog/root.json" },
    });
    expect(connection.inspection.stacStatic?.documents.map((document) => document.id)).toEqual([
      "canonical-root",
      "one-child",
    ]);
    expect(requests).toEqual(["/catalog/root.json", "/catalog/child.json"]);
  });

  it("fails closed for a browser-shaped opaque redirect response", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect);
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "type", { configurable: true, value: "opaqueredirect" });
      return response;
    });

    await expect(
      connect({
        endpoint: "https://static.example/catalog.json",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn, retry: { maxRetries: 0 } },
      }),
    ).rejects.toThrow(/Redirects are not allowed for this bounded request/);
    expect(redirects).toEqual(["error"]);
  });

  it("cancels during linked traversal and never returns a partial tree", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/catalog.json") return json(catalog);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(
      connect({
        endpoint: "https://static.example/catalog.json",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        signal: controller.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
  });

  it("round-trips the validator-bound tree cache and rejects a forged tree fingerprint", async () => {
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache: ConnectDiscoveryCache = {
      get: (identity) => values.get(identity.key),
      set: (identity, snapshot) => {
        values.set(identity.key, snapshot);
      },
    };
    const base = {
      endpoint: "https://static.example/catalog.json",
      protocol: "stac" as const,
      authorizationScopeFingerprint: "anonymous",
      cache,
    };
    const first = await connect({ ...base, clientOptions: { fetchFn: staticFetch() } });
    const second = await connect({
      ...base,
      clientOptions: { fetchFn: vi.fn(async () => new Response("must not fetch", { status: 500 })) },
    });
    expect(first.inspection.cacheStatus).toBe("miss");
    expect(second.inspection.cacheStatus).toBe("hit");
    expect(second.inspection.stacStatic?.assetCandidates).toEqual(first.inspection.stacStatic?.assetCandidates);

    const [key, snapshot] = [...values.entries()][0]!;
    const redundantRoot = structuredClone(snapshot) as ConnectDiscoverySnapshot;
    const mutableInspection = redundantRoot.stacStatic as unknown as {
      root: Record<string, unknown>;
    };
    mutableInspection.root = { ...mutableInspection.root, title: "forged redundant title" };
    values.set(key, redundantRoot);
    const canonicalized = await connect({
      ...base,
      clientOptions: { fetchFn: vi.fn(async () => new Response("must not fetch", { status: 500 })) },
    });
    expect(canonicalized.inspection.stacStatic?.root.title).not.toBe("forged redundant title");

    const forged = structuredClone(snapshot) as ConnectDiscoverySnapshot & {
      stacStatic: { treeFingerprint: string };
    };
    (forged.stacStatic as { treeFingerprint: string }).treeFingerprint = `sha256:${"0".repeat(64)}`;
    values.set(key, forged);
    await expect(
      connect({
        ...base,
        clientOptions: { fetchFn: vi.fn(async () => new Response("must not fetch", { status: 500 })) },
      }),
    ).rejects.toMatchObject({ code: "invalid-discovery-cache" });

    const forgedCandidate = structuredClone(snapshot) as ConnectDiscoverySnapshot & {
      stacStatic: { assetCandidates: Array<{ id: string; href?: string }> };
    };
    forgedCandidate.stacStatic.assetCandidates[0]!.id = "forged-id";
    values.set(key, forgedCandidate);
    await expect(
      connect({
        ...base,
        clientOptions: { fetchFn: vi.fn(async () => new Response("must not fetch", { status: 500 })) },
      }),
    ).rejects.toMatchObject({ code: "invalid-discovery-cache" });

    const forgedBinding = structuredClone(snapshot) as ConnectDiscoverySnapshot & {
      stacStatic: { assetCandidates: Array<{ href?: string }> };
    };
    const mutableBinding = forgedBinding.stacStatic.assetCandidates.find((candidate) => candidate.href) as {
      href?: string;
    };
    mutableBinding.href = "https://static.example/assets/other.pmtiles";
    values.set(key, forgedBinding);
    await expect(
      connect({
        ...base,
        clientOptions: { fetchFn: vi.fn(async () => new Response("must not fetch", { status: 500 })) },
      }),
    ).rejects.toMatchObject({ code: "invalid-discovery-cache" });
  });

  it("partitions cache identity by the bounded traversal policy", async () => {
    const keys: string[] = [];
    const cache: ConnectDiscoveryCache = {
      get: (identity) => {
        keys.push(identity.key);
        return undefined;
      },
      set: () => undefined,
    };
    for (const maxAssetProbes of [0, 1]) {
      await connect({
        endpoint: "https://static.example/catalog.json",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        stac: { maxAssetProbes },
        cache,
        clientOptions: { fetchFn: staticFetch() },
      });
    }
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
