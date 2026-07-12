import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GeoParquetSourceProfiler } from "../src/connect-geoparquet.js";
import { type ConnectDiscoverySnapshot, connect } from "../src/connect.js";
import { geoparquetResolver } from "../src/geoparquet/index.js";
import type { SourceProfile } from "../src/geoparquet/metadata.js";
// @ts-expect-error — .mjs test helper (no type declarations, excluded from tsc)
import { createNodeDuckDbDriver } from "./helpers/geoparquet-node-driver.mjs";

const GEOPARQUET_ENDPOINT = "https://fixtures.test/places-geoparquet.parquet";

const GEO_PROFILE: SourceProfile = {
  columns: ["id", "name", "category", "population"],
  geometry: { column: "geometry", encoding: "wkb", bboxColumn: "bbox" },
  crs: "OGC:CRS84",
  rowEstimate: 8,
};

function fakeProfiler(profile: SourceProfile = GEO_PROFILE): GeoParquetSourceProfiler & {
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

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/geoparquet/${name}`, import.meta.url))));
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

  // Live end-to-end: discovery + the injected resolver drive a real DuckDB query
  // over registered fixture bytes (no network, no mocks). Runs in CI where the
  // DuckDB-WASM asset is present.
  describe("live DuckDB round-trip against fixtures", () => {
    const disposers: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const dispose of disposers.splice(0)) await dispose();
    });

    it("resolves a discovered descriptor and runs a real query end-to-end", async () => {
      const resolver = geoparquetResolver({ driverFactory: createNodeDuckDbDriver });
      disposers.push(() => resolver.dispose());
      await resolver.runtime.registerFileBuffer(GEOPARQUET_ENDPOINT, fixtureBytes("places-geoparquet.parquet"));

      const connection = await connect({
        endpoint: GEOPARQUET_ENDPOINT,
        protocol: "geoparquet",
        authorizationScopeFingerprint: "anonymous",
        geoparquet: { profiler: resolver.runtime },
        resolveSource: resolver,
      });

      expect(connection.dataset.sourceIds()).toEqual(["places-geoparquet"]);
      expect([...connection.source().capabilities]).toEqual(["query", "queryAggregate", "stream"]);
      expect(connection.source().descriptor.locator.geoparquet?.geometryColumn).toBe("geometry");

      const result = await connection.source().query({ pagination: { limit: 3 } });
      expect(result.features).toHaveLength(3);
      expect(result.features[0]?.geometry).toMatchObject({ type: "Point" });
    }, 60_000);
  });
});
