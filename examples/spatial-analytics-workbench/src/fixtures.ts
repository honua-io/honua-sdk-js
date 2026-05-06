import {
  SPATIAL_AGGREGATION_METADATA_SCHEMA_VERSION,
  SPATIAL_AGGREGATION_SCHEMA_VERSION,
} from "@honua/sdk-js/contract";
import type { SpatialAggregationContractFixture } from "@honua/sdk-js/contract";
import { createHonuaCacheState } from "@honua/sdk-js/honua";

import type {
  AnalyticsAoi,
  AnalyticsCapabilityGap,
  AnalyticsDataset,
  AnalyticsFeature,
  AnalyticsLayer,
  AnalyticsPlan,
  AnalyticsProcess,
} from "./types.js";

export const ANALYTICS_RESULT_SOURCE_ID = "honua-cloud:analytics-results";
export const ANALYTICS_FIXED_GENERATED_AT = "2026-05-05T08:00:00.000Z";

const METADATA_TTL_MS = 15 * 60 * 1_000;

const readyMetadataCache = (keyFingerprint: string) =>
  createHonuaCacheState({
    scope: "metadata",
    status: "hit",
    keyFingerprint,
    ageMs: 42_000,
    ttlMs: METADATA_TTL_MS,
    revalidatedAt: ANALYTICS_FIXED_GENERATED_AT,
    validator: { etag: `"${keyFingerprint}"` },
  });

const staleMetadataCache = (keyFingerprint: string) =>
  createHonuaCacheState({
    scope: "metadata",
    status: "stale",
    keyFingerprint,
    ageMs: 1_900_000,
    ttlMs: METADATA_TTL_MS,
    staleIfErrorMs: 3_600_000,
    revalidatedAt: ANALYTICS_FIXED_GENERATED_AT,
    invalidationReason: "backend capability discovery is waiting on indexed analytics contract #66",
  });

export const ANALYTICS_AOIS: readonly AnalyticsAoi[] = [
  {
    id: "honolulu-urban-core",
    title: "Honolulu Urban Core",
    description: "Dense parcels, civic facilities, and flood exposure around the urban core.",
    areaSqKm: 14.7,
    geometryLabel: "AOI polygon - EPSG:4326",
    extent: {
      xmin: -157.872,
      ymin: 21.286,
      xmax: -157.812,
      ymax: 21.331,
      spatialReference: { wkid: 4326 },
    },
  },
  {
    id: "honolulu-harbor",
    title: "Honolulu Harbor",
    description: "Port operations, fuel handling, and evacuation-route constraints.",
    areaSqKm: 9.3,
    geometryLabel: "Harbor buffer - EPSG:4326",
    extent: {
      xmin: -157.902,
      ymin: 21.295,
      xmax: -157.842,
      ymax: 21.335,
      spatialReference: { wkid: 4326 },
    },
  },
  {
    id: "airport-corridor",
    title: "Airport Corridor",
    description: "Lifeline access between Daniel K. Inouye airport and response depots.",
    areaSqKm: 12.2,
    geometryLabel: "Corridor envelope - EPSG:4326",
    extent: {
      xmin: -157.935,
      ymin: 21.303,
      xmax: -157.874,
      ymax: 21.35,
      spatialReference: { wkid: 4326 },
    },
  },
];

export const ANALYTICS_LAYERS: readonly AnalyticsLayer[] = [
  {
    id: "parcels",
    title: "Parcels and land use",
    kind: "feature",
    featureCount: 128_420,
    rendererHint: "Class breaks by composite exposure score",
    capabilities: ["bbox", "intersects", "fields", "count"],
    cache: readyMetadataCache("layer:parcels:v7"),
  },
  {
    id: "flood-hazard",
    title: "Flood and storm surge zones",
    kind: "hazard",
    featureCount: 2_348,
    rendererHint: "Hazard polygons by zone",
    capabilities: ["bbox", "intersects", "overlay"],
    cache: readyMetadataCache("layer:flood-hazard:v3"),
  },
  {
    id: "critical-assets",
    title: "Critical facilities and lifelines",
    kind: "asset",
    featureCount: 9_812,
    rendererHint: "Facility symbols by lifeline sector",
    capabilities: ["bbox", "within-distance", "intersects", "count"],
    cache: readyMetadataCache("layer:critical-assets:v5"),
  },
  {
    id: "live-incidents",
    title: "Incident handoff layer",
    kind: "incident",
    featureCount: 127,
    rendererHint: "Live incident severity symbols",
    capabilities: ["bbox", "intersects", "snapshot", "delta-token"],
    cache: readyMetadataCache("layer:live-incidents:v2"),
  },
];

