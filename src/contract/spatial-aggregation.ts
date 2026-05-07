/**
 * Protocol-neutral request and response shapes for indexed spatial aggregation.
 *
 * This module is intentionally a contract surface only. It describes the
 * request envelope SDKs send to a backend that can aggregate into indexed
 * cells, and the response metadata apps need to build widgets and load
 * progressively. The index model id is opaque so callers can work with H3,
 * Quadbin, WebMercatorQuad, or a provider-specific grid without switching on
 * one implementation.
 *
 * @module
 */

import type { SpatialFilter } from "../core/spatial-filter.js";
import type { HonuaExtent } from "../core/types.js";
import type { DegradedReason, SourceId } from "./types.js";

export const SPATIAL_AGGREGATION_SCHEMA_VERSION = "honua.spatial-aggregation.v1" as const;
export const SPATIAL_AGGREGATION_METADATA_SCHEMA_VERSION = "honua.spatial-aggregation.metadata.v1" as const;
export const SPATIAL_AGGREGATION_CAPABILITY = "spatialAggregate" as const;
export const FEATURE_SERVER_H3_SPATIAL_AGGREGATION_INDEX_MODEL_ID = "h3" as const;

export type SpatialAggregationSummaryKind =
  | "category"
  | "histogram"
  | "range"
  | "count"
  | "sum"
  | "avg"
  | "min"
  | "max";

export type SpatialAggregationMetricKind = Extract<
  SpatialAggregationSummaryKind,
  "count" | "sum" | "avg" | "min" | "max"
>;

export type SpatialAggregationValueType = "number" | "string" | "boolean" | "date" | "unknown";
export type SpatialAggregationCellGeometry = "none" | "centroid" | "extent" | "boundary";
export type SpatialAggregationWidgetKind = "stat" | "category-list" | "histogram" | "range-list" | "grouped-table";
export type SpatialAggregationProgressStatus = "complete" | "partial" | "estimated" | "streaming";
export type SpatialAggregationProgressRefinement = "append" | "replace" | "refine";

export interface SpatialAggregationViewport {
  readonly extent: HonuaExtent;
  readonly zoom?: number;
  readonly width?: number;
  readonly height?: number;
  readonly devicePixelRatio?: number;
}

export interface SpatialAggregationResolutionInput {
  /** Map zoom that should drive backend resolution selection. */
  readonly zoom?: number;
  /** Backend-native index resolution. Its meaning is index-model specific. */
  readonly indexResolution?: number;
  /** Preferred number of cells for the returned page or viewport. */
  readonly targetCellCount?: number;
  /** Hard cap the backend should not exceed without paging/refinement. */
  readonly maxCellCount?: number;
  readonly strategy?: "backend-default" | "fit-viewport" | "fixed-index-resolution";
}

export interface SpatialAggregationIndexSelection {
  /** Opaque backend-advertised id, for example "h3" or "quadbin". */
  readonly modelId?: string;
  readonly geometry?: SpatialAggregationCellGeometry;
  readonly allowApproximate?: boolean;
}

export interface SpatialAggregationPageRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SpatialAggregationInclude {
  readonly cells?: boolean;
  readonly totals?: boolean;
  readonly emptyCells?: boolean;
  readonly metadata?: boolean;
}

