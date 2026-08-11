import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildFixtureCogAssets } from "../examples/imagery-cog-quickstart/fixture-cog-assets.mjs";

describe("imagery COG public fixture", () => {
  it("pins a tiled EPSG:4326 GeoTIFF with a bounded overview and exact chunk digests", () => {
    const generated = buildFixtureCogAssets();
    expect(generated.assetBytes.subarray(0, 4)).toEqual(Buffer.from([0x49, 0x49, 42, 0]));
    expect(generated.manifest.asset.crs).toBe("EPSG:4326");
    expect(generated.manifest.asset.license).toBe("CC0-1.0");
    expect(generated.manifest.asset.levels.map((level) => level.decimation)).toEqual([1, 4]);
    expect(generated.manifest.asset.levels[1].bytes).toBeLessThan(generated.manifest.asset.bytes / 4);
    expect(createHash("sha256").update(generated.assetBytes).digest("hex")).toBe(generated.manifest.asset.sha256);
    for (const chunk of generated.chunks) {
      expect(chunk.bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(createHash("sha256").update(chunk.bytes).digest("hex")).toBe(chunk.sha256);
    }
  });
  it("publishes a virtual COG href rather than a complete-object fixture", () => {
    const generated = buildFixtureCogAssets();
    const asset = generated.item.assets.cog;
    expect(asset.href).toBe("./assets/oahu-natural-color-v1.tif");
    expect(asset["file:size"]).toBe(generated.assetBytes.byteLength);
    expect(asset["checksum:multihash"]).toBe(`sha256:${generated.manifest.asset.sha256}`);
    expect(generated.chunks.reduce((total, chunk) => total + chunk.bytes.length, 0)).toBe(generated.assetBytes.length);
  });
});
