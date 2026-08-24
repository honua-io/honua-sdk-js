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
import { JobRunLifecycle } from "./job-run-lifecycle.js";
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
  private readonly lifecycle: JobRunLifecycle<T>;

  public constructor(options: GeospatialGrpcProcessJobRunOptions) {
    this.client = options.client;
    this.id = readJobId(options.accepted);
    this.lifecycle = new JobRunLifecycle<T>({
      id: this.id,
      initialStatus: geospatialGrpcJobStateToStatus(options.accepted.state),
      pollIntervalMs: 1_000,
      poll: async (signal) => this.translateJob(await this.client.getJob({ jobId: this.id, signal })),
    });
  }

  public get status(): JobStatus {
    return this.lifecycle.status;
  }

  public get progress(): JobProgress | undefined {
    return this.lifecycle.progress;
  }

  public async poll(): Promise<JobSnapshot<T>> {
    return this.lifecycle.poll();
  }

  public watch(listener: JobSnapshotListener<T>): () => void {
    return this.lifecycle.watch(listener);
  }

  public async results(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    return this.lifecycle.results(options);
  }

  public async cancel(): Promise<JobStatus> {
    return this.lifecycle.cancel(async () => this.translateJob(await this.client.cancelJob({ jobId: this.id })));
  }

  private async translateJob(
    response: GeospatialGrpcGetJobResponse | GeospatialGrpcCancelJobResponse,
  ): Promise<JobSnapshot<T>> {
    const jobProgress = "progress" in response ? response.progress : undefined;
    const status = geospatialGrpcJobStateToStatus(response.state ?? jobProgress?.state);
    const progress = geospatialGrpcProgress(jobProgress);

    if (status === "successful") {
      const result = await this.client.getJobResult({ jobId: this.id });
      const snapshot = geospatialGrpcResultSnapshot<T>(result, progress);
      return snapshot;
    }

    if (status === "failed" || status === "dismissed") {
      const result = await this.safeGetTerminalResult();
      const error = result ? geospatialGrpcError(result) : undefined;
      const snapshot: JobSnapshot<T> = { status, progress, ...(error ? { error } : {}) };
      return snapshot;
    }

    const snapshot: JobSnapshot<T> = { status, progress };
    return snapshot;
  }

  private async safeGetTerminalResult(): Promise<GeospatialGrpcGetJobResultResponse | undefined> {
    try {
      return await this.client.getJobResult({ jobId: this.id });
    } catch {
      return undefined;
    }
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
