import { describe, expect, it } from "vitest";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import {
  type HonuaOfflineRegionError,
  OFFLINE_REGION_TILE_SCHEME,
  type OfflineRegionSnapshotSelectionV1,
  type OfflineRegionSnapshotV1,
  buildOfflineRegionTileUrlTemplate,
  createMemoryOfflineRegionStore,
  createOfflineRegionFetchHandler,
  createOfflineRegionSnapshotLoader,
  createOfflineRegionTileProtocol,
  downloadOfflineRegion,
  normalizeOfflineRegionTileKey,
  offlineRegionAssetSelector,
  offlineRegionMetadataSelector,
  offlineRegionTileEnvelope,
  offlineRegionTileSelector,
  parseOfflineRegionTileUrl,
  planOfflineRegionSnapshot,
  readOfflineRegionAsset,
  readOfflineRegionMetadata,
  readOfflineRegionResource,
  readOfflineRegionTile,
  registerOfflineRegionTileProtocol,
  resolveOfflineRegionResourceId,
} from "../src/offline/index.js";

const SCOPE = "tenant:a/role:field";
const OBSERVED_AT = "2026-07-10T10:00:00.000Z";
const NOW = () => new Date("2026-07-10T10:01:00.000Z");
const QUOTA = 4 * 1024 * 1024;

/** Northwest quadrant: exactly the extent of XYZ tile 1/0/0. */
const BOUNDS = { minX: -180, minY: 0, maxX: 0, maxY: 85, crs: "EPSG:4326" } as const;

const TILE_BYTES = new Uint8Array([0x1a, 0x2b, 0x3c, 0x4d]);
const SPRITE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const LANDING_PAGE = { title: "Incidents", links: [{ rel: "data", href: "/collections" }] };

const encoder = new TextEncoder();

function selection(overrides: Partial<OfflineRegionSnapshotSelectionV1> = {}): OfflineRegionSnapshotSelectionV1 {
  return {
    name: "Northwest quadrant",
    sourceId: "incidents",
    endpoint: "https://example.test/ogc/tiles",
    authorizationScopeFingerprint: SCOPE,
    bounds: BOUNDS,
    minZoom: 1,
    maxZoom: 3,
    sourceVersion: "source-v3",
    schemaVersion: "schema-v7",
    planVersion: "plan-v2",
    observation: { state: "cached", observedAt: OBSERVED_AT },
    attribution: { fixture: "Honua deterministic tile fixture" },
    contents: [
      {
        kind: "tile",
        bytes: TILE_BYTES,
        contentType: "application/vnd.mapbox-vector-tile",
        selector: offlineRegionTileSelector({ z: 1, x: 0, y: 0 }),
        attributionIds: ["fixture"],
      },
      {
        kind: "asset",
        bytes: SPRITE_BYTES,
        contentType: "image/png",
        selector: offlineRegionAssetSelector("sprite-2x.png"),
        attributionIds: ["fixture"],
      },
      {
        kind: "metadata",
        bytes: encoder.encode(JSON.stringify(LANDING_PAGE)),
        contentType: "application/json",
        selector: offlineRegionMetadataSelector("landing-page"),
        attributionIds: ["fixture"],
      },
      {
        kind: "metadata",
        bytes: encoder.encode("<Capabilities/>"),
        contentType: "application/xml",
        selector: offlineRegionMetadataSelector("capabilities"),
        attributionIds: ["fixture"],
      },
      {
        kind: "metadata",
        bytes: encoder.encode("{ not json"),
        contentType: "application/json",
        selector: offlineRegionMetadataSelector("damaged"),
        attributionIds: ["fixture"],
      },
    ],
    ...overrides,
  };
}

async function persisted(overrides: Partial<OfflineRegionSnapshotSelectionV1> = {}): Promise<{
  snapshot: OfflineRegionSnapshotV1;
  store: ReturnType<typeof createMemoryOfflineRegionStore>;
}> {
  const snapshot = await planOfflineRegionSnapshot(selection(overrides));
  const store = createMemoryOfflineRegionStore();
  await downloadOfflineRegion(snapshot.manifest, {
    store,
    load: createOfflineRegionSnapshotLoader(snapshot),
    logicalQuotaBytes: QUOTA,
  });
  return { snapshot, store };
}

