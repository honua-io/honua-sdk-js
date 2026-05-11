import type { HonuaAppWorkspace } from "@honua/sdk-js/app-workspace";
import type { HonuaAiMapKit, HonuaAgentAuditEvent } from "@honua/sdk-js/agent-tools";
import type { ExplorationContext, ExplorationViewController, FilterClause } from "@honua/sdk-js/exploration";
import type { HonuaCacheState, HonuaExtent, JobSnapshot } from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

export type BuilderCapabilityState = "available" | "degraded" | "unsupported";
export type BuilderViewKind = "map" | "table" | "chart" | "filter" | "detail";
export type BuilderPromptId = "parcels-flood" | "station-distance" | "spatial-join" | "bbox-filter" | "grouped-chart";

export interface BuilderFeature {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly parcelUse: string;
  readonly floodZone: string;
  readonly stationName: string;
  readonly builtYear: number;
  readonly distanceMeters: number;
  readonly assessedValue: number;
  readonly x: number;
  readonly y: number;
  readonly attributes: Readonly<Record<string, string | number>>;
}

export interface BuilderSourceMetadata {
  readonly id: string;
  readonly title: string;
  readonly fields: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<string>;
  readonly cache: HonuaCacheState;
  readonly capabilityState: BuilderCapabilityState;
}

export interface BuilderCapabilityNote {
  readonly id: string;
  readonly title: string;
  readonly state: BuilderCapabilityState;
  readonly detail: string;
}

export interface BuilderPromptFixture {
  readonly id: BuilderPromptId;
  readonly prompt: string;
  readonly intent: string;
  readonly requiresClarification?: BuilderClarification;
  readonly draft: BuilderDraftSpec;
}

export interface BuilderClarification {
  readonly id: string;
  readonly question: string;
  readonly choices: ReadonlyArray<BuilderClarificationChoice>;
}

export interface BuilderClarificationChoice {
  readonly id: string;
  readonly label: string;
  readonly resolves: Readonly<Record<string, string>>;
}

export interface BuilderDraftSpec {
  readonly id: string;
  readonly title: string;
  readonly sourceIds: ReadonlyArray<string>;
  readonly spatialPredicate: "within-distance" | "intersects" | "contains" | "within" | "bbox" | "spatial-join";
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly extent: HonuaExtent;
  readonly grouping: ReadonlyArray<string>;
  readonly aggregation?: LinkedViewQueryProjection["aggregation"];
  readonly views: ReadonlyArray<BuilderViewKind>;
  readonly warnings: ReadonlyArray<string>;
  readonly cacheNotes: ReadonlyArray<string>;
  readonly estimatedCost: string;
  readonly estimatedDuration: string;
}

export interface BuilderTurn {
  readonly id: string;
  readonly prompt: string;
  readonly assistantText: string;
  readonly clarification?: BuilderClarification;
  readonly draft?: BuilderDraftSpec;
}

export interface BuilderPlan {
  readonly id: string;
  readonly draftId: string;
  readonly steps: ReadonlyArray<BuilderPlanStep>;
  readonly warnings: ReadonlyArray<string>;
  readonly cacheNotes: ReadonlyArray<string>;
  readonly estimatedCost: string;
  readonly estimatedDuration: string;
}

export interface BuilderPlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: "ready" | "degraded" | "blocked";
}

export interface BuilderGeneratedApp {
  readonly id: string;
  readonly draftId: string;
  readonly title: string;
  readonly viewIds: Readonly<Record<BuilderViewKind, string>>;
  readonly query: LinkedViewQueryProjection;
  readonly featureIds: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export interface BuilderJobOutput {
  readonly planId: string;
  readonly generatedApp: BuilderGeneratedApp;
  readonly features: ReadonlyArray<BuilderFeature>;
  readonly warnings: ReadonlyArray<string>;
}

export interface BuilderDataset {
  readonly workspaceId: string;
  readonly resultSourceId: string;
  readonly generatedAt: string;
  readonly sources: ReadonlyArray<BuilderSourceMetadata>;
  readonly capabilityNotes: ReadonlyArray<BuilderCapabilityNote>;
  readonly prompts: ReadonlyArray<BuilderPromptFixture>;
  readonly features: ReadonlyArray<BuilderFeature>;
}

export interface BuilderViewControllers {
  readonly map: ExplorationViewController;
  readonly table: ExplorationViewController;
  readonly chart: ExplorationViewController;
  readonly filters: ExplorationViewController;
  readonly detail: ExplorationViewController;
}

export interface AiSpatialAppBuilderSession {
  readonly dataset: BuilderDataset;
  readonly workspace: HonuaAppWorkspace<BuilderFeature, BuilderSourceMetadata, BuilderJobOutput>;
  readonly exploration: ExplorationContext;
  readonly views: BuilderViewControllers;
  readonly aiMapKit: HonuaAiMapKit;
  readonly agentAudit: readonly HonuaAgentAuditEvent[];
  readonly lastTurn?: BuilderTurn;
  readonly activeDraft?: BuilderDraftSpec;
  readonly activePlan?: BuilderPlan;
  readonly activeJobId?: string;
  submitPrompt(prompt: string): BuilderTurn;
  answerClarification(choiceId: string): BuilderTurn;
  previewPlan(): BuilderPlan;
  applyPlan(): string;
  advanceJob(jobId?: string): JobSnapshot<BuilderJobOutput>;
  selectFeature(featureId: string): void;
  setFloodZoneFilter(zone: string | "all"): void;
  selectChartBucket(zone: string | "all"): void;
  runAiMapKitDemo(): Promise<unknown[]>;
  currentProjection(): LinkedViewQueryProjection;
  visibleFeatures(): BuilderFeature[];
  chartBuckets(): ReadonlyArray<{ readonly floodZone: string; readonly count: number; readonly value: number }>;
  generatedApp(): BuilderGeneratedApp | undefined;
  exportState(): string;
  dispose(): void;
}
