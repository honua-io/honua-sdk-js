/**
 * WMTS 1.0 wire + Source-adapter conformance. Exercises the
 * `GetCapabilities` parse, the RESTful and KVP `GetTile` routes, the
 * `Source.protocol("wmts" | "wmts-layer" | "wmts-tileset")` escape
 * hatches, and the MapLibre `raster` source spec emitter.
 */

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset, type SourceDescriptor } from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { HonuaWmts, HonuaWmtsLayer, HonuaWmtsTileset } from "../../src/core/wmts.js";
import { buildWmtsRasterSourceSpec } from "../../src/runtime/source-bridge.js";

import { jsonResponse, makeMockClient } from "./shared.js";

const WMTS_CAPABILITIES_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities version="1.0.0"
  xmlns="http://www.opengis.net/wmts/1.0"
  xmlns:ows="http://www.opengis.net/ows/1.1"
  xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:ServiceIdentification><ows:Title>Honua Test WMTS</ows:Title></ows:ServiceIdentification>
  <Contents>
    <Layer>
      <ows:Title>Imagery</ows:Title>
      <ows:Identifier>imagery</ows:Identifier>
      <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style>
      <Format>image/png</Format>
      <TileMatrixSetLink><TileMatrixSet>WebMercatorQuad</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile"
        template="https://example.com/wmts/imagery/default/WebMercatorQuad/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>WebMercatorQuad</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      <TileMatrix>
        <ows:Identifier>0</ows:Identifier>
        <ScaleDenominator>559082264.0287178</ScaleDenominator>
        <TopLeftCorner>-20037508.3427892 20037508.3427892</TopLeftCorner>
        <TileWidth>256</TileWidth>
        <TileHeight>256</TileHeight>
        <MatrixWidth>1</MatrixWidth>
        <MatrixHeight>1</MatrixHeight>
      </TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;

function pngResponse(): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

describe("wmts / wire", () => {
  it("parses GetCapabilities into the typed envelope", async () => {
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMTS?",
          () =>
            new Response(WMTS_CAPABILITIES_FIXTURE, {
              status: 200,
              headers: { "Content-Type": "text/xml" },
            }),
        ],
      ],
    });
    const caps = await client.wmts("imagery").capabilities();
    expect(caps.layers[0]?.identifier).toBe("imagery");
    expect(caps.tileMatrixSets[0]?.identifier).toBe("WebMercatorQuad");
  });

  it("fetches tiles through the RESTful path by default", async () => {
    let observedPath = "";
    const client = makeMockClient({
      routes: [
        [
          /MapServer\/WMTS\/imagery\/default\/WebMercatorQuad\/5\/9\/12\.png/,
          (url) => {
            observedPath = url.pathname;
            return pngResponse();
          },
        ],
      ],
    });
    const result = await client.wmts("imagery").tile({
      layer: "imagery",
      tileMatrix: 5,
      tileRow: 9,
      tileCol: 12,
    });
    expect(result.contentType).toBe("image/png");
    expect(observedPath).toContain("/imagery/default/WebMercatorQuad/5/9/12.png");
  });

  it("falls back to KVP routing when mode=kvp", async () => {
    let observed: URLSearchParams | undefined;
    let observedPath = "";
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMTS",
          (url) => {
            observed = url.searchParams;
            observedPath = url.pathname;
            return pngResponse();
          },
        ],
      ],
    });
    await client.wmts("imagery").tile({
      layer: "imagery",
      tileMatrix: 5,
      tileRow: 9,
      tileCol: 12,
      mode: "kvp",
    });
    expect(observed?.get("REQUEST")).toBe("GetTile");
    expect(observed?.get("LAYER")).toBe("imagery");
    expect(observed?.get("STYLE")).toBe("default");
    expect(observed?.get("TILEMATRIXSET")).toBe("WebMercatorQuad");
    expect(observed?.get("TILEMATRIX")).toBe("5");
    expect(observed?.get("TILEROW")).toBe("9");
    expect(observed?.get("TILECOL")).toBe("12");
    expect(observedPath).toBe("/rest/services/imagery/MapServer/WMTS");
  });

  it("decodes WMTS GetFeatureInfo JSON through the RESTful route", async () => {
    let observedPath = "";
    const client = makeMockClient({
      routes: [
        [
          /MapServer\/WMTS\/imagery\/default\/WebMercatorQuad\/3\/2\/1\/64\/128\.json/,
          (url) => {
            observedPath = url.pathname;
            return jsonResponse({
              type: "FeatureInfoResponse",
              features: [{ layer: "imagery", attributes: { px: 0.42 } }],
            });
          },
        ],
      ],
    });
    const response = await client.wmts("imagery").featureInfo<{ px: number }>({
      layer: "imagery",
      tileMatrix: 3,
      tileRow: 2,
      tileCol: 1,
      i: 128,
      j: 64,
    });
    // RESTful FeatureInfo segments are `.../{TileMatrix}/{TileRow}/{TileCol}/{J}/{I}.{ext}`.
    expect(observedPath).toContain("/imagery/default/WebMercatorQuad/3/2/1/64/128.json");
    expect(response.features?.[0]?.attributes.px).toBeCloseTo(0.42);
  });

  it("appends extraParams to the RESTful tile URL while preserving the path", async () => {
    let observedPath = "";
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          /MapServer\/WMTS\/imagery\/default\/WebMercatorQuad\/5\/9\/12\.png/,
          (url) => {
            observedPath = url.pathname;
            observed = url.searchParams;
            return pngResponse();
          },
        ],
      ],
    });
    await client.wmts("imagery").tile({
      layer: "imagery",
      tileMatrix: 5,
      tileRow: 9,
      tileCol: 12,
      // Path-encoded keys (LAYER / TILEMATRIX / etc.) must be dropped
      // by the SDK so honua-server's RESTful router never sees the
      // value twice. `time` and `apiKey` are pass-through query
      // parameters that the server preserves before dispatch.
      extraParams: { time: "2026-04-01", apiKey: "secret-token", LAYER: "ignored" },
    });
    expect(observedPath).toContain("/imagery/default/WebMercatorQuad/5/9/12.png");
    expect(observed?.get("time")).toBe("2026-04-01");
    expect(observed?.get("apiKey")).toBe("secret-token");
    expect(observed?.has("LAYER")).toBe(false);
  });

  it("appends extraParams to the RESTful GetFeatureInfo URL", async () => {
    let observedPath = "";
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          /MapServer\/WMTS\/imagery\/default\/WebMercatorQuad\/3\/2\/1\/64\/128\.json/,
          (url) => {
            observedPath = url.pathname;
            observed = url.searchParams;
            return jsonResponse({ type: "FeatureInfoResponse", features: [] });
          },
        ],
      ],
    });
    await client.wmts("imagery").featureInfo({
      layer: "imagery",
      tileMatrix: 3,
      tileRow: 2,
      tileCol: 1,
      i: 128,
      j: 64,
      extraParams: { time: "2026-04-01", INFOFORMAT: "ignored" },
    });
    expect(observedPath).toContain("/imagery/default/WebMercatorQuad/3/2/1/64/128.json");
    expect(observed?.get("time")).toBe("2026-04-01");
    expect(observed?.has("INFOFORMAT")).toBe(false);
  });
});

