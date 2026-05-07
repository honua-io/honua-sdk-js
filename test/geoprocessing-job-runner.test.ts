import { describe, expect, it } from "vitest";

import {
  createGeoprocessingJobRunnerSession,
  selectGeoprocessingRunnerUiModels,
} from "../examples/geoprocessing-job-runner/src/model.js";

describe("Geoprocessing Job Runner sample", () => {
  it("builds a geospatial-grpc execution plan with AOI, filters, steps, and cache policy", () => {
    const session = createGeoprocessingJobRunnerSession();
    session.setCategoryFilter("facility");

    const request = session.buildProcessRequest();
    const plan = request.plan as { planId: string; steps: Array<{ stepId: string; kind: string }> };
    const context = request.context as { metadata: Record<string, string> };

    expect(plan.planId).toBe("buffer-overlay");
    expect(plan.steps.map((step) => step.stepId)).toEqual([
      "select-aoi",
      "geometry-buffer",
      "geometry-intersect",
      "ogc-materialize",
    ]);
    expect(plan.steps.map((step) => step.kind)).toEqual(["query_features", "buffer", "intersect", "execute"]);
    expect(context.metadata.cache_policy).toBe("metadata-and-materialized-output");

    session.dispose();
  });

  it("submits, polls, materializes, and synchronizes result rows across linked views", async () => {
    const session = createGeoprocessingJobRunnerSession();
    session.selectAoi("harbor-corridor");

    const jobId = await session.startJob();
    expect((await session.pollJob(jobId)).status).toBe("running");
    expect((await session.pollJob(jobId)).status).toBe("successful");

    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual([
      "facility-1001",
      "facility-1004",
      "route-1003",
    ]);

    session.setCategoryFilter("route");
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual(["route-1003"]);

    session.selectFeature("route-1003");
    const models = selectGeoprocessingRunnerUiModels(session);
    expect(models.detail.selectedRecords[0]?.feature.title).toBe("Nimitz outbound bottleneck");

    const exported = JSON.parse(session.exportWorkspace());
    expect(exported.kind).toBe("honua.saved-workspace");
    expect(exported.analysisOutputs[0].metadata.protocol).toBe("geospatial-grpc");
    expect(exported.metadata.cachePolicy).toContain("Job status");

    session.dispose();
  });

  it("can use an injected geospatial-grpc process client for cloud rehearsal", async () => {
    const submitted: unknown[] = [];
    const session = createGeoprocessingJobRunnerSession({
      processClientFactory: () => ({
        async submitJob(request) {
          submitted.push(request);
          return { jobId: "cloud-job-1", state: "JOB_STATE_RUNNING" };
        },
        async getJob() {
          return {
            jobId: "cloud-job-1",
            state: "JOB_STATE_COMPLETED",
            progress: { progressPercent: 100, message: "Cloud job completed" },
          };
        },
        async getJobResult() {
          return { jobId: "cloud-job-1", result: { resultId: "cloud-result", summary: "Cloud result ready" } };
        },
        async cancelJob() {
          return { jobId: "cloud-job-1", state: "JOB_STATE_CANCELLED" };
        },
      }),
    });

    const jobId = await session.startJob();
    const snapshot = await session.pollJob(jobId);

    expect(jobId).toBe("cloud-job-1");
    expect(snapshot.status).toBe("successful");
    expect(submitted).toHaveLength(1);
    expect((submitted[0] as { context: { metadata: Record<string, string> } }).context.metadata.cache_policy).toBe(
      "metadata-and-materialized-output",
    );

    session.dispose();
  });

  it("surfaces unsupported capabilities and cancellation states explicitly", async () => {
    const failed = createGeoprocessingJobRunnerSession();
    failed.selectPlan("network-allocation");
    const failedJobId = await failed.startJob();
    const failedSnapshot = await failed.pollJob(failedJobId);

    expect(failedSnapshot.status).toBe("failed");
    expect(failedSnapshot.error?.code).toBe("CapabilityNotSupported");
    failed.dispose();

    const cancelled = createGeoprocessingJobRunnerSession();
    const cancelledJobId = await cancelled.startJob();
    const cancelledSnapshot = await cancelled.cancelJob(cancelledJobId);

    expect(cancelledSnapshot.status).toBe("dismissed");
    expect(cancelledSnapshot.progress?.message).toContain("Cancellation acknowledged");
    cancelled.dispose();
  });
});
