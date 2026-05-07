import { describe, expect, it } from "vitest";

import type { IJobRun } from "../../src/contract/index.js";
import { HonuaGeoprocessingJobRun } from "../../src/core/surfaces.js";

import { jsonResponse, makeMockClient } from "./shared.js";

describe("geoprocessing / canonical IJobRun lifecycle", () => {
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
