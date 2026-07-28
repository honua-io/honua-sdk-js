import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GeoParquetSourceProfile, GeoParquetSourceProfiler } from "../src/connect-geoparquet.js";
import type { ConnectDiscoverySnapshot } from "../src/connect.js";
import { schemaStateBindingFingerprint } from "../src/contract/schema.js";
import type { Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { HONUA_MINIMUM_SUPPORTED_SERVER_VERSION, HonuaClient } from "../src/core/client.js";
import type { HonuaLayerMetadata, HonuaQueryResponse } from "../src/core/types.js";
import { createCapabilitySourceEndpointFingerprint } from "../src/source-capabilities.js";
import {
  type SourceCapabilityConnectOptions,
  type SourceCapabilityEvaluationOptions,
  connectWithSourceCapabilities,
  sourceCapabilityEndpointIdentity,
} from "../src/source-capability-discovery.js";

type EndpointDescriptorFixture = Pick<SourceDescriptor, "id" | "protocol" | "locator">;

const OBSERVED_AT = "2026-07-15T00:00:00.000Z";
const EVALUATED_AT = "2026-07-15T00:01:00Z";
const WMS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/wms/capabilities.xml", import.meta.url),
  "utf8",
);
const WMTS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/wmts/capabilities.xml", import.meta.url),
  "utf8",
);
const WFS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/geoserver-wfs/capabilities.xml", import.meta.url),
  "utf8",
);
const PMTILES_ASSET_URL = "https://assets.example.test/maps/basemap.pmtiles";
const PMTILES_ETAG = '"pmtiles-fixture-v1"';
const GRPC_LAYER: HonuaLayerMetadata = {
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
const GEOSERVICES_IMAGE_ENDPOINT = "https://example.test/rest/services/elevation/ImageServer";
const GRPC_ENDPOINT = "https://example.test/rest/services/parcels/FeatureServer/0";
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
const OGC_TILES_ENDPOINT = "https://tiles.example/ogc/tiles";
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
const STAC_ENDPOINT = "https://catalog.example.stac/v1";
const STAC_LANDING = {
  id: "geo-catalog",
  conformsTo: ["https://api.stacspec.org/v1.0.0/core", "https://api.stacspec.org/v1.0.0/item-search"],
  links: [
    { rel: "data", href: "./collections" },
    { rel: "search", href: "./search", type: "application/geo+json" },
  ],
};
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
const STAC_COLLECTIONS = {
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
const GEOPARQUET_ENDPOINT = "https://fixtures.test/places.parquet";

afterEach(() => vi.useRealTimers());

describe("capability discovery endpoint binding", () => {
  it("canonicalizes base and already-resolved GeoServices descriptors to one layer identity", () => {
    const base = geoDescriptor("https://example.test/arcgis", "Public/Parcels & Lots", 7);
    const resolved = geoDescriptor(
      "https://example.test/arcgis/rest/services/Public/Parcels%20%26%20Lots/FeatureServer/7",
      "Public/Parcels & Lots",
      7,
    );

    expect(sourceCapabilityEndpointIdentity(base)).toEqual({
      endpoint: "https://example.test/arcgis/rest/services/Public/Parcels%20%26%20Lots/FeatureServer/7",
      protocol: "geoservices-feature-service",
      sourceId: "7",
    });
    expect(createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(base))).toBe(
      createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(resolved)),
    );
  });

  it("binds OData entity sets and rejects contradictory or credential-bearing replay coordinates", () => {
    const odata: Pick<SourceDescriptor, "id" | "protocol" | "locator"> = {
      id: "Work Orders",
      protocol: "odata",
      locator: { url: "https://example.test/v4/", entitySet: "Work Orders" },
    };
    expect(sourceCapabilityEndpointIdentity(odata)).toEqual({
      endpoint: "https://example.test/v4/Work%20Orders",
      protocol: "odata",
      sourceId: "Work Orders",
    });

    const originOnly = {
      ...odata,
      locator: { ...odata.locator, url: "https://example.test" },
    };
    const explicitDefaultPath = {
      ...odata,
      locator: { ...odata.locator, url: "https://example.test/odata" },
    };
    expect(sourceCapabilityEndpointIdentity(originOnly)).toEqual({
      endpoint: "https://example.test/odata/Work%20Orders",
      protocol: "odata",
      sourceId: "Work Orders",
    });
    expect(createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(originOnly))).toBe(
      createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(explicitDefaultPath)),
    );

    const layerScoped = {
      ...odata,
      id: "1",
      locator: { url: "https://example.test", layerId: 1 },
    };
    expect(sourceCapabilityEndpointIdentity(layerScoped)).toEqual({
      endpoint: "https://example.test/odata/Layers(1)/Features",
      protocol: "odata",
      sourceId: "1",
    });
    expect(createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(layerScoped))).toBe(
      createCapabilitySourceEndpointFingerprint(
        sourceCapabilityEndpointIdentity({
          ...layerScoped,
          locator: { url: "https://example.test/odata", layerId: 1 },
        }),
      ),
    );

    expect(() =>
      sourceCapabilityEndpointIdentity(
        geoDescriptor("https://example.test/rest/services/Public/Parcels/FeatureServer/8", "Public/Parcels", 7),
      ),
    ).toThrow(/layer contradicts/);
    expect(() =>
      sourceCapabilityEndpointIdentity({
        ...odata,
        locator: { ...odata.locator, url: "https://u:p@example.test/v4" },
      }),
    ).toThrow(/credentials/);
    expect(() =>
      sourceCapabilityEndpointIdentity({
        ...odata,
        locator: { ...odata.locator, url: "https://example.test/v4?sig=x" },
      }),
    ).toThrow(/query or fragment/);
    expect(() =>
      sourceCapabilityEndpointIdentity({
        ...odata,
        locator: { ...odata.locator, url: "file:///tmp/v4" },
      }),
    ).toThrow(/HTTP/);
    for (const entitySet of [".", ".."] as const) {
      expect(() =>
        sourceCapabilityEndpointIdentity({
          ...odata,
          locator: { ...odata.locator, entitySet },
        }),
      ).toThrow(/routable path identifier/);
    }
  });

  it("binds WMS and WMTS service/layer identities without retaining operation URLs", () => {
    const wms = rasterDescriptor("wms", "https://example.test/ogc/wms", "parcels");
    const wmts = rasterDescriptor("wmts", "https://example.test/ogc/wmts", "imagery");

    expect(sourceCapabilityEndpointIdentity(wms)).toEqual({
      endpoint: "https://example.test/ogc/wms",
      protocol: "wms",
      sourceId: "parcels",
    });
    expect(sourceCapabilityEndpointIdentity(wmts)).toEqual({
      endpoint: "https://example.test/ogc/wmts",
      protocol: "wmts",
      sourceId: "imagery",
    });
    expect(() => sourceCapabilityEndpointIdentity({ ...wms, id: "roads" })).toThrow(/must match locator\.typeName/);
    expect(() =>
      sourceCapabilityEndpointIdentity({
        ...wmts,
        locator: { ...wmts.locator, url: "https://example.test/ogc/wmts?token=secret" },
      }),
    ).toThrow(/query or fragment/);
  });

  it("binds gRPC, WFS, OGC API, and GeoParquet identities with protocol-specific canonicalization", () => {
    const grpc: EndpointDescriptorFixture = {
      id: "7",
      protocol: "grpc",
      locator: {
        url: "https://example.test/arcgis/rest/services/Transportation/FeatureServer",
        serviceId: "Transportation",
        layerId: 7,
      },
    };
    expect(sourceCapabilityEndpointIdentity(grpc)).toEqual({
      endpoint: "https://example.test/arcgis/rest/services/Transportation/FeatureServer/7",
      protocol: "grpc",
      sourceId: "7",
    });

    const wfs: EndpointDescriptorFixture = {
      id: "ne:ne_10m_admin_0_countries",
      protocol: "wfs",
      locator: { url: "https://ahocevar.com/geoserver/wfs", typeName: "ne:ne_10m_admin_0_countries" },
    };
    expect(sourceCapabilityEndpointIdentity(wfs)).toEqual({
      endpoint: "https://ahocevar.com/geoserver/wfs",
      protocol: "wfs",
      sourceId: "ne:ne_10m_admin_0_countries",
    });

    const ogcFeatures: EndpointDescriptorFixture = {
      id: "incidents",
      protocol: "ogc-features",
      locator: { url: "https://example.test/ogc", collectionId: "incidents" },
    };
    expect(sourceCapabilityEndpointIdentity(ogcFeatures)).toEqual({
      endpoint: "https://example.test/ogc",
      protocol: "ogc-features",
      sourceId: "incidents",
    });

    const ogcRecords: EndpointDescriptorFixture = {
      id: "counties",
      protocol: "ogc-records",
      locator: { url: "https://example.test", basePath: "/api/v1/admin", collectionId: "counties" },
    };
    expect(sourceCapabilityEndpointIdentity(ogcRecords)).toEqual({
      endpoint: "https://example.test/api/v1/admin",
      protocol: "ogc-records",
      sourceId: "counties",
    });

    const geoparquet: EndpointDescriptorFixture = {
      id: "places",
      protocol: "geoparquet",
      locator: { url: "https://cdn.example.test/places.parquet", geoparquet: { geometryColumn: "shape" } },
    };
    expect(sourceCapabilityEndpointIdentity(geoparquet)).toEqual({
      endpoint: "https://cdn.example.test/places.parquet",
      protocol: "geoparquet",
      sourceId: "places",
    });
  });

  it("binds PMTiles identity to the archive URL", () => {
    expect(
      sourceCapabilityEndpointIdentity({
        id: "pmtiles",
        protocol: "pmtiles",
        locator: { url: PMTILES_ASSET_URL, sourceType: "vector" },
      }),
    ).toEqual({
      endpoint: PMTILES_ASSET_URL,
      protocol: "pmtiles",
      sourceId: "pmtiles",
    });
  });
});

