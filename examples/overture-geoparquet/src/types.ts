import type { CloudNativeAnalysisPlanReceipt } from "./cloud-native-analysis.js";

export type OvertureLane = "fixture" | "live";

export type Bbox = readonly [number, number, number, number];

export interface OvertureObjectManifest {
  readonly id: string;
  readonly url: string;
  readonly objectKey: string;
  readonly bbox: Bbox;
  readonly bytes: number;
  readonly rows: number;
  readonly rowGroups: number;
  readonly etag: string;
  readonly lastModified: string;
}

export interface OvertureSourceManifest {
  readonly lane: OvertureLane;
  readonly release: string;
  readonly schemaVersion: string;
  readonly stacUrl: string | null;
  readonly totalFiles: number;
  readonly totalRows: number;
  readonly totalBytes: number;
  readonly totalRowGroups: number;
  readonly objects: readonly OvertureObjectManifest[];
  readonly attribution: string;
  readonly crs: "OGC:CRS84";
}

export interface OvertureExecutionPolicy {
  readonly maxRows: number;
  readonly maxProjectedColumns: number;
  readonly maxAoiSquareDegrees: number;
  readonly memoryLimitMiB: number;
  readonly maxResultBytes: number;
  readonly renderBatchSize: number;
  readonly maxEngineMs: number;
  readonly maxSourceProbeMs: number;
  readonly allowFullHttpReads: false;
}

export interface OvertureQueryInput {
  readonly lane: OvertureLane;
  readonly aoi: Bbox;
  readonly category: string;
  readonly limit: number;
}

export interface OvertureQueryPlan {
  readonly lane: OvertureLane;
  readonly aoi: Bbox;
  readonly aoiSquareDegrees: number;
  readonly category: string;
  readonly limit: number;
  readonly projection: readonly string[];
  readonly selectedObjects: readonly OvertureObjectManifest[];
  readonly filesSelected: number;
  readonly filesAvailable: number;
  readonly selectedObjectRows: number;
  readonly selectedObjectRowGroups: number;
  readonly filePruning: "fixture-manifest-bbox" | "pinned-stac-manifest-bbox";
  readonly rowGroupPruning: "bbox-predicate-planned-unverified";
  readonly rangeReadPlan: "local-buffer" | "aws-fail-closed-range-io";
  readonly cacheKey: string;
  /** Complete policy snapshot used to produce this plan. */
  readonly policy: OvertureExecutionPolicy;
  readonly memoryLimitMiB: number;
  readonly maxResultBytes: number;
  readonly maxEngineMs: number;
  readonly maxSourceProbeMs: number;
  readonly allowFullHttpReads: false;
  readonly warning: string;
}

export interface OvertureRangeEvidence {
  readonly lane: OvertureLane;
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly status: "local-buffer" | "verified" | "unsupported";
  readonly observedAt: string;
  readonly bytes: number;
  readonly ranges: number;
  readonly objectBytes: number;
  readonly acceptRanges: boolean;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly cacheStatus: string;
  readonly durationMs: number;
  readonly limitation: string;
}

export interface OvertureTimingEvidence {
  readonly sdkPlanMs: number;
  readonly sourceProbeMs: number;
  readonly engineExecutionMs: number;
  readonly renderMs: number;
  readonly totalMs: number;
}

export interface OvertureExecutionEvidence {
  readonly plan: OvertureQueryPlan;
  readonly queryPlan: CloudNativeAnalysisPlanReceipt | null;
  readonly range: OvertureRangeEvidence;
  readonly rowsReturned: number;
  readonly rowsScanned: number | null;
  readonly rowGroupsPruned: number | null;
  readonly estimatedResultBytes: number;
  readonly cacheStatus: "miss" | "hit";
  readonly timing: OvertureTimingEvidence;
  readonly status: "completed" | "cancelled" | "rejected" | "failed";
  readonly reason: string | null;
}

export interface OverturePlaceRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly confidence: number;
  readonly longitude: number;
  readonly latitude: number;
}
