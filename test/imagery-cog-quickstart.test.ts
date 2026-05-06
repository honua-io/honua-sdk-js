import { describe, expect, it } from "vitest";

import { createFixtureImageryCogDataset } from "../examples/imagery-cog-quickstart/src/fixtures.js";
import {
  activeImageryLayerCount,
  buildImageServerTileUrlTemplate,
  createImageryRenderPlan,
  setImageryLayerOpacity,
  setImageryLayerVisibility,
  summarizeImageryCache,
  summarizeImageryCapabilities,
} from "../examples/imagery-cog-quickstart/src/model.js";
import { HonuaClient, HonuaImageService } from "../src/index.js";

describe("Imagery and COG Quickstart sample", () => {
  it("projects WMS and COG-backed ImageServer layers into MapLibre raster sources", () => {
    const client = new HonuaClient({ baseUrl: "https://honua.example.test" });
    const plan = createImageryRenderPlan(createFixtureImageryCogDataset(), client);

    const wms = plan.layers.find((state) => state.layer.accessPath === "wms-getmap");
    const imageServer = plan.layers.find((state) => state.layer.accessPath === "image-server-tile");

    expect(wms?.sourceSpec.type).toBe("raster");
    expect(wms?.sourceSpec.tiles[0]).toContain("/rest/services/OahuImagery/MapServer/WMS?SERVICE=WMS");
    expect(wms?.sourceSpec.tiles[0]).toContain("REQUEST=GetMap");
    expect(wms?.sourceSpec.tiles[0]).toContain("LAYERS=natural_color");
    expect(wms?.sourceSpec.tiles[0]).toContain("BBOX={bbox-epsg3857}");

    expect(imageServer?.sourceSpec.type).toBe("raster");
    expect(imageServer?.sourceSpec.tiles[0]).toBe(
      "https://honua.example.test/rest/services/OahuCog/ImageServer/tile/{z}/{y}/{x}?f=png",
    );
    expect(plan.auditRows.map((row) => row.sdkSurface)).toEqual([
      "client.wms().capabilities + buildWmsRasterSourceSpec",
      "HonuaImageService.tileUrl",
      "HonuaImageService.exportImage",
    ]);
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
