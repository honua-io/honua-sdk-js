/**
 * WMS 1.3 wire + Source-adapter conformance. Exercises the
 * `GetCapabilities` parse, `GetMap` KVP serialization (including CRS
 * axis-order swap on `EPSG:4326`), `GetFeatureInfo` JSON decode through
 * `Source.query()`, and the `HonuaCapabilityNotSupportedError` paths
 * for non-point queries / aggregates / streams.
 */

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset, type SourceDescriptor } from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { HonuaWms, HonuaWmsLayer } from "../../src/core/wms.js";
import { point } from "../../src/core/spatial-filter.js";
import { buildWmsRasterSourceSpec } from "../../src/runtime/source-bridge.js";

import { jsonResponse, makeMockClient } from "./shared.js";

const WMS_CAPABILITIES_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink">
  <Service><Title>Honua Test WMS</Title></Service>
  <Capability>
    <Request>
      <GetMap><Format>image/png</Format></GetMap>
      <GetFeatureInfo><Format>application/json</Format></GetFeatureInfo>
    </Request>
    <Layer queryable="1">
      <Name>parcels</Name>
      <Title>Parcels</Title>
      <CRS>EPSG:3857</CRS>
      <CRS>EPSG:4326</CRS>
      <BoundingBox CRS="EPSG:3857" minx="-20037508" miny="-20037508" maxx="20037508" maxy="20037508"/>
      <Style><Name>default</Name></Style>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

function pngResponse(): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

describe("wms / wire", () => {
  it("parses GetCapabilities into the typed envelope", async () => {
    const client = makeMockClient({
      routes: [["MapServer/WMS", () => xmlResponse(WMS_CAPABILITIES_FIXTURE)]],
    });
    const caps = await client.wms("imagery").capabilities();
    expect(caps.version).toBe("1.3.0");
    expect(caps.layers).toHaveLength(1);
    expect(caps.layers[0]?.name).toBe("parcels");
    expect(caps.formats.map).toContain("image/png");
    expect(caps.request.getFeatureInfo).toBe(true);
    expect(caps.request.getLegendGraphic).toBe(false);
  });

  it("serializes GetMap with default CRS=EPSG:3857 and unswapped bbox", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            observed = url.searchParams;
            return pngResponse();
          },
        ],
      ],
    });
    await client.wms("imagery").map({
      layers: ["parcels"],
      styles: ["default"],
      bbox: [-13540000, 4540000, -13530000, 4550000],
      width: 256,
      height: 256,
    });
    expect(observed?.get("REQUEST")).toBe("GetMap");
    expect(observed?.get("CRS")).toBe("EPSG:3857");
    expect(observed?.get("BBOX")).toBe("-13540000,4540000,-13530000,4550000");
    expect(observed?.get("LAYERS")).toBe("parcels");
    expect(observed?.get("STYLES")).toBe("default");
    expect(observed?.get("WIDTH")).toBe("256");
    expect(observed?.get("FORMAT")).toBe("image/png");
    expect(observed?.get("TRANSPARENT")).toBe("TRUE");
  });

  it("swaps bbox axis order on EPSG:4326 per WMS 1.3 §6.7.3.2", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            observed = url.searchParams;
            return pngResponse();
          },
        ],
      ],
    });
    await client.wms("imagery").map({
      layers: ["parcels"],
      crs: "EPSG:4326",
      bbox: [-122, 37, -120, 38], // canonical [minx, miny, maxx, maxy] in lon/lat
      width: 256,
      height: 256,
    });
    // EPSG:4326 axes are (lat, lon); the wire bbox flips to lat-first.
    expect(observed?.get("BBOX")).toBe("37,-122,38,-120");
    expect(observed?.get("CRS")).toBe("EPSG:4326");
  });

  it("decodes GetFeatureInfo JSON into the canonical typed feature shape", async () => {
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            if (url.searchParams.get("REQUEST") === "GetFeatureInfo") {
              return jsonResponse({
                type: "FeatureInfoResponse",
                features: [{ layer: "parcels", attributes: { OBJECTID: 42, name: "lot-42" } }],
              });
            }
            return pngResponse();
          },
        ],
      ],
    });
    const response = await client.wms("imagery").featureInfo({
      layers: ["parcels"],
      queryLayers: ["parcels"],
      bbox: [-122, 37, -120, 38],
      width: 256,
      height: 256,
      i: 128,
      j: 128,
    });
    expect(response.contentType).toContain("application/json");
    expect(response.features).toHaveLength(1);
    expect(response.features?.[0]?.attributes).toEqual({ OBJECTID: 42, name: "lot-42" });
  });

  it("forwards TIME / ELEVATION dimensions through to the wire", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            observed = url.searchParams;
            return pngResponse();
          },
        ],
      ],
    });
    await client.wms("imagery").map({
      layers: ["parcels"],
      bbox: [-122, 37, -120, 38],
      width: 256,
      height: 256,
      time: "2026-01-01T00:00:00Z",
      elevation: "100",
    });
    expect(observed?.get("TIME")).toBe("2026-01-01T00:00:00Z");
    expect(observed?.get("ELEVATION")).toBe("100");
  });
});

