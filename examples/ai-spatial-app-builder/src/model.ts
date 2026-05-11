import {
  createHonuaAiMapKit,
  type HonuaAgentAuditEvent,
  type HonuaAgentRuntime,
  type HonuaAgentToolResult,
  type HonuaAgentViewport,
  type HonuaAgentWidgetQueryRequest,
  type HonuaAgentWidgetQueryResult,
} from "@honua/sdk-js/agent-tools";
import {
  createHonuaAppWorkspace,
  createHonuaSavedWorkspaceDocument,
  selectHonuaAppWorkspaceDetailModel,
  selectHonuaAppWorkspaceJobModel,
  selectHonuaAppWorkspaceTableModel,
} from "@honua/sdk-js/app-workspace";
import { createExplorationContext, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import type { ExplorationContext } from "@honua/sdk-js/exploration";
import type { FilterClause } from "@honua/sdk-js/exploration";
import { envelope } from "@honua/sdk-js/honua";
import type { HonuaExtent, JobSnapshot } from "@honua/sdk-js/honua";
import { selectLinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

import { createFixtureAiSpatialAppBuilderDataset } from "./fixtures.js";
import type {
  AiSpatialAppBuilderSession,
  BuilderDataset,
  BuilderDraftSpec,
  BuilderFeature,
  BuilderGeneratedApp,
  BuilderJobOutput,
  BuilderPlan,
  BuilderPlanStep,
  BuilderPromptFixture,
  BuilderSourceMetadata,
  BuilderTurn,
  BuilderViewControllers,
} from "./types.js";

const RESULT_MEDIA_TYPE = "application/vnd.honua.generated-app+json";

interface JobRecord {
  readonly id: string;
  readonly plan: BuilderPlan;
  readonly draft: BuilderDraftSpec;
  step: number;
}

export function createAiSpatialAppBuilderSession(
  dataset: BuilderDataset = createFixtureAiSpatialAppBuilderDataset(),
): AiSpatialAppBuilderSession {
  const workspace = createHonuaAppWorkspace<BuilderFeature, BuilderSourceMetadata, BuilderJobOutput>();
  const exploration = createExplorationContext({
    datasetId: dataset.workspaceId,
    sourceIds: [dataset.resultSourceId],
    preset: "globalLinked",
  });
  const views = {
    map: exploration.connectView({ id: "builder-map", role: "map" }),
    table: exploration.connectView({ id: "builder-table", role: "grid" }),
    chart: exploration.connectView({ id: "builder-chart", role: "chart" }),
    filters: exploration.connectView({ id: "builder-filters", role: "filter" }),
    detail: exploration.connectView({ id: "builder-detail", role: "detail" }),
  };

  let turnCounter = 0;
  let jobCounter = 0;
  let pendingClarification: BuilderPromptFixture | undefined;
  let lastTurn: BuilderTurn | undefined;
  let activeDraft: BuilderDraftSpec | undefined;
  let activePlan: BuilderPlan | undefined;
  let activeJobId: string | undefined;
  let generatedApp: BuilderGeneratedApp | undefined;
  const agentAudit: HonuaAgentAuditEvent[] = [];
  const jobs = new Map<string, JobRecord>();

  workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
  workspace.dispatch({
    kind: "set-layout",
    layout: {
      activeViewId: views.map.id,
      panels: {
        prompt: { order: 0, size: 1 },
        draft: { order: 1, size: 1 },
        map: { order: 2, size: 2 },
        table: { order: 3, size: 2 },
        chart: { order: 4, size: 1 },
      },
    },
  });
  for (const source of dataset.sources) {
    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId: source.id,
      status: source.cache.status === "stale" ? "stale" : "ready",
      metadata: source,
      updatedAt: Date.parse(dataset.generatedAt),
    });
  }
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      cursor: "fixture:empty-builder-results",
      receivedAt: Date.parse(dataset.generatedAt),
      features: [],
    },
  });
  views.table.setVisibleFields(["title", "parcelUse", "floodZone", "builtYear", "distanceMeters"]);
  syncWorkspace(workspace, exploration);
  const aiMapKit = createHonuaAiMapKit({
    runtime: createBuilderAgentRuntime(dataset, views, () => generatedApp),
    providerFormat: "mcp",
    tools: ["inspectMap", "listSources", "listCapabilities", "setFilter", "selectFeature", "runWidgetQuery", "addLayer"],
    policy: {
      actor: "fixture-ai-map-kit",
      allowActions: true,
      allowedSourceIds: [dataset.resultSourceId],
      maxResults: 5,
      now: () => dataset.generatedAt,
      onAudit: (event) => agentAudit.push(event),
    },
    context: { actor: "fixture-ai-map-kit", now: () => dataset.generatedAt, maxPromptChars: 5000 },
  });

  const session: AiSpatialAppBuilderSession = {
    dataset,
    workspace,
    exploration,
    views,
    aiMapKit,
    get agentAudit() {
      return agentAudit;
    },
    get lastTurn() {
      return lastTurn;
    },
    get activeDraft() {
      return activeDraft;
    },
    get activePlan() {
      return activePlan;
    },
    get activeJobId() {
      return activeJobId;
    },
    submitPrompt(prompt: string): BuilderTurn {
      const fixture = resolvePrompt(dataset, prompt);
      turnCounter += 1;
      if (fixture.requiresClarification) {
        pendingClarification = fixture;
        activeDraft = undefined;
        activePlan = undefined;
        lastTurn = {
          id: `turn-${turnCounter}`,
          prompt,
          assistantText: "I need one structured clarification before drafting a deterministic app spec.",
          clarification: fixture.requiresClarification,
        };
        return lastTurn;
      }
      lastTurn = stageDraftTurn(workspace, exploration, fixture, turnCounter, prompt);
      activeDraft = fixture.draft;
      activePlan = undefined;
      syncWorkspace(workspace, exploration);
      return lastTurn;
    },
    answerClarification(choiceId: string): BuilderTurn {
      if (!pendingClarification) throw new Error("No clarification is pending.");
      const choice = pendingClarification.requiresClarification?.choices.find((entry) => entry.id === choiceId);
      if (!choice) throw new Error(`Unknown clarification choice: ${choiceId}`);
      turnCounter += 1;
      const fixture = pendingClarification;
      pendingClarification = undefined;
      lastTurn = stageDraftTurn(workspace, exploration, fixture, turnCounter, `${fixture.prompt} (${choice.label})`);
      activeDraft = fixture.draft;
      activePlan = undefined;
      syncWorkspace(workspace, exploration);
      return lastTurn;
    },
    previewPlan(): BuilderPlan {
      const draft = requireDraft(activeDraft);
      activePlan = buildPlan(dataset, draft);
      return activePlan;
    },
    applyPlan(): string {
      const draft = requireDraft(activeDraft);
      const plan = activePlan ?? buildPlan(dataset, draft);
      activePlan = plan;
      jobCounter += 1;
      const jobId = `ai-builder-${draft.id}-${jobCounter}`;
      jobs.set(jobId, { id: jobId, plan, draft, step: 0 });
      activeJobId = jobId;
      workspace.dispatch({
        kind: "set-job-snapshot",
        jobId,
        type: "ai-spatial-app-builder",
        snapshot: acceptedSnapshot(plan),
      });
      return jobId;
    },
    advanceJob(jobId: string = requireJobId(activeJobId)): JobSnapshot<BuilderJobOutput> {
      const record = requireJob(jobs, jobId);
      record.step += 1;
      if (record.step === 1) {
        const snapshot = runningSnapshot(record.plan);
        workspace.dispatch({ kind: "set-job-snapshot", jobId, type: "ai-spatial-app-builder", snapshot });
        return snapshot;
      }

      const output = materializeGeneratedApp(dataset, record.draft, session.currentProjection());
      generatedApp = output.generatedApp;
      const snapshot = successfulSnapshot(output);
      workspace.dispatch({ kind: "set-job-snapshot", jobId, type: "ai-spatial-app-builder", snapshot });
      workspace.dispatch({
        kind: "set-source-metadata",
        sourceId: dataset.resultSourceId,
        status: "ready",
        metadata: {
          id: dataset.resultSourceId,
          title: output.generatedApp.title,
          fields: ["title", "parcelUse", "floodZone", "builtYear", "distanceMeters", "assessedValue"],
          capabilities: ["materialized-result", "query", "bbox", "linked-view-sync"],
          cache: dataset.sources[0].cache,
          capabilityState: "available",
        },
        updatedAt: Date.parse(dataset.generatedAt) + record.step,
      });
      workspace.dispatch({
        kind: "apply-realtime-event",
        event: {
          type: "snapshot",
          cursor: `job:${jobId}`,
          receivedAt: Date.parse(dataset.generatedAt) + record.step,
          features: output.features.map((feature) => ({ sourceId: dataset.resultSourceId, id: feature.id, feature })),
        },
      });
      syncWorkspace(workspace, exploration);
      return snapshot;
    },
    selectFeature(featureId: string): void {
      views.table.select([sourceFeatureSelectionTarget(dataset.resultSourceId, featureId)], { replace: true });
      syncWorkspace(workspace, exploration);
    },
    setFloodZoneFilter(zone: string | "all"): void {
      if (zone === "all") views.filters.clearFilter("floodZone");
      else views.filters.setFilter("floodZone", { field: "floodZone", operator: "=", value: zone });
      syncWorkspace(workspace, exploration);
    },
    selectChartBucket(zone: string | "all"): void {
      views.chart.setGrouping(["floodZone"]);
      if (zone === "all") views.chart.clearFilter("floodZone");
      else views.chart.setFilter("floodZone", { field: "floodZone", operator: "=", value: zone });
      syncWorkspace(workspace, exploration);
    },
    async runAiMapKitDemo(): Promise<unknown[]> {
      const results: HonuaAgentToolResult[] = [];
      results.push(await aiMapKit.execute({ name: "inspectMap", args: { includeSelection: true } }));
      results.push(
        await aiMapKit.execute({
          name: "runWidgetQuery",
          args: { sourceId: dataset.resultSourceId, kind: "count", limit: 50 },
        }),
      );
      results.push(
        await aiMapKit.execute({
          name: "setFilter",
          args: {
            id: "floodZone",
            clause: { field: "floodZone", operator: "=", value: "X", appliesTo: [dataset.resultSourceId] },
          },
        }),
      );
      results.push(
        await aiMapKit.execute({
          name: "selectFeature",
          args: { sourceId: dataset.resultSourceId, id: "parcel-1006" },
        }),
      );
      results.push(
        await aiMapKit.execute({
          name: "addLayer",
          args: {
            layer: { id: "ai-reviewed-parcels", source: dataset.resultSourceId, type: "circle" },
            dryRun: true,
          },
        }),
      );
      return results;
    },
    currentProjection(): LinkedViewQueryProjection {
      return selectLinkedViewQueryProjection(exploration.state, { sourceId: dataset.resultSourceId });
    },
    visibleFeatures(): BuilderFeature[] {
      const table = selectHonuaAppWorkspaceTableModel(workspace.state, { sourceId: dataset.resultSourceId });
      return applyProjection(
        table.records.map((record) => record.feature),
        session.currentProjection(),
      );
    },
    chartBuckets() {
      const visible = session.visibleFeatures();
      const zones = Array.from(new Set(dataset.features.map((feature) => feature.floodZone))).sort();
      return zones.map((floodZone) => {
        const rows = visible.filter((feature) => feature.floodZone === floodZone);
        return {
          floodZone,
          count: rows.length,
          value: rows.reduce((sum, feature) => sum + feature.assessedValue, 0),
        };
      });
    },
    generatedApp() {
      return generatedApp;
    },
    exportState(): string {
      syncWorkspace(workspace, exploration);
      const document = createHonuaSavedWorkspaceDocument<BuilderFeature, BuilderSourceMetadata, BuilderJobOutput>({
        snapshot: workspace.snapshot(),
        project: {
          id: dataset.workspaceId,
          title: "AI Spatial App Builder and Query Studio",
          description: "Fixture-backed generated app state for issue #74.",
        },
        sources: dataset.sources.map((source) => ({
          id: source.id,
          protocol: "honua-cloud",
          title: source.title,
          capabilities: source.capabilities,
          status: source.cache.status === "stale" ? "stale" : "ready",
          metadata: { cache: source.cache, capabilityState: source.capabilityState },
        })),
        savedQueries: activeDraft
          ? [
              {
                id: activeDraft.id,
                label: activeDraft.title,
                sourceIds: activeDraft.sourceIds,
                filters: exploration.state.filters,
                spatialFilter: exploration.state.spatialFilter,
                page: exploration.state.page,
                visibleFields: exploration.state.visibleFields,
                grouping: exploration.state.grouping,
                aggregation: exploration.state.aggregation,
                createdAt: dataset.generatedAt,
                metadata: { spatialPredicate: activeDraft.spatialPredicate, views: activeDraft.views },
              },
            ]
          : [],
        analysisOutputs: generatedApp
          ? [
              {
                id: generatedApp.id,
                jobId: activeJobId,
                type: RESULT_MEDIA_TYPE,
                label: generatedApp.title,
                sourceId: dataset.resultSourceId,
                layerId: generatedApp.id,
                data: generatedApp,
                createdAt: dataset.generatedAt,
                metadata: { deterministic: true, serializable: true, linkedViewSync: true },
              },
            ]
          : [],
        metadata: {
          capabilityNotes: dataset.capabilityNotes,
          cachePolicy:
            "Metadata/schema/domain/capability discovery is cacheable; mutable spatial result queries are debounced and materialized before reuse.",
        },
      });
      return `${JSON.stringify(document, null, 2)}\n`;
    },
    dispose(): void {
      for (const view of Object.values(views)) view.unbind();
      workspace.dispose();
      exploration.dispose();
    },
  };

  return session;
}

