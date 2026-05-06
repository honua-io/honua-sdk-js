import {
  createHonuaAppWorkspace,
  createHonuaSavedWorkspaceDocument,
  selectHonuaAppWorkspaceChartModel,
  selectHonuaAppWorkspaceDetailModel,
  selectHonuaAppWorkspaceJobModel,
  selectHonuaAppWorkspaceMapModel,
  selectHonuaAppWorkspaceMetadataCacheModel,
  selectHonuaAppWorkspaceTableModel,
} from "@honua/sdk-js/app-workspace";
import {
  assertValidSpatialAggregationRequest,
  isSpatialAggregationComplete,
  spatialAggregationProgress,
  spatialAggregationWidgets,
} from "@honua/sdk-js/contract";
import type {
  SpatialAggregationCell,
  SpatialAggregationRequest,
  SpatialAggregationResult,
  SpatialAggregationSummaryValue,
  SpatialAggregationWidgetMetadata,
} from "@honua/sdk-js/contract";
import { createExplorationContext, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import type { FilterClause } from "@honua/sdk-js/exploration";
import { createHonuaCacheState, envelope } from "@honua/sdk-js/honua";
import type { HonuaExtent, JobSnapshot } from "@honua/sdk-js/honua";
import { selectLinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

import { ANALYTICS_INDEXED_AGGREGATION_FIXTURE, createFixtureSpatialAnalyticsDataset } from "./fixtures.js";
import type {
  AnalyticsAggregationReport,
  AnalyticsAoi,
  AnalyticsDataset,
  AnalyticsFeature,
  AnalyticsJobOutput,
  AnalyticsMetric,
  AnalyticsPlan,
  AnalyticsPlanId,
  AnalyticsReport,
  AnalyticsResultLayer,
  AnalyticsRisk,
  AnalyticsSourceMetadata,
  HonuaCloudAnalysisRequest,
  SpatialAnalyticsWorkbenchSession,
} from "./types.js";

const REPORT_SCHEMA_VERSION = "honua.spatial-analytics-workbench-report.v1";
const RESULT_LAYER_MEDIA_TYPE = "application/geo+json";
const RISK_ORDER: readonly AnalyticsRisk[] = ["critical", "high", "moderate", "low"];

interface JobRecord {
  readonly id: string;
  readonly planId: AnalyticsPlanId;
  readonly aoiId: string;
  step: number;
}

interface SavedWorkspaceSourceProjection {
  readonly id: string;
  readonly protocol: string;
  readonly title: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly status: "ready" | "stale";
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function createSpatialAnalyticsWorkbenchSession(
  dataset: AnalyticsDataset = createFixtureSpatialAnalyticsDataset(),
): SpatialAnalyticsWorkbenchSession {
  const workspace = createHonuaAppWorkspace<AnalyticsFeature, AnalyticsSourceMetadata, AnalyticsJobOutput>();
  const exploration = createExplorationContext({
    datasetId: dataset.workspaceId,
    sourceIds: [dataset.resultSourceId],
    preset: "globalLinked",
  });
  const views = {
    map: exploration.connectView({ id: "workbench-map", role: "map" }),
    table: exploration.connectView({ id: "workbench-table", role: "grid" }),
    chart: exploration.connectView({ id: "workbench-chart", role: "chart" }),
    filters: exploration.connectView({ id: "workbench-filters", role: "filter" }),
    detail: exploration.connectView({ id: "workbench-detail", role: "detail" }),
  };

  let activeAoiId = dataset.aois[0]?.id ?? "";
  let activePlanId = dataset.plans[0]?.id ?? "buffer-overlay";
  let activeJobId: string | undefined;
  let jobCounter = 0;
  const jobs = new Map<string, JobRecord>();
  let latestOutput: AnalyticsJobOutput | undefined;

  workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
  workspace.dispatch({
    kind: "set-layout",
    layout: {
      activeViewId: views.map.id,
      panels: {
        map: { order: 1, size: 2 },
        table: { order: 2, size: 2 },
        chart: { order: 3, size: 1 },
        filters: { order: 0, size: 1 },
      },
    },
  });
  registerMetadata(dataset, workspace);
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: { type: "status", status: "live", receivedAt: Date.parse(dataset.generatedAt) },
  });
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: { type: "snapshot", receivedAt: Date.parse(dataset.generatedAt), features: [] },
  });

  const initialAoi = requireAoi(dataset, activeAoiId);
  views.map.setExtent(initialAoi.extent);
  views.map.setSpatialFilter(envelopeFromExtent(initialAoi.extent));
  views.table.setVisibleFields(["title", "risk", "category", "zone", "score", "distanceMeters"]);
  views.chart.setGrouping(["risk"]);
  views.chart.setAggregation({ groupBy: ["risk"], metrics: [{ fn: "avg", field: "score", alias: "averageScore" }] });
  syncWorkspaceExploration(dataset, workspace, exploration);

  const session: SpatialAnalyticsWorkbenchSession = {
    dataset,
    workspace,
    exploration,
    views,
    get activeAoi() {
      return requireAoi(dataset, activeAoiId);
    },
    get activePlan() {
      return requirePlan(dataset, activePlanId);
    },
    get activeJobId() {
      return activeJobId;
    },
    selectAoi(aoiId: string): void {
      const aoi = requireAoi(dataset, aoiId);
      activeAoiId = aoi.id;
      views.map.setExtent(aoi.extent);
      views.map.setSpatialFilter(envelopeFromExtent(aoi.extent));
      syncWorkspaceExploration(dataset, workspace, exploration);
    },
    selectPlan(planId: AnalyticsPlanId): void {
      activePlanId = requirePlan(dataset, planId).id;
    },
    setRiskFilter(risk: AnalyticsRisk | "all"): void {
      if (risk === "all") {
        views.filters.clearFilter("risk");
      } else {
        views.filters.setFilter("risk", { field: "risk", operator: "=", value: risk });
      }
      syncWorkspaceExploration(dataset, workspace, exploration);
    },
    selectFeature(featureId: string): void {
      views.table.select([sourceFeatureSelectionTarget(dataset.resultSourceId, featureId)], { replace: true });
      syncWorkspaceExploration(dataset, workspace, exploration);
    },
    selectChartBucket(risk: AnalyticsRisk | "all"): void {
      views.chart.setGrouping(["risk"]);
      views.chart.setAggregation({
        groupBy: ["risk"],
        metrics: [{ fn: "avg", field: "score", alias: "averageScore" }],
      });
      if (risk === "all") {
        views.chart.clearFilter("risk");
      } else {
        views.chart.setFilter("risk", { field: "risk", operator: "=", value: risk });
      }
      syncWorkspaceExploration(dataset, workspace, exploration);
    },
    currentProjection(): LinkedViewQueryProjection {
      return selectLinkedViewQueryProjection(exploration.state, { sourceId: dataset.resultSourceId });
    },
    buildRequest(): HonuaCloudAnalysisRequest {
      return buildHonuaCloudAnalysisRequest(
        dataset,
        requirePlan(dataset, activePlanId),
        requireAoi(dataset, activeAoiId),
        this.currentProjection(),
      );
    },
    startAnalysis(): string {
      const plan = requirePlan(dataset, activePlanId);
      const aoi = requireAoi(dataset, activeAoiId);
      jobCounter += 1;
      const jobId = `analytics-${plan.id}-${jobCounter}`;
      jobs.set(jobId, { id: jobId, planId: plan.id, aoiId: aoi.id, step: 0 });
      activeJobId = jobId;
      workspace.dispatch({
        kind: "set-job-snapshot",
        jobId,
        type: plan.processIds.join("+"),
        snapshot: acceptedSnapshot(plan, aoi),
      });
      return jobId;
    },
    advanceJob(jobId: string = requireActiveJobId(activeJobId)): JobSnapshot<AnalyticsJobOutput> {
      const record = requireJob(jobs, jobId);
      const plan = requirePlan(dataset, record.planId);
      const aoi = requireAoi(dataset, record.aoiId);
      record.step += 1;

      if (record.step === 1) {
        const snapshot = runningSnapshot(plan, aoi);
        workspace.dispatch({ kind: "set-job-snapshot", jobId, type: plan.processIds.join("+"), snapshot });
        return snapshot;
      }

      if (plan.fixtureMode === "missing-platform-capability") {
        const snapshot = failedCapabilitySnapshot(plan);
        workspace.dispatch({ kind: "set-job-snapshot", jobId, type: plan.processIds.join("+"), snapshot });
        return snapshot;
      }

      latestOutput =
        plan.fixtureMode === "fixture-indexed-aggregation"
          ? materializeAggregationOutput(dataset, plan, aoi, session.currentProjection(), jobId)
          : materializeOutput(dataset, plan, aoi, session.currentProjection(), jobId);
      const snapshot = successfulSnapshot(latestOutput);
      workspace.dispatch({ kind: "set-job-snapshot", jobId, type: plan.processIds.join("+"), snapshot });
      publishOutput(dataset, workspace, latestOutput, jobId, record.step);
      return snapshot;
    },
    retryJob(jobId: string = requireActiveJobId(activeJobId)): string {
      const record = requireJob(jobs, jobId);
      activePlanId = record.planId;
      activeAoiId = record.aoiId;
      return this.startAnalysis();
    },
    visibleFeatures(): AnalyticsFeature[] {
      const tableModel = selectHonuaAppWorkspaceTableModel(workspace.state, { sourceId: dataset.resultSourceId });
      const records = tableModel.records.map((record) => record.feature);
      return applyProjection(records, session.currentProjection());
    },
    chartBuckets(): ReadonlyArray<{ readonly risk: AnalyticsRisk; readonly count: number; readonly score: number }> {
      const aggregation = this.latestAggregation();
      if (aggregation) return aggregationSeverityBuckets(aggregation);

      const visible = this.visibleFeatures();
      return RISK_ORDER.map((risk) => {
        const rows = visible.filter((feature) => feature.risk === risk);
        return {
          risk,
          count: rows.length,
          score: rows.length === 0 ? 0 : Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length),
        };
      });
    },
    aggregationCells(): readonly SpatialAggregationCell[] {
      return latestOutput?.aggregation?.cells ?? [];
    },
    aggregationWidgets(): readonly SpatialAggregationWidgetMetadata[] {
      const aggregation = this.latestAggregation();
      return aggregation ? spatialAggregationWidgets(aggregation) : [];
    },
    latestAggregation(): SpatialAggregationResult | undefined {
      return latestOutput?.aggregation;
    },
    latestOutput(): AnalyticsJobOutput | undefined {
      return latestOutput;
    },
    createReport(): AnalyticsReport {
      return createAnalyticsReport(
        dataset,
        requirePlan(dataset, activePlanId),
        requireAoi(dataset, activeAoiId),
        this.currentProjection(),
        latestOutput,
      );
    },
    exportWorkspace(): string {
      syncWorkspaceExploration(dataset, workspace, exploration);
      const output = latestOutput;
      const document = createHonuaSavedWorkspaceDocument<AnalyticsFeature, AnalyticsSourceMetadata, AnalyticsJobOutput>(
        {
          snapshot: workspace.snapshot(),
          project: {
            id: dataset.workspaceId,
            title: "Cloud Spatial Analytics Workbench",
            description: "Fixture-backed Honua Cloud analytics workspace",
          },
          sources: sourceDocuments(dataset, output?.resultLayer),
          layers: output
            ? [
                {
                  id: output.resultLayer.id,
                  sourceId: dataset.resultSourceId,
                  title: output.resultLayer.title,
                  visible: true,
                  metadata: { mediaType: RESULT_LAYER_MEDIA_TYPE, lineage: output.resultLayer.lineage },
                },
              ]
            : [],
          savedQueries: [
            {
              id: "active-analysis-query",
              label: requirePlan(dataset, activePlanId).title,
              sourceIds: [dataset.resultSourceId],
              filters: exploration.state.filters,
              spatialFilter: exploration.state.spatialFilter,
              page: exploration.state.page,
              visibleFields: exploration.state.visibleFields,
              grouping: exploration.state.grouping,
              aggregation: exploration.state.aggregation,
              createdAt: dataset.generatedAt,
              metadata: { aoiId: activeAoiId, planId: activePlanId },
            },
          ],
          analysisOutputs: output
            ? [
                {
                  id: output.resultLayer.id,
                  jobId: activeJobId,
                  type: RESULT_LAYER_MEDIA_TYPE,
                  label: output.resultLayer.title,
                  sourceId: dataset.resultSourceId,
                  layerId: output.resultLayer.id,
                  href: output.resultLayer.href,
                  createdAt: dataset.generatedAt,
                  data: { metrics: output.metrics, featureCount: output.features.length },
                  metadata: { materialized: output.resultLayer.materialized, cache: output.resultLayer.cache },
                },
              ]
            : [],
          metadata: {
            capabilityGaps: dataset.capabilityGaps,
            cachePolicy:
              "Layer metadata and process descriptions are cacheable; arbitrary AOI results are reusable only after materialization.",
          },
        },
      );
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

export function buildHonuaCloudAnalysisRequest(
  dataset: AnalyticsDataset,
  plan: AnalyticsPlan,
  aoi: AnalyticsAoi,
  projection: LinkedViewQueryProjection,
): HonuaCloudAnalysisRequest {
  const operations = plan.processIds.map((processId) => {
    const process = dataset.processes.find((entry) => entry.id === processId);
    return process?.operation ?? processId;
  });
  return {
    processId: plan.processIds.join("+"),
    mode: "async",
    response: "document",
    inputs: {
      aoi: {
        id: aoi.id,
        bbox: [aoi.extent.xmin, aoi.extent.ymin, aoi.extent.xmax, aoi.extent.ymax],
        spatialReference: aoi.extent.spatialReference,
      },
      layers: plan.layerIds,
      operations,
      filters: projection.filters,
      grouping: projection.grouping,
      aggregation: projection.aggregation,
      indexedAggregation:
        plan.fixtureMode === "fixture-indexed-aggregation" ? buildIndexedAggregationRequest(aoi) : undefined,
      materialize: plan.materializes,
    },
    metadata: {
      estimatedCost: plan.estimatedCost,
      estimatedDuration: plan.estimatedDuration,
      cachePolicy: plan.materializes ? "materialized-result" : "metadata-only",
    },
  };
}

export function applyProjection(
  features: readonly AnalyticsFeature[],
  projection: LinkedViewQueryProjection,
): AnalyticsFeature[] {
  const rows = features.filter((feature) => {
    if (!pointInExtent(feature, projection.spatialFilter?.geometry ?? projection.extent)) return false;
    return Object.values(projection.filters).every((filter) => matchesFilter(feature, filter));
  });
  const selectedIds = new Set(
    projection.selection.map((target) => (typeof target === "object" ? String(target.id) : String(target))),
  );
  if (selectedIds.size > 0) {
    return rows.sort((a, b) => Number(selectedIds.has(b.id)) - Number(selectedIds.has(a.id)) || b.score - a.score);
  }
  return rows.sort((a, b) => b.score - a.score);
}

export function selectAnalyticsUiModels(session: SpatialAnalyticsWorkbenchSession) {
  return {
    map: selectHonuaAppWorkspaceMapModel(session.workspace.state, { sourceId: session.dataset.resultSourceId }),
    table: selectHonuaAppWorkspaceTableModel(session.workspace.state, { sourceId: session.dataset.resultSourceId }),
    chart: selectHonuaAppWorkspaceChartModel(session.workspace.state, { sourceId: session.dataset.resultSourceId }),
    detail: selectHonuaAppWorkspaceDetailModel(session.workspace.state),
    jobs: selectHonuaAppWorkspaceJobModel(session.workspace.state),
    cache: selectHonuaAppWorkspaceMetadataCacheModel(session.workspace.state),
  };
}

function registerMetadata(
  dataset: AnalyticsDataset,
  workspace: ReturnType<typeof createHonuaAppWorkspace<AnalyticsFeature, AnalyticsSourceMetadata, AnalyticsJobOutput>>,
): void {
  for (const layer of dataset.layers) {
    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId: layer.id,
      status: layer.cache.status === "stale" ? "stale" : "ready",
      metadata: {
        id: layer.id,
        title: layer.title,
        type: "layer",
        cache: layer.cache,
        capabilities: layer.capabilities,
      },
      updatedAt: Date.parse(dataset.generatedAt),
    });
  }
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: "honua-cloud:process-catalog",
    status: "ready",
    metadata: {
      id: "honua-cloud:process-catalog",
      title: "Honua Cloud OGC Processes catalog",
      type: "process-catalog",
      cache:
        dataset.processes[0]?.cache ??
        createHonuaCacheState({ scope: "metadata", status: "miss", keyFingerprint: "process-catalog" }),
      capabilities: dataset.processes.map((process) => process.operation),
    },
    updatedAt: Date.parse(dataset.generatedAt),
  });
}

