import {
  type HonuaAppWorkspace,
  type HonuaAppWorkspaceState,
  type HonuaSavedWorkspaceDocument,
  createHonuaAppWorkspace,
  createHonuaSavedWorkspaceDocument,
  validateHonuaSavedWorkspaceDocument,
} from "@honua/sdk-js/app-workspace";
import {
  type ExplorationContext,
  type ExplorationStateSnapshot,
  type ExplorationViewController,
  type FeatureSelectionTarget,
  type FilterClause,
  createExplorationContext,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";
import {
  type ChartExplorationBinding,
  type FilterControlsExplorationBinding,
  type InteractionBindingHandle,
  type LinkedViewQueryProjection,
  type MapExtentExplorationSource,
  type TableSelectionExplorationBinding,
  bindChartToExploration,
  bindFilterControlsToExploration,
  bindMapExtentToExploration,
  bindTableSelectionToExploration,
  extentToSpatialFilter,
  syncMapLayerFilterToExploration,
} from "@honua/sdk-js/interactions";
import {
  type RealtimeFeatureEvent,
  type RealtimeFeaturePatch,
  realtimeFeatureKey,
  reconcileRealtimeSelection,
} from "@honua/sdk-js/realtime";

import { createEditWorkflowDemoSession } from "../../edit-workflow-demo/src/model.js";
import type { EditWorkflowDemoSession, InspectionAttributes } from "../../edit-workflow-demo/src/types.js";
import {
  DEFAULT_WORKSPACE_EXTENT,
  INITIAL_SOURCE_METADATA,
  INITIAL_UNIFIED_OPS_FEATURES,
  OPS_SOURCE_IDS,
  UNIFIED_OPS_SCENARIO_STEPS,
  editWorkflowFeatureToUnifiedOpsFeature,
} from "./fixtures.js";
import { FIELD_INSPECTION_SOURCE_ID, INCIDENT_SOURCE_ID, OPS_LAYER_ID } from "./types.js";
import type {
  UnifiedOpsChartBucket,
  UnifiedOpsFeature,
  UnifiedOpsJobResult,
  UnifiedOpsModuleId,
  UnifiedOpsProjectionResult,
  UnifiedOpsSeverity,
  UnifiedOpsSnapshotDiagnostics,
  UnifiedOpsSourceId,
  UnifiedOpsSourceMetadata,
} from "./types.js";

export type UnifiedOpsAppWorkspace = HonuaAppWorkspace<
  UnifiedOpsFeature,
  UnifiedOpsSourceMetadata,
  UnifiedOpsJobResult
>;

export type UnifiedOpsWorkspaceState = HonuaAppWorkspaceState<
  UnifiedOpsFeature,
  UnifiedOpsSourceMetadata,
  UnifiedOpsJobResult
>;

export interface UnifiedOpsWorkspaceViews {
  readonly map: ExplorationViewController;
  readonly table: ExplorationViewController;
  readonly chart: ExplorationViewController;
  readonly filters: ExplorationViewController;
  readonly detail: ExplorationViewController;
}

export interface UnifiedOpsWorkspaceControllers {
  readonly filters: FilterControlsExplorationBinding;
  readonly table: TableSelectionExplorationBinding;
  readonly chart: ChartExplorationBinding;
}

export interface UnifiedOpsWorkspace {
  readonly workspace: UnifiedOpsAppWorkspace;
  readonly exploration: ExplorationContext;
  readonly views: UnifiedOpsWorkspaceViews;
  readonly controllers: UnifiedOpsWorkspaceControllers;
  readonly mapExtentSource: ManualMapExtentSource;
  readonly mapLayerFilters: MemoryMapLayerFilterTarget;
  readonly editWorkflow: EditWorkflowDemoSession;
  readonly sourceIds: ReadonlyArray<UnifiedOpsSourceId>;
  readonly currentScenarioStepIndex: number;
  stepRealtimeScenario(): string | undefined;
  dispose(): void;
}

export interface CreateUnifiedOpsWorkspaceOptions {
  readonly now?: () => number;
}

export interface ApplyUnifiedOpsProjectionOptions {
  readonly sourceId?: UnifiedOpsSourceId;
}

export interface UnifiedOpsSnapshotSaveResult {
  readonly id: string;
  readonly document: HonuaSavedWorkspaceDocument<UnifiedOpsFeature, UnifiedOpsSourceMetadata, UnifiedOpsJobResult>;
  readonly diagnostics: UnifiedOpsSnapshotDiagnostics;
}

export type UnifiedOpsSnapshotRestoreResult =
  | {
      readonly ok: true;
      readonly diagnostics: UnifiedOpsSnapshotDiagnostics;
    }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<string>;
    };