function createBuilderAgentRuntime(
  dataset: BuilderDataset,
  views: BuilderViewControllers,
  generatedApp: () => BuilderGeneratedApp | undefined,
): HonuaAgentRuntime {
  let viewport: HonuaAgentViewport = {
    bbox: extentToBbox(dataset.prompts[0]?.draft.extent),
    crs: "EPSG:4326",
  };
  return {
    id: dataset.workspaceId,
    snapshot: () => ({
      appId: dataset.workspaceId,
      snapshotTimestamp: dataset.generatedAt,
      sourceVersion: `fixture:${dataset.workspaceId}`,
      viewport,
      sources: dataset.sources.map((source) => ({
        id: source.id,
        title: source.title,
        capabilities: source.capabilities.filter((capability): capability is "query" => capability === "query"),
        metadata: { cache: source.cache, capabilityState: source.capabilityState },
      })),
      layers: [
        {
          id: generatedApp()?.id ?? "ai-builder-results",
          sourceId: dataset.resultSourceId,
          title: generatedApp()?.title ?? "AI builder result layer",
          type: "feature",
          visible: true,
        },
      ],
      selection: views.table.state.selection,
      filters: views.filters.state.filters,
      realtime: {
        mode: "fixture",
        snapshotTimestamp: dataset.generatedAt,
        sourceVersion: `fixture:${dataset.workspaceId}`,
      },
    }),
    getViewport: () => viewport,
    setViewport: (next) => {
      viewport = next;
    },
    getSelection: () => views.table.state.selection,
    setFilter: (id, clause) => {
      if (clause) views.filters.setFilter(id, clause);
      else views.filters.clearFilter(id);
    },
    selectFeature: (target, options) => {
      views.table.select([target], { replace: options?.replace ?? true });
      return views.table.state.selection;
    },
    runWidgetQuery: (request) => runBuilderWidgetQuery(dataset, views, request),
  };
}