function sourceDocuments(
  dataset: AnalyticsDataset,
  resultLayer: AnalyticsResultLayer | undefined,
): SavedWorkspaceSourceProjection[] {
  const sources: SavedWorkspaceSourceProjection[] = dataset.layers.map((layer) => ({
    id: layer.id,
    protocol: "honua-cloud",
    title: layer.title,
    capabilities: layer.capabilities,
    status: layer.cache.status === "stale" ? ("stale" as const) : ("ready" as const),
    metadata: { cache: layer.cache, rendererHint: layer.rendererHint, featureCount: layer.featureCount },
  }));
  if (resultLayer) {
    sources.push({
      id: dataset.resultSourceId,
      protocol: "honua-cloud",
      title: resultLayer.title,
      capabilities: ["materialized-result", "bbox", "query", "download"],
      status: "ready",
      metadata: { cache: resultLayer.cache, lineage: resultLayer.lineage },
    });
  }
  return sources;
}

function acceptedSnapshot(plan: AnalyticsPlan, aoi: AnalyticsAoi): JobSnapshot<AnalyticsJobOutput> {
  return {
    status: "accepted",
    progress: {
      percent: 5,
      message: `Queued ${plan.title} for ${aoi.title}`,
    },
  };
}

function runningSnapshot(plan: AnalyticsPlan, aoi: AnalyticsAoi): JobSnapshot<AnalyticsJobOutput> {
  return {
    status: "running",
    progress: {
      percent: plan.fixtureMode === "missing-platform-capability" ? 35 : 64,
      message:
        plan.fixtureMode === "missing-platform-capability"
          ? "Checking indexed aggregation capability"
          : `Overlaying ${plan.layerIds.length} layer(s) inside ${aoi.title}`,
    },
  };
}