const SEVERITY_ORDER: readonly UnifiedOpsSeverity[] = ["critical", "high", "medium", "low"];
const SEVERITY_RANK: Record<UnifiedOpsSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const STATUS_RANK: Record<string, number> = {
  open: 0,
  assigned: 1,
  enroute: 2,
  "in-progress": 3,
  monitoring: 4,
  staged: 5,
  available: 6,
  resolved: 7,
  closed: 8,
};

export class ManualMapExtentSource implements MapExtentExplorationSource {
  #extent: HonuaExtent | undefined;
  readonly #listeners = new Set<(extent: HonuaExtent | undefined) => void>();

  public constructor(initialExtent: HonuaExtent | undefined = DEFAULT_WORKSPACE_EXTENT) {
    this.#extent = initialExtent;
  }

  public current(): HonuaExtent | undefined {
    return this.#extent;
  }

  public subscribe(listener: (extent: HonuaExtent | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public publish(extent: HonuaExtent | undefined): void {
    this.#extent = extent;
    for (const listener of [...this.#listeners]) listener(extent);
  }
}

export class MemoryMapLayerFilterTarget {
  readonly filters: Record<string, unknown> = {};

  public setFilter(layerId: string, filter: unknown): void {
    this.filters[layerId] = filter;
  }
}

export function createUnifiedOpsWorkspace(options: CreateUnifiedOpsWorkspaceOptions = {}): UnifiedOpsWorkspace {
  const now = options.now ?? (() => Date.now());
  const workspace = createHonuaAppWorkspace<UnifiedOpsFeature, UnifiedOpsSourceMetadata, UnifiedOpsJobResult>();
  const editWorkflow = createEditWorkflowDemoSession();
  const exploration = createExplorationContext({
    datasetId: "unified-operational-intelligence",
    sourceIds: OPS_SOURCE_IDS,
    preset: "globalLinked",
  });
  const views: UnifiedOpsWorkspaceViews = {
    map: exploration.connectView({ id: "unified-ops-map", role: "map" }),
    table: exploration.connectView({ id: "unified-ops-table", role: "grid" }),
    chart: exploration.connectView({ id: "unified-ops-chart", role: "chart" }),
    filters: exploration.connectView({ id: "unified-ops-filters", role: "filter" }),
    detail: exploration.connectView({ id: "unified-ops-detail", role: "detail" }),
  };
  const mapExtentSource = new ManualMapExtentSource(DEFAULT_WORKSPACE_EXTENT);
  const mapLayerFilters = new MemoryMapLayerFilterTarget();
  const bindingHandles: InteractionBindingHandle[] = [
    bindMapExtentToExploration(views.map, mapExtentSource, {
      applyInitial: false,
      coalesce: false,
      publishSpatialFilter: true,
    }),
    syncMapLayerFilterToExploration(mapLayerFilters, views.map, {
      layerId: OPS_LAYER_ID,
      translate: createUnifiedOpsLayerFilter,
    }),
  ];
  let scenarioStepIndex = 0;

  workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
  workspace.dispatch({
    kind: "set-layout",
    layout: {
      activeViewId: "incident-command",
      panels: {
        "incident-command": { visible: true, order: 1, size: 620 },
        "analysis-review": { visible: false, order: 2, size: 520 },
        "field-editing": { visible: false, order: 3, size: 520 },
        "detail-panel": { visible: true, order: 4, size: 360 },
        "diagnostics-panel": { visible: true, order: 5, size: 320 },
      },
    },
  });

  seedUnifiedOpsExploration(exploration);
  syncUnifiedOpsExplorationSnapshot(workspace, exploration);
  seedUnifiedOpsSources(workspace, now());
  seedUnifiedOpsRealtime(workspace, now());

  return {
    workspace,
    exploration,
    views,
    controllers: {
      filters: bindFilterControlsToExploration(views.filters),
      table: bindTableSelectionToExploration(views.table),
      chart: bindChartToExploration(views.chart),
    },
    mapExtentSource,
    mapLayerFilters,
    editWorkflow,
    sourceIds: OPS_SOURCE_IDS,
    get currentScenarioStepIndex() {
      return scenarioStepIndex;
    },
    stepRealtimeScenario(): string | undefined {
      const step = UNIFIED_OPS_SCENARIO_STEPS[scenarioStepIndex % UNIFIED_OPS_SCENARIO_STEPS.length];
      scenarioStepIndex += 1;
      applyUnifiedOpsRealtimeEvent(this, scenarioStepToRealtimeEvent(step.event, scenarioStepIndex, now()));
      return step.label;
    },
    dispose(): void {
      for (const handle of bindingHandles) handle.remove();
      editWorkflow.dispose();
      workspace.dispose();
      exploration.dispose();
    },
  };
}

export function setUnifiedOpsActiveModule(shell: UnifiedOpsWorkspace, moduleId: UnifiedOpsModuleId): void {
  shell.workspace.dispatch({ kind: "set-active-view", viewId: moduleId });
  shell.workspace.dispatch({
    kind: "update-panel",
    panelId: "incident-command",
    panel: { visible: moduleId === "incident-command" },
  });
  shell.workspace.dispatch({
    kind: "update-panel",
    panelId: "analysis-review",
    panel: { visible: moduleId === "analysis-review" },
  });
  shell.workspace.dispatch({
    kind: "update-panel",
    panelId: "field-editing",
    panel: { visible: moduleId === "field-editing" },
  });
}

export function visibleUnifiedOpsEditFeatures(shell: UnifiedOpsWorkspace): readonly UnifiedOpsFeature[] {
  const active = shell.workspace.state.sources.entries[FIELD_INSPECTION_SOURCE_ID]?.metadata?.active !== false;
  if (!active) return [];
  return applyUnifiedOpsProjection(shell.workspace.state, selectProjectionFromState(shell.workspace.state), {
    sourceId: FIELD_INSPECTION_SOURCE_ID,
  }).rows;
}

export function selectUnifiedOpsEditFeature(shell: UnifiedOpsWorkspace, featureId: string | number): void {
  shell.editWorkflow.selectFeature(Number(featureId));
  shell.views.table.select([sourceFeatureSelectionTarget(FIELD_INSPECTION_SOURCE_ID, String(featureId))], {
    replace: true,
  });
  syncUnifiedOpsExplorationSnapshot(shell.workspace, shell.exploration);
}

export function updateUnifiedOpsEditDraftValue(
  shell: UnifiedOpsWorkspace,
  fieldName: keyof InspectionAttributes,
  value: unknown,
): void {
  shell.editWorkflow.updateDraftValue(fieldName, value);
}

export function stageUnifiedOpsEditAttachment(shell: UnifiedOpsWorkspace, name = "workspace-after-action.png"): void {
  shell.editWorkflow.stageAttachmentAdd(name);
}

export function forceUnifiedOpsEditConflict(shell: UnifiedOpsWorkspace): void {
  shell.editWorkflow.forceNextConflict();
}

export async function submitUnifiedOpsEditDraft(shell: UnifiedOpsWorkspace) {
  const result = await shell.editWorkflow.submitDraft();
  syncUnifiedOpsEditWorkflowFeatures(shell);
  const committedId = result.committedFeatureId ?? shell.editWorkflow.draft().featureId;
  if (committedId !== undefined) {
    shell.views.table.select([sourceFeatureSelectionTarget(FIELD_INSPECTION_SOURCE_ID, String(committedId))], {
      replace: true,
    });
    syncUnifiedOpsExplorationSnapshot(shell.workspace, shell.exploration);
  }
  return result;
}

export function setUnifiedOpsActiveSource(
  shell: UnifiedOpsWorkspace,
  sourceId: UnifiedOpsSourceId,
  active: boolean,
  options: { readonly now?: number } = {},
): void {
  const existing = shell.workspace.state.sources.entries[sourceId]?.metadata ?? INITIAL_SOURCE_METADATA[sourceId];
  shell.workspace.dispatch({
    kind: "set-source-metadata",
    sourceId,
    status: active ? "ready" : "stale",
    metadata: {
      ...existing,
      active,
      cache: {
        ...existing.cache,
        status: active ? existing.cache.status : "stale",
      },
    },
    updatedAt: options.now ?? Date.now(),
  });
}

export function moveUnifiedOpsMap(shell: UnifiedOpsWorkspace, extent: HonuaExtent | undefined): void {
  shell.mapExtentSource.publish(extent);
}

export function applyUnifiedOpsRealtimeEvent(
  shell: UnifiedOpsWorkspace,
  event: RealtimeFeatureEvent<UnifiedOpsFeature>,
): void {
  shell.workspace.dispatch({ kind: "apply-realtime-event", event });
  reconcileRealtimeSelection(shell.views.detail, shell.workspace.state.realtime.features, { requireLiveRecord: false });
}

export function stageUnifiedOpsAiDraft(
  shell: UnifiedOpsWorkspace,
  options: { readonly now?: number; readonly source?: "ai" | "mcp" } = {},
): string {
  const now = options.now ?? Date.now();
  const source = options.source ?? "ai";
  const draftId = `${source}-critical-focus-${now}`;
  const snapshot = nextCriticalFocusSnapshot(shell.exploration.snapshot());
  shell.workspace.dispatch({
    kind: "set-job-snapshot",
    jobId: `${source}-review-${now}`,
    type: `${source}-workspace-review`,
    snapshot: {
      status: "successful",
      result: {
        outputs: {
          draft: {
            kind: "analysis-draft",
            title: "Focus critical open incidents",
            summary: "Adds a critical severity filter while preserving the current map extent and selection.",
            draftId,
          },
        },
      },
    },
  });
  shell.workspace.dispatch({
    kind: "stage-draft",
    activate: true,
    draft: {
      id: draftId,
      source,
      label: "Focus critical open incidents",
      description: "Reviewable action: add a critical severity filter to the shared linked context.",
      createdAt: now,
      proposedIntent: {
        kind: "restore-exploration-snapshot",
        snapshot,
      },
      metadata: {
        preserves: ["extent", "selection", "active-sources", "module-state"],
      },
    },
  });
  return draftId;
}

export function applyUnifiedOpsDraft(shell: UnifiedOpsWorkspace, draftId: string): void {
  const draft = shell.workspace.state.drafts.entries[draftId];
  if (!draft) throw new Error(`Unified ops draft ${draftId} was not found`);
  const intent = draft.proposedIntent;
  if (intent.kind === "restore-exploration-snapshot") {
    shell.exploration.restore(intent.snapshot);
    syncUnifiedOpsExplorationSnapshot(shell.workspace, shell.exploration);
    shell.workspace.dispatch({ kind: "remove-draft", draftId });
    return;
  }
  if (intent.kind === "set-exploration" && intent.snapshot) {
    shell.exploration.restore(intent.snapshot);
    syncUnifiedOpsExplorationSnapshot(shell.workspace, shell.exploration);
    shell.workspace.dispatch({ kind: "remove-draft", draftId });
    return;
  }
  shell.workspace.applyDraft(draftId);
}

export function saveUnifiedOpsSnapshot(
  shell: UnifiedOpsWorkspace,
  options: { readonly savedAt?: string; readonly id?: string } = {},
): UnifiedOpsSnapshotSaveResult {
  const savedAt = options.savedAt ?? new Date().toISOString();
  const id = options.id ?? `unified-ops-${savedAt.replaceAll(/[:.]/g, "-")}`;
  shell.workspace.dispatch({
    kind: "set-saved-state-metadata",
    metadata: {
      id,
      label: "Unified operational intelligence workspace",
      savedAt: Date.parse(savedAt),
      version: "1",
    },
  });
  const snapshot = shell.workspace.snapshot();
  const diagnostics = createUnifiedOpsSnapshotDiagnostics(snapshot.state);
  const exploration = snapshot.state.exploration.snapshot?.state;
  const document = createHonuaSavedWorkspaceDocument<UnifiedOpsFeature, UnifiedOpsSourceMetadata, UnifiedOpsJobResult>({
    project: {
      id: "unified-operational-intelligence",
      title: "Unified operational intelligence workspace",
      metadata: {
        issue: 73,
      },
    },
    session: {
      id,
      activeViewId: snapshot.state.layout.activeViewId,
      updatedAt: savedAt,
    },
    snapshot,
    savedAt,
    sources: Object.values(snapshot.state.sources.entries).map((entry) => ({
      id: entry.sourceId,
      title: entry.metadata?.title,
      protocol: entry.metadata?.protocol,
      status: entry.status,
      metadata: entry.metadata,
    })),
    layers: [
      {
        id: OPS_LAYER_ID,
        title: "Unified operational features",
        visible: true,
        metadata: {
          activeSourceIds: activeSourceIds(snapshot.state),
        },
      },
    ],
    styles: [
      {
        id: "ops-severity",
        layerId: OPS_LAYER_ID,
        name: "Severity and source role",
        spec:
          shell.mapLayerFilters.filters[OPS_LAYER_ID] ??
          createUnifiedOpsLayerFilter(selectProjectionFromState(snapshot.state)),
      },
    ],
    savedQueries: [
      {
        id: "current-linked-context",
        label: "Current linked context",
        sourceIds: snapshot.state.exploration.reference?.sourceIds,
        filters: exploration?.filters ?? {},
        spatialFilter: exploration?.spatialFilter,
        sort: exploration?.sort,
        page: exploration?.page,
        visibleFields: exploration?.visibleFields,
        grouping: exploration?.grouping,
        aggregation: exploration?.aggregation,
      },
    ],
    analysisOutputs: Object.values(snapshot.state.jobs.entries).flatMap((entry) =>
      Object.entries(entry.snapshot.result?.outputs ?? {}).map(([outputId, output]) => ({
        id: `${entry.id}-${outputId}`,
        jobId: entry.id,
        type: "json",
        label: outputId,
        data: output,
      })),
    ),
    metadata: {
      diagnostics,
    },
  });

  shell.workspace.dispatch({
    kind: "set-job-snapshot",
    jobId: "snapshot-diagnostics",
    type: "workspace-snapshot",
    snapshot: {
      status: "successful",
      result: {
        outputs: {
          diagnostics: {
            kind: "snapshot-diagnostics",
            title: "Snapshot diagnostics",
            summary: `${diagnostics.realtimeRecordCount} live records and ${diagnostics.filterCount} filters saved.`,
            diagnostics,
          },
        },
      },
    },
  });

  return { id, document, diagnostics };
}

export function restoreUnifiedOpsSnapshot(
  shell: UnifiedOpsWorkspace,
  document: unknown,
): UnifiedOpsSnapshotRestoreResult {
  const validation = validateHonuaSavedWorkspaceDocument<
    UnifiedOpsFeature,
    UnifiedOpsSourceMetadata,
    UnifiedOpsJobResult
  >(document);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors.map((error) => `${error.path}: ${error.message}`),
    };
  }
  const snapshot = validation.document.appSnapshot;
  if (!snapshot) {
    return { ok: false, errors: ["Saved workspace document does not include an appSnapshot."] };
  }
  shell.workspace.restore(snapshot);
  const explorationSnapshot = snapshot.state.exploration.snapshot;
  if (explorationSnapshot) shell.exploration.restore(explorationSnapshot);
  return {
    ok: true,
    diagnostics: createUnifiedOpsSnapshotDiagnostics(shell.workspace.state),
  };
}

export function applyUnifiedOpsProjection(
  state: UnifiedOpsWorkspaceState,
  projection: LinkedViewQueryProjection,
  options: ApplyUnifiedOpsProjectionOptions = {},
): UnifiedOpsProjectionResult {
  const active = new Set(activeSourceIds(state));
  const filters = Object.values(projection.filters);
  const rows = Object.values(state.realtime.features.records)
    .map((record) => record.feature)
    .filter((feature) => active.has(feature.sourceId))
    .filter((feature) => (options.sourceId ? feature.sourceId === options.sourceId : true))
    .filter((feature) => featureInExtent(feature, projection.extent))
    .filter((feature) => filters.every((clause) => matchesClause(feature, clause)))
    .sort(compareUnifiedOpsFeatures);
  const incidentRows = rows.filter((feature) => feature.kind === "incident");
  const crewRows = rows.filter((feature) => feature.kind === "crew");
  return {
    rows,
    incidentRows,
    crewRows,
    summary: summarizeRows(rows),
    buckets: createSeverityBuckets(incidentRows),
  };
}

export function createUnifiedOpsLayerFilter(projection: LinkedViewQueryProjection): unknown {
  const clauses = Object.values(projection.filters).flatMap((clause) => {
    const filter = clauseToLayerFilter(clause);
    return filter ? [filter] : [];
  });
  return clauses.length === 0 ? ["==", "$type", "Point"] : ["all", ["==", "$type", "Point"], ...clauses];
}

export function createUnifiedOpsSnapshotDiagnostics(state: UnifiedOpsWorkspaceState): UnifiedOpsSnapshotDiagnostics {
  const entries = Object.values(state.sources.entries);
  const exploration = state.exploration.snapshot?.state;
  const warnings: string[] = [];
  if (entries.length === 0) warnings.push("No source metadata is attached to the workspace.");
  if (activeSourceIds(state).length === 0) warnings.push("No active source is enabled.");
  if ((exploration?.selection.length ?? 0) > 0 && Object.keys(state.realtime.features.records).length === 0) {
    warnings.push("Selection exists without live records.");
  }
  if (Object.keys(state.drafts.entries).length > 0) warnings.push("Reviewable drafts are saved but not applied.");

  return {
    sourceCount: entries.length,
    activeSourceCount: activeSourceIds(state).length,
    filterCount: Object.keys(exploration?.filters ?? {}).length,
    selectedFeatureCount: exploration?.selection.length ?? 0,
    realtimeRecordCount: Object.keys(state.realtime.features.records).length,
    jobCount: Object.keys(state.jobs.entries).length,
    draftCount: Object.keys(state.drafts.entries).length,
    activeViewId: state.layout.activeViewId,
    modulePanelCount: Object.keys(state.layout.panels).length,
    warnings,
  };
}

export function activeSourceIds(state: UnifiedOpsWorkspaceState): UnifiedOpsSourceId[] {
  return OPS_SOURCE_IDS.filter((sourceId) => state.sources.entries[sourceId]?.metadata?.active !== false);
}

export function selectedFeatureId(selection: ReadonlyArray<FeatureSelectionTarget>): string | undefined {
  const [target] = selection;
  if (!target) return undefined;
  return isSourceQualifiedSelectionTarget(target) ? String(target.id) : String(target);
}

export function formatExtent(extent: HonuaExtent | undefined): string {
  if (!extent) return "No extent";
  return `${extent.xmin.toFixed(3)}, ${extent.ymin.toFixed(3)} to ${extent.xmax.toFixed(3)}, ${extent.ymax.toFixed(3)}`;
}

function seedUnifiedOpsExploration(exploration: ExplorationContext): void {
  exploration.dispatch({ kind: "set-visible-fields", fields: ["id", "title", "status", "severity", "district"] });
  exploration.dispatch({ kind: "set-page", page: { offset: 0, limit: 25 } });
  exploration.dispatch({ kind: "set-sort", sort: [{ field: "severity", direction: "asc" }] });
  exploration.dispatch({ kind: "set-grouping", grouping: ["severity"] });
  exploration.dispatch({
    kind: "set-aggregation",
    aggregation: {
      groupBy: ["severity"],
      metrics: [{ fn: "count", field: "id", alias: "features" }],
    },
  });
  exploration.dispatch({ kind: "set-extent", extent: DEFAULT_WORKSPACE_EXTENT });
  exploration.dispatch({ kind: "set-spatial-filter", spatialFilter: extentToSpatialFilter(DEFAULT_WORKSPACE_EXTENT) });
}

function syncUnifiedOpsExplorationSnapshot(workspace: UnifiedOpsAppWorkspace, exploration: ExplorationContext): void {
  workspace.dispatch({
    kind: "set-exploration",
    reference: { datasetId: exploration.datasetId, sourceIds: exploration.sourceIds },
    snapshot: exploration.snapshot(),
  });
}

function seedUnifiedOpsSources(workspace: UnifiedOpsAppWorkspace, now: number): void {
  for (const sourceId of OPS_SOURCE_IDS) {
    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId,
      status: "ready",
      metadata: INITIAL_SOURCE_METADATA[sourceId],
      updatedAt: now,
    });
  }
}

