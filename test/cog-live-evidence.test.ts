import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { runCogLiveEvidence, validateCogPublicContract } from "../scripts/cog-live-evidence.mjs";
import { validateEvidenceEnvelope } from "../scripts/sample-contract.mjs";

const contract = JSON.parse(
  fs.readFileSync(new URL("./fixtures/cog/public-earth-search-sentinel-2.json", import.meta.url), "utf8"),
);

describe("direct COG scheduled semantic evidence", () => {
  it("pins immutable STAC, byte, inspection, provenance, and freshness semantics", () => {
    expect(validateCogPublicContract(contract)).toBe(contract);
    expect(contract).toMatchObject({
      stac: {
        collectionId: "sentinel-2-l2a",
        itemId: "S2B_21WWV_20260706_0_L2A",
        assetKey: "visual",
        acquisitionAt: "2026-07-06T16:02:45.822000Z",
      },
      asset: {
        byteLength: 42_399_590,
        prefix: { offset: 0, length: 64 },
      },
      expectedInspection: {
        crs: "EPSG:32621",
        bandCount: 3,
        overviewDecimations: [2, 4, 8, 16],
      },
      freshness: { scheduledCadenceDays: 7, evidenceValidityDays: 8 },
    });
    expect(Date.parse(contract.stac.acquisitionAt)).toBeLessThan(Date.parse(contract.freshness.contractObservedAt));
  });

  it("is network-gated and produces a valid skipped envelope without touching fetch", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const evidence = await runCogLiveEvidence({
      enabled: false,
      fetchFn,
      observedAt: new Date().toISOString(),
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      format: "honua.sdk.sample-evidence.v1",
      sampleId: "imagery-cog-quickstart",
      lane: "live",
      status: "skipped",
      authMode: "anonymous",
      degradation: { state: "unavailable", reasons: ["live-network-gate-disabled"] },
      cog: {
        contractPath: "test/fixtures/cog/public-earth-search-sentinel-2.json",
        networkGate: "HONUA_COG_LIVE_ENABLED",
        scheduledOnly: true,
      },
    });
    expect(validateEvidenceEnvelope(evidence)).toBe(evidence);
  });

  it("keeps GeoTIFF.js lazy and the root, honua, and browser graphs COG-free", () => {
    const adapter = fs.readFileSync(new URL("../scripts/lib/geotiff-cog-decoder.mjs", import.meta.url), "utf8");
    const root = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const honua = fs.readFileSync(new URL("../src/honua.ts", import.meta.url), "utf8");
    const browserBuild = fs.readFileSync(new URL("../scripts/build-browser-bundle.mjs", import.meta.url), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    expect(adapter).toContain('await import("geotiff")');
    expect(adapter).not.toMatch(/^import .* from ["']geotiff["'];?$/m);
    expect(root).not.toMatch(/from ["']\.\/cog\//);
    expect(honua).not.toMatch(/from ["']\.\/cog\//);
    expect(browserBuild).toContain("assertNoDirectCogRetention");
    expect(packageJson.dependencies?.geotiff).toBeUndefined();
    expect(packageJson.peerDependencies?.geotiff).toBeUndefined();
    expect(packageJson.devDependencies.geotiff).toBe("3.0.5");
  });
});