function failedCapabilitySnapshot(plan: AnalyticsPlan): JobSnapshot<AnalyticsJobOutput> {
  return {
    status: "failed",
    progress: {
      percent: 35,
      message: "Stopped before expensive execution because the server does not advertise indexed analytics.",
    },
    error: {
      code: "HonuaCapabilityNotSupported",
      message: `${plan.title} requires #66 large-scale spatial aggregation and indexed analytics contracts.`,
      details: {
        requiredCapabilities: plan.requiresCapabilities,
        ticket: "#66",
      },
    },
  };
}

function successfulSnapshot(output: AnalyticsJobOutput): JobSnapshot<AnalyticsJobOutput> {
  const aggregation = output.aggregation;
  return {
    status: "successful",
    progress: {
      percent: 100,
      message: aggregation
        ? `Loaded ${aggregation.cells.length} indexed cell(s); ${aggregation.page?.totalCellCount ?? aggregation.index.cellCount ?? aggregation.cells.length} available through paging`
        : `Materialized ${output.features.length} result feature(s)`,
    },
    result: {
      outputs: {
        [output.resultLayer.id]: output,
      },
    },
  };
}

function publishOutput(
  dataset: AnalyticsDataset,
  workspace: ReturnType<typeof createHonuaAppWorkspace<AnalyticsFeature, AnalyticsSourceMetadata, AnalyticsJobOutput>>,
  output: AnalyticsJobOutput,
  jobId: string,
  step: number,
): void {
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: dataset.resultSourceId,
    status: "ready",
    metadata: resultSourceMetadata(dataset, output.resultLayer, output.aggregation),
    updatedAt: Date.parse(dataset.generatedAt),
  });
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      eventId: `${jobId}:materialized`,
      cursor: `job:${jobId}`,
      receivedAt: Date.parse(dataset.generatedAt) + step,
      features: output.features.map((feature) => ({
        id: feature.id,
        sourceId: dataset.resultSourceId,
        feature,
      })),
    },
  });
}

