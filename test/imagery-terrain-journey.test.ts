import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startImageryCogFixtureServer } from "../examples/imagery-cog-quickstart/mock-server.mjs";
import { ImageryTerrainJourney } from "../examples/imagery-cog-quickstart/src/journey.js";
import { HonuaClient } from "../src/index.js";

const SEARCH = {
  collectionId: "sentinel-2-l2a",
  bbox: [-158.18, 21.22, -157.7, 21.58],
  datetime: "2026-04-01T00:00:00Z/2026-05-05T23:59:59Z",
  maxCloudCover: 20,
} as const;

const ITEM_ID = "S2A_20260412T211901_OAHU_RANGE_01";

describe("Imagery and Terrain S1 journey", () => {
  let server: { url: string; close(): Promise<void> };

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
      tiffByteOrder: "little-endian",
    });
    expect(inspection.cache).toMatchObject({
      status: "revalidated",
      etag: '"oahu-range-fixture-v1"',
      cacheControl: "public, max-age=3600",
      maxAgeSeconds: 3600,
    });
    expect(inspection.cache.key).toContain("sentinel-2-l2a");
    expect(inspection.comparison.wmsPath).toBe("/rest/services/OahuImagery/MapServer/WMS");
    expect(inspection.limitation).toContain("#537");
    expect(journey.resources()).toMatchObject({ activeRequests: 0, disposed: false });
  });

  it.each([
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
    expect(journey.resources().activeRequests).toBe(0);
  });
});

function createJourney(baseUrl: string): ImageryTerrainJourney {
  return new ImageryTerrainJourney({ client: new HonuaClient({ baseUrl }) });
}
