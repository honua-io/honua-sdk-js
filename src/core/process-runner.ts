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
import { HonuaJobPollTimeoutError } from "../contract/jobs.js";
import type { HonuaOgcProcesses } from "./ogc-processes.js";
import type { HonuaGeoprocessingService } from "./surfaces.js";
import type { OgcProcessExecuteRequest } from "./types.js";

export type HonuaProcessProtocol = "ogc-processes" | "geoservices-gp" | "geospatial-grpc";

export interface HonuaProcessExecuteRequest {
  /** OGC process id or a human-readable id for GP/gRPC plans. */
  readonly processId?: string;
  /** OGC-style input bag, also used as GPServer submit parameters by the GeoServices adapter. */
  readonly inputs?: OgcProcessExecuteRequest["inputs"];
  /** GeoServices GPServer submit parameters. Takes precedence over `inputs`. */
  readonly parameters?: Record<string, unknown>;
  /** geospatial-grpc `ExecutionPlan` message or compatible plain object. */
  readonly plan?: unknown;
  /** OGC output descriptor map, when targeting OGC API Processes. */
  readonly outputs?: OgcProcessExecuteRequest["outputs"];
  /** geospatial-grpc `ExecutionContext` message or compatible plain object. */
  readonly context?: unknown;
  /** Result ids to fetch when targeting GeoServices GPServer result routes. */
  readonly resultNames?: readonly string[];
  /**
   * Execution preference. `"sync"` is meaningful only for OGC API Processes
   * (the other adapters are job-oriented by construction); every mode still
   * yields an `IJobRun`.
   */
  readonly mode?: "sync" | "async" | "auto";
  readonly signal?: AbortSignal;
  /** OGC process `jobControlOptions`, when known, for fail-closed mode gating. */
  readonly jobControlOptions?: readonly string[];
}

export interface HonuaProcessJobOptions {
  readonly processId?: string;
  readonly resultNames?: readonly string[];
}

export interface HonuaProcessAdapter {
  readonly protocol: HonuaProcessProtocol;
  execute<T = unknown>(request: HonuaProcessExecuteRequest): Promise<IJobRun<T>>;
  job<T = unknown>(jobId: string, options?: HonuaProcessJobOptions): IJobRun<T>;
  validate?(request: HonuaProcessExecuteRequest): Promise<unknown>;
  dryRun?(request: HonuaProcessExecuteRequest): Promise<unknown>;
}

export class HonuaProcessRunner {
  public readonly adapter: HonuaProcessAdapter;

  public constructor(adapter: HonuaProcessAdapter) {
    this.adapter = adapter;
  }

  public get protocol(): HonuaProcessProtocol {
    return this.adapter.protocol;
  }

  public execute<T = unknown>(request: HonuaProcessExecuteRequest): Promise<IJobRun<T>> {
    return this.adapter.execute<T>(request);
  }

  public job<T = unknown>(jobId: string, options: HonuaProcessJobOptions = {}): IJobRun<T> {
    return this.adapter.job<T>(jobId, options);
  }

  public async validate(request: HonuaProcessExecuteRequest): Promise<unknown> {
    if (!this.adapter.validate) {
      throw new Error(`${this.protocol} does not expose validate through the unified process runner.`);
    }
    return this.adapter.validate(request);
  }

  public async dryRun(request: HonuaProcessExecuteRequest): Promise<unknown> {
    if (!this.adapter.dryRun) {
      throw new Error(`${this.protocol} does not expose dryRun through the unified process runner.`);
    }
    return this.adapter.dryRun(request);
  }
}

export function createHonuaProcessRunner(adapter: HonuaProcessAdapter): HonuaProcessRunner {
  return new HonuaProcessRunner(adapter);
}

