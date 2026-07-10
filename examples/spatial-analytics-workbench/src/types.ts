import type { HonuaAppWorkspace } from "@honua/sdk-js/app-workspace";
import type {
  SpatialAggregationCell,
  SpatialAggregationRequest,
  SpatialAggregationResult,
  SpatialAggregationWidgetMetadata,
} from "@honua/sdk-js/contract";
import type { ExplorationContext, ExplorationViewController } from "@honua/sdk-js/exploration";
import type { HonuaCacheState, HonuaExtent, JobSnapshot } from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import type { QueryExecutionPlanV1, QueryPlanningErrorCode } from "@honua/sdk-js/query-planner";

export type AnalyticsPlanId = "linked-risk-summary" | "indexed-aggregation";
export type AnalyticsRisk = "critical" | "high" | "moderate" | "low";
export type AnalyticsLayerKind = "feature" | "hazard" | "asset" | "incident";
export type AnalyticsCapabilityState = "available" | "degraded" | "missing";
export type LinkedAnalysisLane = "remote-pushdown" | "bounded-local" | "unsafe-rejected";
export type LinkedAnalysisDataMode = "fixture" | "live";
export type LinkedAnalysisState =
  | "estimate"
  | "accepted"
  | "fixture-replay"
  | "executed-remote"
  | "executed-local"
  | "rejected"
  | "skipped";

export interface LinkedAnalysisLiveConfig {
  readonly protocol: "geoservices-feature-service" | "ogc-features";
  readonly baseUrl?: string;
  readonly serviceId?: string;
  readonly layerId?: number;
  readonly sourceVersion?: string;
  readonly schemaVersion?: string;
}

export interface LinkedAnalysisProvenance {
  readonly sourceId: string;
  readonly sourceUrl: string | null;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly observedAt: string | null;
  readonly observationState: "replayed" | "pending" | "skipped" | "live";
  readonly attribution: string;
  readonly cacheDecision: "bypass";
}

export interface LinkedAnalysisOutputArtifact {
  readonly schemaVersion: "honua.linked-analysis-output.v1";
  readonly id: string;
  readonly contextId: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly generatedAt: string;
  readonly aoiId: string;
  readonly aggregateRows: readonly Record<string, unknown>[];
  readonly provenance: LinkedAnalysisProvenance;
}

export interface LinkedAnalysisContext {
  readonly schemaVersion: "honua.linked-analysis-context.v1";
  readonly id: string;
  readonly lane: LinkedAnalysisLane;
  readonly dataMode: LinkedAnalysisDataMode;
  readonly state: LinkedAnalysisState;
  readonly aoiId: string;
  readonly projection: LinkedViewQueryProjection;
  readonly plan?: QueryExecutionPlanV1;
  readonly rejection?: { readonly code: QueryPlanningErrorCode | "live-config-unavailable"; readonly reason: string };
  readonly provenance: LinkedAnalysisProvenance;
  readonly estimatedRows: number;
  readonly estimatedBytes: number;
  readonly executionMs?: number;
  readonly aggregateRows?: readonly Record<string, unknown>[];
  readonly outputArtifact?: LinkedAnalysisOutputArtifact;
}

export interface LinkedAnalysisController {
  readonly dataMode: LinkedAnalysisDataMode;
  explain(lane: LinkedAnalysisLane, aoi: AnalyticsAoi, projection: LinkedViewQueryProjection): LinkedAnalysisContext;
  accept(context: LinkedAnalysisContext): LinkedAnalysisContext;
  execute(context: LinkedAnalysisContext, signal?: AbortSignal): Promise<LinkedAnalysisContext>;
}

export interface AnalyticsAoi {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly extent: HonuaExtent;
  readonly areaSqKm: number;
  readonly geometryLabel: string;
}

export interface AnalyticsLayer {
  readonly id: string;
  readonly title: string;
  readonly kind: AnalyticsLayerKind;
  readonly featureCount: number;
  readonly rendererHint: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly cache: HonuaCacheState;
}

export interface AnalyticsProcess {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly operation: "buffer" | "intersect" | "summarize" | "aggregate" | "materialize";
  readonly capabilityState: AnalyticsCapabilityState;
  readonly cache: HonuaCacheState;
  readonly requiresTicket?: string;
}

export interface AnalyticsPlan {
  readonly id: AnalyticsPlanId;
  readonly title: string;
  readonly summary: string;
  readonly processIds: ReadonlyArray<string>;
  readonly layerIds: ReadonlyArray<string>;
  readonly defaultAoiId: string;
  readonly estimatedDuration: string;
  readonly estimatedCost: string;
  readonly materializes: boolean;
  readonly requiresCapabilities: ReadonlyArray<string>;
  readonly fixtureMode: "supported" | "fixture-indexed-aggregation" | "missing-platform-capability";
}

export interface AnalyticsFeature {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly category: string;
  readonly risk: AnalyticsRisk;
  readonly zone: string;
  readonly score: number;
  readonly distanceMeters: number;
  readonly incidentCount: number;
  readonly x: number;
  readonly y: number;
  readonly aoiIds: ReadonlyArray<string>;
  readonly attributes: Readonly<Record<string, string | number>>;
}

export interface AnalyticsMetric {
  readonly label: string;
  readonly value: string;
  readonly tone?: "good" | "warn" | "danger" | "neutral";
}

export interface AnalyticsResultLayer {
  readonly id: string;
  readonly title: string;
  readonly sourceId: string;
  readonly featureIds: ReadonlyArray<string>;
  readonly materialized: boolean;
  readonly href: string;
  readonly cache: HonuaCacheState;
  readonly lineage: ReadonlyArray<string>;
}

