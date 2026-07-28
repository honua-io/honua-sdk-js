/**
 * Cross-protocol descriptor identity matrix (issue #555).
 *
 * `connect()` discovers the same kind of logical resource — a vector
 * "parcels" layer, or a raster/catalog "imagery" resource — through a
 * modern protocol matrix that includes vector GeoServices and gRPC variants,
 * OData v4, GeoParquet, WFS 2.0, OGC API Features/Records/Tiles/Maps, WMS,
 * WMTS, and STAC. This file proves two things end to end through the real
 * `connect()` / `connectWithSourceSchemaV2()` facade, never by calling a normalizer
 * function directly:
 *
 *  1. Where two protocols carry genuinely equivalent metadata (the same
 *     field kind, key semantics, geometry type, or CRS), the normalized
 *     `SourceSchemaV2` descriptors agree exactly — proven by structural
 *     equality on the protocol-neutral projection, not by fixture-specific
 *     assertions that happen to look similar.
 *  2. Where two protocols genuinely differ (GeoParquet never declares a
 *     key; Esri's `geometryType` enum can't distinguish Polygon from
 *     MultiPolygon; OData's wire format allows special float literals;
 *     GeoServices ImageServer does not emit schemaV2; OGC/WMS/WMTS/WFS/STAC
 *     do not discover a schemaV2 field inventory), the matrix asserts the
 *     *documented* difference with a reason,
 *     rather than skipping the protocol or forcing a false equivalence.
 *
 * Endpoint identity, locators, and raw `native` type references are
 * intentionally never compared across protocols — only the normalized
 * semantic projection is. Cache, refresh, cancellation, and auth-scope
 * isolation are asserted once, uniformly, across the whole matrix, because
 * that behavior lives in `connect()`'s shared body rather than in any one
 * protocol adapter.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { GeoParquetSourceProfile, GeoParquetSourceProfiler } from "../src/connect-geoparquet.js";
import {
  type ConnectDiscoveryCache,
  type ConnectDiscoverySnapshot,
  type ConnectOptions,
  type ConnectResolvedProtocol,
  connect,
} from "../src/connect.js";
import { HONUA_MINIMUM_SUPPORTED_SERVER_VERSION, HonuaClient } from "../src/core/client.js";
import { HonuaAbortError } from "../src/core/errors.js";
import type { HonuaLayerMetadata, HonuaQueryResponse } from "../src/core/types.js";
import { type SourceSchemaV2, connectWithSourceSchemaV2 } from "../src/source-schema.js";

const WMS_CAPABILITIES_XML = readFileSync(
  new URL("./fixtures/backend-agnostic/wms/capabilities.xml", import.meta.url),
  "utf8",
);
const WMTS_CAPABILITIES_XML = readFileSync(
  new URL("./fixtures/backend-agnostic/wmts/capabilities.xml", import.meta.url),
  "utf8",
);

type BaseConnectOptions = Omit<ConnectOptions, "authorizationScopeFingerprint" | "cache" | "refresh" | "signal">;

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function xml(body: string, headers: HeadersInit = {}): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/xml; charset=utf-8", ...headers } });
}

// ── Vector "parcels" resource: GeoServices / gRPC / OData / GeoParquet ─────
// Same logical dataset — a key-ish integer id, a string name, a numeric
// area, and a Polygon geometry in a WGS84-family CRS — expressed natively in
// each protocol's own metadata shape.

const PARCELS_LAYER: HonuaLayerMetadata = {
  id: 0,
  name: "Parcels",
  geometryType: "esriGeometryPolygon",
  objectIdField: "OBJECTID",
  capabilities: "Query",
  spatialReference: { wkid: 4326 },
  advancedQueryCapabilities: { supportsPagination: true, supportsReturningQueryExtent: true },
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "NAME", type: "esriFieldTypeString" },
    { name: "AREA_SQM", type: "esriFieldTypeDouble" },
  ],
};

const PARCELS_PROBE_RESPONSE: HonuaQueryResponse = {
  objectIdFieldName: "OBJECTID",
  geometryType: "esriGeometryPolygon",
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "NAME", type: "esriFieldTypeString" },
    { name: "AREA_SQM", type: "esriFieldTypeDouble" },
  ],
  features: [],
};

const GEOSERVICES_ENDPOINT = "https://example.test/rest/services/parcels/FeatureServer/0";
const GEOSERVICES_MAP_ENDPOINT = "https://example.test/rest/services/parcels/MapServer/0";
const GEOSERVICES_IMAGE_ENDPOINT = "https://example.test/rest/services/elevation/ImageServer";
const GEOSERVICES_GEOMETRY_ENDPOINT = "https://example.test/rest/services/analysis/GeometryServer";
const GEOSERVICES_GP_ENDPOINT = "https://example.test/rest/services/tools/GPServer";
const OGC_PROCESSES_ENDPOINT = "https://example.test/ogc/processes";
const PMTILES_ENDPOINT = "https://assets.example.test/maps/world.pmtiles";
const PMTILES_ETAG = '"pmtiles-fixture-v1"';

function geoservicesFetchHandler(layer: HonuaLayerMetadata = PARCELS_LAYER): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/services/parcels/FeatureServer/0") return json(layer);
    throw new Error(`Unexpected GeoServices fetch: ${url.pathname}`);
  }) as typeof fetch;
}

const PARCELS_MAP_LAYER: HonuaLayerMetadata = {
  id: 0,
  name: "Parcels",
  geometryType: "esriGeometryPolygon",
  objectIdField: "OBJECTID",
  capabilities: "Map,Query",
  spatialReference: { wkid: 4326 },
  advancedQueryCapabilities: { supportsPagination: true, supportsReturningQueryExtent: true },
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "NAME", type: "esriFieldTypeString" },
    { name: "AREA_SQM", type: "esriFieldTypeDouble" },
  ],
};

function geoservicesMapFetchHandler(layer: HonuaLayerMetadata = PARCELS_MAP_LAYER): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/services/parcels/MapServer") {
      return json({ layers: [{ id: 0, name: "Parcels" }] });
    }
    if (url.pathname === "/rest/services/parcels/MapServer/0") return json(layer);
    throw new Error(`Unexpected GeoServices MapServer fetch: ${url.pathname}`);
  }) as typeof fetch;
}

const PARCELS_IMAGE_METADATA = {
  name: "Imagery",
  capabilities: "Image,Query",
  objectIdField: "OBJECTID",
  advancedQueryCapabilities: { supportsPagination: true, supportsReturningQueryExtent: true },
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "NAME", type: "esriFieldTypeString" },
    { name: "AREA_SQM", type: "esriFieldTypeDouble" },
  ],
};

function geoservicesImageFetchHandler(metadata: unknown = PARCELS_IMAGE_METADATA): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/services/elevation/ImageServer") return json(metadata);
    throw new Error(`Unexpected GeoServices ImageServer fetch: ${url.pathname}`);
  }) as typeof fetch;
}

function grpcCapabilitiesEnvelope() {
  return {
    success: true,
    data: {
      compatibility: {
        serverVersion: HONUA_MINIMUM_SUPPORTED_SERVER_VERSION,
        releaseChannel: "stable",
        controlPlaneApi: { major: 1, basePath: "/api/v1/admin", deprecated: false },
        metadataSchemas: [],
        features: {
          metadataResources: true,
          manifestExport: true,
          manifestApply: true,
          manifestDryRun: true,
          manifestPrune: true,
        },
      },
    },
  };
}

function grpcFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/api/v1/admin/capabilities") return json(grpcCapabilitiesEnvelope());
    if (url.pathname === "/rest/services/parcels/FeatureServer/0") return json(PARCELS_LAYER);
    throw new Error(`Unexpected gRPC fetch: ${url.pathname}`);
  }) as typeof fetch;
}

const PARCELS_ODATA_METADATA_XML = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Honua">
      <EntityType Name="ParcelEntity">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="AreaSqm" Type="Edm.Double"/>
        <Property Name="Geometry" Type="Edm.GeographyPolygon"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parcels" EntityType="Honua.ParcelEntity"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const ODATA_ENDPOINT = "https://svc.example/odata";

function odataFetchHandler(metadataXml: string = PARCELS_ODATA_METADATA_XML): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/odata/$metadata") {
      return xml(metadataXml, { ETag: '"parcels-odata-v1"' });
    }
    if (url.pathname === "/odata/Parcels") return json({ value: [], "@odata.count": 0 });
    throw new Error(`Unexpected OData fetch: ${url.pathname}`);
  }) as typeof fetch;
}

const PARCELS_GEOPARQUET_PROFILE: GeoParquetSourceProfile = {
  columns: ["id", "name", "area_sqm"],
  fields: [
    { name: "id", type: "INTEGER", nullable: false },
    { name: "name", type: "VARCHAR", nullable: true },
    { name: "area_sqm", type: "DOUBLE", nullable: true },
  ],
  geometry: {
    column: "geometry",
    encoding: "wkb",
    bboxColumn: "bbox",
    metadataState: "valid",
    geometryTypesState: "valid",
    geometryTypes: ["Polygon"],
  },
  // No per-geometry crsState/crsValue: falls back to this top-level `crs`
  // string, which — like GeoServices' spatialReference.wkid and OData's
  // default Geography SRID — resolves to the EPSG:4326 authority.
  crs: "EPSG:4326",
  rowEstimate: 4,
};

const GEOPARQUET_ENDPOINT = "https://fixtures.test/parcels.parquet";

function fakeParcelsProfiler(profile: GeoParquetSourceProfile = PARCELS_GEOPARQUET_PROFILE): {
  readonly profiler: GeoParquetSourceProfiler;
  readonly calls: readonly unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    profiler: {
      async profile(sources, override) {
        calls.push({ sources: [...sources], override });
        return profile;
      },
    },
  };
}

// ── Vector "parcels" resource without a discovered field schema: WFS / OGC Features ──
// These protocol adapters intentionally discover only capability + locator +
// coarse CRS truth today; `connect()` never invents a field inventory for
// them, so this is a structural (not incidental) difference from the four
// schema-bearing adapters above.

const WFS_ENDPOINT = "https://example.test/geoserver/wfs";

const PARCELS_WFS_CAPABILITIES_XML = `<?xml version="1.0"?>
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0.0">
  <ows:OperationsMetadata>
    <ows:Operation name="GetFeature">
      <ows:DCP><ows:HTTP><ows:Get xlink:href="${WFS_ENDPOINT}"/><ows:Post xlink:href="${WFS_ENDPOINT}"/></ows:HTTP></ows:DCP>
      <ows:Parameter name="outputFormat"><ows:AllowedValues><ows:Value>application/geo+json</ows:Value></ows:AllowedValues></ows:Parameter>
    </ows:Operation>
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>parcels</wfs:Name>
      <wfs:Title>Parcels</wfs:Title>
      <wfs:DefaultCRS>urn:ogc:def:crs:EPSG::4326</wfs:DefaultCRS>
      <ows:WGS84BoundingBox><ows:LowerCorner>-158 21</ows:LowerCorner><ows:UpperCorner>-157 22</ows:UpperCorner></ows:WGS84BoundingBox>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>`;

function wfsFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.searchParams.get("request") === "GetFeature") {
      return json({ type: "FeatureCollection", features: [], numberMatched: 0, numberReturned: 0 });
    }
    return xml(PARCELS_WFS_CAPABILITIES_XML);
  }) as typeof fetch;
}

const OGC_FEATURES_ENDPOINT = "https://example.test/ogc/features";

const OGC_FEATURES_LANDING = {
  title: "Test API",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
  ],
};
const OGC_FEATURES_CONFORMANCE = {
  conformsTo: ["http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core"],
};
const OGC_FEATURES_COLLECTIONS = {
  collections: [{ id: "parcels", title: "Parcels", crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"] }],
};

function ogcFeaturesFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/ogc/features") return json(OGC_FEATURES_LANDING);
    if (url.pathname === "/ogc/features/conformance") return json(OGC_FEATURES_CONFORMANCE);
    if (url.pathname === "/ogc/features/collections") return json(OGC_FEATURES_COLLECTIONS);
    throw new Error(`Unexpected OGC Features fetch: ${url.pathname}`);
  }) as typeof fetch;
}

// ── Raster / catalog "imagery" resource: WMS / WMTS / STAC ─────────────────
// A render/tile-only resource never carries a field inventory at all; this
// is the deliberately non-equivalent family in the matrix.

const OGC_RECORDS_ENDPOINT = "https://catalog.example/ogc/records";
const OGC_RECORDS_LANDING = {
  title: "Test Record Catalog",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
  ],
};
const OGC_RECORDS_CONFORMANCE = {
  conformsTo: ["http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/core"],
};
const OGC_RECORDS_COLLECTIONS = {
  collections: [{ id: "parcels", title: "Parcels", crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"] }],
};

function ogcRecordsFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/ogc/records") return json(OGC_RECORDS_LANDING, { ETag: '"records-root-v1"' });
    if (url.pathname === "/ogc/records/conformance")
      return json(OGC_RECORDS_CONFORMANCE, { ETag: '"records-conf-v1"' });
    if (url.pathname === "/ogc/records/collections")
      return json(OGC_RECORDS_COLLECTIONS, { ETag: '"records-cols-v1"' });
    throw new Error(`Unexpected OGC Records fetch: ${url.pathname}`);
  }) as typeof fetch;
}

const OGC_TILES_ENDPOINT = "https://tiles.example/ogc/tiles";
const OGC_TILES_LANDING = {
  title: "Test Tile Service",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
  ],
};
const OGC_TILES_CONFORMANCE = {
  conformsTo: ["http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/core"],
};
const OGC_TILES_COLLECTIONS = {
  collections: [{ id: "parcels", title: "Parcels", crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"] }],
};

function ogcTilesFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/ogc/tiles") return json(OGC_TILES_LANDING, { ETag: '"tiles-root-v1"' });
    if (url.pathname === "/ogc/tiles/conformance") return json(OGC_TILES_CONFORMANCE, { ETag: '"tiles-conf-v1"' });
    if (url.pathname === "/ogc/tiles/collections") return json(OGC_TILES_COLLECTIONS, { ETag: '"tiles-cols-v1"' });
    throw new Error(`Unexpected OGC Tiles fetch: ${url.pathname}`);
  }) as typeof fetch;
}

const OGC_MAPS_ENDPOINT = "https://maps.example/ogc/maps";
const OGC_MAPS_LANDING = {
  title: "Test Map Service",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
  ],
};
const OGC_MAPS_CONFORMANCE = {
  conformsTo: ["http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/core"],
};
const OGC_MAPS_COLLECTIONS = {
  collections: [{ id: "parcels", title: "Parcels", crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"] }],
};

function ogcMapsFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/ogc/maps") return json(OGC_MAPS_LANDING, { ETag: '"maps-root-v1"' });
    if (url.pathname === "/ogc/maps/conformance") return json(OGC_MAPS_CONFORMANCE, { ETag: '"maps-conf-v1"' });
    if (url.pathname === "/ogc/maps/collections") return json(OGC_MAPS_COLLECTIONS, { ETag: '"maps-cols-v1"' });
    throw new Error(`Unexpected OGC Maps fetch: ${url.pathname}`);
  }) as typeof fetch;
}

// â”€â”€ Raw OGC API / raster families without shared field schema: Records / Tiles / Maps / WMS / WMTS / STAC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// OGC / WMS-family resources used in the schema-less matrix branch:
// OGC Records / OGC Tiles / OGC Maps / WMS / WMTS / STAC
const WMS_ENDPOINT = "https://maps.example/ogc/wms";
const WMTS_ENDPOINT = "https://maps.example/ogc/wmts";

function wmsFetchHandler(): typeof fetch {
  return vi.fn(async () => xml(WMS_CAPABILITIES_XML, { ETag: '"wms-capabilities-v1"' })) as typeof fetch;
}
function wmtsFetchHandler(): typeof fetch {
  return vi.fn(async () => xml(WMTS_CAPABILITIES_XML, { ETag: '"wmts-capabilities-v1"' })) as typeof fetch;
}

const STAC_ENDPOINT = "https://catalog.example/stac/v1";

const IMAGERY_STAC_LANDING = {
  id: "geo-catalog",
  conformsTo: ["https://api.stacspec.org/v1.0.0/core", "https://api.stacspec.org/v1.0.0/item-search"],
  links: [
    { rel: "data", href: "./collections" },
    { rel: "search", href: "./search", type: "application/geo+json" },
  ],
};
const IMAGERY_STAC_COLLECTIONS = {
  collections: [
    {
      id: "imagery",
      title: "Imagery",
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
      extent: {
        spatial: { bbox: [[-158.5, 20.5, -157.5, 22.5]] },
        temporal: { interval: [["2015-06-27T00:00:00Z", null]] },
      },
    },
  ],
};

function stacFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/stac/v1") return json(IMAGERY_STAC_LANDING, { ETag: '"stac-root-v1"' });
    if (url.pathname === "/stac/v1/collections")
      return json(IMAGERY_STAC_COLLECTIONS, { ETag: '"stac-collections-v1"' });
    throw new Error(`Unexpected STAC fetch: ${url.pathname}`);
  }) as typeof fetch;
}

function pmtilesFixtureAsset(name = "sample-vector.pmtiles"): Uint8Array {
  const fixture = readFileSync(new URL(`./fixtures/pmtiles/${name}`, import.meta.url));
  const asset = new Uint8Array(64 * 1024);
  asset.set(new Uint8Array(fixture));
  return asset;
}

function pmtilesRangeFetch(asset = pmtilesFixtureAsset()) {
  const calls: Array<{ url: string; range: string | null; authorization: string | null; signal?: AbortSignal }> = [];
  const fetchFn = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("range");
    calls.push({
      url: input.toString(),
      range,
      authorization: headers.get("authorization"),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!range) return new Response("missing range", { status: 400 });
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) return new Response("invalid range", { status: 400 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = asset.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": "application/vnd.pmtiles",
        "Content-Length": String(body.byteLength),
        "Content-Range": `bytes ${start}-${end}/${asset.byteLength}`,
        ETag: PMTILES_ETAG,
      },
    });
  });
  return { fetchFn, calls };
}

// Full protocol matrix used by the cache / refresh / cancel / auth-scope suite

interface MatrixCase {
  readonly label: ConnectResolvedProtocol;
  build(): { readonly options: BaseConnectOptions; readonly activity: () => number };
}

const MATRIX_CASES: readonly MatrixCase[] = [
  {
    label: "geoservices-feature-service",
    build() {
      const fetchFn = geoservicesFetchHandler();
      return {
        options: {
          endpoint: GEOSERVICES_ENDPOINT,
          protocol: "geoservices-feature-service",
          clientOptions: { fetchFn },
        },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "geoservices-map-service",
    build() {
      const fetchFn = geoservicesMapFetchHandler();
      return {
        options: {
          endpoint: GEOSERVICES_MAP_ENDPOINT,
          protocol: "geoservices-map-service",
          clientOptions: { fetchFn },
        },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "geoservices-image-service",
    build() {
      const fetchFn = geoservicesImageFetchHandler();
      return {
        options: {
          endpoint: GEOSERVICES_IMAGE_ENDPOINT,
          protocol: "geoservices-image-service",
          clientOptions: { fetchFn },
        },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "grpc",
    build() {
      const fetchFn = grpcFetchHandler();
      const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
      const queryFeatures = vi.spyOn(client, "queryFeatures").mockResolvedValue(PARCELS_PROBE_RESPONSE);
      return {
        options: { endpoint: GEOSERVICES_ENDPOINT, protocol: "grpc", client },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length + queryFeatures.mock.calls.length,
      };
    },
  },
  {
    label: "odata",
    build() {
      const fetchFn = odataFetchHandler();
      return {
        options: { endpoint: ODATA_ENDPOINT, protocol: "odata", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "geoparquet",
    build() {
      const { profiler, calls } = fakeParcelsProfiler();
      return {
        options: { endpoint: GEOPARQUET_ENDPOINT, protocol: "geoparquet", geoparquet: { profiler } },
        activity: () => calls.length,
      };
    },
  },
  {
    label: "wfs",
    build() {
      const fetchFn = wfsFetchHandler();
      return {
        options: { endpoint: WFS_ENDPOINT, protocol: "wfs", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "ogc-records",
    build() {
      const fetchFn = ogcRecordsFetchHandler();
      return {
        options: { endpoint: OGC_RECORDS_ENDPOINT, protocol: "ogc-records", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "ogc-tiles",
    build() {
      const fetchFn = ogcTilesFetchHandler();
      return {
        options: { endpoint: OGC_TILES_ENDPOINT, protocol: "ogc-tiles", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "ogc-maps",
    build() {
      const fetchFn = ogcMapsFetchHandler();
      return {
        options: { endpoint: OGC_MAPS_ENDPOINT, protocol: "ogc-maps", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "ogc-features",
    build() {
      const fetchFn = ogcFeaturesFetchHandler();
      return {
        options: { endpoint: OGC_FEATURES_ENDPOINT, protocol: "ogc-features", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "wms",
    build() {
      const fetchFn = wmsFetchHandler();
      return {
        options: { endpoint: WMS_ENDPOINT, protocol: "wms", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "wmts",
    build() {
      const fetchFn = wmtsFetchHandler();
      return {
        options: { endpoint: WMTS_ENDPOINT, protocol: "wmts", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "stac",
    build() {
      const fetchFn = stacFetchHandler();
      return {
        options: { endpoint: STAC_ENDPOINT, protocol: "stac", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
  {
    label: "pmtiles",
    build() {
      const { fetchFn } = pmtilesRangeFetch();
      return {
        options: { endpoint: PMTILES_ENDPOINT, protocol: "pmtiles", clientOptions: { fetchFn } },
        activity: () => (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length,
      };
    },
  },
];

function spyCache(): ConnectDiscoveryCache & {
  readonly get: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, ConnectDiscoverySnapshot>();
  return {
    get: vi.fn((identity) => store.get(identity.key)),
    set: vi.fn((identity, snapshot) => {
      store.set(identity.key, snapshot);
    }),
  };
}

function fieldNamed(schema: SourceSchemaV2, name: string) {
  return schema.fields.find((field) => field.name === name);
}

function geometryKnowledge(schema: SourceSchemaV2) {
  if (schema.geometry.state !== "known") {
    throw new Error(`Expected a known geometry state; got ${schema.geometry.state}`);
  }
  return schema.geometry.fields[0]!.geometryTypes;
}

function geometryCrsDefinition(schema: SourceSchemaV2) {
  if (schema.geometry.state !== "known") {
    throw new Error(`Expected a known geometry state; got ${schema.geometry.state}`);
  }
  return schema.geometry.fields[0]!.crs.definition;
}

/** Correspondence between each schema-bearing protocol's native field name and its logical role. */
const PARCELS_FIELD_NAMES = {
  geoservices: { key: "OBJECTID", name: "NAME", area: "AREA_SQM", geometry: "geometry" },
  geoservicesMap: { key: "OBJECTID", name: "NAME", area: "AREA_SQM", geometry: "geometry" },
  grpc: { key: "OBJECTID", name: "NAME", area: "AREA_SQM", geometry: "geometry" },
  odata: { key: "Id", name: "Name", area: "AreaSqm", geometry: "Geometry" },
  geoparquet: { key: "id", name: "name", area: "area_sqm", geometry: "geometry" },
} as const;

