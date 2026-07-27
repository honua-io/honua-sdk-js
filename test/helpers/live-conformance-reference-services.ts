/**
 * Deterministic stand-ins for the public reference services pinned by
 * `config/live-conformance-endpoints.v1.json`.
 *
 * The scheduled live-conformance lane is the only thing that talks to the real
 * servers. This helper lets the always-on unit lane drive the same runner over
 * the same URL space with zero network access, so the runner's own contracts —
 * budgets, redaction, typed degradation, and the semantic assertions — are
 * regression-tested on every commit.
 *
 * Where a real response body was already recorded for
 * `test/contract/*-backend-agnostic.test.ts`, it is reused verbatim; the rest
 * are minimal documents shaped like the live originals (verified against them
 * while the manifest was reviewed).
 */

import fs from "node:fs";

type RouteHandler = (url: URL, request: Request) => Response;

export interface ReferenceServiceOptions {
  /** Replace or remove individual routes to model drift, outages, or rot. */
  readonly overrides?: Readonly<Record<string, RouteHandler | null>>;
  /** Observe every request the SDK makes (already same-origin filtered). */
  readonly onRequest?: (url: URL, request: Request) => void;
  /** Extra latency, in ms, before every response resolves. */
  readonly delayMs?: number;
}

function readRecordedFixture(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/${relativePath}`, import.meta.url), "utf8"));
}

function json(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": `${contentType}; charset=utf-8` },
  });
}

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8" } });
}

function image(bytes: Uint8Array, mediaType: string, status = 200): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status, headers: { "content-type": mediaType } });
}

/** A 1x1 PNG. Only the signature and byte count matter to the runner. */
export const REFERENCE_TILE_PNG: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** A JFIF header plus end-of-image marker. */
export const REFERENCE_TILE_JPEG: Uint8Array = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0xff, 0xd9,
]);

/** Minimal non-empty Mapbox Vector Tile payload for protocol-operation evidence. */
export const REFERENCE_TILE_MVT: Uint8Array = new Uint8Array([0x1a, 0x05, 0x78, 0x02, 0x0a, 0x01, 0x6e]);

// ── GeoServices (Esri sample server 6) ────────────────────────

const GEOSERVICES_LAYER = Object.freeze({
  currentVersion: 10.91,
  id: 0,
  name: "Requests",
  type: "Feature Layer",
  geometryType: "esriGeometryPoint",
  capabilities: "Query,Create,Update,Delete,Uploads,Editing",
  supportedQueryFormats: "JSON, geoJSON, PBF",
  hasAttachments: true,
  supportsStatistics: true,
  supportsAdvancedQueries: true,
  useStandardizedQueries: true,
  objectIdField: "objectid",
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsStatistics: true,
    supportsReturningQueryExtent: true,
    supportsOrderBy: true,
    supportsDistinct: true,
    supportsSqlExpression: true,
  },
  extent: {
    xmin: -13_050_000,
    ymin: 3_850_000,
    xmax: -13_020_000,
    ymax: 3_875_000,
    spatialReference: { wkid: 102_100, latestWkid: 3857 },
  },
  fields: [
    { name: "objectid", type: "esriFieldTypeOID", alias: "OBJECTID" },
    { name: "requesttype", type: "esriFieldTypeString", alias: "Request type", length: 64 },
    { name: "severity", type: "esriFieldTypeSmallInteger", alias: "Severity" },
    { name: "status", type: "esriFieldTypeString", alias: "Status", length: 32 },
  ],
});

const GEOSERVICES_QUERY = Object.freeze({
  objectIdFieldName: "objectid",
  globalIdFieldName: "globalid",
  geometryType: "esriGeometryPoint",
  spatialReference: { wkid: 102_100, latestWkid: 3857 },
  fields: GEOSERVICES_LAYER.fields,
  features: [
    {
      attributes: { objectid: 1, requesttype: "Pothole", severity: 2, status: "Open" },
      geometry: { x: -13_042_000, y: 3_862_000 },
    },
  ],
  exceededTransferLimit: true,
});

// ── OGC API Features (pygeoapi + ldproxy) ─────────────────────

const PYGEOAPI_LANDING = readRecordedFixture("backend-agnostic/pygeoapi/landing.json");
const PYGEOAPI_CONFORMANCE = readRecordedFixture("backend-agnostic/pygeoapi/conformance.json");
const PYGEOAPI_COLLECTION = readRecordedFixture("backend-agnostic/pygeoapi/collection-lakes.json");
const PYGEOAPI_ITEMS = readRecordedFixture("backend-agnostic/pygeoapi/items-lakes.json");
const PYGEOAPI_RECORD_COLLECTION = Object.freeze({
  id: "dutch-metadata",
  title: "Dutch metadata records",
  description: "Metadata catalog published by the pygeoapi demo.",
  itemType: "record",
  crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
});
const PYGEOAPI_RECORD_ITEMS = Object.freeze({
  type: "FeatureCollection",
  numberMatched: 1,
  features: [
    {
      type: "Feature",
      id: "dutch-metadata-1",
      geometry: { type: "Point", coordinates: [5.12, 52.09] },
      properties: {
        created: "2025-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        type: "dataset",
        title: "Dutch reference dataset",
        description: "Deterministic catalog record for the live runner.",
      },
    },
  ],
  links: [],
});
const PYGEOAPI_MAP_COLLECTION = Object.freeze({
  id: "mapserver_world_map",
  title: "MapServer world map",
  description: "World map rendered through pygeoapi's OGC API Maps provider.",
  itemType: "map",
  crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
});
const PYGEOAPI_PROCESSES = Object.freeze({
  processes: [
    {
      id: "hello-world",
      title: "Hello World",
      description: "Deterministic process-discovery reference.",
      version: "0.2.0",
    },
  ],
  links: [],
});
const PYGEOAPI_COLLECTIONS = Object.freeze([PYGEOAPI_COLLECTION, PYGEOAPI_RECORD_COLLECTION, PYGEOAPI_MAP_COLLECTION]);

const LDPROXY_LANDING = readRecordedFixture("backend-agnostic/ldproxy/landing.json");
const LDPROXY_ITEMS = readRecordedFixture("backend-agnostic/ldproxy/items-vineyards.json");

const LDPROXY_CONFORMANCE = Object.freeze({
  conformsTo: [
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/collections",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
    "http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter",
  ],
});

const LDPROXY_COLLECTIONS = Object.freeze({
  links: [{ rel: "self", type: "application/json", href: "https://demo.ldproxy.net/vineyards/collections?f=json" }],
  collections: [
    {
      id: "vineyards",
      title: "Vineyards",
      description: "Vineyards in Rhineland-Palatinate, Germany.",
      itemType: "feature",
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84", "http://www.opengis.net/def/crs/EPSG/0/25832"],
      storageCrs: "http://www.opengis.net/def/crs/EPSG/0/25832",
      extent: {
        spatial: { bbox: [[6.32, 49.11, 8.53, 50.24]], crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
      },
      links: [
        {
          rel: "items",
          type: "application/geo+json",
          title: "Vineyards",
          href: "https://demo.ldproxy.net/vineyards/collections/vineyards/items",
        },
      ],
    },
  ],
});

// ── STAC API (Element 84 Earth Search) ────────────────────────

const STAC_LANDING = readRecordedFixture("backend-agnostic/earth-search-stac/landing.json");
const STAC_SEARCH = readRecordedFixture("backend-agnostic/earth-search-stac/search.json");

const STAC_COLLECTIONS = Object.freeze({
  collections: [
    {
      type: "Collection",
      stac_version: "1.0.0",
      id: "sentinel-2-l2a",
      title: "Sentinel-2 Level-2A",
      description: "Sentinel-2 L2A surface reflectance.",
      license: "proprietary",
      extent: {
        spatial: { bbox: [[-180, -90, 180, 90]] },
        temporal: { interval: [["2015-06-27T10:25:31.456000Z", null]] },
      },
      links: [
        {
          rel: "items",
          type: "application/geo+json",
          href: "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items",
        },
        {
          rel: "self",
          type: "application/json",
          href: "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a",
        },
      ],
    },
  ],
  links: [{ rel: "self", type: "application/json", href: "https://earth-search.aws.element84.com/v1/collections" }],
});

const STAC_CONFORMANCE = Object.freeze({ conformsTo: (STAC_LANDING as { conformsTo: string[] }).conformsTo });

// ── WFS 2.0 (PDOK BAG) ────────────────────────────────────────

const WFS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1"
  xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:bag="http://bag.geostandaarden.nl/2012" version="2.0.0">
  <ows:ServiceIdentification>
    <ows:Title>BAG WFS</ows:Title>
    <ows:ServiceType>WFS</ows:ServiceType>
    <ows:ServiceTypeVersion>2.0.0</ows:ServiceTypeVersion>
    <ows:Fees>NONE</ows:Fees>
    <ows:AccessConstraints>NONE</ows:AccessConstraints>
  </ows:ServiceIdentification>
  <ows:OperationsMetadata>
    <ows:Operation name="GetCapabilities">
      <ows:DCP><ows:HTTP>
        <ows:Get xlink:href="https://service.pdok.nl/kadaster/bag/wfs/v2_0?"/>
      </ows:HTTP></ows:DCP>
    </ows:Operation>
    <ows:Operation name="DescribeFeatureType">
      <ows:DCP><ows:HTTP>
        <ows:Get xlink:href="https://service.pdok.nl/kadaster/bag/wfs/v2_0?"/>
      </ows:HTTP></ows:DCP>
    </ows:Operation>
    <ows:Operation name="GetFeature">
      <ows:DCP><ows:HTTP>
        <ows:Get xlink:href="https://service.pdok.nl/kadaster/bag/wfs/v2_0?"/>
        <ows:Post xlink:href="https://service.pdok.nl/kadaster/bag/wfs/v2_0"/>
      </ows:HTTP></ows:DCP>
      <ows:Parameter name="outputFormat">
        <ows:AllowedValues>
          <ows:Value>application/gml+xml; version=3.2</ows:Value>
          <ows:Value>application/json</ows:Value>
          <ows:Value>application/json; subtype=geojson</ows:Value>
        </ows:AllowedValues>
      </ows:Parameter>
    </ows:Operation>
    <ows:Constraint name="ImplementsResultPaging"><ows:DefaultValue>TRUE</ows:DefaultValue></ows:Constraint>
    <ows:Constraint name="CountDefault"><ows:DefaultValue>1000</ows:DefaultValue></ows:Constraint>
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>bag:woonplaats</wfs:Name>
      <wfs:Title>Woonplaats</wfs:Title>
      <wfs:DefaultCRS>urn:ogc:def:crs:EPSG::28992</wfs:DefaultCRS>
      <wfs:OtherCRS>urn:ogc:def:crs:EPSG::4326</wfs:OtherCRS>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>3.05 50.67</ows:LowerCorner>
        <ows:UpperCorner>7.24 53.56</ows:UpperCorner>
      </ows:WGS84BoundingBox>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
  <fes:Filter_Capabilities xmlns:fes="http://www.opengis.net/fes/2.0">
    <fes:Spatial_Capabilities>
      <fes:SpatialOperators>
        <fes:SpatialOperator name="BBOX"/>
        <fes:SpatialOperator name="Intersects"/>
      </fes:SpatialOperators>
    </fes:Spatial_Capabilities>
    <fes:Scalar_Capabilities>
      <fes:ComparisonOperators>
        <fes:ComparisonOperator>PropertyIsEqualTo</fes:ComparisonOperator>
        <fes:ComparisonOperator>PropertyIsLike</fes:ComparisonOperator>
      </fes:ComparisonOperators>
    </fes:Scalar_Capabilities>
  </fes:Filter_Capabilities>
</wfs:WFS_Capabilities>
`;

const WFS_GETFEATURE = Object.freeze({
  type: "FeatureCollection",
  name: "woonplaats",
  numberMatched: 2543,
  numberReturned: 1,
  crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::28992" } },
  features: [
    {
      type: "Feature",
      id: "woonplaats.5ec44fc6-0ae7-4c0e-8ca3-5487627d2d30",
      properties: { identificatie: "3386", status: "Woonplaats aangewezen", woonplaats: "Amsterdam" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [121_000, 487_000],
              [121_500, 487_000],
              [121_500, 487_500],
              [121_000, 487_500],
              [121_000, 487_000],
            ],
          ],
        ],
      },
    },
  ],
});

