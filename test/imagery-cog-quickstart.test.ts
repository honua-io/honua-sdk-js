import { describe, expect, it } from "vitest";

import { HonuaImageService } from "@honua/sdk-js/honua";
import {
  clientOptionsFromImageryConfig,
  resolveImageryCogConfig,
} from "../examples/imagery-cog-quickstart/src/config.js";
import { createFixtureImageryCogDataset } from "../examples/imagery-cog-quickstart/src/fixtures.js";
import {
  activeImageryLayerCount,
  buildImageServerTileUrlTemplate,
  createImageryRenderPlan,
  normalizeSdkWmsTemplateForMapLibre,
  setImageryLayerOpacity,
  setImageryLayerVisibility,
  summarizeImageryCache,
  summarizeImageryCapabilities,
} from "../examples/imagery-cog-quickstart/src/model.js";
import { HonuaClient } from "../src/index.js";

describe("Imagery and COG Quickstart sample", () => {
  it("keeps browser configuration credential-free and same-origin", () => {
    const fixture = resolveImageryCogConfig({}, "https://demo.honua.test");
    const proxied = resolveImageryCogConfig(
      {
        VITE_HONUA_IMAGERY_BASE_URL: "/honua",
        VITE_HONUA_IMAGERY_API_KEY: "must-not-be-read",
        VITE_HONUA_IMAGERY_BEARER_TOKEN: "must-not-be-read",
      },
      "https://demo.honua.test",
    );

    expect(fixture).toEqual({ honuaBaseUrl: "https://demo.honua.test", mode: "fixture-safe" });
    expect(proxied).toEqual({ honuaBaseUrl: "https://demo.honua.test/honua", mode: "live" });
    expect(clientOptionsFromImageryConfig(proxied)).not.toHaveProperty("apiKey");
    expect(clientOptionsFromImageryConfig(proxied)).not.toHaveProperty("bearerToken");
    expect(() =>
      resolveImageryCogConfig(
        { VITE_HONUA_IMAGERY_BASE_URL: "https://credential-edge.example.test" },
        "https://demo.honua.test",
      ),
    ).toThrow(/same-origin proxy/u);
    expect(() =>
      resolveImageryCogConfig(
        { VITE_HONUA_IMAGERY_BASE_URL: "https://fixture-user:fixture-password@demo.honua.test/honua" },
        "https://demo.honua.test",
      ),
    ).toThrow(/credential-free path/u);
    expect(() =>
      resolveImageryCogConfig(
        { VITE_HONUA_IMAGERY_BASE_URL: "/honua?token=must-not-survive" },
        "https://demo.honua.test",
      ),
    ).toThrow(/credential-free path/u);
    expect(() =>
      resolveImageryCogConfig(
        { VITE_HONUA_IMAGERY_BASE_URL: `/honua/${"x".repeat(2_048)}` },
        "https://demo.honua.test",
      ),
    ).toThrow(/2048 characters/u);
  });

  it("projects WMS and COG-backed ImageServer layers into MapLibre raster sources", () => {
    const client = new HonuaClient({ baseUrl: "https://honua.example.test" });
    const plan = createImageryRenderPlan(createFixtureImageryCogDataset(), client);

    const wms = plan.layers.find((state) => state.layer.accessPath === "wms-getmap");
    const imageServer = plan.layers.find((state) => state.layer.accessPath === "image-server-tile");

    expect(wms?.sourceSpec.type).toBe("raster");
    expect(wms?.sourceSpec.tiles[0]).toContain("/rest/services/OahuImagery/MapServer/WMS?SERVICE=WMS");
    expect(wms?.sourceSpec.tiles[0]).toContain("REQUEST=GetMap");
    expect(wms?.sourceSpec.tiles[0]).toContain("LAYERS=natural_color");
    expect(wms?.sourceSpec.tiles[0]).toContain("BBOX={bbox-epsg-3857}");
    expect(wms?.sourceSpec.tiles[0]).toContain("WIDTH=256");
    expect(wms?.sourceSpec.tiles[0]).toContain("HEIGHT=256");
    expect(wms?.sourceSpec.tiles[0]).not.toMatch(/\{(?:bbox-epsg3857|width|height)\}/u);

    expect(imageServer?.sourceSpec.type).toBe("raster");
    expect(imageServer?.sourceSpec.tiles[0]).toBe(
      "https://honua.example.test/rest/services/OahuCog/ImageServer/tile/{z}/{y}/{x}?f=png",
    );
    expect(plan.auditRows.map((row) => row.sdkSurface)).toEqual([
      "client.wms().capabilities + buildWmsRasterSourceSpec + MapLibre token normalization",
      "HonuaImageService.tileUrl",
      "HonuaImageService.exportImage",
    ]);
  });

  it("normalizes only the legacy SDK WMS placeholders MapLibre cannot expand", () => {
    expect(
      normalizeSdkWmsTemplateForMapLibre({
        type: "raster",
        tiles: ["https://honua.test/wms?BBOX={bbox-epsg3857}&WIDTH={width}&HEIGHT={height}"],
        tileSize: 512,
      }).tiles[0],
    ).toBe("https://honua.test/wms?BBOX={bbox-epsg-3857}&WIDTH=512&HEIGHT=512");
  });

  it("builds ImageServer tile templates from the SDK adapter tileUrl surface", () => {
    const client = new HonuaClient({ baseUrl: "https://honua.example.test/honua/" });
    const service = new HonuaImageService({ client, serviceId: "OahuCog" });

    expect(buildImageServerTileUrlTemplate(service, "jpg")).toBe(
      "https://honua.example.test/honua/rest/services/OahuCog/ImageServer/tile/{z}/{y}/{x}?f=jpg",
    );
  });

  it("tracks cache summary and layer state without mutating the original plan", () => {
    const client = new HonuaClient({ baseUrl: "https://honua.example.test" });
    const dataset = createFixtureImageryCogDataset();
    const plan = createImageryRenderPlan(dataset, client);
    const hidden = setImageryLayerVisibility(plan, "oahu-cog-image-server", false);
    const faded = setImageryLayerOpacity(hidden, "oahu-wms-natural-color", 0.35);

    expect(summarizeImageryCache(dataset)).toBe("2 ready / 0 stale / 1 bypass");
    expect(summarizeImageryCapabilities(plan)).toBe("WMS GetMap, ImageServer tile, ImageServer export");
    expect(activeImageryLayerCount(plan)).toBe(2);
    expect(activeImageryLayerCount(hidden)).toBe(1);
    expect(faded.layers.find((state) => state.layer.id === "oahu-wms-natural-color")?.opacity).toBe(0.35);
    expect(plan.layers.find((state) => state.layer.id === "oahu-wms-natural-color")?.opacity).toBe(0.82);
  });
});