export interface AnalyticsJobOutput {
  readonly planId: AnalyticsPlanId;
  readonly aoiId: string;
  readonly resultLayer: AnalyticsResultLayer;
  readonly metrics: ReadonlyArray<AnalyticsMetric>;
  readonly features: ReadonlyArray<AnalyticsFeature>;
  readonly aggregation?: SpatialAggregationResult;
  readonly warnings: ReadonlyArray<string>;
  readonly report: AnalyticsReport;
  readonly linkedAnalysis?: LinkedAnalysisContext;
}

export interface AnalyticsReport {
  readonly schemaVersion: "honua.spatial-analytics-workbench-report.v1";
  readonly generatedAt: string;
  readonly reportId: string;
  readonly planId: AnalyticsPlanId;
  readonly aoiId: string;
  readonly query: LinkedViewQueryProjection;
  readonly metrics: ReadonlyArray<AnalyticsMetric>;
  readonly resultLayer?: AnalyticsResultLayer;
  readonly aggregation?: AnalyticsAggregationReport;
  readonly warnings: ReadonlyArray<string>;
  readonly linkedAnalysis?: {
    readonly contextId: string;
    readonly state: LinkedAnalysisState;
    readonly lane: LinkedAnalysisLane;
    readonly planId?: string;
    readonly planFingerprint?: string;
    readonly provenance: LinkedAnalysisProvenance;
  };
}

export interface AnalyticsAggregationReport {
  readonly requestId?: string;
  readonly sourceId: string;
  readonly indexModel: string;
  readonly indexResolution?: number;
  readonly visibleCellCount: number;
  readonly loadedCellCount?: number;
  readonly totalCellCount?: number;
  readonly widgetIds: ReadonlyArray<string>;
  readonly metadataCacheable: boolean;
  readonly resultCacheable: boolean;
}

export interface AnalyticsCapabilityGap {
  readonly id: string;
  readonly title: string;
  readonly impact: string;
  readonly nextStep: string;
  readonly ticket: string;
}

export interface AnalyticsSourceMetadata {
  readonly id: string;
  readonly title: string;
  readonly type: "layer" | "process-catalog" | "materialized-result";
  readonly cache: HonuaCacheState;
  readonly capabilities: ReadonlyArray<string>;
}

export interface AnalyticsDataset {
  readonly workspaceId: string;
  readonly resultSourceId: string;
  readonly generatedAt: string;
  readonly aois: ReadonlyArray<AnalyticsAoi>;
  readonly layers: ReadonlyArray<AnalyticsLayer>;
  readonly processes: ReadonlyArray<AnalyticsProcess>;
  readonly plans: ReadonlyArray<AnalyticsPlan>;
  readonly features: ReadonlyArray<AnalyticsFeature>;
  readonly capabilityGaps: ReadonlyArray<AnalyticsCapabilityGap>;
}

export interface HonuaCloudAnalysisRequest {
  readonly processId: string;
  readonly mode: "async";
  readonly response: "document";
  readonly inputs: {
    readonly aoi: {
      readonly id: string;
      readonly bbox: [number, number, number, number];
      readonly spatialReference?: HonuaExtent["spatialReference"];
    };
    readonly layers: ReadonlyArray<string>;
    readonly operations: ReadonlyArray<string>;
    readonly filters: LinkedViewQueryProjection["filters"];
    readonly grouping: LinkedViewQueryProjection["grouping"];
    readonly aggregation: LinkedViewQueryProjection["aggregation"];
    readonly indexedAggregation?: SpatialAggregationRequest;
    readonly materialize: boolean;
  };
  readonly metadata: {
    readonly estimatedCost: string;
    readonly estimatedDuration: string;
    readonly cachePolicy: "metadata-only" | "materialized-result";
  };
}

export interface AnalyticsViewControllers {
  readonly map: ExplorationViewController;
  readonly table: ExplorationViewController;
  readonly chart: ExplorationViewController;
  readonly filters: ExplorationViewController;
  readonly detail: ExplorationViewController;
}

export interface SpatialAnalyticsWorkbenchSession {
  readonly dataset: AnalyticsDataset;
  readonly workspace: HonuaAppWorkspace<AnalyticsFeature, AnalyticsSourceMetadata, AnalyticsJobOutput>;
  readonly exploration: ExplorationContext;
  readonly views: AnalyticsViewControllers;
  readonly activeAoi: AnalyticsAoi;
  readonly activePlan: AnalyticsPlan;
  readonly activeJobId?: string;
  readonly linkedAnalysisContext?: LinkedAnalysisContext;
  selectAoi(aoiId: string): void;
  selectPlan(planId: AnalyticsPlanId): void;
  setRiskFilter(risk: AnalyticsRisk | "all"): void;
  selectFeature(featureId: string): void;
  selectChartBucket(risk: AnalyticsRisk | "all"): void;
  currentProjection(): LinkedViewQueryProjection;
  buildRequest(): HonuaCloudAnalysisRequest;
  startAnalysis(): string;
  advanceJob(jobId?: string): JobSnapshot<AnalyticsJobOutput>;
  retryJob(jobId?: string): string;
  visibleFeatures(): AnalyticsFeature[];
  chartBuckets(): ReadonlyArray<{ readonly risk: AnalyticsRisk; readonly count: number; readonly score: number }>;
  aggregationCells(): readonly SpatialAggregationCell[];
  aggregationWidgets(): readonly SpatialAggregationWidgetMetadata[];
  latestAggregation(): SpatialAggregationResult | undefined;
  latestOutput(): AnalyticsJobOutput | undefined;
  clearOutput(): void;
  createReport(): AnalyticsReport;
  setLinkedAnalysisContext(context: LinkedAnalysisContext | undefined): void;
  exportWorkspace(): string;
  dispose(): void;
}
