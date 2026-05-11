import type {
  HonuaAppWorkspace,
  HonuaAppWorkspaceChartModel,
  HonuaAppWorkspaceDetailModel,
  HonuaAppWorkspaceFilterModel,
  HonuaAppWorkspaceMapModel,
  HonuaAppWorkspaceMetadataCacheModel,
  HonuaAppWorkspaceTableModel,
} from "@honua/sdk-js/app-workspace";
import type {
  AttachmentInfo,
  EditAttachmentMutation,
  EditSketchTool,
  EditSketchWorkflowSnapshot,
  EditWorkflowCapabilitySummary,
  EditWorkflowField,
  EditWorkflowSubmitResult,
  FeatureId,
  Source,
  SourceId,
} from "@honua/sdk-js/contract";
import type {
  ExplorationContext,
  ExplorationViewController,
  LinkedViewQueryProjection,
} from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";

export type InspectionStatus = "open" | "in-progress" | "closed";
export type InspectionPriority = "critical" | "high" | "medium" | "low";
export type EditWorkflowMode = "create" | "update";
export type MapAreaId = "honolulu-harbor" | "airport-corridor" | "kakaako-grid";

export interface InspectionAttributes extends Record<string, unknown> {
  OBJECTID: number;
  asset_id: string;
  asset_name: string;
  status: InspectionStatus;
  priority: InspectionPriority;
  inspection_score: number;
  assigned_to: string;
  notes: string;
  version: number;
  last_edited_date: string;
}

export interface InspectionFeature {
  readonly id: FeatureId;
  readonly sourceId: SourceId;
  readonly title: string;
  readonly attributes: InspectionAttributes;
  readonly geometry: {
    readonly type: "point";
    readonly x: number;
    readonly y: number;
    readonly spatialReference: { readonly wkid: number };
  };
  readonly mapPosition: {
    readonly x: number;
    readonly y: number;
  };
  readonly areaId: MapAreaId;
}

export interface EditWorkflowMapArea {
  readonly id: MapAreaId;
  readonly title: string;
  readonly extent: HonuaExtent;
  readonly cacheKey: string;
}

export interface EditWorkflowDataset {
  readonly id: string;
  readonly title: string;
  readonly sourceId: SourceId;
  readonly readonlySourceId: SourceId;
  readonly generatedAt: string;
  readonly mapAreas: readonly EditWorkflowMapArea[];
  readonly features: readonly InspectionFeature[];
  readonly attachments: Readonly<Record<string, readonly AttachmentInfo[]>>;
  readonly fields: readonly EditWorkflowField[];
}

export interface EditWorkflowSourceMetadata {
  readonly title: string;
  readonly sourceId: SourceId;
  readonly protocol: string;
  readonly cachePolicy: "metadata-only";
  readonly metadataCacheKey: string;
  readonly fields: readonly EditWorkflowField[];
  readonly capabilities: EditWorkflowCapabilitySummary;
  readonly relationshipCount: number;
  readonly updatedAt: string;
}

export interface EditWorkflowDraft {
  readonly mode: EditWorkflowMode;
  readonly sourceId: SourceId;
  readonly featureId?: FeatureId;
  readonly values: InspectionAttributes;
  readonly geometry: InspectionFeature["geometry"];
}

export interface EditWorkflowReadinessEntry {
  readonly sourceId: SourceId;
  readonly capability: "applyEdits" | "attachments" | "relationships" | "conflicts";
  readonly state: string;
  readonly note: string;
}

export interface EditWorkflowOperationLogEntry {
  readonly id: string;
  readonly title: string;
  readonly status: EditWorkflowSubmitResult<InspectionAttributes>["status"] | "ready";
  readonly detail: string;
  readonly optimistic: string;
}

export interface EditWorkflowUiModels {
  readonly map: HonuaAppWorkspaceMapModel<EditWorkflowSourceMetadata>;
  readonly table: HonuaAppWorkspaceTableModel<InspectionFeature, EditWorkflowSourceMetadata>;
  readonly detail: HonuaAppWorkspaceDetailModel<InspectionFeature>;
  readonly filters: HonuaAppWorkspaceFilterModel;
  readonly chart: HonuaAppWorkspaceChartModel;
  readonly cache: HonuaAppWorkspaceMetadataCacheModel<EditWorkflowSourceMetadata>;
}

export interface EditWorkflowViews {
  readonly map: ExplorationViewController;
  readonly table: ExplorationViewController;
  readonly filters: ExplorationViewController;
  readonly form: ExplorationViewController;
  readonly chart: ExplorationViewController;
}

export interface EditWorkflowDemoSession {
  readonly dataset: EditWorkflowDataset;
  readonly workspace: HonuaAppWorkspace<InspectionFeature, EditWorkflowSourceMetadata>;
  readonly exploration: ExplorationContext;
  readonly views: EditWorkflowViews;
  readonly source: Source<InspectionAttributes>;
  readonly readonlySource: Source<InspectionAttributes>;
  readonly sourceId: SourceId;
  readonly readonlySourceId: SourceId;
  activeArea(): EditWorkflowMapArea;
  activeProjection(): LinkedViewQueryProjection;
  capabilities(): EditWorkflowCapabilitySummary;
  metadataFields(): readonly EditWorkflowField[];
  allFeatures(): readonly InspectionFeature[];
  draft(): EditWorkflowDraft;
  pendingAttachments(): readonly EditAttachmentMutation[];
  sketchSnapshot(): EditSketchWorkflowSnapshot<InspectionAttributes>;
  attachmentList(featureId?: FeatureId): Promise<readonly AttachmentInfo[]>;
  visibleFeatures(): readonly InspectionFeature[];
  detailFeature(): InspectionFeature | undefined;
  setStatusFilter(status: InspectionStatus | "all"): void;
  setPriorityFilter(priority: InspectionPriority | "all"): void;
  selectMapArea(areaId: MapAreaId): void;
  selectFeature(featureId: FeatureId): void;
  startCreateDraft(): void;
  updateDraftValue(fieldName: keyof InspectionAttributes, value: unknown): void;
  applySketchGeometry(tool: EditSketchTool, geometry: EditWorkflowDraft["geometry"]): void;
  undoSketchEdit(): boolean;
  redoSketchEdit(): boolean;
  stageAttachmentAdd(name?: string): void;
  stageAttachmentDelete(attachmentId?: FeatureId): Promise<void>;
  submitDraft(): Promise<EditWorkflowSubmitResult<InspectionAttributes>>;
  deleteSelected(): Promise<EditWorkflowSubmitResult<InspectionAttributes>>;
  forceNextConflict(): void;
  runUnsupportedCheck(): Promise<EditWorkflowSubmitResult<InspectionAttributes>>;
  readiness(): readonly EditWorkflowReadinessEntry[];
  uiModels(): EditWorkflowUiModels;
  operationLog(): readonly EditWorkflowOperationLogEntry[];
  lastResult(): EditWorkflowSubmitResult<InspectionAttributes> | undefined;
  exportWorkspace(): string;
  dispose(): void;
}