function materializeOutput(
  dataset: AnalyticsDataset,
  plan: AnalyticsPlan,
  aoi: AnalyticsAoi,
  projection: LinkedViewQueryProjection,
  jobId: string,
): AnalyticsJobOutput {
  const features = dataset.features.filter((feature) => feature.aoiIds.includes(aoi.id));
  const filteredFeatures = applyProjection(features, {
    ...projection,
    filters: withoutSelectionOnlyFilters(projection.filters),
    selection: [],
  });
  const resultLayer: AnalyticsResultLayer = {
    id: `materialized-${jobId}`,
    title: `${aoi.title} analysis output`,
    sourceId: dataset.resultSourceId,
    featureIds: filteredFeatures.map((feature) => feature.id),
    materialized: true,
    href: `/workspaces/${dataset.workspaceId}/analysis/${jobId}.geojson`,
    cache: createHonuaCacheState({
      scope: "materialized-result",
      status: "refreshed",
      keyFingerprint: `job:${jobId}:aoi:${aoi.id}`,
      revalidatedAt: dataset.generatedAt,
      sourceUpdatedAt: dataset.generatedAt,
    }),
    lineage: [aoi.id, ...plan.layerIds, ...plan.processIds],
  };
  const metrics = metricsForFeatures(filteredFeatures);
  const report = createAnalyticsReport(dataset, plan, aoi, projection, {
    metrics,
    resultLayer,
  });
  return {
    planId: plan.id,
    aoiId: aoi.id,
    resultLayer,
    metrics,
    features: filteredFeatures,
    warnings: [
      "Layer metadata and process descriptions may be cached.",
      "AOI-specific analysis results are not reused unless the job output is explicitly materialized.",
    ],
    report,
  };
}

