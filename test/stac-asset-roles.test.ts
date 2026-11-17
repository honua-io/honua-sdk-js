import { describe, expect, it } from "vitest";

import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import type { HonuaStacItemResponse } from "../src/core/types.js";
import { createDynamicStacClient } from "../src/stac/index.js";

const ITEM: HonuaStacItemResponse = {
  type: "Feature",
  id: "maui-parcels-export",
  collection: "maui-parcels",
  geometry: null,
  properties: { datetime: "2026-11-13T12:20:54Z" },
  links: [{ rel: "self", href: "https://data.example.test/maui/item.json" }],
  assets: {
    thumbnail: { href: "./preview.png", type: "image/png", roles: ["thumbnail"] },
    style: { href: "./style.json", type: "application/vnd.mapbox.style+json", roles: ["style", "default"] },
    tiles: { href: "./maui.pmtiles", type: "application/vnd.pmtiles", roles: ["visual"] },
    data: { href: "./maui.parquet", type: "application/vnd.apache.parquet", roles: ["data"] },
  },
};

describe("static STAC asset roles", () => {
  const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1" });

  it("selects the data asset, then the visual asset, never a thumbnail or style listed first", async () => {
    expect((await stac.selectAsset(ITEM)).key).toBe("data");
    expect((await stac.selectAsset(ITEM, { assetKeys: ["thumbnail", "style", "tiles"] })).key).toBe("tiles");
  });

  it("describes thumbnails and styles without handing them to a reader", async () => {
    const described = Object.fromEntries((await stac.assets(ITEM)).map((asset) => [asset.key, asset]));
    expect(described.thumbnail?.handoff).toBeUndefined();
    expect(described.style).toMatchObject({ roles: ["style", "default"], format: "unsupported" });
    await expect(stac.selectAsset(ITEM, { assetKeys: ["thumbnail", "style"] })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
  });
});
