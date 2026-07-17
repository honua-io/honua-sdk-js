import { readFileSync } from "node:fs";

import type { Capability, Protocol } from "../src/contract/index.js";

export interface ServiceExplorerPublicFixture {
  readonly id: string;
  readonly protocol: Protocol;
  readonly endpoint: string;
  readonly sourceId: string;
  readonly sourceCount: number;
  readonly schema: "available" | "unavailable";
  readonly requiredCapabilities: readonly Capability[];
  readonly forbiddenCapabilities: readonly Capability[];
  readonly locator: Readonly<Record<string, unknown>>;
  readonly requestCount: number;
  readonly terminalKind?: "ready" | "partial";
}

export interface ServiceExplorerRawFixtureRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
}

const FIXTURE_ORIGIN = "https://fixtures.example.test";
const capabilities = (...values: Capability[]): readonly Capability[] => Object.freeze(values);

export const SERVICE_EXPLORER_PUBLIC_FIXTURES: readonly ServiceExplorerPublicFixture[] = Object.freeze([
  Object.freeze({
    id: "geoservices-feature",
    protocol: "geoservices-feature-service",
    endpoint: `${FIXTURE_ORIGIN}/arcgis/rest/services/Public/Parcels/FeatureServer`,
    sourceId: "0",
    sourceCount: 2,
    schema: "available",
    requiredCapabilities: capabilities("query", "queryObjectIds", "applyEdits", "stream"),
    forbiddenCapabilities: capabilities("render"),
    locator: Object.freeze({ url: `${FIXTURE_ORIGIN}/arcgis`, serviceId: "Public/Parcels", layerId: 0 }),
    requestCount: 3,
  }),
  Object.freeze({
    id: "geoservices-map",
    protocol: "geoservices-map-service",
    endpoint: `${FIXTURE_ORIGIN}/arcgis/rest/services/Public/County/MapServer`,
    sourceId: "2",
    sourceCount: 1,
    schema: "available",
    requiredCapabilities: capabilities("query", "queryObjectIds", "render", "tiles", "stream"),
    forbiddenCapabilities: capabilities("applyEdits"),
    locator: Object.freeze({ url: `${FIXTURE_ORIGIN}/arcgis`, serviceId: "Public/County", layerId: 2 }),
    requestCount: 2,
  }),
  Object.freeze({
    id: "ogc-features",
    protocol: "ogc-features",
    endpoint: `${FIXTURE_ORIGIN}/ogc/features`,
    sourceId: "parcels",
    sourceCount: 2,
    schema: "unavailable",
    requiredCapabilities: capabilities("query", "queryObjectIds", "applyEdits"),
    forbiddenCapabilities: capabilities("render"),
    locator: Object.freeze({
      url: `${FIXTURE_ORIGIN}/ogc/features`,
      collectionId: "parcels",
      layout: "ogc-api",
    }),
    requestCount: 3,
  }),
  Object.freeze({
    id: "ogc-tiles",
    protocol: "ogc-tiles",
    endpoint: `${FIXTURE_ORIGIN}/ogc/tiles`,
    sourceId: "buildings",
    sourceCount: 2,
    schema: "unavailable",
    requiredCapabilities: capabilities("render", "tiles"),
    forbiddenCapabilities: capabilities("query"),
    locator: Object.freeze({ url: FIXTURE_ORIGIN, basePath: "/ogc/tiles", collectionId: "buildings" }),
    requestCount: 3,
  }),
  Object.freeze({
    id: "ogc-maps",
    protocol: "ogc-maps",
    endpoint: `${FIXTURE_ORIGIN}/ogc/maps`,
    sourceId: "counties",
    sourceCount: 2,
    schema: "unavailable",
    requiredCapabilities: capabilities("render"),
    forbiddenCapabilities: capabilities("query", "tiles"),
    locator: Object.freeze({ url: FIXTURE_ORIGIN, basePath: "/ogc/maps", collectionId: "counties" }),
    requestCount: 3,
  }),
  Object.freeze({
    id: "wfs",
    protocol: "wfs",
    endpoint: `${FIXTURE_ORIGIN}/geoserver/ows`,
    sourceId: "parcels:lot",
    sourceCount: 2,
    schema: "unavailable",
    requiredCapabilities: capabilities("query", "applyEdits", "stream"),
    forbiddenCapabilities: capabilities("render"),
    locator: Object.freeze({
      url: `${FIXTURE_ORIGIN}/geoserver/ows`,
      typeName: "parcels:lot",
      srsName: "urn:ogc:def:crs:EPSG::4326",
    }),
    requestCount: 1,
  }),
  Object.freeze({
    id: "wms",
    protocol: "wms",
    endpoint: "https://maps.example/ogc/wms",
    sourceId: "parcels",
    sourceCount: 2,
    schema: "unavailable",
    requiredCapabilities: capabilities("render", "tiles"),
    forbiddenCapabilities: capabilities("query"),
    locator: Object.freeze({ url: "https://maps.example/ogc/wms", typeName: "parcels" }),
    requestCount: 1,
    terminalKind: "partial",
  }),
  Object.freeze({
    id: "wmts",
    protocol: "wmts",
    endpoint: "https://tiles.example/ogc/wmts",
    sourceId: "imagery",
    sourceCount: 1,
    schema: "unavailable",
    requiredCapabilities: capabilities("render", "tiles"),
    forbiddenCapabilities: capabilities("query"),
    locator: Object.freeze({
      url: "https://tiles.example/ogc/wmts",
      typeName: "imagery",
      styleId: "day",
      tileMatrixSetId: "WebMercatorQuad",
    }),
    requestCount: 1,
  }),
  Object.freeze({
    id: "stac",
    protocol: "stac",
    endpoint: `${FIXTURE_ORIGIN}/stac/v1`,
    sourceId: "sentinel-2-l2a",
    sourceCount: 2,
    schema: "unavailable",
    requiredCapabilities: capabilities("query", "queryObjectIds", "stream"),
    forbiddenCapabilities: capabilities("render"),
    locator: Object.freeze({
      url: `${FIXTURE_ORIGIN}/stac/v1`,
      collectionId: "sentinel-2-l2a",
      layout: "stac-api",
    }),
    requestCount: 2,
  }),
  Object.freeze({
    id: "odata",
    protocol: "odata",
    endpoint: `${FIXTURE_ORIGIN}/odata`,
    sourceId: "Incidents",
    sourceCount: 3,
    schema: "available",
    requiredCapabilities: capabilities("query", "queryObjectIds", "applyEdits", "stream"),
    forbiddenCapabilities: capabilities("render"),
    locator: Object.freeze({ url: `${FIXTURE_ORIGIN}/odata`, entitySet: "Incidents" }),
    requestCount: 1,
  }),
]);