/** Capture the rejection of `body`, failing when it resolves instead. */
async function rejection(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error) {
    return error;
  }
  throw new Error("expected the offline read to fail closed");
}

describe("offline region tile coordinates", () => {
  it("keeps longitude wrapping but refuses a row outside the pyramid", () => {
    expect(normalizeOfflineRegionTileKey({ z: 1, x: 2, y: 0 })).toEqual({ z: 1, x: 0, y: 0 });
    expect(normalizeOfflineRegionTileKey({ z: 1, x: -1, y: 1 })).toEqual({ z: 1, x: 1, y: 1 });
    // The renderer's normalizer clamps here; clamping would address another
    // tile's bytes, so the offline addressing refuses instead.
    expect(() => normalizeOfflineRegionTileKey({ z: 1, x: 0, y: 5 })).toThrowError(/outside the zoom-1 tile pyramid/);
    expect(() => normalizeOfflineRegionTileKey({ z: 31, x: 0, y: 0 })).toThrowError(/between 0 and 30/);
  });

  it("folds a tms row onto the canonical xyz row", () => {
    expect(normalizeOfflineRegionTileKey({ z: 1, x: 0, y: 1 }, { scheme: "tms" })).toEqual({ z: 1, x: 0, y: 0 });
    expect(offlineRegionTileSelector({ z: 1, x: 0, y: 1 }, { scheme: "tms" })).toEqual(
      offlineRegionTileSelector({ z: 1, x: 0, y: 0 }),
    );
  });

  it("computes the WGS84 envelope of a canonical tile", () => {
    const envelope = offlineRegionTileEnvelope({ z: 1, x: 0, y: 0 });
    expect(envelope.minX).toBe(-180);
    expect(envelope.maxX).toBe(0);
    expect(envelope.minY).toBeCloseTo(0, 10);
    expect(envelope.maxY).toBeCloseTo(85.051129, 5);
    expect(envelope.crs).toBe("EPSG:4326");
  });

  it("accepts an OGC tile-matrix alias for the same coordinate", () => {
    expect(offlineRegionTileSelector({ tileMatrix: 1, tileCol: 0, tileRow: 0 })).toEqual(
      offlineRegionTileSelector({ z: 1, x: 0, y: 0 }),
    );
  });
});

