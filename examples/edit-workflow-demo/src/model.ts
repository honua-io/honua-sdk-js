import {
  createHonuaAppWorkspace,
  createHonuaSavedWorkspaceDocument,
  selectHonuaAppWorkspaceChartModel,
  selectHonuaAppWorkspaceDetailModel,
  selectHonuaAppWorkspaceFilterModel,
  selectHonuaAppWorkspaceMapModel,
  selectHonuaAppWorkspaceMetadataCacheModel,
  selectHonuaAppWorkspaceTableModel,
} from "@honua/sdk-js/app-workspace";
import {
  type AggregationSpec,
  type AttachmentApi,
  type AttachmentDelete,
  type AttachmentEditOutcome,
  type AttachmentInfo,
  type AttachmentQuery,
  type CanonicalFeature,
  type EditAttachmentMutation,
  type EditEnvelope,
  type EditResult,
  type EditWorkflowCapabilitySummary,
  type EditWorkflowSubmitResult,
  type FeatureId,
  type Query,
  type RelatedQuery,
  type RelatedResult,
  type Result,
  type Source,
  type SourceDescriptor,
  capabilities,
  createEditSession,
} from "@honua/sdk-js/contract";
import { createExplorationContext, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import { HonuaCapabilityNotSupportedError, type HonuaExtent, envelope } from "@honua/sdk-js/honua";

import {
  EDIT_WORKFLOW_DOMAINS,
  EDIT_WORKFLOW_FIELDS,
  EDIT_WORKFLOW_GENERATED_AT,
  EDIT_WORKFLOW_RELATIONSHIPS,
  EDIT_WORKFLOW_SOURCE_ID,
  createEditWorkflowDataset,
  createEditableSourceDescriptor,
  createReadonlySourceDescriptor,
} from "./fixtures.js";
import type {
  EditWorkflowDataset,
  EditWorkflowDemoSession,
  EditWorkflowDraft,
  EditWorkflowMapArea,
  EditWorkflowOperationLogEntry,
  EditWorkflowReadinessEntry,
  EditWorkflowSourceMetadata,
  EditWorkflowUiModels,
  InspectionAttributes,
  InspectionFeature,
  InspectionPriority,
  InspectionStatus,
  MapAreaId,
} from "./types.js";

const EDITABLE_FIELD_NAMES: readonly string[] = [
  "asset_id",
  "asset_name",
  "status",
  "priority",
  "inspection_score",
  "assigned_to",
  "notes",
  "version",
];
const SPATIAL_REFERENCE = { wkid: 4326 } as const;

export function createEditWorkflowDemoSession(
  dataset: EditWorkflowDataset = createEditWorkflowDataset(),
): EditWorkflowDemoSession {
  const source = new FixtureEditSource(dataset, createEditableSourceDescriptor(dataset.sourceId));
  const readonlySource = new FixtureReadonlySource(dataset, createReadonlySourceDescriptor(dataset.readonlySourceId));
  const workspace = createHonuaAppWorkspace<InspectionFeature, EditWorkflowSourceMetadata>();
  const exploration = createExplorationContext({
    datasetId: dataset.id,
    sourceIds: [dataset.sourceId],
    preset: "globalLinked",
  });
  const views = {
    map: exploration.connectView({ id: "edit-map", role: "map" }),
    table: exploration.connectView({ id: "edit-table", role: "grid" }),
    filters: exploration.connectView({ id: "edit-filters", role: "filter" }),
    form: exploration.connectView({ id: "edit-form", role: "form" }),
    chart: exploration.connectView({ id: "edit-chart", role: "chart" }),
  };

  let activeAreaId: MapAreaId = dataset.mapAreas[0]?.id ?? "honolulu-harbor";
  let draft = draftFromFeature(source.features()[0] ?? dataset.features[0]);
  let pendingAttachments: EditAttachmentMutation[] = [];
  let conflictNext = false;
  let logCounter = 0;
  let latestResult: EditWorkflowSubmitResult<InspectionAttributes> | undefined;
  const logEntries: EditWorkflowOperationLogEntry[] = [
    {
      id: "ready",
      title: "Workflow ready",
      status: "ready",
      detail: "metadata cache, domains, relationships, attachments, and conflict hints loaded",
      optimistic: "none",
    },
  ];

  workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
  workspace.dispatch({
    kind: "set-layout",
    layout: {
      activeViewId: views.map.id,
      panels: {
        map: { order: 1, size: 2 },
        table: { order: 2, size: 2 },
        filters: { order: 0, size: 1 },
        form: { order: 3, size: 1 },
      },
    },
  });
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: dataset.sourceId,
    status: "ready",
    updatedAt: Date.parse(dataset.generatedAt),
    metadata: sourceMetadata(dataset, source),
  });
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: dataset.readonlySourceId,
    status: "ready",
    updatedAt: Date.parse(dataset.generatedAt),
    metadata: readonlySourceMetadata(dataset, readonlySource),
  });
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: { type: "status", status: "live", receivedAt: Date.parse(dataset.generatedAt) },
  });
  publishSnapshot(source.features(), workspace, dataset);

  const initialArea = requireArea(dataset, activeAreaId);
  views.map.setExtent(initialArea.extent);
  views.map.setSpatialFilter(envelopeFromExtent(initialArea.extent));
  views.table.setVisibleFields([...EDITABLE_FIELD_NAMES]);
  views.chart.setGrouping(["status"]);
  views.chart.setAggregation({
    groupBy: ["status"],
    metrics: [{ fn: "avg", field: "inspection_score", alias: "score" }],
  });
  if (draft.featureId !== undefined) {
    views.table.select([sourceFeatureSelectionTarget(dataset.sourceId, draft.featureId)], { replace: true });
  }
  syncWorkspaceExploration(workspace, exploration);

  function activeArea(): EditWorkflowMapArea {
    return requireArea(dataset, activeAreaId);
  }

  function activeProjection() {
    return selectHonuaAppWorkspaceTableModel(workspace.state, { sourceId: dataset.sourceId }).query;
  }

  function visibleFeatures(): readonly InspectionFeature[] {
    const table = selectHonuaAppWorkspaceTableModel(workspace.state, { sourceId: dataset.sourceId });
    return applyProjection(
      table.records.map((record) => record.feature),
      table.query,
    );
  }

  function detailFeature(): InspectionFeature | undefined {
    const detail = selectHonuaAppWorkspaceDetailModel(workspace.state);
    return detail.selectedRecords[0]?.feature;
  }

  function selectFeature(featureId: FeatureId): void {
    const feature = source.getFeature(featureId) ?? visibleFeatures().find((entry) => entry.id === featureId);
    if (!feature) throw new Error(`Unknown inspection feature: ${String(featureId)}`);
    views.table.select([sourceFeatureSelectionTarget(dataset.sourceId, featureId)], { replace: true });
    draft = draftFromFeature(feature);
    pendingAttachments = [];
    syncWorkspaceExploration(workspace, exploration);
  }

  function setStatusFilter(status: InspectionStatus | "all"): void {
    if (status === "all") {
      views.filters.clearFilter("status");
    } else {
      views.filters.setFilter("status", {
        field: "status",
        operator: "=",
        value: status,
        appliesTo: [dataset.sourceId],
      });
    }
    syncWorkspaceExploration(workspace, exploration);
  }

  function setPriorityFilter(priority: InspectionPriority | "all"): void {
    if (priority === "all") {
      views.filters.clearFilter("priority");
    } else {
      views.filters.setFilter("priority", {
        field: "priority",
        operator: "=",
        value: priority,
        appliesTo: [dataset.sourceId],
      });
    }
    syncWorkspaceExploration(workspace, exploration);
  }

  function selectMapArea(areaId: MapAreaId): void {
    const area = requireArea(dataset, areaId);
    activeAreaId = area.id;
    views.map.setExtent(area.extent);
    views.map.setSpatialFilter(envelopeFromExtent(area.extent));
    syncWorkspaceExploration(workspace, exploration);
  }

  function startCreateDraft(): void {
    const area = activeArea();
    const nextId = source.peekNextObjectId();
    const x = (area.extent.xmin + area.extent.xmax) / 2;
    const y = (area.extent.ymin + area.extent.ymax) / 2;
    draft = {
      mode: "create",
      sourceId: dataset.sourceId,
      values: {
        OBJECTID: nextId,
        asset_id: `NEW-${nextId}`,
        asset_name: "New field inspection",
        status: "open",
        priority: "medium",
        inspection_score: 50,
        assigned_to: "Unassigned",
        notes: "Created from the editing workflow demo.",
        version: 1,
        last_edited_date: EDIT_WORKFLOW_GENERATED_AT,
      },
      geometry: { type: "point", x, y, spatialReference: SPATIAL_REFERENCE },
    };
    pendingAttachments = [];
    views.table.deselect();
    syncWorkspaceExploration(workspace, exploration);
  }

  function updateDraftValue(fieldName: keyof InspectionAttributes, value: unknown): void {
    draft = {
      ...draft,
      values: {
        ...draft.values,
        [fieldName]: coerceDraftValue(fieldName, value),
      },
    };
  }

  function stageAttachmentAdd(name = "after-action.png"): void {
    pendingAttachments = [
      ...pendingAttachments,
      {
        operation: "add",
        ...(draft.featureId !== undefined ? { parentId: draft.featureId } : {}),
        attachment: `fixture://${name}`,
        name,
        contentType: contentTypeForName(name),
      },
    ];
  }

  async function stageAttachmentDelete(attachmentId?: FeatureId): Promise<void> {
    const featureId = draft.featureId;
    if (featureId === undefined) return;
    const attachments = await source.attachments.list(featureId);
    const resolvedId = attachmentId ?? attachments[0]?.id;
    if (resolvedId === undefined) return;
    pendingAttachments = [
      ...pendingAttachments,
      {
        operation: "delete",
        parentId: featureId,
        attachmentIds: [resolvedId],
      },
    ];
  }

  async function submitDraft(): Promise<EditWorkflowSubmitResult<InspectionAttributes>> {
    const kind = draft.mode === "create" ? "create" : "update";
    const selected = draft.featureId !== undefined ? source.getFeature(draft.featureId) : undefined;
    const previous = selected ? cloneFeature(selected) : undefined;
    source.failNextUpdateConflict = conflictNext;
    conflictNext = false;

    const session = createEditSession<InspectionAttributes>({
      source,
      kind,
      feature: canonicalFeatureFromDraft(draft),
      metadata: metadataOptions(),
      rollbackOnFailure: true,
      optimistic: {
        apply(snapshot) {
          pushLog(
            `${titleCase(kind)} optimistic`,
            "ready",
            `staged ${snapshot.attachments.length} attachment mutation(s)`,
            "applied",
          );
          if (draft.mode === "update" && previous) {
            upsertWorkspaceFeature(featureFromCanonical(previous, snapshot.feature, activeAreaId), workspace, dataset);
          }
        },
        rollback(_snapshot, result) {
          if (previous) upsertWorkspaceFeature(previous, workspace, dataset);
          pushLog(`${titleCase(kind)} rollback`, result.status, failureSummary(result), "rolled back");
        },
        commit(_snapshot, result) {
          const committedId = result.committedFeatureId ?? draft.featureId;
          const committed = committedId !== undefined ? source.getFeature(committedId) : undefined;
          if (committed) upsertWorkspaceFeature(committed, workspace, dataset);
          pushLog(
            `${titleCase(kind)} committed`,
            result.status,
            committedId ? `feature ${String(committedId)}` : "feature",
            "committed",
          );
        },
      },
    });
    for (const mutation of pendingAttachments) stageAttachment(session, mutation);

    const result = await session.submit();
    latestResult = result;
    if (result.status === "succeeded") {
      const committedId = result.committedFeatureId ?? draft.featureId;
      publishSnapshot(source.features(), workspace, dataset);
      if (committedId !== undefined) selectFeature(committedId);
      pendingAttachments = [];
    } else if (result.status === "partial") {
      pendingAttachments = [];
      pushLog(
        "Partial edit",
        result.status,
        failureSummary(result),
        result.optimistic.rolledBack ? "rolled back" : "applied",
      );
    } else {
      pushLog(
        "Edit failed",
        result.status,
        failureSummary(result),
        result.optimistic.rolledBack ? "rolled back" : "not applied",
      );
    }
    return result;
  }

  async function deleteSelected(): Promise<EditWorkflowSubmitResult<InspectionAttributes>> {
    const selected = detailFeature();
    if (!selected) throw new Error("No inspection selected for delete");
    const previous = cloneFeature(selected);
    const session = createEditSession<InspectionAttributes>({
      source,
      kind: "delete",
      feature: { id: selected.id, attributes: { ...selected.attributes }, geometry: selected.geometry },
      metadata: metadataOptions(),
      rollbackOnFailure: true,
      optimistic: {
        apply() {
          deleteWorkspaceFeature(selected.id, workspace, dataset);
          pushLog("Delete optimistic", "ready", selected.title, "applied");
        },
        rollback(_snapshot, result) {
          upsertWorkspaceFeature(previous, workspace, dataset);
          pushLog("Delete rollback", result.status, failureSummary(result), "rolled back");
        },
        commit(_snapshot, result) {
          pushLog("Delete committed", result.status, selected.title, "committed");
        },
      },
    });

    const result = await session.submit();
    latestResult = result;
    if (result.status === "succeeded") {
      pendingAttachments = [];
      const next = visibleFeatures()[0] ?? source.features()[0];
      if (next) selectFeature(next.id);
      publishSnapshot(source.features(), workspace, dataset);
    }
    return result;
  }

  async function runUnsupportedCheck(): Promise<EditWorkflowSubmitResult<InspectionAttributes>> {
    const target = draft.featureId !== undefined ? source.getFeature(draft.featureId) : source.features()[0];
    if (!target) throw new Error("No fixture feature available for unsupported workflow check");
    const result = await createEditSession<InspectionAttributes>({
      source: readonlySource,
      kind: "update",
      feature: { id: target.id, attributes: { ...target.attributes }, geometry: target.geometry },
      metadata: metadataOptions(),
    })
      .stageAttachmentAdd("readonly-proof.png", {
        parentId: target.id,
        name: "readonly-proof.png",
        contentType: "image/png",
      })
      .submit();
    latestResult = result;
    pushLog("Unsupported source check", result.status, failureSummary(result), "not applied");
    return result;
  }

  function readiness(): readonly EditWorkflowReadinessEntry[] {
    const caps = capabilitiesFor(source);
    const readonlyCaps = capabilitiesFor(readonlySource);
    return [
      {
        sourceId: dataset.sourceId,
        capability: "applyEdits",
        state: caps.applyEdits,
        note: "feature create, update, and delete use the same edit session contract",
      },
      {
        sourceId: dataset.sourceId,
        capability: "attachments",
        state: caps.attachments,
        note: "attachment add and delete run inside the selected edit workflow",
      },
      {
        sourceId: dataset.sourceId,
        capability: "relationships",
        state: caps.relationships,
        note: "related work orders are discoverable from the metadata relationship list",
      },
      {
        sourceId: dataset.sourceId,
        capability: "conflicts",
        state: caps.conflicts,
        note: "version field is surfaced on conflict failures",
      },
      {
        sourceId: dataset.readonlySourceId,
        capability: "applyEdits",
        state: readonlyCaps.applyEdits,
        note: "read-only sources fail preflight instead of dropping edits",
      },
      {
        sourceId: dataset.readonlySourceId,
        capability: "attachments",
        state: readonlyCaps.attachments,
        note: "attachment controls can be disabled from capability state",
      },
    ];
  }

  function uiModels(): EditWorkflowUiModels {
    return {
      map: selectHonuaAppWorkspaceMapModel(workspace.state, { sourceId: dataset.sourceId }),
      table: selectHonuaAppWorkspaceTableModel(workspace.state, { sourceId: dataset.sourceId }),
      detail: selectHonuaAppWorkspaceDetailModel(workspace.state),
      filters: selectHonuaAppWorkspaceFilterModel(workspace.state),
      chart: selectHonuaAppWorkspaceChartModel(workspace.state, { sourceId: dataset.sourceId }),
      cache: selectHonuaAppWorkspaceMetadataCacheModel(workspace.state),
    };
  }

  function operationLog(): readonly EditWorkflowOperationLogEntry[] {
    return [...logEntries];
  }

  function pushLog(
    title: string,
    status: EditWorkflowOperationLogEntry["status"],
    detail: string,
    optimistic: string,
  ): void {
    logCounter += 1;
    logEntries.unshift({ id: `log-${logCounter}`, title, status, detail, optimistic });
    if (logEntries.length > 8) logEntries.pop();
  }

  return {
    dataset,
    workspace,
    exploration,
    views,
    source,
    readonlySource,
    sourceId: dataset.sourceId,
    readonlySourceId: dataset.readonlySourceId,
    activeArea,
    activeProjection,
    capabilities() {
      return capabilitiesFor(source);
    },
    metadataFields() {
      return EDIT_WORKFLOW_FIELDS;
    },
    allFeatures() {
      return source.features();
    },
    draft() {
      return cloneDraft(draft);
    },
    pendingAttachments() {
      return pendingAttachments.map(cloneAttachmentMutation);
    },
    attachmentList(featureId) {
      const resolvedId = featureId ?? draft.featureId;
      return resolvedId === undefined ? Promise.resolve([]) : source.attachments.list(resolvedId);
    },
    visibleFeatures,
    detailFeature,
    setStatusFilter,
    setPriorityFilter,
    selectMapArea,
    selectFeature,
    startCreateDraft,
    updateDraftValue,
    stageAttachmentAdd,
    stageAttachmentDelete,
    submitDraft,
    deleteSelected,
    forceNextConflict() {
      conflictNext = true;
    },
    runUnsupportedCheck,
    readiness,
    uiModels,
    operationLog,
    lastResult() {
      return latestResult;
    },
    exportWorkspace() {
      const doc = createHonuaSavedWorkspaceDocument<InspectionFeature, EditWorkflowSourceMetadata>({
        project: {
          id: dataset.id,
          title: dataset.title,
          metadata: {
            workflow: "edit-session",
            sourceId: dataset.sourceId,
            cachePolicy: "metadata-only",
          },
        },
        snapshot: workspace.snapshot(),
        savedAt: dataset.generatedAt,
        metadata: {
          demo: "edit-workflow",
          selectedArea: activeArea().id,
          pendingAttachmentCount: pendingAttachments.length,
        },
      });
      return JSON.stringify(doc, null, 2);
    },
    dispose() {
      workspace.dispose();
      exploration.dispose();
    },
  };
}

