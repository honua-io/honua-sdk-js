import type { HonuaExtent } from "@honua/sdk-js/honua";

import { FLOOD_SOURCE_ID, PARCEL_SOURCE_ID, PERMIT_SOURCE_ID, ZONING_SOURCE_ID } from "./types.js";
import type {
  FloodClass,
  ParcelFeature,
  PermitFeature,
  WorkbenchMapPreset,
  WorkbenchSourceMetadata,
  ZoningClass,
} from "./types.js";

export const WORKBENCH_GENERATED_AT = "2026-06-10T17:30:00.000Z";

/** Maui / Kahului-Wailuku working extent over the seeded demo datasets. */
export const DEFAULT_WORKBENCH_EXTENT: HonuaExtent = {
  xmin: -156.52,
  ymin: 20.86,
  xmax: -156.44,
  ymax: 20.92,
  spatialReference: { wkid: 4326 },
};

export const WAILUKU_EXTENT: HonuaExtent = {
  xmin: -156.515,
  ymin: 20.88,
  xmax: -156.49,
  ymax: 20.9,
  spatialReference: { wkid: 4326 },
};

export const KAHULUI_SHORE_EXTENT: HonuaExtent = {
  xmin: -156.48,
  ymin: 20.89,
  xmax: -156.45,
  ymax: 20.91,
  spatialReference: { wkid: 4326 },
};

export const MAP_PRESETS: readonly WorkbenchMapPreset[] = [
  { id: "maui-nui", label: "Maui Nui", extent: DEFAULT_WORKBENCH_EXTENT },
  { id: "wailuku", label: "Wailuku Core", extent: WAILUKU_EXTENT },
  { id: "kahului-shore", label: "Kahului Shore", extent: KAHULUI_SHORE_EXTENT },
];

export const ZONING_CLASSES: readonly ZoningClass[] = [
  {
    code: "R-1",
    label: "R-1 Residential",
    description: "Single-family residential",
    maxHeightFeet: 30,
    color: "#7cb342",
  },
  {
    code: "R-3",
    label: "R-3 Multifamily",
    description: "Medium-density residential",
    maxHeightFeet: 45,
    color: "#43a047",
  },
  {
    code: "B-2",
    label: "B-2 Business",
    description: "Community business district",
    maxHeightFeet: 60,
    color: "#1e88e5",
  },
  {
    code: "M-1",
    label: "M-1 Light Industrial",
    description: "Light industrial / warehouse",
    maxHeightFeet: 50,
    color: "#8e24aa",
  },
  { code: "AG", label: "Agricultural", description: "Agricultural district", maxHeightFeet: 30, color: "#c0ca33" },
  { code: "OS", label: "Open Space", description: "Parks and open space", maxHeightFeet: 25, color: "#26a69a" },
];

export const FLOOD_CLASSES: readonly FloodClass[] = [
  { zone: "VE", label: "VE — Coastal high hazard", regulated: true, color: "#b71c1c" },
  { zone: "AE", label: "AE — 1% annual chance", regulated: true, color: "#ef6c00" },
  { zone: "AO", label: "AO — Sheet flow", regulated: true, color: "#f9a825" },
  { zone: "X-shaded", label: "X (shaded) — 0.2% chance", regulated: false, color: "#90caf9" },
  { zone: "X", label: "X — Minimal hazard", regulated: false, color: "#cfd8dc" },
];

export const PARCELS: readonly ParcelFeature[] = [
  {
    id: "TMK-3-8-001-014",
    sourceId: PARCEL_SOURCE_ID,
    tmk: "3-8-001-014",
    address: "120 Market St, Wailuku",
    ownerName: "Iao Holdings LLC",
    zoning: "B-2",
    floodZone: "X",
    acreage: 0.42,
    assessedValue: 1_240_000,
    district: "Wailuku",
    coordinate: [-156.5045, 20.8915],
  },
  {
    id: "TMK-3-8-001-027",
    sourceId: PARCEL_SOURCE_ID,
    tmk: "3-8-001-027",
    address: "55 Vineyard St, Wailuku",
    ownerName: "K. Nakamura",
    zoning: "R-3",
    floodZone: "X-shaded",
    acreage: 0.28,
    assessedValue: 845_000,
    district: "Wailuku",
    coordinate: [-156.5072, 20.8896],
  },
  {
    id: "TMK-3-8-004-002",
    sourceId: PARCEL_SOURCE_ID,
    tmk: "3-8-004-002",
    address: "10 High St, Wailuku",
    ownerName: "County of Maui",
    zoning: "OS",
    floodZone: "X",
    acreage: 1.9,
    assessedValue: 0,
    district: "Wailuku",
    coordinate: [-156.5021, 20.8881],
  },
  {
    id: "TMK-3-7-010-031",
    sourceId: PARCEL_SOURCE_ID,
    tmk: "3-7-010-031",
    address: "300 Hana Hwy, Kahului",
    ownerName: "Pacific Retail Partners",
    zoning: "B-2",
    floodZone: "AE",
    acreage: 1.1,
    assessedValue: 3_120_000,
    district: "Kahului",
    coordinate: [-156.4662, 20.8951],
  },
  {
    id: "TMK-3-7-010-044",
    sourceId: PARCEL_SOURCE_ID,
    tmk: "3-7-010-044",
    address: "420 Kaahumanu Ave, Kahului",
    ownerName: "Valley Isle Logistics",
    zoning: "M-1",
    floodZone: "AO",
    acreage: 2.4,
    assessedValue: 2_780_000,
    district: "Kahului",
    coordinate: [-156.4701, 20.8929],
  },
  {
    id: "TMK-3-7-002-009",
    sourceId: PARCEL_SOURCE_ID,
    tmk: "3-7-002-009",
    address: "8 Amala Pl, Kahului",
    ownerName: "Shoreline Trust",
    zoning: "R-1",
    floodZone: "VE",
    acreage: 0.35,
    assessedValue: 1_010_000,
    district: "Kahului",
    coordinate: [-156.4598, 20.9041],
  },
  {
    id: "TMK-3-5-006-118",
    sourceId: PARCEL_SOURCE_ID,
    tmk: "3-5-006-118",
    address: "1500 Lower Main St, Wailuku",
    ownerName: "Aloha Farms Co",
    zoning: "AG",
    floodZone: "X-shaded",
    acreage: 12.6,
    assessedValue: 920_000,
    district: "Wailuku",
    coordinate: [-156.4988, 20.8742],
  },
  {
    id: "TMK-3-7-011-067",
    sourceId: PARCEL_SOURCE_ID,
    tmk: "3-7-011-067",
    address: "75 Puunene Ave, Kahului",
    ownerName: "M. Texeira",
    zoning: "R-1",
    floodZone: "X",
    acreage: 0.19,
    assessedValue: 690_000,
    district: "Kahului",
    coordinate: [-156.473, 20.8862],
  },
];

