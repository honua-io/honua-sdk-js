import { describe, expect, it, vi } from "vitest";
import { HonuaJobPollTimeoutError } from "../src/contract/jobs.js";
import type { JobSnapshot, JobStatus } from "../src/contract/jobs.js";
import { JobRunLifecycle } from "../src/core/job-run-lifecycle.js";

function lifecycle(statuses: JobSnapshot<number>[]) {
  let polls = 0;
  const run = new JobRunLifecycle<number>({
    id: "job-parity",
    initialStatus: "accepted",
    pollIntervalMs: 0,
    poll: async () => statuses[Math.min(polls++, statuses.length - 1)] as JobSnapshot<number>,
  });
  return { run, polls: () => polls };
}

describe("shared IJobRun lifecycle parity kernel", () => {
  it.each([
    ["failed", "ProcessFailed"],
    ["dismissed", "ProcessDismissed"],
  ] as const)("throws the exported typed failure for %s terminals", async (status, code) => {
    const { run } = lifecycle([{ status, error: { code, message: `${status} by server` } }]);
    await expect(run.results()).rejects.toMatchObject({
      name: "HonuaJobFailedError",
      status,
      errorCode: code,
    });
  });

  it.each([
    ["max-attempts", { maxAttempts: 1 }],
    ["deadline", { deadlineMs: 0 }],
  ] as const)("enforces the %s bound", async (reason, options) => {
    const { run } = lifecycle([{ status: "running" }]);
    await expect(run.results({ ...options, pollIntervalMs: 0 })).rejects.toMatchObject({
      name: "HonuaJobPollTimeoutError",
      reason,
    });
  });

  it("maps aborts to the shared poll-timeout error", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, polls } = lifecycle([{ status: "running" }]);
    await expect(run.results({ signal: controller.signal })).rejects.toMatchObject({ reason: "aborted" });
    expect(polls()).toBe(0);
  });

  it("resets the terminal promise after timeout so callers can retry", async () => {
    const { run } = lifecycle([{ status: "running" }, { status: "successful", result: { outputs: { value: 42 } } }]);
    await expect(run.results({ maxAttempts: 1 })).rejects.toBeInstanceOf(HonuaJobPollTimeoutError);
    await expect(run.results()).resolves.toEqual({ outputs: { value: 42 } });
  });

  it("isolates listener exceptions from polling and other listeners", async () => {
    const { run } = lifecycle([{ status: "running", progress: { percent: 25 } }]);
    const observer = vi.fn();
    run.watch(() => {
      throw new Error("consumer bug");
    });
    run.watch(observer);
    await expect(run.poll()).resolves.toMatchObject({ status: "running" });
    expect(observer).toHaveBeenCalledOnce();
  });

  it.each(["successful", "failed", "dismissed"] as const)(
    "keeps the observed %s terminal when cancellation loses a race",
    async (status) => {
      const terminal: JobSnapshot<number> =
        status === "successful"
          ? { status, result: { outputs: {} } }
          : { status, error: { code: "Terminal", message: status } };
      const { run } = lifecycle([terminal]);
      await run.poll();
      const cancel = vi.fn(async () => ({ status: "dismissed" as JobStatus }));
      await expect(run.cancel(cancel)).resolves.toBe(status);
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it("coalesces concurrent cancellation races into one transport request", async () => {
    const { run } = lifecycle([{ status: "running" }]);
    let release!: (snapshot: JobSnapshot<number>) => void;
    const pending = new Promise<JobSnapshot<number>>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => pending);
    const first = run.cancel(cancel);
    const second = run.cancel(cancel);
    release({ status: "dismissed" });
    await expect(Promise.all([first, second])).resolves.toEqual(["dismissed", "dismissed"]);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