class FixtureEditSource implements Source<InspectionAttributes> {
  public readonly descriptor: SourceDescriptor;
  public readonly capabilities;
  public failNextUpdateConflict = false;
  readonly #features = new Map<FeatureId, InspectionFeature>();
  readonly #attachments = new Map<FeatureId, AttachmentInfo[]>();
  #nextObjectId = 0;
  #nextAttachmentId = 10_000;

  public constructor(dataset: EditWorkflowDataset, descriptor: SourceDescriptor) {
    this.descriptor = descriptor;
    this.capabilities = descriptor.capabilities;
    for (const feature of dataset.features) {
      this.#features.set(feature.id, cloneFeature(feature));
      this.#nextObjectId = Math.max(this.#nextObjectId, Number(feature.id) + 1);
    }
    for (const [parentId, attachments] of Object.entries(dataset.attachments)) {
      this.#attachments.set(Number(parentId), attachments.map(cloneAttachment));
      for (const attachment of attachments)
        this.#nextAttachmentId = Math.max(this.#nextAttachmentId, Number(attachment.id) + 1);
    }
  }

  public features(): readonly InspectionFeature[] {
    return [...this.#features.values()].map(cloneFeature);
  }

  public getFeature(id: FeatureId): InspectionFeature | undefined {
    const feature = this.#features.get(id);
    return feature ? cloneFeature(feature) : undefined;
  }

  public peekNextObjectId(): number {
    return this.#nextObjectId;
  }

  public async query(_request?: Query<InspectionAttributes>): Promise<Result<InspectionAttributes>> {
    return {
      features: this.features().map((feature) => ({
        attributes: { ...feature.attributes },
        geometry: { ...feature.geometry },
      })),
      exceededTransferLimit: false,
      totalCount: this.#features.size,
      fields: this.descriptor.schema?.fields,
    };
  }

  public async queryAll(request?: Query<InspectionAttributes>): Promise<Result<InspectionAttributes>> {
    return this.query(request);
  }

  public async queryAggregate(
    _request?: Query<InspectionAttributes> & { aggregation?: AggregationSpec },
  ): Promise<Result<InspectionAttributes>> {
    const rows = countByStatus(this.features());
    return { features: [], aggregateRows: rows, exceededTransferLimit: false, totalCount: rows.length };
  }

  public async queryExtent(
    _request?: Query<InspectionAttributes>,
  ): Promise<{ extent: HonuaExtent | null; count?: number }> {
    const features = this.features();
    if (features.length === 0) return { extent: null, count: 0 };
    return {
      extent: {
        xmin: Math.min(...features.map((feature) => feature.geometry.x)),
        ymin: Math.min(...features.map((feature) => feature.geometry.y)),
        xmax: Math.max(...features.map((feature) => feature.geometry.x)),
        ymax: Math.max(...features.map((feature) => feature.geometry.y)),
        spatialReference: SPATIAL_REFERENCE,
      },
      count: features.length,
    };
  }

  public async *stream(
    _request?: Query<InspectionAttributes>,
  ): AsyncGenerator<Result<InspectionAttributes>, void, undefined> {
    yield await this.query();
  }

  public async queryObjectIds(_request?: Query<InspectionAttributes>): Promise<readonly FeatureId[]> {
    return [...this.#features.keys()];
  }

  public async applyEdits(envelopeInput: EditEnvelope<InspectionAttributes>): Promise<EditResult> {
    const added = (envelopeInput.adds ?? []).map((feature) => this.#addFeature(feature));
    const updated = (envelopeInput.updates ?? []).map((feature) => this.#updateFeature(feature));
    const deleted = (envelopeInput.deletes ?? []).map((id) => this.#deleteFeature(id));
    return { added, updated, deleted };
  }

  public async queryRelated<R = Record<string, unknown>>(request: RelatedQuery): Promise<RelatedResult<R>> {
    return {
      groups: request.sourceIds.map((sourceId) => ({
        sourceId,
        features: [
          {
            attributes: {
              work_order_id: `WO-${String(sourceId)}`,
              status: "scheduled",
              crew: "Field Ops",
            } as R,
          },
        ],
      })),
    };
  }

  public readonly attachments: AttachmentApi = {
    query: async (request: AttachmentQuery = {}) => {
      const parentIds = request.parentIds ?? [...this.#attachments.keys()];
      return parentIds.map((parentId) => ({ parentId, attachments: this.#listAttachments(parentId) }));
    },
    list: async (parentId) => this.#listAttachments(parentId),
    add: async (request) => {
      if (String(request.name ?? "").includes("too-large")) {
        return {
          parentId: request.parentId,
          success: false,
          error: { code: 413, description: "attachment exceeds source upload limit" },
        };
      }
      const attachmentId = this.#nextAttachmentId;
      this.#nextAttachmentId += 1;
      const attachment: AttachmentInfo = {
        id: attachmentId,
        parentId: request.parentId,
        name: request.name,
        contentType: request.contentType,
        size: typeof request.attachment === "string" ? request.attachment.length * 64 : undefined,
      };
      this.#attachments.set(request.parentId, [...this.#listAttachments(request.parentId), attachment]);
      return { parentId: request.parentId, attachmentId, success: true };
    },
    update: async (request) => {
      const attachments = this.#listAttachments(request.parentId);
      const index = attachments.findIndex((attachment) => attachment.id === request.attachmentId);
      if (index === -1) {
        return {
          parentId: request.parentId,
          attachmentId: request.attachmentId,
          success: false,
          error: { code: 404, description: "attachment not found" },
        };
      }
      attachments[index] = {
        ...attachments[index],
        name: request.name ?? attachments[index]?.name,
        contentType: request.contentType ?? attachments[index]?.contentType,
      };
      this.#attachments.set(request.parentId, attachments);
      return { parentId: request.parentId, attachmentId: request.attachmentId, success: true };
    },
    delete: async (request: AttachmentDelete) => {
      const attachments = this.#listAttachments(request.parentId);
      const ids = new Set(request.attachmentIds);
      this.#attachments.set(
        request.parentId,
        attachments.filter((attachment) => !ids.has(attachment.id)),
      );
      return request.attachmentIds.map<AttachmentEditOutcome>((attachmentId) => ({
        parentId: request.parentId,
        attachmentId,
        success: attachments.some((attachment) => attachment.id === attachmentId),
        ...(attachments.some((attachment) => attachment.id === attachmentId)
          ? {}
          : { error: { code: 404, description: "attachment not found" } }),
      }));
    },
  };

  public protocol() {
    return undefined;
  }

  public adapter() {
    return undefined;
  }

  #addFeature(feature: CanonicalFeature<InspectionAttributes>) {
    const id = feature.id ?? this.#nextObjectId;
    this.#nextObjectId = Math.max(this.#nextObjectId, Number(id) + 1);
    const attributes: InspectionAttributes = {
      ...feature.attributes,
      OBJECTID: Number(id),
      version: 1,
      last_edited_date: EDIT_WORKFLOW_GENERATED_AT,
    };
    const created = featureFromAttributes(id, attributes, feature.geometry ?? defaultGeometry(), "honolulu-harbor");
    this.#features.set(id, created);
    return { id, success: true };
  }

  #updateFeature(feature: CanonicalFeature<InspectionAttributes>) {
    if (feature.id === undefined) {
      return { success: false, error: { code: 400, description: "update requires feature id" } };
    }
    if (this.failNextUpdateConflict) {
      this.failNextUpdateConflict = false;
      return {
        id: feature.id,
        success: false,
        error: { code: 409, description: `version conflict: expected ${String(feature.attributes.version)}` },
      };
    }
    const existing = this.#features.get(feature.id);
    if (!existing) return { id: feature.id, success: false, error: { code: 404, description: "feature not found" } };
    const attributes: InspectionAttributes = {
      ...existing.attributes,
      ...feature.attributes,
      OBJECTID: Number(feature.id),
      version: Number(existing.attributes.version) + 1,
      last_edited_date: EDIT_WORKFLOW_GENERATED_AT,
    };
    this.#features.set(
      feature.id,
      featureFromAttributes(feature.id, attributes, feature.geometry ?? existing.geometry, existing.areaId),
    );
    return { id: feature.id, success: true };
  }

  #deleteFeature(id: FeatureId) {
    const existed = this.#features.delete(id);
    this.#attachments.delete(id);
    return existed
      ? { id, success: true }
      : { id, success: false, error: { code: 404, description: "feature not found" } };
  }

  #listAttachments(parentId: FeatureId): AttachmentInfo[] {
    return (this.#attachments.get(parentId) ?? []).map(cloneAttachment);
  }
}

class FixtureReadonlySource implements Source<InspectionAttributes> {
  public readonly descriptor: SourceDescriptor;
  public readonly capabilities = capabilities(["query", "queryExtent", "queryObjectIds"]);
  public readonly attachments: AttachmentApi;
  readonly #editable: FixtureEditSource;

  public constructor(dataset: EditWorkflowDataset, descriptor: SourceDescriptor) {
    this.descriptor = descriptor;
    this.attachments = unsupportedAttachments(descriptor);
    this.#editable = new FixtureEditSource(dataset, descriptor);
  }

  public query(request?: Query<InspectionAttributes>) {
    return this.#editable.query(request);
  }

  public queryAll(request?: Query<InspectionAttributes>) {
    return this.#editable.queryAll(request);
  }

  public queryAggregate(request: Query<InspectionAttributes>) {
    return this.#editable.queryAggregate(request);
  }

  public queryExtent(request?: Query<InspectionAttributes>) {
    return this.#editable.queryExtent(request);
  }

  public stream(request?: Query<InspectionAttributes>) {
    return this.#editable.stream(request);
  }

  public queryObjectIds(request?: Query<InspectionAttributes>) {
    return this.#editable.queryObjectIds(request);
  }

  public applyEdits(): Promise<EditResult> {
    throw new HonuaCapabilityNotSupportedError("applyEdits", this.descriptor.protocol, this.descriptor.id);
  }

  public async queryRelated<R = Record<string, unknown>>(_request: RelatedQuery): Promise<RelatedResult<R>> {
    throw new HonuaCapabilityNotSupportedError("queryRelated", this.descriptor.protocol, this.descriptor.id);
  }

  public protocol() {
    return undefined;
  }

  public adapter() {
    return undefined;
  }
}

function unsupportedAttachments(descriptor: SourceDescriptor): AttachmentApi {
  const fail = () => {
    throw new HonuaCapabilityNotSupportedError("attachments", descriptor.protocol, descriptor.id);
  };
  return {
    query: fail,
    list: fail,
    add: fail,
    update: fail,
    delete: fail,
  };
}

function sourceMetadata(
  dataset: EditWorkflowDataset,
  source: Source<InspectionAttributes>,
): EditWorkflowSourceMetadata {
  return {
    title: dataset.title,
    sourceId: dataset.sourceId,
    protocol: source.descriptor.protocol,
    cachePolicy: "metadata-only",
    metadataCacheKey: requireArea(dataset, "honolulu-harbor").cacheKey,
    fields: EDIT_WORKFLOW_FIELDS,
    capabilities: capabilitiesFor(source),
    relationshipCount: EDIT_WORKFLOW_RELATIONSHIPS.length,
    updatedAt: dataset.generatedAt,
  };
}

function readonlySourceMetadata(
  dataset: EditWorkflowDataset,
  source: Source<InspectionAttributes>,
): EditWorkflowSourceMetadata {
  return {
    ...sourceMetadata(dataset, source),
    sourceId: dataset.readonlySourceId,
    metadataCacheKey: "metadata:field-inspections-readonly:v1",
  };
}

function capabilitiesFor(source: Source<InspectionAttributes>): EditWorkflowCapabilitySummary {
  const probe = createEditSession<InspectionAttributes>({
    source,
    kind: "update",
    feature: { id: 0, attributes: emptyAttributes(0), geometry: defaultGeometry() },
    metadata: metadataOptions(),
  });
  return probe.capabilities();
}

function metadataOptions() {
  return {
    domains: EDIT_WORKFLOW_DOMAINS,
    relationships: EDIT_WORKFLOW_RELATIONSHIPS,
    conflict: { state: "supported" as const, versionField: "version" },
  };
}

function publishSnapshot(
  features: readonly InspectionFeature[],
  workspace: ReturnType<typeof createHonuaAppWorkspace<InspectionFeature, EditWorkflowSourceMetadata>>,
  dataset: EditWorkflowDataset,
): void {
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      replace: true,
      receivedAt: Date.parse(dataset.generatedAt),
      features: features.map((feature) => realtimePatch(feature, dataset.sourceId)),
    },
  });
}

function upsertWorkspaceFeature(
  feature: InspectionFeature,
  workspace: ReturnType<typeof createHonuaAppWorkspace<InspectionFeature, EditWorkflowSourceMetadata>>,
  dataset: EditWorkflowDataset,
): void {
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "upsert",
      receivedAt: Date.parse(dataset.generatedAt),
      feature: realtimePatch(feature, dataset.sourceId),
    },
  });
}