function seedUnifiedOpsRealtime(workspace: UnifiedOpsAppWorkspace, now: number): void {
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      eventId: "unified-ops-initial-snapshot",
      cursor: "fixture-0",
      sequence: 0,
      receivedAt: now,
      features: INITIAL_UNIFIED_OPS_FEATURES.map(featureToPatch),
      replace: true,
    },
  });
}

function syncUnifiedOpsEditWorkflowFeatures(shell: UnifiedOpsWorkspace): void {
  for (const feature of shell.editWorkflow.allFeatures()) {
    shell.workspace.dispatch({
      kind: "apply-realtime-event",
      event: {
        type: "upsert",
        eventId: `edit-workflow-sync-${String(feature.id)}-${String(feature.attributes.version)}`,
        receivedAt: Date.parse(feature.attributes.last_edited_date),
        feature: featureToPatch(editWorkflowFeatureToUnifiedOpsFeature(feature)),
      },
    });
  }
}

function scenarioStepToRealtimeEvent(
  event: (typeof UNIFIED_OPS_SCENARIO_STEPS)[number]["event"],
  sequence: number,
  receivedAt: number,
): RealtimeFeatureEvent<UnifiedOpsFeature> {
  if (event.type === "delete") {
    return {
      type: "delete",
      eventId: `unified-ops-step-${sequence}`,
      cursor: `fixture-${sequence}`,
      sequence,
      receivedAt,
      sourceId: event.sourceId,
      id: event.id,
    };
  }
  return {
    type: "upsert",
    eventId: `unified-ops-step-${sequence}`,
    cursor: `fixture-${sequence}`,
    sequence,
    receivedAt,
    feature: featureToPatch(event.feature),
  };
}