export const PERMITS: readonly PermitFeature[] = [
  permit({
    OBJECTID: 5001,
    permit_no: "B2026-0418",
    parcel_tmk: "3-7-010-031",
    permit_type: "commercial",
    status: "under-review",
    description: "Tenant improvement for ground-floor retail and signage.",
    applicant: "Pacific Retail Partners",
    reviewer: "L. Akana",
    valuation: 480_000,
    flood_review_required: true,
    coordinate: [-156.4662, 20.8951],
  }),
  permit({
    OBJECTID: 5002,
    permit_no: "B2026-0455",
    parcel_tmk: "3-8-001-027",
    permit_type: "residential",
    status: "intake",
    description: "New three-unit residential structure with parking.",
    applicant: "K. Nakamura",
    reviewer: "Unassigned",
    valuation: 1_150_000,
    flood_review_required: false,
    coordinate: [-156.5072, 20.8896],
  }),
  permit({
    OBJECTID: 5003,
    permit_no: "G2026-0102",
    parcel_tmk: "3-7-010-044",
    permit_type: "grading",
    status: "approved",
    description: "Site grading and drainage improvements for warehouse expansion.",
    applicant: "Valley Isle Logistics",
    reviewer: "R. Pico",
    valuation: 220_000,
    flood_review_required: true,
    coordinate: [-156.4701, 20.8929],
  }),
  permit({
    OBJECTID: 5004,
    permit_no: "S2026-0033",
    parcel_tmk: "3-7-002-009",
    permit_type: "shoreline",
    status: "intake",
    description: "Shoreline setback variance request for accessory structure.",
    applicant: "Shoreline Trust",
    reviewer: "Unassigned",
    valuation: 95_000,
    flood_review_required: true,
    coordinate: [-156.4598, 20.9041],
  }),
];

export const INITIAL_SOURCE_METADATA: Record<string, WorkbenchSourceMetadata> = {
  [PARCEL_SOURCE_ID]: source("Maui parcels", "ogc-features", false, "community", [
    "Schema cache hit",
    "Zoning domain cache hit",
  ]),
  [ZONING_SOURCE_ID]: source("Zoning districts", "ogc-features", false, "community", [
    "Domain cache hit",
    "Renderer cache hit",
  ]),
  [FLOOD_SOURCE_ID]: source("Flood hazard (FEMA)", "wms", false, "community", [
    "Legend cache hit",
    "Overlay tiles warmed",
  ]),
  [PERMIT_SOURCE_ID]: source("Permits & inspections", "odata", true, "pro", [
    "Form metadata cache hit",
    "Edit capability supported",
    "Conflict version field surfaced",
  ]),
};

function source(
  title: string,
  protocol: string,
  writable: boolean,
  tier: WorkbenchSourceMetadata["tier"],
  diagnostics: string[],
): WorkbenchSourceMetadata {
  return {
    title,
    protocol,
    active: true,
    writable,
    cache: { status: "hit", updatedAt: Date.parse(WORKBENCH_GENERATED_AT), ttlMs: 900_000 },
    tier,
    diagnostics,
  };
}

function permit(input: {
  OBJECTID: number;
  permit_no: string;
  parcel_tmk: string;
  permit_type: PermitFeature["attributes"]["permit_type"];
  status: PermitFeature["attributes"]["status"];
  description: string;
  applicant: string;
  reviewer: string;
  valuation: number;
  flood_review_required: boolean;
  coordinate: readonly [number, number];
}): PermitFeature {
  return {
    id: input.OBJECTID,
    sourceId: PERMIT_SOURCE_ID,
    title: `${input.permit_no} — ${input.parcel_tmk}`,
    attributes: {
      OBJECTID: input.OBJECTID,
      permit_no: input.permit_no,
      parcel_tmk: input.parcel_tmk,
      permit_type: input.permit_type,
      status: input.status,
      description: input.description,
      applicant: input.applicant,
      reviewer: input.reviewer,
      valuation: input.valuation,
      flood_review_required: input.flood_review_required,
      version: 1,
      last_edited_date: WORKBENCH_GENERATED_AT,
    },
    geometry: {
      type: "point",
      x: input.coordinate[0],
      y: input.coordinate[1],
      spatialReference: { wkid: 4326 },
    },
  };
}