describe("wms / Source adapter", () => {
  it("registers under the canonical Source surface and exposes the wms-layer adapter", () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "imagery",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels",
          protocol: "wms",
          locator: {
            url: "https://mock.honua.test/rest/services/imagery/MapServer/WMS",
            serviceId: "imagery",
            typeName: "parcels",
            styleId: "default",
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("parcels")!;
    expect(source.capabilities.has("render")).toBe(true);
    expect(source.capabilities.has("query")).toBe(true);
    expect(source.protocol("wms")).toBeInstanceOf(HonuaWms);
    expect(source.protocol("wms-layer")).toBeInstanceOf(HonuaWmsLayer);
  });

  it("translates a point spatialFilter into a 1x1 GetFeatureInfo and decodes the JSON response", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            observed = url.searchParams;
            return jsonResponse({
              type: "FeatureInfoResponse",
              features: [{ layer: "parcels", attributes: { OBJECTID: 7, name: "lot-7" } }],
            });
          },
        ],
      ],
    });
    const dataset = createDataset({
      id: "imagery",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels",
          protocol: "wms",
          locator: {
            url: "https://mock.honua.test/rest/services/imagery/MapServer/WMS",
            serviceId: "imagery",
            typeName: "parcels",
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<{ OBJECTID: number; name: string }>("parcels")!;
    const result = await source.query({ spatialFilter: point(-122, 38) });
    expect(observed?.get("REQUEST")).toBe("GetFeatureInfo");
    expect(observed?.get("WIDTH")).toBe("1");
    expect(observed?.get("HEIGHT")).toBe("1");
    expect(observed?.get("I")).toBe("0");
    expect(observed?.get("J")).toBe("0");
    expect(observed?.get("INFO_FORMAT")).toBe("application/json");
    expect(observed?.get("QUERY_LAYERS")).toBe("parcels");
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.attributes.OBJECTID).toBe(7);
  });

  it("rejects non-point spatialFilter envelopes through Source.query()", async () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "imagery",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels",
          protocol: "wms",
          locator: {
            url: "https://mock.honua.test/rest/services/imagery/MapServer/WMS",
            serviceId: "imagery",
            typeName: "parcels",
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("parcels")!;
    await expect(
      source.query({
        spatialFilter: {
          geometryType: "esriGeometryEnvelope",
          geometry: { xmin: -122, ymin: 37, xmax: -120, ymax: 38 },
        },
      }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("throws HonuaCapabilityNotSupportedError on aggregates / extent / stream / edits", async () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "imagery",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels",
          protocol: "wms",
          locator: {
            url: "https://mock.honua.test/rest/services/imagery/MapServer/WMS",
            serviceId: "imagery",
            typeName: "parcels",
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms,
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("parcels")!;
    await expect(source.queryExtent()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryAggregate({ aggregation: { metrics: [{ fn: "count", field: "*" }] } })).rejects.toThrow(
      HonuaCapabilityNotSupportedError,
    );
    await expect(source.queryObjectIds()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.applyEdits({ adds: [] })).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("wms / MapLibre binding", () => {
  it("emits a raster source spec with the MapLibre runtime placeholders", () => {
    const spec = buildWmsRasterSourceSpec({
      id: "parcels",
      protocol: "wms",
      locator: {
        url: "https://mock.honua.test/rest/services/imagery/MapServer/WMS",
        serviceId: "imagery",
        typeName: "parcels",
        styleId: "default",
      },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms,
      attribution: "© Honua",
    });
    expect(spec.type).toBe("raster");
    expect(spec.tileSize).toBe(256);
    expect(spec.attribution).toBe("© Honua");
    const url = spec.tiles[0]!;
    expect(url).toContain("REQUEST=GetMap");
    expect(url).toContain("LAYERS=parcels");
    expect(url).toContain("STYLES=default");
    expect(url).toContain("CRS=EPSG%3A3857");
    expect(url).toContain("BBOX={bbox-epsg3857}");
    expect(url).toContain("WIDTH={width}");
    expect(url).toContain("HEIGHT={height}");
  });
});