function extentToBbox(extent: HonuaExtent | undefined): readonly [number, number, number, number] | undefined {
  return extent ? [extent.xmin, extent.ymin, extent.xmax, extent.ymax] : undefined;
}

function runBuilderWidgetQuery(
  dataset: BuilderDataset,
  views: BuilderViewControllers,
  request: HonuaAgentWidgetQueryRequest,
): HonuaAgentWidgetQueryResult {
  const projection = selectLinkedViewQueryProjection(views.table.state, { sourceId: dataset.resultSourceId });
  const rows = applyProjection(dataset.features, projection).slice(0, request.limit ?? 25);
  return {
    sourceId: request.sourceId,
    kind: request.kind,
    data:
      request.kind === "count"
        ? { count: rows.length }
        : rows.map((feature) => ({ id: feature.id, title: feature.title, attributes: feature.attributes })),
    cache: { status: dataset.sources[0]?.cache.status, snapshotTimestamp: dataset.generatedAt },
  };
}

export function buildPlan(dataset: BuilderDataset, draft: BuilderDraftSpec): BuilderPlan {
  const steps: BuilderPlanStep[] = [
    { id: "ground", title: "Ground prompt against cached source metadata", status: "ready" },
    {
      id: "capabilities",
      title: `Validate ${draft.spatialPredicate} capability`,
      status: draft.warnings.length > 0 ? "degraded" : "ready",
    },
    { id: "materialize", title: "Apply deterministic spec and materialize linked app artifact", status: "ready" },
  ];
  if (dataset.capabilityNotes.some((note) => note.state === "unsupported")) {
    steps.push({ id: "exclude-live", title: "Exclude unsupported live layers from generated app", status: "blocked" });
  }
  return {
    id: `plan-${draft.id}`,
    draftId: draft.id,
    steps,
    warnings: draft.warnings,
    cacheNotes: draft.cacheNotes,
    estimatedCost: draft.estimatedCost,
    estimatedDuration: draft.estimatedDuration,
  };
}