function featureToPatch(feature: UnifiedOpsFeature): RealtimeFeaturePatch<UnifiedOpsFeature> {
  return {
    sourceId: feature.sourceId,
    id: feature.id,
    feature,
    updatedAt: feature.updatedAt,
  };
}

function nextCriticalFocusSnapshot(snapshot: ExplorationStateSnapshot): ExplorationStateSnapshot {
  return {
    version: 1,
    state: {
      ...structuredClone(snapshot.state),
      filters: {
        ...snapshot.state.filters,
        aiCritical: {
          field: "severity",
          operator: "=",
          value: "critical",
          appliesTo: [INCIDENT_SOURCE_ID],
        },
      },
    },
  };
}

function selectProjectionFromState(state: UnifiedOpsWorkspaceState): LinkedViewQueryProjection {
  const exploration = state.exploration.snapshot?.state;
  return {
    filters: exploration?.filters ?? {},
    spatialFilter: exploration?.spatialFilter,
    extent: exploration?.extent,
    selection: exploration?.selection ?? [],
    orderBy: exploration?.sort ?? [],
    pagination: exploration?.page ?? {},
    outFields: exploration?.visibleFields,
    grouping: exploration?.grouping ?? [],
    aggregation: exploration?.aggregation,
  };
}

function compareUnifiedOpsFeatures(left: UnifiedOpsFeature, right: UnifiedOpsFeature): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    (STATUS_RANK[left.status] ?? 99) - (STATUS_RANK[right.status] ?? 99) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function summarizeRows(rows: ReadonlyArray<UnifiedOpsFeature>) {
  const incidents = rows.filter((feature) => feature.kind === "incident");
  const activeIncidents = incidents.filter((feature) => feature.status !== "resolved");
  const etaTotal = activeIncidents.reduce((sum, feature) => sum + (feature.etaMinutes ?? 0), 0);
  return {
    visible: rows.length,
    activeIncidents: activeIncidents.length,
    criticalIncidents: incidents.filter((feature) => feature.severity === "critical").length,
    availableCrews: rows.filter((feature) => feature.kind === "crew" && feature.status === "available").length,
    averageEtaMinutes: activeIncidents.length > 0 ? Math.round(etaTotal / activeIncidents.length) : 0,
  };
}