export function createOgcProcessesAdapter(processes: HonuaOgcProcesses): HonuaProcessAdapter {
  return {
    protocol: "ogc-processes",
    execute<T = unknown>(request: HonuaProcessExecuteRequest) {
      if (!request.processId) throw new Error("OGC Processes execution requires processId.");
      return processes.execute<T>({
        processId: request.processId,
        inputs: request.inputs,
        outputs: request.outputs,
        mode: request.mode ?? "async",
        signal: request.signal,
        ...(request.jobControlOptions !== undefined ? { jobControlOptions: request.jobControlOptions } : {}),
      });
    },
    job<T = unknown>(jobId: string, options: HonuaProcessJobOptions = {}) {
      return processes.job<T>(jobId, { processId: options.processId });
    },
  };
}

export function createGeoServicesGpAdapter(service: HonuaGeoprocessingService): HonuaProcessAdapter {
  return {
    protocol: "geoservices-gp",
    execute<T = unknown>(request: HonuaProcessExecuteRequest) {
      return service.submit<T>(
        {
          parameters: request.parameters ?? request.inputs ?? {},
          signal: request.signal,
        },
        { resultNames: request.resultNames },
      );
    },
    job<T = unknown>(jobId: string, options: HonuaProcessJobOptions = {}) {
      return service.job<T>(jobId, { resultNames: options.resultNames });
    },
  };
}

export interface GeospatialGrpcProcessClient {
  validatePlan?(request: { readonly plan: unknown }): Promise<unknown>;
  dryRunPlan?(request: { readonly plan: unknown }): Promise<unknown>;
  submitJob(request: { readonly plan: unknown; readonly context?: unknown }): Promise<GeospatialGrpcSubmitJobResponse>;
  getJob(request: { readonly jobId: string; readonly signal?: AbortSignal }): Promise<GeospatialGrpcGetJobResponse>;
  getJobResult(request: { readonly jobId: string }): Promise<GeospatialGrpcGetJobResultResponse>;
  cancelJob(request: { readonly jobId: string }): Promise<GeospatialGrpcCancelJobResponse>;
}

export interface GeospatialGrpcSubmitJobResponse {
  readonly jobId?: string;
  readonly job_id?: string;
  readonly state?: unknown;
}

export interface GeospatialGrpcGetJobResponse extends GeospatialGrpcSubmitJobResponse {
  readonly progress?: GeospatialGrpcJobProgress;
}

export interface GeospatialGrpcCancelJobResponse extends GeospatialGrpcSubmitJobResponse {}

export interface GeospatialGrpcGetJobResultResponse {
  readonly jobId?: string;
  readonly job_id?: string;
  readonly result?: unknown;
  readonly error?: GeospatialGrpcErrorDetail;
  readonly outcome?: { readonly case?: string; readonly value?: unknown };
}

export interface GeospatialGrpcJobProgress {
  readonly progressPercent?: number;
  readonly progress_percent?: number;
  readonly message?: string;
  readonly updatedAt?: number | bigint | string;
  readonly updated_at?: number | bigint | string;
  readonly state?: unknown;
}

export interface GeospatialGrpcErrorDetail {
  readonly errorCode?: string;
  readonly error_code?: string;
  readonly message?: string;
  readonly details?: Record<string, string>;
}

export function createGeospatialGrpcProcessAdapter(client: GeospatialGrpcProcessClient): HonuaProcessAdapter {
  return {
    protocol: "geospatial-grpc",
    validate(request) {
      if (!client.validatePlan) throw new Error("geospatial-grpc ProcessService client does not expose validatePlan.");
      return client.validatePlan({ plan: requirePlan(request) });
    },
    dryRun(request) {
      if (!client.dryRunPlan) throw new Error("geospatial-grpc ProcessService client does not expose dryRunPlan.");
      return client.dryRunPlan({ plan: requirePlan(request) });
    },
    async execute<T = unknown>(request: HonuaProcessExecuteRequest) {
      const accepted = await client.submitJob({ plan: requirePlan(request), context: request.context });
      return new GeospatialGrpcProcessJobRun<T>({ client, accepted });
    },
    job<T = unknown>(jobId: string) {
      return new GeospatialGrpcProcessJobRun<T>({ client, accepted: { jobId, state: "JOB_STATE_UNSPECIFIED" } });
    },
  };
}