const WMS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/wms/capabilities.xml", import.meta.url),
  "utf8",
);
const WMTS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/wmts/capabilities.xml", import.meta.url),
  "utf8",
);

export function createServiceExplorerRawFixtureFetch(fixtureId: string): {
  readonly fetchFn: typeof fetch;
  readonly requests: ServiceExplorerRawFixtureRequest[];
} {
  const requests: ServiceExplorerRawFixtureRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(Object.freeze({ method: request.method, pathname: url.pathname, search: url.search }));
    return rawFixtureResponse(fixtureId, url);
  };
  return { fetchFn, requests };
}

function rawFixtureResponse(fixtureId: string, url: URL): Response {
  if (fixtureId === "geoservices-feature") return geoServicesFeatureResponse(url);
  if (fixtureId === "geoservices-map") return geoServicesMapResponse(url);
  if (fixtureId === "ogc-features") return ogcFeaturesResponse(url);
  if (fixtureId === "ogc-tiles") return ogcTilesResponse(url);
  if (fixtureId === "ogc-maps") return ogcMapsResponse(url);
  if (fixtureId === "wfs") return wfsResponse(url);
  if (fixtureId === "wms") return xml(WMS_CAPABILITIES, '"wms-capabilities-v1"');
  if (fixtureId === "wmts") return xml(WMTS_CAPABILITIES, '"wmts-capabilities-v1"');
  if (fixtureId === "stac") return stacResponse(url);
  if (fixtureId === "odata") return odataResponse(url);
  throw new Error(`Unknown Service Explorer fixture: ${fixtureId}`);
}