async function discoverParcelsSchemas() {
  const [geoservices, geoservicesMap, grpcConnection, odata, geoparquet] = await Promise.all([
    connectWithSourceSchemaV2({
      endpoint: GEOSERVICES_ENDPOINT,
      protocol: "geoservices-feature-service",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: geoservicesFetchHandler() },
    }),
    connectWithSourceSchemaV2({
      endpoint: GEOSERVICES_MAP_ENDPOINT,
      protocol: "geoservices-map-service",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: geoservicesMapFetchHandler() },
    }),
    (async () => {
      const fetchFn = grpcFetchHandler();
      const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
      vi.spyOn(client, "queryFeatures").mockResolvedValue(PARCELS_PROBE_RESPONSE);
      return connectWithSourceSchemaV2({
        endpoint: GEOSERVICES_ENDPOINT,
        protocol: "grpc",
        authorizationScopeFingerprint: "anonymous",
        client,
      });
    })(),
    connectWithSourceSchemaV2({
      endpoint: ODATA_ENDPOINT,
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: odataFetchHandler() },
    }),
    (async () => {
      const { profiler } = fakeParcelsProfiler();
      return connectWithSourceSchemaV2({
        endpoint: GEOPARQUET_ENDPOINT,
        protocol: "geoparquet",
        authorizationScopeFingerprint: "anonymous",
        geoparquet: { profiler },
      });
    })(),
  ]);
  return {
    geoservices: geoservices.inspection.sources[0]!.descriptor.schemaV2!,
    geoservicesMap: geoservicesMap.inspection.sources[0]!.descriptor.schemaV2!,
    grpc: grpcConnection.inspection.sources[0]!.descriptor.schemaV2!,
    odata: odata.inspection.sources[0]!.descriptor.schemaV2!,
    geoparquet: geoparquet.inspection.sources[0]!.descriptor.schemaV2!,
  };
}

