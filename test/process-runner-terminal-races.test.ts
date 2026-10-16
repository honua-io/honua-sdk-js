import { describe, expect, it, vi } from "vitest";

import type { JobStatus } from "../src/contract/jobs.js";
import {
  createGeoServicesGpAdapter,
  createGeospatialGrpcProcessAdapter,
  createHonuaProcessRunner,
  createOgcProcessesAdapter,
} from "../src/core/process-runner.js";
import { jsonResponse, makeMockClient } from "./contract/shared.js";

const protocols = ["ogc-processes", "geoservices-gp", "geospatial-grpc"] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function racingJob(protocol: (typeof protocols)[number], poll: () => Promise<JobStatus>) {
  const cancel = vi.fn(async () => "dismissed" as const);
  if (protocol === "geospatial-grpc") {
    const state = (status: JobStatus) =>
      ({ running: "JOB_STATE_RUNNING", successful: "JOB_STATE_COMPLETED", dismissed: "JOB_STATE_CANCELLED" })[
        status as "running" | "successful" | "dismissed"
      ];
    const runner = createHonuaProcessRunner(
      createGeospatialGrpcProcessAdapter({
        submitJob: async () => ({ jobId: "race" }),
        getJob: async () => ({ jobId: "race", state: state(await poll()) }),
        getJobResult: async () => ({ jobId: "race", result: { value: 42 } }),
        cancelJob: async () => ({ jobId: "race", state: state(await cancel()) }),
      }),
    );
    return { job: runner.job("race"), cancel };
  }
  const client = makeMockClient({
    routes:
      protocol === "ogc-processes"
        ? [
            ["/ogc/processes/jobs/race/results", () => jsonResponse({ value: 42 })],
            [
              "/ogc/processes/jobs/race",
              async (_url, init) =>
                jsonResponse({
                  jobID: "race",
                  status: init?.method === "DELETE" ? await cancel() : await poll(),
                }),
            ],
          ]
        : [
            [
              "/jobs/race/cancel",
              async () => {
                await cancel();
                return jsonResponse({ jobId: "race", jobStatus: "esriJobCancelled" });
              },
            ],
            [
              "/jobs/race",
              async () =>
                jsonResponse({
                  jobId: "race",
                  jobStatus: (await poll()) === "successful" ? "esriJobSucceeded" : "esriJobExecuting",
                  results: { value: 42 },
                }),
            ],
          ],
  });
  const adapter =
    protocol === "ogc-processes"
      ? createOgcProcessesAdapter(client.ogcProcesses())
      : createGeoServicesGpAdapter(client.geoprocessing("Analysis", "Buffer"));
  return { job: createHonuaProcessRunner(adapter).job("race"), cancel };
}

describe.each(protocols)("%s terminal races", (protocol) => {
  it.each(["poll", "results"] as const)("keeps dismissal when an older %s response arrives", async (method) => {
    const old = deferred<JobStatus>();
    const started = deferred<void>();
    const { job, cancel } = racingJob(protocol, () => {
      started.resolve();
      return old.promise;
    });
    const watcher = vi.fn();
    job.watch(watcher);
    const pending =
      method === "poll"
        ? expect(job.poll()).resolves.toMatchObject({ status: "dismissed" })
        : expect(job.results({ maxAttempts: 1 })).rejects.toMatchObject({ status: "dismissed" });
    await started.promise;
    await expect(job.cancel()).resolves.toBe("dismissed");
    old.resolve("running");
    await pending;
    expect(job.status).toBe("dismissed");
    expect(watcher.mock.calls.map(([snapshot]) => snapshot.status)).toEqual(["dismissed"]);
    await expect(job.cancel()).resolves.toBe("dismissed");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps successful results when an older poll resolves after the newer terminal", async () => {
    const old = deferred<JobStatus>();
    const started = deferred<void>();
    let count = 0;
    const { job, cancel } = racingJob(protocol, () => {
      if (count++ > 0) return Promise.resolve("successful");
      started.resolve();
      return old.promise;
    });
    const watcher = vi.fn();
    job.watch(watcher);
    const first = job.poll();
    await started.promise;
    const terminal = await job.poll();
    expect(terminal.status).toBe("successful");
    old.resolve("running");
    await expect(first).resolves.toEqual(terminal);
    expect(job.status).toBe("successful");
    expect(watcher.mock.calls.map(([snapshot]) => snapshot.status)).toEqual(["successful"]);
    await expect(job.results()).resolves.toEqual(terminal.result);
    await expect(job.cancel()).resolves.toBe("successful");
    expect(cancel).not.toHaveBeenCalled();
  });
});
