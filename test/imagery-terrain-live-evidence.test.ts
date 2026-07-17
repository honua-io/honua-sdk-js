import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  IMAGERY_TERRAIN_LIVE_PRODUCER_ARTIFACT,
  IMAGERY_TERRAIN_LIVE_TARGET,
  collectImageryTerrainLiveEvidence,
  validatePinnedLiveUrl,
} from "../scripts/imagery-terrain-live-evidence.mjs";
import { validateEvidenceEnvelope } from "../scripts/sample-contract.mjs";

const PACKAGE_JSON = { name: "@honua/sdk-js", version: "0.1.0-beta.0" };
const SOURCE_REVISION = "1".repeat(40);
const OBSERVED_AT = Date.parse("2026-07-16T18:00:00.000Z");

function pinnedItem() {
  return {
    id: IMAGERY_TERRAIN_LIVE_TARGET.itemId,
    collection: IMAGERY_TERRAIN_LIVE_TARGET.collectionId,
    bbox: [...IMAGERY_TERRAIN_LIVE_TARGET.bbox],
    properties: {
      datetime: IMAGERY_TERRAIN_LIVE_TARGET.acquiredAt,
      "proj:epsg": IMAGERY_TERRAIN_LIVE_TARGET.epsg,
      "eo:cloud_cover": IMAGERY_TERRAIN_LIVE_TARGET.cloudCover,
    },
    assets: {
      visual: {
        href: IMAGERY_TERRAIN_LIVE_TARGET.assetUrl,
        type: IMAGERY_TERRAIN_LIVE_TARGET.mediaType,
        roles: ["visual"],
        "proj:shape": [10_980, 10_980],
        "proj:transform": [10, 0, 600_000, 0, -10, 2_400_000],
        "eo:bands": [{ common_name: "red" }, { common_name: "green" }, { common_name: "blue" }],
      },
    },
    links: [{ rel: "license", href: IMAGERY_TERRAIN_LIVE_TARGET.licenseUrl }],
  };
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      "access-control-allow-origin": "*",
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/geo+json",
      ...headers,
    },
  });
}

function rangeResponse(options: { status?: number; headers?: Record<string, string>; bytes?: number } = {}) {
  const bytes = new Uint8Array(options.bytes ?? 64);
  bytes.set([0x49, 0x49, 0x2a, 0x00]);
  return new Response(bytes, {
    status: options.status ?? 206,
    headers: {
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(bytes.byteLength),
      "content-range": `bytes 0-63/${IMAGERY_TERRAIN_LIVE_TARGET.objectBytes}`,
      "content-type": IMAGERY_TERRAIN_LIVE_TARGET.mediaType,
      etag: IMAGERY_TERRAIN_LIVE_TARGET.etag,
      "last-modified": IMAGERY_TERRAIN_LIVE_TARGET.lastModified,
      ...options.headers,
    },
  });
}

function liveOptions(fetchImpl: typeof fetch) {
  return {
    env: { HONUA_SAMPLE_LIVE_ENABLED: "true", HONUA_SAMPLE_SOURCE_REVISION: SOURCE_REVISION },
    fetchImpl,
    packageJson: PACKAGE_JSON,
    now: () => OBSERVED_AT,
  };
}

describe("Imagery and Terrain live evidence", () => {
  it("is opt-in and skips without touching the network", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const evidence = await collectImageryTerrainLiveEvidence({
      env: {},
      fetchImpl,
      packageJson: PACKAGE_JSON,
      now: () => OBSERVED_AT,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      sampleId: "imagery-cog-quickstart",
      lane: "live",
      status: "skipped",
      authMode: "anonymous",
      degradation: { state: "unavailable" },
    });
  });

  it("qualifies the exact STAC item and bounded COG response while exposing the browser header gap", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pinnedItem()))
      .mockResolvedValueOnce(rangeResponse());

    const evidence = await collectImageryTerrainLiveEvidence(liveOptions(fetchImpl));

    expect(evidence).toMatchObject({
      status: "executed",
      semantics: {
        outcome: "pinned-stac-cog-range-verified-browser-header-exposure-degraded",
        itemCount: 1,
      },
      degradation: { state: "expected" },
    });
    expect(evidence.semantics.assertions).toContain("unbounded-cog-gets=0");
    expect(evidence.semantics.assertions).toContain("browser-range-headers-exposed=false");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      IMAGERY_TERRAIN_LIVE_TARGET.assetUrl,
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ Range: "bytes=0-63", Origin: "https://honua.io" }),
      }),
    );
  });

  it.each([
    {
      name: "wrong item identity",
      item: { ...pinnedItem(), id: "different-item" },
      range: rangeResponse(),
      reason: "different pinned item identity",
    },
    {
      name: "unbounded response",
      item: pinnedItem(),
      range: rangeResponse({ status: 200 }),
      reason: "exact 206 is required",
    },
    {
      name: "oversized range body",
      item: pinnedItem(),
      range: rangeResponse({ bytes: 65, headers: { "content-length": "65" } }),
      reason: "exceeding the 64-byte limit",
    },
    {
      name: "missing CORS",
      item: pinnedItem(),
      range: rangeResponse({ headers: { "access-control-allow-origin": "https://other.example" } }),
      reason: "did not allow the qualification origin",
    },
  ])("fails honestly for $name", async ({ item, range, reason }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(item)).mockResolvedValueOnce(range);
    const evidence = await collectImageryTerrainLiveEvidence(liveOptions(fetchImpl));

    expect(evidence).toMatchObject({ status: "failed", degradation: { state: "unexpected" } });
    expect(evidence.reason).toContain(reason);
  });

  it("rejects signed, credentialed, redirected, and non-HTTPS target forms", () => {
    for (const url of [
      "https://example.test/data.tif?X-Amz-Signature=secret",
      "https://user:password@example.test/data.tif",
      "https://example.test/data.tif#fragment",
      "http://example.test/data.tif",
    ]) {
      expect(() => validatePinnedLiveUrl(url)).toThrow(/unsigned credential-free HTTPS/u);
    }
  });

  it("content-binds the producer and validates a successful shared envelope", async () => {
    const producerBytes = await readFile(IMAGERY_TERRAIN_LIVE_PRODUCER_ARTIFACT.path);
    expect(IMAGERY_TERRAIN_LIVE_PRODUCER_ARTIFACT.sha256).toBe(
      createHash("sha256").update(producerBytes).digest("hex"),
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pinnedItem()))
      .mockResolvedValueOnce(
        rangeResponse({
          headers: { "access-control-expose-headers": "Accept-Ranges, Content-Range, ETag" },
        }),
      );
    const evidence = await collectImageryTerrainLiveEvidence(liveOptions(fetchImpl));

    expect(evidence.degradation).toEqual({ state: "none", reasons: [] });
    expect(validateEvidenceEnvelope(evidence, { now: new Date(OBSERVED_AT).toISOString() })).toBe(evidence);
  });
});
