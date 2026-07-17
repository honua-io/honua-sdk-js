/**
 * OGC API Processes surface. Process discovery, execution, and async
 * job tracking. Per the ticket constraint, async executions return an
 * `IJobRun` (the canonical async-operation surface) rather than an
 * OGC-specific job type.
 *
 * @module
 */

import type {
  IJobRun,
  JobError,
  JobProgress,
  JobResult,
  JobResultsOptions,
  JobSnapshot,
  JobSnapshotListener,
  JobStatus,
} from "../contract/jobs.js";
import { HonuaJobPollTimeoutError, isJobTerminal } from "../contract/jobs.js";
import type { HonuaClient } from "./client.js";
import { HonuaSdkError, withHonuaErrorClassification } from "./error-base.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type {
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaOgcProcessDescription,
  HonuaOgcProcessJobAccepted,
  HonuaOgcProcessJobResults,
  HonuaOgcProcessJobStatus,
  HonuaOgcProcessesResponse,
  OgcMetadataRequest,
  OgcProcessExecuteRequest,
  OgcProcessStatus,
} from "./types.js";
import { createOgcMetadataParams, mergeHeaders } from "./wire-shared.js";

export interface HonuaOgcProcessesOptions {
  client: HonuaClient;
}

export interface HonuaOgcProcessJobOptions {
  client: HonuaClient;
  jobId: string;
  /** Process identifier the job was created from, when known. */
  processId?: string;
  /** Initial server snapshot, as returned from `executeOgcProcess`. */
  initialStatus?: HonuaOgcProcessJobStatus;
  /** Default `pollIntervalMs` for `results()`. */
  pollIntervalMs?: number;
  /** Override of the default polling behavior; useful in tests. */
  pollFn?: (jobId: string, signal?: AbortSignal) => Promise<HonuaOgcProcessJobStatus>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Honua facade path prefix for OGC API Processes. */
const PROCESSES_FACADE_BASE = "/ogc/processes";

/**
 * Resolve the OGC API Processes path prefix: the caller-supplied raw `basePath`
 * (a `discoverOgcProcesses()`-discovered third-party service root) or the Honua
 * facade default. Trailing slashes are trimmed so a discovered root and the
 * facade compose the same sub-paths. Mirrors the OGC API Records seam.
 */
function processesBase(request: { basePath?: string }): string {
  // An omitted basePath uses the Honua facade; an explicit "" is a legitimate
  // root-mounted raw service and must NOT fall back to the facade prefix.
  if (request.basePath === undefined) return PROCESSES_FACADE_BASE;
  const base = request.basePath;
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end--;
  return base.slice(0, end);
}

/** Cache-key discriminator so a discovered root never collides with the facade. */
function processesBaseKey(request: { basePath?: string }): string {
  const base = processesBase(request);
  return base === PROCESSES_FACADE_BASE ? "" : `${base}:`;
}

/** Top-level OGC API Processes handle. */
export class HonuaOgcProcesses {
  public readonly client: HonuaClient;

  public constructor(options: HonuaOgcProcessesOptions) {
    this.client = options.client;
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return this.client.getOgcProcessesLanding(request);
  }

  public async conformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return this.client.getOgcProcessesConformance(request);
  }

  public async list(request: OgcMetadataRequest = {}): Promise<HonuaOgcProcessesResponse> {
    return this.client.listOgcProcesses(request);
  }

  public async describe(processId: string, request: OgcMetadataRequest = {}): Promise<HonuaOgcProcessDescription> {
    return this.client.getOgcProcess({ ...request, processId });
  }

  /**
   * Submit a process for execution. Always returns an `IJobRun`: honua-server
   * is async-only (advertises `jobControlOptions: ['async-execute', 'dismiss']`),
   * so the runner polls for the terminal snapshot regardless of whether
   * `mode` is `"async"` or `"auto"`.
   */
  public async execute<T = unknown>(request: OgcProcessExecuteRequest): Promise<IJobRun<T>> {
    const accepted = await this.client.executeOgcProcess(request);
    return new HonuaOgcProcessJobRun<T>({
      client: this.client,
      jobId: accepted.jobID,
      processId: accepted.processID ?? request.processId,
      initialStatus: accepted.statusInfo ?? {
        jobID: accepted.jobID,
        processID: accepted.processID ?? request.processId,
        status: accepted.status,
      },
    });
  }

