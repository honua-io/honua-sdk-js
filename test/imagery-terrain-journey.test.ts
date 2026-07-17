import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startImageryCogFixtureServer } from "../examples/imagery-cog-quickstart/mock-server.mjs";
import {
  ImageryTerrainJourney,
  type RasterSelectionIdentity,
  buildRasterCacheKey,
} from "../examples/imagery-cog-quickstart/src/journey.js";
import { HonuaClient } from "../src/index.js";

const SEARCH = {
  collectionId: "sentinel-2-l2a",
  bbox: [-158.18, 21.22, -157.7, 21.58],
  datetime: "2026-04-01T00:00:00Z/2026-05-05T23:59:59Z",
  maxCloudCover: 20,
} as const;

const ITEM_ID = "S2A_20260412T211901_OAHU_RANGE_01";

describe("Imagery and Terrain S1 journey", () => {
  let server: Awaited<ReturnType<typeof startImageryCogFixtureServer>>;

  beforeAll(async () => {
    server = await startImageryCogFixtureServer({ build: false });
  });

  afterAll(async () => {
    await server.close();
  });

  it("searches STAC and produces a truthful bounded COG range-inspection receipt", async () => {
    const journey = createJourney(server.url);
    const search = await journey.search(SEARCH);

    expect(search.sdkSurface).toBe("HonuaClient.stac().search");
    expect(search.request).toMatchObject({
      collections: ["sentinel-2-l2a"],
      bbox: SEARCH.bbox,
      datetime: SEARCH.datetime,
      filter: '"eo:cloud_cover" <= 20',
      filterLang: "cql2-text",
    });
    expect(search.numberMatched).toBe(1);
    expect(search.scenes).toHaveLength(1);
    expect(search.scenes[0]).toMatchObject({
      id: ITEM_ID,
      cloudCover: 4,
      acquiredAt: "2026-04-12T21:19:01Z",
    });
    expect(search.scenes[0]?.assets.map((asset) => asset.key)).toContain("cog");

    const inspection = await journey.inspectAsset(ITEM_ID, "cog");
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") throw new Error(`Unexpected ${inspection.status} outcome.`);

    expect(inspection.identity).toMatchObject({
      collectionId: "sentinel-2-l2a",
      itemId: ITEM_ID,
      assetKey: "cog",
      acquiredAt: "2026-04-12T21:19:01Z",
      version: "fixture-2026.04.12-v1",
    });
    expect(inspection.crs).toBe("EPSG:4326");
    expect(inspection.bands).toHaveLength(3);
    expect(inspection.bands.every((band) => band.nodata === 0 && band.resolutionMeters === 10)).toBe(true);
    expect(inspection.footprint).toHaveLength(5);
    expect(inspection.provenance).toMatchObject({
      provider: "Copernicus Sentinel-2 fixture",
      attribution: "Contains modified Copernicus Sentinel data (fixture metadata only)",
      license: "CC-BY-4.0 fixture terms",
    });
    expect(inspection.provenance.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(inspection.range).toEqual({
      sdkSurface: "HonuaClient.pipelineFetch",
      requested: "bytes=0-63",
      contentRange: expect.stringMatching(/^bytes 0-63\/\d+$/),
      bytesReceived: 64,
      totalBytes: expect.any(Number),
      acceptRangesAdvertised: true,
      tiffByteOrder: "little-endian",
    });
    expect(inspection.cache).toMatchObject({
      status: "observed",
      etag: '"oahu-range-fixture-v1"',
      cacheControl: "public, max-age=3600",
      maxAgeSeconds: 3600,
    });
    expect(inspection.cache.key).toMatch(/^raster-v1:sha256:[a-f0-9]{64}$/u);
    expect(inspection.comparison.wmsPath).toBe("/rest/services/OahuImagery/MapServer/WMS");
    expect(inspection.limitation).toContain("records direct decoding and MapLibre mounting separately");
    expect(journey.resources()).toMatchObject({ activeRequests: 0, disposed: false });
  });

  it("hashes a delimiter-safe cache identity without retaining credentials", async () => {
    const identity = (overrides: Partial<RasterSelectionIdentity> = {}): RasterSelectionIdentity => ({
      selectionId: "selection",
      collectionId: "a:b",
      itemId: "c",
      assetKey: "visual",
      assetHref: "/fixtures/oahu.tif?token=first-secret",
      version: "v1",
      ...overrides,
    });
    const first = await buildRasterCacheKey(server.url, identity(), '"etag-v1"', "sha256:fixture");
    const delimiterCollision = await buildRasterCacheKey(
      server.url,
      identity({ collectionId: "a", itemId: "b:c" }),
      '"etag-v1"',
      "sha256:fixture",
    );
    const redactedCredentialVariant = await buildRasterCacheKey(
      server.url,
      identity({ assetHref: "/fixtures/oahu.tif?token=second-secret" }),
      '"etag-v1"',
      "sha256:fixture",
    );
    const otherService = await buildRasterCacheKey(
      "https://other-service.example.test",
      identity(),
      '"etag-v1"',
      "sha256:fixture",
    );

    expect(first).toMatch(/^raster-v1:sha256:[a-f0-9]{64}$/u);
    expect(delimiterCollision).not.toBe(first);
    expect(redactedCredentialVariant).toBe(first);
    expect(otherService).not.toBe(first);
    expect(JSON.stringify({ first, delimiterCollision, redactedCredentialVariant, otherService })).not.toMatch(
      /first-secret|second-secret/u,
    );
  });

  it("accepts an exact bounded 206 when the advisory Accept-Ranges header is absent", async () => {
    const journey = createJourney(server.url);
    await journey.search(SEARCH);

    const outcome = await journey.inspectAsset(ITEM_ID, "advisory-range-cog");

    expect(outcome).toMatchObject({
      status: "ready",
      range: { requested: "bytes=0-63", bytesReceived: 64, acceptRangesAdvertised: false },
    });
  });

  it.each([
    ["credential-cog", "credentials"],
    ["cors-cog", "cors"],
    ["no-range-cog", "range"],
    ["unsupported-crs", "crs"],
    ["unsupported-format", "format"],
    ["missing-nodata", "nodata"],
  ] as const)("returns an explicit %s unsupported outcome", async (assetKey, expectedCode) => {
    const journey = createJourney(server.url);
    await journey.search(SEARCH);

    const outcome = await journey.inspectAsset(ITEM_ID, assetKey);

    expect(outcome).toMatchObject({ status: "unsupported", code: expectedCode });
    if (outcome.status === "unsupported") expect(outcome.message.length).toBeGreaterThan(20);
    expect(journey.resources().activeRequests).toBe(0);
  });

  it("rejects unsafe probe sizes before issuing a range request", () => {
    const client = new HonuaClient({ baseUrl: server.url });
    for (const rangeProbeBytes of [Number.NaN, Number.POSITIVE_INFINITY, 3, 65_537, 4.5]) {
      expect(() => new ImageryTerrainJourney({ client, rangeProbeBytes })).toThrow(/rangeProbeBytes.*safe integer/u);
    }
    expect(() => new ImageryTerrainJourney({ client, rangeProbeBytes: 65_536 })).not.toThrow();
  });

  it("validates hostile search inputs and bounds an overstated response", async () => {
    const journey = createJourney(server.url);
    const invalidRequests: Array<Parameters<ImageryTerrainJourney["search"]>[0]> = [
      { ...SEARCH, collectionId: 'sentinel-2" OR true' },
      { ...SEARCH, bbox: [-158, 21, Number.POSITIVE_INFINITY, 22] },
      { ...SEARCH, bbox: [-157, 21, -158, 22] },
      { ...SEARCH, datetime: `${SEARCH.datetime} OR true` },
      { ...SEARCH, datetime: "2026-02-31T00:00:00Z/2026-03-02T00:00:00Z" },
      { ...SEARCH, maxCloudCover: "20 OR true" as never },
      { ...SEARCH, maxCloudCover: Number.NaN },
      { ...SEARCH, limit: 101 },
    ];
    for (const request of invalidRequests) await expect(journey.search(request)).rejects.toThrow(RangeError);
    expect(journey.resources().activeRequests).toBe(0);

    const receipt = await journey.search({ ...SEARCH, collectionId: "hostile-overflow", limit: 1 });
    expect(receipt.scenes).toHaveLength(1);
    expect(receipt.numberMatched).toBe(1_000_000);
    expect(receipt.request.limit).toBe(1);
  });

  it.each(["oversized-cog", "chunked-oversized-cog"])(
    "cancels a lying oversized 206 body for %s at the hard byte ceiling",
    async (assetKey) => {
      const journey = createJourney(server.url);
      await journey.search(SEARCH);

      const outcome = await journey.inspectAsset(ITEM_ID, assetKey);

      expect(outcome).toMatchObject({ status: "unsupported", code: "range" });
      if (outcome.status !== "unsupported") throw new Error(`Unexpected ${outcome.status} outcome.`);
      expect(outcome.message).toContain("hard 64-byte body ceiling");
      expect(journey.resources().activeRequests).toBe(0);
    },
  );

  it("redacts and rejects signed-query and userinfo asset credentials", async () => {
    const journey = createJourney(server.url);
    const search = await journey.search(SEARCH);
    const scene = search.scenes[0];
    const signed = scene?.assets.find((asset) => asset.key === "credential-cog");
    const userinfo = scene?.assets.find((asset) => asset.key === "userinfo-cog");

    expect(signed?.href).toContain("%5Bredacted%5D");
    expect(signed?.href).not.toContain("fixture-super-secret");
    expect(userinfo?.href).not.toContain("fixture-user");
    expect(userinfo?.href).not.toContain("fixture-password");
    const outcomes = await Promise.all([
      journey.inspectAsset(ITEM_ID, "credential-cog"),
      journey.inspectAsset(ITEM_ID, "userinfo-cog"),
    ]);
    expect(outcomes).toMatchObject([
      { status: "unsupported", code: "credentials" },
      { status: "unsupported", code: "credentials" },
    ]);
    const receiptText = JSON.stringify({ search, outcomes });
    expect(receiptText).not.toContain("fixture-super-secret");
    expect(receiptText).not.toContain("fixture-user");
    expect(receiptText).not.toContain("fixture-password");
  });

  it("cancels obsolete asset work and releases renderer-owned resources on switch and disposal", async () => {
    const journey = createJourney(server.url);
    await journey.search(SEARCH);
    const first = await journey.inspectAsset(ITEM_ID, "cog");
    if (first.status !== "ready") throw new Error("Expected the initial COG inspection to be ready.");

    let releases = 0;
    journey.retainRasterResource(first, () => {
      releases += 1;
    });
    expect(journey.resources().retainedRasterResource).toBe(first.identity.selectionId);

    const obsolete = journey.inspectAsset(ITEM_ID, "slow-cog");
    const replacement = journey.inspectAsset(ITEM_ID, "cog");
    const [obsoleteOutcome, replacementOutcome] = await Promise.all([obsolete, replacement]);

    expect(obsoleteOutcome).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(replacementOutcome.status).toBe("ready");
    expect(releases).toBe(1);
    expect(journey.resources().activeRequests).toBe(0);
    expect(journey.resources().retainedRasterResource).toBeUndefined();

    if (replacementOutcome.status !== "ready") throw new Error("Expected the replacement COG inspection to be ready.");
    journey.retainRasterResource(replacementOutcome, () => {
      releases += 1;
    });
    journey.dispose();
    journey.dispose();

    expect(releases).toBe(2);
    expect(journey.resources()).toEqual({ activeRequests: 0, disposed: true });
  });

  it("uses public SDK elevation and profile surfaces with provenance, cache, and nodata outcomes", async () => {
    const journey = createJourney(server.url);

    const elevation = await journey.lookupElevation([-157.9, 21.35]);
    expect(elevation).toMatchObject({
      status: "ready",
      sdkSurface: "HonuaClient.pipelineRequestJson",
      elevationMeters: 900,
      provenance: {
        source: "oahu-terrain-rgb-fixture",
        version: "dem-fixture-v1",
        attribution: "Honua deterministic Terrain-RGB fixture",
        verticalDatum: "EGM96",
        resolutionMeters: 10,
      },
      cache: {
        status: "revalidated",
        etag: '"terrain-dem-v1"',
        cacheControl: "private, max-age=60",
      },
    });

    const profile = await journey.sampleProfile(
      [
        [-157.9, 21.35],
        [-157.8, 21.45],
      ],
      { sampleCount: 4 },
    );
    expect(profile.status).toBe("ready");
    if (profile.status !== "ready") throw new Error(`Unexpected ${profile.status} profile outcome.`);
    expect(profile.sdkSurface).toBe("sampleElevationProfile + HonuaClient.pipelineRequestJson");
    expect(profile.profile.samples).toHaveLength(4);
    expect(profile.profile.samples.map((sample) => sample.elevationMeters)).toEqual([900, 950, 1000, 1050]);
    expect(profile.profile.gainMeters).toBe(150);
    expect(profile.profile.lossMeters).toBe(0);
    expect(profile.provenance.source).toBe("oahu-terrain-rgb-fixture");

    const nodata = await journey.lookupElevation([-159, 21.35]);
    expect(nodata).toMatchObject({ status: "unsupported", code: "nodata", coordinate: [-159, 21.35] });
    const profileNoData = await journey.sampleProfile(
      [
        [-159, 21.35],
        [-158.9, 21.4],
      ],
      { sampleCount: 3 },
    );
    expect(profileNoData).toMatchObject({ status: "unsupported", code: "nodata" });
    const observedOnly = await journey.lookupElevation([-157.8888, 21.35]);
    expect(observedOnly).toMatchObject({
      status: "ready",
      cache: { status: "observed", etag: '"terrain-dem-v1"' },
    });
    expect(journey.resources().activeRequests).toBe(0);
  });

  it("disposal aborts owned search, elevation, and profile work", async () => {
    const journey = createJourney(server.url);
    const search = journey.search({ ...SEARCH, collectionId: "slow-search" });
    const elevation = journey.lookupElevation([-157.7777, 21.35]);
    const profile = journey.sampleProfile(
      [
        [-157.7777, 21.35],
        [-157.7, 21.4],
      ],
      { sampleCount: 3 },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(journey.resources().activeRequests).toBe(3);

    journey.dispose();
    const [searchResult, elevationResult, profileResult] = await Promise.allSettled([search, elevation, profile]);

    expect(searchResult).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
    expect(elevationResult).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    expect(profileResult).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    expect(journey.resources()).toEqual({ activeRequests: 0, disposed: true });
  });
});

function createJourney(baseUrl: string): ImageryTerrainJourney {
  return new ImageryTerrainJourney({ client: new HonuaClient({ baseUrl }) });
}