export const ANALYTICS_PROCESSES: readonly AnalyticsProcess[] = [
  {
    id: "honua.analytics.buffer",
    title: "Buffer AOI",
    description: "Builds a server-side buffer envelope for distance predicates and downstream overlay.",
    operation: "buffer",
    capabilityState: "available",
    cache: readyMetadataCache("process:buffer:v1"),
  },
  {
    id: "honua.analytics.intersect",
    title: "Intersect overlay",
    description: "Intersects AOI, hazard, parcel, asset, and incident layers and records lineage.",
    operation: "intersect",
    capabilityState: "available",
    cache: readyMetadataCache("process:intersect:v1"),
  },
  {
    id: "honua.analytics.summarize",
    title: "Summarize counts",
    description: "Summarizes affected features by risk, zone, and layer type.",
    operation: "summarize",
    capabilityState: "available",
    cache: readyMetadataCache("process:summarize:v1"),
  },
  {
    id: "honua.analytics.materialize",
    title: "Materialize result layer",
    description: "Persists selected job output as a reusable workspace artifact.",
    operation: "materialize",
    capabilityState: "available",
    cache: readyMetadataCache("process:materialize:v1"),
  },
  {
    id: "honua.analytics.indexed-aggregation",
    title: "Indexed aggregation",
    description: "Fixture-backed large-scale spatial aggregation contract for CARTO-style cells and widgets.",
    operation: "aggregate",
    capabilityState: "degraded",
    cache: staleMetadataCache("process:indexed-aggregation:v0"),
    requiresTicket: "#66",
  },
];

export const ANALYTICS_PLANS: readonly AnalyticsPlan[] = [
  {
    id: "buffer-overlay",
    title: "AOI buffer, overlay, and summarize",
    summary: "Fixture-backed Honua Cloud process chain for buffer, intersect, summarize/count, and materialize.",
    processIds: [
      "honua.analytics.buffer",
      "honua.analytics.intersect",
      "honua.analytics.summarize",
      "honua.analytics.materialize",
    ],
    layerIds: ["parcels", "flood-hazard", "critical-assets", "live-incidents"],
    defaultAoiId: "honolulu-urban-core",
    estimatedDuration: "42 seconds",
    estimatedCost: "$0.18 fixture estimate",
    materializes: true,
    requiresCapabilities: ["bbox", "intersects", "within-distance", "count", "overlay"],
    fixtureMode: "supported",
  },
  {
    id: "indexed-aggregation",
    title: "Indexed aggregation fixture",
    summary:
      "CARTO-style aggregation job that renders SDK-shaped cells, categories, histograms, and grouped summaries.",
    processIds: ["honua.analytics.indexed-aggregation"],
    layerIds: ["parcels", "flood-hazard", "critical-assets"],
    defaultAoiId: "honolulu-urban-core",
    estimatedDuration: "fixture response",
    estimatedCost: "$0.04 metadata-only fixture",
    materializes: false,
    requiresCapabilities: ["indexed-spatial-aggregation", "grouped-vector-tiles", "server-side-statistics"],
    fixtureMode: "fixture-indexed-aggregation",
  },
];

