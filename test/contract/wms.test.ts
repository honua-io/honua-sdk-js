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

describe("wms / legend gating", () => {
  // Capabilities fixture that *does* advertise GetLegendGraphic, so the
  // gated path lets the request through.
  const LEGEND_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0">
  <Service><Title>Honua WMS</Title></Service>
  <Capability>
    <Request>
      <GetMap><Format>image/png</Format></GetMap>
      <GetLegendGraphic><Format>image/png</Format></GetLegendGraphic>
    </Request>
    <Layer queryable="1"><Name>parcels</Name><Style><Name>default</Name></Style></Layer>
  </Capability>
</WMS_Capabilities>`;

  it("HonuaWms.legend throws when caller-supplied capabilities omit GetLegendGraphic", async () => {
    const client = makeMockClient({
      routes: [["MapServer/WMS", () => xmlResponse(WMS_CAPABILITIES_FIXTURE)]],
    });
    const wms = new HonuaWms({ client, serviceId: "imagery" });
    const caps = await wms.capabilities();
    await expect(wms.legend({ layer: "parcels" }, { capabilities: caps })).rejects.toThrow(
      HonuaCapabilityNotSupportedError,
    );
  });

  it("HonuaWms.legend lazy-loads capabilities and throws when the server does not advertise GetLegendGraphic", async () => {
    let capabilitiesFetches = 0;
    let legendFetches = 0;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            const request = url.searchParams.get("REQUEST");
            if (request === "GetLegendGraphic") {
              legendFetches += 1;
              return pngResponse();
            }
            capabilitiesFetches += 1;
            return xmlResponse(WMS_CAPABILITIES_FIXTURE);
          },
        ],
      ],
    });
    const wms = new HonuaWms({ client, serviceId: "imagery" });
    await expect(wms.legend({ layer: "parcels" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    // A second call reuses the cached capabilities promise — no second
    // GetCapabilities round-trip.
    await expect(wms.legend({ layer: "parcels" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    expect(capabilitiesFetches).toBe(1);
    expect(legendFetches).toBe(0);
  });

  it("HonuaWms.legend forwards the request when capabilities advertise GetLegendGraphic", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            const request = url.searchParams.get("REQUEST");
            if (request === "GetLegendGraphic") {
              observed = url.searchParams;
              return pngResponse();
            }
            return xmlResponse(LEGEND_CAPABILITIES);
          },
        ],
      ],
    });
    const wms = new HonuaWms({ client, serviceId: "imagery" });
    await wms.legend({ layer: "parcels", style: "default" });
    expect(observed?.get("REQUEST")).toBe("GetLegendGraphic");
    expect(observed?.get("LAYER")).toBe("parcels");
    expect(observed?.get("STYLE")).toBe("default");
  });

  it("HonuaWmsLayer.legend lazy-loads capabilities and throws when GetLegendGraphic is missing", async () => {
    let capabilitiesFetches = 0;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            const request = url.searchParams.get("REQUEST");
            if (request === "GetLegendGraphic") return pngResponse();
            capabilitiesFetches += 1;
            return xmlResponse(WMS_CAPABILITIES_FIXTURE);
          },
        ],
      ],
    });
    const layer = new HonuaWmsLayer({ client, serviceId: "imagery", layerName: "parcels" });
    await expect(layer.legend()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(layer.legend()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    expect(capabilitiesFetches).toBe(1);
  });

  it("HonuaWms.legend retries the capabilities fetch after a transient failure", async () => {
    let capabilitiesFetches = 0;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            const request = url.searchParams.get("REQUEST");
            if (request === "GetLegendGraphic") return pngResponse();
            capabilitiesFetches += 1;
            if (capabilitiesFetches === 1) {
              return new Response("transient", { status: 503 });
            }
            return xmlResponse(LEGEND_CAPABILITIES);
          },
        ],
      ],
    });
    const wms = new HonuaWms({ client, serviceId: "imagery" });
    await expect(wms.legend({ layer: "parcels" })).rejects.not.toThrow(HonuaCapabilityNotSupportedError);
    // The first call's failed cache entry must be cleared so the second
    // call retries the capabilities fetch (and then succeeds).
    await wms.legend({ layer: "parcels" });
    expect(capabilitiesFetches).toBeGreaterThanOrEqual(2);
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
    // WGS84 lon/lat point with no explicit spatial reference defaults
    // to CRS:84 (lon, lat axis order) per WMS 1.3.0; outSr is the
    // output SR and must not leak into the input CRS.
    expect(observed?.get("CRS")).toBe("CRS:84");
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.attributes.OBJECTID).toBe(7);
  });

  it("derives the WMS CRS from the spatial filter geometry's spatialReference", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            observed = url.searchParams;
            return jsonResponse({ type: "FeatureInfoResponse", features: [] });
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
    const source = dataset.source("parcels")!;
    // EPSG:4326 lat/lon point. outSr is the output SR (3857 here)
    // and must not be mistaken for the input CRS.
    await source.query({
      outSr: 3857,
      spatialFilter: point(38, -122, { wkid: 4326 }),
    });
    expect(observed?.get("CRS")).toBe("EPSG:4326");
    expect(observed?.get("WIDTH")).toBe("1");
    expect(observed?.get("HEIGHT")).toBe("1");
  });

  it("prefers latestWkid over wkid when both are present on the spatial reference", async () => {
    let observed: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "MapServer/WMS",
          (url) => {
            observed = url.searchParams;
            return jsonResponse({ type: "FeatureInfoResponse", features: [] });
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
    const source = dataset.source("parcels")!;
    await source.query({
      spatialFilter: point(-13624000, 4567000, { wkid: 102100, latestWkid: 3857 }),
    });
    expect(observed?.get("CRS")).toBe("EPSG:3857");
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
    // Honua Server's WMS handler reads WIDTH / HEIGHT through
    // `TryGetRequiredQueryValue` + `int.TryParse`, so the same key
    // must appear exactly once. Counting the occurrences keeps a
    // future regression that re-introduces a fixed `WIDTH=256` from
    // silently breaking GetMap dispatch.
    const widthOccurrences = url.match(/[?&]WIDTH=/g) ?? [];
    const heightOccurrences = url.match(/[?&]HEIGHT=/g) ?? [];
    expect(widthOccurrences).toHaveLength(1);
    expect(heightOccurrences).toHaveLength(1);
  });
});