function createSeverityBuckets(incidentRows: ReadonlyArray<UnifiedOpsFeature>): UnifiedOpsChartBucket[] {
  return SEVERITY_ORDER.map((severity) => {
    const rows = incidentRows.filter((feature) => feature.severity === severity);
    return {
      id: severity,
      label: titleCase(severity),
      count: rows.length,
      targets: rows.map((feature) => sourceFeatureSelectionTarget(feature.sourceId, feature.id)),
      filter: {
        field: "severity",
        operator: "=",
        value: severity,
        appliesTo: [INCIDENT_SOURCE_ID],
      },
    };
  });
}

function featureInExtent(feature: UnifiedOpsFeature, extent: HonuaExtent | undefined): boolean {
  if (!extent) return true;
  const [x, y] = feature.coordinate;
  return x >= extent.xmin && x <= extent.xmax && y >= extent.ymin && y <= extent.ymax;
}

function matchesClause(feature: UnifiedOpsFeature, clause: FilterClause): boolean {
  if (clause.appliesTo && clause.appliesTo.length > 0 && !clause.appliesTo.includes(feature.sourceId)) return true;
  const value = featureValue(feature, clause.field);
  switch (clause.operator) {
    case "=":
      return value === clause.value;
    case "!=":
      return value !== clause.value;
    case "<":
      return typeof value === "number" && typeof clause.value === "number" && value < clause.value;
    case "<=":
      return typeof value === "number" && typeof clause.value === "number" && value <= clause.value;
    case ">":
      return typeof value === "number" && typeof clause.value === "number" && value > clause.value;
    case ">=":
      return typeof value === "number" && typeof clause.value === "number" && value >= clause.value;
    case "between":
      return (
        typeof value === "number" &&
        Array.isArray(clause.value) &&
        typeof clause.value[0] === "number" &&
        typeof clause.value[1] === "number" &&
        value >= clause.value[0] &&
        value <= clause.value[1]
      );
    case "in":
      return Array.isArray(clause.value) && clause.value.includes(value);
    case "not-in":
      return Array.isArray(clause.value) && !clause.value.includes(value);
    case "like":
      return typeof value === "string" && typeof clause.value === "string" && value.includes(clause.value);
    case "is-null":
      return value === undefined || value === null;
    case "is-not-null":
      return value !== undefined && value !== null;
  }
}

function featureValue(feature: UnifiedOpsFeature, field: string): unknown {
  if (field in feature) return feature[field as keyof UnifiedOpsFeature];
  return undefined;
}

function clauseToLayerFilter(clause: FilterClause): unknown[] | undefined {
  switch (clause.operator) {
    case "=":
      return ["==", ["get", clause.field], clause.value];
    case "!=":
      return ["!=", ["get", clause.field], clause.value];
    case "in":
      return Array.isArray(clause.value) ? ["in", ["get", clause.field], ["literal", clause.value]] : undefined;
    default:
      return undefined;
  }
}

function titleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function featureRecordKey(feature: UnifiedOpsFeature): string {
  return realtimeFeatureKey(feature.sourceId, feature.id);
}
