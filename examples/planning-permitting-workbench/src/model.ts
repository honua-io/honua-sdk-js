import {
  type HonuaAppWorkspace,
  type HonuaAppWorkspaceState,
  type HonuaSavedWorkspaceDocument,
  createHonuaAppWorkspace,
  createHonuaSavedWorkspaceDocument,
} from "@honua/sdk-js/app-workspace";
import {
  type AggregationSpec,
  type AttachmentApi,
  type CanonicalFeature,
  type EditEnvelope,
  type EditResult,
  type EditWorkflowCapabilitySummary,
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
import {
  type ExplorationContext,
  type FeatureSelectionTarget,
  type FilterClause,
  createExplorationContext,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "@honua/sdk-js/exploration";
import { HonuaCapabilityNotSupportedError, type HonuaExtent } from "@honua/sdk-js/honua";
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
} from "@honua/sdk-js/interactions";

import {
  DEFAULT_WORKBENCH_EXTENT,
  FLOOD_CLASSES,
  INITIAL_SOURCE_METADATA,
  PARCELS,
  PERMITS,
  WORKBENCH_GENERATED_AT,
  ZONING_CLASSES,
} from "./fixtures.js";
import { FLOOD_SOURCE_ID, PARCEL_SOURCE_ID, PERMIT_SOURCE_ID, ZONING_SOURCE_ID } from "./types.js";
import type {
  FloodClass,
  MeasureResult,
  ParcelFeature,
  PermitAttributes,
  PermitFeature,
  PermitReadinessEntry,
  SketchFootprint,
  WorkbenchLayerId,
  WorkbenchModuleId,
  WorkbenchPrintManifest,
  WorkbenchQueryResult,
  WorkbenchSourceId,
  WorkbenchSourceMetadata,
  WorkbenchZoningBucket,
  ZoningCode,
} from "./types.js";

const SPATIAL_REFERENCE = { wkid: 4326 } as const;
const WORKBENCH_SOURCE_IDS: readonly WorkbenchSourceId[] = [
  PARCEL_SOURCE_ID,
  ZONING_SOURCE_ID,
  FLOOD_SOURCE_ID,
  PERMIT_SOURCE_ID,
];

export type WorkbenchAppWorkspace = HonuaAppWorkspace<PermitFeature, WorkbenchSourceMetadata>;
export type WorkbenchWorkspaceState = HonuaAppWorkspaceState<PermitFeature, WorkbenchSourceMetadata>;

export interface PermitDraft {
  readonly mode: "create" | "update";
  readonly featureId?: number;
  readonly values: PermitAttributes;
  readonly coordinate: readonly [number, number];
}

export interface PermitSubmitOutcome {
  readonly status: "applied" | "degraded" | "failed";
  readonly committedFeatureId?: number;
  readonly message: string;
  readonly degraded: boolean;
}

export interface PlanningWorkbench {
  readonly workspace: WorkbenchAppWorkspace;
  readonly exploration: ExplorationContext;
  readonly views: {
    readonly map: ReturnType<ExplorationContext["connectView"]>;
    readonly table: ReturnType<ExplorationContext["connectView"]>;
    readonly chart: ReturnType<ExplorationContext["connectView"]>;
    readonly filters: ReturnType<ExplorationContext["connectView"]>;
    readonly detail: ReturnType<ExplorationContext["connectView"]>;
  };
  readonly controllers: {
    readonly filters: FilterControlsExplorationBinding;
    readonly table: TableSelectionExplorationBinding;
    readonly chart: ChartExplorationBinding;
  };
  readonly mapExtentSource: ManualMapExtentSource;
  readonly permitSource: PermitFixtureSource;
  readonly sourceIds: readonly WorkbenchSourceId[];
  permitCapabilities(): EditWorkflowCapabilitySummary;
  dispose(): void;
}

export class ManualMapExtentSource implements MapExtentExplorationSource {
  #extent: HonuaExtent | undefined;
  readonly #listeners = new Set<(extent: HonuaExtent | undefined) => void>();

  public constructor(initialExtent: HonuaExtent | undefined = DEFAULT_WORKBENCH_EXTENT) {
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

export function createPlanningWorkbench(): PlanningWorkbench {
  const workspace = createHonuaAppWorkspace<PermitFeature, WorkbenchSourceMetadata>();
  const permitSource = new PermitFixtureSource(PERMITS);
  const exploration = createExplorationContext({
    datasetId: "maui-planning-permitting",
    sourceIds: [...WORKBENCH_SOURCE_IDS],
    preset: "globalLinked",
  });
  const views = {
    map: exploration.connectView({ id: "workbench-map", role: "map" }),
    table: exploration.connectView({ id: "workbench-table", role: "grid" }),
    chart: exploration.connectView({ id: "workbench-chart", role: "chart" }),
    filters: exploration.connectView({ id: "workbench-filters", role: "filter" }),
    detail: exploration.connectView({ id: "workbench-detail", role: "detail" }),
  };
  const mapExtentSource = new ManualMapExtentSource(DEFAULT_WORKBENCH_EXTENT);
  const bindingHandles: InteractionBindingHandle[] = [
    bindMapExtentToExploration(views.map, mapExtentSource, {
      applyInitial: false,
      coalesce: false,
      publishSpatialFilter: true,
    }),
  ];

  workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
  workspace.dispatch({
    kind: "set-layout",
    layout: {
      activeViewId: "review-board",
      panels: {
        "review-board": { visible: true, order: 1, size: 620 },
        "query-analysis": { visible: false, order: 2, size: 520 },
        "permit-editing": { visible: false, order: 3, size: 520 },
        "detail-panel": { visible: true, order: 4, size: 360 },
      },
    },
  });

  exploration.dispatch({
    kind: "set-visible-fields",
    fields: ["tmk", "address", "zoning", "floodZone", "assessedValue"],
  });
  exploration.dispatch({ kind: "set-page", page: { offset: 0, limit: 50 } });
  exploration.dispatch({ kind: "set-sort", sort: [{ field: "zoning", direction: "asc" }] });
  exploration.dispatch({ kind: "set-grouping", grouping: ["zoning"] });
  exploration.dispatch({
    kind: "set-aggregation",
    aggregation: { groupBy: ["zoning"], metrics: [{ fn: "count", field: "tmk", alias: "parcels" }] },
  });
  exploration.dispatch({ kind: "set-extent", extent: DEFAULT_WORKBENCH_EXTENT });
  exploration.dispatch({ kind: "set-spatial-filter", spatialFilter: extentToSpatialFilter(DEFAULT_WORKBENCH_EXTENT) });

  syncWorkbenchExploration(workspace, exploration);
  seedSources(workspace);
  publishPermits(workspace, permitSource.features());

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
    permitSource,
    sourceIds: WORKBENCH_SOURCE_IDS,
    permitCapabilities() {
      return capabilitiesFor(permitSource);
    },
    dispose() {
      for (const handle of bindingHandles) handle.remove();
      workspace.dispose();
      exploration.dispose();
    },
  };
}

export function setWorkbenchActiveModule(shell: PlanningWorkbench, moduleId: WorkbenchModuleId): void {
  shell.workspace.dispatch({ kind: "set-active-view", viewId: moduleId });
  for (const panelId of ["review-board", "query-analysis", "permit-editing"] as const) {
    shell.workspace.dispatch({
      kind: "update-panel",
      panelId,
      panel: { visible: panelId === moduleId },
    });
  }
}

export function setWorkbenchLayerVisible(shell: PlanningWorkbench, layerId: WorkbenchLayerId, visible: boolean): void {
  const sourceId = layerToSourceId(layerId);
  const existing = shell.workspace.state.sources.entries[sourceId]?.metadata ?? INITIAL_SOURCE_METADATA[sourceId];
  shell.workspace.dispatch({
    kind: "set-source-metadata",
    sourceId,
    status: visible ? "ready" : "stale",
    metadata: { ...existing, active: visible },
    updatedAt: Date.now(),
  });
}

export function isWorkbenchLayerVisible(state: WorkbenchWorkspaceState, layerId: WorkbenchLayerId): boolean {
  const sourceId = layerToSourceId(layerId);
  return state.sources.entries[sourceId]?.metadata?.active !== false;
}

export function setZoningFilter(shell: PlanningWorkbench, zoning: ZoningCode | ""): void {
  if (!zoning) {
    shell.controllers.filters.clearFilter("zoning");
  } else {
    shell.controllers.filters.setFilter("zoning", {
      field: "zoning",
      operator: "=",
      value: zoning,
      appliesTo: [PARCEL_SOURCE_ID],
    });
  }
  syncWorkbenchExploration(shell.workspace, shell.exploration);
}

export function setFloodOnlyFilter(shell: PlanningWorkbench, floodOnly: boolean): void {
  if (!floodOnly) {
    shell.controllers.filters.clearFilter("flood");
  } else {
    shell.controllers.filters.setFilter("flood", {
      field: "floodZone",
      operator: "in",
      value: regulatedFloodZones(),
      appliesTo: [PARCEL_SOURCE_ID],
    });
  }
  syncWorkbenchExploration(shell.workspace, shell.exploration);
}

export function clearWorkbenchFilters(shell: PlanningWorkbench): void {
  shell.controllers.filters.clearFilter("zoning");
  shell.controllers.filters.clearFilter("flood");
  syncWorkbenchExploration(shell.workspace, shell.exploration);
}

export function selectParcel(shell: PlanningWorkbench, parcelId: string): void {
  shell.controllers.table.select([sourceFeatureSelectionTarget(PARCEL_SOURCE_ID, parcelId)], { replace: true });
  syncWorkbenchExploration(shell.workspace, shell.exploration);
}

export function selectZoningBucket(shell: PlanningWorkbench, bucket: WorkbenchZoningBucket): void {
  shell.controllers.chart.selectBucket(
    { filters: { zoning: bucket.filter }, targets: bucket.targets },
    { replaceSelection: true },
  );
  syncWorkbenchExploration(shell.workspace, shell.exploration);
}

export function moveWorkbenchMap(shell: PlanningWorkbench, extent: HonuaExtent | undefined): void {
  shell.mapExtentSource.publish(extent);
  syncWorkbenchExploration(shell.workspace, shell.exploration);
}

export function currentProjection(state: WorkbenchWorkspaceState): LinkedViewQueryProjection {
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

export function runWorkbenchQuery(
  projection: LinkedViewQueryProjection,
  options: { readonly parcelsActive: boolean } = { parcelsActive: true },
): WorkbenchQueryResult {
  const filters = Object.values(projection.filters);
  const parcels = options.parcelsActive
    ? PARCELS.filter((parcel) => parcelInExtent(parcel, projection.extent)).filter((parcel) =>
        filters.every((clause) => matchesClause(parcel, clause)),
      )
    : [];
  return {
    parcels,
    buckets: createZoningBuckets(parcels),
    floodExposed: parcels.filter((parcel) => isRegulatedFloodZone(parcel.floodZone)).length,
    totalAssessedValue: parcels.reduce((sum, parcel) => sum + parcel.assessedValue, 0),
  };
}

export function selectedParcelId(selection: ReadonlyArray<FeatureSelectionTarget>): string | undefined {
  for (const target of selection) {
    if (isSourceQualifiedSelectionTarget(target)) {
      if (target.sourceId === PARCEL_SOURCE_ID) return String(target.id);
    } else {
      return String(target);
    }
  }
  return undefined;
}

export function findParcel(parcelId: string | undefined): ParcelFeature | undefined {
  if (!parcelId) return undefined;
  return PARCELS.find((parcel) => parcel.id === parcelId);
}

export function zoningClass(code: ZoningCode) {
  return ZONING_CLASSES.find((entry) => entry.code === code);
}

export function floodClass(zone: ParcelFeature["floodZone"]): FloodClass | undefined {
  return FLOOD_CLASSES.find((entry) => entry.zone === zone);
}

export function regulatedFloodZones(): ParcelFeature["floodZone"][] {
  return FLOOD_CLASSES.filter((entry) => entry.regulated).map((entry) => entry.zone);
}

export function isRegulatedFloodZone(zone: ParcelFeature["floodZone"]): boolean {
  return FLOOD_CLASSES.find((entry) => entry.zone === zone)?.regulated === true;
}

/** Shoelace area in acres for a closed lon/lat ring (small-extent planar approximation). */
export function sketchFootprintFromRing(ring: ReadonlyArray<readonly [number, number]>): SketchFootprint {
  return { ring, areaAcres: ringAreaAcres(ring) };
}

export function measureRing(ring: ReadonlyArray<readonly [number, number]>): MeasureResult {
  let distance = 0;
  for (let i = 1; i < ring.length; i += 1) {
    distance += haversineMeters(ring[i - 1], ring[i]);
  }
  return { distanceMeters: Math.round(distance), segments: Math.max(0, ring.length - 1) };
}

export function visiblePermits(shell: PlanningWorkbench): readonly PermitFeature[] {
  if (shell.workspace.state.sources.entries[PERMIT_SOURCE_ID]?.metadata?.active === false) return [];
  return Object.values(shell.workspace.state.realtime.features.records)
    .map((record) => record.feature)
    .filter((feature): feature is PermitFeature => feature.sourceId === PERMIT_SOURCE_ID)
    .sort((left, right) => left.id - right.id);
}

export function findPermit(shell: PlanningWorkbench, featureId: number): PermitFeature | undefined {
  return shell.permitSource.getFeature(featureId);
}

export function permitReadiness(shell: PlanningWorkbench): readonly PermitReadinessEntry[] {
  const caps = shell.permitCapabilities();
  return [
    {
      capability: "applyEdits",
      state: caps.applyEdits,
      note: "permit create/update share the protocol-neutral edit session contract",
    },
    {
      capability: "attachments",
      state: caps.attachments,
      note: "site-plan attachments degrade to local-optimistic when the source is read-only",
    },
    {
      capability: "conflicts",
      state: caps.conflicts,
      note: "version field is surfaced when the writable source rejects a stale edit",
    },
  ];
}

export async function submitPermitDraft(shell: PlanningWorkbench, draft: PermitDraft): Promise<PermitSubmitOutcome> {
  const writable = shell.workspace.state.sources.entries[PERMIT_SOURCE_ID]?.metadata?.writable !== false;
  const canonical = canonicalFromDraft(draft);

  // REQ-003: when writes are not licensed, degrade to a local-optimistic update.
  if (!writable) {
    const optimistic = optimisticPermitFromDraft(shell, draft);
    upsertPermit(shell.workspace, optimistic);
    return {
      status: "degraded",
      committedFeatureId: optimistic.id,
      degraded: true,
      message: "Writes are not licensed on this source — applied a local-optimistic permit update.",
    };
  }

  try {
    const session = createEditSession<PermitAttributes>({
      source: shell.permitSource,
      kind: draft.mode === "create" ? "create" : "update",
      feature: canonical,
      metadata: { conflict: { state: "supported", versionField: "version" } },
    });
    const result = await session.submit();
    if (result.status === "succeeded") {
      const committedId = Number(result.committedFeatureId ?? draft.featureId);
      publishPermits(shell.workspace, shell.permitSource.features());
      return {
        status: "applied",
        committedFeatureId: committedId,
        degraded: false,
        message: `Permit ${draft.values.permit_no} ${draft.mode === "create" ? "created" : "updated"}.`,
      };
    }
    return {
      status: "failed",
      degraded: false,
      message: result.failures.map((failure) => failure.description).join("; ") || "Edit was rejected by the source.",
    };
  } catch (error) {
    if (error instanceof HonuaCapabilityNotSupportedError) {
      const optimistic = optimisticPermitFromDraft(shell, draft);
      upsertPermit(shell.workspace, optimistic);
      return {
        status: "degraded",
        committedFeatureId: optimistic.id,
        degraded: true,
        message: "Source does not support edits — applied a local-optimistic permit update.",
      };
    }
    throw error;
  }
}

export function buildPrintManifest(
  shell: PlanningWorkbench,
  options: { readonly sketch?: SketchFootprint; readonly measure?: MeasureResult; readonly now?: string } = {},
): WorkbenchPrintManifest {
  const state = shell.workspace.state;
  const projection = currentProjection(state);
  const query = runWorkbenchQuery(projection, { parcelsActive: isWorkbenchLayerVisible(state, "parcels") });
  const now = options.now ?? new Date().toISOString();
  const visibleLayers = (["parcels", "zoning", "flood", "permits"] as const).filter((layer) =>
    isWorkbenchLayerVisible(state, layer),
  );
  return {
    id: `print-${now.replaceAll(/[:.]/g, "-")}`,
    title: "Maui Planning & Permitting Workbench",
    generatedAt: now,
    extent: projection.extent,
    visibleLayers,
    parcelCount: query.parcels.length,
    permitCount: visiblePermits(shell).length,
    sketch: options.sketch,
    measure: options.measure,
  };
}

export function exportWorkbench(shell: PlanningWorkbench, manifest: WorkbenchPrintManifest): string {
  const doc: HonuaSavedWorkspaceDocument<PermitFeature, WorkbenchSourceMetadata> = createHonuaSavedWorkspaceDocument<
    PermitFeature,
    WorkbenchSourceMetadata
  >({
    project: {
      id: "maui-planning-permitting",
      title: "Maui Planning & Permitting Workbench",
      metadata: { issue: 289 },
    },
    snapshot: shell.workspace.snapshot(),
    savedAt: manifest.generatedAt,
    metadata: { print: manifest },
  });
  return JSON.stringify(doc, null, 2);
}

// ---------------------------------------------------------------------------
// Editable permit Source (OData-style writable layer over an in-memory store).
// ---------------------------------------------------------------------------

export class PermitFixtureSource implements Source<PermitAttributes> {
  public readonly descriptor: SourceDescriptor;
  public readonly capabilities = capabilities(["query", "queryExtent", "queryObjectIds", "applyEdits"]);
  public failNextConflict = false;
  readonly #features = new Map<number, PermitFeature>();
  #nextId = 0;

  public constructor(seed: readonly PermitFeature[]) {
    this.descriptor = {
      id: PERMIT_SOURCE_ID,
      protocol: "odata",
      locator: { url: "https://cloud.honua.io/mock/maui/Permits" },
      capabilities: this.capabilities,
      attribution: "Honua Cloud fixture",
    };
    for (const feature of seed) {
      this.#features.set(feature.id, clonePermit(feature));
      this.#nextId = Math.max(this.#nextId, feature.id + 1);
    }
  }

  public features(): readonly PermitFeature[] {
    return [...this.#features.values()].map(clonePermit);
  }

  public getFeature(id: FeatureId): PermitFeature | undefined {
    const feature = this.#features.get(Number(id));
    return feature ? clonePermit(feature) : undefined;
  }

  public peekNextId(): number {
    return this.#nextId;
  }

  public async query(_request?: Query<PermitAttributes>): Promise<Result<PermitAttributes>> {
    return {
      features: this.features().map((feature) => ({
        attributes: { ...feature.attributes },
        geometry: { ...feature.geometry },
      })),
      exceededTransferLimit: false,
      totalCount: this.#features.size,
    };
  }

  public async queryAll(request?: Query<PermitAttributes>): Promise<Result<PermitAttributes>> {
    return this.query(request);
  }

  public async queryAggregate(
    _request?: Query<PermitAttributes> & { aggregation?: AggregationSpec },
  ): Promise<Result<PermitAttributes>> {
    const counts = new Map<string, number>();
    for (const feature of this.features()) {
      counts.set(feature.attributes.status, (counts.get(feature.attributes.status) ?? 0) + 1);
    }
    const rows = [...counts].map(([status, count]) => ({ status, count }));
    return { features: [], aggregateRows: rows, exceededTransferLimit: false, totalCount: rows.length };
  }

  public async queryExtent(
    _request?: Query<PermitAttributes>,
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

  public async *stream(_request?: Query<PermitAttributes>): AsyncGenerator<Result<PermitAttributes>, void, undefined> {
    yield await this.query();
  }

  public async queryObjectIds(_request?: Query<PermitAttributes>): Promise<readonly FeatureId[]> {
    return [...this.#features.keys()];
  }

  public async applyEdits(envelopeInput: EditEnvelope<PermitAttributes>): Promise<EditResult> {
    const added = (envelopeInput.adds ?? []).map((feature) => this.#addFeature(feature));
    const updated = (envelopeInput.updates ?? []).map((feature) => this.#updateFeature(feature));
    const deleted = (envelopeInput.deletes ?? []).map((id) => this.#deleteFeature(Number(id)));
    return { added, updated, deleted };
  }

  public async queryRelated<R = Record<string, unknown>>(_request: RelatedQuery): Promise<RelatedResult<R>> {
    throw new HonuaCapabilityNotSupportedError("queryRelated", this.descriptor.protocol, this.descriptor.id);
  }

  // Attachment uploads are not licensed on the fixture source; the editing lane
  // demonstrates graceful degradation rather than dropping the request.
  public readonly attachments: AttachmentApi = {
    query: this.#unsupportedAttachment(),
    list: this.#unsupportedAttachment(),
    add: this.#unsupportedAttachment(),
    update: this.#unsupportedAttachment(),
    delete: this.#unsupportedAttachment(),
  };

  #unsupportedAttachment() {
    return (): never => {
      throw new HonuaCapabilityNotSupportedError("attachments", this.descriptor.protocol, this.descriptor.id);
    };
  }

  public protocol() {
    return undefined;
  }

  public adapter() {
    return undefined;
  }

  #addFeature(feature: CanonicalFeature<PermitAttributes>) {
    const id = Number(feature.id ?? this.#nextId);
    this.#nextId = Math.max(this.#nextId, id + 1);
    const attributes: PermitAttributes = {
      ...(feature.attributes as PermitAttributes),
      OBJECTID: id,
      version: 1,
      last_edited_date: WORKBENCH_GENERATED_AT,
    };
    this.#features.set(id, permitFromAttributes(id, attributes, feature.geometry));
    return { id, success: true };
  }

  #updateFeature(feature: CanonicalFeature<PermitAttributes>) {
    if (feature.id === undefined) {
      return { success: false, error: { code: 400, description: "update requires a permit id" } };
    }
    const id = Number(feature.id);
    if (this.failNextConflict) {
      this.failNextConflict = false;
      return {
        id,
        success: false,
        error: { code: 409, description: `version conflict: expected ${String(feature.attributes?.version)}` },
      };
    }
    const existing = this.#features.get(id);
    if (!existing) return { id, success: false, error: { code: 404, description: "permit not found" } };
    const attributes: PermitAttributes = {
      ...existing.attributes,
      ...(feature.attributes as PermitAttributes),
      OBJECTID: id,
      version: existing.attributes.version + 1,
      last_edited_date: WORKBENCH_GENERATED_AT,
    };
    this.#features.set(id, permitFromAttributes(id, attributes, feature.geometry ?? existing.geometry));
    return { id, success: true };
  }

  #deleteFeature(id: number) {
    const existed = this.#features.delete(id);
    return existed
      ? { id, success: true }
      : { id, success: false, error: { code: 404, description: "permit not found" } };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function seedSources(workspace: WorkbenchAppWorkspace): void {
  for (const sourceId of WORKBENCH_SOURCE_IDS) {
    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId,
      status: "ready",
      metadata: INITIAL_SOURCE_METADATA[sourceId],
      updatedAt: Date.parse(WORKBENCH_GENERATED_AT),
    });
  }
}

function publishPermits(workspace: WorkbenchAppWorkspace, permits: readonly PermitFeature[]): void {
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      replace: true,
      receivedAt: Date.parse(WORKBENCH_GENERATED_AT),
      features: permits.map((feature) => realtimePatch(feature)),
    },
  });
}

function upsertPermit(workspace: WorkbenchAppWorkspace, permit: PermitFeature): void {
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: { type: "upsert", receivedAt: Date.now(), feature: realtimePatch(permit) },
  });
}

function realtimePatch(feature: PermitFeature) {
  return {
    id: feature.id,
    sourceId: PERMIT_SOURCE_ID,
    feature,
    version: feature.attributes.version,
    updatedAt: feature.attributes.last_edited_date,
  };
}

function syncWorkbenchExploration(workspace: WorkbenchAppWorkspace, exploration: ExplorationContext): void {
  workspace.dispatch({
    kind: "set-exploration",
    reference: { datasetId: exploration.datasetId, sourceIds: [...exploration.sourceIds] },
    snapshot: exploration.snapshot(),
  });
}

function capabilitiesFor(source: Source<PermitAttributes>): EditWorkflowCapabilitySummary {
  const probe = createEditSession<PermitAttributes>({
    source,
    kind: "update",
    feature: { id: 0, attributes: {} as PermitAttributes, geometry: defaultGeometry() },
    metadata: { conflict: { state: "supported", versionField: "version" } },
  });
  return probe.capabilities();
}

function canonicalFromDraft(draft: PermitDraft): CanonicalFeature<PermitAttributes> {
  const attributes = { ...draft.values };
  if (draft.mode === "create") {
    delete (attributes as Partial<PermitAttributes>).OBJECTID;
    delete (attributes as Partial<PermitAttributes>).last_edited_date;
  }
  return {
    ...(draft.featureId !== undefined ? { id: draft.featureId } : {}),
    attributes,
    geometry: {
      type: "point",
      x: draft.coordinate[0],
      y: draft.coordinate[1],
      spatialReference: SPATIAL_REFERENCE,
    },
  };
}

function optimisticPermitFromDraft(shell: PlanningWorkbench, draft: PermitDraft): PermitFeature {
  const id = draft.featureId ?? shell.permitSource.peekNextId();
  const existing = draft.featureId !== undefined ? shell.permitSource.getFeature(draft.featureId) : undefined;
  const attributes: PermitAttributes = {
    ...draft.values,
    OBJECTID: id,
    version: (existing?.attributes.version ?? 0) + 1,
    last_edited_date: new Date().toISOString(),
  };
  return permitFromAttributes(id, attributes, {
    type: "point",
    x: draft.coordinate[0],
    y: draft.coordinate[1],
    spatialReference: SPATIAL_REFERENCE,
  });
}

function permitFromAttributes(
  id: number,
  attributes: PermitAttributes,
  geometry: Record<string, unknown> | null | undefined,
): PermitFeature {
  const point = isPointGeometry(geometry) ? geometry : defaultGeometry();
  return {
    id,
    sourceId: PERMIT_SOURCE_ID,
    title: `${attributes.permit_no} — ${attributes.parcel_tmk}`,
    attributes: { ...attributes },
    geometry: point,
  };
}

function isPointGeometry(value: Record<string, unknown> | null | undefined): value is PermitFeature["geometry"] {
  return (
    !!value &&
    value.type === "point" &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.spatialReference === "object"
  );
}

function defaultGeometry(): PermitFeature["geometry"] {
  return { type: "point", x: -156.5, y: 20.89, spatialReference: SPATIAL_REFERENCE };
}

function createZoningBuckets(parcels: readonly ParcelFeature[]): WorkbenchZoningBucket[] {
  return ZONING_CLASSES.map((zoning) => {
    const rows = parcels.filter((parcel) => parcel.zoning === zoning.code);
    return {
      code: zoning.code,
      label: zoning.label,
      color: zoning.color,
      count: rows.length,
      targets: rows.map((parcel) => sourceFeatureSelectionTarget(PARCEL_SOURCE_ID, parcel.id)),
      filter: { field: "zoning", operator: "=", value: zoning.code, appliesTo: [PARCEL_SOURCE_ID] },
    };
  });
}

function parcelInExtent(parcel: ParcelFeature, extent: HonuaExtent | undefined): boolean {
  if (!extent) return true;
  const [x, y] = parcel.coordinate;
  return x >= extent.xmin && x <= extent.xmax && y >= extent.ymin && y <= extent.ymax;
}

function matchesClause(parcel: ParcelFeature, clause: FilterClause): boolean {
  if (clause.appliesTo && clause.appliesTo.length > 0 && !clause.appliesTo.includes(parcel.sourceId)) return true;
  const value = (parcel as unknown as Record<string, unknown>)[clause.field];
  switch (clause.operator) {
    case "=":
      return value === clause.value;
    case "!=":
      return value !== clause.value;
    case "in":
      return Array.isArray(clause.value) && clause.value.includes(value);
    case "not-in":
      return Array.isArray(clause.value) && !clause.value.includes(value);
    case ">":
      return typeof value === "number" && typeof clause.value === "number" && value > clause.value;
    case ">=":
      return typeof value === "number" && typeof clause.value === "number" && value >= clause.value;
    case "<":
      return typeof value === "number" && typeof clause.value === "number" && value < clause.value;
    case "<=":
      return typeof value === "number" && typeof clause.value === "number" && value <= clause.value;
    default:
      return true;
  }
}

function layerToSourceId(layerId: WorkbenchLayerId): WorkbenchSourceId {
  switch (layerId) {
    case "parcels":
      return PARCEL_SOURCE_ID;
    case "zoning":
      return ZONING_SOURCE_ID;
    case "flood":
      return FLOOD_SOURCE_ID;
    case "permits":
      return PERMIT_SOURCE_ID;
  }
}

function ringAreaAcres(ring: ReadonlyArray<readonly [number, number]>): number {
  if (ring.length < 3) return 0;
  const metersPerDegLat = 111_320;
  const midLat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const metersPerDegLon = metersPerDegLat * Math.cos((midLat * Math.PI) / 180);
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    area += x1 * metersPerDegLon * (y2 * metersPerDegLat) - x2 * metersPerDegLon * (y1 * metersPerDegLat);
  }
  const squareMeters = Math.abs(area) / 2;
  return Number((squareMeters / 4046.8564224).toFixed(3));
}

function haversineMeters(a: readonly [number, number], b: readonly [number, number]): number {
  const radius = 6_371_000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function clonePermit(feature: PermitFeature): PermitFeature {
  return { ...feature, attributes: { ...feature.attributes }, geometry: { ...feature.geometry } };
}