  /** Adopt an existing job by id (useful when reconnecting after navigation). */
  public job<T = unknown>(jobId: string, options: { processId?: string } = {}): IJobRun<T> {
    return new HonuaOgcProcessJobRun<T>({
      client: this.client,
      jobId,
      processId: options.processId,
    });
  }
}

/**
 * `IJobRun` implementation backed by OGC API Processes 1.0 status / result
 * endpoints. Watchers receive the latest `JobSnapshot` when status,
 * progress, or terminal result changes; cancel is idempotent and races
 * the server's `dismissed` response against any concurrent terminal
 * transition.
 */
export class HonuaOgcProcessJobRun<T = unknown> implements IJobRun<T> {
  public readonly id: string;
  public readonly type: string;

  private readonly client: HonuaClient;
  private readonly pollIntervalMs: number;
  private readonly pollFn: (jobId: string, signal?: AbortSignal) => Promise<HonuaOgcProcessJobStatus>;
  private currentStatus: JobStatus;
  private currentProgress: JobProgress | undefined;
  private terminalSnapshot: JobSnapshot<T> | undefined;
  private terminalPromise: Promise<JobResult<T>> | undefined;
  private readonly listeners = new Set<JobSnapshotListener<T>>();

  public constructor(options: HonuaOgcProcessJobOptions) {
    this.client = options.client;
    this.id = options.jobId;
    this.type = options.processId ?? options.initialStatus?.processID ?? "unknown";
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollFn = options.pollFn ?? ((jobId, signal) => options.client.getOgcProcessJob({ jobId, signal }));
    const initial = options.initialStatus;
    this.currentStatus = (initial?.status as JobStatus) ?? "accepted";
    this.currentProgress = progressFromOgcStatus(initial);
  }

  public get status(): JobStatus {
    return this.currentStatus;
  }

  public get progress(): JobProgress | undefined {
    return this.currentProgress;
  }

  public async poll(): Promise<JobSnapshot<T>> {
    if (this.terminalSnapshot) {
      return this.terminalSnapshot;
    }
    const ogcStatus = await this.pollFn(this.id);
    return this.handleOgcStatus(ogcStatus);
  }

