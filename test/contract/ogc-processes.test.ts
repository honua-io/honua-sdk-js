/**
 * OGC API Processes + canonical IJobRun conformance. Covers process
 * discovery, async execution, status polling, terminal-state results,
 * and idempotent cancellation. The acceptance criterion calls out that
 * the SDK must surface jobs through `IJobRun`, not an OGC-specific job
 * type — `instanceof` checks below assert that contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { HonuaJobPollTimeoutError, type IJobRun, type JobSnapshot, isJobTerminal } from "../../src/contract/index.js";
import { HonuaJobFailedError, HonuaOgcProcessJobRun } from "../../src/core/ogc-processes.js";
import type { HonuaOgcProcessJobStatus } from "../../src/core/types.js";

import { jsonResponse, makeMockClient } from "./shared.js";

afterEach(() => {
  vi.useRealTimers();
});

function processesListing() {
  return {
    processes: [
      { id: "buffer", title: "Buffer geometry", version: "1.0.0" },
      { id: "intersect", title: "Intersect geometries", version: "1.0.0" },
    ],
  };
}

function processDescription() {
  return {
    id: "buffer",
    title: "Buffer geometry",
    inputs: { feature: { schema: { type: "object" } } },
    outputs: { result: { schema: { type: "object" } } },
  };
}

describe("ogc-processes / discovery", () => {
  it("lists processes and returns process descriptions", async () => {
    const client = makeMockClient({
      routes: [
        ["/ogc/processes/processes/buffer", () => jsonResponse(processDescription())],
        ["/ogc/processes/processes", () => jsonResponse(processesListing())],
      ],
    });
    const processes = client.ogcProcesses();
    const list = await processes.list();
    expect(list.processes.map((p) => p.id)).toEqual(["buffer", "intersect"]);
    const description = await processes.describe("buffer");
    expect(description.id).toBe("buffer");
    expect(description.outputs).toBeDefined();
  });
});

describe("ogc-processes / IJobRun lifecycle", () => {
  it("returns an IJobRun-shaped handle from execute() — not an OGC-specific job type", async () => {
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () =>
            jsonResponse({
              jobID: "job-1",
              status: "running",
              processID: "buffer",
            }),
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({
      processId: "buffer",
      inputs: { feature: { type: "Point", coordinates: [0, 0] } },
      mode: "async",
    });
    // IJobRun exposes id/type/status/progress/poll/results/cancel/watch.
    expect(typeof job.id).toBe("string");
    expect(typeof job.type).toBe("string");
    expect(job.id).toBe("job-1");
    expect(job.type).toBe("buffer");
    expect(typeof job.poll).toBe("function");
    expect(typeof job.cancel).toBe("function");
    expect(typeof job.results).toBe("function");
    expect(typeof job.watch).toBe("function");
    // The constraint forbids exposing `OgcJobRun` as a top-level type;
    // the runner is reachable through `HonuaOgcProcessJobRun` only as an
    // implementation detail.
    expect(job).toBeInstanceOf(HonuaOgcProcessJobRun);
  });

  it("polls until the job reaches `successful` and surfaces outputs through the canonical Result", async () => {
    vi.useFakeTimers();
    const statuses: HonuaOgcProcessJobStatus[] = [
      { jobID: "job-2", status: "running", progress: 25, message: "buffering" },
      { jobID: "job-2", status: "running", progress: 75, message: "almost there" },
      { jobID: "job-2", status: "successful" },
    ];
    let pollCount = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () =>
            jsonResponse({
              jobID: "job-2",
              status: "running",
              processID: "buffer",
            }),
        ],
        [
          "/ogc/processes/jobs/job-2/results",
          () =>
            // OGC API Processes §7.11.1: the document-mode body is the
            // outputs map itself, keyed by output id.
            jsonResponse({ result: { type: "Polygon", coordinates: [[[0, 0]]] } }),
        ],
        [
          "/ogc/processes/jobs/job-2",
          () => {
            const status = statuses[Math.min(pollCount, statuses.length - 1)];
            pollCount += 1;
            return jsonResponse(status);
          },
        ],
      ],
    });

    const job = (await client.ogcProcesses().execute<Record<string, unknown>>({
      processId: "buffer",
      inputs: {},
      mode: "async",
    })) as IJobRun<Record<string, unknown>> & HonuaOgcProcessJobRun<Record<string, unknown>>;

    const observed: JobSnapshot<Record<string, unknown>>[] = [];
    job.watch((snapshot) => observed.push(snapshot));

    // Bypass the polling delay so the test stays deterministic.
    (job as unknown as { pollIntervalMs: number }).pollIntervalMs = 0;
    const result = await job.results();
    expect(result.outputs.result).toMatchObject({ type: "Polygon" });
    expect(job.status).toBe("successful");
    // The watcher should have observed both intermediate progress
    // updates and the populated terminal snapshot.
    expect(observed.some((s) => s.progress?.percent === 25)).toBe(true);
    expect(observed.some((s) => s.progress?.percent === 75)).toBe(true);
    expect(observed.some((s) => s.status === "successful" && s.result !== undefined)).toBe(true);
  });

  it("surfaces a failed job through HonuaJobFailedError with the server exception", async () => {
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-3", status: "running", processID: "buffer" }),
        ],
        [
          "/ogc/processes/jobs/job-3",
          () =>
            jsonResponse({
              jobID: "job-3",
              status: "failed",
              exception: { code: "InvalidParameterValue", message: "bad input" },
            }),
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    (job as unknown as { pollIntervalMs: number }).pollIntervalMs = 0;
    await expect(job.results()).rejects.toBeInstanceOf(HonuaJobFailedError);
    expect(job.status).toBe("failed");
  });

  it("cancel() flips the job to dismissed and is idempotent", async () => {
    let cancelCalls = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-4", status: "running", processID: "buffer" }),
        ],
        [
          "/ogc/processes/jobs/job-4",
          (_url, init) => {
            if (init?.method === "DELETE") {
              cancelCalls += 1;
              return jsonResponse({ jobID: "job-4", status: "dismissed" });
            }
            return jsonResponse({ jobID: "job-4", status: "running" });
          },
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    const status = await job.cancel();
    expect(status).toBe("dismissed");
    expect(job.status).toBe("dismissed");
    // Second cancel is a no-op — it sees the cached terminal snapshot.
    const second = await job.cancel();
    expect(second).toBe("dismissed");
    expect(cancelCalls).toBe(1);
  });

  it("isJobTerminal narrows the canonical status enum", () => {
    expect(isJobTerminal("accepted")).toBe(false);
    expect(isJobTerminal("running")).toBe(false);
    expect(isJobTerminal("successful")).toBe(true);
    expect(isJobTerminal("failed")).toBe(true);
    expect(isJobTerminal("dismissed")).toBe(true);
  });

  it("cancel() resolves the documented terminal race when the server returns 409", async () => {
    // honua-server returns 409 Conflict from DELETE /jobs/{id} when the
    // job already reached a terminal state (succeeded / failed /
    // dismissed). The runner must treat 409 as an idempotent race and
    // return the authoritative terminal status instead of re-throwing.
    let cancelCalls = 0;
    let statusCalls = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-race", status: "running", processID: "buffer" }),
        ],
        [
          "/ogc/processes/jobs/job-race",
          (_url, init) => {
            if (init?.method === "DELETE") {
              cancelCalls += 1;
              return new Response(JSON.stringify({ title: "Cannot dismiss completed job", status: 409 }), {
                status: 409,
                headers: { "Content-Type": "application/json" },
              });
            }
            statusCalls += 1;
            return jsonResponse({ jobID: "job-race", status: "successful" });
          },
        ],
        [
          "/ogc/processes/jobs/job-race/results",
          () => jsonResponse({ result: { type: "Point", coordinates: [0, 0] } }),
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    const terminal = await job.cancel();
    expect(cancelCalls).toBe(1);
    expect(statusCalls).toBeGreaterThanOrEqual(1);
    // The race resolves to the authoritative terminal status returned
    // from the subsequent GET /jobs/{id}, not to a thrown error.
    expect(terminal).toBe("successful");
    expect(job.status).toBe("successful");
  });

  it("rethrows 409 'Dismiss could not be confirmed' instead of swallowing it as a terminal race", async () => {
    // honua-server emits the same HTTP 409 status for three distinct
    // problem-details titles. Only the "Cannot dismiss completed job"
    // title is a benign terminal race; the other two surfaces (dismiss
    // unconfirmed, cancellation not supported) are real failures the
    // caller must see.
    let cancelCalls = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-unconf", status: "running", processID: "buffer" }),
        ],
        [
          "/ogc/processes/jobs/job-unconf",
          (_url, init) => {
            if (init?.method === "DELETE") {
              cancelCalls += 1;
              return new Response(
                JSON.stringify({
                  title: "Dismiss could not be confirmed",
                  detail: "backend dismissal could not be confirmed",
                  status: 409,
                }),
                { status: 409, headers: { "Content-Type": "application/json" } },
              );
            }
            return jsonResponse({ jobID: "job-unconf", status: "running" });
          },
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    await expect(job.cancel()).rejects.toMatchObject({ statusCode: 409 });
    expect(cancelCalls).toBe(1);
    // Status is still running — the failed cancel did not flip the job.
    expect(job.status).toBe("running");
  });

  it("rethrows 409 'Cancellation not supported' instead of swallowing it", async () => {
    let cancelCalls = 0;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-nosup", status: "running", processID: "buffer" }),
        ],
        [
          "/ogc/processes/jobs/job-nosup",
          (_url, init) => {
            if (init?.method === "DELETE") {
              cancelCalls += 1;
              return new Response(
                JSON.stringify({
                  title: "Cancellation not supported",
                  detail: "runs on backend 'gs-batch' which does not support dismissal",
                  status: 409,
                }),
                { status: 409, headers: { "Content-Type": "application/json" } },
              );
            }
            return jsonResponse({ jobID: "job-nosup", status: "running" });
          },
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    await expect(job.cancel()).rejects.toMatchObject({ statusCode: 409 });
    expect(cancelCalls).toBe(1);
    expect(job.status).toBe("running");
  });

  it("rethrows the 409 when the follow-up poll returns a non-terminal status", async () => {
    // If the server claims "Cannot dismiss completed job" but the
    // follow-up GET reports a non-terminal status, the claim cannot be
    // confirmed. The honest signal is the original 409, not a fabricated
    // running snapshot.
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-stale", status: "running", processID: "buffer" }),
        ],
        [
          "/ogc/processes/jobs/job-stale",
          (_url, init) => {
            if (init?.method === "DELETE") {
              return new Response(JSON.stringify({ title: "Cannot dismiss completed job", status: 409 }), {
                status: 409,
                headers: { "Content-Type": "application/json" },
              });
            }
            return jsonResponse({ jobID: "job-stale", status: "running" });
          },
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    await expect(job.cancel()).rejects.toMatchObject({ statusCode: 409 });
    expect(job.status).toBe("running");
  });

  it("rethrows the original 409 when the follow-up poll itself fails", async () => {
    // Same invariant family as the previous test: the cancel-side 409 is
    // the most honest signal we have. If the confirmation poll cannot run
    // (network blip, server outage), surface the 409 instead of letting a
    // poll-side error swallow the cancel-side conflict.
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-pollfail", status: "running", processID: "buffer" }),
        ],
        [
          "/ogc/processes/jobs/job-pollfail",
          (_url, init) => {
            if (init?.method === "DELETE") {
              return new Response(JSON.stringify({ title: "Cannot dismiss completed job", status: 409 }), {
                status: 409,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response("upstream unavailable", { status: 502 });
          },
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    await expect(job.cancel()).rejects.toMatchObject({ statusCode: 409 });
    expect(job.status).toBe("running");
  });

  it("accepts the empty `{}` results body honua-server emits for V1's value-less canonical process", async () => {
    // honua-server returns 200 OK + `{}` from /jobs/{id}/results until the
    // artifact store is wired up. The runner must surface `result.outputs = {}`
    // — not throw a parse error trying to dereference a missing `outputs`
    // wrapper.
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-empty", status: "running", processID: "buffer" }),
        ],
        ["/ogc/processes/jobs/job-empty/results", () => jsonResponse({})],
        ["/ogc/processes/jobs/job-empty", () => jsonResponse({ jobID: "job-empty", status: "successful" })],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    (job as unknown as { pollIntervalMs: number }).pollIntervalMs = 0;
    const result = await job.results();
    expect(result.outputs).toEqual({});
    expect(job.status).toBe("successful");
  });

  it("populates HonuaJobFailedError from statusInfo.message when the server omits `exception`", async () => {
    // honua-server's StatusInfo DTO has no `exception` field; failure
    // text rides on `message`. Terminal-failure snapshots must fall back
    // to that so `HonuaJobFailedError` carries the real reason.
    const client = makeMockClient({
      routes: [
        [
          "/ogc/processes/processes/buffer/execution",
          () => jsonResponse({ jobID: "job-msg", status: "running", processID: "buffer" }),
        ],
        [
          "/ogc/processes/jobs/job-msg",
          () =>
            jsonResponse({
              jobID: "job-msg",
              status: "failed",
              message: "input geometry is not closed",
            }),
        ],
      ],
    });
    const job = await client.ogcProcesses().execute({ processId: "buffer", inputs: {}, mode: "async" });
    (job as unknown as { pollIntervalMs: number }).pollIntervalMs = 0;
    await expect(job.results()).rejects.toMatchObject({
      name: "HonuaJobFailedError",
      status: "failed",
      errorCode: "JobFailed",
      message: expect.stringContaining("input geometry is not closed"),
    });
  });
});

describe("ogc-processes / runUntilTerminal bounds", () => {
  const runningStatus: HonuaOgcProcessJobStatus = { jobID: "job-x", status: "running", processID: "buffer" };

  function makeNeverTerminalJob(
    pollFn: (jobId: string, signal?: AbortSignal) => Promise<HonuaOgcProcessJobStatus>,
  ): HonuaOgcProcessJobRun {
    const client = makeMockClient({ routes: [] });
    return new HonuaOgcProcessJobRun({ client, jobId: "job-x", processId: "buffer", pollIntervalMs: 0, pollFn });
  }

  it("stops after maxAttempts when the job never reaches a terminal state", async () => {
    let polls = 0;
    const job = makeNeverTerminalJob(async () => {
      polls += 1;
      return runningStatus;
    });
    await expect(job.results({ maxAttempts: 3 })).rejects.toMatchObject({
      name: "HonuaJobPollTimeoutError",
      reason: "max-attempts",
    });
    expect(polls).toBe(3);
  });

  it("stops once the deadline elapses", async () => {
    const job = makeNeverTerminalJob(async () => runningStatus);
    await expect(job.results({ deadlineMs: 0 })).rejects.toBeInstanceOf(HonuaJobPollTimeoutError);
  });

  it("stops when the caller aborts the poll loop", async () => {
    const controller = new AbortController();
    const job = makeNeverTerminalJob(async () => {
      controller.abort();
      return runningStatus;
    });
    await expect(job.results({ signal: controller.signal, maxAttempts: 100 })).rejects.toMatchObject({
      reason: "aborted",
    });
  });

  it("does not poison results() after a bounded attempt is exhausted", async () => {
    let polls = 0;
    const statuses: HonuaOgcProcessJobStatus[] = [
      runningStatus,
      { jobID: "job-x", status: "successful", processID: "buffer" },
    ];
    const client = makeMockClient({
      routes: [["/ogc/processes/jobs/job-x/results", () => jsonResponse({ out: 1 })]],
    });
    const job = new HonuaOgcProcessJobRun({
      client,
      jobId: "job-x",
      processId: "buffer",
      pollIntervalMs: 0,
      pollFn: async () => statuses[Math.min(polls++, statuses.length - 1)],
    });
    // First call is capped before the job terminates.
    await expect(job.results({ maxAttempts: 1 })).rejects.toBeInstanceOf(HonuaJobPollTimeoutError);
    // A subsequent unbounded call must be able to retry rather than replay the rejection.
    const result = await job.results();
    expect(result.outputs).toMatchObject({ out: 1 });
  });
});
