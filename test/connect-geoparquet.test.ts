import { describe, expect, it, vi } from "vitest";

import type { GeoParquetSourceProfile, GeoParquetSourceProfiler } from "../src/connect-geoparquet.js";
import { type ConnectDiscoverySnapshot, connect } from "../src/connect.js";
import type { Result, Source, SourceDescriptor, SourceResolver } from "../src/contract/types.js";

const GEOPARQUET_ENDPOINT = "https://fixtures.test/places-geoparquet.parquet";

const GEO_PROFILE: GeoParquetSourceProfile = {
  columns: ["id", "name", "category", "population"],
  geometry: { column: "geometry", encoding: "wkb", bboxColumn: "bbox" },
  crs: "OGC:CRS84",
  rowEstimate: 8,
};

function fakeProfiler(profile: GeoParquetSourceProfile = GEO_PROFILE): GeoParquetSourceProfiler & {
  readonly calls: Array<{ sources: readonly string[]; override?: string }>;
} {
  const calls: Array<{ sources: readonly string[]; override?: string }> = [];
  return {
    calls,
    async profile(sources, override) {
      calls.push({ sources: [...sources], override });
      return profile;
    },
  };
}

/**
 * A resolveSource that stands in for `geoparquetResolver()` without the DuckDB
 * engine — it proves the connect → resolveSource → `source.query()` wiring
 * end-to-end with no real network / file read. Real DuckDB execution of a
 * geoparquet descriptor is covered by `test/geoparquet-source.test.ts`.
 */
function stubResolver(result: Result): { resolver: SourceResolver; captured: SourceDescriptor[] } {
  const captured: SourceDescriptor[] = [];
  const resolver: SourceResolver = (descriptor) => {
    captured.push(descriptor);
    if (descriptor.protocol !== "geoparquet") return undefined;
    const source: Partial<Source> = {
      descriptor,
      capabilities: descriptor.capabilities,
      async query() {
        return result;
      },
    };
    return source as Source;
  };
  return { resolver, captured };
}