// ── WMS 1.3.0 (terrestris OSM) ────────────────────────────────

const WMS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
  <Service>
    <Name>WMS</Name>
    <Title>OpenStreetMap WMS</Title>
    <OnlineResource xlink:href="https://ows.terrestris.de/osm/service?"/>
  </Service>
  <Capability>
    <Request>
      <GetCapabilities>
        <Format>text/xml</Format>
        <DCPType><HTTP><Get><OnlineResource xlink:href="https://ows.terrestris.de/osm/service?"/></Get></HTTP></DCPType>
      </GetCapabilities>
      <GetMap>
        <Format>image/jpeg</Format>
        <Format>image/png</Format>
        <DCPType><HTTP><Get><OnlineResource xlink:href="https://ows.terrestris.de/osm/service?"/></Get></HTTP></DCPType>
      </GetMap>
      <GetFeatureInfo>
        <Format>text/plain</Format>
        <Format>text/html</Format>
        <Format>text/xml</Format>
        <DCPType><HTTP><Get><OnlineResource xlink:href="https://ows.terrestris.de/osm/service?"/></Get></HTTP></DCPType>
      </GetFeatureInfo>
    </Request>
    <Layer>
      <Title>OpenStreetMap WMS</Title>
      <CRS>EPSG:4326</CRS>
      <CRS>EPSG:3857</CRS>
      <CRS>CRS:84</CRS>
      <EX_GeographicBoundingBox>
        <westBoundLongitude>-180</westBoundLongitude>
        <southBoundLatitude>-88</southBoundLatitude>
        <eastBoundLongitude>180</eastBoundLongitude>
        <northBoundLatitude>88</northBoundLatitude>
      </EX_GeographicBoundingBox>
      <Layer queryable="false">
        <Name>OSM-WMS</Name>
        <Title>OpenStreetMap WMS - by terrestris</Title>
        <CRS>EPSG:3857</CRS>
        <Style>
          <Name>default</Name>
          <Title>default</Title>
          <LegendURL width="150" height="200">
            <Format>image/png</Format>
            <OnlineResource xlink:href="https://ows.terrestris.de/osm/service?styles=&amp;layer=OSM-WMS"/>
          </LegendURL>
        </Style>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>