describe("offline region tile reads", () => {
  it("serves stored tile bytes verbatim with provenance and attribution", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionTile(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      tile: { z: 1, x: 0, y: 0 },
      now: NOW,
    });
    expect(read.resourceKind).toBe("tile");
    expect(read.tile).toEqual({ z: 1, x: 0, y: 0 });
    expect([...read.bytes]).toEqual([...TILE_BYTES]);
    expect(read.contentType).toBe("application/vnd.mapbox-vector-tile");
    expect(read.regionId).toBe(snapshot.manifest.id);
    expect(read.attribution).toEqual({ fixture: "Honua deterministic tile fixture" });
    expect(read.provenance).toMatchObject({
      sourceId: "incidents",
      sourceVersion: "source-v3",
      schemaVersion: "schema-v7",
      planVersion: "plan-v2",
      observation: { state: "cached", observedAt: OBSERVED_AT },
    });
    expect(read.cache).toMatchObject({
      action: "reuse",
      state: "offline",
      freshness: "fresh",
      completeness: "complete",
      regionId: snapshot.manifest.id,
    });
    expect(read.cache.resources.map((resource) => resource.kind)).toEqual(["tile"]);
    expect(read.planCache).toEqual({
      policy: "prefer-cache",
      freshness: "fresh",
      validator: { kind: "fingerprint", fingerprint: snapshot.manifest.id },
    });
  });

  it("never presents a cached tile as a live one", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionTile(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      tile: { z: 1, x: 0, y: 0 },
      now: NOW,
    });
    expect(read.degraded).toHaveLength(1);
    expect(read.degraded[0]).toMatchObject({ capability: "tiles", sourceId: "incidents" });
    expect(read.degraded[0]?.reason).toContain("cached snapshot, not a live read");
    expect(read.degraded[0]?.reason).toContain(snapshot.manifest.id);
  });

  it("addresses one stored tile through equivalent coordinates", async () => {
    const { snapshot, store } = await persisted();
    const read = async (tile: { z: number; x: number; y: number }, scheme?: "xyz" | "tms") =>
      readOfflineRegionTile(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        tile,
        ...(scheme ? { scheme } : {}),
        now: NOW,
      });
    const wrapped = await read({ z: 1, x: 2, y: 0 });
    const tms = await read({ z: 1, x: 0, y: 1 }, "tms");
    expect([...wrapped.bytes]).toEqual([...TILE_BYTES]);
    expect([...tms.bytes]).toEqual([...TILE_BYTES]);
    expect(tms.resourceId).toBe(wrapped.resourceId);
  });

  it("returns caller-owned bytes", async () => {
    const { snapshot, store } = await persisted();
    const options = {
      store,
      authorizationScopeFingerprint: SCOPE,
      tile: { z: 1, x: 0, y: 0 },
      now: NOW,
    } as const;
    const first = await readOfflineRegionTile(snapshot.manifest, options);
    first.bytes[0] = 0;
    const second = await readOfflineRegionTile(snapshot.manifest, options);
    expect([...second.bytes]).toEqual([...TILE_BYTES]);
  });

  it("reports a zoom the region never captured as out of region", async () => {
    const { snapshot, store } = await persisted();
    for (const z of [0, 4]) {
      await expect(
        readOfflineRegionTile(snapshot.manifest, {
          store,
          authorizationScopeFingerprint: SCOPE,
          tile: { z, x: 0, y: 0 },
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "out-of-region", sdkCode: "offline.region.miss" });
    }
  });

  it("reports a tile outside the region's own extent as out of region", async () => {
    const { snapshot, store } = await persisted();
    // 1/1/1 is the south-eastern quadrant: disjoint from the stored extent.
    await expect(
      readOfflineRegionTile(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        tile: { z: 1, x: 1, y: 1 },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "out-of-region" });
  });

  it("misses rather than inventing a tile inside the extent it never stored", async () => {
    const { snapshot, store } = await persisted();
    await expect(
      readOfflineRegionTile(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        tile: { z: 2, x: 0, y: 0 },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "cache-miss", sdkCode: "offline.region.miss" });
  });

  it("makes no geometric claim about a CRS it cannot prove", async () => {
    const { snapshot, store } = await persisted({
      bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000, crs: "EPSG:2193" },
    });
    // The tile is not comparable to a projected extent, so identity alone gates
    // it: the stored tile still reads, and an unstored one is an honest miss.
    const read = await readOfflineRegionTile(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      tile: { z: 1, x: 0, y: 0 },
      now: NOW,
    });
    expect([...read.bytes]).toEqual([...TILE_BYTES]);
    await expect(
      readOfflineRegionTile(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        tile: { z: 1, x: 1, y: 1 },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "cache-miss" });
  });

  it("refuses a tile read from another authorization scope", async () => {
    const { snapshot, store } = await persisted();
    const error = (await rejection(() =>
      readOfflineRegionTile(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: "tenant:b/role:field",
        tile: { z: 1, x: 0, y: 0 },
        now: NOW,
      }),
    )) as HonuaOfflineRegionError;
    expect(error.code).toBe("scope-mismatch");
    expect(error.message).not.toContain("tenant:b");
  });

  it("refuses a tile read whose versions drifted", async () => {
    const { snapshot, store } = await persisted();
    await expect(
      readOfflineRegionTile(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        tile: { z: 1, x: 0, y: 0 },
        expect: { schemaVersion: "schema-v8" },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "out-of-region" });
  });
});