describe("connectWithSourceCapabilities", () => {
  it("projects PMTiles source descriptors through source schema v2 and binds PMTiles capability truth", async () => {
    useDiscoveryClock();
    const { fetchFn } = pmtilesRangeFetch();
    const connection = await connectWithSourceCapabilities(
      {
        endpoint: PMTILES_ASSET_URL,
        protocol: "pmtiles",
        authorizationScopeFingerprint: "public",
        clientOptions: { fetchFn },
      },
      { evaluatedAt: EVALUATED_AT },
    );

    const source = connection.source();
    expect(source.descriptor.schemaV2).toMatchObject({
      fields: [],
      key: { state: "none" },
      geometry: { state: "none", reason: "no-geometry-fields" },
      temporal: { state: "none" },
      openContent: "closed",
    });
    expect(source.capabilityProfile.sourceFingerprint).toBe(source.descriptor.schemaV2.fingerprint);
    expect(source.capabilityProfile.sourceEndpointFingerprint).toBe(
      createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(source.descriptor)),
    );
    expect(capability(source, "tiles")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "query")).toMatchObject({
      claimed: "unsupported",
      observed: "not-observed",
      effective: "unsupported",
    });
    expect(connection.dataset.sourceDescriptors[0]).toBe(connection.inspection.sources[0]!.descriptor);
  });

  it("projects gRPC capability truth through a parity-ready probe and rejects no-op query variants", async () => {
    useDiscoveryClock();
    const grpcClient = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: grpcFetchHandler(),
    });
    vi.spyOn(grpcClient, "queryFeatures").mockResolvedValue({
      objectIdFieldName: "OBJECTID",
      geometryType: "esriGeometryPolygon",
      fields: [
        { name: "OBJECTID", type: "esriFieldTypeOID" },
        { name: "NAME", type: "esriFieldTypeString" },
        { name: "AREA_SQM", type: "esriFieldTypeDouble" },
      ],
      features: [],
    } satisfies HonuaQueryResponse);

    const connection = await connectWithSourceCapabilities(
      {
        endpoint: GRPC_ENDPOINT,
        protocol: "grpc",
        authorizationScopeFingerprint: "anonymous",
        client: grpcClient,
      },
      { evaluatedAt: EVALUATED_AT },
    );
    const source = connection.source();
    expect(capability(source, "query")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "queryAggregate")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
    });
    expect(capability(source, "applyEdits")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });
    expect(capability(source, "stream")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(source.supports("queryAggregate")).toBe(false);
    expect(source.supports("stream")).toBe(true);
  });

  it("projects OGC Features and STAC conformance-backed query-only capability truth", async () => {
    useDiscoveryClock();
    const ogcFeaturesConnection = await connectWithSourceCapabilities(
      {
        endpoint: OGC_FEATURES_ENDPOINT,
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: ogcFeaturesFetchHandler() },
      },
      { evaluatedAt: EVALUATED_AT },
    );
    const ogcFeaturesSource = ogcFeaturesConnection.source("parcels");
    expect(capability(ogcFeaturesSource!, "query")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(ogcFeaturesSource!, "queryObjectIds")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(ogcFeaturesSource!, "applyEdits")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });

    const stacConnection = await connectWithSourceCapabilities(
      {
        endpoint: STAC_ENDPOINT,
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: stacFetchHandler() },
      },
      { evaluatedAt: EVALUATED_AT },
    );
    const stacSource = stacConnection.source("imagery");
    expect(capability(stacSource!, "query")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(stacSource!, "queryObjectIds")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(stacSource!, "stream")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
      reasons: ["supported-by-claim-and-observation"],
    });
  });

  it("projects GeoParquet discovery through a profiler seam and surfaces only supported vector operations", async () => {
    useDiscoveryClock();
    const profile = fakeParcelsProfiler({
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
      crs: "EPSG:4326",
      rowEstimate: 4,
    });
    const geoparquetConnection = await connectWithSourceCapabilities(
      {
        endpoint: GEOPARQUET_ENDPOINT,
        protocol: "geoparquet",
        authorizationScopeFingerprint: "anonymous",
        geoparquet: {
          profiler: profile.profiler,
        },
        resolveSource: resolveGeoparquetSource,
      },
      { evaluatedAt: EVALUATED_AT },
    );
    const source = geoparquetConnection.source();
    expect(capability(source, "query")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "queryAggregate")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "stream")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "applyEdits")).toMatchObject({
      claimed: "unsupported",
      observed: "not-observed",
      effective: "unsupported",
    });
    expect(source.supports("queryAggregate")).toBe(true);
    expect(source.supports("applyEdits")).toBe(false);
  });

  it("projects GeoServices ImageServer capabilities without inventing unsupported tile claims", async () => {
    useDiscoveryClock();
    const connection = await connectWithSourceCapabilities(
      {
        endpoint: GEOSERVICES_IMAGE_ENDPOINT,
        protocol: "geoservices-image-service",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: geoservicesImageFetchHandler() },
      },
      { evaluatedAt: EVALUATED_AT },
    );
    const source = connection.source();
    expect(capability(source, "query")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "queryObjectIds")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "image")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "render")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(source, "tiles")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });
  });

  it("projects OGC catalog, tile, and map families from conformance with render-accurate scopes", async () => {
    useDiscoveryClock();
    const recordsConnection = await connectWithSourceCapabilities(
      {
        endpoint: OGC_RECORDS_ENDPOINT,
        protocol: "ogc-records",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: ogcRecordsFetchHandler() },
      },
      { evaluatedAt: EVALUATED_AT },
    );
    const recordsSource = recordsConnection.source("parcels");
    expect(capability(recordsSource!, "query")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });
    expect(capability(recordsSource!, "queryObjectIds")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });
    expect(capability(recordsSource!, "stream")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });

    const tilesConnection = await connectWithSourceCapabilities(
      {
        endpoint: OGC_TILES_ENDPOINT,
        protocol: "ogc-tiles",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: ogcTilesFetchHandler() },
      },
      { evaluatedAt: EVALUATED_AT },
    );
    const tilesSource = tilesConnection.source("parcels");
    expect(capability(tilesSource!, "tiles")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(tilesSource!, "render")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });

    const mapsConnection = await connectWithSourceCapabilities(
      {
        endpoint: OGC_MAPS_ENDPOINT,
        protocol: "ogc-maps",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: ogcMapsFetchHandler() },
      },
      { evaluatedAt: EVALUATED_AT },
    );
    const mapsSource = mapsConnection.source("parcels");
    expect(capability(mapsSource!, "render")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(mapsSource!, "query")).toMatchObject({
      claimed: "unsupported",
      observed: "not-observed",
      effective: "unsupported",
      reasons: ["unsupported-by-claim"],
    });
  });

  it("projects GeoServices metadata once and exposes one schema/endpoint-bound effective profile", async () => {
    useDiscoveryClock();
    let cached: ConnectDiscoverySnapshot | undefined;
    const fetchFn = vi.fn(async () =>
      json({
        id: 0,
        name: "Parcels",
        capabilities: "Query,Create,Update,Delete",
        supportsStatistics: true,
        advancedQueryCapabilities: {
          supportsPagination: true,
          supportsReturningQueryExtent: true,
        },
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID" },
          { name: "STATUS", type: "esriFieldTypeString" },
        ],
      }),
    );
    const connection = await connectWithSourceCapabilities(
      {
        endpoint: "https://example.test/arcgis/rest/services/Public/Parcels/FeatureServer/0",
        protocol: "auto",
        authorizationScopeFingerprint: "role:editor:v1",
        clientOptions: { fetchFn },
        cache: {
          get: () => undefined,
          set: (_identity, snapshot) => {
            cached = snapshot;
          },
        },
      },
      {
        evaluatedAt: EVALUATED_AT,
        policy: { deny: ["applyEdits"] },
        environment: "browser",
      },
    );

    const source = connection.source();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(source.descriptor.schemaV2.fingerprint).toBe(source.capabilityProfile.sourceFingerprint);
    expect(source.capabilityProfile.sourceEndpointFingerprint).toBe(
      createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(source.descriptor)),
    );
    expect(capability(source, "query")).toMatchObject({
      effective: "supported",
      reasons: ["supported-by-claim-and-observation"],
    });
    expect(capability(source, "applyEdits")).toMatchObject({
      observed: "supported",
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(source.supports("query")).toBe(true);
    expect(source.supports("applyEdits")).toBe(false);
    expect([...source.capabilities]).toEqual([...connection.inspection.sources[0]!.descriptor.capabilities]);
    expect(connection.dataset.sourceDescriptors[0]).toBe(connection.inspection.sources[0]!.descriptor);
    expect(JSON.stringify(source.capabilityProfile)).not.toContain("https://example.test");
    expect(cached?.sources[0]).not.toHaveProperty("capabilityProfile");
  });

  it("does not reuse a stale discovery policy when evaluation omits policy", async () => {
    useDiscoveryClock();
    const reusedOptions = {
      ...odataOptions("https://example.test/odata"),
      capabilityPolicy: { deny: ["query"] },
    } as unknown as SourceCapabilityConnectOptions;
    const connection = await connectWithSourceCapabilities(reusedOptions, { evaluatedAt: EVALUATED_AT });

    expect(capability(connection.source(), "query")).toMatchObject({
      effective: "supported",
      reasons: ["supported-by-claim-and-observation"],
    });
    expect(connection.source().supports("query")).toBe(true);
    expect(connection.source().capabilities.has("query")).toBe(true);
  });

  it("produces equivalent OData decisions across facade and third-party roots while retaining endpoint identity", async () => {
    useDiscoveryClock();
    const facade = await connectWithSourceCapabilities(odataOptions("https://facade.test/odata"), {
      evaluatedAt: EVALUATED_AT,
      environment: "node",
      availablePeers: ["maplibre-gl"],
    });
    const thirdParty = await connectWithSourceCapabilities(odataOptions("https://vendor.test/v4"), {
      evaluatedAt: EVALUATED_AT,
      environment: "node",
      availablePeers: ["maplibre-gl"],
    });

    expect(facade.source().descriptor.schemaV2.fingerprint).toBe(thirdParty.source().descriptor.schemaV2.fingerprint);
    expect(facade.source().capabilityProfile.entries).toEqual(thirdParty.source().capabilityProfile.entries);
    expect(facade.source().capabilityProfile.context).toEqual(thirdParty.source().capabilityProfile.context);
    expect(facade.source().capabilityProfile.sourceEndpointFingerprint).not.toBe(
      thirdParty.source().capabilityProfile.sourceEndpointFingerprint,
    );
    expect(capability(facade.source(), "queryObjectIds")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
    });
    expect(capability(facade.source(), "tiles")).toMatchObject({
      claimed: "unsupported",
      observed: "not-observed",
      effective: "unsupported",
    });
  });

  it("records unavailable GeoServices metadata as unknown instead of restoring adapter defaults", async () => {
    useDiscoveryClock();
    const connection = await connectWithSourceCapabilities(
      {
        endpoint: "https://example.test/rest/services/Parcels/FeatureServer/0",
        protocol: "auto",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: vi.fn(async () =>
            json({
              id: 0,
              name: "Parcels",
              fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
            }),
          ),
        },
      },
      { evaluatedAt: EVALUATED_AT },
    );

    expect(capability(connection.source(), "query")).toMatchObject({
      claimed: "supported",
      observed: "unknown",
      effective: "unknown",
      reasons: ["observation-unknown"],
    });
    expect(connection.source().supports("query")).toBe(false);
    expect([...connection.source().capabilities]).toEqual([]);
  });

  it("projects WMS/WMTS schema authority and operation-aware capability truth", async () => {
    useDiscoveryClock();
    const wms = await connectWithSourceCapabilities(
      rasterOptions("wms", "https://maps.example/ogc/wms", "parcels", WMS_CAPABILITIES),
      { evaluatedAt: EVALUATED_AT, policy: { deny: ["tiles"] } },
    );
    const wmts = await connectWithSourceCapabilities(
      rasterOptions("wmts", "https://tiles.example/ogc/wmts", "imagery", WMTS_CAPABILITIES),
      { evaluatedAt: EVALUATED_AT },
    );

    expect(wms.source().descriptor.schemaV2).toBeUndefined();
    expect(wms.source().descriptor.schemaV2State).toMatchObject({
      state: "unavailable",
      reason: "not-advertised",
    });
    expect(wmts.source().descriptor.schemaV2).toBeUndefined();
    expect(wmts.source().descriptor.schemaV2State).toMatchObject({
      state: "unavailable",
      reason: "not-advertised",
    });
    for (const connection of [wms, wmts]) {
      const source = connection.source();
      expect(source.descriptor.schemaV2State).toBeDefined();
      expect(schemaStateBindingFingerprint(source.descriptor.schemaV2State!)).toBe(
        source.capabilityProfile.sourceFingerprint,
      );
      expect(source.capabilityProfile.sourceEndpointFingerprint).toBe(
        createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(source.descriptor)),
      );
      expect(JSON.stringify(source.capabilityProfile)).not.toContain("https://");
    }
    expect(capability(wms.source(), "render")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(wms.source(), "tiles")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(capability(wms.source(), "query")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });
    expect(wms.source().supports("render")).toBe(true);
    expect(wms.source().supports("tiles")).toBe(false);
    expect(wms.source().supports("query")).toBe(false);
    expect(capability(wmts.source(), "render")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(wmts.source(), "tiles")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(wmts.source(), "query")).toMatchObject({
      claimed: "unsupported",
      observed: "not-observed",
      effective: "unsupported",
      reasons: ["unsupported-by-claim"],
    });
  });

  it("projects WFS schema and policy-bound capability truth", async () => {
    useDiscoveryClock();
    const wfs = await connectWithSourceCapabilities(
      wfsOptions("https://ahocevar.com/geoserver/wfs", "ne:ne_10m_admin_0_countries", WFS_CAPABILITIES),
      { evaluatedAt: EVALUATED_AT, policy: { deny: ["applyEdits"] }, environment: "node" },
    );
    expect(wfs.source("ne:ne_10m_admin_0_countries")).toBeDefined();
    expect(
      createCapabilitySourceEndpointFingerprint(
        sourceCapabilityEndpointIdentity(wfs.source("ne:ne_10m_admin_0_countries")!.descriptor),
      ),
    ).toBe(wfs.source("ne:ne_10m_admin_0_countries")!.capabilityProfile.sourceEndpointFingerprint);
    expect(capability(wfs.source("ne:ne_10m_admin_0_countries")!, "query")).toMatchObject({
      effective: "supported",
      reasons: ["supported-by-claim-and-observation"],
    });
    expect(capability(wfs.source("ne:ne_10m_admin_0_countries")!, "applyEdits")).toMatchObject({
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(capability(wfs.source("ne:ne_10m_admin_0_countries")!, "stream")).toMatchObject({
      reasons: ["supported-by-claim-and-observation"],
      effective: "supported",
    });
    expect(JSON.stringify(wfs.source("ne:ne_10m_admin_0_countries")!.capabilityProfile.context)).toContain("node");
    expect(wfs.dataset.sourceDescriptors[0].schemaV2.fingerprint).toBe(
      wfs.source("ne:ne_10m_admin_0_countries")!.descriptor.schemaV2.fingerprint,
    );
  });

  it("retains canonical Honua WMS FeatureInfo truth and reapplies policy after a raw cache hit", async () => {
    useDiscoveryClock();
    let snapshot: ConnectDiscoverySnapshot | undefined;
    const canonicalOptions = rasterOptions(
      "wms",
      "https://maps.example/rest/services/Public/Map/MapServer/WMS",
      "parcels",
      WMS_CAPABILITIES,
    );
    const first = await connectWithSourceCapabilities(
      {
        ...canonicalOptions,
        cache: {
          get: () => undefined,
          set: (_identity, value) => {
            snapshot = value;
          },
        },
      },
      { evaluatedAt: EVALUATED_AT },
    );
    expect(capability(first.source(), "query")).toMatchObject({
      observed: "supported",
      effective: "supported",
    });
    if (!snapshot) throw new Error("expected WMS discovery snapshot");
    expect(snapshot.sources[0]).not.toHaveProperty("capabilityProfile");

    const fetchFn = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const replay = await connectWithSourceCapabilities(
      {
        endpoint: canonicalOptions.endpoint,
        protocol: "wms",
        typeName: "parcels",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache: { get: () => structuredClone(snapshot), set: vi.fn() },
      },
      { evaluatedAt: EVALUATED_AT, policy: { deny: ["query"] } },
    );

    expect(replay.inspection.cacheStatus).toBe("hit");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(capability(replay.source(), "query")).toMatchObject({
      observed: "supported",
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(replay.source().supports("query")).toBe(false);
  });

  it("re-evaluates policy and freshness after a raw cache hit without fetching or caching evaluated truth", async () => {
    useDiscoveryClock();
    let snapshot: ConnectDiscoverySnapshot | undefined;
    const first = await connectWithSourceCapabilities(
      {
        ...odataOptions("https://example.test/odata"),
        cache: {
          get: () => undefined,
          set: (_identity, value) => {
            snapshot = value;
          },
        },
      },
      { evaluatedAt: EVALUATED_AT, observationTtlMs: 120_000 },
    );
    if (!snapshot) throw new Error("expected discovery snapshot");
    expect(capability(first.source(), "query").effective).toBe("supported");
    expect(snapshot.sources[0]).not.toHaveProperty("capabilityProfile");

    const fetchFn = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const denied = await connectWithSourceCapabilities(
      {
        endpoint: "https://example.test/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache: { get: () => structuredClone(snapshot), set: vi.fn() },
      },
      {
        evaluatedAt: "2026-07-15T00:01:30Z",
        observationTtlMs: 120_000,
        policy: { deny: ["query"] },
      },
    );
    expect(denied.inspection.cacheStatus).toBe("hit");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(capability(denied.source(), "query")).toMatchObject({
      observed: "supported",
      effective: "policy-disabled",
    });
    expect(denied.source().supports("query")).toBe(false);

    const stale = await connectWithSourceCapabilities(
      {
        endpoint: "https://example.test/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache: { get: () => structuredClone(snapshot), set: vi.fn() },
      },
      { evaluatedAt: "2026-07-15T00:02:00Z", observationTtlMs: 120_000 },
    );
    expect(capability(stale.source(), "query")).toMatchObject({
      effective: "unknown",
      reasons: ["evidence-stale"],
    });
    expect(stale.source().supports("query")).toBe(false);
  });

  it("fails before network access for unsupported protocols or invalid dynamic freshness input", async () => {
    const fetchFn = vi.fn();
    await expect(
      connectWithSourceCapabilities(
        {
          endpoint: "https://example.test/services/Geocoding/GeocodeServer",
          protocol: "geoservices-gp-service",
          authorizationScopeFingerprint: "anonymous",
          clientOptions: { fetchFn },
        } as unknown as SourceCapabilityConnectOptions,
        { evaluatedAt: EVALUATED_AT },
      ),
    ).rejects.toThrow(/currently certified/);
    await expect(
      connectWithSourceCapabilities(odataOptions("https://example.test/odata"), {
        evaluatedAt: EVALUATED_AT,
        observationTtlMs: 0,
      }),
    ).rejects.toThrow(/positive safe integer/);
    const validationOptions: SourceCapabilityConnectOptions = {
      endpoint: "https://example.test/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    };
    await expect(
      connectWithSourceCapabilities(validationOptions, {
        evaluatedAt: EVALUATED_AT,
        environment: "" as never,
      }),
    ).rejects.toThrow(/environment/);
    await expect(
      connectWithSourceCapabilities(validationOptions, {
        evaluatedAt: EVALUATED_AT,
        observationTtlMs: null as never,
      }),
    ).rejects.toThrow(/positive safe integer/);
    const accessorEvaluation = Object.defineProperty({ evaluatedAt: EVALUATED_AT }, "environment", {
      enumerable: true,
      get: () => "browser",
    }) as SourceCapabilityEvaluationOptions;
    await expect(connectWithSourceCapabilities(validationOptions, accessorEvaluation)).rejects.toThrow(/data property/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

function geoDescriptor(
  url: string,
  serviceId: string,
  layerId: number,
): Pick<SourceDescriptor, "id" | "protocol" | "locator"> {
  return {
    id: String(layerId),
    protocol: "geoservices-feature-service",
    locator: { url, serviceId, layerId },
  };
}

function rasterDescriptor(
  protocol: "wms" | "wmts",
  url: string,
  typeName: string,
): Pick<SourceDescriptor, "id" | "protocol" | "locator"> {
  return { id: typeName, protocol, locator: { url, typeName } };
}

function rasterOptions(
  protocol: "wms" | "wmts",
  endpoint: string,
  typeName: string,
  capabilities: string,
): SourceCapabilityConnectOptions {
  return {
    endpoint,
    protocol,
    typeName,
    authorizationScopeFingerprint: "anonymous",
    clientOptions: {
      fetchFn: vi.fn(
        async () =>
          new Response(capabilities, {
            status: 200,
            headers: { "Content-Type": "application/xml", ETag: '"capabilities-v1"' },
          }),
      ),
    },
  };
}

function odataOptions(endpoint: string): SourceCapabilityConnectOptions {
  return {
    endpoint,
    protocol: "odata",
    authorizationScopeFingerprint: "anonymous",
    clientOptions: {
      fetchFn: vi.fn(
        async () => new Response(odataMetadata(), { status: 200, headers: { "Content-Type": "application/xml" } }),
      ),
    },
  };
}

function odataMetadata(): string {
  return `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Example">
      <EntityType Name="Asset">
        <Property Name="Id" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
}

function capability(
  source: { readonly capabilityProfile: { readonly entries: readonly { readonly id: string }[] } },
  id: string,
) {
  const entry = source.capabilityProfile.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`missing capability ${id}`);
  return entry as (typeof source.capabilityProfile.entries)[number] & Record<string, unknown>;
}

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function wfsOptions(endpoint: string, typeName: string, capabilities: string): SourceCapabilityConnectOptions {
  return {
    endpoint,
    protocol: "wfs",
    typeName,
    authorizationScopeFingerprint: "anonymous",
    clientOptions: {
      fetchFn: vi.fn(
        async () =>
          new Response(capabilities, {
            status: 200,
            headers: { "Content-Type": "application/xml", ETag: '"wfs-capabilities-v1"' },
          }),
      ),
    },
  };
}

function pmtilesFixtureAsset(name = "sample-vector.pmtiles"): Uint8Array {
  const fixture = readFileSync(new URL(`./fixtures/pmtiles/${name}`, import.meta.url));
  const asset = new Uint8Array(64 * 1024);
  asset.set(new Uint8Array(fixture));
  return asset;
}

function pmtilesRangeFetch(asset = pmtilesFixtureAsset()) {
  const calls: Array<{ url: string; range: string | null; authorization: string | null; signal?: AbortSignal }> = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
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
    if (url.pathname === "/rest/services/parcels/FeatureServer/0") return json(GRPC_LAYER);
    throw new Error(`Unexpected gRPC fetch: ${url.pathname}`);
  }) as typeof fetch;
}

function geoservicesImageFetchHandler(metadata: unknown = PARCELS_IMAGE_METADATA): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/services/elevation/ImageServer") return json(metadata);
    throw new Error(`Unexpected GeoServices ImageServer fetch: ${url.pathname}`);
  }) as typeof fetch;
}

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

function ogcTilesFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/ogc/tiles") return json(OGC_TILES_LANDING, { ETag: '"tiles-root-v1"' });
    if (url.pathname === "/ogc/tiles/conformance") return json(OGC_TILES_CONFORMANCE, { ETag: '"tiles-conf-v1"' });
    if (url.pathname === "/ogc/tiles/collections") return json(OGC_TILES_COLLECTIONS, { ETag: '"tiles-cols-v1"' });
    throw new Error(`Unexpected OGC Tiles fetch: ${url.pathname}`);
  }) as typeof fetch;
}

function ogcMapsFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/ogc/maps") return json(OGC_MAPS_LANDING, { ETag: '"maps-root-v1"' });
    if (url.pathname === "/ogc/maps/conformance") return json(OGC_MAPS_CONFORMANCE, { ETag: '"maps-conf-v1"' });
    if (url.pathname === "/ogc/maps/collections") return json(OGC_MAPS_COLLECTIONS, { ETag: '"maps-cols-v1"' });
    throw new Error(`Unexpected OGC Maps fetch: ${url.pathname}`);
  }) as typeof fetch;
}

function ogcFeaturesFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/ogc/features") return json(OGC_FEATURES_LANDING);
    if (url.pathname === "/ogc/features/conformance") return json(OGC_FEATURES_CONFORMANCE);
    if (url.pathname === "/ogc/features/collections") return json(OGC_FEATURES_COLLECTIONS);
    throw new Error(`Unexpected OGC Features fetch: ${url.pathname}`);
  }) as typeof fetch;
}

function stacFetchHandler(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/stac/v1" || url.pathname === "/v1") return json(STAC_LANDING, { ETag: '"stac-root-v1"' });
    if (url.pathname === "/v1/collections" || url.pathname === "/stac/v1/collections") {
      return json(STAC_COLLECTIONS, { ETag: '"stac-collections-v1"' });
    }
    throw new Error(`Unexpected STAC fetch: ${url.pathname}`);
  }) as typeof fetch;
}

function resolveGeoparquetSource<T>(descriptor: SourceDescriptor): Source<T> {
  return {
    descriptor,
    capabilities: descriptor.capabilities,
    async query() {
      throw new Error("query is not expected in this fixture");
    },
    async queryAll() {
      throw new Error("queryAll is not expected in this fixture");
    },
    async queryObjectIds() {
      throw new Error("queryObjectIds is not expected in this fixture");
    },
    // biome-ignore lint/correctness/useYield: fixture stream method intentionally throws to prove unsupported behavior.
    async *stream() {
      throw new Error("stream is not expected in this fixture");
    },
    async queryAggregate() {
      throw new Error("queryAggregate is not expected in this fixture");
    },
    async queryExtent() {
      throw new Error("queryExtent is not expected in this fixture");
    },
    async applyEdits() {
      throw new Error("applyEdits is not expected in this fixture");
    },
    async queryRelated() {
      throw new Error("queryRelated is not expected in this fixture");
    },
    attachments: {
      query() {
        throw new Error("attachments.query is not expected in this fixture");
      },
      list() {
        throw new Error("attachments.list is not expected in this fixture");
      },
      add() {
        throw new Error("attachments.add is not expected in this fixture");
      },
      update() {
        throw new Error("attachments.update is not expected in this fixture");
      },
      delete() {
        throw new Error("attachments.delete is not expected in this fixture");
      },
    },
    protocol() {
      return undefined;
    },
    adapter() {
      return undefined;
    },
  } as Source<T>;
}

function fakeParcelsProfiler(profile: GeoParquetSourceProfile): {
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

function useDiscoveryClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(OBSERVED_AT));
}