`;

// ── WMTS 1.0.0 (ArcGIS Online World Street Map) ───────────────

const WMTS_BASE = "https://services.arcgisonline.com/arcgis/rest/services/World_Street_Map/MapServer/WMTS";

const WMTS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities version="1.0.0" xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1"
  xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:ServiceIdentification>
    <ows:Title>World_Street_Map</ows:Title>
    <ows:ServiceType>OGC WMTS</ows:ServiceType>
    <ows:ServiceTypeVersion>1.0.0</ows:ServiceTypeVersion>
  </ows:ServiceIdentification>
  <ows:OperationsMetadata>
    <ows:Operation name="GetCapabilities">
      <ows:DCP><ows:HTTP><ows:Get xlink:href="${WMTS_BASE}/1.0.0/WMTSCapabilities.xml"/></ows:HTTP></ows:DCP>
    </ows:Operation>
    <ows:Operation name="GetTile">
      <ows:DCP><ows:HTTP><ows:Get xlink:href="${WMTS_BASE}/tile/1.0.0/"/></ows:HTTP></ows:DCP>
    </ows:Operation>
  </ows:OperationsMetadata>
  <Contents>
    <Layer>
      <ows:Title>World_Street_Map</ows:Title>
      <ows:Identifier>World_Street_Map</ows:Identifier>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>-179.99999550841463 -88.99999992161116</ows:LowerCorner>
        <ows:UpperCorner>179.99999550841463 88.99999992161116</ows:UpperCorner>
      </ows:WGS84BoundingBox>
      <Style isDefault="true">
        <ows:Title>Default Style</ows:Title>
        <ows:Identifier>default</ows:Identifier>
      </Style>
      <Format>image/jpeg</Format>
      <TileMatrixSetLink><TileMatrixSet>default028mm</TileMatrixSet></TileMatrixSetLink>
      <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/jpeg" resourceType="tile"
        template="${WMTS_BASE}/tile/1.0.0/World_Street_Map/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>GoogleMapsCompatible</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG:6.18.3:3857</ows:SupportedCRS>
      <WellKnownScaleSet>urn:ogc:def:wkss:OGC:1.0:GoogleMapsCompatible</WellKnownScaleSet>
      <TileMatrix>
        <ows:Identifier>0</ows:Identifier>
        <ScaleDenominator>559082264.0287178</ScaleDenominator>
        <TopLeftCorner>-20037508.34278845 20037508.34278845</TopLeftCorner>
        <TileWidth>256</TileWidth><TileHeight>256</TileHeight>
        <MatrixWidth>1</MatrixWidth><MatrixHeight>1</MatrixHeight>
      </TileMatrix>
      <TileMatrix>
        <ows:Identifier>1</ows:Identifier>
        <ScaleDenominator>279541132.0143589</ScaleDenominator>
        <TopLeftCorner>-20037508.34278845 20037508.34278845</TopLeftCorner>
        <TileWidth>256</TileWidth><TileHeight>256</TileHeight>
        <MatrixWidth>2</MatrixWidth><MatrixHeight>2</MatrixHeight>
      </TileMatrix>
    </TileMatrixSet>
    <TileMatrixSet>
      <ows:Identifier>default028mm</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      <TileMatrix>
        <ows:Identifier>0</ows:Identifier>
        <ScaleDenominator>591657527.591555</ScaleDenominator>
        <TopLeftCorner>-20037508.34278845 20037508.34278845</TopLeftCorner>
        <TileWidth>256</TileWidth><TileHeight>256</TileHeight>
        <MatrixWidth>1</MatrixWidth><MatrixHeight>1</MatrixHeight>
      </TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>
`;

