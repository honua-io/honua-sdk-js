import type {
  JobProgress,
  JobResult,
  JobResultsOptions,
  JobSnapshot,
  JobSnapshotListener,
  JobStatus,
} from "../contract/jobs.js";
import { HonuaJobPollTimeoutError, isJobTerminal } from "../contract/jobs.js";
import { HonuaJobFailedError } from "./job-run-errors.js";

const DEFAULT_JOB_DEADLINE_MS = 600_000;

export interface JobRunLifecycleOptions<T> {
  readonly id: string;
  readonly initialStatus: JobStatus;
  readonly initialProgress?: JobProgress;
  readonly pollIntervalMs: number | (() => number);
  readonly pollBudget?: JobResultsOptions;
  readonly poll: (signal?: AbortSignal) => Promise<JobSnapshot<T>>;
}

/** Internal protocol-neutral state machine shared by every remote IJobRun. */
export class JobRunLifecycle<T> {
  private currentStatus: JobStatus;
  private currentProgress: JobProgress | undefined;
  private terminalSnapshot: JobSnapshot<T> | undefined;
  private terminalPromise: Promise<JobResult<T>> | undefined;
  private cancelPromise: Promise<JobStatus> | undefined;
  private readonly listeners = new Set<JobSnapshotListener<T>>();

  public constructor(private readonly options: JobRunLifecycleOptions<T>) {
    this.currentStatus = options.initialStatus;
    this.currentProgress = options.initialProgress;
  }

  public get status(): JobStatus {
    return this.currentStatus;
  }
  public get progress(): JobProgress | undefined {
    return this.currentProgress;
  }
  public get terminal(): JobSnapshot<T> | undefined {
    return this.terminalSnapshot;
  }

  public watch(listener: JobSnapshotListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async poll(): Promise<JobSnapshot<T>> {
    if (this.terminalSnapshot) return this.terminalSnapshot;
    return this.observe(await this.options.poll());
  }

  public observe(snapshot: JobSnapshot<T>): JobSnapshot<T> {
    this.currentStatus = snapshot.status;
    this.currentProgress = snapshot.progress;
    if (isJobTerminal(snapshot.status)) this.terminalSnapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Observers cannot disrupt the lifecycle. */
      }
    }
    return snapshot;
  }

  public async cancel(cancel: () => Promise<JobSnapshot<T>>): Promise<JobStatus> {
    if (this.terminalSnapshot) return this.currentStatus;
    if (!this.cancelPromise) {
      this.cancelPromise = cancel()
        .then((snapshot) => {
          // A poll may have observed an authoritative terminal while the
          // transport cancellation was in flight. Never let the older cancel
          // response overwrite that terminal race winner.
          if (this.terminalSnapshot) return this.currentStatus;
          const status = this.observe(snapshot).status;
          if (!isJobTerminal(status)) this.cancelPromise = undefined;
          return status;
        })
        .catch((error) => {
          this.cancelPromise = undefined;
          throw error;
        });
    }
    return this.cancelPromise;
  }

  public results(overrides: JobResultsOptions = {}): Promise<JobResult<T>> {
    if (!this.terminalPromise) {
      const options = this.resolveBudget(overrides);
      this.terminalPromise = this.runUntilTerminal(options).catch((error) => {
        this.terminalPromise = undefined;
        throw error;
      });
    }
    return this.terminalPromise;
  }

  private resolveBudget(overrides: JobResultsOptions): JobResultsOptions {
    const merged = { ...this.options.pollBudget, ...overrides };
    return merged.deadlineMs !== undefined || merged.maxAttempts !== undefined
      ? merged
      : { ...merged, deadlineMs: DEFAULT_JOB_DEADLINE_MS };
  }

  private async runUntilTerminal(options: JobResultsOptions): Promise<JobResult<T>> {
    const configuredInterval =
      typeof this.options.pollIntervalMs === "function" ? this.options.pollIntervalMs() : this.options.pollIntervalMs;
    const baseIntervalMs = options.pollIntervalMs ?? configuredInterval;
    const maxIntervalMs = options.maxPollIntervalMs ?? Math.max(baseIntervalMs, 30_000);
    const startedAt = Date.now();
    let attempts = 0;
    while (!this.terminalSnapshot) {
      this.assertWithinBudget(options, attempts, startedAt);
      let snapshot: JobSnapshot<T>;
      try {
        snapshot = await this.pollWithinBudget(options, startedAt);
      } catch (error) {
        if (options.signal?.aborted) this.throwTimeout("aborted", options);
        throw error;
      }
      attempts += 1;
      this.observe(snapshot);
      if (this.terminalSnapshot) break;
      this.assertWithinBudget(options, attempts, startedAt);
      const intervalMs = Math.min(maxIntervalMs, baseIntervalMs * 2 ** (attempts - 1));
      if (intervalMs > 0) await abortableDelay(intervalMs, options.signal);
    }
    const terminal = this.terminalSnapshot;
    if (terminal.status === "successful" && terminal.result) return terminal.result;
    const error = terminal.error;
    throw new HonuaJobFailedError(
      error?.message ?? `Job ended in non-success terminal state: ${terminal.status}`,
      terminal.status,
      error?.code,
      error?.details,
    );
  }

  private async pollWithinBudget(options: JobResultsOptions, startedAt: number): Promise<JobSnapshot<T>> {
    if (options.signal === undefined && options.deadlineMs === undefined) return this.options.poll();

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectBoundary!: (error: PollBoundaryReached) => void;
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject;
    });
    const reachBoundary = (reason: "aborted" | "deadline") => {
      controller.abort();
      rejectBoundary(new PollBoundaryReached(reason));
    };
    const onAbort = () => reachBoundary("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.deadlineMs !== undefined) {
      const remainingMs = Math.max(0, options.deadlineMs - (Date.now() - startedAt));
      timer = setTimeout(() => reachBoundary("deadline"), remainingMs);
    }

    try {
      return await Promise.race([this.options.poll(controller.signal), boundary]);
    } catch (error) {
      if (error instanceof PollBoundaryReached) this.throwTimeout(error.reason, options);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private assertWithinBudget(options: JobResultsOptions, attempts: number, startedAt: number): void {
    if (options.signal?.aborted) this.throwTimeout("aborted", options);
    if (options.maxAttempts !== undefined && attempts >= options.maxAttempts)
      this.throwTimeout("max-attempts", options);
    if (options.deadlineMs !== undefined && Date.now() - startedAt >= options.deadlineMs)
      this.throwTimeout("deadline", options);
  }

  private throwTimeout(reason: "aborted" | "deadline" | "max-attempts", options: JobResultsOptions): never {
    const suffix =
      reason === "aborted"
        ? "poll aborted"
        : reason === "deadline"
          ? `did not reach a terminal state within ${options.deadlineMs}ms`
          : `did not reach a terminal state within ${options.maxAttempts} poll attempt(s)`;
    throw new HonuaJobPollTimeoutError(`Job ${this.options.id} ${suffix}`, reason, this.options.id, this.currentStatus);
  }
}

class PollBoundaryReached extends Error {
  public constructor(public readonly reason: "aborted" | "deadline") {
    super(reason);
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