function geoServicesFeatureResponse(url: URL): Response {
  if (url.pathname.endsWith("/FeatureServer")) {
    return json({
      capabilities: "Query,Create,Update,Delete",
      layers: [{ id: 0, name: "Parcels" }],
      tables: [{ id: 3, name: "Owners" }],
    });
  }
  if (url.pathname.endsWith("/FeatureServer/0")) {
    return json(
      {
        id: 0,
        name: "Parcels",
        capabilities: "Query,Create,Update,Delete",
        supportsAttachments: true,
        supportsStatistics: true,
        useStandardizedQueries: true,
        supportedQueryFormats: "JSON, geoJSON, PBF",
        advancedQueryCapabilities: { supportsPagination: true },
        relationships: [{ id: 1, relatedTableId: 3 }],
        extent: { xmin: -158, ymin: 21, xmax: -157, ymax: 22, spatialReference: { wkid: 4326 } },
        fields: [
          { name: "OBJECTID", alias: "Object ID", type: "esriFieldTypeOID", nullable: false, editable: false },
          { name: "STATUS", type: "esriFieldTypeString", length: 64, nullable: true, editable: true },
        ],
      },
      '"geoservices-feature-layer-v1"',
    );
  }
  if (url.pathname.endsWith("/FeatureServer/3")) {
    return json({
      id: 3,
      name: "Owners",
      capabilities: "Query,Create,Update,Delete",
      advancedQueryCapabilities: { supportsPagination: true },
      fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
    });
  }
  return notFound(url);
}

function geoServicesMapResponse(url: URL): Response {
  if (url.pathname.endsWith("/MapServer")) {
    return json({
      capabilities: "Map,Query",
      singleFusedMapCache: true,
      layers: [{ id: 2, name: "Counties" }],
    });
  }
  if (url.pathname.endsWith("/MapServer/2")) {
    return json(
      {
        id: 2,
        name: "Counties",
        capabilities: "Map,Query",
        supportsStatistics: true,
        useStandardizedQueries: true,
        advancedQueryCapabilities: { supportsPagination: true },
        extent: { xmin: -158, ymin: 21, xmax: -157, ymax: 22, spatialReference: { wkid: 4326 } },
        fields: [
          { name: "OBJECTID", alias: "Object ID", type: "esriFieldTypeOID", nullable: false, editable: false },
          { name: "NAME", type: "esriFieldTypeString", length: 128, nullable: true, editable: false },
        ],
      },
      '"geoservices-map-layer-v1"',
    );
  }
  return notFound(url);
}

function ogcFeaturesResponse(url: URL): Response {
  if (url.pathname === "/ogc/features") {
    return json({
      title: "Parcel Features",
      links: [
        { rel: "data", href: "./collections" },
        { rel: "conformance", href: "./conformance" },
      ],
    });
  }
  if (url.pathname === "/ogc/features/conformance") {
    return json(
      {
        conformsTo: [
          "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
          "http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/create-replace-delete",
        ],
      },
      '"ogc-features-conformance-v1"',
    );
  }
  if (url.pathname === "/ogc/features/collections") {
    return json({
      collections: [
        {
          id: "parcels",
          title: "Parcels",
          crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
          extent: { spatial: { bbox: [[-158, 21, -157, 22]] } },
        },
        { id: "roads", title: "Roads" },
      ],
    });
  }
  return notFound(url);
}

function ogcTilesResponse(url: URL): Response {
  if (url.pathname === "/ogc/tiles") {
    return json({
      title: "Building Tiles",
      links: [
        { rel: "data", href: "./tiles/collections" },
        { rel: "conformance", href: "./tiles/conformance" },
      ],
    });
  }
  if (url.pathname === "/ogc/tiles/conformance") {
    return json(
      {
        conformsTo: [
          "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/core",
          "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/tileset",
          "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/mvt",
        ],
      },
      '"ogc-tiles-conformance-v1"',
    );
  }
  if (url.pathname === "/ogc/tiles/collections") {
    return json({
      collections: [
        {
          id: "buildings",
          title: "Buildings",
          crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
        },
        { id: "roads", title: "Roads" },
      ],
    });
  }
  return notFound(url);
}