export const ANALYTICS_INDEXED_AGGREGATION_FIXTURE: SpatialAggregationContractFixture = {
  schemaVersion: 1,
  request: {
    schemaVersion: SPATIAL_AGGREGATION_SCHEMA_VERSION,
    requestId: "agg-honolulu-risk-viewport-001",
    sourceId: "honolulu-incidents",
    where: "status <> 'closed'",
    spatialFilter: {
      geometry: {
        ...(ANALYTICS_AOIS[0]?.extent ?? {
          xmin: -157.872,
          ymin: 21.286,
          xmax: -157.812,
          ymax: 21.331,
          spatialReference: { wkid: 4326 },
        }),
      },
      geometryType: "esriGeometryEnvelope",
      spatialRel: "esriSpatialRelIntersects",
    },
    viewport: {
      extent: ANALYTICS_AOIS[0]?.extent ?? {
        xmin: -157.872,
        ymin: 21.286,
        xmax: -157.812,
        ymax: 21.331,
        spatialReference: { wkid: 4326 },
      },
      zoom: 11,
      width: 1280,
      height: 720,
      devicePixelRatio: 2,
    },
    resolution: {
      zoom: 11,
      indexResolution: 8,
      targetCellCount: 700,
      maxCellCount: 1000,
      strategy: "fit-viewport",
    },
    index: {
      geometry: "boundary",
      allowApproximate: true,
    },
    summaries: [
      { id: "totalIncidents", kind: "count", field: "incident_id", title: "Incidents" },
      {
        id: "bySeverity",
        kind: "category",
        field: "severity",
        title: "Severity",
        limit: 5,
        includeOther: true,
        orderBy: "count-desc",
      },
      {
        id: "responseTimeHistogram",
        kind: "histogram",
        field: "response_minutes",
        title: "Response time",
        bins: 4,
        min: 0,
        max: 60,
        method: "equal-interval",
        unit: "minutes",
      },
      {
        id: "populationExposureRange",
        kind: "range",
        field: "exposed_population",
        title: "Population exposure",
        ranges: [
          { id: "low", label: "0-999", min: 0, max: 1000, includeMin: true },
          { id: "medium", label: "1,000-4,999", min: 1000, max: 5000, includeMin: true },
          { id: "high", label: "5,000+", min: 5000, includeMin: true },
        ],
      },
      { id: "populationSum", kind: "sum", field: "exposed_population", title: "Exposed population" },
      { id: "averageRisk", kind: "avg", field: "risk_score", title: "Average risk" },
      { id: "minResponseTime", kind: "min", field: "response_minutes", title: "Fastest response", unit: "minutes" },
      { id: "maxResponseTime", kind: "max", field: "response_minutes", title: "Slowest response", unit: "minutes" },
    ],
    groupBy: [
      { field: "severity", alias: "severity", label: "Severity", limit: 5 },
      { field: "land_use", alias: "landUse", label: "Land use" },
    ],
    include: { cells: true, totals: true, emptyCells: false, metadata: true },
    page: { limit: 2 },
    metadata: { scenario: "fixture-only indexed aggregation contract" },
  },
  response: {
    schemaVersion: SPATIAL_AGGREGATION_SCHEMA_VERSION,
    requestId: "agg-honolulu-risk-viewport-001",
    sourceId: "honolulu-incidents",
    generatedAt: "2026-05-06T12:00:00.000Z",
    index: {
      model: {
        id: "h3",
        title: "Backend H3 grid",
        family: "discrete-global-grid",
        cellIdEncoding: "string",
        minResolution: 0,
        maxResolution: 15,
        supportedGeometry: ["centroid", "extent", "boundary"],
        hierarchy: "parent-child",
        spatialReference: { wkid: 4326 },
      },
      resolution: 8,
      requestedResolution: {
        zoom: 11,
        indexResolution: 8,
        targetCellCount: 700,
        maxCellCount: 1000,
        strategy: "fit-viewport",
      },
      cellCount: 96,
      extent: ANALYTICS_AOIS[0]?.extent,
    },
    metadata: {
      schemaVersion: SPATIAL_AGGREGATION_METADATA_SCHEMA_VERSION,
      sourceId: "honolulu-incidents",
      indexModels: [
        {
          id: "h3",
          title: "Backend H3 grid",
          family: "discrete-global-grid",
          cellIdEncoding: "string",
          minResolution: 0,
          maxResolution: 15,
          supportedGeometry: ["centroid", "extent", "boundary"],
          hierarchy: "parent-child",
          spatialReference: { wkid: 4326 },
        },
        {
          id: "quadbin",
          title: "Backend Quadbin grid",
          family: "quadtree",
          cellIdEncoding: "bigint",
          minResolution: 0,
          maxResolution: 26,
          supportedGeometry: ["centroid", "extent", "boundary"],
          hierarchy: "parent-child",
          spatialReference: { wkid: 3857 },
        },
      ],
      summaries: [
        { id: "totalIncidents", kind: "count", title: "Incidents", field: "incident_id", valueType: "number" },
        {
          id: "bySeverity",
          kind: "category",
          title: "Severity",
          field: "severity",
          valueType: "string",
          domain: [
            { value: "critical", label: "Critical", color: "#b42318" },
            { value: "high", label: "High", color: "#dc6803" },
            { value: "moderate", label: "Moderate", color: "#ca8504" },
          ],
        },
        {
          id: "responseTimeHistogram",
          kind: "histogram",
          title: "Response time",
          field: "response_minutes",
          valueType: "number",
          unit: "minutes",
          histogram: { bins: 4, min: 0, max: 60, method: "equal-interval" },
        },
        {
          id: "populationExposureRange",
          kind: "range",
          title: "Population exposure",
          field: "exposed_population",
          valueType: "number",
          ranges: [
            { id: "low", label: "0-999", min: 0, max: 1000, includeMin: true },
            { id: "medium", label: "1,000-4,999", min: 1000, max: 5000, includeMin: true },
            { id: "high", label: "5,000+", min: 5000, includeMin: true },
          ],
        },
        { id: "populationSum", kind: "sum", title: "Exposed population", field: "exposed_population" },
        { id: "averageRisk", kind: "avg", title: "Average risk", field: "risk_score" },
      ],
      groupBy: [
        {
          field: "severity",
          alias: "severity",
          title: "Severity",
          valueType: "string",
          domain: [
            { value: "critical", label: "Critical", color: "#b42318" },
            { value: "high", label: "High", color: "#dc6803" },
            { value: "moderate", label: "Moderate", color: "#ca8504" },
          ],
        },
        { field: "land_use", alias: "landUse", title: "Land use", valueType: "string" },
      ],
      widgets: [
        { id: "incident-count", kind: "stat", title: "Incidents", summaryId: "totalIncidents" },
        { id: "severity-list", kind: "category-list", title: "Severity", summaryId: "bySeverity" },
        {
          id: "response-histogram",
          kind: "histogram",
          title: "Response time",
          summaryId: "responseTimeHistogram",
          unit: "minutes",
        },
        {
          id: "grouped-risk-table",
          kind: "grouped-table",
          title: "Severity by land use",
          summaryIds: ["totalIncidents", "averageRisk", "populationSum"],
          groupBy: ["severity", "landUse"],
        },
      ],
      progressive: {
        status: "partial",
        refinement: "append",
        nextCursor: "page-2",
        loadedCellCount: 2,
        totalCellCount: 96,
        loadedSummaryCount: 16,
        estimatedSummaryCount: 768,
      },
      cache: {
        metadataCacheable: true,
        resultCacheable: false,
        cacheKeyParts: ["sourceId", "where", "spatialFilter", "viewport", "resolution", "summaries", "groupBy"],
        ttlMs: 900000,
      },
    },
    cells: [
      {
        id: "8828308281fffff",
        resolution: 8,
        extent: { xmin: -157.865, ymin: 21.296, xmax: -157.849, ymax: 21.31, spatialReference: { wkid: 4326 } },
        centroid: [-157.857, 21.303],
        summaries: {
          totalIncidents: { kind: "count", value: 42, approximate: true },
          bySeverity: {
            kind: "category",
            approximate: true,
            buckets: [
              { value: "critical", label: "Critical", count: 8, color: "#b42318" },
              { value: "high", label: "High", count: 21, color: "#dc6803" },
              { value: "moderate", label: "Moderate", count: 13, color: "#ca8504" },
            ],
          },
          responseTimeHistogram: {
            kind: "histogram",
            approximate: true,
            buckets: [
              { min: 0, max: 15, count: 10, includeMin: true },
              { min: 15, max: 30, count: 18 },
              { min: 30, max: 45, count: 11 },
              { min: 45, max: 60, count: 3, includeMax: true },
            ],
          },
          populationSum: { kind: "sum", value: 15340, approximate: true },
          averageRisk: { kind: "avg", value: 82.6, approximate: true },
        },
        groups: [
          {
            key: { severity: "critical", landUse: "industrial" },
            label: "Critical / industrial",
            summaries: {
              totalIncidents: { kind: "count", value: 6 },
              averageRisk: { kind: "avg", value: 91.4 },
              populationSum: { kind: "sum", value: 6120 },
            },
          },
        ],
        partial: true,
      },
      {
        id: "8828308285fffff",
        resolution: 8,
        extent: { xmin: -157.849, ymin: 21.296, xmax: -157.833, ymax: 21.31, spatialReference: { wkid: 4326 } },
        centroid: [-157.841, 21.303],
        summaries: {
          totalIncidents: { kind: "count", value: 28, approximate: true },
          bySeverity: {
            kind: "category",
            approximate: true,
            buckets: [
              { value: "critical", label: "Critical", count: 3, color: "#b42318" },
              { value: "high", label: "High", count: 11, color: "#dc6803" },
              { value: "moderate", label: "Moderate", count: 14, color: "#ca8504" },
            ],
          },
          responseTimeHistogram: {
            kind: "histogram",
            approximate: true,
            buckets: [
              { min: 0, max: 15, count: 7, includeMin: true },
              { min: 15, max: 30, count: 13 },
              { min: 30, max: 45, count: 6 },
              { min: 45, max: 60, count: 2, includeMax: true },
            ],
          },
          populationSum: { kind: "sum", value: 8210, approximate: true },
          averageRisk: { kind: "avg", value: 74.1, approximate: true },
        },
        groups: [
          {
            key: { severity: "high", landUse: "mixed-use" },
            label: "High / mixed-use",
            summaries: {
              totalIncidents: { kind: "count", value: 9 },
              averageRisk: { kind: "avg", value: 80.2 },
              populationSum: { kind: "sum", value: 4100 },
            },
          },
        ],
        partial: true,
      },
    ],
    totals: {
      totalIncidents: { kind: "count", value: 231, approximate: true },
      populationSum: { kind: "sum", value: 68420, approximate: true },
      averageRisk: { kind: "avg", value: 77.4, approximate: true },
    },
    groups: [
      {
        key: { severity: "critical", landUse: "industrial" },
        label: "Critical / industrial",
        summaries: {
          totalIncidents: { kind: "count", value: 19 },
          averageRisk: { kind: "avg", value: 89.9 },
          populationSum: { kind: "sum", value: 12440 },
        },
      },
    ],
    page: { nextCursor: "page-2", loadedCellCount: 2, totalCellCount: 96 },
  },
};