  public watch(listener: JobSnapshotListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async results(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    if (!this.terminalPromise) {
      // Reset the cached promise if the poll loop rejects (abort / deadline /
      // attempt cap) so a later results() call can retry rather than being
      // permanently poisoned by a transient cancellation.
      this.terminalPromise = this.runUntilTerminal(options).catch((error) => {
        this.terminalPromise = undefined;
        throw error;
      });
    }
    return this.terminalPromise;
  }

  public async cancel(): Promise<JobStatus> {
    if (this.terminalSnapshot) {
      return this.currentStatus;
    }
    try {
      const cancelled = await this.client.cancelOgcProcessJob({ jobId: this.id });
      const snapshot = await this.handleOgcStatus(cancelled);
      return snapshot.status;
    } catch (error) {
      const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
      // `IJobRun.cancel` is documented as idempotent: when the job is
      // already gone (404), return the cached status. honua-server uses
      // 409 for three distinct cases — only the terminal-race case is
      // benign:
      //   - "Cannot dismiss completed job" → terminal race; poll for the
      //     authoritative terminal status and return it.
      //   - "Dismiss could not be confirmed" → backend dismissal request
      //     was issued but did not confirm; rethrow so callers can retry.
      //   - "Cancellation not supported" → backend lacks cancel support;
      //     rethrow so callers can branch.
      // Any 409 with an unknown title also rethrows. The terminal-race
      // branch only swallows the 409 when the follow-up poll reaches a
      // terminal status; a non-terminal poll or a poll failure means the
      // "completed job" claim cannot be confirmed and the original 409
      // is the most honest signal.
      if (statusCode === 404) {
        return this.currentStatus;
      }
      if (statusCode === 409 && isCompletedJobConflict(error)) {
        let fresh: HonuaOgcProcessJobStatus;
        try {
          fresh = await this.pollFn(this.id);
        } catch {
          // Server claimed the job is in a terminal state but the
          // follow-up poll could not confirm it. Surface the original
          // 409 instead of letting the poll-side error swallow it.
          throw error;
        }
        const snapshot = await this.handleOgcStatus(fresh);
        if (!isJobTerminal(snapshot.status)) {
          throw error;
        }
        return snapshot.status;
      }
      throw error;
    }
  }

  private async runUntilTerminal(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    const { signal } = options;
    const baseIntervalMs = options.pollIntervalMs ?? this.pollIntervalMs;
    const maxIntervalMs = options.maxPollIntervalMs ?? Math.max(baseIntervalMs, 30_000);
    const startedAt = Date.now();
    let attempts = 0;

    while (!this.terminalSnapshot) {
      if (signal?.aborted) {
        throw new HonuaJobPollTimeoutError(`Job ${this.id} poll aborted`, "aborted", this.id, this.currentStatus);
      }
      if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) {
        throw new HonuaJobPollTimeoutError(
          `Job ${this.id} did not reach a terminal state within ${options.maxAttempts} poll attempt(s)`,
          "max-attempts",
          this.id,
          this.currentStatus,
        );
      }

      let ogcStatus: HonuaOgcProcessJobStatus;
      try {
        ogcStatus = await this.pollFn(this.id, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw new HonuaJobPollTimeoutError(`Job ${this.id} poll aborted`, "aborted", this.id, this.currentStatus);
        }
        throw error;
      }
      attempts += 1;
      await this.handleOgcStatus(ogcStatus);
      if (this.terminalSnapshot) break;

      if (options.deadlineMs !== undefined && Date.now() - startedAt >= options.deadlineMs) {
        throw new HonuaJobPollTimeoutError(
          `Job ${this.id} did not reach a terminal state within ${options.deadlineMs}ms`,
          "deadline",
          this.id,
          this.currentStatus,
        );
      }

      // Capped exponential backoff instead of a fixed interval.
      const intervalMs = Math.min(maxIntervalMs, baseIntervalMs * 2 ** (attempts - 1));
      if (intervalMs > 0) {
        await delay(intervalMs, signal);
      }
    }
    if (this.terminalSnapshot.status === "successful" && this.terminalSnapshot.result) {
      return this.terminalSnapshot.result;
    }
    throw makeJobFailedError(this.terminalSnapshot);
  }

  /**
   * Translate an OGC `statusInfo` payload onto the canonical snapshot
   * surface, fire watchers, and (for `successful` terminals) fetch the
   * result document inline so the snapshot's `result.outputs` is
   * populated by the time `runUntilTerminal` / `poll` resolves.
   */
  private async handleOgcStatus(ogcStatus: HonuaOgcProcessJobStatus): Promise<JobSnapshot<T>> {
    const status = (ogcStatus.status as JobStatus) ?? "accepted";
    const progress = progressFromOgcStatus(ogcStatus);
    this.currentStatus = status;
    this.currentProgress = progress;

    if (status === "successful") {
      try {
        // Per OGC API Processes §7.11.1 the document-mode result body is the
        // outputs map itself (honua-server returns `{}` for the canonical
        // V1 process; populated maps are keyed by output id). Wrap it into
        // the canonical `JobResult.outputs` envelope.
        const results = await this.client.getOgcProcessJobResults({ jobId: this.id });
        const snapshot: JobSnapshot<T> = {
          status: "successful",
          progress,
          result: { outputs: results as Record<string, T> },
        };
        this.terminalSnapshot = snapshot;
        this.notify(snapshot);
        return snapshot;
      } catch (error) {
        const failure: JobSnapshot<T> = {
          status: "failed",
          progress,
          error: {
            code: (error as { name?: string } | undefined)?.name ?? "ResultsFetchFailed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
        this.currentStatus = "failed";
        this.terminalSnapshot = failure;
        this.notify(failure);
        return failure;
      }
    }

    if (status === "failed" || status === "dismissed") {
      const error = terminalJobError(status, ogcStatus);
      const snapshot: JobSnapshot<T> = {
        status,
        progress,
        ...(error ? { error } : {}),
      };
      this.terminalSnapshot = snapshot;
      this.notify(snapshot);
      return snapshot;
    }

    const snapshot: JobSnapshot<T> = { status, progress };
    this.notify(snapshot);
    return snapshot;
  }

  private notify(snapshot: JobSnapshot<T>): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener exceptions must not break the runner; log silently.
      }
    }
  }
}

