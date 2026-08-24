import { describe, expect, it } from "vitest";

import {
  HonuaClient,
  createGeoServicesGpAdapter,
  createGeospatialGrpcProcessAdapter,
  createHonuaProcessRunner,
  createOgcProcessesAdapter,
} from "../src/honua.js";
import type { GeospatialGrpcProcessClient } from "../src/honua.js";

import { jsonResponse, makeMockClient } from "./contract/shared.js";

describe("HonuaProcessRunner unified geoprocessing API", () => {
  it("is reachable from HonuaClient helpers for OGC, GeoServices GP, and geospatial-grpc", () => {
    const client = new HonuaClient({ baseUrl: "https://honua.example.test" });
    const processClient: GeospatialGrpcProcessClient = {
      async submitJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_RUNNING" };
      },
      async getJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_RUNNING" };
      },
      async getJobResult() {
        return { jobId: "grpc-job-1", result: {} };
      },
      async cancelJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_CANCELLED" };
      },
    };

    expect(client.ogcProcessRunner().protocol).toBe("ogc-processes");
    expect(client.geoprocessingRunner("Analysis", "OverlayFacilities").protocol).toBe("geoservices-gp");
    expect(client.geospatialGrpcProcessRunner(processClient).protocol).toBe("geospatial-grpc");
  });

  it("runs OGC API Processes through the canonical IJobRun surface", async () => {
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "ogc-job-1", processID: "buffer", status: "running" }),
        ],
        ["/ogc/processes/jobs/ogc-job-1/results", () => jsonResponse({ result: { featureCount: 2 } })],
        ["/ogc/processes/jobs/ogc-job-1", () => jsonResponse({ jobID: "ogc-job-1", status: "successful" })],
      ],
    });
    const runner = createHonuaProcessRunner(createOgcProcessesAdapter(client.ogcProcesses()));

    const job = await runner.execute({ processId: "buffer", inputs: { distance: 250 } });
    const result = await job.results();

    expect(runner.protocol).toBe("ogc-processes");
    expect(job.id).toBe("ogc-job-1");
    expect(result.outputs.result).toEqual({ featureCount: 2 });
  });

  it("runs GeoServices REST GPServer tasks through the same runner", async () => {
    const client = makeMockClient({
      routes: [
        [
          "/rest/services/Analysis/GPServer/OverlayFacilities/submitJob",
          () => jsonResponse({ jobId: "gp-job-1", jobStatus: "esriJobSubmitted" }),
        ],
        [
          "/rest/services/Analysis/GPServer/OverlayFacilities/jobs/gp-job-1/results/outputLayer",
          () => jsonResponse({ value: { featureCount: 3 } }),
        ],
        [
          "/rest/services/Analysis/GPServer/OverlayFacilities/jobs/gp-job-1",
          () => jsonResponse({ jobId: "gp-job-1", jobStatus: "esriJobSucceeded" }),
        ],
      ],
    });
    const runner = createHonuaProcessRunner(
      createGeoServicesGpAdapter(client.geoprocessing("Analysis", "OverlayFacilities")),
    );

    const job = await runner.execute({ inputs: { Buffer_Distance: 250 }, resultNames: ["outputLayer"] });
    const result = await job.results();

    expect(runner.protocol).toBe("geoservices-gp");
    expect(job.type).toBe("Analysis/OverlayFacilities");
    expect(result.outputs.outputLayer).toEqual({ value: { featureCount: 3 } });
  });

  it("runs geospatial-grpc ProcessService clients without requiring generated proto in this package", async () => {
    let getJobCount = 0;
    const processClient: GeospatialGrpcProcessClient = {
      async validatePlan(request) {
        return { valid: Boolean(request.plan), issues: [] };
      },
      async dryRunPlan() {
        return { valid: true, result: { estimatedDurationSeconds: 12 } };
      },
      async submitJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_RUNNING" };
      },
      async getJob() {
        getJobCount += 1;
        return {
          jobId: "grpc-job-1",
          state: getJobCount === 1 ? "JOB_STATE_RUNNING" : "JOB_STATE_COMPLETED",
          progress: {
            progressPercent: getJobCount === 1 ? 40 : 100,
            message: getJobCount === 1 ? "Overlaying features" : "Complete",
            updatedAt: 1770000000000,
          },
        };
      },
      async getJobResult() {
        return {
          jobId: "grpc-job-1",
          result: {
            resultId: "result-1",
            status: "JOB_STATE_COMPLETED",
            artifacts: [{ artifactId: "layer-1", artifactClass: "ARTIFACT_CLASS_FEATURE_LAYER" }],
          },
        };
      },
      async cancelJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_CANCELLED" };
      },
    };
    const runner = createHonuaProcessRunner(createGeospatialGrpcProcessAdapter(processClient));

    await expect(runner.validate({ plan: { planId: "analysis-plan" } })).resolves.toMatchObject({ valid: true });
    await expect(runner.dryRun({ plan: { planId: "analysis-plan" } })).resolves.toMatchObject({ valid: true });

    const job = await runner.execute({ plan: { planId: "analysis-plan" } });
    await expect(job.poll()).resolves.toMatchObject({ status: "running", progress: { percent: 40 } });
    const result = await job.results();

    expect(runner.protocol).toBe("geospatial-grpc");
    expect(result.outputs.result).toMatchObject({
      resultId: "result-1",
      artifacts: [{ artifactId: "layer-1" }],
    });
  });

  it("bounds geospatial-grpc polling by maxAttempts and forwards the abort signal", async () => {
    let getJobCount = 0;
    let sawSignal = false;
    const processClient: GeospatialGrpcProcessClient = {
      async submitJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_RUNNING" };
      },
      async getJob(request) {
        getJobCount += 1;
        if (request.signal) sawSignal = true;
        return { jobId: "grpc-job-1", state: "JOB_STATE_RUNNING" };
      },
      async getJobResult() {
        return { jobId: "grpc-job-1", result: {} };
      },
      async cancelJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_CANCELLED" };
      },
    };
    const runner = createHonuaProcessRunner(createGeospatialGrpcProcessAdapter(processClient));
    const job = await runner.execute({ plan: { planId: "analysis-plan" } });

    await expect(
      job.results({ maxAttempts: 2, pollIntervalMs: 0, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      name: "HonuaJobPollTimeoutError",
      reason: "max-attempts",
    });
    expect(getJobCount).toBe(2);
    expect(sawSignal).toBe(true);
  });

  it("aborts geospatial-grpc polling when the caller signal fires", async () => {
    const controller = new AbortController();
    const processClient: GeospatialGrpcProcessClient = {
      async submitJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_RUNNING" };
      },
      async getJob() {
        controller.abort();
        return { jobId: "grpc-job-1", state: "JOB_STATE_RUNNING" };
      },
      async getJobResult() {
        return { jobId: "grpc-job-1", result: {} };
      },
      async cancelJob() {
        return { jobId: "grpc-job-1", state: "JOB_STATE_CANCELLED" };
      },
    };
    const runner = createHonuaProcessRunner(createGeospatialGrpcProcessAdapter(processClient));
    const job = await runner.execute({ plan: { planId: "analysis-plan" } });
    await expect(job.results({ signal: controller.signal, maxAttempts: 100, pollIntervalMs: 0 })).rejects.toMatchObject(
      {
        reason: "aborted",
      },
    );
  });

  it("throws the exported typed job failure for geospatial-grpc failures", async () => {
    const processClient: GeospatialGrpcProcessClient = {
      async submitJob() {
        return { jobId: "grpc-failed", state: "JOB_STATE_RUNNING" };
      },
      async getJob() {
        return { jobId: "grpc-failed", state: "JOB_STATE_FAILED" };
      },
      async getJobResult() {
        return { jobId: "grpc-failed", error: { errorCode: "OverlayFailed", message: "Overlay failed" } };
      },
      async cancelJob() {
        return { jobId: "grpc-failed", state: "JOB_STATE_CANCELLED" };
      },
    };
    const job = await createHonuaProcessRunner(createGeospatialGrpcProcessAdapter(processClient)).execute({
      plan: { planId: "failing-plan" },
    });
    await expect(job.results({ pollIntervalMs: 0 })).rejects.toMatchObject({
      name: "HonuaJobFailedError",
      status: "failed",
      errorCode: "OverlayFailed",
    });
  });
});