function ogcMapsResponse(url: URL): Response {
  if (url.pathname === "/ogc/maps") {
    return json({
      title: "County Maps",
      links: [
        { rel: "data", href: "./maps/collections" },
        { rel: "conformance", href: "./maps/conformance" },
      ],
    });
  }
  if (url.pathname === "/ogc/maps/conformance") {
    return json(
      {
        conformsTo: [
          "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/core",
          "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/collection-map",
          "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/png",
        ],
      },
      '"ogc-maps-conformance-v1"',
    );
  }
  if (url.pathname === "/ogc/maps/collections") {
    return json({
      collections: [
        {
          id: "counties",
          title: "Counties",
          crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
        },
        { id: "rivers", title: "Rivers" },
      ],
    });
  }
  return notFound(url);
}

function wfsResponse(url: URL): Response {
  if (url.searchParams.get("request") !== "GetCapabilities") return notFound(url);
  return xml(
    `<?xml version="1.0"?>
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:parcels="https://fixtures.example.test/ns/parcels" version="2.0.0">
  <ows:OperationsMetadata>
    <ows:Operation name="GetFeature">
      <ows:DCP><ows:HTTP><ows:Get xlink:href="${FIXTURE_ORIGIN}/geoserver/wfs"/><ows:Post xlink:href="${FIXTURE_ORIGIN}/geoserver/wfs"/></ows:HTTP></ows:DCP>
      <ows:Parameter name="outputFormat"><ows:AllowedValues><ows:Value>application/geo+json</ows:Value></ows:AllowedValues></ows:Parameter>
    </ows:Operation>
    <ows:Operation name="Transaction"><ows:DCP><ows:HTTP><ows:Post xlink:href="${FIXTURE_ORIGIN}/geoserver/wfs"/></ows:HTTP></ows:DCP></ows:Operation>
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList>
    <wfs:FeatureType><wfs:Name>parcels:lot</wfs:Name><wfs:Title>Lots</wfs:Title><wfs:DefaultCRS>urn:ogc:def:crs:EPSG::4326</wfs:DefaultCRS><ows:WGS84BoundingBox><ows:LowerCorner>-158 21</ows:LowerCorner><ows:UpperCorner>-157 22</ows:UpperCorner></ows:WGS84BoundingBox></wfs:FeatureType>
    <wfs:FeatureType><wfs:Name>roads:road</wfs:Name><wfs:Title>Roads</wfs:Title></wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>`,
    '"wfs-capabilities-v1"',
  );
}

function stacResponse(url: URL): Response {
  if (url.pathname === "/stac/v1") {
    return json(
      {
        id: "earth-search",
        conformsTo: ["https://api.stacspec.org/v1.0.0/core", "https://api.stacspec.org/v1.0.0/item-search"],
        links: [
          { rel: "data", href: "./collections" },
          { rel: "search", href: "./search", type: "application/geo+json" },
        ],
      },
      '"stac-root-v1"',
    );
  }
  if (url.pathname === "/stac/v1/collections") {
    return json(
      {
        collections: [
          {
            id: "sentinel-2-l2a",
            title: "Sentinel-2 L2A",
            crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
            extent: {
              spatial: { bbox: [[-180, -90, 180, 90]] },
              temporal: { interval: [["2015-06-27T00:00:00Z", null]] },
            },
          },
          { id: "landsat-c2-l2", title: "Landsat Collection 2" },
        ],
      },
      '"stac-collections-v1"',
    );
  }
  return notFound(url);
}

function odataResponse(url: URL): Response {
  if (url.pathname !== "/odata/$metadata") return notFound(url);
  return xml(
    `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Honua">
      <EntityType Name="IncidentEntity">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Title" Type="Edm.String"/>
        <Property Name="Location" Type="Edm.GeographyPoint" SRID="4326"/>
      </EntityType>
      <EntityType Name="StatEntity"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32" Nullable="false"/></EntityType>
      <EntityType Name="ViewEntity"><Property Name="Label" Type="Edm.String"/></EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Incidents" EntityType="Honua.IncidentEntity"/>
        <EntitySet Name="Stats" EntityType="Honua.StatEntity"/>
        <EntitySet Name="Views" EntityType="Honua.ViewEntity"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
    '"odata-metadata-v1"',
  );
}

function json(body: unknown, etag?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...(etag ? { ETag: etag } : {}),
    },
  });
}

function xml(body: string, etag: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8", ETag: etag },
  });
}

function notFound(url: URL): never {
  throw new Error(`Fixture ${url.pathname}${url.search} was not declared.`);
}