/** Error thrown when `IJobRun.results()` resolves a non-success terminal. */
export class HonuaJobFailedError extends HonuaSdkError {
  public declare readonly status: JobStatus;
  public declare readonly errorCode: string | undefined;
  public declare readonly details: unknown;

  public constructor(message: string, status: JobStatus, errorCode?: string, details?: unknown) {
    super(
      "core.job-failed",
      message,
      withHonuaErrorClassification(
        { context: { status, errorCode } },
        "core.job-failed",
        "HonuaJobFailedError",
        "core",
        "protocol",
        false,
      ),
    );
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}

/**
 * Honua-server emits problem-details JSON for DELETE /jobs/{id} 409s. The
 * `title` distinguishes the benign terminal race ("Cannot dismiss
 * completed job") from non-benign 409s ("Dismiss could not be confirmed",
 * "Cancellation not supported"). The detail text mirrors the title
 * ("terminal state '...'") so we accept either as confirmation.
 */
function isCompletedJobConflict(error: unknown): boolean {
  const body = (error as { body?: unknown } | undefined)?.body;
  if (!body || typeof body !== "object") return false;
  const title = (body as { title?: unknown }).title;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof title === "string" && /cannot dismiss completed job/i.test(title)) {
    return true;
  }
  if (typeof detail === "string" && /terminal state/i.test(detail)) {
    return true;
  }
  return false;
}

function terminalJobError(status: JobStatus, ogcStatus: HonuaOgcProcessJobStatus): JobError | undefined {
  if (ogcStatus.exception) {
    return { ...ogcStatus.exception };
  }
  // honua-server emits failure text as `statusInfo.message` (its
  // StatusInfo DTO has no `exception` field). Fall back to the progress
  // message so `HonuaJobFailedError.message` carries the server reason
  // instead of the generic "non-success terminal state" default.
  if (typeof ogcStatus.message === "string" && ogcStatus.message.length > 0) {
    return {
      code: status === "dismissed" ? "JobDismissed" : "JobFailed",
      message: ogcStatus.message,
    };
  }
  return undefined;
}