describe("wmts / Source adapter", () => {
  it("registers as a render-only Source with the wmts adapters wired", () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "imagery",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "imagery-tiles",
          protocol: "wmts",
          locator: {
            url: "https://mock.honua.test/rest/services/imagery/MapServer/WMTS",
            serviceId: "imagery",
            typeName: "imagery",
            styleId: "default",
            tileMatrixSetId: "WebMercatorQuad",
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wmts,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("imagery-tiles")!;
    expect(source.capabilities.has("render")).toBe(true);
    expect(source.capabilities.has("tiles")).toBe(true);
    expect(source.protocol("wmts")).toBeInstanceOf(HonuaWmts);
    expect(source.protocol("wmts-layer")).toBeInstanceOf(HonuaWmtsLayer);
    expect(source.protocol("wmts-tileset")).toBeInstanceOf(HonuaWmtsTileset);
  });

  it("Source.query() throws because WMTS GetFeatureInfo is keyed on tile pixels", async () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "imagery",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "imagery-tiles",
          protocol: "wmts",
          locator: {
            url: "https://mock.honua.test/rest/services/imagery/MapServer/WMTS",
            serviceId: "imagery",
            typeName: "imagery",
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wmts,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("imagery-tiles")!;
    await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryExtent()).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("rejects descriptors missing serviceId", () => {
    const client = makeMockClient({ routes: [] });
    expect(() =>
      createDataset({
        id: "imagery",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "imagery-tiles",
            protocol: "wmts",
            locator: { url: "https://mock/" },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wmts,
          } satisfies SourceDescriptor,
        ],
      }).source("imagery-tiles"),
    ).toThrow(/locator\.serviceId/);
  });
});

describe("wmts / MapLibre binding", () => {
  it("emits a raster source spec using the RESTful tile template", () => {
    const spec = buildWmtsRasterSourceSpec({
      id: "imagery-tiles",
      protocol: "wmts",
      locator: {
        url: "https://mock.honua.test/rest/services/imagery/MapServer/WMTS",
        serviceId: "imagery",
        typeName: "imagery",
        styleId: "default",
        tileMatrixSetId: "WebMercatorQuad",
      },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wmts,
    });
    expect(spec.type).toBe("raster");
    expect(spec.scheme).toBe("xyz");
    expect(spec.tiles[0]).toBe(
      "https://mock.honua.test/rest/services/imagery/MapServer/WMTS/imagery/default/WebMercatorQuad/{z}/{y}/{x}.png",
    );
  });
});
