/**
 * WMS / WMTS Capabilities parser unit tests. Exercises the
 * named-element walker against representative honua-server fixtures
 * (single layer, nested layers with inherited CRS / bbox, WMTS RESTful
 * tile templates, missing optional nodes).
 */

import { describe, expect, it } from "vitest";

import {
  HonuaWmsCapabilitiesParseError,
  findWmsLayer,
  iterateWmsLayers,
  parseWmsCapabilities,
} from "../src/core/wms-capabilities.js";
import {
  HonuaWmtsCapabilitiesParseError,
  findWmtsTileMatrixSet,
  parseWmtsCapabilities,
} from "../src/core/wmts-capabilities.js";

const BASIC_WMS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink">
  <Service>
    <Name>WMS</Name>
    <Title>Honua Test Service</Title>
    <Abstract>Imagery + parcels for conformance fixtures.</Abstract>
  </Service>
  <Capability>
    <Request>
      <GetCapabilities>
        <Format>text/xml</Format>
      </GetCapabilities>
      <GetMap>
        <Format>image/png</Format>
        <Format>image/jpeg</Format>
      </GetMap>
      <GetFeatureInfo>
        <Format>application/json</Format>
        <Format>text/plain</Format>
      </GetFeatureInfo>
    </Request>
    <Layer>
      <Name>root</Name>
      <Title>Root group</Title>
      <CRS>EPSG:4326</CRS>
      <CRS>EPSG:3857</CRS>
      <CRS>CRS:84</CRS>
      <EX_GeographicBoundingBox>
        <westBoundLongitude>-180</westBoundLongitude>
        <eastBoundLongitude>180</eastBoundLongitude>
        <southBoundLatitude>-85</southBoundLatitude>
        <northBoundLatitude>85</northBoundLatitude>
      </EX_GeographicBoundingBox>
      <BoundingBox CRS="EPSG:3857" minx="-20037508" miny="-20037508" maxx="20037508" maxy="20037508"/>
      <Layer queryable="1">
        <Name>parcels</Name>
        <Title>Parcels</Title>
        <Style>
          <Name>default</Name>
          <Title>Default</Title>
          <LegendURL width="100" height="50">
            <Format>image/png</Format>
            <OnlineResource xlink:href="https://example.com/legend.png"/>
          </LegendURL>
        </Style>
        <Style>
          <Name>highlighted</Name>
          <Title>Highlighted</Title>
        </Style>
        <Dimension name="time" units="ISO8601" default="2026-01-01T00:00:00Z">
          2025-01-01T00:00:00Z,2026-01-01T00:00:00Z
        </Dimension>
      </Layer>
      <Layer>
        <Name>imagery</Name>
        <Title>Imagery</Title>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