function progressFromOgcStatus(ogcStatus: HonuaOgcProcessJobStatus | undefined): JobProgress | undefined {
  if (!ogcStatus) return undefined;
  const out: JobProgress = {};
  if (typeof ogcStatus.progress === "number" && Number.isFinite(ogcStatus.progress)) {
    out.percent = clampPercent(ogcStatus.progress);
  }
  if (ogcStatus.message !== undefined) out.message = ogcStatus.message;
  if (ogcStatus.updated !== undefined) out.updatedAt = ogcStatus.updated;
  if (out.percent === undefined && out.message === undefined && out.updatedAt === undefined) {
    return undefined;
  }
  return out;
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function makeJobFailedError<T>(snapshot: JobSnapshot<T>): HonuaJobFailedError {
  const error: JobError | undefined = snapshot.error;
  const message = error?.message ?? `Job ended in non-success terminal state: ${snapshot.status}`;
  return new HonuaJobFailedError(message, snapshot.status, error?.code, error?.details);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
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

export function createHonuaOgcProcesses(client: HonuaClient): HonuaOgcProcesses {
  return new HonuaOgcProcesses({ client });
}

// Type-only re-export so adapter map augmentation in `contract/source.ts`
// can reference the OGC processes runner without importing the full
// surface module.
export type HonuaOgcProcessesAdapter = HonuaOgcProcesses;
export type { OgcProcessStatus };

// ── OGC API Processes wire methods ──────────────────────────────

export async function getOgcProcessesLanding(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcLandingResponse> {
  const params = createOgcMetadataParams(request);
  const base = processesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    `ogc-processes:landing:${processesBaseKey(request)}${params.toString()}`,
    `${base}?${params.toString()}`,
    request,
  );
}

export async function getOgcProcessesConformance(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcConformanceResponse> {
  const params = createOgcMetadataParams(request);
  const base = processesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
    `ogc-processes:conformance:${processesBaseKey(request)}${params.toString()}`,
    `${base}/conformance?${params.toString()}`,
    request,
  );
}

export async function listOgcProcesses(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcProcessesResponse> {
  const params = createOgcMetadataParams(request);
  const base = processesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcProcessesResponse>(
    `ogc-processes:processes:${processesBaseKey(request)}${params.toString()}`,
    `${base}/processes?${params.toString()}`,
    request,
  );
}

export async function getOgcProcess(
  transport: HonuaProtocolTransport,
  request: { processId: string } & OgcMetadataRequest,
): Promise<HonuaOgcProcessDescription> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcProcessDescription>(
    `ogc-processes:process:${request.processId}:${params.toString()}`,
    `/ogc/processes/processes/${encodeURIComponent(request.processId)}?${params.toString()}`,
    request,
  );
}

export async function executeOgcProcess(
  transport: HonuaProtocolTransport,
  request: OgcProcessExecuteRequest,
): Promise<HonuaOgcProcessJobAccepted> {
  const headers = mergeHeaders(
    { "Content-Type": "application/json", Accept: "application/json" },
    request.headers,
    preferHeaderForExecute(request),
  );
  const path = `/ogc/processes/processes/${encodeURIComponent(request.processId)}/execution`;
  // honua-server only supports `response: "document"` and rejects "raw"
  // with HTTP 501; the SDK pins the supported value here.
  const body = JSON.stringify({
    inputs: request.inputs ?? {},
    outputs: request.outputs,
    response: "document",
  });
  return transport.requestJson<HonuaOgcProcessJobAccepted>("POST", path, { headers, body }, request.signal);
}

export async function getOgcProcessJob(
  transport: HonuaProtocolTransport,
  request: {
    jobId: string;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  },
): Promise<HonuaOgcProcessJobStatus> {
  const params = createOgcMetadataParams(request);
  return transport.requestJson<HonuaOgcProcessJobStatus>(
    "GET",
    `/ogc/processes/jobs/${encodeURIComponent(request.jobId)}?${params.toString()}`,
    undefined,
    request.signal,
  );
}

export async function getOgcProcessJobResults(
  transport: HonuaProtocolTransport,
  request: {
    jobId: string;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  },
): Promise<HonuaOgcProcessJobResults> {
  const params = createOgcMetadataParams(request);
  return transport.requestJson<HonuaOgcProcessJobResults>(
    "GET",
    `/ogc/processes/jobs/${encodeURIComponent(request.jobId)}/results?${params.toString()}`,
    undefined,
    request.signal,
  );
}

export async function cancelOgcProcessJob(
  transport: HonuaProtocolTransport,
  request: {
    jobId: string;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  },
): Promise<HonuaOgcProcessJobStatus> {
  const params = createOgcMetadataParams(request);
  return transport.requestJson<HonuaOgcProcessJobStatus>(
    "DELETE",
    `/ogc/processes/jobs/${encodeURIComponent(request.jobId)}?${params.toString()}`,
    undefined,
    request.signal,
  );
}

/**
 * Build the `Prefer` header for an OGC API Processes execution request.
 * honua-server is async-only: `mode: "async"` sends an explicit
 * `Prefer: respond-async` so OGC-conformance checkers see the header;
 * `mode: "auto"` (or unset) omits it and lets the server default apply.
 */
function preferHeaderForExecute(request: OgcProcessExecuteRequest): { Prefer: string } | undefined {
  if (request.mode === "async") {
    return { Prefer: "respond-async" };
  }
  return undefined;
}