describe("offline region asset and metadata reads", () => {
  it("serves an opaque asset with its declared media type", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionAsset(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      asset: "sprite-2x.png",
      now: NOW,
    });
    expect([...read.bytes]).toEqual([...SPRITE_BYTES]);
    expect(read.contentType).toBe("image/png");
    expect(read.resourceKind).toBe("asset");
    expect(read.degraded[0]?.capability).toBe("render");
    expect(read.cache.regionId).toBe(snapshot.manifest.id);
  });

  it("parses a metadata document that declares a JSON media type", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionMetadata(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      document: "landing-page",
      now: NOW,
    });
    expect(read.document).toEqual(LANDING_PAGE);
    expect(read.resourceKind).toBe("metadata");
    expect(read.degraded[0]?.capability).toBe("query");
    expect(read.attribution).toEqual({ fixture: "Honua deterministic tile fixture" });
  });

  it("leaves a non-JSON document as bytes rather than guessing", async () => {
    const { snapshot, store } = await persisted();
    const read = await readOfflineRegionMetadata(snapshot.manifest, {
      store,
      authorizationScopeFingerprint: SCOPE,
      document: "capabilities",
      now: NOW,
    });
    expect(read.document).toBeUndefined();
    expect(new TextDecoder().decode(read.bytes)).toBe("<Capabilities/>");
  });

  it("treats a document that cannot be its declared media type as an integrity failure", async () => {
    const { snapshot, store } = await persisted();
    await expect(
      readOfflineRegionMetadata(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        document: "damaged",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "integrity-mismatch" });
  });

  it("misses when a kind does not match the stored resource", async () => {
    const { snapshot, store } = await persisted();
    await expect(
      readOfflineRegionResource(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        kind: "features",
        selector: offlineRegionMetadataSelector("landing-page"),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "cache-miss" });
  });

  it("refuses an asset key carrying request-URL shape", async () => {
    const { snapshot, store } = await persisted();
    const error = await rejection(() =>
      readOfflineRegionAsset(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        asset: "sprite@2x.png?token=secret",
        now: NOW,
      }),
    );
    expect((error as HonuaOfflineRegionError).code).toBe("invalid-manifest");
    expect((error as Error).message).not.toContain("secret");
  });

  it("refuses an aggregation on a tile read like every other offline read", async () => {
    const { snapshot, store } = await persisted();
    const error = await rejection(() =>
      readOfflineRegionTile(snapshot.manifest, {
        store,
        authorizationScopeFingerprint: SCOPE,
        tile: { z: 1, x: 0, y: 0 },
        query: { aggregation: { metrics: [{ fn: "count", field: "id" }] } },
        now: NOW,
      }),
    );
    expect(error).toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });
});

