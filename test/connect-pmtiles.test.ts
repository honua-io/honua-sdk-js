import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import type { ConnectDiscoveryCache, ConnectDiscoverySnapshot, ConnectOptions } from "../src/connect.js";
import { connect } from "../src/connect.js";
import { serializeHonuaError } from "../src/core/error-envelope.js";
import {
  HonuaAbortError,
  HonuaCapabilityNotSupportedError,
  HonuaDiscoveryError,
  HonuaTimeoutError,
} from "../src/core/errors.js";
import { inspectPmtilesArchive } from "../src/pmtiles/index.js";

const ASSET_URL = "https://assets.example.test/maps/basemap.pmtiles";
const ETAG = '"pmtiles-fixture-v1"';

function fixtureAsset(name = "sample-vector.pmtiles"): Uint8Array {
  const fixture = readFileSync(fileURLToPath(new URL(`./fixtures/pmtiles/${name}`, import.meta.url)));
  // PMTiles asks for a 16 KiB header/root range. Keep the virtual archive larger
  // than that request so the connect() lane proves it never downloads the whole
  // asset while retaining the committed fixture's valid header/metadata bytes.
  const asset = new Uint8Array(64 * 1024);
  asset.set(fixture);
  return asset;
}

function rangeFetch(asset = fixtureAsset()) {
  const calls: Array<{
    url: string;
    range: string | null;
    authorization: string | null;
    cache?: RequestCache;
    signal?: AbortSignal;
  }> = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("range");
    calls.push({
      url: input.toString(),
      range,
      authorization: headers.get("authorization"),
      ...(init?.cache ? { cache: init.cache } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!match) return new Response("missing range", { status: 400 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = asset.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": "application/vnd.pmtiles",
        "Content-Length": String(body.byteLength),
        "Content-Range": `bytes ${start}-${end}/${asset.byteLength}`,
        ETag: ETAG,
      },
    });
  });
  return { fetchFn, calls };
}

interface ControlledRangeCall {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly init: RequestInit | undefined;
}

function controlledRangeFetch(
  asset: Uint8Array,
  control: (call: ControlledRangeCall) => {
    readonly status?: number;
    readonly headers?: HeadersInit;
    readonly body?: BodyInit | null;
  },
) {
  const calls: ControlledRangeCall[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range") ?? "");
    if (!match) return new Response("missing range", { status: 400 });
    const call = {
      index: calls.length,
      start: Number(match[1]),
      end: Number(match[2]),
      init,
    };
    calls.push(call);
    const configured = control(call);
    const body = configured.body === undefined ? asset.slice(call.start, call.end + 1) : configured.body;
    const headers = new Headers({
      "Content-Length": String(call.end - call.start + 1),
      "Content-Range": `bytes ${call.start}-${call.end}/${asset.byteLength}`,
      ...Object.fromEntries(new Headers(configured.headers)),
    });
    return new Response(body, { status: configured.status ?? 206, headers });
  });
  return { fetchFn, calls };
}

function setUint64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true);
}

function fixtureWithMetadataAt(metadataOffset: number, totalBytes = 64 * 1024): Uint8Array {
  const fixture = fixtureAsset();
  const metadata = fixture.slice(152, 352);
  const asset = new Uint8Array(totalBytes);
  asset.set(fixture.slice(0, 152));
  asset.set(metadata, metadataOffset);
  const view = new DataView(asset.buffer);
  setUint64(view, 24, metadataOffset);
  setUint64(view, 32, metadata.byteLength);
  return asset;
}

function fixtureWithMetadataJson(value: unknown, totalBytes = 64 * 1024): Uint8Array {
  const fixture = fixtureAsset();
  const compressed = gzipSync(JSON.stringify(value));
  const asset = new Uint8Array(totalBytes);
  asset.set(fixture.slice(0, 152));
  asset.set(compressed, 152);
  const view = new DataView(asset.buffer);
  setUint64(view, 24, 152);
  setUint64(view, 32, compressed.byteLength);
  return asset;
}

function vectorLayerMetadata(layerCount: number, fieldsPerLayer: number) {
  const fields = Object.fromEntries(Array.from({ length: fieldsPerLayer }, (_, index) => [`f${index}`, "String"]));
  return {
    vector_layers: Array.from({ length: layerCount }, (_, index) => ({
      id: `layer-${index}`,
      fields,
    })),
  };
}

