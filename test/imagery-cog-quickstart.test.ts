import { describe, expect, it } from "vitest";

import { HonuaImageService } from "@honua/sdk-js/honua";
import {
  clientOptionsFromImageryConfig,
  resolveImageryCogConfig,
} from "../examples/imagery-cog-quickstart/src/config.js";
import {
  fixtureImageSource,
  fixtureMapManifest,
  fixtureRasterTileUrl,
} from "../examples/imagery-cog-quickstart/src/fixture-map-protocol.js";
import {
  createFixtureCogFetch,
  fixtureCogTransportSnapshot,
} from "../examples/imagery-cog-quickstart/src/fixture-range-fetch.js";
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

  it("intercepts only exact same-origin fixture identities and supported asset methods", async () => {
    const forwarded: Array<{ method: string; url: string }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      forwarded.push({ method: request.method, url: request.url });
      return new Response("forwarded", { headers: { "x-forwarded": "true" } });
    };
    const fetchFn = createFixtureCogFetch({
      appRootUrl: new URL("https://samples.honua.test/"),
      fixtureRootUrl: new URL("https://samples.honua.test/sdk/imagery-cog-quickstart/app/fixtures/cog/"),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const assetUrl =
      "https://samples.honua.test/sdk/imagery-cog-quickstart/app/fixtures/cog/assets/oahu-natural-color-v1.tif";
    const forwardedRequests = [
      new Request(assetUrl.replace("samples.honua.test", "foreign.example.test"), { method: "GET" }),
      new Request(assetUrl.replace("/sdk/", "/lookalike/sdk/"), { method: "GET" }),
      new Request(assetUrl, { method: "POST" }),
    ];

    for (const request of forwardedRequests) {
      const response = await fetchFn(request);
      expect(response.headers.get("x-forwarded")).toBe("true");
    }
    expect(forwarded).toEqual(forwardedRequests.map(({ method, url }) => ({ method, url })));

    const fixtureHead = await fetchFn(assetUrl, { method: "HEAD" });
    expect(fixtureHead.headers.get("accept-ranges")).toBe("bytes");
    const degradedHead = await fetchFn(assetUrl.replace("oahu-natural-color-v1.tif", "unsupported-crs"), {
      method: "HEAD",
    });
    expect(degradedHead.headers.get("accept-ranges")).toBe("bytes");
    const noRange = await fetchFn(assetUrl.replace("oahu-natural-color-v1.tif", "no-range-cog"), {
      headers: { range: "bytes=0-63" },
    });
    expect(noRange.status).toBe(200);
    expect(noRange.headers.get("accept-ranges")).toBeNull();
    expect(forwarded).toHaveLength(3);
    const search = await fetchFn("https://samples.honua.test/stac/search", { method: "POST" });
    expect(await search.json()).toMatchObject({
      type: "FeatureCollection",
      features: [{ id: "oahu-natural-color-fixture-v1" }],
    });
    expect(forwarded).toHaveLength(3);
  });

  it("serves only exact bundle-local WMS, ImageServer, and elevation identities", async () => {
    const forwarded: string[] = [];
    const fetchFn = createFixtureCogFetch({
      appRootUrl: new URL("https://samples.honua.test/"),
      fixtureRootUrl: new URL("https://samples.honua.test/sdk/imagery-cog-quickstart/app/fixtures/cog/"),
      fetchImpl: (async (input: RequestInfo | URL) => {
        forwarded.push(input instanceof Request ? input.url : String(input));
        return new Response("forwarded", { headers: { "x-forwarded": "true" } });
      }) as typeof fetch,
    });

    const capabilities = await fetchFn(
      "https://samples.honua.test/rest/services/OahuImagery/MapServer/WMS?SERVICE=WMS&REQUEST=GetCapabilities",
    );
    expect(await capabilities.text()).toContain("Oahu Honua Imagery WMS");
    expect(
      await (
        await fetchFn(
          "https://samples.honua.test/stac/search?bbox=-158.18%2C21.22%2C-157.7%2C21.58&datetime=2026-04-01T00%3A00%3A00Z%2F2026-05-05T23%3A59%3A59Z&collections=sentinel-2-l2a&filter=%22eo%3Acloud_cover%22%20%3C%3D%2020&filter-lang=cql2-text&limit=20",
        )
      ).json(),
    ).toMatchObject({ features: [{ id: "oahu-natural-color-fixture-v1" }] });
    expect(
      await (await fetchFn("https://samples.honua.test/rest/services/OahuCog/ImageServer?f=json")).json(),
    ).toMatchObject({
      layers: [{ name: "oahu_sentinel2_cog" }],
    });
    expect(
      await (await fetchFn("https://samples.honua.test/rest/services/OahuCog/ImageServer/legend?f=json")).json(),
    ).toMatchObject({ layers: [{ legend: [{ label: "Sentinel-2 visual" }] }] });
    expect(
      await (await fetchFn("https://samples.honua.test/rest/services/OahuCog/ImageServer/exportImage?f=json")).json(),
    ).toMatchObject({ href: expect.stringContaining("/fixtures/cog/tiles/image-server-natural-color.png") });
    expect(
      await (
        await fetchFn(
          "https://samples.honua.test/api/v1/terrain/OahuTerrain/elevation/value?longitude=-157.9&latitude=21.35",
        )
      ).json(),
    ).toMatchObject({ elevationMeters: 900, verticalDatum: "EGM96" });

    for (const url of [
      "https://foreign.example.test/rest/services/OahuCog/ImageServer?f=json",
      "https://samples.honua.test/lookalike/rest/services/OahuCog/ImageServer?f=json",
    ]) {
      expect((await fetchFn(url)).headers.get("x-forwarded")).toBe("true");
    }
    expect(
      (await fetchFn("https://samples.honua.test/rest/services/OahuCog/ImageServer", { method: "POST" })).headers.get(
        "x-forwarded",
      ),
    ).toBe("true");
    expect(forwarded).toHaveLength(3);
    expect(fixtureCogTransportSnapshot().serviceRequests).toEqual(
      expect.arrayContaining([
        "wms-capabilities",
        "stac-search",
        "image-server-metadata",
        "image-server-legend",
        "image-server-export",
        "elevation-value",
      ]),
    );
  });

  it("publishes exact fixture-only MapLibre protocol identities", () => {
    expect(fixtureMapManifest.renderFixtures.map((fixture) => fixture.id)).toEqual([
      "wms-natural-color",
      "image-server-natural-color",
      "terrain-rgb",
    ]);
    expect(fixtureRasterTileUrl("terrain-rgb")).toBe("honua-cog-fixture://terrain-rgb/{z}/{x}/{y}");
    expect(() => fixtureRasterTileUrl("wms-natural-color")).toThrow(/unsupported raster tile fixture/u);
    expect(fixtureImageSource("wms-natural-color", new URL("https://samples.test/sdk/cog/fixtures/cog/"))).toEqual({
      type: "image",
      url: "https://samples.test/sdk/cog/fixtures/cog/tiles/wms-natural-color.png",
      coordinates: [
        [-158.22, 21.64],
        [-157.66, 21.64],
        [-157.66, 21.21],
        [-158.22, 21.21],
      ],
    });
    expect(() => fixtureImageSource("terrain-rgb", new URL("https://samples.test/"))).toThrow(
      /unsupported imagery fixture/u,
    );
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