export interface SpatialAggregationRequest {
  readonly schemaVersion?: typeof SPATIAL_AGGREGATION_SCHEMA_VERSION;
  readonly requestId?: string;
  readonly sourceId: SourceId;
  readonly where?: string;
  readonly spatialFilter?: SpatialFilter;
  readonly viewport?: SpatialAggregationViewport;
  readonly resolution?: SpatialAggregationResolutionInput;
  readonly index?: SpatialAggregationIndexSelection;
  readonly summaries: readonly SpatialAggregationSummarySpec[];
  readonly groupBy?: readonly SpatialAggregationGroupBySpec[];
  readonly include?: SpatialAggregationInclude;
  readonly page?: SpatialAggregationPageRequest;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SpatialAggregationSummaryBase {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly field?: string;
  readonly valueType?: SpatialAggregationValueType;
  readonly unit?: string;
}

export interface SpatialAggregationCountSummarySpec extends SpatialAggregationSummaryBase {
  readonly kind: "count";
  readonly countDistinct?: boolean;
}

export interface SpatialAggregationCategorySummarySpec extends SpatialAggregationSummaryBase {
  readonly kind: "category";
  readonly field: string;
  readonly limit?: number;
  readonly includeOther?: boolean;
  readonly orderBy?: "count-desc" | "count-asc" | "value-asc" | "value-desc";
}

export interface SpatialAggregationHistogramSummarySpec extends SpatialAggregationSummaryBase {
  readonly kind: "histogram";
  readonly field: string;
  readonly bins?: number;
  readonly min?: number;
  readonly max?: number;
  readonly method?: "equal-interval" | "quantile" | "custom";
}

export interface SpatialAggregationRangeSummarySpec extends SpatialAggregationSummaryBase {
  readonly kind: "range";
  readonly field: string;
  readonly ranges: readonly SpatialAggregationRangeBucketSpec[];
}

export interface SpatialAggregationMetricSummarySpec extends SpatialAggregationSummaryBase {
  readonly kind: Exclude<SpatialAggregationMetricKind, "count">;
  readonly field: string;
}

export type SpatialAggregationSummarySpec =
  | SpatialAggregationCountSummarySpec
  | SpatialAggregationCategorySummarySpec
  | SpatialAggregationHistogramSummarySpec
  | SpatialAggregationRangeSummarySpec
  | SpatialAggregationMetricSummarySpec;

export interface SpatialAggregationRangeBucketSpec {
  readonly id: string;
  readonly label?: string;
  readonly min?: number;
  readonly max?: number;
  readonly includeMin?: boolean;
  readonly includeMax?: boolean;
}

export interface SpatialAggregationGroupBySpec {
  readonly field: string;
  readonly alias?: string;
  readonly label?: string;
  readonly limit?: number;
  readonly nullLabel?: string;
}

export interface SpatialAggregationIndexModelMetadata {
  /** Opaque model id. Apps must not infer behavior from this string. */
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly family?: string;
  readonly cellIdEncoding?: "string" | "number" | "bigint" | "opaque";
  readonly minResolution?: number;
  readonly maxResolution?: number;
  readonly supportedGeometry?: readonly SpatialAggregationCellGeometry[];
  readonly hierarchy?: "parent-child" | "flat" | "unknown";
  readonly spatialReference?: HonuaExtent["spatialReference"];
}

export interface SpatialAggregationIndexState {
  readonly model: SpatialAggregationIndexModelMetadata;
  readonly resolution?: number;
  readonly requestedResolution?: SpatialAggregationResolutionInput;
  readonly cellCount?: number;
  readonly extent?: HonuaExtent;
}

export interface SpatialAggregationPageInfo {
  readonly nextCursor?: string;
  readonly loadedCellCount?: number;
  readonly totalCellCount?: number;
}

export interface SpatialAggregationProgressiveState {
  readonly status: SpatialAggregationProgressStatus;
  readonly refinement?: SpatialAggregationProgressRefinement;
  readonly nextCursor?: string;
  readonly loadedCellCount?: number;
  readonly totalCellCount?: number;
  readonly loadedSummaryCount?: number;
  readonly estimatedSummaryCount?: number;
}

export interface SpatialAggregationMetadata {
  readonly schemaVersion?: typeof SPATIAL_AGGREGATION_METADATA_SCHEMA_VERSION;
  readonly sourceId?: SourceId;
  readonly indexModels?: readonly SpatialAggregationIndexModelMetadata[];
  readonly summaries: readonly SpatialAggregationSummaryMetadata[];
  readonly groupBy?: readonly SpatialAggregationGroupByMetadata[];
  readonly widgets?: readonly SpatialAggregationWidgetMetadata[];
  readonly progressive?: SpatialAggregationProgressiveState;
  readonly cache?: SpatialAggregationCacheMetadata;
}

export interface SpatialAggregationCacheMetadata {
  readonly metadataCacheable: boolean;
  readonly resultCacheable: boolean;
  readonly cacheKeyParts?: readonly string[];
  readonly ttlMs?: number;
}

export interface SpatialAggregationSummaryMetadata {
  readonly id: string;
  readonly kind: SpatialAggregationSummaryKind;
  readonly title?: string;
  readonly field?: string;
  readonly valueType?: SpatialAggregationValueType;
  readonly unit?: string;
  readonly domain?: readonly SpatialAggregationDomainValue[];
  readonly ranges?: readonly SpatialAggregationRangeBucketSpec[];
  readonly histogram?: {
    readonly bins?: number;
    readonly min?: number;
    readonly max?: number;
    readonly method?: SpatialAggregationHistogramSummarySpec["method"];
  };
}

export interface SpatialAggregationGroupByMetadata {
  readonly field: string;
  readonly alias?: string;
  readonly title?: string;
  readonly valueType?: SpatialAggregationValueType;
  readonly domain?: readonly SpatialAggregationDomainValue[];
}

export interface SpatialAggregationDomainValue {
  readonly value: string | number | boolean | null;
  readonly label?: string;
  readonly color?: string;
}

export interface SpatialAggregationWidgetMetadata {
  readonly id: string;
  readonly kind: SpatialAggregationWidgetKind;
  readonly title?: string;
  readonly summaryId?: string;
  readonly summaryIds?: readonly string[];
  readonly field?: string;
  readonly groupBy?: readonly string[];
  readonly valueType?: SpatialAggregationValueType;
  readonly unit?: string;
  readonly interactions?: readonly ("filter" | "drilldown" | "highlight")[];
  readonly progressive?: {
    readonly stableAcrossPages: boolean;
    readonly partialValueSemantics: SpatialAggregationProgressRefinement;
  };
}

export interface SpatialAggregationResult {
  readonly schemaVersion: typeof SPATIAL_AGGREGATION_SCHEMA_VERSION;
  readonly requestId?: string;
  readonly sourceId: SourceId;
  readonly generatedAt?: string;
  readonly index: SpatialAggregationIndexState;
  readonly metadata: SpatialAggregationMetadata;
  readonly cells: readonly SpatialAggregationCell[];
  readonly totals?: SpatialAggregationSummaryBag;
  readonly groups?: readonly SpatialAggregationGroupedSummary[];
  readonly page?: SpatialAggregationPageInfo;
  readonly degraded?: readonly DegradedReason[];
}

export interface SpatialAggregationCell {
  readonly id: string;
  readonly parentId?: string;
  readonly resolution?: number;
  readonly extent?: HonuaExtent;
  readonly centroid?: readonly [number, number];
  readonly geometry?: Record<string, unknown> | null;
  readonly summaries: SpatialAggregationSummaryBag;
  readonly groups?: readonly SpatialAggregationGroupedSummary[];
  readonly partial?: boolean;
}

export type SpatialAggregationSummaryBag = Readonly<Record<string, SpatialAggregationSummaryValue>>;

export interface SpatialAggregationGroupedSummary {
  readonly key: Readonly<Record<string, string | number | boolean | null>>;
  readonly label?: string;
  readonly summaries: SpatialAggregationSummaryBag;
}

export type SpatialAggregationSummaryValue =
  | SpatialAggregationCountValue
  | SpatialAggregationMetricValue
  | SpatialAggregationCategoryValue
  | SpatialAggregationHistogramValue
  | SpatialAggregationRangeValue;

export interface SpatialAggregationCountValue {
  readonly kind: "count";
  readonly value: number;
  readonly approximate?: boolean;
}

export interface SpatialAggregationMetricValue {
  readonly kind: Exclude<SpatialAggregationMetricKind, "count">;
  readonly value: number | null;
  readonly unit?: string;
  readonly approximate?: boolean;
}

export interface SpatialAggregationCategoryValue {
  readonly kind: "category";
  readonly buckets: readonly SpatialAggregationCategoryBucket[];
  readonly otherCount?: number;
  readonly nullCount?: number;
  readonly approximate?: boolean;
}

export interface SpatialAggregationCategoryBucket {
  readonly value: string | number | boolean | null;
  readonly label?: string;
  readonly count: number;
  readonly color?: string;
}

export interface SpatialAggregationHistogramValue {
  readonly kind: "histogram";
  readonly buckets: readonly SpatialAggregationHistogramBucket[];
  readonly approximate?: boolean;
}

export interface SpatialAggregationHistogramBucket {
  readonly min: number;
  readonly max: number;
  readonly count: number;
  readonly includeMin?: boolean;
  readonly includeMax?: boolean;
}

export interface SpatialAggregationRangeValue {
  readonly kind: "range";
  readonly buckets: readonly SpatialAggregationRangeBucketValue[];
  readonly approximate?: boolean;
}

export interface SpatialAggregationRangeBucketValue extends SpatialAggregationRangeBucketSpec {
  readonly count: number;
}

export interface SpatialAggregationValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface SpatialAggregationContractFixture {
  readonly schemaVersion: 1;
  readonly request: SpatialAggregationRequest;
  readonly response: SpatialAggregationResult;
}

export function spatialAggregationSummaryKindRequiresField(kind: SpatialAggregationSummaryKind): boolean {
  return kind !== "count";
}

export function validateSpatialAggregationRequest(
  request: SpatialAggregationRequest,
): readonly SpatialAggregationValidationIssue[] {
  const issues: SpatialAggregationValidationIssue[] = [];

  if (!isNonEmptyString(request.sourceId)) {
    issues.push({ path: "sourceId", message: "sourceId is required" });
  }

  if (request.summaries.length === 0) {
    issues.push({ path: "summaries", message: "at least one summary is required" });
  }

  const summaryIds = new Set<string>();
  request.summaries.forEach((summary, index) => {
    const path = `summaries[${index}]`;
    if (!isNonEmptyString(summary.id)) {
      issues.push({ path: `${path}.id`, message: "summary id is required" });
    } else if (summaryIds.has(summary.id)) {
      issues.push({ path: `${path}.id`, message: `duplicate summary id "${summary.id}"` });
    } else {
      summaryIds.add(summary.id);
    }

    if (spatialAggregationSummaryKindRequiresField(summary.kind) && !isNonEmptyString(summary.field)) {
      issues.push({ path: `${path}.field`, message: `${summary.kind} summaries require a field` });
    }

    if (summary.kind === "histogram") {
      if (summary.bins !== undefined && !isPositiveInteger(summary.bins)) {
        issues.push({ path: `${path}.bins`, message: "histogram bins must be a positive integer" });
      }
      if (summary.min !== undefined && summary.max !== undefined && summary.min >= summary.max) {
        issues.push({ path: `${path}.max`, message: "histogram max must be greater than min" });
      }
    }

    if (summary.kind === "range") {
      if (summary.ranges.length === 0) {
        issues.push({ path: `${path}.ranges`, message: "range summaries require at least one range" });
      }
      summary.ranges.forEach((range, rangeIndex) => {
        if (!isNonEmptyString(range.id)) {
          issues.push({ path: `${path}.ranges[${rangeIndex}].id`, message: "range id is required" });
        }
        if (range.min !== undefined && range.max !== undefined && range.min >= range.max) {
          issues.push({ path: `${path}.ranges[${rangeIndex}].max`, message: "range max must be greater than min" });
        }
      });
    }
  });

  request.groupBy?.forEach((group, index) => {
    if (!isNonEmptyString(group.field)) {
      issues.push({ path: `groupBy[${index}].field`, message: "group field is required" });
    }
    if (group.limit !== undefined && !isPositiveInteger(group.limit)) {
      issues.push({ path: `groupBy[${index}].limit`, message: "group limit must be a positive integer" });
    }
  });

  const viewport = request.viewport;
  if (viewport) {
    if (viewport.zoom !== undefined && !isNonNegativeFinite(viewport.zoom)) {
      issues.push({ path: "viewport.zoom", message: "viewport zoom must be a non-negative number" });
    }
    if (viewport.width !== undefined && !isPositiveFinite(viewport.width)) {
      issues.push({ path: "viewport.width", message: "viewport width must be greater than zero" });
    }
    if (viewport.height !== undefined && !isPositiveFinite(viewport.height)) {
      issues.push({ path: "viewport.height", message: "viewport height must be greater than zero" });
    }
  }

  const resolution = request.resolution;
  if (resolution) {
    if (resolution.zoom !== undefined && !isNonNegativeFinite(resolution.zoom)) {
      issues.push({ path: "resolution.zoom", message: "resolution zoom must be a non-negative number" });
    }
    if (resolution.indexResolution !== undefined && !isNonNegativeFinite(resolution.indexResolution)) {
      issues.push({
        path: "resolution.indexResolution",
        message: "index resolution must be a non-negative number",
      });
    }
    if (resolution.targetCellCount !== undefined && !isPositiveInteger(resolution.targetCellCount)) {
      issues.push({ path: "resolution.targetCellCount", message: "target cell count must be a positive integer" });
    }
    if (resolution.maxCellCount !== undefined && !isPositiveInteger(resolution.maxCellCount)) {
      issues.push({ path: "resolution.maxCellCount", message: "max cell count must be a positive integer" });
    }
  }

  if (request.page?.limit !== undefined && !isPositiveInteger(request.page.limit)) {
    issues.push({ path: "page.limit", message: "page limit must be a positive integer" });
  }

  return issues;
}

export function assertValidSpatialAggregationRequest(request: SpatialAggregationRequest): void {
  const issues = validateSpatialAggregationRequest(request);
  if (issues.length > 0) {
    const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Invalid spatial aggregation request: ${details}`);
  }
}

export function spatialAggregationSummaryKindSupportedByFeatureServerH3(
  kind: SpatialAggregationSummaryKind,
): kind is SpatialAggregationMetricKind {
  return kind === "count" || kind === "sum" || kind === "avg" || kind === "min" || kind === "max";
}

export function validateFeatureServerH3SpatialAggregationRequest(
  request: SpatialAggregationRequest,
): readonly SpatialAggregationValidationIssue[] {
  const issues = [...validateSpatialAggregationRequest(request)];

  const indexResolution = request.resolution?.indexResolution;
  if (indexResolution === undefined) {
    issues.push({
      path: "resolution.indexResolution",
      message: "FeatureServer queryH3 requires an explicit indexResolution",
    });
  } else if (!Number.isInteger(indexResolution) || indexResolution < 0 || indexResolution > 15) {
    issues.push({
      path: "resolution.indexResolution",
      message: "FeatureServer queryH3 indexResolution must be an integer between 0 and 15",
    });
  }

  if (
    request.index?.modelId !== undefined &&
    request.index.modelId !== FEATURE_SERVER_H3_SPATIAL_AGGREGATION_INDEX_MODEL_ID
  ) {
    issues.push({
      path: "index.modelId",
      message: "FeatureServer queryH3 only supports the H3 index model",
    });
  }

  if (request.index?.geometry === "centroid") {
    issues.push({
      path: "index.geometry",
      message: "FeatureServer queryH3 does not currently return cell centroids",
    });
  }

  if (request.spatialFilter !== undefined) {
    issues.push({
      path: "spatialFilter",
      message: "FeatureServer queryH3 does not currently accept spatialFilter input",
    });
  }

  if (request.viewport !== undefined) {
    issues.push({
      path: "viewport",
      message: "FeatureServer queryH3 does not currently accept viewport input",
    });
  }

  if (request.groupBy !== undefined && request.groupBy.length > 0) {
    issues.push({
      path: "groupBy",
      message: "FeatureServer queryH3 does not currently support grouped summaries",
    });
  }

  if (request.page !== undefined) {
    issues.push({
      path: "page",
      message: "FeatureServer queryH3 does not currently support cursor paging",
    });
  }

  const metricSummaries = request.summaries.filter((summary) =>
    spatialAggregationSummaryKindSupportedByFeatureServerH3(summary.kind),
  );
  request.summaries.forEach((summary, index) => {
    const path = `summaries[${index}]`;
    if (!spatialAggregationSummaryKindSupportedByFeatureServerH3(summary.kind)) {
      issues.push({
        path: `${path}.kind`,
        message: `${summary.kind} summaries are not supported by FeatureServer queryH3`,
      });
      return;
    }

    if (summary.kind === "count" && summary.countDistinct === true) {
      issues.push({
        path: `${path}.countDistinct`,
        message: "FeatureServer queryH3 does not currently support countDistinct summaries",
      });
    }

    if (summary.kind === "count" && summary.field === undefined && metricSummaries.length > 1) {
      issues.push({
        path: `${path}.field`,
        message: "count summaries require a field when combined with other queryH3 metrics",
      });
    }
  });

  return issues;
}

export function assertFeatureServerH3SpatialAggregationRequest(request: SpatialAggregationRequest): void {
  const issues = validateFeatureServerH3SpatialAggregationRequest(request);
  if (issues.length > 0) {
    const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Invalid FeatureServer queryH3 spatial aggregation request: ${details}`);
  }
}