async function settleWithin<T>(pending: Promise<T>, maximumMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not settle within ${maximumMs}ms.`)), maximumMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function memoryCache(): ConnectDiscoveryCache & { readonly entries: Map<string, ConnectDiscoverySnapshot> } {
  const entries = new Map<string, ConnectDiscoverySnapshot>();
  return {
    entries,
    get(identity) {
      return entries.get(identity.key);
    },
    set(identity, snapshot) {
      entries.set(identity.key, snapshot);
    },
  };
}

interface MutablePmtilesSnapshot {
  identityKey: string;
  endpoint: string;
  retrievedAt: string;
  evidence: Array<{
    kind?: string;
    capabilities?: string[];
    scope?: string[];
    provenance?: Array<{ source: string; retrievedAt?: string; validator?: string }>;
  }>;
  sources: Array<{
    title?: string;
    description?: string;
    crs?: string[];
    extent?: {
      spatial?: { bbox: number[][]; crs?: string };
      temporal?: { interval: Array<Array<string | null>>; trs?: string };
    };
    schema?: { fields?: unknown[] };
    evidence?: Array<{
      kind?: string;
      capabilities?: string[];
      scope?: string[];
      provenance?: Array<{ source: string; retrievedAt?: string; validator?: string }>;
    }>;
    metadata?: {
      crs?: string[];
      extent?: {
        spatial?: { bbox: number[][]; crs?: string };
        temporal?: { interval: Array<Array<string | null>>; trs?: string };
      };
      protocolVersion?: string;
      partialReasons?: string[];
      pmtiles?: {
        validator?: string;
        metadataJson: string;
        center: number[];
        vectorLayers: Array<{ minZoom?: number; maxZoom?: number }>;
        transfer: {
          bytesFetched: number;
          decompressedBytes: number;
          ranges: Array<{
            offset: number;
            length: number;
            bytesReceived: number;
            status: number;
            contentRange: string;
            validator?: string;
          }>;
        };
      };
    };
  }>;
}

describe("connect() / PMTiles static discovery", () => {
  it("shares cache identity, metadata, and fail-closed validation with the focused PMTiles inspector", async () => {
    const cache = memoryCache();
    const directFetch = rangeFetch();
    const connection = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-parity",
      clientOptions: { fetchFn: directFetch.fetchFn },
      cache,
    });
    const focusedFetch = vi.fn<typeof fetch>();
    const focused = await inspectPmtilesArchive({
      endpoint: ASSET_URL,
      authorizationScopeFingerprint: "tenant-parity",
      clientOptions: { fetchFn: focusedFetch },
      cache,
    });
    expect(focused.cacheStatus).toBe("hit");
    expect(focused.endpoint).toBe(connection.inspection.endpoint);
    expect(focused.metadata).toEqual(connection.inspection.sources[0]?.metadata?.pmtiles);
    expect(focusedFetch).not.toHaveBeenCalled();

    const honest = [...cache.entries.values()][0]!;
    const invalidCache = (): ConnectDiscoveryCache => ({
      get: () => {
        const snapshot = structuredClone(honest) as unknown as MutablePmtilesSnapshot;
        snapshot.sources[0]!.metadata!.pmtiles!.transfer.ranges[0]!.contentRange = "not-a-range";
        return snapshot as unknown as ConnectDiscoverySnapshot;
      },
      set: () => {
        throw new Error("invalid PMTiles cache must not be rewritten");
      },
    });
    const genericError = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-parity",
      clientOptions: { fetchFn: vi.fn() },
      cache: invalidCache(),
    }).catch((cause: unknown) => cause);
    const focusedError = await inspectPmtilesArchive({
      endpoint: ASSET_URL,
      authorizationScopeFingerprint: "tenant-parity",
      clientOptions: { fetchFn: vi.fn() },
      cache: invalidCache(),
    }).catch((cause: unknown) => cause);
    expect(genericError).toBeInstanceOf(HonuaDiscoveryError);
    if (!(genericError instanceof HonuaDiscoveryError)) throw genericError;
    expect(focusedError).toMatchObject({
      name: genericError.name,
      code: genericError.code,
      message: genericError.message,
    });
  });

  it("discovers an explicit archive through the authenticated bounded pipeline and reuses its review", async () => {
    const { fetchFn, calls } = rangeFetch();
    const controller = new AbortController();
    const connection = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      signal: controller.signal,
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: { fetchFn, bearerToken: "secret-token" },
    });

    expect(connection.inspection.protocol).toBe("pmtiles");
    expect(connection.inspection.defaultSourceId).toBe("pmtiles");
    expect(connection.inspection.cacheIdentity.endpoint).toBe(ASSET_URL);
    expect(connection.inspection.cacheIdentity.authorizationScopeDigest).toMatch(/^sha256:/);
    expect(connection.inspection.cacheIdentity.authorizationScopeDigest).not.toContain("tenant-a");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: ASSET_URL,
      range: "bytes=0-16383",
      authorization: "Bearer secret-token",
    });
    expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
    expect(calls.every((call) => call.cache === "no-store")).toBe(true);

    const inspection = connection.inspection.sources[0]!;
    expect(inspection.descriptor).toMatchObject({
      id: "pmtiles",
      protocol: "pmtiles",
      locator: { url: ASSET_URL, sourceType: "vector" },
    });
    expect([...inspection.descriptor.capabilities!]).toEqual(["tiles"]);
    expect(inspection.metadata?.pmtiles).toMatchObject({
      specVersion: 3,
      tileKind: "mvt",
      bounds: [-123.2, 37, -121.5, 38.2],
      minZoom: 0,
      maxZoom: 5,
      validator: `etag:${ETAG}`,
      transfer: {
        requests: 1,
        bytesFetched: 16_384,
        decompressedBytes: expect.any(Number),
      },
    });
    expect(inspection.metadata?.pmtiles?.vectorLayers.map((layer) => layer.id)).toEqual(["landuse", "roads"]);
    expect(inspection.metadata?.pmtiles?.transfer.decompressedBytes).toBeGreaterThan(0);
    expect(inspection.metadata?.pmtiles?.transfer.decompressedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(inspection.metadata?.pmtiles?.transfer.ranges.every((range) => range.status === 206)).toBe(true);

    const source = connection.source();
    expect(source.capabilities.has("tiles")).toBe(true);
    const archive = source.protocol("pmtiles");
    expect(archive?.url).toBe(ASSET_URL);
    await expect(archive?.describe()).resolves.toMatchObject({
      url: ASSET_URL,
      tileKind: "mvt",
      center: [-122.35, 37.6, 3],
    });
    await expect(source.query()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect(calls).toHaveLength(1);
  });

  it("preserves the complete bounded raw metadata document across live and cached adapter reuse", async () => {
    const rawMetadata = {
      name: "Island basemap",
      description: "Full archive description",
      version: "2026.07",
      attribution: "Honua test data",
      custom: { theme: "ocean", nested: [1, true, null] },
      vector_layers: [{ id: "empty-description", description: "" }],
    };
    const cache = memoryCache();
    const liveFetch = rangeFetch(fixtureWithMetadataJson(rawMetadata));
    const live = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn: liveFetch.fetchFn },
      cache,
    });

    expect(JSON.parse(live.inspection.sources[0]!.metadata!.pmtiles!.metadataJson)).toEqual(rawMetadata);
    expect(live.inspection.sources[0]!.metadata!.pmtiles!.vectorLayers).toEqual([{ id: "empty-description" }]);
    await expect(live.source().protocol("pmtiles")!.describe()).resolves.toMatchObject({
      metadata: rawMetadata,
    });

    const cachedFetch = vi.fn<typeof fetch>();
    const cached = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn: cachedFetch },
      cache,
    });
    await expect(cached.source().protocol("pmtiles")!.describe()).resolves.toMatchObject({
      metadata: rawMetadata,
      vectorLayers: [{ id: "empty-description" }],
    });
    expect(cachedFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null, undefined],
    ["string", "pmtiles-secret-token", "pmtiles-secret-token"],
    ["number", 8_675_309, "8675309"],
    ["array", [{ secret: "array-secret-token" }], "array-secret-token"],
  ])("rejects a %s raw metadata document before live or cached exposure", async (_case, rawMetadata, secret) => {
    const cache = memoryCache();
    const archiveFetch = rangeFetch(fixtureWithMetadataJson(rawMetadata));

    const error = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn: archiveFetch.fetchFn },
      cache,
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      name: "HonuaDiscoveryError",
      code: "protocol-mismatch",
      detail: { reason: "invalid-metadata" },
    });
    expect(error).toBeInstanceOf(HonuaDiscoveryError);
    const serialized = JSON.stringify(serializeHonuaError(error as HonuaDiscoveryError));
    expect(serialized).not.toContain("PMTiles archive metadata");
    if (secret !== undefined) {
      expect(serialized).not.toContain(secret);
    }
    expect(serializeHonuaError(error as HonuaDiscoveryError).cause).toEqual({ name: "SyntaxError" });
    expect(archiveFetch.calls).toHaveLength(1);
    expect(cache.entries.size).toBe(0);
  });

  it("accepts pmtiles:// as strong auto evidence and canonicalizes the cache URL", async () => {
    const { fetchFn } = rangeFetch();
    const connection = await connect({
      endpoint: `pmtiles://${ASSET_URL}`,
      protocol: "auto",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn },
    });

    expect(connection.inspection.protocol).toBe("pmtiles");
    expect(connection.inspection.endpoint).toBe(ASSET_URL);
    expect(connection.inspection.sources[0]?.descriptor.locator.url).toBe(ASSET_URL);

    const urlObjectFetch = rangeFetch();
    const urlObjectConnection = await connect({
      endpoint: new URL(`pmtiles://${ASSET_URL}`),
      protocol: "auto",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn: urlObjectFetch.fetchFn },
    });
    expect(urlObjectConnection.inspection.endpoint).toBe(ASSET_URL);
    expect(urlObjectConnection.inspection.cacheIdentity.key).toBe(connection.inspection.cacheIdentity.key);
  });

  it("does not infer PMTiles from a filename or probe alternate protocols", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "auto",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "ambiguous-protocol",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails a spoofed strong marker after one PMTiles range without fallback probing", async () => {
    const asset = new Uint8Array(64 * 1024);
    asset.set(new TextEncoder().encode("not a pmtiles archive"));
    const { fetchFn, calls } = rangeFetch(asset);
    await expect(
      connect({
        endpoint: `pmtiles://${ASSET_URL}`,
        protocol: "auto",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "protocol-mismatch",
      detail: { reason: "invalid-magic", alternateProtocolProbing: false },
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects whole-file fallback and caller attempts to widen or invalidate transfer limits", async () => {
    const asset = fixtureAsset();
    const fullBodyFetch = vi.fn<typeof fetch>(async () => new Response(asset.buffer as ArrayBuffer, { status: 200 }));
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: fullBodyFetch },
      }),
    ).rejects.toMatchObject({
      code: "invalid-endpoint",
      detail: { reason: "range-unsupported" },
    });

    const { fetchFn } = rangeFetch();
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn },
        pmtiles: { limits: { maxRangeBytes: 128 } },
      }),
    ).rejects.toMatchObject({
      code: "invalid-endpoint",
      detail: { reason: "range-limit-exceeded" },
    });
    expect(fetchFn).not.toHaveBeenCalled();

    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn },
        pmtiles: { limits: { maxRequests: 0 } },
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });

    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn },
        pmtiles: { limits: { maxRequests: 3 } },
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();

    const cumulativeBudget = rangeFetch();
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: cumulativeBudget.fetchFn },
        pmtiles: { limits: { maxTotalBytes: 16 * 1024 - 1 } },
      }),
    ).rejects.toMatchObject({
      code: "invalid-endpoint",
      detail: { reason: "byte-limit-exceeded" },
    });
    expect(cumulativeBudget.calls).toHaveLength(0);
  });

  it("rejects retryable range responses before a long Retry-After backoff", async () => {
    const controller = new AbortController();
    const retryFetch = controlledRangeFetch(fixtureAsset(), () => ({
      status: 503,
      headers: { "Retry-After": "3600" },
      body: "retry",
    }));
    try {
      await expect(
        settleWithin(
          connect({
            endpoint: ASSET_URL,
            protocol: "pmtiles",
            authorizationScopeFingerprint: "public",
            signal: controller.signal,
            clientOptions: {
              fetchFn: retryFetch.fetchFn,
              timeoutMs: 250,
              retry: { maxRetries: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 },
            },
          }),
        ),
      ).rejects.toMatchObject({
        name: "HonuaDiscoveryError",
        code: "invalid-endpoint",
        detail: { reason: "range-replay-disallowed" },
      });
    } finally {
      controller.abort();
    }
    expect(retryFetch.calls).toHaveLength(1);
  });

  it("rejects authentication range responses before nonsettling credential refresh", async () => {
    const auth = vi.fn(async ({ reason }: { reason: string }) => {
      if (reason === "unauthorized") {
        await new Promise<void>(() => undefined);
      }
      return { bearerToken: "stale" };
    });
    const authFetch = controlledRangeFetch(fixtureAsset(), () => ({ status: 401, body: "unauthorized" }));

    await expect(
      settleWithin(
        connect({
          endpoint: ASSET_URL,
          protocol: "pmtiles",
          authorizationScopeFingerprint: "tenant-a",
          clientOptions: { fetchFn: authFetch.fetchFn, auth },
        }),
      ),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      detail: { reason: "range-replay-disallowed" },
    });
    expect(authFetch.calls).toHaveLength(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(new Headers(authFetch.calls[0]!.init?.headers).get("authorization")).toBe("Bearer stale");
  });

  it("requires a stable validator only when discovery needs a disjoint range", async () => {
    const disjoint = fixtureWithMetadataAt(20_000);
    const missing = controlledRangeFetch(disjoint, () => ({}));
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: missing.fetchFn },
      }),
    ).rejects.toMatchObject({
      code: "invalid-endpoint",
      detail: { reason: "validator-required" },
    });
    expect(missing.calls).toHaveLength(1);

    const weak = controlledRangeFetch(disjoint, () => ({ headers: { ETag: 'W/"weak-v1"' } }));
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: weak.fetchFn },
      }),
    ).rejects.toMatchObject({
      code: "invalid-endpoint",
      detail: { reason: "validator-required" },
    });
    expect(weak.calls).toHaveLength(1);

    for (const invalidLastModified of ["Wednesday, 01-Jul-26 00:00:00 GMT", "Sat, 01 Jan 10000 00:00:00 GMT"]) {
      const noncanonicalDate = controlledRangeFetch(disjoint, () => ({
        headers: { "Last-Modified": invalidLastModified },
      }));
      await expect(
        connect({
          endpoint: ASSET_URL,
          protocol: "pmtiles",
          authorizationScopeFingerprint: "public",
          clientOptions: { fetchFn: noncanonicalDate.fetchFn },
        }),
      ).rejects.toMatchObject({
        code: "invalid-endpoint",
        detail: { reason: "validator-required" },
      });
      expect(noncanonicalDate.calls).toHaveLength(1);
    }

    const lastModified = "Wed, 01 Jul 2026 00:00:00 GMT";
    const stable = controlledRangeFetch(disjoint, () => ({ headers: { "Last-Modified": lastModified } }));
    const connection = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn: stable.fetchFn },
    });
    expect(stable.calls).toHaveLength(2);
    expect(connection.inspection.sources[0]?.metadata?.pmtiles?.validator).toBe(`last-modified:${lastModified}`);

    const maximumStrongEtag = `"${"v".repeat(4_089)}"`;
    const boundaryCache = memoryCache();
    const boundary = controlledRangeFetch(disjoint, () => ({ headers: { ETag: maximumStrongEtag } }));
    const boundaryConnection = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "boundary",
      clientOptions: { fetchFn: boundary.fetchFn },
      cache: boundaryCache,
    });
    expect(boundary.calls).toHaveLength(2);
    expect(boundaryConnection.inspection.sources[0]?.metadata?.pmtiles?.validator).toBe(`etag:${maximumStrongEtag}`);
    const boundaryCacheFetch = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "boundary",
        clientOptions: { fetchFn: boundaryCacheFetch },
        cache: boundaryCache,
      }),
    ).resolves.toMatchObject({ inspection: { cacheStatus: "hit" } });
    expect(boundaryCacheFetch).not.toHaveBeenCalled();

    const oversizedEtag = `"${"v".repeat(4_090)}"`;
    const oversized = controlledRangeFetch(disjoint, () => ({ headers: { ETag: oversizedEtag } }));
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: oversized.fetchFn },
      }),
    ).rejects.toMatchObject({
      code: "invalid-endpoint",
      detail: { reason: "validator-required" },
    });
    expect(oversized.calls).toHaveLength(1);

    for (const secondHeaders of [new Headers(), new Headers({ ETag: '"changed"' })]) {
      const changed = controlledRangeFetch(disjoint, ({ index }) => ({
        headers: index === 0 ? { ETag: ETAG } : secondHeaders,
      }));
      await expect(
        connect({
          endpoint: ASSET_URL,
          protocol: "pmtiles",
          authorizationScopeFingerprint: "public",
          clientOptions: { fetchFn: changed.fetchFn },
        }),
      ).rejects.toMatchObject({
        code: "invalid-endpoint",
        detail: { reason: "archive-version-changed" },
      });
      expect(changed.calls).toHaveLength(2);
    }
  });

  it("rejects multiple ranges whose union would materialize the whole archive", async () => {
    const total = 16_384 + 200;
    const asset = fixtureWithMetadataAt(16_384, total);
    const fetch = controlledRangeFetch(asset, () => ({ headers: { ETag: ETAG } }));
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: fetch.fetchFn },
      }),
    ).rejects.toMatchObject({
      code: "invalid-endpoint",
      detail: { reason: "whole-file-disallowed" },
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it("bounds cumulative internal decompression and accepts a payload immediately below the ceiling", async () => {
    const bomb = fixtureWithMetadataJson({ padding: "a".repeat(5 * 1024 * 1024) });
    const bombFetch = rangeFetch(bomb);
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: bombFetch.fetchFn },
      }),
    ).rejects.toMatchObject({
      code: "invalid-endpoint",
      detail: { reason: "decompression-limit-exceeded" },
    });

    const bounded = fixtureWithMetadataJson({ padding: "a".repeat(2_000) });
    const boundedFetch = rangeFetch(bounded);
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: boundedFetch.fetchFn },
        pmtiles: { limits: { maxDecompressedBytes: 4_096 } },
      }),
    ).resolves.toMatchObject({ inspection: { protocol: "pmtiles" } });
    expect(boundedFetch.calls).toHaveLength(1);
  });

  it("applies the retained raw-metadata ceiling consistently with and without a discovery cache", async () => {
    const oversizedMetadata = fixtureWithMetadataJson({ padding: "x".repeat(1_100_000) });
    for (const cache of [undefined, memoryCache()]) {
      const fetch = rangeFetch(oversizedMetadata);
      await expect(
        connect({
          endpoint: ASSET_URL,
          protocol: "pmtiles",
          authorizationScopeFingerprint: "public",
          clientOptions: { fetchFn: fetch.fetchFn },
          ...(cache ? { cache } : {}),
        }),
      ).rejects.toMatchObject({
        code: "invalid-endpoint",
        detail: { reason: "invalid-metadata" },
      });
      expect(fetch.calls).toHaveLength(1);
      expect(cache?.entries.size ?? 0).toBe(0);
    }
  });

  it("rejects excessive raw vector-layer fanout before either live or cached reuse", async () => {
    const excessiveFanout = fixtureWithMetadataJson({
      vector_layers: Array.from({ length: 2_049 }, () => null),
    });
    for (const cache of [undefined, memoryCache()]) {
      const fetch = rangeFetch(excessiveFanout);
      await expect(
        connect({
          endpoint: ASSET_URL,
          protocol: "pmtiles",
          authorizationScopeFingerprint: "public",
          clientOptions: { fetchFn: fetch.fetchFn },
          ...(cache ? { cache } : {}),
        }),
      ).rejects.toMatchObject({
        code: "invalid-endpoint",
        detail: { reason: "invalid-metadata" },
      });
      expect(fetch.calls).toHaveLength(1);
      expect(cache?.entries.size ?? 0).toBe(0);
    }
  });

  it("keeps normalized vector-layer structure inside the shared cache envelope", async () => {
    const cache = memoryCache();
    const nearCeiling = rangeFetch(fixtureWithMetadataJson(vectorLayerMetadata(2, 3_996)));
    const live = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "near-structural-ceiling",
      clientOptions: { fetchFn: nearCeiling.fetchFn },
      cache,
    });
    expect(nearCeiling.calls).toHaveLength(2);
    expect(live.inspection.sources[0]?.metadata?.pmtiles?.vectorLayers).toHaveLength(2);

    const replayFetch = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "near-structural-ceiling",
        clientOptions: { fetchFn: replayFetch },
        cache,
      }),
    ).resolves.toMatchObject({ inspection: { cacheStatus: "hit" } });
    expect(replayFetch).not.toHaveBeenCalled();

    const excessive = fixtureWithMetadataJson(vectorLayerMetadata(3, 4_000));
    for (const candidateCache of [undefined, memoryCache()]) {
      const fetch = rangeFetch(excessive);
      await expect(
        connect({
          endpoint: ASSET_URL,
          protocol: "pmtiles",
          authorizationScopeFingerprint: "excessive-structural-nodes",
          clientOptions: { fetchFn: fetch.fetchFn },
          ...(candidateCache ? { cache: candidateCache } : {}),
        }),
      ).rejects.toMatchObject({
        code: "invalid-endpoint",
        detail: { reason: "invalid-metadata" },
      });
      expect(fetch.calls).toHaveLength(2);
      expect(candidateCache?.entries.size ?? 0).toBe(0);
    }
  });

  it("rejects redirect, encoded, misbound, and overflowing range responses", async () => {
    const scenarios = [
      {
        control: () => ({ status: 302, headers: { Location: `${ASSET_URL}?redirected=true` }, body: null }),
        expected: { name: "HonuaNetworkError", sdkCode: "core.network" },
      },
      {
        control: () => ({ headers: { "Content-Encoding": "gzip", ETag: ETAG } }),
        expected: { code: "invalid-endpoint", detail: { reason: "compressed-range-response" } },
      },
      {
        control: ({ start, end }: ControlledRangeCall) => ({
          headers: { "Content-Range": `bytes ${start + 1}-${end + 1}/${64 * 1024}`, ETag: ETAG },
        }),
        expected: { code: "invalid-endpoint", detail: { reason: "invalid-content-range" } },
      },
      {
        control: ({ start, end }: ControlledRangeCall) => ({
          headers: { ETag: ETAG },
          body: new Uint8Array(end - start + 2),
        }),
        expected: { code: "invalid-endpoint", detail: { reason: "range-overflow" } },
      },
    ] as const;
    for (const scenario of scenarios) {
      const fetch = controlledRangeFetch(fixtureAsset(), scenario.control);
      await expect(
        connect({
          endpoint: ASSET_URL,
          protocol: "pmtiles",
          authorizationScopeFingerprint: "public",
          clientOptions: { fetchFn: fetch.fetchFn },
        }),
      ).rejects.toMatchObject(scenario.expected);
      expect(fetch.calls).toHaveLength(1);
    }
  });

  it("bounds a range body before body-reading after interceptors can inspect it", async () => {
    const asset = fixtureAsset();
    const afterByteLengths: number[] = [];
    const responseSemantics: Array<{
      url: string;
      type: Response["type"];
      redirected: boolean;
      cloneUrl: string;
      cloneType: Response["type"];
      cloneRedirected: boolean;
    }> = [];
    const oversized = controlledRangeFetch(asset, ({ start, end }) => ({
      headers: { ETag: ETAG },
      body: new Uint8Array(end - start + 2),
    }));
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: {
          fetchFn: oversized.fetchFn,
          interceptors: [
            {
              after: async ({ response }) => {
                afterByteLengths.push((await response.arrayBuffer()).byteLength);
              },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ detail: { reason: "range-overflow" } });
    expect(afterByteLengths).toEqual([]);

    const bounded = rangeFetch(asset);
    const semanticFetch = vi.fn<typeof fetch>(async (input, init) => {
      const response = await bounded.fetchFn(input, init);
      Object.defineProperties(response, {
        url: { configurable: true, value: ASSET_URL },
        type: { configurable: true, value: "cors" },
        redirected: { configurable: true, value: false },
      });
      return response;
    });
    await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "public",
      clientOptions: {
        fetchFn: semanticFetch,
        interceptors: [
          {
            after: async ({ response }) => {
              const clone = response.clone();
              responseSemantics.push({
                url: response.url,
                type: response.type,
                redirected: response.redirected,
                cloneUrl: clone.url,
                cloneType: clone.type,
                cloneRedirected: clone.redirected,
              });
              afterByteLengths.push((await response.arrayBuffer()).byteLength);
            },
          },
        ],
      },
    });
    expect(afterByteLengths).toEqual([16 * 1024]);
    expect(responseSemantics).toEqual([
      {
        url: ASSET_URL,
        type: "cors",
        redirected: false,
        cloneUrl: ASSET_URL,
        cloneType: "cors",
        cloneRedirected: false,
      },
    ]);
  });

  it("keeps unknown tile kinds disabled and treats center zoom 255 as a display hint", async () => {
    const asset = fixtureAsset();
    asset[99] = 6;
    asset[118] = 255;
    const archiveFetch = rangeFetch(asset);
    const cache = memoryCache();
    const connection = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn: archiveFetch.fetchFn },
      cache,
    });
    const source = connection.source();
    expect(source.capabilities.has("tiles")).toBe(false);
    expect(connection.inspection.sources[0]?.descriptor.locator.sourceType).toBeUndefined();
    expect(connection.inspection.sources[0]?.metadata?.pmtiles?.center[2]).toBe(255);
    expect(connection.inspection.sources[0]?.metadata?.partialReasons).toHaveLength(1);
    await expect(source.protocol("pmtiles")!.describe()).resolves.toMatchObject({
      tileKind: "unknown",
      center: [-122.35, 37.6, 255],
    });
    expect(archiveFetch.calls).toHaveLength(1);

    const replayFetch = vi.fn<typeof fetch>();
    const replay = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn: replayFetch },
      cache,
    });
    expect(replay.inspection.cacheStatus).toBe("hit");
    expect(replay.source().capabilities.has("tiles")).toBe(false);
    expect(replay.inspection.sources[0]?.metadata?.partialReasons).toEqual(
      connection.inspection.sources[0]?.metadata?.partialReasons,
    );
    expect(replayFetch).not.toHaveBeenCalled();

    const tampered = structuredClone([...cache.entries.values()][0]!) as unknown as MutablePmtilesSnapshot;
    tampered.sources[0]!.metadata!.partialReasons = ["fabricated unknown-tile reason"];
    const tamperedFetch = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn: tamperedFetch },
        cache: {
          get: () => tampered as unknown as ConnectDiscoverySnapshot,
          set: () => {
            throw new Error("tampered cache entry must not be rewritten");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-discovery-cache" });
    expect(tamperedFetch).not.toHaveBeenCalled();
  });

  it("uses scope- and policy-aware cache identities and revalidates cached archive evidence", async () => {
    const cache = memoryCache();
    const firstFetch = rangeFetch();
    const first = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: { fetchFn: firstFetch.fetchFn },
      cache,
    });
    expect(first.inspection.cacheStatus).toBe("miss");
    expect(firstFetch.calls).toHaveLength(1);

    const cachedFetch = vi.fn<typeof fetch>();
    const second = await connect({
      endpoint: `pmtiles://${ASSET_URL}`,
      protocol: "auto",
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: { fetchFn: cachedFetch },
      cache,
    });
    expect(second.inspection.cacheStatus).toBe("hit");
    expect(cachedFetch).not.toHaveBeenCalled();
    expect(second.inspection.sources[0]?.metadata?.pmtiles?.validator).toBe(`etag:${ETAG}`);
    await expect(second.source().protocol("pmtiles")!.describe()).resolves.toMatchObject({
      url: ASSET_URL,
      tileKind: "mvt",
    });
    expect(cachedFetch).not.toHaveBeenCalled();

    const refreshedFetch = rangeFetch();
    const refreshed = await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: { fetchFn: refreshedFetch.fetchFn },
      cache,
      refresh: true,
    });
    expect(refreshed.inspection.cacheStatus).toBe("refreshed");
    expect(refreshedFetch.calls).toHaveLength(1);
    expect(refreshedFetch.calls[0]?.cache).toBe("no-store");

    const otherScope = rangeFetch();
    await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-b",
      clientOptions: { fetchFn: otherScope.fetchFn },
      cache,
    });
    expect(otherScope.calls).toHaveLength(1);

    const narrowerPolicy = rangeFetch();
    await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: { fetchFn: narrowerPolicy.fetchFn },
      cache,
      pmtiles: { limits: { maxTotalBytes: 32 * 1024 } },
    });
    expect(narrowerPolicy.calls).toHaveLength(1);

    const decompressionPolicy = rangeFetch();
    await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: { fetchFn: decompressionPolicy.fetchFn },
      cache,
      pmtiles: { limits: { maxDecompressedBytes: 1_024 } },
    });
    expect(decompressionPolicy.calls).toHaveLength(1);
  });

  it("rejects tampered cached range, validator, policy, and archive metadata evidence", async () => {
    const primedCache = memoryCache();
    const primingFetch = rangeFetch(fixtureWithMetadataAt(20_000));
    await connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: { fetchFn: primingFetch.fetchFn },
      cache: primedCache,
    });
    const honest = [...primedCache.entries.values()][0]!;

    const expectRejected = async (
      mutate: (snapshot: MutablePmtilesSnapshot) => void,
      pmtiles?: ConnectOptions["pmtiles"],
    ) => {
      const fetchFn = vi.fn<typeof fetch>();
      const cache: ConnectDiscoveryCache = {
        get(identity) {
          const snapshot = structuredClone(honest) as unknown as MutablePmtilesSnapshot;
          snapshot.identityKey = identity.key;
          mutate(snapshot);
          return snapshot as unknown as ConnectDiscoverySnapshot;
        },
        set() {
          throw new Error("invalid cached PMTiles evidence must not be rewritten");
        },
      };
      await expect(
        connect({
          endpoint: ASSET_URL,
          protocol: "pmtiles",
          authorizationScopeFingerprint: "tenant-a",
          clientOptions: { fetchFn },
          cache,
          ...(pmtiles ? { pmtiles } : {}),
        }),
      ).rejects.toMatchObject({ code: "invalid-discovery-cache" });
      expect(fetchFn).not.toHaveBeenCalled();
    };

    await expectRejected((snapshot) => {
      snapshot.sources[0]!.metadata!.pmtiles!.transfer.ranges[0]!.contentRange = "bounded-but-not-a-range";
    });
    await expectRejected((snapshot) => {
      const header = snapshot.sources[0]!.metadata!.pmtiles!.transfer.ranges[0]!;
      header.offset = 1;
      header.contentRange = `bytes 1-${header.length}/65536`;
    });
    await expectRejected((snapshot) => {
      const range = snapshot.sources[0]!.metadata!.pmtiles!.transfer.ranges[1]!;
      range.contentRange = `bytes ${range.offset}-${range.offset + range.length - 1}/65537`;
    });
    await expectRejected((snapshot) => {
      const pmtiles = snapshot.sources[0]!.metadata!.pmtiles!;
      const duplicate = pmtiles.transfer.ranges[1]!;
      duplicate.offset = 0;
      duplicate.length = 16_384;
      duplicate.bytesReceived = duplicate.length;
      duplicate.contentRange = "bytes 0-16383/65536";
      pmtiles.transfer.bytesFetched = 32_768;
    });
    await expectRejected((snapshot) => {
      const pmtiles = snapshot.sources[0]!.metadata!.pmtiles!;
      const subrange = pmtiles.transfer.ranges[1]!;
      subrange.offset = 1_024;
      subrange.length = 2_048;
      subrange.bytesReceived = subrange.length;
      subrange.contentRange = "bytes 1024-3071/65536";
      pmtiles.transfer.bytesFetched = 16_384 + subrange.length;
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.metadata!.pmtiles!.transfer.ranges[1]!.validator = 'etag:"different"';
    });
    await expectRejected((snapshot) => {
      const pmtiles = snapshot.sources[0]!.metadata!.pmtiles!;
      const metadata = pmtiles.transfer.ranges[1]!;
      metadata.offset = 16_384;
      metadata.length = 65_536 - 16_384;
      metadata.bytesReceived = metadata.length;
      metadata.contentRange = "bytes 16384-65535/65536";
      pmtiles.transfer.bytesFetched = 16_384 + metadata.length;
    });
    await expectRejected((snapshot) => {
      for (const range of snapshot.sources[0]!.metadata!.pmtiles!.transfer.ranges) {
        delete range.validator;
      }
      delete snapshot.sources[0]!.metadata!.pmtiles!.validator;
      for (const record of [...snapshot.evidence, ...(snapshot.sources[0]!.evidence ?? [])]) {
        for (const provenance of record.provenance ?? []) delete provenance.validator;
      }
    });
    await expectRejected((snapshot) => {
      snapshot.evidence[0]!.provenance![0]!.source = "https://assets.example.test/other.pmtiles";
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.evidence![0]!.provenance![0]!.retrievedAt = "2020-01-01T00:00:00.000Z";
    });
    await expectRejected((snapshot) => {
      snapshot.retrievedAt = "not-a-canonical-timestamp";
      for (const record of [...snapshot.evidence, ...(snapshot.sources[0]!.evidence ?? [])]) {
        for (const provenance of record.provenance ?? []) provenance.retrievedAt = snapshot.retrievedAt;
      }
    });
    await expectRejected((snapshot) => {
      (snapshot as unknown as { injected?: string }).injected = "fabricated";
    });
    await expectRejected((snapshot) => {
      (snapshot.sources[0] as unknown as { injected?: string }).injected = "fabricated";
    });
    await expectRejected((snapshot) => {
      snapshot.evidence.push(structuredClone(snapshot.evidence[0]!));
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.evidence![0]!.capabilities = [];
    });
    await expectRejected((snapshot) => {
      snapshot.evidence[0]!.capabilities = ["tiles", "tiles"];
    });
    await expectRejected((snapshot) => {
      snapshot.evidence[0]!.scope = ["tiles", "query"];
    });
    await expectRejected((snapshot) => {
      const provenance = snapshot.sources[0]!.evidence![0]!.provenance!;
      provenance.push(structuredClone(provenance[0]!));
    });
    await expectRejected((snapshot) => {
      const provenance = snapshot.evidence[0]!.provenance![0]! as {
        source: string;
        retrievedAt?: string;
        validator?: string;
        injected?: string;
      };
      provenance.injected = "fabricated";
    });
    await expectRejected((snapshot) => {
      const changed = 'etag:"coordinated-tamper"';
      snapshot.sources[0]!.metadata!.pmtiles!.validator = changed;
      for (const range of snapshot.sources[0]!.metadata!.pmtiles!.transfer.ranges) range.validator = changed;
      for (const record of snapshot.sources[0]!.evidence ?? []) {
        for (const provenance of record.provenance ?? []) provenance.validator = changed;
      }
    });
    for (const invalidValidator of ["banana", 'etag:W/"weak"', "last-modified:Wednesday, 01-Jul-26 00:00:00 GMT"]) {
      await expectRejected((snapshot) => {
        snapshot.sources[0]!.metadata!.pmtiles!.validator = invalidValidator;
        for (const range of snapshot.sources[0]!.metadata!.pmtiles!.transfer.ranges) {
          range.validator = invalidValidator;
        }
        for (const record of [...snapshot.evidence, ...(snapshot.sources[0]!.evidence ?? [])]) {
          for (const provenance of record.provenance ?? []) provenance.validator = invalidValidator;
        }
      });
    }
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.metadata!.pmtiles!.center[0] = 181;
    });
    await expectRejected((snapshot) => {
      const layer = snapshot.sources[0]!.metadata!.pmtiles!.vectorLayers[0]!;
      layer.minZoom = 5;
      layer.maxZoom = 4;
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.metadata!.pmtiles!.metadataJson = JSON.stringify({
        attribution: "contradictory attribution",
      });
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.extent!.spatial!.bbox[0]![0] = -120;
    });
    await expectRejected((snapshot) => {
      (snapshot.sources[0]!.extent!.spatial as unknown as { injected?: string }).injected = "fabricated";
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.metadata!.extent!.spatial!.bbox[0]![2] = -120;
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.title = "fabricated attribution";
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.schema = { fields: [] };
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.crs = ["EPSG:3857"];
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.description = "fabricated description";
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.metadata!.protocolVersion = "fabricated-version";
    });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.metadata!.partialReasons = [];
    });
    await expectRejected(() => undefined, { limits: { maxTotalBytes: 16 * 1024 } });
    await expectRejected((snapshot) => {
      snapshot.sources[0]!.metadata!.pmtiles!.transfer.decompressedBytes = 4 * 1024 * 1024 + 1;
    });
    const admittedDecompressedBytes = honest.sources[0]!.metadata!.pmtiles!.transfer.decompressedBytes;
    expect(admittedDecompressedBytes).toBeGreaterThan(1);
    await expectRejected(() => undefined, { limits: { maxDecompressedBytes: admittedDecompressedBytes - 1 } });
  });

  it("honors cancellation before cache, auth, and network work", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("settles cancellation while authentication is pending and never fetches after auth releases", async () => {
    const controller = new AbortController();
    let authStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authStarted = resolve;
    });
    let releaseAuth!: (credentials: { bearerToken: string }) => void;
    const credentials = new Promise<{ bearerToken: string }>((resolve) => {
      releaseAuth = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>();
    const pending = connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: {
        fetchFn,
        auth: {
          getCredentials() {
            authStarted();
            return credentials;
          },
        },
      },
      signal: controller.signal,
    });

    await started;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();

    releaseAuth({ bearerToken: "late-secret" });
    await credentials;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("cancels an in-flight bounded response body", async () => {
    const controller = new AbortController();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(async () => {
      requestStarted();
      return new Response(new ReadableStream<Uint8Array>({}), {
        status: 206,
        headers: {
          "Content-Length": String(16 * 1024),
          "Content-Range": `bytes 0-${16 * 1024 - 1}/${64 * 1024}`,
          ETag: ETAG,
        },
      });
    });
    const pending = connect({
      endpoint: ASSET_URL,
      protocol: "pmtiles",
      authorizationScopeFingerprint: "public",
      clientOptions: { fetchFn },
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps the client timeout active through a stalled bounded response body", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      const partial = fixtureAsset().slice(0, 8);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(partial);
          },
        }),
        {
          status: 206,
          headers: {
            "Content-Length": String(16 * 1024),
            "Content-Range": `bytes 0-${16 * 1024 - 1}/${64 * 1024}`,
            ETag: ETAG,
          },
        },
      );
    });

    await expect(
      connect({
        endpoint: ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn, timeoutMs: 20 },
      }),
    ).rejects.toBeInstanceOf(HonuaTimeoutError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns structured STAC-classification guidance for an unclassified direct TIFF", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: "https://assets.example.test/scenes/image.tif",
        protocol: "auto",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({
      code: "unsupported-protocol",
      detail: {
        discoveryDisposition: "stac-classified",
        directInput: "unsupported-unclassified",
        requiredWorkflow: "connect-static-stac",
        alternateProtocolProbing: false,
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
