import type { HonuaFeature, HonuaLayerMetadata, HonuaServiceMetadata } from "@honua/sdk-js/honua";

import type {
  ServiceExplorerCapabilitySummary,
  ServiceExplorerCatalog,
  ServiceExplorerDiagnostic,
  ServiceExplorerLayerSummary,
  ServiceExplorerServiceSummary,
  ServiceExplorerSourceMetadata,
} from "./types.js";

export const FIXTURE_UPDATED_AT = Date.parse("2026-05-05T19:30:00.000Z");
export const FIXTURE_REVALIDATE_AFTER_MS = 5 * 60_000;

export const FIXTURE_SERVICE_ID = "honolulu-civic-services";
export const FIXTURE_LAYER_ID = 0;
export const FIXTURE_SOURCE_ID = `${FIXTURE_SERVICE_ID}:${FIXTURE_LAYER_ID}`;

export const FIXTURE_SERVICES: readonly ServiceExplorerServiceSummary[] = [
  {
    id: FIXTURE_SERVICE_ID,
    name: "Honolulu Civic Services",
    type: "FeatureServer",
    layerCount: 2,
    description: "Fixture-backed service used when cloud Honua credentials are not configured.",
    status: "available",
  },
  {
    id: "coastal-planning",
    name: "Coastal Planning",
    type: "FeatureServer",
    layerCount: 1,
    description: "Shows a discovered service with a currently unsupported polygon-first workflow.",
    status: "degraded",
  },
  {
    id: "imagery-basemap",
    name: "Imagery Basemap",
    type: "MapServer",
    layerCount: 1,
    description: "MapServer discovery is visible; feature querying is not part of this first slice.",
    status: "unsupported",
  },
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
];

export const FIXTURE_CATALOG: ServiceExplorerCatalog = {
  services: FIXTURE_SERVICES,
  layersByServiceId: {
    [FIXTURE_SERVICE_ID]: FIXTURE_LAYERS,
    "coastal-planning": [
      {
        id: 0,
        name: "Shoreline Review Areas",
        serviceId: "coastal-planning",
        serviceType: "FeatureServer",
        geometryType: "esriGeometryPolygon",
        sourceId: "coastal-planning:0",
      },
    ],
    "imagery-basemap": [
      {
        id: 0,
        name: "Current Orthoimagery",
        serviceId: "imagery-basemap",
        serviceType: "MapServer",
        sourceId: "imagery-basemap:0",
      },
    ],
  },
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
  query: "supported",
  metadata: "supported",
  extent: "supported",
  statistics: "degraded",
  attachments: "unsupported",
};

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

export const FIXTURE_SOURCE_METADATA: ServiceExplorerSourceMetadata = {
  service: FIXTURE_SERVICES[0],
  layer: FIXTURE_LAYERS[0],
  schema: FIXTURE_LAYER_METADATA,
  serviceMetadata: FIXTURE_SERVICE_METADATA,
  capabilities: FIXTURE_CAPABILITIES,
  cache: {
    status: "ready",
    source: "fixture",
    updatedAt: FIXTURE_UPDATED_AT,
    revalidateAfterMs: FIXTURE_REVALIDATE_AFTER_MS,
    lastRevalidatedAt: FIXTURE_UPDATED_AT,
  },
  diagnostics: FIXTURE_DIAGNOSTICS,
};

function feature(x: number, y: number, attributes: Record<string, unknown>): HonuaFeature {
  return {
    attributes,
    geometry: { x, y, spatialReference: { wkid: 4326 } },
  };
}