describe("connect() — cross-protocol descriptor identity matrix (issue #555)", () => {
  it("never populates schemaV2 on the plain connect() facade for any protocol; only the focused connectWithSourceSchemaV2() entry point does", async () => {
    const connection = await connect({
      endpoint: GEOSERVICES_ENDPOINT,
      protocol: "geoservices-feature-service",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: geoservicesFetchHandler() },
    });
    expect(connection.inspection.sources[0]?.descriptor.schemaV2).toBeUndefined();
  });

  it("rejects unsupported operation-oriented protocols when they are explicitly selected", async () => {
    await expect(
      connect({
        endpoint: GEOSERVICES_GEOMETRY_ENDPOINT,
        // `ogc-processes` is not part of Protocol and requires a cast in this
        // negative test case to assert the real `connect()` behavior.
        protocol: "ogc-processes" as never,
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: vi.fn() },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "unsupported-protocol",
    });

    await expect(
      connect({
        endpoint: GEOSERVICES_GEOMETRY_ENDPOINT,
        protocol: "geoservices-geometry-service" as never,
        authorizationScopeFingerprint: "anonymous",
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "unsupported-protocol",
    });

    await expect(
      connect({
        endpoint: `${GEOSERVICES_GP_ENDPOINT}/Buffer`,
        protocol: "geoservices-gp-service" as never,
        authorizationScopeFingerprint: "anonymous",
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "unsupported-protocol",
    });
  });

  it("treats operation-oriented GeoServices URLs as unsupported under auto protocol detection", async () => {
    await expect(
      connect({
        endpoint: GEOSERVICES_GEOMETRY_ENDPOINT,
        protocol: "auto",
        authorizationScopeFingerprint: "anonymous",
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "unsupported-protocol",
    });

    await expect(
      connect({
        endpoint: `${GEOSERVICES_GP_ENDPOINT}/Buffer`,
        protocol: "auto",
        authorizationScopeFingerprint: "anonymous",
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "unsupported-protocol",
    });
  });

  it.each([
    { label: "ogc-processes", protocol: "ogc-processes" as never, endpoint: OGC_PROCESSES_ENDPOINT },
    {
      label: "geoservices-geometry-service",
      protocol: "geoservices-geometry-service" as never,
      endpoint: GEOSERVICES_GEOMETRY_ENDPOINT,
    },
    {
      label: "geoservices-gp-service",
      protocol: "geoservices-gp-service" as never,
      endpoint: `${GEOSERVICES_GP_ENDPOINT}/Buffer`,
    },
  ] as const)(
    "keeps operation-oriented protocols rejected by connect() without cache access: $label",
    async ({ protocol, endpoint }) => {
      const cache = spyCache();

      await expect(
        connect({
          endpoint,
          protocol,
          authorizationScopeFingerprint: "anonymous",
          cache,
        }),
      ).rejects.toMatchObject({
        name: "HonuaDiscoveryError",
        code: "unsupported-protocol",
      });

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "geometry-service auto protocol",
      endpoint: GEOSERVICES_GEOMETRY_ENDPOINT,
    },
    {
      label: "gp-service auto protocol",
      endpoint: `${GEOSERVICES_GP_ENDPOINT}/Buffer`,
    },
  ] as const)(
    "rejects auto-detected operation-oriented protocols before cache lookup and keeps all protocol-specific inputs non-operative: $label",
    async ({ endpoint }) => {
      const cache = spyCache();

      await expect(
        connect({
          endpoint,
          protocol: "auto",
          authorizationScopeFingerprint: "anonymous",
          cache,
        }),
      ).rejects.toMatchObject({
        name: "HonuaDiscoveryError",
        code: "unsupported-protocol",
      });

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    },
  );

  describe("semantic field / key / geometry / CRS identity across the five schema-bearing protocols", () => {
    it("normalizes equivalent string and geometry fields to identical logical kinds across GeoServices variants, gRPC, OData, and GeoParquet", async () => {
      const schemas = await discoverParcelsSchemas();

      for (const protocol of ["geoservices", "geoservicesMap", "grpc", "odata", "geoparquet"] as const) {
        const names = PARCELS_FIELD_NAMES[protocol];
        const schema = schemas[protocol];
        expect(fieldNamed(schema, names.name)?.type).toEqual({ kind: "string" });
        expect(fieldNamed(schema, names.geometry)?.type).toEqual({ kind: "geometry" });
        expect(fieldNamed(schema, names.geometry)?.roles).toContain("geometry");
      }
    });

    it("normalizes the declared key column to an identical integer kind across GeoServices variants, gRPC, and OData", async () => {
      const schemas = await discoverParcelsSchemas();
      const expectedKeyType = { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" } as const;

      expect(fieldNamed(schemas.geoservices, "OBJECTID")?.type).toEqual(expectedKeyType);
      expect(fieldNamed(schemas.geoservicesMap, "OBJECTID")?.type).toEqual(expectedKeyType);
      expect(fieldNamed(schemas.grpc, "OBJECTID")?.type).toEqual(expectedKeyType);
      expect(fieldNamed(schemas.odata, "Id")?.type).toEqual(expectedKeyType);
      // GeoParquet's "id" column is the SAME logical key by convention, but the
      // adapter never infers Parquet primary keys, so it degrades to a plain
      // attribute — see the "documented divergence" test below.
      expect(fieldNamed(schemas.geoparquet, "id")?.type).toEqual(expectedKeyType);
    });

    it("normalizes the same EPSG:4326 geometry CRS to a byte-identical authority definition across GeoServices variants, gRPC, OData, and GeoParquet", async () => {
      const schemas = await discoverParcelsSchemas();
      const expectedDefinition = {
        kind: "authority",
        authority: "EPSG",
        code: "4326",
        definitionAxisOrder: {
          state: "known",
          source: "crs-definition",
          axes: [
            { name: "geodetic latitude", direction: "north", unit: "degree" },
            { name: "geodetic longitude", direction: "east", unit: "degree" },
          ],
        },
      };

      for (const protocol of ["geoservices", "geoservicesMap", "grpc", "odata", "geoparquet"] as const) {
        expect(geometryCrsDefinition(schemas[protocol])).toEqual(expectedDefinition);
      }
    });

    it("keeps gRPC's schemaV2 fingerprint byte-identical to raw GeoServices REST discovery of the same underlying layer document", async () => {
      const schemas = await discoverParcelsSchemas();
      // Same transport-neutral identity, proven by the verified fingerprint —
      // not by re-deriving field-by-field equality, which is exactly the
      // sourceSchemaV2QueryContext() query-plan-identity guarantee.
      expect(schemas.grpc.fingerprint).toBe(schemas.geoservices.fingerprint);
    });

    it("keeps gRPC's capability truth a verified fail-closed subset of raw GeoServices REST for the identical layer", async () => {
      const restConnection = await connect({
        endpoint: GEOSERVICES_ENDPOINT,
        protocol: "geoservices-feature-service",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: geoservicesFetchHandler() },
      });
      const grpcFetchFn = grpcFetchHandler();
      const grpcClient = new HonuaClient({
        baseUrl: "https://example.test",
        transport: "grpc-web",
        fetchFn: grpcFetchFn,
      });
      vi.spyOn(grpcClient, "queryFeatures").mockResolvedValue(PARCELS_PROBE_RESPONSE);
      const grpcConnection = await connect({
        endpoint: GEOSERVICES_ENDPOINT,
        protocol: "grpc",
        authorizationScopeFingerprint: "anonymous",
        client: grpcClient,
      });

      const restCapabilities = new Set([...restConnection.source().capabilities]);
      const grpcCapabilities = new Set([...grpcConnection.source().capabilities]);
      for (const capability of grpcCapabilities) expect(restCapabilities.has(capability)).toBe(true);
      // gRPC has no pbf/sql/attachments RPC surface even though the identical
      // REST metadata would advertise them.
      expect(grpcCapabilities.has("pbf")).toBe(false);
      expect(grpcConnection.inspection.sources[0]!.descriptor.locator).toEqual(
        restConnection.inspection.sources[0]!.descriptor.locator,
      );
      // Endpoint identity (the descriptor's protocol tag) still distinguishes
      // them even though locator and schema identity are equal.
      expect(grpcConnection.inspection.protocol).toBe("grpc");
      expect(restConnection.inspection.protocol).toBe("geoservices-feature-service");
    });
  });

  describe("documented, non-equivalent per-protocol differences — an explicit reason, never a silent skip", () => {
    it("never assigns a GeoParquet key even to a column literally named the same as the other protocols' declared key", async () => {
      const schemas = await discoverParcelsSchemas();

      // The GeoParquet adapter has no key-inference convention (unlike
      // GeoServices' objectIdField or OData's CSDL <Key>): key state is
      // always {state: "none"}, regardless of column naming.
      expect(schemas.geoparquet.key).toEqual({ state: "none" });
      expect(fieldNamed(schemas.geoparquet, "id")?.roles).toEqual([]);

      // ...whereas the same logical column IS the declared, non-nullable key
      // for the other four protocols.
      expect(schemas.geoservices.key).toEqual({ state: "known", fields: ["OBJECTID"] });
      expect(schemas.geoservicesMap.key).toEqual({ state: "known", fields: ["OBJECTID"] });
      expect(schemas.grpc.key).toEqual({ state: "known", fields: ["OBJECTID"] });
      expect(schemas.odata.key).toEqual({ state: "known", fields: ["Id"] });
      for (const [protocol, keyField] of [
        ["geoservices", "OBJECTID"],
        ["geoservicesMap", "OBJECTID"],
        ["grpc", "OBJECTID"],
        ["odata", "Id"],
      ] as const) {
        expect(fieldNamed(schemas[protocol], keyField)?.roles).toEqual(
          expect.arrayContaining(["primary-key", "feature-id"]),
        );
      }
    });

    it("keeps Esri's Polygon/MultiPolygon ambiguity distinct from OData's and GeoParquet's unambiguous Polygon declaration", async () => {
      const schemas = await discoverParcelsSchemas();

      // Esri's geometryType enum cannot distinguish single- from
      // multi-part polygons at declaration time, so both GeoServices REST
      // and gRPC (which reuses the identical REST-shaped metadata) report a
      // "mixed" knowledge state.
      const geoservicesGeometry = geometryKnowledge(schemas.geoservices);
      expect(geoservicesGeometry).toEqual({ state: "mixed", types: ["MultiPolygon", "Polygon"] });
      expect(geometryKnowledge(schemas.grpc)).toEqual(geoservicesGeometry);
      expect(geometryKnowledge(schemas.geoservicesMap)).toEqual(geoservicesGeometry);

      // OData's Edm.GeographyPolygon and GeoParquet's declared geometry_types
      // are both unambiguous, so they normalize to a single known type.
      expect(geometryKnowledge(schemas.odata)).toEqual({ state: "known", type: "Polygon" });
      expect(geometryKnowledge(schemas.geoparquet)).toEqual({ state: "known", type: "Polygon" });
    });

    it("keeps OData's special-float wire encoding distinct from GeoServices' and GeoParquet's plain float64", async () => {
      const schemas = await discoverParcelsSchemas();

      // OData's wire format allows IEEE-754 special float literals (NaN,
      // INF) encoded as strings, so Edm.Double always normalizes to a
      // {float64 | special-string} union — never a plain float — while
      // GeoServices' and GeoParquet's numeric encodings have no such
      // escape hatch and normalize to a plain 64-bit float.
      expect(fieldNamed(schemas.odata, "AreaSqm")?.type).toEqual({
        kind: "union",
        members: [
          { kind: "float", bits: 64 },
          { kind: "string", encoding: "odata-special-float" },
        ],
      });
      expect(fieldNamed(schemas.geoservices, "AREA_SQM")?.type).toEqual({ kind: "float", bits: 64 });
      expect(fieldNamed(schemas.grpc, "AREA_SQM")?.type).toEqual({ kind: "float", bits: 64 });
      expect(fieldNamed(schemas.geoparquet, "area_sqm")?.type).toEqual({ kind: "float", bits: 64 });
    });
  });

  describe("structurally schema-less protocols never invent a field inventory for the same resource", () => {
    it("carries no legacy schema and explicit unavailable schema state when fields are not advertised", async () => {
      const [wfs, ogcFeatures, wms, wmts, stac, geoservicesImage, ogcRecords, ogcTiles, ogcMaps, pmtiles] =
        await Promise.all([
          connectWithSourceSchemaV2({
            endpoint: WFS_ENDPOINT,
            protocol: "wfs",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: wfsFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: OGC_FEATURES_ENDPOINT,
            protocol: "ogc-features",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: ogcFeaturesFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: WMS_ENDPOINT,
            protocol: "wms",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: wmsFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: WMTS_ENDPOINT,
            protocol: "wmts",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: wmtsFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: STAC_ENDPOINT,
            protocol: "stac",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: stacFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: GEOSERVICES_IMAGE_ENDPOINT,
            protocol: "geoservices-image-service",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: geoservicesImageFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: OGC_RECORDS_ENDPOINT,
            protocol: "ogc-records",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: ogcRecordsFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: OGC_TILES_ENDPOINT,
            protocol: "ogc-tiles",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: ogcTilesFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: OGC_MAPS_ENDPOINT,
            protocol: "ogc-maps",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: ogcMapsFetchHandler() },
          }),
          connectWithSourceSchemaV2({
            endpoint: PMTILES_ENDPOINT,
            protocol: "pmtiles",
            authorizationScopeFingerprint: "anonymous",
            clientOptions: { fetchFn: pmtilesRangeFetch().fetchFn },
          }),
        ]);

      // WFS and OGC Features: vector protocols. Discovery does not return a
      // field inventory, so the focused path preserves that fact as an
      // unavailable identity while retaining vector capabilities.
      const wfsSource = wfs.inspection.sources.find((source) => source.descriptor.id === "parcels")!;
      expect(wfsSource.descriptor.schema).toBeUndefined();
      expect(wfsSource.descriptor.schemaV2).toBeUndefined();
      expect(wfsSource.descriptor.schemaV2State).toMatchObject({ state: "unavailable", reason: "not-advertised" });
      expect(wfsSource.descriptor.capabilities.has("query")).toBe(true);

      const ogcSource = ogcFeatures.inspection.sources.find((source) => source.descriptor.id === "parcels")!;
      expect(ogcSource.descriptor.schema).toBeUndefined();
      expect(ogcSource.descriptor.schemaV2).toBeUndefined();
      expect(ogcSource.descriptor.schemaV2State).toMatchObject({ state: "unavailable", reason: "not-advertised" });
      expect(ogcSource.descriptor.capabilities.has("query")).toBe(true);

      // WMS and WMTS: render/tile-only protocols. Both explicitly report
      // "no field inventory", but for different, protocol-accurate reasons:
      // WMS layers *might* be queryable via GetFeatureInfo (unknown pending
      // metadata), WMTS tiles never carry per-feature attributes at all.
      const wmsSource = wms.inspection.sources.find((source) => source.descriptor.id === "imagery")!;
      expect(wmsSource.descriptor.schema).toBeUndefined();
      expect(wmsSource.descriptor.schemaV2).toBeUndefined();
      expect(wmsSource.descriptor.schemaV2State).toMatchObject({ state: "unavailable", reason: "not-advertised" });

      const wmtsSource = wmts.inspection.sources.find((source) => source.descriptor.id === "imagery")!;
      expect(wmtsSource.descriptor.schema).toBeUndefined();
      expect(wmtsSource.descriptor.schemaV2).toBeUndefined();
      expect(wmtsSource.descriptor.schemaV2State).toMatchObject({ state: "unavailable", reason: "not-advertised" });

      // STAC: a catalog/item protocol, not an attribute-schema protocol.
      const stacSource = stac.inspection.sources.find((source) => source.descriptor.id === "imagery")!;
      expect(stacSource.descriptor.schema).toBeUndefined();
      expect(stacSource.descriptor.schemaV2).toBeUndefined();
      expect(stacSource.descriptor.schemaV2State).toMatchObject({ state: "unavailable", reason: "not-advertised" });
      expect(stacSource.descriptor.capabilities.has("query")).toBe(true);

      const geoservicesImageSource = geoservicesImage.inspection.sources[0];
      expect(geoservicesImageSource?.descriptor.schema).toBeDefined();
      expect(geoservicesImageSource?.descriptor.schemaV2).toBeUndefined();
      expect(geoservicesImageSource?.descriptor.schemaV2State).toMatchObject({
        state: "unavailable",
        reason: "not-advertised",
      });
      expect(geoservicesImageSource?.descriptor.schema?.primaryKey).toBe("OBJECTID");
      expect(geoservicesImageSource?.descriptor.capabilities.has("query")).toBe(true);

      const recordsSource = ogcRecords.inspection.sources.find((source) => source.descriptor.id === "parcels")!;
      expect(recordsSource.descriptor.schema).toBeUndefined();
      expect(recordsSource.descriptor.schemaV2).toBeUndefined();
      expect(recordsSource.descriptor.schemaV2State).toMatchObject({
        state: "unavailable",
        reason: "not-advertised",
      });

      const tilesSource = ogcTiles.inspection.sources.find((source) => source.descriptor.id === "parcels")!;
      expect(tilesSource.descriptor.schema).toBeUndefined();
      expect(tilesSource.descriptor.schemaV2).toBeUndefined();
      expect(tilesSource.descriptor.schemaV2State).toMatchObject({ state: "unavailable", reason: "not-advertised" });

      const mapsSource = ogcMaps.inspection.sources.find((source) => source.descriptor.id === "parcels")!;
      expect(mapsSource.descriptor.schema).toBeUndefined();
      expect(mapsSource.descriptor.schemaV2).toBeUndefined();
      expect(mapsSource.descriptor.schemaV2State).toMatchObject({ state: "unavailable", reason: "not-advertised" });

      const pmtilesSource = pmtiles.inspection.sources.find((source) => source.descriptor.id === "pmtiles")!;
      expect(pmtilesSource.descriptor.schema).toBeUndefined();
      expect(pmtilesSource.descriptor.schemaV2).toBeUndefined();
      expect(pmtilesSource.descriptor.schemaV2State).toMatchObject({ state: "unavailable", reason: "not-advertised" });
      expect(pmtilesSource.descriptor.capabilities.has("tiles")).toBe(true);
    });

    it("keeps each protocol's native CRS encoding of the same real-world WGS84 area distinct rather than silently coalescing them", async () => {
      // The very same geographic area is advertised as three different
      // native CRS identifiers across these three protocols — connect()
      // preserves each verbatim rather than resolving cross-authority
      // equivalence (EPSG:4326 vs the OGC CRS84 URI form) on the caller's
      // behalf.
      const [wfs, ogcFeatures, stac] = await Promise.all([
        connect({
          endpoint: WFS_ENDPOINT,
          protocol: "wfs",
          authorizationScopeFingerprint: "anonymous",
          clientOptions: { fetchFn: wfsFetchHandler() },
        }),
        connect({
          endpoint: OGC_FEATURES_ENDPOINT,
          protocol: "ogc-features",
          authorizationScopeFingerprint: "anonymous",
          clientOptions: { fetchFn: ogcFeaturesFetchHandler() },
        }),
        connect({
          endpoint: STAC_ENDPOINT,
          protocol: "stac",
          authorizationScopeFingerprint: "anonymous",
          clientOptions: { fetchFn: stacFetchHandler() },
        }),
      ]);

      expect(wfs.inspection.sources[0]?.metadata?.crs).toEqual(["urn:ogc:def:crs:EPSG::4326"]);
      expect(ogcFeatures.inspection.sources[0]?.metadata?.crs).toEqual([
        "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
      ]);
      expect(stac.inspection.sources[0]?.metadata?.crs).toEqual(["http://www.opengis.net/def/crs/OGC/1.3/CRS84"]);
    });
  });

  describe("cache / refresh / cancellation / auth-scope isolation hold uniformly across the full protocol matrix", () => {
    it.each(MATRIX_CASES)(
      "$label: a cache hit reapplies capability policy without any new discovery activity",
      async ({ build }) => {
        const { options, activity } = build();
        const cache = spyCache();

        const first = await connect({ ...options, authorizationScopeFingerprint: "anonymous", cache });
        const activityAfterFirst = activity();
        expect(activityAfterFirst).toBeGreaterThan(0);
        expect(first.inspection.cacheStatus).toBe("miss");

        const second = await connect({ ...options, authorizationScopeFingerprint: "anonymous", cache });
        expect(second.inspection.cacheStatus).toBe("hit");
        expect(second.inspection.protocol).toBe(first.inspection.protocol);
        expect(activity()).toBe(activityAfterFirst);
      },
    );

    it.each(MATRIX_CASES)("$label: refresh always bypasses a cache read and revalidates", async ({ build }) => {
      const { options, activity } = build();
      const cache = { get: vi.fn(), set: vi.fn() };

      const result = await connect({ ...options, authorizationScopeFingerprint: "anonymous", refresh: true, cache });

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).toHaveBeenCalledOnce();
      expect(result.inspection.cacheStatus).toBe("refreshed");
      expect(activity()).toBeGreaterThan(0);
    });

    it.each(MATRIX_CASES)(
      "$label: cancellation before network rejects without any discovery activity",
      async ({ build }) => {
        const { options, activity } = build();
        const controller = new AbortController();
        controller.abort();

        await expect(
          connect({ ...options, authorizationScopeFingerprint: "anonymous", signal: controller.signal }),
        ).rejects.toBeInstanceOf(HonuaAbortError);
        expect(activity()).toBe(0);
      },
    );

    it.each(MATRIX_CASES)(
      "$label: a different authorization scope fingerprint is a distinct cache identity and triggers fresh discovery",
      async ({ build }) => {
        const { options, activity } = build();
        const cache = spyCache();

        const first = await connect({ ...options, authorizationScopeFingerprint: "role:viewer:v1", cache });
        const activityAfterFirst = activity();
        expect(first.inspection.cacheStatus).toBe("miss");

        const second = await connect({ ...options, authorizationScopeFingerprint: "role:editor:v1", cache });

        expect(second.inspection.cacheStatus).toBe("miss");
        expect(activity()).toBeGreaterThan(activityAfterFirst);
        expect(first.inspection.cacheIdentity.key).not.toBe(second.inspection.cacheIdentity.key);
      },
    );
  });

  describe("malformed optional metadata degrades one field, not the whole descriptor", () => {
    it("degrades an unrecognized GeoServices coded-value domain to an explicit unknown reason while every other field, and the descriptor itself, stays intact", async () => {
      const layerWithMalformedDomain: HonuaLayerMetadata = {
        ...PARCELS_LAYER,
        fields: [
          ...PARCELS_LAYER.fields!,
          {
            name: "STATUS",
            type: "esriFieldTypeString",
            // Malformed: codedValues must be an array; a string is not
            // recoverable, so the SDK must degrade this one field's domain
            // rather than fail discovery outright.
            domain: { type: "codedValue", codedValues: "not-an-array" } as never,
          },
        ],
      };

      const connection = await connectWithSourceSchemaV2({
        endpoint: GEOSERVICES_ENDPOINT,
        protocol: "geoservices-feature-service",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: geoservicesFetchHandler(layerWithMalformedDomain) },
      });

      const schema = connection.inspection.sources[0]!.descriptor.schemaV2!;
      expect(fieldNamed(schema, "STATUS")?.domain).toMatchObject({ state: "unknown", reason: "unrecognized" });
      // Every other field's identity is unaffected by the corrupt domain.
      expect(fieldNamed(schema, "NAME")?.type).toEqual({ kind: "string" });
      expect(fieldNamed(schema, "OBJECTID")?.roles).toEqual(expect.arrayContaining(["primary-key", "feature-id"]));
      expect(connection.inspection.sources[0]!.descriptor.schema).toBeDefined();
    });

    it("degrades an OData enum with a duplicate member name to an explicit unrecognized reason without dropping the entity's source schema", async () => {
      const metadataWithConflictingEnum = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Honua">
      <EnumType Name="ParcelStatus">
        <Member Name="Active" Value="0"/>
        <Member Name="Active" Value="1"/>
      </EnumType>
      <EntityType Name="ParcelEntity">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="Status" Type="Honua.ParcelStatus"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parcels" EntityType="Honua.ParcelEntity"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

      const connection = await connectWithSourceSchemaV2({
        endpoint: ODATA_ENDPOINT,
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: odataFetchHandler(metadataWithConflictingEnum) },
      });

      const schema = connection.inspection.sources[0]!.descriptor.schemaV2!;
      expect(fieldNamed(schema, "Status")?.domain).toMatchObject({ state: "unknown", reason: "unrecognized" });
      expect(fieldNamed(schema, "Name")?.type).toEqual({ kind: "string" });
      expect(connection.inspection.sources[0]!.descriptor.schema).toBeDefined();
      expect(connection.source("Parcels").capabilities.has("query")).toBe(true);
    });
  });
});
