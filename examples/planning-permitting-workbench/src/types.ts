import type { FeatureSelectionTarget, FilterClause } from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";

export const PARCEL_SOURCE_ID = "honua-cloud:maui-parcels";
export const ZONING_SOURCE_ID = "honua-cloud:maui-zoning";
export const FLOOD_SOURCE_ID = "honua-cloud:maui-flood-hazard";
export const PERMIT_SOURCE_ID = "honua-cloud:maui-permits";
export const WORKBENCH_LAYER_ID = "planning-permitting-features";

export type WorkbenchSourceId =
  | typeof PARCEL_SOURCE_ID
  | typeof ZONING_SOURCE_ID
  | typeof FLOOD_SOURCE_ID
  | typeof PERMIT_SOURCE_ID;

export type WorkbenchLayerId = "parcels" | "zoning" | "flood" | "permits";

export type ZoningCode = "R-1" | "R-3" | "B-2" | "M-1" | "AG" | "OS";

export type FloodZone = "VE" | "AE" | "AO" | "X-shaded" | "X";

export type PermitStatus = "intake" | "under-review" | "approved" | "issued" | "denied";

export type PermitType = "residential" | "commercial" | "grading" | "shoreline" | "demolition";

/** A parcel layer feature (read-only reference data). */
export interface ParcelFeature {
  readonly id: string;
  readonly sourceId: typeof PARCEL_SOURCE_ID;
  readonly tmk: string;
  readonly address: string;
  readonly ownerName: string;
  readonly zoning: ZoningCode;
  readonly floodZone: FloodZone;
  readonly acreage: number;
  readonly assessedValue: number;
  readonly district: string;
  readonly coordinate: readonly [number, number];
}

/** A zoning-domain descriptor used for the legend and detail panel. */
export interface ZoningClass {
  readonly code: ZoningCode;
  readonly label: string;
  readonly description: string;
  readonly maxHeightFeet: number;
  readonly color: string;
}

/** A flood-hazard-domain descriptor used for the legend and overlay check. */
export interface FloodClass {
  readonly zone: FloodZone;
  readonly label: string;
  readonly regulated: boolean;
  readonly color: string;
}

export interface PermitAttributes extends Record<string, unknown> {
  OBJECTID: number;
  permit_no: string;
  parcel_tmk: string;
  permit_type: PermitType;
  status: PermitStatus;
  description: string;
  applicant: string;
  reviewer: string;
  valuation: number;
  flood_review_required: boolean;
  version: number;
  last_edited_date: string;
}

export interface PermitFeature {
  readonly id: number;
  readonly sourceId: typeof PERMIT_SOURCE_ID;
  readonly title: string;
  readonly attributes: PermitAttributes;
  readonly geometry: {
    readonly type: "point";
    readonly x: number;
    readonly y: number;
    readonly spatialReference: { readonly wkid: number };
  };
}

export type WorkbenchModuleId = "review-board" | "query-analysis" | "permit-editing";

export interface WorkbenchSourceMetadata {
  readonly title: string;
  readonly protocol: string;
  readonly active: boolean;
  readonly writable: boolean;
  readonly cache: {
    readonly status: "hit" | "stale" | "refreshing";
    readonly updatedAt: number;
    readonly ttlMs: number;
  };
  readonly tier: "community" | "pro";
  readonly diagnostics: ReadonlyArray<string>;
}

export interface WorkbenchMapPreset {
  readonly id: string;
  readonly label: string;
  readonly extent: HonuaExtent;
}

/** A drawn area-of-interest footprint (the sketch lane). */
export interface SketchFootprint {
  readonly ring: ReadonlyArray<readonly [number, number]>;
  readonly areaAcres: number;
}

export interface MeasureResult {
  readonly distanceMeters: number;
  readonly segments: number;
}

export interface WorkbenchQueryResult {
  readonly parcels: ReadonlyArray<ParcelFeature>;
  readonly buckets: ReadonlyArray<WorkbenchZoningBucket>;
  readonly floodExposed: number;
  readonly totalAssessedValue: number;
}

export interface WorkbenchZoningBucket {
  readonly code: ZoningCode;
  readonly label: string;
  readonly count: number;
  readonly color: string;
  readonly targets: ReadonlyArray<FeatureSelectionTarget>;
  readonly filter: FilterClause;
}

export interface PermitReadinessEntry {
  readonly capability: "applyEdits" | "attachments" | "conflicts";
  readonly state: string;
  readonly note: string;
}

export interface WorkbenchPrintManifest {
  readonly id: string;
  readonly title: string;
  readonly generatedAt: string;
  readonly extent: HonuaExtent | undefined;
  readonly visibleLayers: ReadonlyArray<WorkbenchLayerId>;
  readonly parcelCount: number;
  readonly permitCount: number;
  readonly sketch: SketchFootprint | undefined;
  readonly measure: MeasureResult | undefined;
}
