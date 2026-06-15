import type { HonuaFeature, HonuaLayerMetadata, HonuaServiceMetadata } from "@honua/sdk-js/honua";

import type {
  ServiceExplorerCapabilitySummary,
  ServiceExplorerCatalog,
  ServiceExplorerDiagnostic,
  ServiceExplorerLayerSummary,
  ServiceExplorerServiceSummary,
  ServiceExplorerSourceMetadata,
  ServiceExplorerSourceOption,
} from "./types.js";

export const FIXTURE_UPDATED_AT = Date.parse("2026-05-05T19:30:00.000Z");
export const FIXTURE_REVALIDATE_AFTER_MS = 5 * 60_000;

export const FIXTURE_SERVICE_ID = "honolulu-civic-services";
export const FIXTURE_LAYER_ID = 0;
export const FIXTURE_SOURCE_ID = `${FIXTURE_SERVICE_ID}:${FIXTURE_LAYER_ID}`;

// Standards / native sources added to round out the picker so every protocol
// identifier the SDK contract supports (src/contract/types.ts `Protocol`) has a
// lane in the explorer — not just the original FeatureServer/MapServer/WFS/WMTS/
// OGC Maps/OData six. Capability summaries mirror the protocol defaults in
// `PROTOCOL_DEFAULT_CAPABILITIES`; query/render-only utility lanes keep table
// controls disabled while metadata, cache, capability, and diagnostics panels
// stay live.
const STANDARDS_SOURCE_OPTIONS: readonly ServiceExplorerSourceOption[] = [
  sourceOption({
    id: "grpc-service-requests",
    name: "Honua gRPC feature stream",
    protocol: "Honua gRPC",
    mode: "queryable",
    serviceId: "grpc-service-requests",
    description:
      "Honua's canonical gRPC FeatureService transport — the protocol-neutral query, aggregate, and streaming surface every other adapter normalizes onto.",
    cachePolicy:
      "Cache the FeatureService descriptor, field schema, and capability manifest by service version; stream query/aggregate responses live.",
    capabilities: {
      query: "supported",
      render: "supported",
      table: "supported",
      metadata: "supported",
      extent: "supported",
      statistics: "supported",
      attachments: "unsupported",
      find: "degraded",
    },
  }),
  sourceOption({
    id: "imageserver-elevation",
    name: "ImageServer elevation",
    protocol: "ImageServer",
    mode: "render-only",
    serviceId: "imageserver-elevation",
    description:
      "GeoServices ImageServer raster lane — exportImage rendering and pixel identify. Feature tables are disabled; identify stays a degraded query affordance.",
    cachePolicy:
      "Cache service metadata, raster function info, mosaic-rule defaults, and tile matrix hints; refresh exportImage and identify requests.",
    capabilities: {
      query: "degraded",
      render: "supported",
      table: "unsupported",
      metadata: "supported",
      extent: "supported",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "degraded",
    },
  }),
  sourceOption({
    id: "geometry-utility",
    name: "Geometry Service utility",
    protocol: "Geometry Service",
    mode: "degraded",
    serviceId: "geometry-utility",
    description:
      "GeoServices Geometry Service — project/buffer/relate utility operations. It hosts no features, so only the typed protocol() escape hatch and metadata stay active.",
    cachePolicy:
      "Cache the geometry service descriptor and supported-operation manifest; treat every project/buffer/relate call as a fresh request.",
    capabilities: {
      query: "unsupported",
      render: "unsupported",
      table: "unsupported",
      metadata: "supported",
      extent: "unsupported",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "gp-routing",
    name: "GP Service routing job",
    protocol: "GP Service",
    mode: "degraded",
    serviceId: "gp-routing",
    description:
      "GeoServices Geoprocessing Service — submit/poll async jobs and read materialized results. No live feature table; the job lifecycle runs through the typed protocol() surface.",
    cachePolicy:
      "Cache the GP task descriptor and parameter schema; never cache job submissions, status polls, or result materialization.",
    capabilities: {
      query: "unsupported",
      render: "unsupported",
      table: "unsupported",
      metadata: "supported",
      extent: "unsupported",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "ogc-features-parcels",
    name: "OGC API Features parcels",
    protocol: "OGC Features",
    mode: "queryable",
    serviceId: "ogc-features-parcels",
    description:
      "OGC API Features items lane — CQL2 filtering normalized into the same linked map/table/chart/filter/detail context as FeatureServer.",
    cachePolicy:
      "Cache the landing page, conformance, collection descriptor, queryables, and CRS list; refresh items requests.",
    capabilities: {
      query: "supported",
      render: "supported",
      table: "supported",
      metadata: "supported",
      extent: "supported",
      statistics: "degraded",
      attachments: "unsupported",
      find: "degraded",
    },
  }),
  sourceOption({
    id: "ogc-tiles-basemap",
    name: "OGC API Tiles basemap",
    protocol: "OGC Tiles",
    mode: "render-only",
    serviceId: "ogc-tiles-basemap",
    description:
      "OGC API Tiles vector/raster tile lane. Render and tile-matrix metadata stay visible; feature table and query controls are disabled.",
    cachePolicy:
      "Cache the tileset list, tile matrix sets, and tile JSON; individual tile fetches follow normal HTTP cache decisions.",
    capabilities: {
      query: "unsupported",
      render: "supported",
      table: "unsupported",
      metadata: "supported",
      extent: "degraded",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "ogc-records-catalog",
    name: "OGC API Records catalog",
    protocol: "OGC Records",
    mode: "queryable",
    serviceId: "ogc-records-catalog",
    description:
      "OGC API Records catalog lane — searchable record metadata with footprints projected into the linked table and detail panels.",
    cachePolicy: "Cache the catalog landing page, conformance, and queryables; refresh record search requests.",
    capabilities: {
      query: "supported",
      render: "degraded",
      table: "supported",
      metadata: "supported",
      extent: "supported",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "supported",
    },
  }),
  sourceOption({
    id: "stac-imagery",
    name: "STAC imagery search",
    protocol: "STAC",
    mode: "queryable",
    serviceId: "stac-imagery",
    description:
      "STAC item-search lane — bbox/datetime/collection filters returning item footprints and asset metadata in the shared linked context.",
    cachePolicy: "Cache the catalog landing page, collection descriptors, and queryables; refresh /search responses.",
    capabilities: {
      query: "supported",
      render: "degraded",
      table: "supported",
      metadata: "supported",
      extent: "supported",
      statistics: "unsupported",
      attachments: "degraded",
      find: "supported",
    },
  }),
  sourceOption({
    id: "wms-hazard",
    name: "WMS hazard overlay",
    protocol: "WMS",
    mode: "render-only",
    serviceId: "wms-hazard",
    description:
      "OGC WMS GetMap render lane with GetFeatureInfo identify. Table/query controls are disabled; identify stays a degraded query affordance.",
    cachePolicy:
      "Cache GetCapabilities, layer/style metadata, and CRS list; refresh GetMap and GetFeatureInfo requests.",
    capabilities: {
      query: "degraded",
      render: "supported",
      table: "unsupported",
      metadata: "supported",
      extent: "supported",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "maplibre-vector-basemap",
    name: "MapLibre vector source",
    protocol: "MapLibre Vector",
    mode: "render-only",
    serviceId: "maplibre-vector-basemap",
    description:
      "MapLibre-native vector tile source composed alongside protocol sources by HonuaMap. Render-only; schema comes from the style, not a service descriptor.",
    cachePolicy: "Cache the style document and tile JSON; vector tile fetches follow normal HTTP cache decisions.",
    capabilities: {
      query: "unsupported",
      render: "supported",
      table: "unsupported",
      metadata: "degraded",
      extent: "degraded",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "maplibre-raster-imagery",
    name: "MapLibre raster source",
    protocol: "MapLibre Raster",
    mode: "render-only",
    serviceId: "maplibre-raster-imagery",
    description:
      "MapLibre-native raster tile source composed alongside protocol sources. Render-only basemap/imagery tiles with style-derived metadata.",
    cachePolicy: "Cache the style document and tile JSON; raster tile fetches follow normal HTTP cache decisions.",
    capabilities: {
      query: "unsupported",
      render: "supported",
      table: "unsupported",
      metadata: "degraded",
      extent: "degraded",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "maplibre-geojson-incidents",
    name: "MapLibre GeoJSON source",
    protocol: "MapLibre GeoJSON",
    mode: "render-only",
    serviceId: "maplibre-geojson-incidents",
    description:
      "MapLibre-native in-memory GeoJSON source. Renders client-side geometry; there is no server query surface, so table/query stay degraded affordances.",
    cachePolicy: "No server metadata to cache; the GeoJSON payload lives in memory and is supplied by the composition.",
    capabilities: {
      query: "degraded",
      render: "supported",
      table: "unsupported",
      metadata: "degraded",
      extent: "degraded",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
];

export const FIXTURE_SOURCE_OPTIONS: readonly ServiceExplorerSourceOption[] = [
  sourceOption({
    id: FIXTURE_SOURCE_ID,
    name: "FeatureServer service requests",
    protocol: "FeatureServer",
    mode: "queryable",
    serviceId: FIXTURE_SERVICE_ID,
    layerId: FIXTURE_LAYER_ID,
    description: "GeoServices FeatureServer feature query with full linked map/table/chart/filter/detail context.",
    cachePolicy: "Cache service, layer, schema, domains, and capability metadata by service/layer version.",
    capabilities: {
      query: "supported",
      render: "supported",
      table: "supported",
      metadata: "supported",
      extent: "supported",
      statistics: "degraded",
      attachments: "unsupported",
      find: "degraded",
    },
  }),
  sourceOption({
    id: "mapserver-orthoimagery:0",
    name: "MapServer orthoimagery",
    protocol: "MapServer",
    mode: "render-only",
    serviceId: "mapserver-orthoimagery",
    layerId: 0,
    description: "GeoServices MapServer render/export and legend lane. Table queries are intentionally disabled.",
    cachePolicy:
      "Cache service metadata, legend metadata, drawingInfo, and export defaults; refresh render/export requests.",
    capabilities: {
      query: "unsupported",
      render: "supported",
      table: "unsupported",
      metadata: "supported",
      extent: "supported",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "supported",
    },
  }),
  sourceOption({
    id: "wfs-service-requests",
    name: "WFS service requests",
    protocol: "WFS",
    mode: "queryable",
    serviceId: "wfs-service-requests",
    description: "OGC WFS 2.0 GetFeature lane normalized into the same linked context as FeatureServer.",
    cachePolicy: "Cache GetCapabilities, feature type schema, CRS metadata, and output format negotiation.",
    capabilities: {
      query: "supported",
      render: "degraded",
      table: "supported",
      metadata: "supported",
      extent: "supported",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "wmts-basemap",
    name: "WMTS basemap tiles",
    protocol: "WMTS",
    mode: "render-only",
    serviceId: "wmts-basemap",
    description: "OGC WMTS tile rendering lane. Feature table and ad hoc query controls are disabled.",
    cachePolicy:
      "Cache capabilities, tile matrix sets, layer styles, and tile metadata; individual tile fetches stay normal HTTP cache decisions.",
    capabilities: {
      query: "unsupported",
      render: "supported",
      table: "unsupported",
      metadata: "supported",
      extent: "degraded",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "ogc-maps-zoning",
    name: "OGC Maps zoning",
    protocol: "OGC Maps",
    mode: "render-only",
    serviceId: "ogc-maps-zoning",
    description: "OGC API Maps render lane with explicit degraded table/query affordances.",
    cachePolicy: "Cache landing page, conformance, collection, style, and map metadata by collection/style version.",
    capabilities: {
      query: "unsupported",
      render: "supported",
      table: "unsupported",
      metadata: "supported",
      extent: "supported",
      statistics: "unsupported",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  sourceOption({
    id: "odata-assets",
    name: "OData public assets",
    protocol: "OData",
    mode: "queryable",
    serviceId: "odata-assets",
    description: "OData v4 entity-set metadata and table exploration with the same linked filters and details.",
    cachePolicy: "Cache $metadata, entity-set schema, navigation metadata, and capability hints by service version.",
    capabilities: {
      query: "supported",
      render: "degraded",
      table: "supported",
      metadata: "supported",
      extent: "degraded",
      statistics: "degraded",
      attachments: "unsupported",
      find: "unsupported",
    },
  }),
  ...STANDARDS_SOURCE_OPTIONS,
];

export const FIXTURE_SERVICES: readonly ServiceExplorerServiceSummary[] = [
  serviceSummary(FIXTURE_SOURCE_OPTIONS[0], {
    layerCount: 2,
    description: "Fixture-backed FeatureServer used when cloud Honua credentials are not configured.",
    status: "available",
  }),
  serviceSummary(FIXTURE_SOURCE_OPTIONS[1], {
    layerCount: 1,
    description: "MapServer render/export lane with query controls intentionally disabled.",
    status: "available",
  }),
  serviceSummary(FIXTURE_SOURCE_OPTIONS[2], {
    layerCount: 1,
    description: "WFS GetFeature lane projected into the linked workspace.",
    status: "available",
  }),
  serviceSummary(FIXTURE_SOURCE_OPTIONS[3], {
    layerCount: 1,
    description: "WMTS tile lane that validates render-only degraded controls.",
    status: "available",
  }),
  serviceSummary(FIXTURE_SOURCE_OPTIONS[4], {
    layerCount: 1,
    description: "OGC API Maps render lane.",
    status: "available",
  }),
  serviceSummary(FIXTURE_SOURCE_OPTIONS[5], {
    layerCount: 1,
    description: "OData entity-set table lane.",
    status: "degraded",
  }),
  ...STANDARDS_SOURCE_OPTIONS.map((option) =>
    serviceSummary(option, {
      layerCount: 1,
      description: option.description,
      status: option.mode === "degraded" ? "degraded" : "available",
    }),
  ),
];

export const FIXTURE_LAYERS: readonly ServiceExplorerLayerSummary[] = [
  {
    id: FIXTURE_LAYER_ID,
    name: "Service Requests",
    serviceId: FIXTURE_SERVICE_ID,
    serviceType: "FeatureServer",
    geometryType: "esriGeometryPoint",
    sourceId: FIXTURE_SOURCE_ID,
  },
  {
    id: 1,
    name: "Public Assets",
    serviceId: FIXTURE_SERVICE_ID,
    serviceType: "FeatureServer",
    geometryType: "esriGeometryPoint",
    sourceId: `${FIXTURE_SERVICE_ID}:1`,
  },
  layerSummary(FIXTURE_SOURCE_OPTIONS[1], "Current Orthoimagery"),
  layerSummary(FIXTURE_SOURCE_OPTIONS[2], "Service Requests WFS"),
  layerSummary(FIXTURE_SOURCE_OPTIONS[3], "Basemap WMTS"),
  layerSummary(FIXTURE_SOURCE_OPTIONS[4], "Zoning OGC Maps"),
  layerSummary(FIXTURE_SOURCE_OPTIONS[5], "Public Assets EntitySet"),
  ...STANDARDS_SOURCE_OPTIONS.map((option) => layerSummary(option, option.name)),
];

export const FIXTURE_CATALOG: ServiceExplorerCatalog = {
  sources: FIXTURE_SOURCE_OPTIONS,
  services: FIXTURE_SERVICES,
  // One entry per distinct serviceId, derived from FIXTURE_LAYERS so new
  // standards/native lanes appear in the discovery panel without hand-maintained
  // duplication.
  layersByServiceId: Object.fromEntries(
    [...new Set(FIXTURE_LAYERS.map((layer) => layer.serviceId))].map((serviceId) => [
      serviceId,
      FIXTURE_LAYERS.filter((layer) => layer.serviceId === serviceId),
    ]),
  ),
};

export const FIXTURE_SERVICE_METADATA: HonuaServiceMetadata = {
  serviceDescription: "Demo civic request service projected through the Honua SDK service explorer sample.",
  layers: FIXTURE_LAYERS.map((layer) => ({ id: layer.id, name: layer.name })),
  spatialReference: { wkid: 4326 },
  fullExtent: {
    xmin: -157.91,
    ymin: 21.265,
    xmax: -157.755,
    ymax: 21.345,
    spatialReference: { wkid: 4326 },
  },
  maxRecordCount: 2000,
};

export const FIXTURE_LAYER_METADATA: HonuaLayerMetadata = {
  id: FIXTURE_LAYER_ID,
  name: "Service Requests",
  type: "Feature Layer",
  geometryType: "esriGeometryPoint",
  description: "Citizen-reported service requests around urban Honolulu.",
  extent: {
    xmin: -157.91,
    ymin: 21.265,
    xmax: -157.755,
    ymax: 21.345,
    spatialReference: { wkid: 4326 },
  },
  spatialReference: { wkid: 4326 },
  maxRecordCount: 2000,
  supportsAttachments: false,
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "Object ID", nullable: false, editable: false },
    { name: "title", type: "esriFieldTypeString", alias: "Title", length: 96, nullable: false, editable: true },
    { name: "status", type: "esriFieldTypeString", alias: "Status", length: 24, nullable: false, editable: true },
    { name: "category", type: "esriFieldTypeString", alias: "Category", length: 32, nullable: false, editable: true },
    { name: "priority", type: "esriFieldTypeString", alias: "Priority", length: 16, nullable: false, editable: true },
    { name: "district", type: "esriFieldTypeString", alias: "District", length: 32, nullable: false, editable: true },
    {
      name: "response_time_min",
      type: "esriFieldTypeInteger",
      alias: "Response Time (min)",
      nullable: true,
      editable: true,
    },
    {
      name: "assets_affected",
      type: "esriFieldTypeSmallInteger",
      alias: "Assets Affected",
      nullable: true,
      editable: true,
    },
    { name: "reported_at", type: "esriFieldTypeDate", alias: "Reported At", nullable: true, editable: false },
  ],
};

export const FIXTURE_CAPABILITIES: ServiceExplorerCapabilitySummary = {
  ...FIXTURE_SOURCE_OPTIONS[0].capabilities,
};

export const FIXTURE_SOURCE_METADATA: ServiceExplorerSourceMetadata = {
  ...createFixtureServiceExplorerSourceMetadata(FIXTURE_SOURCE_OPTIONS[0]),
};

function sourceOption(
  init: Omit<ServiceExplorerSourceOption, "sourceId"> & { readonly sourceId?: string },
): ServiceExplorerSourceOption {
  return {
    ...init,
    sourceId: init.sourceId ?? init.id,
  };
}

function serviceSummary(
  source: ServiceExplorerSourceOption,
  options: Pick<ServiceExplorerServiceSummary, "layerCount" | "description" | "status">,
): ServiceExplorerServiceSummary {
  return {
    id: source.serviceId,
    name: source.name,
    type: source.protocol,
    protocol: source.protocol,
    ...options,
  };
}

function layerSummary(source: ServiceExplorerSourceOption, name: string): ServiceExplorerLayerSummary {
  return {
    id: source.layerId ?? 0,
    name,
    serviceId: source.serviceId,
    serviceType: source.protocol,
    geometryType: source.mode === "render-only" ? undefined : "esriGeometryPoint",
    sourceId: source.sourceId,
  };
}

export function findFixtureServiceExplorerSourceOption(
  sourceOptionId: string | undefined,
): ServiceExplorerSourceOption {
  return (
    FIXTURE_SOURCE_OPTIONS.find((source) => source.id === sourceOptionId || source.sourceId === sourceOptionId) ??
    FIXTURE_SOURCE_OPTIONS[0]
  );
}

export function createFixtureServiceExplorerSourceMetadata(
  sourceOption: ServiceExplorerSourceOption,
): ServiceExplorerSourceMetadata {
  const defaultMetadata = sourceOption.protocol === "FeatureServer";
  const service =
    FIXTURE_SERVICES.find((entry) => entry.id === sourceOption.serviceId) ?? serviceSummary(sourceOption, {});
  const layer =
    Object.values(FIXTURE_CATALOG.layersByServiceId)
      .flat()
      .find((entry) => entry.sourceId === sourceOption.sourceId) ?? layerSummary(sourceOption, sourceOption.name);
  const schema: HonuaLayerMetadata = defaultMetadata
    ? FIXTURE_LAYER_METADATA
    : {
        ...FIXTURE_LAYER_METADATA,
        id: sourceOption.layerId ?? 0,
        name: sourceOption.name,
        type: sourceOption.mode === "render-only" ? "Map Layer" : "Feature Layer",
        description: sourceOption.description,
        geometryType: sourceOption.mode === "render-only" ? undefined : "esriGeometryPoint",
      };
  const diagnostics: readonly ServiceExplorerDiagnostic[] = [
    {
      level: "info",
      code: "fixture-mode",
      title: "Using fixture-backed data",
      detail: "The app contract targets cloud Honua, but local credentials were not provided.",
      sourceId: sourceOption.sourceId,
    },
    {
      level: sourceOption.mode === "render-only" ? "warning" : "info",
      code: `source-${sourceOption.protocol.toLowerCase().replaceAll(" ", "-")}`,
      title: `${sourceOption.protocol} source selected`,
      detail: sourceOption.description,
      sourceId: sourceOption.sourceId,
    },
    {
      level: "info",
      code: "metadata-cache-policy",
      title: "Metadata cache policy",
      detail: sourceOption.cachePolicy,
      sourceId: sourceOption.sourceId,
    },
    ...(sourceOption.capabilities.statistics !== "supported"
      ? [
          {
            level: "warning" as const,
            code: "statistics-degraded",
            title: "Statistics are not authoritative",
            detail:
              sourceOption.capabilities.statistics === "degraded"
                ? "Chart buckets are computed from projected records for this source."
                : "This source does not expose a statistics surface.",
            sourceId: sourceOption.sourceId,
          },
        ]
      : []),
    ...(sourceOption.capabilities.table === "unsupported"
      ? [
          {
            level: "warning" as const,
            code: "table-query-disabled",
            title: "Table/query controls disabled",
            detail:
              "Render-only standards sources keep metadata and map rendering visible without pretending to support feature queries.",
            sourceId: sourceOption.sourceId,
          },
        ]
      : []),
  ];

  return {
    service,
    layer,
    schema,
    serviceMetadata: {
      ...FIXTURE_SERVICE_METADATA,
      serviceDescription: sourceOption.description,
      layers: [{ id: sourceOption.layerId ?? 0, name: sourceOption.name }],
    },
    capabilities: sourceOption.capabilities,
    cache: {
      status: "ready",
      state: {
        scope: "metadata",
        status: "hit",
        keyFingerprint: `metadata:fixture:${sourceOption.sourceId}`,
        ageMs: 0,
        ttlMs: FIXTURE_REVALIDATE_AFTER_MS,
        sourceUpdatedAt: new Date(FIXTURE_UPDATED_AT).toISOString(),
      },
      source: "fixture",
      updatedAt: FIXTURE_UPDATED_AT,
      revalidateAfterMs: FIXTURE_REVALIDATE_AFTER_MS,
      lastRevalidatedAt: FIXTURE_UPDATED_AT,
    },
    diagnostics,
  };
}

function feature(x: number, y: number, attributes: Record<string, unknown>): HonuaFeature {
  return {
    attributes,
    geometry: { x, y, spatialReference: { wkid: 4326 } },
  };
}
export const FIXTURE_DIAGNOSTICS: readonly ServiceExplorerDiagnostic[] = [
  {
    level: "info",
    code: "fixture-mode",
    title: "Using fixture-backed data",
    detail: "The app contract targets cloud Honua, but local credentials were not provided.",
    sourceId: FIXTURE_SOURCE_ID,
  },
  {
    level: "warning",
    code: "statistics-client-side",
    title: "Statistics are client-side",
    detail: "Chart buckets are computed from the projected feature set until server-side statistics are enabled.",
    sourceId: FIXTURE_SOURCE_ID,
  },
  {
    level: "warning",
    code: "attachments-unsupported",
    title: "Attachments unsupported",
    detail:
      "The active fixture layer reports supportsAttachments=false; the detail panel surfaces that degraded state.",
    sourceId: FIXTURE_SOURCE_ID,
  },
];

export const FIXTURE_FEATURES: readonly HonuaFeature[] = [
  feature(-157.8583, 21.3069, {
    OBJECTID: 1001,
    title: "Signal timing review",
    status: "open",
    category: "traffic",
    priority: "high",
    district: "downtown",
    response_time_min: 22,
    assets_affected: 3,
    reported_at: "2026-05-05T18:10:00.000Z",
  }),
  feature(-157.8216, 21.2902, {
    OBJECTID: 1002,
    title: "Drain inlet inspection",
    status: "assigned",
    category: "stormwater",
    priority: "medium",
    district: "kaimuki",
    response_time_min: 48,
    assets_affected: 1,
    reported_at: "2026-05-05T17:46:00.000Z",
  }),
  feature(-157.8767, 21.3134, {
    OBJECTID: 1003,
    title: "Streetlight outage cluster",
    status: "open",
    category: "lighting",
    priority: "high",
    district: "kalihi",
    response_time_min: 35,
    assets_affected: 8,
    reported_at: "2026-05-05T16:58:00.000Z",
  }),
  feature(-157.8014, 21.2765, {
    OBJECTID: 1004,
    title: "Park restroom repair",
    status: "monitoring",
    category: "parks",
    priority: "low",
    district: "diamond-head",
    response_time_min: 96,
    assets_affected: 1,
    reported_at: "2026-05-04T23:18:00.000Z",
  }),
  feature(-157.8897, 21.3313, {
    OBJECTID: 1005,
    title: "Water main valve check",
    status: "assigned",
    category: "utilities",
    priority: "medium",
    district: "salt-lake",
    response_time_min: 57,
    assets_affected: 2,
    reported_at: "2026-05-05T15:41:00.000Z",
  }),
  feature(-157.8472, 21.2998, {
    OBJECTID: 1006,
    title: "Crosswalk repaint",
    status: "resolved",
    category: "traffic",
    priority: "low",
    district: "ala-moana",
    response_time_min: 144,
    assets_affected: 1,
    reported_at: "2026-05-03T20:08:00.000Z",
  }),
  feature(-157.8351, 21.3207, {
    OBJECTID: 1007,
    title: "Tree limb clearance",
    status: "open",
    category: "parks",
    priority: "medium",
    district: "manoa",
    response_time_min: 66,
    assets_affected: 4,
    reported_at: "2026-05-05T19:02:00.000Z",
  }),
  feature(-157.7698, 21.2851, {
    OBJECTID: 1008,
    title: "Beach access sign replacement",
    status: "assigned",
    category: "parks",
    priority: "low",
    district: "hawaii-kai",
    response_time_min: 132,
    assets_affected: 2,
    reported_at: "2026-05-04T18:25:00.000Z",
  }),
];
