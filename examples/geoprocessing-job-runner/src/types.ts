import type {
  HonuaAppWorkspace,
  HonuaAppWorkspaceJobModel,
  HonuaAppWorkspaceMetadataCacheModel,
} from "@honua/sdk-js/app-workspace";
import type { ExplorationContext } from "@honua/sdk-js/exploration";
import type {
  GeospatialGrpcProcessClient,
  HonuaCacheState,
  HonuaExtent,
  HonuaProcessExecuteRequest,
  JobSnapshot,
} from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

export type RunnerCapabilityState = "available" | "degraded" | "unsupported";

export interface RunnerAoi {
  readonly id: string;
  readonly title: string;
  readonly extent: HonuaExtent;
  readonly geometryLabel: string;
  readonly areaSqKm: number;
}

export interface RunnerFeature {
  readonly id: string;
  readonly title: string;
  readonly category: "facility" | "route" | "shelter" | "asset";
  readonly risk: "critical" | "high" | "moderate" | "low";
  readonly zone: string;
  readonly score: number;
  readonly peopleServed: number;
  readonly distanceMeters: number;
  readonly aoiIds: readonly string[];
  readonly geometry: {
    readonly x: number;
    readonly y: number;
    readonly spatialReference: { readonly wkid: number };
  };
}

export interface RunnerProcess {
  readonly id: string;
  readonly title: string;
  readonly protocol: "GeometryServer" | "GPServer" | "OGC Processes";
  readonly operation: string;
  readonly capabilityState: RunnerCapabilityState;
  readonly cache: HonuaCacheState;
  readonly requiresTicket?: string;
}

export interface RunnerPlan {
  readonly id: string;
  readonly title: string;
  readonly processIds: readonly string[];
  readonly description: string;
  readonly materializes: boolean;
  readonly estimatedDuration: string;
  readonly capabilityState: RunnerCapabilityState;
  readonly fixtureMode: "materialize-facilities" | "route-profile" | "unsupported-capability";
  readonly outputLayerTitle: string;
}

export interface RunnerSourceMetadata {
  readonly id: string;
  readonly title: string;
  readonly type: "input-layer" | "process-catalog" | "result-layer";
  readonly cache: HonuaCacheState;
  readonly capabilities: readonly string[];
  readonly capabilityState: RunnerCapabilityState;
}

export interface RunnerResultLayer {
  readonly id: string;
  readonly title: string;
  readonly sourceId: string;
  readonly href: string;
  readonly cache: HonuaCacheState;
  readonly lineage: readonly string[];
  readonly materialized: boolean;
}

export interface RunnerJobOutput {
  readonly planId: string;
  readonly aoiId: string;
  readonly resultLayer: RunnerResultLayer;
  readonly features: readonly RunnerFeature[];
  readonly metrics: {
    readonly featureCount: number;
    readonly criticalCount: number;
    readonly peopleServed: number;
    readonly averageScore: number;
  };
  readonly warnings: readonly string[];
}

export interface RunnerDataset {
  readonly workspaceId: string;
  readonly resultSourceId: string;
  readonly generatedAt: string;
  readonly aois: readonly RunnerAoi[];
  readonly features: readonly RunnerFeature[];
  readonly processes: readonly RunnerProcess[];
  readonly plans: readonly RunnerPlan[];
  readonly inputSources: readonly RunnerSourceMetadata[];
}

export interface RunnerProcessClientFactoryContext {
  readonly dataset: RunnerDataset;
  readonly plan: RunnerPlan;
  readonly aoi: RunnerAoi;
  readonly jobId: string;
  projection(): LinkedViewQueryProjection;
}

export interface GeoprocessingJobRunnerSessionOptions {
  readonly dataset?: RunnerDataset;
  readonly processClientFactory?: (context: RunnerProcessClientFactoryContext) => GeospatialGrpcProcessClient;
}

export interface RunnerUiModels {
  readonly jobs: HonuaAppWorkspaceJobModel<RunnerJobOutput>;
  readonly cache: HonuaAppWorkspaceMetadataCacheModel<RunnerSourceMetadata>;
}

export interface GeoprocessingJobRunnerSession {
  readonly dataset: RunnerDataset;
  readonly workspace: HonuaAppWorkspace<RunnerFeature, RunnerSourceMetadata, RunnerJobOutput>;
  readonly exploration: ExplorationContext;
  readonly activeAoi: RunnerAoi;
  readonly activePlan: RunnerPlan;
  readonly activeJobId: string | undefined;
  selectAoi(aoiId: string): void;
  selectPlan(planId: string): void;
  setCategoryFilter(category: RunnerFeature["category"] | "all"): void;
  selectFeature(featureId: string): void;
  currentProjection(): LinkedViewQueryProjection;
  buildProcessRequest(): HonuaProcessExecuteRequest;
  startJob(): Promise<string>;
  pollJob(jobId?: string): Promise<JobSnapshot<RunnerJobOutput>>;
  cancelJob(jobId?: string): Promise<JobSnapshot<RunnerJobOutput>>;
  visibleFeatures(): RunnerFeature[];
  chartBuckets(): ReadonlyArray<{
    readonly risk: RunnerFeature["risk"];
    readonly count: number;
    readonly score: number;
  }>;
  latestOutput(): RunnerJobOutput | undefined;
  exportWorkspace(): string;
  dispose(): void;
}