export function applyProjection(
  features: readonly BuilderFeature[],
  projection: LinkedViewQueryProjection,
): BuilderFeature[] {
  const selected = new Set(
    projection.selection.map((target) => (typeof target === "object" ? String(target.id) : String(target))),
  );
  return features
    .filter((feature) => pointInExtent(feature, projection.spatialFilter?.geometry ?? projection.extent))
    .filter((feature) => Object.values(projection.filters).every((filter) => matchesFilter(feature, filter)))
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.id.localeCompare(b.id));
}

function stageDraftTurn(
  workspace: ReturnType<typeof createHonuaAppWorkspace<BuilderFeature, BuilderSourceMetadata, BuilderJobOutput>>,
  exploration: ExplorationContext,
  fixture: BuilderPromptFixture,
  turnIndex: number,
  prompt: string,
): BuilderTurn {
  const snapshot = snapshotForDraft(fixture.draft);
  workspace.dispatch({
    kind: "stage-draft",
    activate: true,
    draft: {
      id: fixture.draft.id,
      source: "ai",
      label: fixture.draft.title,
      description: `${fixture.draft.spatialPredicate} over ${fixture.draft.sourceIds.join(", ")}`,
      createdAt: Date.parse("2026-05-05T18:30:00.000Z") + turnIndex,
      proposedIntent: { kind: "restore-exploration-snapshot", snapshot },
      metadata: {
        spec: fixture.draft,
        deterministic: true,
        serializable: true,
        cacheNotes: fixture.draft.cacheNotes,
        warnings: fixture.draft.warnings,
      },
    },
  });
  exploration.restore(snapshot);
  return {
    id: `turn-${turnIndex}`,
    prompt,
    assistantText: "Review the deterministic query/spec draft before previewing the plan.",
    draft: fixture.draft,
  };
}

