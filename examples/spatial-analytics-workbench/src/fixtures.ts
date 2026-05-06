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
    description: "Large-scale spatial aggregation contract for CARTO-style tiles, joins, and grouped analytics.",
    operation: "aggregate",
    capabilityState: "missing",
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
    title: "Indexed aggregation readiness",
    summary: "CARTO-style aggregation job that intentionally reports the missing #66 platform contract.",
    processIds: ["honua.analytics.indexed-aggregation"],
    layerIds: ["parcels", "flood-hazard", "critical-assets"],
    defaultAoiId: "honolulu-urban-core",
    estimatedDuration: "2-4 minutes",
    estimatedCost: "requires #66 cost estimate",
    materializes: false,
    requiresCapabilities: ["indexed-spatial-aggregation", "grouped-vector-tiles", "server-side-statistics"],
    fixtureMode: "missing-platform-capability",
  },
];

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
      "The workbench can show fixture summaries, but production-scale grouped statistics and tile-backed aggregation wait on #66.",
    nextStep: "Implement #66 server/SDK contracts, then replace fixture aggregation with cloud job execution.",
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
