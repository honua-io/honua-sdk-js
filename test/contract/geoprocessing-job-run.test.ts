import { describe, expect, it } from "vitest";

import type { IJobRun } from "../../src/contract/index.js";
import { createGeoServicesGpAdapter, createHonuaProcessRunner } from "../../src/core/process-runner.js";
import { HonuaGeoprocessingJobRun } from "../../src/core/surfaces.js";

import { jsonResponse, makeMockClient } from "./shared.js";

describe("geoprocessing / canonical IJobRun lifecycle", () => {
  it("executes an AI-selected Buffer through the Esri GPServer facade without changing IJobRun", async () => {
    let submitted: URL | undefined;
    const client = makeMockClient({
      routes: [
        [
          "/rest/services/geoprocessing/GPServer/Buffer/submitJob",
          (url) => {
            submitted = url;
            return jsonResponse({ jobId: "gp-buffer-1", jobStatus: "esriJobSubmitted" });
          },
        ],
        [
          "/rest/services/geoprocessing/GPServer/Buffer/jobs/gp-buffer-1/results/outputFeatureLayer",
          () => jsonResponse({ value: "data:application/geo+json;base64,e30=" }),
        ],
        [
          "/rest/services/geoprocessing/GPServer/Buffer/jobs/gp-buffer-1",
          () => jsonResponse({ jobId: "gp-buffer-1", jobStatus: "esriJobSucceeded" }),
        ],
      ],
    });
    const selectedByAi = {
      canonicalProcessId: "geometry.buffer",
      esriTaskName: "Buffer",
      // The server's task metadata owns this canonical parameter shape. The SDK
      // does not duplicate or guess the server-side GP translator.
      parameters: {
        wkb: "AQEAAABQ/Bhz15pewNDVVuwv40JA",
        srid: 4326,
        distance: 0.00025,
      },
      resultNames: ["outputFeatureLayer"] as const,
    };
    const runner = createHonuaProcessRunner(
      createGeoServicesGpAdapter(client.geoprocessing("geoprocessing", selectedByAi.esriTaskName)),
    );

    const job: IJobRun<Record<string, unknown>> = await runner.execute({
      processId: selectedByAi.canonicalProcessId,
      parameters: selectedByAi.parameters,
      resultNames: selectedByAi.resultNames,
    });
    const result = await job.results({ pollIntervalMs: 0 });

    expect(runner.protocol).toBe("geoservices-gp");
    expect(job.status).toBe("successful");
    expect(result.outputs.outputFeatureLayer).toEqual({ value: "data:application/geo+json;base64,e30=" });
    expect(submitted?.searchParams.get("wkb")).toBe(selectedByAi.parameters.wkb);
    expect(submitted?.searchParams.get("srid")).toBe("4326");
    expect(submitted?.searchParams.get("distance")).toBe("0.00025");
  });

  it("submits a GPServer task and polls/fetches results through IJobRun", async () => {
    const statuses = [
      {
        jobId: "gp-job-1",
        jobStatus: "esriJobExecuting",
        messages: [{ type: "esriJobMessageTypeInformative", description: "Running overlay" }],
      },
      {
        jobId: "gp-job-1",
        jobStatus: "esriJobSucceeded",
        messages: [{ type: "esriJobMessageTypeInformative", description: "Overlay complete" }],
      },
    ];
    let statusCount = 0;
    const client = makeMockClient({
      routes: [
        [
          "/rest/services/Analysis/GPServer/OverlayFacilities/submitJob",
          () => jsonResponse({ jobId: "gp-job-1", jobStatus: "esriJobSubmitted" }),
        ],
        [
          "/rest/services/Analysis/GPServer/OverlayFacilities/jobs/gp-job-1/results/outputLayer",
          () =>
            jsonResponse({
              value: {
                type: "FeatureCollection",
                features: [{ id: "facility-1", properties: { risk: "high" } }],
              },
            }),
        ],
        [
          "/rest/services/Analysis/GPServer/OverlayFacilities/jobs/gp-job-1",
          () => {
            const status = statuses[Math.min(statusCount, statuses.length - 1)];
            statusCount += 1;
            return jsonResponse(status);
          },
        ],
      ],
    });

    const job = await client.geoprocessing("Analysis", "OverlayFacilities").submit(
      {
        parameters: { Input_AOI: { xmin: -158, ymin: 21, xmax: -157, ymax: 22 }, Buffer_Distance: 250 },
      },
      { resultNames: ["outputLayer"], pollIntervalMs: 0 },
    );

    expect(job).toBeInstanceOf(HonuaGeoprocessingJobRun);
    expect(job.id).toBe("gp-job-1");
    expect(job.type).toBe("Analysis/OverlayFacilities");

    const observed: string[] = [];
    job.watch((snapshot) => observed.push(snapshot.status));

    const result = await (job as IJobRun<Record<string, unknown>>).results();
    expect(result.outputs.outputLayer).toMatchObject({
      value: {
        type: "FeatureCollection",
      },
    });
    expect(job.status).toBe("successful");
    expect(observed).toEqual(["running", "successful"]);
  });

  it("maps cancellation to dismissed and keeps cancel idempotent after terminal state", async () => {
    let cancelCount = 0;
    const client = makeMockClient({
      routes: [
        [
          "/rest/services/Analysis/GPServer/OverlayFacilities/submitJob",
          () => jsonResponse({ jobId: "gp-job-2", jobStatus: "esriJobExecuting" }),
        ],
        [
          "/rest/services/Analysis/GPServer/OverlayFacilities/jobs/gp-job-2/cancel",
          () => {
            cancelCount += 1;
            return jsonResponse({
              jobId: "gp-job-2",
              jobStatus: "esriJobCancelled",
              messages: [{ type: "esriJobMessageTypeInformative", description: "Cancelled by analyst" }],
            });
          },
        ],
      ],
    });

    const job = await client
      .geoprocessing("Analysis", "OverlayFacilities")
      .submit({ parameters: {} }, { pollIntervalMs: 0 });

    await expect(job.cancel()).resolves.toBe("dismissed");
    await expect(job.cancel()).resolves.toBe("dismissed");
    expect(cancelCount).toBe(1);
  });
});