interface GeospatialGrpcProcessJobRunOptions {
  readonly client: GeospatialGrpcProcessClient;
  readonly accepted: GeospatialGrpcSubmitJobResponse;
}

class GeospatialGrpcProcessJobRun<T = unknown> implements IJobRun<T> {
  public readonly id: string;
  public readonly type = "geospatial-grpc";

  private readonly client: GeospatialGrpcProcessClient;
  private currentStatus: JobStatus;
  private currentProgress: JobProgress | undefined;
  private terminalSnapshot: JobSnapshot<T> | undefined;
  private terminalPromise: Promise<JobResult<T>> | undefined;
  private readonly listeners = new Set<JobSnapshotListener<T>>();

  public constructor(options: GeospatialGrpcProcessJobRunOptions) {
    this.client = options.client;
    this.id = readJobId(options.accepted);
    this.currentStatus = geospatialGrpcJobStateToStatus(options.accepted.state);
  }

  public get status(): JobStatus {
    return this.currentStatus;
  }

  public get progress(): JobProgress | undefined {
    return this.currentProgress;
  }

  public async poll(): Promise<JobSnapshot<T>> {
    if (this.terminalSnapshot) return this.terminalSnapshot;
    const response = await this.client.getJob({ jobId: this.id });
    return this.handleJob(response);
  }

  public watch(listener: JobSnapshotListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async results(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    if (!this.terminalPromise) {
      // Reset on failure so an aborted / timed-out poll does not permanently
      // poison subsequent results() calls.
      this.terminalPromise = this.runUntilTerminal(options).catch((error) => {
        this.terminalPromise = undefined;
        throw error;
      });
    }
    return this.terminalPromise;
  }

  public async cancel(): Promise<JobStatus> {
    if (this.terminalSnapshot) return this.currentStatus;
    const response = await this.client.cancelJob({ jobId: this.id });
    const snapshot = await this.handleJob(response);
    return snapshot.status;
  }

  private async runUntilTerminal(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    const { signal } = options;
    const baseIntervalMs = options.pollIntervalMs ?? 1_000;
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

      let response: GeospatialGrpcGetJobResponse;
      try {
        response = await this.client.getJob({ jobId: this.id, signal });
      } catch (error) {
        if (signal?.aborted) {
          throw new HonuaJobPollTimeoutError(`Job ${this.id} poll aborted`, "aborted", this.id, this.currentStatus);
        }
        throw error;
      }
      attempts += 1;
      await this.handleJob(response);
      if (this.terminalSnapshot) break;

      if (options.deadlineMs !== undefined && Date.now() - startedAt >= options.deadlineMs) {
        throw new HonuaJobPollTimeoutError(
          `Job ${this.id} did not reach a terminal state within ${options.deadlineMs}ms`,
          "deadline",
          this.id,
          this.currentStatus,
        );
      }

      // Capped exponential backoff instead of a fixed 1s interval.
      const intervalMs = Math.min(maxIntervalMs, baseIntervalMs * 2 ** (attempts - 1));
      if (intervalMs > 0) {
        await wait(intervalMs, signal);
      }
    }
    if (this.terminalSnapshot.status === "successful" && this.terminalSnapshot.result) {
      return this.terminalSnapshot.result;
    }
    throw new Error(
      this.terminalSnapshot.error?.message ?? `geospatial-grpc job ended in ${this.terminalSnapshot.status}`,
    );
  }