describe("parseWmsCapabilities", () => {
  it("rejects missing root element", () => {
    expect(() => parseWmsCapabilities("<NotCapabilities/>")).toThrow(HonuaWmsCapabilitiesParseError);
  });

  it("rejects empty input", () => {
    expect(() => parseWmsCapabilities("")).toThrow(HonuaWmsCapabilitiesParseError);
  });

  it("extracts version, service metadata, and request support flags", () => {
    const caps = parseWmsCapabilities(BASIC_WMS_CAPABILITIES);
    expect(caps.version).toBe("1.3.0");
    expect(caps.service.title).toBe("Honua Test Service");
    expect(caps.service.abstract).toContain("conformance fixtures");
    expect(caps.request.getFeatureInfo).toBe(true);
    // honua-server does not advertise GetLegendGraphic; the fixture
    // mirrors that gap so the parser flag is exercised.
    expect(caps.request.getLegendGraphic).toBe(false);
  });

  it("collects request-format lists per request type", () => {
    const caps = parseWmsCapabilities(BASIC_WMS_CAPABILITIES);
    expect(caps.formats.map).toContain("image/png");
    expect(caps.formats.map).toContain("image/jpeg");
    expect(caps.formats.featureInfo).toContain("application/json");
    expect(caps.formats.legend.length).toBe(0);
  });

  it("inherits CRS, bbox, and queryable from ancestor layers", () => {
    const caps = parseWmsCapabilities(BASIC_WMS_CAPABILITIES);
    const parcels = findWmsLayer(caps, "parcels");
    expect(parcels).toBeDefined();
    expect(parcels?.crs).toEqual(expect.arrayContaining(["EPSG:4326", "EPSG:3857", "CRS:84"]));
    expect(parcels?.bbox.find((bb) => bb.crs === "EPSG:3857")).toBeDefined();
    // EX_GeographicBoundingBox synthesizes a CRS:84 entry.
    expect(parcels?.bbox.find((bb) => bb.crs === "CRS:84")).toBeDefined();
    expect(parcels?.queryable).toBe(true);
  });

  it("ignores an EX_GeographicBoundingBox outside WGS84 coordinate ranges", () => {
    const invalid = BASIC_WMS_CAPABILITIES.replace(
      "<westBoundLongitude>-180</westBoundLongitude>",
      "<westBoundLongitude>-181</westBoundLongitude>",
    );
    const caps = parseWmsCapabilities(invalid);
    const parcels = findWmsLayer(caps, "parcels");

    expect(parcels?.bbox.some((bbox) => bbox.crs === "CRS:84")).toBe(false);
    expect(caps.warnings).toContain("WMS EX_GeographicBoundingBox metadata was malformed and ignored.");
  });

  it("emits styles with optional legend URLs and titles", () => {
    const caps = parseWmsCapabilities(BASIC_WMS_CAPABILITIES);
    const parcels = findWmsLayer(caps, "parcels");
    expect(parcels?.styles).toHaveLength(2);
    expect(parcels?.styles[0]?.name).toBe("default");
    expect(parcels?.styles[0]?.legendUrl).toBe("https://example.com/legend.png");
    expect(parcels?.styles[1]?.legendUrl).toBeUndefined();
  });

  it("extracts dimensions with units, default, and discrete values", () => {
    const caps = parseWmsCapabilities(BASIC_WMS_CAPABILITIES);
    const parcels = findWmsLayer(caps, "parcels");
    expect(parcels?.dimensions).toHaveLength(1);
    const time = parcels?.dimensions[0];
    expect(time?.name).toBe("time");
    expect(time?.units).toBe("ISO8601");
    expect(time?.default).toBe("2026-01-01T00:00:00Z");
    expect(time?.values).toEqual(["2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
  });

  it("iterates named layers including children and skips container layers without a name", () => {
    const xml = BASIC_WMS_CAPABILITIES.replace("<Name>root</Name>", "");
    const caps = parseWmsCapabilities(xml);
    const names = [...iterateWmsLayers(caps)].map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(["parcels", "imagery"]));
    expect(names).not.toContain("");
  });

  it("tolerates missing optional nodes (Title / Abstract / styles)", () => {
    const minimal = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0">
  <Capability>
    <Request><GetMap><Format>image/png</Format></GetMap></Request>
    <Layer>
      <Name>only</Name>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
    const caps = parseWmsCapabilities(minimal);
    const layer = findWmsLayer(caps, "only");
    expect(layer).toBeDefined();
    expect(layer?.styles).toHaveLength(0);
    expect(layer?.dimensions).toHaveLength(0);
    expect(caps.service.title).toBeUndefined();
  });

  it("does not leak descendant Layer metadata into the parent or siblings", () => {
    // Unnamed group layer with two named children. Child `a` advertises a
    // `red` style and a `EPSG:32612` CRS; child `b` advertises neither.
    // Without the direct-child guard, the unnamed parent inherits `a`'s
    // Name / Style / CRS by scanning into the descendant subtree, then
    // `mergeAncestors` propagates the leaked style and CRS down to sibling
    // `b`. This regression test pins both layers' local fields.
    const xml = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0">
  <Capability>
    <Request><GetMap><Format>image/png</Format></GetMap></Request>
    <Layer>
      <Title>Unnamed group</Title>
      <Layer queryable="1">
        <Name>a</Name>
        <Title>A</Title>
        <CRS>EPSG:32612</CRS>
        <Style><Name>red</Name></Style>
      </Layer>
      <Layer queryable="1">
        <Name>b</Name>
        <Title>B</Title>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
    const caps = parseWmsCapabilities(xml);
    const named = [...iterateWmsLayers(caps)];
    expect(named.map((l) => l.name).sort()).toEqual(["a", "b"]);

    const a = findWmsLayer(caps, "a");
    const b = findWmsLayer(caps, "b");
    expect(a?.styles.map((s) => s.name)).toEqual(["red"]);
    expect(a?.crs).toContain("EPSG:32612");

    // The sibling must NOT inherit `a`'s style or CRS.
    expect(b?.styles).toEqual([]);
    expect(b?.crs).not.toContain("EPSG:32612");

    // The unnamed group must not synthesize a name from its child.
    const root = caps.layers[0];
    expect(root?.name).toBe("");
    expect(root?.title).toBe("Unnamed group");
    expect(root?.styles).toEqual([]);
    expect(root?.crs).toEqual([]);
  });

  it("decodes XML entities in element text", () => {
    const xml = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0">
  <Service><Title>Honua &amp; Co</Title></Service>
  <Capability>
    <Request><GetMap><Format>image/png</Format></GetMap></Request>
    <Layer><Name>x</Name></Layer>
  </Capability>
</WMS_Capabilities>`;
    const caps = parseWmsCapabilities(xml);
    expect(caps.service.title).toBe("Honua & Co");
  });

  it("rejects duplicate request operation metadata", () => {
    const duplicate = BASIC_WMS_CAPABILITIES.replace(
      "</GetMap>",
      "</GetMap><GetMap><Format>image/png</Format></GetMap>",
    );

    expect(() => parseWmsCapabilities(duplicate)).toThrow(HonuaWmsCapabilitiesParseError);
  });
});

const BASIC_WMTS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities version="1.0.0"
  xmlns="http://www.opengis.net/wmts/1.0"
  xmlns:ows="http://www.opengis.net/ows/1.1"
  xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:ServiceIdentification>
    <ows:Title>Honua Test WMTS</ows:Title>
    <ows:Abstract>Single-layer fixture.</ows:Abstract>
  </ows:ServiceIdentification>
  <Contents>
    <Layer>
      <ows:Title>Imagery</ows:Title>
      <ows:Identifier>imagery</ows:Identifier>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>-180 -85</ows:LowerCorner>
        <ows:UpperCorner>180 85</ows:UpperCorner>
      </ows:WGS84BoundingBox>
      <Style isDefault="true">
        <ows:Title>Default</ows:Title>
        <ows:Identifier>default</ows:Identifier>
      </Style>
      <Format>image/png</Format>
      <TileMatrixSetLink>
        <TileMatrixSet>WebMercatorQuad</TileMatrixSet>
      </TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile"
        template="https://example.com/wmts/imagery/default/WebMercatorQuad/{TileMatrix}/{TileRow}/{TileCol}.png"/>
      <ResourceURL format="application/json" resourceType="FeatureInfo"
        template="https://example.com/wmts/imagery/default/WebMercatorQuad/{TileMatrix}/{TileRow}/{TileCol}/{J}/{I}.json"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>WebMercatorQuad</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      <WellKnownScaleSet>urn:ogc:def:wkss:OGC:1.0:GoogleMapsCompatible</WellKnownScaleSet>
      <TileMatrix>
        <ows:Identifier>0</ows:Identifier>
        <ScaleDenominator>559082264.0287178</ScaleDenominator>
        <TopLeftCorner>-20037508.3427892 20037508.3427892</TopLeftCorner>
        <TileWidth>256</TileWidth>
        <TileHeight>256</TileHeight>
        <MatrixWidth>1</MatrixWidth>
        <MatrixHeight>1</MatrixHeight>
      </TileMatrix>
      <TileMatrix>
        <ows:Identifier>1</ows:Identifier>
        <ScaleDenominator>279541132.0143589</ScaleDenominator>
        <TopLeftCorner>-20037508.3427892 20037508.3427892</TopLeftCorner>
        <TileWidth>256</TileWidth>
        <TileHeight>256</TileHeight>
        <MatrixWidth>2</MatrixWidth>
        <MatrixHeight>2</MatrixHeight>
      </TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;

describe("parseWmtsCapabilities", () => {
  it("rejects empty / missing root", () => {
    expect(() => parseWmtsCapabilities("")).toThrow(HonuaWmtsCapabilitiesParseError);
    expect(() => parseWmtsCapabilities("<NotCapabilities/>")).toThrow(HonuaWmtsCapabilitiesParseError);
  });

  it("rejects duplicate operation metadata", () => {
    const duplicate = BASIC_WMTS_CAPABILITIES.replace(
      "<Contents>",
      `<ows:OperationsMetadata>
        <ows:Operation name="GetTile"/>
        <ows:Operation name="GetTile"/>
      </ows:OperationsMetadata>
      <Contents>`,
    );

    expect(() => parseWmtsCapabilities(duplicate)).toThrow(HonuaWmtsCapabilitiesParseError);
  });

  it("collects layer metadata, formats, styles, and TMS links", () => {
    const caps = parseWmtsCapabilities(BASIC_WMTS_CAPABILITIES);
    expect(caps.version).toBe("1.0.0");
    expect(caps.service.title).toBe("Honua Test WMTS");
    expect(caps.layers).toHaveLength(1);
    const layer = caps.layers[0]!;
    expect(layer.identifier).toBe("imagery");
    expect(layer.formats).toContain("image/png");
    expect(layer.styles[0]?.identifier).toBe("default");
    expect(layer.styles[0]?.isDefault).toBe(true);
    expect(layer.tileMatrixSetIds).toEqual(["WebMercatorQuad"]);
    expect(layer.bbox).toEqual({ west: -180, south: -85, east: 180, north: 85 });
  });

  it("ignores WGS84 bounds outside geographic ranges", () => {
    const invalid = BASIC_WMTS_CAPABILITIES.replace(
      "<ows:LowerCorner>-180 -85</ows:LowerCorner>",
      "<ows:LowerCorner>-181 -85</ows:LowerCorner>",
    );
    const caps = parseWmtsCapabilities(invalid);

    expect(caps.layers[0]?.bbox).toBeUndefined();
    expect(caps.warnings).toContain("WMTS WGS84BoundingBox metadata was malformed and ignored.");
  });

  it("reports malformed Style and Dimension boolean metadata", () => {
    const invalid = BASIC_WMTS_CAPABILITIES.replace('isDefault="true"', 'isDefault="yes"').replace(
      "<TileMatrixSetLink>",
      `<Dimension>
        <ows:Identifier>time</ows:Identifier>
        <Current>sometimes</Current>
        <Value>2026-07-16</Value>
      </Dimension>
      <TileMatrixSetLink>`,
    );
    const caps = parseWmtsCapabilities(invalid);

    expect(caps.layers[0]?.styles[0]?.isDefault).toBe(false);
    expect(caps.layers[0]?.dimensions[0]?.current).toBe(false);
    expect(caps.warnings).toEqual(
      expect.arrayContaining([
        "WMTS Style isDefault metadata was malformed and treated as false.",
        "WMTS Dimension Current metadata was malformed and treated as false.",
      ]),
    );
  });

  it("captures RESTful tile and FeatureInfo templates", () => {
    const caps = parseWmtsCapabilities(BASIC_WMTS_CAPABILITIES);
    const layer = caps.layers[0]!;
    expect(layer.resourceTemplates[0]?.format).toBe("image/png");
    expect(layer.resourceTemplates[0]?.template).toContain("/{TileMatrix}/{TileRow}/{TileCol}.png");
    expect(layer.featureInfoTemplates[0]?.format).toBe("application/json");
    expect(layer.featureInfoTemplates[0]?.template).toContain("/{J}/{I}.json");
  });

  it("decodes the WebMercatorQuad TMS with all matrices", () => {
    const caps = parseWmtsCapabilities(BASIC_WMTS_CAPABILITIES);
    const tms = findWmtsTileMatrixSet(caps, "WebMercatorQuad");
    expect(tms).toBeDefined();
    expect(tms?.matrices).toHaveLength(2);
    expect(tms?.matrices[0]?.tileWidth).toBe(256);
    expect(tms?.matrices[1]?.matrixWidth).toBe(2);
    expect(tms?.supportedCrs).toBe("urn:ogc:def:crs:EPSG::3857");
  });

  it.each([
    ["TileWidth", "0"],
    ["TileHeight", "1.5"],
    ["MatrixWidth", "9007199254740992"],
    ["MatrixHeight", "Infinity"],
    ["ScaleDenominator", "0"],
  ] as const)("ignores a tile matrix with invalid %s value %s", (field, value) => {
    const invalid = BASIC_WMTS_CAPABILITIES.replace(
      new RegExp(`<${field}>[^<]+</${field}>`),
      `<${field}>${value}</${field}>`,
    );
    const caps = parseWmtsCapabilities(invalid);
    const tms = findWmtsTileMatrixSet(caps, "WebMercatorQuad");

    expect(tms?.matrices.map((matrix) => matrix.identifier)).toEqual(["1"]);
    expect(caps.warnings).toContain("WMTS TileMatrix metadata with invalid numeric fields was ignored.");
  });
});