// ── OData v4 (OASIS Northwind reference service) ──────────────

const ODATA_METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="NorthwindModel" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Customer">
        <Key><PropertyRef Name="CustomerID"/></Key>
        <Property Name="CustomerID" Type="Edm.String" Nullable="false" MaxLength="5"/>
        <Property Name="CompanyName" Type="Edm.String" Nullable="false" MaxLength="40"/>
        <Property Name="ContactName" Type="Edm.String" MaxLength="30"/>
        <Property Name="City" Type="Edm.String" MaxLength="15"/>
        <Property Name="Country" Type="Edm.String" MaxLength="15"/>
      </EntityType>
    </Schema>
    <Schema Namespace="ODataWebExperimental.Northwind.Model" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityContainer Name="NorthwindEntities" m:IsDefaultEntityContainer="true"
        xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
        <EntitySet Name="Customers" EntityType="NorthwindModel.Customer"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

const ODATA_CUSTOMERS = Object.freeze({
  "@odata.context": "https://services.odata.org/V4/Northwind/Northwind.svc/$metadata#Customers",
  "@odata.count": 91,
  value: [
    {
      CustomerID: "ALFKI",
      CompanyName: "Alfreds Futterkiste",
      ContactName: "Maria Anders",
      City: "Berlin",
      Country: "Germany",
    },
  ],
});