  private async handleJob(
    response: GeospatialGrpcGetJobResponse | GeospatialGrpcCancelJobResponse,
  ): Promise<JobSnapshot<T>> {
    const jobProgress = "progress" in response ? response.progress : undefined;
    const status = geospatialGrpcJobStateToStatus(response.state ?? jobProgress?.state);
    const progress = geospatialGrpcProgress(jobProgress);
    this.currentStatus = status;
    this.currentProgress = progress;

    if (status === "successful") {
      const result = await this.client.getJobResult({ jobId: this.id });
      const snapshot = geospatialGrpcResultSnapshot<T>(result, progress);
      this.terminalSnapshot = snapshot;
      this.currentStatus = snapshot.status;
      this.notify(snapshot);
      return snapshot;
    }

    if (status === "failed" || status === "dismissed") {
      const result = await this.safeGetTerminalResult();
      const error = result ? geospatialGrpcError(result) : undefined;
      const snapshot: JobSnapshot<T> = { status, progress, ...(error ? { error } : {}) };
      this.terminalSnapshot = snapshot;
      this.notify(snapshot);
      return snapshot;
    }

    const snapshot: JobSnapshot<T> = { status, progress };
    this.notify(snapshot);
    return snapshot;
  }

  private async safeGetTerminalResult(): Promise<GeospatialGrpcGetJobResultResponse | undefined> {
    try {
      return await this.client.getJobResult({ jobId: this.id });
    } catch {
      return undefined;
    }
  }

  private notify(snapshot: JobSnapshot<T>): void {
    for (const listener of this.listeners) listener(snapshot);
  }
}

function requirePlan(request: HonuaProcessExecuteRequest): unknown {
  if (request.plan === undefined) throw new Error("geospatial-grpc process execution requires plan.");
  return request.plan;
}

function readJobId(response: GeospatialGrpcSubmitJobResponse): string {
  const jobId = response.jobId ?? response.job_id;
  if (!jobId) throw new Error("ProcessService response did not include jobId.");
  return jobId;
}

function geospatialGrpcJobStateToStatus(value: unknown): JobStatus {
  if (value === 6) return "successful";
  if (value === 7) return "failed";
  if (value === 8) return "dismissed";
  if (value === 5) return "running";
  if (value === 1 || value === 2 || value === 3 || value === 4) return "accepted";
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("completed") || normalized === "successful") return "successful";
  if (normalized.includes("failed")) return "failed";
  if (normalized.includes("cancelled") || normalized.includes("canceled") || normalized.includes("dismissed")) {
    return "dismissed";
  }
  if (
    normalized.includes("draft") ||
    normalized.includes("clarification") ||
    normalized.includes("validated") ||
    normalized.includes("approval") ||
    normalized.includes("accepted")
  ) {
    return "accepted";
  }
  if (normalized.includes("running")) return "running";
  return "accepted";
}

function geospatialGrpcProgress(progress: GeospatialGrpcJobProgress | undefined): JobProgress | undefined {
  if (!progress) return undefined;
  const percent = progress.progressPercent ?? progress.progress_percent;
  const updatedAt = progress.updatedAt ?? progress.updated_at;
  const out: JobProgress = {};
  if (typeof percent === "number" && Number.isFinite(percent)) out.percent = Math.max(0, Math.min(100, percent));
  if (progress.message) out.message = progress.message;
  if (updatedAt !== undefined) out.updatedAt = timestampToIso(updatedAt);
  return out.percent === undefined && out.message === undefined && out.updatedAt === undefined ? undefined : out;
}

function geospatialGrpcResultSnapshot<T>(
  response: GeospatialGrpcGetJobResultResponse,
  progress: JobProgress | undefined,
): JobSnapshot<T> {
  const error = geospatialGrpcError(response);
  if (error) return { status: "failed", progress, error };
  return {
    status: "successful",
    progress,
    result: {
      outputs: { result: (response.result ?? response.outcome?.value ?? response) as T },
    },
  };
}

function geospatialGrpcError(response: GeospatialGrpcGetJobResultResponse): JobError | undefined {
  const candidate =
    response.error ??
    (response.outcome?.case === "error" ? (response.outcome.value as GeospatialGrpcErrorDetail) : undefined);
  if (!candidate) return undefined;
  return {
    code: candidate.errorCode ?? candidate.error_code ?? "GeospatialGrpcProcessError",
    message: candidate.message ?? "geospatial-grpc process execution failed.",
    details: candidate.details,
  };
}

function timestampToIso(value: number | bigint | string): string {
  const numeric = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (Number.isFinite(numeric)) return new Date(numeric).toISOString();
  return String(value);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
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