function deleteWorkspaceFeature(
  id: FeatureId,
  workspace: ReturnType<typeof createHonuaAppWorkspace<InspectionFeature, EditWorkflowSourceMetadata>>,
  dataset: EditWorkflowDataset,
): void {
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: { type: "delete", id, sourceId: dataset.sourceId, receivedAt: Date.parse(dataset.generatedAt) },
  });
}

function realtimePatch(feature: InspectionFeature, sourceId: string) {
  return {
    id: feature.id,
    sourceId,
    feature,
    version: Number(feature.attributes.version),
    updatedAt: feature.attributes.last_edited_date,
  };
}

function syncWorkspaceExploration(
  workspace: ReturnType<typeof createHonuaAppWorkspace<InspectionFeature, EditWorkflowSourceMetadata>>,
  exploration: ReturnType<typeof createExplorationContext>,
): void {
  workspace.dispatch({
    kind: "set-exploration",
    reference: { datasetId: exploration.datasetId, sourceIds: [...exploration.sourceIds] },
    snapshot: exploration.snapshot(),
  });
}

function applyProjection(
  features: readonly InspectionFeature[],
  query: ReturnType<EditWorkflowDemoSession["activeProjection"]>,
) {
  return features
    .filter((feature) => {
      for (const clause of Object.values(query.filters)) {
        if (clause.operator === "=" && feature.attributes[clause.field] !== clause.value) return false;
      }
      if (query.extent && !pointInExtent(feature.geometry.x, feature.geometry.y, query.extent)) return false;
      return true;
    })
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function pointInExtent(x: number, y: number, extent: HonuaExtent): boolean {
  return x >= extent.xmin && x <= extent.xmax && y >= extent.ymin && y <= extent.ymax;
}

function envelopeFromExtent(extent: HonuaExtent) {
  return envelope(extent.xmin, extent.ymin, extent.xmax, extent.ymax, extent.spatialReference);
}

function draftFromFeature(feature: InspectionFeature): EditWorkflowDraft {
  return {
    mode: "update",
    sourceId: feature.sourceId,
    featureId: feature.id,
    values: { ...feature.attributes },
    geometry: { ...feature.geometry },
  };
}

function canonicalFeatureFromDraft(draft: EditWorkflowDraft): CanonicalFeature<InspectionAttributes> {
  const attributes = { ...draft.values };
  if (draft.mode === "create") {
    delete (attributes as Partial<InspectionAttributes>).OBJECTID;
    delete (attributes as Partial<InspectionAttributes>).last_edited_date;
  }
  return {
    ...(draft.featureId !== undefined ? { id: draft.featureId } : {}),
    attributes,
    geometry: { ...draft.geometry },
  };
}

function featureFromCanonical(
  previous: InspectionFeature,
  canonical: CanonicalFeature<InspectionAttributes>,
  areaId: MapAreaId,
): InspectionFeature {
  return featureFromAttributes(
    canonical.id ?? previous.id,
    { ...previous.attributes, ...canonical.attributes },
    canonical.geometry ?? previous.geometry,
    previous.areaId ?? areaId,
  );
}

function featureFromAttributes(
  id: FeatureId,
  attributes: InspectionAttributes,
  geometry: Record<string, unknown> | null | undefined,
  areaId: MapAreaId,
): InspectionFeature {
  const point = isPointGeometry(geometry) ? geometry : defaultGeometry();
  return {
    id,
    sourceId: EDIT_WORKFLOW_SOURCE_ID,
    title: attributes.asset_name,
    attributes: { ...attributes },
    geometry: point,
    mapPosition: {
      x: Math.max(8, Math.min(92, 50 + (point.x + 157.88) * 700)),
      y: Math.max(8, Math.min(92, 54 - (point.y - 21.31) * 600)),
    },
    areaId,
  };
}

function isPointGeometry(value: Record<string, unknown> | null | undefined): value is InspectionFeature["geometry"] {
  return (
    !!value &&
    value.type === "point" &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.spatialReference === "object"
  );
}

function defaultGeometry(): InspectionFeature["geometry"] {
  return { type: "point", x: -157.875, y: 21.311, spatialReference: SPATIAL_REFERENCE };
}

function emptyAttributes(id: number): InspectionAttributes {
  return {
    OBJECTID: id,
    asset_id: "",
    asset_name: "",
    status: "open",
    priority: "medium",
    inspection_score: 0,
    assigned_to: "",
    notes: "",
    version: 1,
    last_edited_date: EDIT_WORKFLOW_GENERATED_AT,
  };
}

function stageAttachment(
  session: ReturnType<typeof createEditSession<InspectionAttributes>>,
  mutation: EditAttachmentMutation,
): void {
  if (mutation.operation === "add") {
    session.stageAttachmentAdd(mutation.attachment, {
      parentId: mutation.parentId,
      name: mutation.name,
      contentType: mutation.contentType,
    });
  } else if (mutation.operation === "update") {
    session.stageAttachmentUpdate(mutation.attachmentId, mutation.attachment, {
      parentId: mutation.parentId,
      name: mutation.name,
      contentType: mutation.contentType,
    });
  } else {
    session.stageAttachmentDelete(mutation.attachmentIds, { parentId: mutation.parentId });
  }
}

function requireArea(dataset: EditWorkflowDataset, areaId: MapAreaId): EditWorkflowMapArea {
  const area = dataset.mapAreas.find((entry) => entry.id === areaId);
  if (!area) throw new Error(`Missing edit workflow map area: ${areaId}`);
  return area;
}

function coerceDraftValue(
  fieldName: keyof InspectionAttributes,
  value: unknown,
): InspectionAttributes[keyof InspectionAttributes] {
  if (fieldName === "inspection_score" || fieldName === "version" || fieldName === "OBJECTID") return Number(value);
  return String(value);
}

function cloneDraft(draft: EditWorkflowDraft): EditWorkflowDraft {
  return {
    ...draft,
    values: { ...draft.values },
    geometry: { ...draft.geometry },
  };
}

function cloneFeature(feature: InspectionFeature): InspectionFeature {
  return {
    ...feature,
    attributes: { ...feature.attributes },
    geometry: { ...feature.geometry },
    mapPosition: { ...feature.mapPosition },
  };
}

function cloneAttachment(attachment: AttachmentInfo): AttachmentInfo {
  return { ...attachment };
}

function cloneAttachmentMutation(mutation: EditAttachmentMutation): EditAttachmentMutation {
  if (mutation.operation === "delete") return { ...mutation, attachmentIds: [...mutation.attachmentIds] };
  return { ...mutation };
}

function contentTypeForName(name: string): string {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

function countByStatus(features: readonly InspectionFeature[]): ReadonlyArray<Record<string, unknown>> {
  const counts = new Map<string, number>();
  for (const feature of features)
    counts.set(feature.attributes.status, (counts.get(feature.attributes.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => ({ status, count }));
}

function failureSummary(result: EditWorkflowSubmitResult<InspectionAttributes>): string {
  if (result.failures.length === 0) return `feature ${String(result.committedFeatureId ?? "")}`.trim();
  return result.failures.map((failure) => failure.description).join("; ");
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