function materializeAggregationOutput(
  dataset: AnalyticsDataset,
  plan: AnalyticsPlan,
  aoi: AnalyticsAoi,
  projection: LinkedViewQueryProjection,
  jobId: string,
): AnalyticsJobOutput {
  const request = buildIndexedAggregationRequest(aoi, projection);
  assertValidSpatialAggregationRequest(request);
  const fixture = ANALYTICS_INDEXED_AGGREGATION_FIXTURE.response;
  const aggregation: SpatialAggregationResult = {
    ...fixture,
    requestId: request.requestId,
    generatedAt: dataset.generatedAt,
    index: {
      ...fixture.index,
      extent: aoi.extent,
      requestedResolution: request.resolution,
    },
    metadata: {
      ...fixture.metadata,
      sourceId: request.sourceId,
    },
  };
  const resultLayer: AnalyticsResultLayer = {
    id: `aggregation-${jobId}`,
    title: `${aoi.title} indexed aggregation`,
    sourceId: aggregation.sourceId,
    featureIds: [],
    materialized: false,
    href: `/workspaces/${dataset.workspaceId}/aggregation/${jobId}.json`,
    cache: createHonuaCacheState({
      scope: "metadata",
      status: "stale",
      keyFingerprint: `aggregation:${aggregation.requestId}:aoi:${aoi.id}`,
      revalidatedAt: dataset.generatedAt,
      invalidationReason: "fixture result is viewport-specific and not cached as a reusable feature result",
    }),
    lineage: [aoi.id, ...plan.layerIds, ...plan.processIds, aggregation.index.model.id],
  };
  const metrics = metricsForAggregation(aggregation);
  const report = createAnalyticsReport(dataset, plan, aoi, projection, {
    metrics,
    resultLayer,
    aggregation,
  });
  return {
    planId: plan.id,
    aoiId: aoi.id,
    resultLayer,
    metrics,
    features: [],
    aggregation,
    warnings: [
      "Aggregation metadata and widget definitions are cacheable.",
      "Viewport-specific indexed cells are treated as ad hoc spatial results and are not reused as metadata.",
      `Progressive status is ${spatialAggregationProgress(aggregation).status}; complete=${isSpatialAggregationComplete(aggregation)}`,
    ],
    report,
  };
}