export function spatialAggregationWidgets(
  input: SpatialAggregationResult | SpatialAggregationMetadata,
): readonly SpatialAggregationWidgetMetadata[] {
  const metadata = "metadata" in input ? input.metadata : input;
  if (metadata.widgets && metadata.widgets.length > 0) return metadata.widgets;

  const widgets = metadata.summaries.map(summaryToWidget);
  if (metadata.groupBy && metadata.groupBy.length > 0) {
    widgets.push({
      id: "grouped-summaries",
      kind: "grouped-table",
      title: "Grouped summaries",
      summaryIds: metadata.summaries.map((summary) => summary.id),
      groupBy: metadata.groupBy.map((group) => group.alias ?? group.field),
      interactions: ["filter", "drilldown"],
      progressive: {
        stableAcrossPages: false,
        partialValueSemantics: "refine",
      },
    });
  }
  return widgets;
}

export function spatialAggregationProgress(
  input: SpatialAggregationResult | SpatialAggregationMetadata,
): SpatialAggregationProgressiveState {
  const metadata = "metadata" in input ? input.metadata : input;
  if (metadata.progressive) return metadata.progressive;
  if ("page" in input && input.page?.nextCursor) {
    return {
      status: "partial",
      refinement: "append",
      nextCursor: input.page.nextCursor,
      loadedCellCount: input.page.loadedCellCount ?? input.cells.length,
      totalCellCount: input.page.totalCellCount,
    };
  }
  return {
    status: "complete",
    loadedCellCount: "cells" in input ? input.cells.length : undefined,
  };
}

export function isSpatialAggregationComplete(input: SpatialAggregationResult | SpatialAggregationMetadata): boolean {
  const progress = spatialAggregationProgress(input);
  return progress.status === "complete" && !progress.nextCursor;
}

function summaryToWidget(summary: SpatialAggregationSummaryMetadata): SpatialAggregationWidgetMetadata {
  return {
    id: `${summary.id}-widget`,
    kind: widgetKindForSummary(summary.kind),
    title: summary.title,
    summaryId: summary.id,
    field: summary.field,
    valueType: summary.valueType,
    unit: summary.unit,
    interactions: summary.kind === "count" ? ["highlight"] : ["filter", "highlight"],
    progressive: {
      stableAcrossPages: summary.kind !== "histogram" && summary.kind !== "range",
      partialValueSemantics: "refine",
    },
  };
}

function widgetKindForSummary(kind: SpatialAggregationSummaryKind): SpatialAggregationWidgetKind {
  switch (kind) {
    case "category":
      return "category-list";
    case "histogram":
      return "histogram";
    case "range":
      return "range-list";
    default:
      return "stat";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