function snapshotForDraft(draft: BuilderDraftSpec) {
  return {
    version: 1 as const,
    state: {
      preset: "globalLinked" as const,
      extent: draft.extent,
      spatialFilter: envelopeFromExtent(draft.extent),
      filters: draft.filters,
      sort: [],
      page: { offset: 0, limit: 25 },
      visibleFields: ["title", "parcelUse", "floodZone", "builtYear", "distanceMeters"],
      grouping: draft.grouping,
      aggregation: draft.aggregation,
      selection: [],
    },
  };
}

function materializeGeneratedApp(
  dataset: BuilderDataset,
  draft: BuilderDraftSpec,
  projection: LinkedViewQueryProjection,
): BuilderJobOutput {
  const features = applyProjection(dataset.features, projection);
  const generatedApp: BuilderGeneratedApp = {
    id: `generated-${draft.id}`,
    draftId: draft.id,
    title: draft.title,
    viewIds: {
      map: "builder-map",
      table: "builder-table",
      chart: "builder-chart",
      filter: "builder-filters",
      detail: "builder-detail",
    },
    query: projection,
    featureIds: features.map((feature) => feature.id),
    warnings: draft.warnings,
  };
  return { planId: `plan-${draft.id}`, generatedApp, features, warnings: draft.warnings };
}