function createAnalyticsReport(
  dataset: AnalyticsDataset,
  plan: AnalyticsPlan,
  aoi: AnalyticsAoi,
  projection: LinkedViewQueryProjection,
  output: Pick<AnalyticsJobOutput, "metrics" | "resultLayer" | "aggregation"> | undefined,
): AnalyticsReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: dataset.generatedAt,
    reportId: `report-${plan.id}-${aoi.id}`,
    planId: plan.id,
    aoiId: aoi.id,
    query: projection,
    metrics:
      output?.metrics ?? metricsForFeatures(dataset.features.filter((feature) => feature.aoiIds.includes(aoi.id))),
    resultLayer: output?.resultLayer,
    aggregation: output?.aggregation ? aggregationReport(output.aggregation) : undefined,
    warnings: [
      "Metadata cache entries are reusable across AOIs.",
      "Spatial analysis result reuse requires a materialized job artifact.",
      ...dataset.capabilityGaps.map((gap) => `${gap.ticket}: ${gap.title}`),
    ],
  };
}

function buildIndexedAggregationRequest(
  aoi: AnalyticsAoi,
  projection?: LinkedViewQueryProjection,
): SpatialAggregationRequest {
  const fixtureRequest = ANALYTICS_INDEXED_AGGREGATION_FIXTURE.request;
  return {
    ...fixtureRequest,
    requestId: `agg-${aoi.id}-viewport`,
    spatialFilter: projection?.spatialFilter ?? envelopeFromExtent(aoi.extent),
    viewport: {
      ...fixtureRequest.viewport,
      extent: aoi.extent,
    },
    metadata: {
      ...fixtureRequest.metadata,
      aoiId: aoi.id,
      filters: projection?.filters ?? {},
    },
  };
}