describe("offline region resource identity seam", () => {
  it("resolves the identity a host request matcher needs", async () => {
    const { snapshot } = await persisted();
    const resourceId = await resolveOfflineRegionResourceId(snapshot.manifest, {
      authorizationScopeFingerprint: SCOPE,
      kind: "tile",
      selector: offlineRegionTileSelector({ z: 1, x: 0, y: 0 }),
      now: NOW,
    });
    expect(snapshot.entries.map((entry) => entry.id)).toContain(resourceId);
    expect(resourceId.startsWith("tile/")).toBe(true);
  });

  it("serves a tile through the existing storage-backed fetch handler", async () => {
    const { snapshot, store } = await persisted();
    const resourceId = await resolveOfflineRegionResourceId(snapshot.manifest, {
      authorizationScopeFingerprint: SCOPE,
      kind: "tile",
      selector: offlineRegionTileSelector({ z: 1, x: 0, y: 0 }),
      now: NOW,
    });
    const handler = createOfflineRegionFetchHandler({
      store,
      regionId: snapshot.manifest.id,
      match: (request) => (new URL(request.url).pathname === "/tiles/1/0/0" ? resourceId : undefined),
      now: NOW,
    });
    const response = await handler(new Request("https://tiles.example.test/tiles/1/0/0"));
    expect(response?.status).toBe(200);
    expect([...new Uint8Array(await (response as Response).arrayBuffer())]).toEqual([...TILE_BYTES]);
    expect(response?.headers.get("content-type")).toBe("application/vnd.mapbox-vector-tile");
    expect(response?.headers.get("x-honua-offline-region")).toBe(snapshot.manifest.id);
    expect(await handler(new Request("https://tiles.example.test/tiles/9/9/9"))).toBeUndefined();
  });

  it("refuses to resolve an identity for a region another scope owns", async () => {
    const { snapshot } = await persisted();
    await expect(
      resolveOfflineRegionResourceId(snapshot.manifest, {
        authorizationScopeFingerprint: "tenant:b/role:field",
        kind: "tile",
        selector: offlineRegionTileSelector({ z: 1, x: 0, y: 0 }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "scope-mismatch" });
  });
});

describe("offline region tile protocol", () => {
  it("round-trips its own tile URL template", () => {
    expect(buildOfflineRegionTileUrlTemplate()).toBe("offline-region://default/{z}/{x}/{y}");
    expect(buildOfflineRegionTileUrlTemplate({ tileMatrixSetId: "WebMercatorQuad" })).toBe(
      "offline-region://WebMercatorQuad/{z}/{x}/{y}",
    );
    expect(parseOfflineRegionTileUrl("offline-region://default/1/0/0.pbf")).toEqual({
      tileMatrixSetId: "default",
      z: 1,
      x: 0,
      y: 0,
    });
  });

  it("refuses a tile URL that could smuggle a token", () => {
    expect(() => parseOfflineRegionTileUrl("offline-region://default/1/0/0?token=secret")).toThrowError(
      /must not carry a query/,
    );
    expect(() => parseOfflineRegionTileUrl("https://example.test/1/0/0")).toThrowError(/must start with/);
    expect(() => parseOfflineRegionTileUrl("offline-region://default/1/0")).toThrowError(/tileMatrixSetId/);
  });

  it("answers a MapLibre protocol request from the persisted region", async () => {
    const { snapshot, store } = await persisted();
    const handler = createOfflineRegionTileProtocol({
      manifest: snapshot.manifest,
      store,
      authorizationScopeFingerprint: SCOPE,
      now: NOW,
    });
    const response = await handler({ url: "offline-region://default/1/0/0.pbf" }, new AbortController());
    expect([...new Uint8Array(response.data)]).toEqual([...TILE_BYTES]);
    // The region is the cache; a second renderer cache would answer freshness and
    // eviction questions the region already answers.
    expect(response.cacheControl).toBe("no-store");
  });

  it("rejects a tile the region does not hold instead of rendering nothing", async () => {
    const { snapshot, store } = await persisted();
    const handler = createOfflineRegionTileProtocol({
      manifest: snapshot.manifest,
      store,
      authorizationScopeFingerprint: SCOPE,
      now: NOW,
    });
    await expect(handler({ url: "offline-region://default/2/0/0" })).rejects.toMatchObject({ code: "cache-miss" });
    await expect(handler({ url: "offline-region://default/1/1/1" })).rejects.toMatchObject({ code: "out-of-region" });
  });

  it("registers and disposes through a MapLibre-style registrar", async () => {
    const { snapshot, store } = await persisted();
    const registered: string[] = [];
    const removed: string[] = [];
    const registrar = {
      addProtocol: (scheme: string) => {
        registered.push(scheme);
      },
      removeProtocol: (scheme: string) => {
        removed.push(scheme);
      },
    };
    const dispose = registerOfflineRegionTileProtocol(registrar, {
      manifest: snapshot.manifest,
      store,
      authorizationScopeFingerprint: SCOPE,
      now: NOW,
    });
    expect(registered).toEqual([OFFLINE_REGION_TILE_SCHEME]);
    dispose();
    expect(removed).toEqual([OFFLINE_REGION_TILE_SCHEME]);
  });
});