function resolvePrompt(dataset: BuilderDataset, prompt: string): BuilderPromptFixture {
  const normalized = prompt.toLowerCase();
  return (
    dataset.prompts.find((fixture) =>
      [fixture.prompt, fixture.intent, fixture.id].some((value) =>
        normalized.includes(value.toLowerCase().slice(0, 16)),
      ),
    ) ??
    dataset.prompts.find((fixture) => normalized.includes("join") && fixture.id === "spatial-join") ??
    dataset.prompts.find((fixture) => normalized.includes("chart") && fixture.id === "grouped-chart") ??
    dataset.prompts.find((fixture) => normalized.includes("downtown") && fixture.id === "bbox-filter") ??
    dataset.prompts.find((fixture) => normalized.includes("commercial") && fixture.id === "station-distance") ??
    dataset.prompts[0]
  );
}

function syncWorkspace(
  workspace: ReturnType<typeof createHonuaAppWorkspace<BuilderFeature, BuilderSourceMetadata, BuilderJobOutput>>,
  exploration: ExplorationContext,
): void {
  workspace.dispatch({
    kind: "set-exploration",
    reference: { datasetId: exploration.datasetId, sourceIds: exploration.sourceIds },
    snapshot: exploration.snapshot(),
  });
}

function acceptedSnapshot(plan: BuilderPlan): JobSnapshot<BuilderJobOutput> {
  return {
    status: "accepted",
    progress: { percent: 5, message: `Queued ${plan.id}` },
  };
}

function runningSnapshot(plan: BuilderPlan): JobSnapshot<BuilderJobOutput> {
  return {
    status: "running",
    progress: { percent: 58, message: `Applying ${plan.steps.length} deterministic plan step(s)` },
  };
}

function successfulSnapshot(output: BuilderJobOutput): JobSnapshot<BuilderJobOutput> {
  return {
    status: "successful",
    progress: { percent: 100, message: `Generated linked app with ${output.features.length} feature(s)` },
    result: { outputs: { [output.generatedApp.id]: output } },
  };
}

function matchesFilter(feature: BuilderFeature, filter: FilterClause): boolean {
  const value = feature.attributes[filter.field] ?? feature[filter.field as keyof BuilderFeature];
  if (filter.operator === "=") return value === filter.value;
  if (filter.operator === "<") return Number(value) < Number(filter.value);
  if (filter.operator === "<=") return Number(value) <= Number(filter.value);
  if (filter.operator === ">") return Number(value) > Number(filter.value);
  if (filter.operator === ">=") return Number(value) >= Number(filter.value);
  if (filter.operator === "in") return Array.isArray(filter.value) && filter.value.includes(value);
  return true;
}

function pointInExtent(feature: BuilderFeature, extentLike: unknown): boolean {
  if (!extentLike || typeof extentLike !== "object") return true;
  const extent = extentLike as Partial<HonuaExtent>;
  if (
    typeof extent.xmin !== "number" ||
    typeof extent.ymin !== "number" ||
    typeof extent.xmax !== "number" ||
    typeof extent.ymax !== "number"
  ) {
    return true;
  }
  return feature.x >= extent.xmin && feature.x <= extent.xmax && feature.y >= extent.ymin && feature.y <= extent.ymax;
}

function envelopeFromExtent(extent: HonuaExtent) {
  return envelope(extent.xmin, extent.ymin, extent.xmax, extent.ymax, extent.spatialReference);
}

function requireDraft(draft: BuilderDraftSpec | undefined): BuilderDraftSpec {
  if (!draft) throw new Error("No active draft. Submit a prompt and resolve clarifications first.");
  return draft;
}

function requireJobId(jobId: string | undefined): string {
  if (!jobId) throw new Error("No active job.");
  return jobId;
}

function requireJob(jobs: ReadonlyMap<string, JobRecord>, jobId: string): JobRecord {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown builder job: ${jobId}`);
  return job;
}

export function selectAiSpatialBuilderUiModels(session: AiSpatialAppBuilderSession) {
  return {
    table: selectHonuaAppWorkspaceTableModel(session.workspace.state, { sourceId: session.dataset.resultSourceId }),
    detail: selectHonuaAppWorkspaceDetailModel(session.workspace.state),
    jobs: selectHonuaAppWorkspaceJobModel(session.workspace.state),
  };
}