export const ANALYTICS_FEATURES: readonly AnalyticsFeature[] = [
  {
    id: "asset-1001",
    sourceId: ANALYTICS_RESULT_SOURCE_ID,
    title: "Iwilei electrical substation",
    category: "Critical asset",
    risk: "critical",
    zone: "AE",
    score: 94,
    distanceMeters: 140,
    incidentCount: 3,
    x: -157.861,
    y: 21.317,
    aoiIds: ["honolulu-urban-core", "honolulu-harbor"],
    attributes: {
      owner: "HECO",
      exposure: 94,
      floodZone: "AE",
      action: "dispatch inspection team",
    },
  },
  {
    id: "parcel-1002",
    sourceId: ANALYTICS_RESULT_SOURCE_ID,
    title: "Kakaako mixed-use parcel cluster",
    category: "Parcel group",
    risk: "high",
    zone: "VE",
    score: 82,
    distanceMeters: 210,
    incidentCount: 2,
    x: -157.852,
    y: 21.301,
    aoiIds: ["honolulu-urban-core"],
    attributes: {
      parcels: 48,
      exposure: 82,
      floodZone: "VE",
      action: "prepare outreach list",
    },
  },
  {
    id: "route-1003",
    sourceId: ANALYTICS_RESULT_SOURCE_ID,
    title: "Nimitz lifeline segment",
    category: "Transportation",
    risk: "high",
    zone: "AE",
    score: 78,
    distanceMeters: 320,
    incidentCount: 1,
    x: -157.887,
    y: 21.318,
    aoiIds: ["honolulu-harbor", "airport-corridor"],
    attributes: {
      lanes: 6,
      exposure: 78,
      floodZone: "AE",
      action: "stage detour resources",
    },
  },
  {
    id: "facility-1004",
    sourceId: ANALYTICS_RESULT_SOURCE_ID,
    title: "Kalihi response warehouse",
    category: "Logistics",
    risk: "moderate",
    zone: "X",
    score: 61,
    distanceMeters: 540,
    incidentCount: 0,
    x: -157.878,
    y: 21.335,
    aoiIds: ["airport-corridor", "honolulu-harbor"],
    attributes: {
      capacity: 240,
      exposure: 61,
      floodZone: "X",
      action: "keep as fallback depot",
    },
  },
  {
    id: "parcel-1005",
    sourceId: ANALYTICS_RESULT_SOURCE_ID,
    title: "Ala Moana coastal frontage",
    category: "Parcel group",
    risk: "moderate",
    zone: "VE",
    score: 67,
    distanceMeters: 370,
    incidentCount: 1,
    x: -157.843,
    y: 21.291,
    aoiIds: ["honolulu-urban-core"],
    attributes: {
      parcels: 31,
      exposure: 67,
      floodZone: "VE",
      action: "confirm tenant notifications",
    },
  },
  {
    id: "facility-1006",
    sourceId: ANALYTICS_RESULT_SOURCE_ID,
    title: "Airport fuel isolation valve",
    category: "Critical asset",
    risk: "low",
    zone: "X",
    score: 39,
    distanceMeters: 760,
    incidentCount: 0,
    x: -157.919,
    y: 21.322,
    aoiIds: ["airport-corridor"],
    attributes: {
      owner: "HDOT",
      exposure: 39,
      floodZone: "X",
      action: "monitor only",
    },
  },
];

