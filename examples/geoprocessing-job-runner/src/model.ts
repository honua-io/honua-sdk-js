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
import type { IJobRun } from "@honua/sdk-js/contract";
import { createExplorationContext, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import type { FilterClause } from "@honua/sdk-js/exploration";
import {
  createGeospatialGrpcProcessAdapter,
  createHonuaCacheState,
  createHonuaProcessRunner,
  envelope,
} from "@honua/sdk-js/honua";
import type { GeospatialGrpcProcessClient, HonuaExtent, JobSnapshot } from "@honua/sdk-js/honua";
import { selectLinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

import { createFixtureGeoprocessingDataset } from "./fixtures.js";
import type {
  GeoprocessingJobRunnerSession,
  GeoprocessingJobRunnerSessionOptions,
  RunnerAoi,
  RunnerDataset,
  RunnerFeature,
  RunnerJobOutput,
  RunnerPlan,
  RunnerProcessClientFactoryContext,
  RunnerSourceMetadata,
} from "./types.js";

const RISK_ORDER: readonly RunnerFeature["risk"][] = ["critical", "high", "moderate", "low"];
const RESULT_MEDIA_TYPE = "application/geo+json";

interface ActiveJob {
  readonly id: string;
  readonly planId: string;
  readonly aoiId: string;
  readonly job: IJobRun<RunnerJobOutput>;
}

export function createGeoprocessingJobRunnerSession(
  options: RunnerDataset | GeoprocessingJobRunnerSessionOptions = {},
): GeoprocessingJobRunnerSession {
  const dataset = isRunnerDataset(options) ? options : (options.dataset ?? createFixtureGeoprocessingDataset());
  const processClientFactory = isRunnerDataset(options) ? undefined : options.processClientFactory;
  const workspace = createHonuaAppWorkspace<RunnerFeature, RunnerSourceMetadata, RunnerJobOutput>();
  const exploration = createExplorationContext({
    datasetId: dataset.workspaceId,
    sourceIds: [dataset.resultSourceId],
    preset: "globalLinked",
  });
  const views = {
    map: exploration.connectView({ id: "gp-runner-map", role: "map" }),
    table: exploration.connectView({ id: "gp-runner-table", role: "grid" }),
    chart: exploration.connectView({ id: "gp-runner-chart", role: "chart" }),
    filters: exploration.connectView({ id: "gp-runner-filters", role: "filter" }),
    detail: exploration.connectView({ id: "gp-runner-detail", role: "detail" }),
  };
  const syncExplorationSnapshot = (): void => {
    workspace.dispatch({
      kind: "set-exploration",
      reference: { datasetId: exploration.datasetId, sourceIds: exploration.sourceIds },
      snapshot: exploration.snapshot(),
    });
  };

  let activeAoiId = dataset.aois[0]?.id ?? "";
  let activePlanId = dataset.plans[0]?.id ?? "";
  let latestOutput: RunnerJobOutput | undefined;
  let jobCounter = 0;
  const jobs = new Map<string, ActiveJob>();

  workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
  workspace.dispatch({
    kind: "set-layout",
    layout: {
      activeViewId: views.map.id,
      panels: {
        controls: { order: 0, size: 1 },
        map: { order: 1, size: 2 },
        table: { order: 2, size: 2 },
        chart: { order: 3, size: 1 },
      },
    },
  });
  for (const source of dataset.inputSources) {
    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId: source.id,
      status: source.cache.status === "stale" ? "stale" : "ready",
      metadata: source,
      updatedAt: Date.parse(dataset.generatedAt),
    });
  }
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: "honua-cloud:process-catalog",
    status: "ready",
    metadata: {
      id: "honua-cloud:process-catalog",
      title: "Honua process catalog",
      type: "process-catalog",
      cache: createHonuaCacheState({
        scope: "metadata",
        status: "refreshed",
        keyFingerprint: "gp-runner-process-catalog:v1",
        revalidatedAt: dataset.generatedAt,
      }),
      capabilities: ["geospatial-grpc", "geoservices-gp", "ogc-processes", "geometry"],
      capabilityState: "available",
    },
    updatedAt: Date.parse(dataset.generatedAt),
  });
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      cursor: "fixture:empty-gp-results",
      receivedAt: Date.parse(dataset.generatedAt),
      features: [],
    },
  });

  const initialAoi = requireAoi(dataset, activeAoiId);
  views.map.setExtent(initialAoi.extent);
  views.map.setSpatialFilter(envelopeFromExtent(initialAoi.extent));
  views.table.setVisibleFields(["title", "risk", "category", "zone", "score", "peopleServed", "distanceMeters"]);
  views.chart.setGrouping(["risk"]);
  views.chart.setAggregation({ groupBy: ["risk"], metrics: [{ fn: "avg", field: "score", alias: "averageScore" }] });
  syncExplorationSnapshot();

  const session: GeoprocessingJobRunnerSession = {
    dataset,
    workspace,
    exploration,
    get activeAoi() {
      return requireAoi(dataset, activeAoiId);
    },
    get activePlan() {
      return requirePlan(dataset, activePlanId);
    },
    get activeJobId() {
      return Array.from(jobs.keys()).at(-1);
    },
    selectAoi(aoiId: string): void {
      const aoi = requireAoi(dataset, aoiId);
      activeAoiId = aoi.id;
      views.map.setExtent(aoi.extent);
      views.map.setSpatialFilter(envelopeFromExtent(aoi.extent));
      syncExplorationSnapshot();
    },
    selectPlan(planId: string): void {
      activePlanId = requirePlan(dataset, planId).id;
    },
    setCategoryFilter(category: RunnerFeature["category"] | "all"): void {
      if (category === "all") views.filters.clearFilter("category");
      else views.filters.setFilter("category", { field: "category", operator: "=", value: category });
      syncExplorationSnapshot();
    },
    selectFeature(featureId: string): void {
      views.table.select([sourceFeatureSelectionTarget(dataset.resultSourceId, featureId)], { replace: true });
      syncExplorationSnapshot();
    },
    currentProjection(): LinkedViewQueryProjection {
      return selectLinkedViewQueryProjection(exploration.state, { sourceId: dataset.resultSourceId });
    },
    buildProcessRequest() {
      const plan = requirePlan(dataset, activePlanId);
      const aoi = requireAoi(dataset, activeAoiId);
      return {
        plan: buildGeospatialGrpcPlan(dataset, plan, aoi, this.currentProjection()),
        context: {
          workspaceId: dataset.workspaceId,
          metadata: {
            idempotency_key: `${dataset.workspaceId}:${plan.id}:${aoi.id}`,
            cache_policy: plan.materializes ? "metadata-and-materialized-output" : "metadata-only",
          },
        },
      };
    },
    async startJob(): Promise<string> {
      const plan = requirePlan(dataset, activePlanId);
      const aoi = requireAoi(dataset, activeAoiId);
      jobCounter += 1;
      const jobId = `gp-runner-${plan.id}-${jobCounter}`;
      const processClientContext: RunnerProcessClientFactoryContext = {
        dataset,
        plan,
        aoi,
        jobId,
        projection: () => session.currentProjection(),
      };
      const processClient =
        processClientFactory?.(processClientContext) ??
        createFixtureProcessClient(dataset, plan, aoi, jobId, processClientContext.projection);
      const runner = createHonuaProcessRunner(createGeospatialGrpcProcessAdapter(processClient));
      const request = this.buildProcessRequest();
      const job = await runner.execute<RunnerJobOutput>(request);
      jobs.set(job.id, { id: job.id, planId: plan.id, aoiId: aoi.id, job });
      workspace.dispatch({ kind: "attach-job", job });
      workspace.dispatch({
        kind: "set-job-snapshot",
        jobId: job.id,
        type: `geospatial-grpc:${plan.id}`,
        snapshot: { status: "accepted", progress: { percent: 5, message: `Queued ${plan.title}` } },
      });
      return job.id;
    },
    async pollJob(jobId?: string): Promise<JobSnapshot<RunnerJobOutput>> {
      const activeJobId = requireActiveJobId(jobId ?? session.activeJobId);
      const record = requireJob(jobs, activeJobId);
      const snapshot = await record.job.poll();
      if (snapshot.status === "successful" && latestOutput?.resultLayer.id !== `materialized-${activeJobId}`) {
        latestOutput = materializeOutput(
          dataset,
          requirePlan(dataset, record.planId),
          requireAoi(dataset, record.aoiId),
          this.currentProjection(),
          activeJobId,
        );
        publishOutput(dataset, workspace, latestOutput, activeJobId);
        const materializedSnapshot: JobSnapshot<RunnerJobOutput> = {
          status: "successful",
          progress: { percent: 100, message: `Materialized ${latestOutput.features.length} linked feature(s)` },
          result: { outputs: { [latestOutput.resultLayer.id]: latestOutput } },
        };
        workspace.dispatch({
          kind: "set-job-snapshot",
          jobId: activeJobId,
          type: `geospatial-grpc:${record.planId}`,
          snapshot: materializedSnapshot,
        });
        return materializedSnapshot;
      }
      return snapshot;
    },
    async cancelJob(jobId?: string): Promise<JobSnapshot<RunnerJobOutput>> {
      const activeJobId = requireActiveJobId(jobId ?? session.activeJobId);
      const record = requireJob(jobs, activeJobId);
      const status = await record.job.cancel();
      const snapshot: JobSnapshot<RunnerJobOutput> = {
        status,
        progress: { percent: 100, message: "Cancellation acknowledged by job authority" },
      };
      workspace.dispatch({
        kind: "set-job-snapshot",
        jobId: activeJobId,
        type: `geospatial-grpc:${record.planId}`,
        snapshot,
      });
      return snapshot;
    },
    visibleFeatures(): RunnerFeature[] {
      const table = selectHonuaAppWorkspaceTableModel(workspace.state, { sourceId: dataset.resultSourceId });
      return applyProjection(
        table.records.map((record) => record.feature),
        this.currentProjection(),
      );
    },
    chartBuckets() {
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
    latestOutput(): RunnerJobOutput | undefined {
      return latestOutput;
    },
    exportWorkspace(): string {
      const output = latestOutput;
      const document = createHonuaSavedWorkspaceDocument<RunnerFeature, RunnerSourceMetadata, RunnerJobOutput>({
        snapshot: workspace.snapshot(),
        project: {
          id: dataset.workspaceId,
          title: "Geometry and Geoprocessing Job Runner",
          description: "Fixture-backed Honua process execution workspace for issue #129.",
        },
        sources: output
          ? [{ id: dataset.resultSourceId, protocol: "honua-cloud", title: output.resultLayer.title }]
          : [],
        layers: output
          ? [
              {
                id: output.resultLayer.id,
                sourceId: dataset.resultSourceId,
                title: output.resultLayer.title,
                visible: true,
                metadata: { mediaType: RESULT_MEDIA_TYPE, lineage: output.resultLayer.lineage },
              },
            ]
          : [],
        jobs: Object.values(workspace.state.jobs.entries).map((entry) => ({
          id: entry.id,
          type: entry.type,
          status: entry.snapshot.status,
          progress: entry.snapshot.progress,
          result: entry.snapshot.result,
          error: entry.snapshot.error,
          updatedAt: dataset.generatedAt,
        })),
        analysisOutputs: output
          ? [
              {
                id: output.resultLayer.id,
                jobId: session.activeJobId,
                type: RESULT_MEDIA_TYPE,
                label: output.resultLayer.title,
                sourceId: dataset.resultSourceId,
                layerId: output.resultLayer.id,
                href: output.resultLayer.href,
                createdAt: dataset.generatedAt,
                data: { metrics: output.metrics, featureCount: output.features.length },
                metadata: { cache: output.resultLayer.cache, protocol: "geospatial-grpc" },
              },
            ]
          : [],
        metadata: {
          cachePolicy:
            "Process definitions and source metadata are cacheable. Job status, cancellation, and progress are always read from the job authority.",
          protocols: ["geospatial-grpc", "geoservices-gp", "ogc-processes"],
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

export function selectGeoprocessingRunnerUiModels(session: GeoprocessingJobRunnerSession) {
  return {
    map: selectHonuaAppWorkspaceMapModel(session.workspace.state, { sourceId: session.dataset.resultSourceId }),
    table: selectHonuaAppWorkspaceTableModel(session.workspace.state, { sourceId: session.dataset.resultSourceId }),
    chart: selectHonuaAppWorkspaceChartModel(session.workspace.state, { sourceId: session.dataset.resultSourceId }),
    detail: selectHonuaAppWorkspaceDetailModel(session.workspace.state),
    jobs: selectHonuaAppWorkspaceJobModel(session.workspace.state),
    cache: selectHonuaAppWorkspaceMetadataCacheModel(session.workspace.state),
  };
}

export function applyProjection(
  features: readonly RunnerFeature[],
  projection: LinkedViewQueryProjection,
): RunnerFeature[] {
  const filters = Object.values(projection.filters);
  const selectedIds = new Set(
    projection.selection.map((target) => (typeof target === "object" ? String(target.id) : String(target))),
  );
  const rows = features.filter((feature) => {
    if (!pointInExtent(feature, projection.spatialFilter?.geometry ?? projection.extent)) return false;
    return filters.every((filter) => matchesFilter(feature, filter));
  });
  return rows.sort((a, b) => Number(selectedIds.has(b.id)) - Number(selectedIds.has(a.id)) || b.score - a.score);
}

function createFixtureProcessClient(
  dataset: RunnerDataset,
  plan: RunnerPlan,
  aoi: RunnerAoi,
  jobId: string,
  projection: () => LinkedViewQueryProjection,
): GeospatialGrpcProcessClient {
  let pollCount = 0;
  return {
    async validatePlan() {
      return { valid: plan.capabilityState !== "unsupported", issues: validationIssues(plan) };
    },
    async dryRunPlan() {
      return {
        valid: plan.capabilityState !== "unsupported",
        issues: validationIssues(plan),
        result: { estimatedDurationSeconds: plan.fixtureMode === "unsupported-capability" ? 0 : 18 },
      };
    },
    async submitJob() {
      return { jobId, state: "JOB_STATE_RUNNING" };
    },
    async getJob() {
      pollCount += 1;
      if (plan.fixtureMode === "unsupported-capability") {
        return {
          jobId,
          state: "JOB_STATE_FAILED",
          progress: { progressPercent: 30, message: "Stopped before execution: upstream capability is unavailable." },
        };
      }
      const completed = pollCount > 1;
      return {
        jobId,
        state: completed ? "JOB_STATE_COMPLETED" : "JOB_STATE_RUNNING",
        progress: {
          progressPercent: completed ? 100 : plan.fixtureMode === "route-profile" ? 58 : 64,
          message: completed ? `Completed ${plan.title}` : `Executing ${plan.processIds.join(" -> ")} for ${aoi.title}`,
          updatedAt: Date.parse(dataset.generatedAt) + pollCount,
        },
      };
    },
    async getJobResult() {
      if (plan.fixtureMode === "unsupported-capability") {
        return {
          jobId,
          error: {
            errorCode: "CapabilityNotSupported",
            message: `${plan.title} requires ${plan.processIds.join(", ")}.`,
            details: { planId: plan.id, capabilityState: plan.capabilityState },
          },
        };
      }
      const output = materializeOutput(dataset, plan, aoi, projection(), jobId);
      return {
        jobId,
        result: {
          resultId: output.resultLayer.id,
          status: "JOB_STATE_COMPLETED",
          summary: `Materialized ${output.features.length} result feature(s)`,
          artifacts: [
            {
              artifactId: output.resultLayer.id,
              artifactClass: "ARTIFACT_CLASS_FEATURE_LAYER",
              producerRef: jobId,
              materializationState: "materialized",
            },
          ],
        },
      };
    },
    async cancelJob() {
      return { jobId, state: "JOB_STATE_CANCELLED" };
    },
  };
}

function buildGeospatialGrpcPlan(
  dataset: RunnerDataset,
  plan: RunnerPlan,
  aoi: RunnerAoi,
  projection: LinkedViewQueryProjection,
) {
  return {
    planId: plan.id,
    specVersion: "geospatial-grpc.v1",
    workflowFamily: "WORKFLOW_FAMILY_ANALYZE",
    expectedOutputs: plan.materializes ? ["ARTIFACT_CLASS_FEATURE_LAYER"] : [],
    steps: [
      {
        stepId: "select-aoi",
        kind: "query_features",
        inputs: {
          aoiId: { stringValue: aoi.id },
          extent: { structValue: { fields: extentFields(aoi.extent) } },
          filters: {
            structValue: {
              fields: Object.fromEntries(
                Object.entries(projection.filters).map(([id, filter]) => [id, filterValue(filter)]),
              ),
            },
          },
        },
      },
      ...plan.processIds.map((processId, index) => ({
        stepId: processId,
        kind: dataset.processes.find((process) => process.id === processId)?.operation ?? "geoprocess",
        dependencies: index === 0 ? ["select-aoi"] : [plan.processIds[index - 1]],
        inputs: { materialize: { boolValue: plan.materializes } },
      })),
    ],
  };
}

function materializeOutput(
  dataset: RunnerDataset,
  plan: RunnerPlan,
  aoi: RunnerAoi,
  projection: LinkedViewQueryProjection,
  jobId: string,
): RunnerJobOutput {
  const features = applyProjection(
    dataset.features.filter((feature) => feature.aoiIds.includes(aoi.id)),
    { ...projection, selection: [] },
  );
  const featureCount = features.length;
  const peopleServed = features.reduce((sum, feature) => sum + feature.peopleServed, 0);
  const averageScore =
    featureCount === 0 ? 0 : Math.round(features.reduce((sum, feature) => sum + feature.score, 0) / featureCount);
  return {
    planId: plan.id,
    aoiId: aoi.id,
    resultLayer: {
      id: `materialized-${jobId}`,
      title: `${aoi.title} ${plan.outputLayerTitle}`,
      sourceId: dataset.resultSourceId,
      href: `/workspaces/${dataset.workspaceId}/analysis/${jobId}.geojson`,
      materialized: true,
      lineage: [aoi.id, ...plan.processIds],
      cache: createHonuaCacheState({
        scope: "materialized-result",
        status: "refreshed",
        keyFingerprint: `job:${jobId}:aoi:${aoi.id}:plan:${plan.id}`,
        revalidatedAt: dataset.generatedAt,
        sourceUpdatedAt: dataset.generatedAt,
      }),
    },
    features,
    metrics: {
      featureCount,
      criticalCount: features.filter((feature) => feature.risk === "critical").length,
      peopleServed,
      averageScore,
    },
    warnings: [
      "Process definitions and source metadata are cacheable.",
      "Job status, progress, and cancellation are refreshed from the job authority.",
    ],
  };
}

function publishOutput(
  dataset: RunnerDataset,
  workspace: ReturnType<typeof createHonuaAppWorkspace<RunnerFeature, RunnerSourceMetadata, RunnerJobOutput>>,
  output: RunnerJobOutput,
  jobId: string,
): void {
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: dataset.resultSourceId,
    status: "ready",
    metadata: {
      id: dataset.resultSourceId,
      title: output.resultLayer.title,
      type: "result-layer",
      cache: output.resultLayer.cache,
      capabilities: ["query", "bbox", "materialized-result", "linked-view-sync"],
      capabilityState: "available",
    },
    updatedAt: Date.parse(dataset.generatedAt),
  });
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      eventId: `${jobId}:materialized`,
      cursor: `job:${jobId}`,
      receivedAt: Date.parse(dataset.generatedAt),
      features: output.features.map((feature) => ({ sourceId: dataset.resultSourceId, id: feature.id, feature })),
    },
  });
}

function validationIssues(plan: RunnerPlan): readonly Record<string, unknown>[] {
  if (plan.capabilityState !== "unsupported") return [];
  return [
    {
      nodeId: plan.processIds[0],
      field: "processIds",
      message: "The selected upstream capability is not available in this fixture.",
      severity: "ISSUE_SEVERITY_ERROR",
    },
  ];
}

function requireAoi(dataset: RunnerDataset, aoiId: string): RunnerAoi {
  const aoi = dataset.aois.find((entry) => entry.id === aoiId);
  if (!aoi) throw new Error(`Unknown AOI: ${aoiId}`);
  return aoi;
}

function requirePlan(dataset: RunnerDataset, planId: string): RunnerPlan {
  const plan = dataset.plans.find((entry) => entry.id === planId);
  if (!plan) throw new Error(`Unknown process plan: ${planId}`);
  return plan;
}

function requireJob(jobs: ReadonlyMap<string, ActiveJob>, jobId: string): ActiveJob {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  return job;
}

function requireActiveJobId(jobId: string | undefined): string {
  if (!jobId) throw new Error("No active job.");
  return jobId;
}

function envelopeFromExtent(extent: HonuaExtent) {
  return envelope(extent.xmin, extent.ymin, extent.xmax, extent.ymax, extent.spatialReference);
}

function pointInExtent(feature: RunnerFeature, extent: unknown): boolean {
  if (!extent || typeof extent !== "object") return true;
  const candidate = extent as Partial<HonuaExtent>;
  if (
    typeof candidate.xmin !== "number" ||
    typeof candidate.ymin !== "number" ||
    typeof candidate.xmax !== "number" ||
    typeof candidate.ymax !== "number"
  ) {
    return true;
  }
  return (
    feature.geometry.x >= candidate.xmin &&
    feature.geometry.x <= candidate.xmax &&
    feature.geometry.y >= candidate.ymin &&
    feature.geometry.y <= candidate.ymax
  );
}

function matchesFilter(feature: RunnerFeature, filter: FilterClause): boolean {
  const value = feature[filter.field as keyof RunnerFeature];
  if (filter.operator === "=") return value === filter.value;
  if (filter.operator === "!=") return value !== filter.value;
  return true;
}

function extentFields(extent: HonuaExtent): Record<string, unknown> {
  return {
    xmin: { doubleValue: extent.xmin },
    ymin: { doubleValue: extent.ymin },
    xmax: { doubleValue: extent.xmax },
    ymax: { doubleValue: extent.ymax },
  };
}

function filterValue(filter: FilterClause): Record<string, unknown> {
  return {
    structValue: {
      fields: {
        field: { stringValue: filter.field },
        operator: { stringValue: filter.operator },
        value: { stringValue: String(filter.value ?? "") },
      },
    },
  };
}

function isRunnerDataset(value: unknown): value is RunnerDataset {
  return typeof value === "object" && value !== null && "workspaceId" in value && "features" in value;
}