function metricsForFeatures(features: readonly AnalyticsFeature[]): readonly AnalyticsMetric[] {
  const critical = features.filter((feature) => feature.risk === "critical").length;
  const high = features.filter((feature) => feature.risk === "high").length;
  const incidents = features.reduce((sum, feature) => sum + feature.incidentCount, 0);
  const avgScore =
    features.length === 0 ? 0 : Math.round(features.reduce((sum, feature) => sum + feature.score, 0) / features.length);
  return [
    { label: "Affected features", value: String(features.length), tone: features.length > 0 ? "neutral" : "warn" },
    { label: "Critical risk", value: String(critical), tone: critical > 0 ? "danger" : "good" },
    { label: "High risk", value: String(high), tone: high > 0 ? "warn" : "good" },
    { label: "Incident links", value: String(incidents), tone: incidents > 0 ? "warn" : "neutral" },
    {
      label: "Average score",
      value: String(avgScore),
      tone: avgScore >= 80 ? "danger" : avgScore >= 60 ? "warn" : "good",
    },
  ];
}

function metricsForAggregation(aggregation: SpatialAggregationResult): readonly AnalyticsMetric[] {
  return [
    {
      label: "Indexed cells",
      value: `${aggregation.cells.length}/${aggregation.page?.totalCellCount ?? aggregation.index.cellCount ?? aggregation.cells.length}`,
      tone: "neutral",
    },
    {
      label: "Incidents",
      value: formatSummaryValue(aggregation.totals?.totalIncidents),
      tone: "warn",
    },
    {
      label: "Exposed population",
      value: formatSummaryValue(aggregation.totals?.populationSum),
      tone: "warn",
    },
    {
      label: "Average risk",
      value: formatSummaryValue(aggregation.totals?.averageRisk),
      tone: "danger",
    },
    {
      label: "Progress",
      value: spatialAggregationProgress(aggregation).status,
      tone: isSpatialAggregationComplete(aggregation) ? "good" : "warn",
    },
  ];
}

function aggregationSeverityBuckets(
  aggregation: SpatialAggregationResult,
): ReadonlyArray<{ readonly risk: AnalyticsRisk; readonly count: number; readonly score: number }> {
  const category = aggregation.cells[0]?.summaries.bySeverity;
  const buckets = category?.kind === "category" ? category.buckets : [];
  const averageRisk = aggregation.totals?.averageRisk;
  const score = averageRisk && "value" in averageRisk ? Math.round(Number(averageRisk.value ?? 0)) : 0;
  return RISK_ORDER.map((risk) => {
    const bucket = buckets.find((entry) => entry.value === risk);
    return { risk, count: bucket?.count ?? 0, score };
  });
}

function aggregationReport(aggregation: SpatialAggregationResult): AnalyticsAggregationReport {
  return {
    requestId: aggregation.requestId,
    sourceId: aggregation.sourceId,
    indexModel: aggregation.index.model.id,
    indexResolution: aggregation.index.resolution,
    visibleCellCount: aggregation.cells.length,
    loadedCellCount: aggregation.page?.loadedCellCount ?? aggregation.cells.length,
    totalCellCount: aggregation.page?.totalCellCount ?? aggregation.index.cellCount,
    widgetIds: spatialAggregationWidgets(aggregation).map((widget) => widget.id),
    metadataCacheable: aggregation.metadata.cache?.metadataCacheable ?? false,
    resultCacheable: aggregation.metadata.cache?.resultCacheable ?? false,
  };
}