describe("connect() — GeoParquet / static-file discovery", () => {
  it("projects footer metadata into a reviewed descriptor with metadata-driven capabilities", async () => {
    const profiler = fakeProfiler();
    const connection = await connect({
      endpoint: GEOPARQUET_ENDPOINT,
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: { profiler },
    });

    expect(profiler.calls).toEqual([{ sources: [GEOPARQUET_ENDPOINT], override: undefined }]);
    expect(connection.inspection.protocol).toBe("geoparquet");
    expect(connection.inspection.endpoint).toBe(GEOPARQUET_ENDPOINT);
    // Client is bound to the asset origin; it is never used for feature queries.
    expect(connection.dataset.client.serverBaseUrl).toBe("https://fixtures.test");
    // Source id derived from the asset basename (without extension).
    expect(connection.dataset.sourceIds()).toEqual(["places-geoparquet"]);
    expect(connection.inspection.defaultSourceId).toBe("places-geoparquet");

    // Capabilities are the adapter surface intersected with a successful footer
    // read, never PROTOCOL_DEFAULT_CAPABILITIES by fiat.
    const descriptor = connection.inspection.sources[0]!.descriptor;
    expect([...descriptor.capabilities]).toEqual(["query", "queryAggregate", "stream"]);
    expect(connection.inspection.sources[0]?.discovery).toBe("metadata");
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: `${GEOPARQUET_ENDPOINT} (parquet footer)` })]),
    );

    // The detected geometry column + encoding + bbox covering are pinned on the
    // locator so the runtime resolves without a second profiling round-trip.
    expect(descriptor.locator).toMatchObject({
      url: GEOPARQUET_ENDPOINT,
      geoparquet: { geometryColumn: "geometry", geometryEncoding: "wkb", bboxColumn: "bbox" },
    });
    expect(connection.inspection.sources[0]?.metadata?.crs).toEqual(["OGC:CRS84"]);
  });

  it("discovers a purely tabular Parquet file (no geometry column) with the same read capabilities", async () => {
    const profiler = fakeProfiler({ columns: ["id", "value"], rowEstimate: 3 });
    const connection = await connect({
      endpoint: "https://fixtures.test/data/measurements.parquet",
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: { profiler },
    });

    expect(connection.dataset.sourceIds()).toEqual(["measurements"]);
    const descriptor = connection.inspection.sources[0]!.descriptor;
    expect([...descriptor.capabilities]).toEqual(["query", "queryAggregate", "stream"]);
    // No geometry ⇒ no geoparquet addressing block on the locator.
    expect(descriptor.locator.geoparquet).toBeUndefined();
    expect(connection.inspection.sources[0]?.metadata?.crs).toBeUndefined();
  });

  it("preserves discovered GeoParquet 1.1 native coordinate dimensions on the locator", async () => {
    const profiler = fakeProfiler({
      columns: ["id"],
      geometry: {
        column: "geometry",
        encoding: "geoarrow-point",
        nativeDimensions: "xyz",
      },
    });
    const connection = await connect({
      endpoint: GEOPARQUET_ENDPOINT,
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: { profiler },
    });

    expect(connection.inspection.sources[0]?.descriptor.locator.geoparquet).toMatchObject({
      geometryColumn: "geometry",
      geometryEncoding: "geoarrow-point",
      nativeDimensions: "xyz",
    });
  });

  it("unions additional files and forwards an explicit geometry-column override", async () => {
    const profiler = fakeProfiler();
    const connection = await connect({
      endpoint: "https://fixtures.test/overture/theme/type=place/part-0.parquet",
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: {
        profiler,
        urls: ["https://fixtures.test/overture/theme/type=place/part-1.parquet"],
        geometryColumn: "geom",
      },
    });

    expect(profiler.calls[0]).toEqual({
      sources: [
        "https://fixtures.test/overture/theme/type=place/part-0.parquet",
        "https://fixtures.test/overture/theme/type=place/part-1.parquet",
      ],
      override: "geom",
    });
    expect(connection.inspection.sources[0]?.descriptor.locator.geoparquet?.urls).toEqual([
      "https://fixtures.test/overture/theme/type=place/part-1.parquet",
    ]);
  });

  it("resolves a discovered descriptor through an injected resolveSource and round-trips a query", async () => {
    const profiler = fakeProfiler();
    const { resolver, captured } = stubResolver({
      features: [{ attributes: { id: 1 }, geometry: { type: "Point", coordinates: [0, 0] } }],
      exceededTransferLimit: false,
    });
    const connection = await connect({
      endpoint: GEOPARQUET_ENDPOINT,
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: { profiler },
      resolveSource: resolver,
    });

    // Sources resolve lazily, so touching source() triggers the resolver.
    const result = await connection.source().query({ pagination: { limit: 3 } });
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.geometry).toMatchObject({ type: "Point" });

    // The resolver received exactly the reviewed discovered descriptor.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.protocol).toBe("geoparquet");
    expect(captured[0]?.locator).toMatchObject({
      url: GEOPARQUET_ENDPOINT,
      geoparquet: { geometryColumn: "geometry" },
    });
    expect([...(captured[0]?.capabilities ?? [])]).toEqual(["query", "queryAggregate", "stream"]);
  });

  it("partitions the discovery cache identity and serves a validated snapshot on hit", async () => {
    const profiler = fakeProfiler();
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache = {
      get: (identity: { key: string }) => values.get(identity.key),
      set: (identity: { key: string }, snapshot: ConnectDiscoverySnapshot) => {
        values.set(identity.key, snapshot);
      },
    };
    const options = {
      endpoint: GEOPARQUET_ENDPOINT,
      protocol: "geoparquet" as const,
      authorizationScopeFingerprint: "anonymous",
      geoparquet: { profiler },
      cache,
    };

    const first = await connect(options);
    const hit = await connect(options);

    expect(first.inspection.cacheStatus).toBe("miss");
    expect(hit.inspection.cacheStatus).toBe("hit");
    expect(hit.dataset.sourceIds()).toEqual(["places-geoparquet"]);
    expect(first.inspection.cacheIdentity.key).toContain("protocol=geoparquet");
    // The footer is read once; the second connect() is served from cache.
    expect(profiler.calls).toHaveLength(1);
  });

  it("does not collide the cache when geoparquet urls / geometryColumn differ for the same primary asset", async () => {
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache = {
      get: (identity: { key: string }) => values.get(identity.key),
      set: (identity: { key: string }, snapshot: ConnectDiscoverySnapshot) => {
        values.set(identity.key, snapshot);
      },
    };

    // Base: single primary file, no override.
    const base = fakeProfiler();
    const baseConn = await connect({
      endpoint: GEOPARQUET_ENDPOINT,
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: { profiler: base },
      cache,
    });

    // Same primary URL but an explicit geometry-column override ⇒ different
    // discovered profile/locator, so it must NOT reuse the base snapshot.
    const overridden = fakeProfiler({ columns: ["id"], geometry: { column: "geom", encoding: "native" } });
    const overriddenConn = await connect({
      endpoint: GEOPARQUET_ENDPOINT,
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: { profiler: overridden, geometryColumn: "geom" },
      cache,
    });

    // Same primary URL but an additional unioned file ⇒ different identity again.
    const unioned = fakeProfiler();
    const unionedConn = await connect({
      endpoint: GEOPARQUET_ENDPOINT,
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: { profiler: unioned, urls: [`${GEOPARQUET_ENDPOINT}?part=2`] },
      cache,
    });

    const keys = new Set([
      baseConn.inspection.cacheIdentity.key,
      overriddenConn.inspection.cacheIdentity.key,
      unionedConn.inspection.cacheIdentity.key,
    ]);
    expect(keys.size).toBe(3);
    // Each distinct input profiled fresh — no stale cross-input cache hit.
    expect(overriddenConn.inspection.cacheStatus).toBe("miss");
    expect(unionedConn.inspection.cacheStatus).toBe("miss");
    expect(overridden.calls).toHaveLength(1);
    expect(unioned.calls).toHaveLength(1);
    expect(overriddenConn.inspection.sources[0]?.descriptor.locator.geoparquet?.geometryColumn).toBe("geom");
  });

  it("fails closed when no geoparquet profiler seam is supplied", async () => {
    await expect(
      connect({
        endpoint: GEOPARQUET_ENDPOINT,
        protocol: "geoparquet",
        authorizationScopeFingerprint: "anonymous",
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
  });

  it("rejects a geoparquet hint against a canonical GeoServices URL before profiling", async () => {
    const profiler: GeoParquetSourceProfiler = { profile: vi.fn() };
    await expect(
      connect({
        endpoint: "https://example.test/rest/services/Parcels/FeatureServer",
        protocol: "geoparquet",
        authorizationScopeFingerprint: "anonymous",
        geoparquet: { profiler },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(profiler.profile).not.toHaveBeenCalled();
  });
});
