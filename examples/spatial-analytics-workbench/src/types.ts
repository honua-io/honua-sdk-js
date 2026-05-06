import type { HonuaAppWorkspace } from "@honua/sdk-js/app-workspace";
import type { ExplorationContext, ExplorationViewController } from "@honua/sdk-js/exploration";
import type { HonuaCacheState, HonuaExtent, JobSnapshot } from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

export type AnalyticsPlanId = "buffer-overlay" | "indexed-aggregation";
export type AnalyticsRisk = "critical" | "high" | "moderate" | "low";
export type AnalyticsLayerKind = "feature" | "hazard" | "asset" | "incident";
export type AnalyticsCapabilityState = "available" | "degraded" | "missing";

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
  readonly fixtureMode: "supported" | "missing-platform-capability";
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
  readonly warnings: ReadonlyArray<string>;
  readonly report: AnalyticsReport;
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
  readonly warnings: ReadonlyArray<string>;
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
  latestOutput(): AnalyticsJobOutput | undefined;
  createReport(): AnalyticsReport;
  exportWorkspace(): string;
  dispose(): void;
}