export const ANALYTICS_CAPABILITY_GAPS: readonly AnalyticsCapabilityGap[] = [
  {
    id: "indexed-aggregation",
    title: "Large-scale indexed aggregation contract",
    impact:
      "The workbench renders SDK-shaped aggregation cells and widgets, but live production execution still depends on Honua Cloud advertising this capability.",
    nextStep: "Wire the same request/response contract to the cloud endpoint when the server capability is available.",
    ticket: "#66",
  },
  {
    id: "cost-estimates",
    title: "Server-supplied job cost estimates",
    impact:
      "The sample exposes cost/time affordances, but the cost text is fixture metadata until the process plan API returns estimates.",
    nextStep: "Add cost, row-count, and duration estimates to process plan/apply responses.",
    ticket: "#66",
  },
];

export function createFixtureSpatialAnalyticsDataset(): AnalyticsDataset {
  return {
    workspaceId: "cloud-spatial-analytics-workbench",
    resultSourceId: ANALYTICS_RESULT_SOURCE_ID,
    generatedAt: ANALYTICS_FIXED_GENERATED_AT,
    aois: ANALYTICS_AOIS,
    layers: ANALYTICS_LAYERS,
    processes: ANALYTICS_PROCESSES,
    plans: ANALYTICS_PLANS,
    features: ANALYTICS_FEATURES,
    capabilityGaps: ANALYTICS_CAPABILITY_GAPS,
  };
}
