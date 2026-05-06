import { describe, expect, it } from "vitest";

import { createFixtureSpatialAnalyticsDataset } from "../examples/spatial-analytics-workbench/src/fixtures.js";
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
    expect(request.inputs.operations).toEqual(["buffer", "intersect", "summarize", "materialize"]);
    expect(request.inputs.filters.risk?.value).toBe("high");
    expect(request.inputs.materialize).toBe(true);
    expect(request.metadata.cachePolicy).toBe("materialized-result");
    expect(request.metadata.estimatedCost).toContain("$0.18");

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

    session.dispose();
  });

  it("represents missing indexed aggregation as a failed job with #66 diagnostics", () => {
    const session = createSpatialAnalyticsWorkbenchSession();
    session.selectPlan("indexed-aggregation");
    const jobId = session.startAnalysis();

    expect(session.advanceJob(jobId).status).toBe("running");
    const failed = session.advanceJob(jobId);

    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("HonuaCapabilityNotSupported");
    expect(JSON.stringify(failed.error?.details)).toContain("#66");
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
  });
});