function formatSummaryValue(summary: SpatialAggregationSummaryValue | undefined): string {
  if (!summary || !("value" in summary)) return "0";
  const value = summary.value;
  return typeof value === "number" ? value.toLocaleString() : String(value ?? "0");
}

function resultSourceMetadata(
  dataset: AnalyticsDataset,
  resultLayer: AnalyticsResultLayer,
  aggregation?: SpatialAggregationResult,
): AnalyticsSourceMetadata {
  return {
    id: dataset.resultSourceId,
    title: resultLayer.title,
    type: "materialized-result",
    cache: resultLayer.cache,
    capabilities: aggregation
      ? ["spatialAggregate", "widgets", "progressive-loading", "workspace-handoff"]
      : ["bbox", "query", "download", "workspace-handoff"],
  };
}

function matchesFilter(feature: AnalyticsFeature, filter: FilterClause): boolean {
  const value = featureValue(feature, filter.field);
  switch (filter.operator) {
    case "=":
      return value === filter.value;
    case "!=":
      return value !== filter.value;
    case "in":
      return Array.isArray(filter.value) && filter.value.includes(value);
    case "not-in":
      return Array.isArray(filter.value) && !filter.value.includes(value);
    case ">":
      return Number(value) > Number(filter.value);
    case ">=":
      return Number(value) >= Number(filter.value);
    case "<":
      return Number(value) < Number(filter.value);
    case "<=":
      return Number(value) <= Number(filter.value);
    default:
      return true;
  }
}

function featureValue(feature: AnalyticsFeature, field: string): unknown {
  if (field in feature) return feature[field as keyof AnalyticsFeature];
  return feature.attributes[field];
}

function pointInExtent(feature: AnalyticsFeature, value: unknown): boolean {
  if (!isExtentLike(value)) return true;
  return feature.x >= value.xmin && feature.x <= value.xmax && feature.y >= value.ymin && feature.y <= value.ymax;
}

function isExtentLike(value: unknown): value is HonuaExtent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["xmin", "ymin", "xmax", "ymax"].every((key) => typeof candidate[key] === "number");
}

function withoutSelectionOnlyFilters(
  filters: LinkedViewQueryProjection["filters"],
): LinkedViewQueryProjection["filters"] {
  return Object.fromEntries(Object.entries(filters).filter(([id]) => id !== "selection"));
}

function envelopeFromExtent(extent: HonuaExtent) {
  return envelope(extent.xmin, extent.ymin, extent.xmax, extent.ymax, extent.spatialReference);
}

function syncWorkspaceExploration(
  dataset: AnalyticsDataset,
  workspace: ReturnType<typeof createHonuaAppWorkspace<AnalyticsFeature, AnalyticsSourceMetadata, AnalyticsJobOutput>>,
  exploration: ReturnType<typeof createExplorationContext>,
): void {
  workspace.dispatch({
    kind: "set-exploration",
    reference: { datasetId: dataset.workspaceId, sourceIds: [dataset.resultSourceId] },
    snapshot: exploration.snapshot(),
  });
}

function requireAoi(dataset: AnalyticsDataset, aoiId: string): AnalyticsAoi {
  const aoi = dataset.aois.find((entry) => entry.id === aoiId);
  if (!aoi) throw new Error(`Unknown AOI: ${aoiId}`);
  return aoi;
}

function requirePlan(dataset: AnalyticsDataset, planId: AnalyticsPlanId): AnalyticsPlan {
  const plan = dataset.plans.find((entry) => entry.id === planId);
  if (!plan) throw new Error(`Unknown analytics plan: ${planId}`);
  return plan;
}

function requireActiveJobId(jobId: string | undefined): string {
  if (!jobId) throw new Error("No active analysis job");
  return jobId;
}

function requireJob(jobs: ReadonlyMap<string, JobRecord>, jobId: string): JobRecord {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown analysis job: ${jobId}`);
  return job;
}