function ogcCollections(collections: readonly unknown[], self: string): Response {
  return json({ collections, links: [{ rel: "self", type: "application/json", href: self }] });
}

/** Honour the page size the SDK asked for, exactly like the live services. */
function requestedLimit(url: URL, ...names: readonly string[]): number | null {
  for (const name of names) {
    const raw = url.searchParams.get(name) ?? url.searchParams.get(name.toUpperCase());
    if (raw === null) continue;
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function paginateFeatureCollection(body: unknown, limit: number | null): Record<string, unknown> {
  const collection = body as { features?: unknown[]; numberMatched?: number };
  const features = Array.isArray(collection.features) ? collection.features : [];
  const page = limit === null ? features : features.slice(0, limit);
  return {
    ...(collection as Record<string, unknown>),
    features: page,
    numberReturned: page.length,
    numberMatched: collection.numberMatched ?? features.length,
  };
}

function paginateOdataPage(body: unknown, limit: number | null): Record<string, unknown> {
  const page = body as { value?: unknown[] };
  const rows = Array.isArray(page.value) ? page.value : [];
  return { ...(page as Record<string, unknown>), value: limit === null ? rows : rows.slice(0, limit) };
}

function defaultRoutes(): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();

  // GeoServices feature service.
  const geoservices =
    "sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/CitizenRequests/FeatureServer/0";
  routes.set(geoservices, () => json(GEOSERVICES_LAYER));
  routes.set(`${geoservices}/query`, (url) => {
    const limit = requestedLimit(url, "resultRecordCount");
    const features = limit === null ? GEOSERVICES_QUERY.features : GEOSERVICES_QUERY.features.slice(0, limit);
    return json({ ...GEOSERVICES_QUERY, features });
  });

  // OGC API Features: pygeoapi.
  routes.set("demo.pygeoapi.io/master", () => json(PYGEOAPI_LANDING));
  routes.set("demo.pygeoapi.io/master/conformance", () => json(PYGEOAPI_CONFORMANCE));
  routes.set("demo.pygeoapi.io/master/collections", () =>
    ogcCollections(PYGEOAPI_COLLECTIONS, "https://demo.pygeoapi.io/master/collections"),
  );
  routes.set("demo.pygeoapi.io/master/collections/lakes", () => json(PYGEOAPI_COLLECTION));
  routes.set("demo.pygeoapi.io/master/collections/lakes/items", (url) =>
    json(paginateFeatureCollection(PYGEOAPI_ITEMS, requestedLimit(url, "limit")), 200, "application/geo+json"),
  );
  routes.set("demo.pygeoapi.io/master/collections/dutch-metadata/items", (url) =>
    json(paginateFeatureCollection(PYGEOAPI_RECORD_ITEMS, requestedLimit(url, "limit")), 200, "application/geo+json"),
  );
  routes.set("demo.pygeoapi.io/master/collections/lakes/tiles/WebMercatorQuad/0/0/0", () =>
    image(REFERENCE_TILE_MVT, "application/vnd.mapbox-vector-tile"),
  );
  routes.set("demo.pygeoapi.io/master/collections/mapserver_world_map/map", () =>
    image(REFERENCE_TILE_PNG, "image/png"),
  );
  routes.set("demo.pygeoapi.io/master/processes", () => json(PYGEOAPI_PROCESSES));

  // OGC API Features: ldproxy.
  routes.set("demo.ldproxy.net/vineyards", () => json(LDPROXY_LANDING));
  routes.set("demo.ldproxy.net/vineyards/conformance", () => json(LDPROXY_CONFORMANCE));
  routes.set("demo.ldproxy.net/vineyards/collections", () => json(LDPROXY_COLLECTIONS));
  routes.set("demo.ldproxy.net/vineyards/collections/vineyards", () => json(LDPROXY_COLLECTIONS.collections[0]));
  routes.set("demo.ldproxy.net/vineyards/collections/vineyards/items", (url) =>
    json(paginateFeatureCollection(LDPROXY_ITEMS, requestedLimit(url, "limit")), 200, "application/geo+json"),
  );

  // STAC API.
  routes.set("earth-search.aws.element84.com/v1", () => json(STAC_LANDING));
  routes.set("earth-search.aws.element84.com/v1/conformance", () => json(STAC_CONFORMANCE));
  routes.set("earth-search.aws.element84.com/v1/collections", () => json(STAC_COLLECTIONS));
  routes.set("earth-search.aws.element84.com/v1/collections/sentinel-2-l2a", () =>
    json(STAC_COLLECTIONS.collections[0]),
  );
  routes.set("earth-search.aws.element84.com/v1/search", (url) =>
    json(paginateFeatureCollection(STAC_SEARCH, requestedLimit(url, "limit")), 200, "application/geo+json"),
  );

  // WFS 2.0. The capabilities document advertises GetFeature on a second
  // same-origin path, exactly like the live service.
  routes.set("service.pdok.nl/lv/bag/wfs/v2_0", () => xml(WFS_CAPABILITIES));
  routes.set("service.pdok.nl/kadaster/bag/wfs/v2_0", (url) =>
    (url.searchParams.get("request") ?? url.searchParams.get("REQUEST") ?? "").toLowerCase() === "getcapabilities"
      ? xml(WFS_CAPABILITIES)
      : json(paginateFeatureCollection(WFS_GETFEATURE, requestedLimit(url, "count"))),
  );

  // WMS 1.3.0: capabilities and GetMap share one endpoint.
  routes.set("ows.terrestris.de/osm/service", (url) => {
    const request = (url.searchParams.get("REQUEST") ?? url.searchParams.get("request") ?? "").toLowerCase();
    if (request !== "getmap") return xml(WMS_CAPABILITIES);
    // Serve whichever advertised format the SDK's serializer negotiated.
    const format = (url.searchParams.get("FORMAT") ?? url.searchParams.get("format") ?? "image/jpeg").toLowerCase();
    return format === "image/png" ? image(REFERENCE_TILE_PNG, "image/png") : image(REFERENCE_TILE_JPEG, "image/jpeg");
  });

  // WMTS 1.0.0 capabilities plus the RESTful ResourceURL tile.
  routes.set("services.arcgisonline.com/arcgis/rest/services/World_Street_Map/MapServer/WMTS", () =>
    xml(WMTS_CAPABILITIES),
  );
  routes.set(
    "services.arcgisonline.com/arcgis/rest/services/World_Street_Map/MapServer/WMTS/tile/1.0.0/World_Street_Map/default/GoogleMapsCompatible/0/0/0.jpg",
    () => image(REFERENCE_TILE_JPEG, "image/jpeg"),
  );

  // OData v4.
  routes.set("services.odata.org/V4/Northwind/Northwind.svc/$metadata", () => xml(ODATA_METADATA));
  routes.set("services.odata.org/V4/Northwind/Northwind.svc/Customers", (url) =>
    json(paginateOdataPage(ODATA_CUSTOMERS, requestedLimit(url, "$top"))),
  );

  return routes;
}

/**
 * Build a `fetch` stand-in that serves every route the reviewed manifest
 * needs. Unknown routes answer 404 so a routing mistake surfaces as a typed
 * failure instead of a hang.
 */
export function createReferenceServiceFetch(options: ReferenceServiceOptions = {}): typeof fetch {
  const routes = defaultRoutes();
  for (const [key, handler] of Object.entries(options.overrides ?? {})) {
    if (handler === null) routes.delete(key);
    else routes.set(key, handler);
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    options.onRequest?.(url, request);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const key = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    const handler = routes.get(key) ?? routes.get(decodeURIComponent(key));
    if (!handler) {
      return new Response(`no reference route for ${key}`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handler(url, request);
  }) as typeof fetch;
}

/** Route keys the offline lane may override; exported for readable tests. */
export const REFERENCE_ROUTE_KEYS = Object.freeze({
  geoservicesLayer:
    "sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/CitizenRequests/FeatureServer/0",
  geoservicesQuery:
    "sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/CitizenRequests/FeatureServer/0/query",
  pygeoapiLanding: "demo.pygeoapi.io/master",
  pygeoapiConformance: "demo.pygeoapi.io/master/conformance",
  pygeoapiItems: "demo.pygeoapi.io/master/collections/lakes/items",
  pygeoapiRecordsItems: "demo.pygeoapi.io/master/collections/dutch-metadata/items",
  pygeoapiOgcTile: "demo.pygeoapi.io/master/collections/lakes/tiles/WebMercatorQuad/0/0/0",
  pygeoapiOgcMap: "demo.pygeoapi.io/master/collections/mapserver_world_map/map",
  pygeoapiProcesses: "demo.pygeoapi.io/master/processes",
  ldproxyLanding: "demo.ldproxy.net/vineyards",
  stacLanding: "earth-search.aws.element84.com/v1",
  stacSearch: "earth-search.aws.element84.com/v1/search",
  wfsCapabilities: "service.pdok.nl/lv/bag/wfs/v2_0",
  wfsGetFeature: "service.pdok.nl/kadaster/bag/wfs/v2_0",
  wmsService: "ows.terrestris.de/osm/service",
  wmtsCapabilities: "services.arcgisonline.com/arcgis/rest/services/World_Street_Map/MapServer/WMTS",
  wmtsTile:
    "services.arcgisonline.com/arcgis/rest/services/World_Street_Map/MapServer/WMTS/tile/1.0.0/World_Street_Map/default/GoogleMapsCompatible/0/0/0.jpg",
  odataMetadata: "services.odata.org/V4/Northwind/Northwind.svc/$metadata",
  odataCustomers: "services.odata.org/V4/Northwind/Northwind.svc/Customers",
});
