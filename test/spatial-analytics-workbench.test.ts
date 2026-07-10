import { describe, expect, it } from "vitest";

import { createAnalysisExecutionCoordinator } from "../examples/spatial-analytics-workbench/src/execution-coordinator.js";
import { createFixtureSpatialAnalyticsDataset } from "../examples/spatial-analytics-workbench/src/fixtures.js";
import { createLinkedAnalysisController } from "../examples/spatial-analytics-workbench/src/linked-analysis.js";
import {
  buildHonuaCloudAnalysisRequest,
  createSpatialAnalyticsWorkbenchSession,
} from "../examples/spatial-analytics-workbench/src/model.js";

describe("Spatial Analytics Workbench sample", () => {
  it("builds a Honua Cloud process request with AOI, filters, operations, and materialization policy", () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    session.setRiskFilter("high");

    const request = session.buildRequest();

    expect(request.mode).toBe("async");
    expect(request.inputs.aoi.id).toBe("honolulu-urban-core");
    expect(request.inputs.operations).toEqual(["summarize"]);
    expect(request.inputs.filters.risk?.value).toBe("high");
    expect(request.inputs.materialize).toBe(false);
    expect(request.metadata.cachePolicy).toBe("metadata-only");
    expect(request.metadata.estimatedCost).toBe("No billing claim in fixture mode");

    session.dispose();
  });

  it("keeps map extent, table results, chart buckets, and detail selection synchronized through exploration state", () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    session.selectAoi("airport-corridor");
    const jobId = session.startAnalysis();

    expect(session.advanceJob(jobId).status).toBe("running");
    expect(session.advanceJob(jobId).status).toBe("successful");
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual([
      "route-1003",
      "facility-1004",
      "facility-1006",
    ]);

    session.selectChartBucket("low");
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual(["facility-1006"]);

    session.selectFeature("facility-1006");
    const exported = JSON.parse(session.exportWorkspace());
    expect(exported.selectedFeatures).toEqual([{ sourceId: "honua-cloud:analytics-results", id: "facility-1006" }]);
    expect(exported.analysisOutputs[0].metadata.materialized).toBe(true);
    expect(exported.metadata.cachePolicy).toContain("Layer metadata");

    session.setRiskFilter("high");
    expect(session.currentProjection().selection).toEqual([]);
    expect(JSON.parse(session.exportWorkspace()).selectedFeatures).toEqual([]);

    session.setRiskFilter("all");
    session.selectFeature("facility-1006");
    session.selectAoi("honolulu-harbor");
    expect(session.currentProjection().selection).toEqual([]);
    expect(JSON.parse(session.exportWorkspace()).selectedFeatures).toEqual([]);

    session.clearOutput();
    expect(session.visibleFeatures()).toEqual([]);
    expect(session.latestOutput()).toBeUndefined();
    expect(JSON.parse(session.exportWorkspace()).analysisOutputs).toEqual([]);

    session.dispose();
  });

  it("accepts one deterministic GeoServices pushdown plan and retains it through every output", async () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    const controller = createLinkedAnalysisController(session.dataset, {
      now: () => Date.parse(session.dataset.generatedAt),
    });
    const estimate = controller.explain("remote-pushdown", session.activeAoi, session.currentProjection());

    expect(estimate.state).toBe("estimate");
    expect(estimate.plan?.pushdown).toBe("full");
    expect(estimate.plan?.steps[0]).toMatchObject({
      engine: "remote",
      operation: "queryAggregate",
      compiled: { compiler: "geoservices-rest-query-v1", groupByFieldsForStatistics: "risk" },
    });

    const accepted = controller.accept(estimate);
    const executed = await controller.execute(accepted);
    expect(executed.state).toBe("fixture-replay");
    expect(executed.provenance.observationState).toBe("replayed");
    expect(executed.outputArtifact?.planFingerprint).toBe(executed.plan?.fingerprint);
    expect(executed.aggregateRows?.map((row) => row.risk)).toEqual(["critical", "high", "moderate"]);

    session.setLinkedAnalysisContext(executed);
    session.selectPlan("linked-risk-summary");
    const jobId = session.startAnalysis();
    session.advanceJob(jobId);
    session.advanceJob(jobId);
    const exported = JSON.parse(session.exportWorkspace());
    expect(exported.savedQueries[0].metadata.linkedAnalysisContextId).toBe(executed.id);
    expect(exported.analysisOutputs[0].metadata.executionPlanFingerprint).toBe(executed.plan?.fingerprint);
    expect(exported.metadata.linkedAnalysis.state).toBe("fixture-replay");
    expect(session.latestOutput()?.resultLayer.lineage).toContain(`plan:${executed.plan?.fingerprint}`);

    session.dispose();
  });

  it("executes metrics/groupBy locally only behind explicit row and byte ceilings", async () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    const controller = createLinkedAnalysisController(session.dataset);
    const estimate = controller.explain("bounded-local", session.activeAoi, session.currentProjection());

    expect(estimate.plan?.steps).toMatchObject([
      { engine: "remote", operation: "queryAll", query: { pagination: { offset: 0, limit: 65 } } },
      { engine: "client", operation: "aggregate", maxRows: 64, maxBytes: 256_000 },
    ]);
    const executed = await controller.execute(controller.accept(estimate));
    expect(executed.state).toBe("executed-local");
    expect(executed.aggregateRows).toEqual([
      { risk: "critical", feature_count: 1, average_score: 94 },
      { risk: "high", feature_count: 1, average_score: 82 },
      { risk: "moderate", feature_count: 1, average_score: 67 },
    ]);

    session.dispose();
  });

  it("rejects unsafe materialization before acceptance or execution", async () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    const controller = createLinkedAnalysisController(session.dataset);
    const rejected = controller.explain("unsafe-rejected", session.activeAoi, session.currentProjection());

    expect(rejected.state).toBe("rejected");
    expect(rejected.rejection?.code).toBe("unsafe-materialization");
    expect(rejected.plan).toBeUndefined();
    expect(controller.accept(rejected)).toBe(rejected);
    await expect(controller.execute(rejected)).rejects.toThrow(/accepted plan/);

    session.dispose();
  });

  it("emits a structured live skip for the unsupported OGC planner lane", () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    const controller = createLinkedAnalysisController(session.dataset, {
      dataMode: "live",
      live: { protocol: "ogc-features", baseUrl: "https://demo.example/ogc", serviceId: "incidents", layerId: 0 },
    });
    const skipped = controller.explain("remote-pushdown", session.activeAoi, session.currentProjection());

    expect(skipped.state).toBe("skipped");
    expect(skipped.rejection?.reason).toContain("#389 follow-on");
    expect(skipped.plan).toBeUndefined();
    expect(skipped.provenance).toMatchObject({ observationState: "skipped", observedAt: null });

    session.dispose();
  });

  it("keeps configured live provenance unobserved until a request succeeds", () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    const controller = createLinkedAnalysisController(session.dataset, {
      dataMode: "live",
      live: {
        protocol: "geoservices-feature-service",
        baseUrl: "https://demo.example",
        serviceId: "incidents",
        layerId: 0,
      },
    });

    const estimate = controller.explain("remote-pushdown", session.activeAoi, session.currentProjection());
    expect(estimate.state).toBe("estimate");
    expect(estimate.provenance).toMatchObject({ observationState: "pending", observedAt: null });

    session.dispose();
  });

  it.each(["AOI", "risk filter", "execution policy", "new acceptance"])(
    "rejects a deferred stale completion after %s changes even when the source ignores abort",
    async () => {
      const coordinator = createAnalysisExecutionCoordinator<{ readonly id: string }>();
      const accepted = { id: "accepted-old" };
      const ticket = coordinator.begin(accepted);
      let resolveExecution: ((value: string) => void) | undefined;
      const ignoredAbortExecution = new Promise<string>((resolve) => {
        resolveExecution = resolve;
      });
      let currentContext = accepted;
      let committed: string | undefined;
      const completion = ignoredAbortExecution.then((value) => {
        if (coordinator.isCurrent(ticket, currentContext)) committed = value;
      });

      coordinator.invalidate();
      currentContext = { id: "accepted-new" };
      resolveExecution?.("stale-result");
      await completion;

      expect(ticket.signal.aborted).toBe(true);
      expect(committed).toBeUndefined();
      expect(coordinator.finish(ticket)).toBe(false);
    },
  );

  it("renders indexed aggregation cells and SDK widget metadata from the fixture contract", () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    session.selectPlan("indexed-aggregation");
    const jobId = session.startAnalysis();

    expect(session.advanceJob(jobId).status).toBe("running");
    const completed = session.advanceJob(jobId);

    expect(completed.status).toBe("successful");
    expect(session.aggregationCells()).toHaveLength(2);
    expect(session.aggregationWidgets().map((widget) => widget.kind)).toEqual([
      "stat",
      "category-list",
      "histogram",
      "range-list",
      "grouped-table",
    ]);
    expect(session.chartBuckets().map((bucket) => [bucket.risk, bucket.count])).toEqual([
      ["critical", 62],
      ["high", 104],
      ["moderate", 65],
      ["low", 0],
    ]);
    expect(session.latestAggregation()?.totals?.populationExposureRange).toMatchObject({
      kind: "range",
      buckets: [
        { id: "low", count: 74 },
        { id: "medium", count: 101 },
        { id: "high", count: 56 },
      ],
    });
    expect(session.latestAggregation()?.metadata.cache?.metadataCacheable).toBe(true);
    expect(session.latestAggregation()?.metadata.cache?.resultCacheable).toBe(false);
    expect(session.latestOutput()?.features).toHaveLength(0);
    expect(session.dataset.capabilityGaps.map((gap) => gap.ticket)).toContain("#66");

    session.dispose();
  });

  it("keeps unsupported aggregation requests explicit in the request contract", () => {
    const dataset = createFixtureSpatialAnalyticsDataset();
    const plan = dataset.plans.find((entry) => entry.id === "indexed-aggregation");
    const aoi = dataset.aois[0];
    if (!plan || !aoi) throw new Error("fixture is missing required entries");

    const request = buildHonuaCloudAnalysisRequest(dataset, plan, aoi, {
      filters: {},
      orderBy: [],
      pagination: { offset: 0, limit: 25 },
      grouping: ["risk"],
      aggregation: { groupBy: ["risk"], metrics: [{ fn: "count", field: "OBJECTID", alias: "count" }] },
      selection: [],
    });

    expect(request.inputs.operations).toEqual(["aggregate"]);
    expect(request.inputs.materialize).toBe(false);
    expect(request.metadata.cachePolicy).toBe("metadata-only");
    expect(request.inputs.aggregation?.groupBy).toEqual(["risk"]);
    expect(request.inputs.indexedAggregation?.summaries.map((summary) => summary.id)).toContain("bySeverity");
    expect(request.inputs.indexedAggregation?.resolution?.strategy).toBe("fit-viewport");
  });
});
