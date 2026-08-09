import type { PmtilesTileKind } from "../contract/pmtiles.js";
import { toPmtilesSourceUrl } from "../contract/pmtiles.js";
import type { HonuaClient } from "../core/client.js";
import { type HonuaErrorOptions, HonuaSdkError } from "../core/error-envelope.js";
import { HonuaAbortError } from "../core/errors.js";

const JOBS_PATH = "/api/v1/admin/tile-operations/jobs";
const MAX_RESPONSE_BYTES = 256 * 1024;
const ARCHIVE_RETENTION_HOURS = 24;

export type HonuaPmtilesLifecycleErrorCode =
  | "invalid-request"
  | "invalid-response"
  | "response-too-large"
  | "job-poll-timeout"
  | "job-failed"
  | "job-cancelled"
  | "access-url-expired"
  | "manual-cleanup-unsupported";

export class HonuaPmtilesLifecycleError extends HonuaSdkError {
  public constructor(
    public readonly lifecycleCode: HonuaPmtilesLifecycleErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(`pmtiles.lifecycle.${lifecycleCode}`, message, { ...options, context: { ...detail, ...options.context } });
    this.name = "HonuaPmtilesLifecycleError";
  }
}

export type PmtilesJobOperation = "archive" | "publish";
export type PmtilesJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export type PmtilesUrlStrategy = "PublicUrl" | "SignedUrl" | "RangeProxy";
export type PmtilesStorageProvider = "Local" | "AwsS3" | "AzureBlob";

export interface PmtilesJobRequest {
  readonly serviceId?: string;
  readonly layerId: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly tileMatrixSetId?: string;
  readonly bbox?: readonly [number, number, number, number];
  readonly maxTiles?: number;
}

export interface PmtilesRequestOptions {
  readonly signal?: AbortSignal;
}

export interface PmtilesJobWaitOptions extends PmtilesRequestOptions {
  readonly deadlineMs?: number;
  readonly maxAttempts?: number;
  readonly pollIntervalMs?: number;
}

export interface PmtilesJobStartReceipt {
  readonly jobId: string;
  readonly operation: PmtilesJobOperation;
  readonly message: string;
  readonly statusUrl: string;
  readonly cancelUrl: string;
}

export interface PmtilesPublishedArtifact {
  readonly artifactId: string;
  readonly storageProvider: PmtilesStorageProvider;
  readonly bucket: string;
  readonly objectKey: string;
  readonly contentType: "application/vnd.pmtiles";
  readonly sizeBytes: number;
  readonly urlStrategy: PmtilesUrlStrategy;
  readonly accessUrl: string;
  readonly accessUrlExpiresAt?: string;
  readonly publishedAt: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds?: readonly [number, number, number, number];
  readonly layerId?: number;
  readonly serviceId?: string;
  readonly tileMatrixSetId?: string;
}

export interface PmtilesJobProgress {
  readonly jobId: string;
  readonly operation: PmtilesJobOperation;
  readonly serviceId?: string;
  readonly layerId?: number;
  readonly tileMatrixSetId?: string;
  readonly status: PmtilesJobStatus;
  readonly totalTiles: number;
  readonly processedTiles: number;
  readonly successfulTiles: number;
  readonly failedTiles: number;
  readonly percentComplete?: number;
  readonly archiveSizeBytes: number;
  readonly archiveFileId?: string;
  readonly downloadUrl?: string;
  readonly publishedArtifact?: PmtilesPublishedArtifact;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly currentPhase?: string;
  readonly errorMessage?: string;
  readonly warnings: readonly string[];
}

export interface PmtilesJobCancellation {
  readonly jobId: string;
  readonly message: string;
}

export type PmtilesSourceMaturity =
  | "direct-archive"
  | "temporary-archive"
  | "published-public-archive"
  | "published-signed-archive"
  | "honua-range-proxy";

export interface PmtilesRendererSourceDescriptor {
  readonly archiveUrl: string;
  readonly maplibreUrl: string;
  readonly maplibreSource: Readonly<{
    type: "vector" | "raster";
    url: string;
    minzoom?: number;
    maxzoom?: number;
    bounds?: readonly [number, number, number, number];
  }>;
  readonly maturity: PmtilesSourceMaturity;
  readonly serverManaged: boolean;
  readonly artifactDurable: boolean;
  readonly accessStable: boolean;
  readonly accessUrlExpiresAt?: string;
  readonly artifactId?: string;
  readonly fallbackReason?: "missing-published-artifact" | "expired-signed-url";
}

export interface RegisterPmtilesSourceOptions {
  readonly publishedArtifact?: PmtilesPublishedArtifact;
  readonly archiveJob?: PmtilesJobProgress;
  readonly directArchiveUrl?: string;
  readonly directTileKind?: PmtilesTileKind;
  readonly honuaBaseUrl: string;
  readonly now?: Date;
}

export type PmtilesCleanupDisposition =
  | Readonly<{ mode: "caller-owned"; manualDeleteSupported: true }>
  | Readonly<{ mode: "server-ttl"; manualDeleteSupported: false; retentionHours: 24 }>
  | Readonly<{ mode: "republish-overwrite"; manualDeleteSupported: false }>;

export interface PmtilesLifecycleCapabilityState {
  readonly client: "supported" | "experimental" | "unsupported";
  readonly server: "not-required" | "contract-present" | "not-exposed";
  readonly endToEnd: "fixture-qualified" | "fixture-only" | "not-claimable";
}

export const PMTILES_LIFECYCLE_CAPABILITIES = Object.freeze({
  directArchive: Object.freeze({ client: "supported", server: "not-required", endToEnd: "fixture-qualified" }),
  temporaryArchiveJob: Object.freeze({ client: "experimental", server: "contract-present", endToEnd: "fixture-only" }),
  durablePublishJob: Object.freeze({ client: "experimental", server: "contract-present", endToEnd: "fixture-only" }),
  durableRangeProxy: Object.freeze({ client: "experimental", server: "contract-present", endToEnd: "fixture-only" }),
  manualArtifactDelete: Object.freeze({ client: "unsupported", server: "not-exposed", endToEnd: "not-claimable" }),
}) satisfies Readonly<Record<string, PmtilesLifecycleCapabilityState>>;

export interface CreateHonuaPmtilesLifecycleOptions {
  /** May lower, but never raise, the 256 KiB receipt/status response ceiling. */
  readonly maxResponseBytes?: number;
}

export type PmtilesProgressListener = (progress: PmtilesJobProgress) => void;

export class HonuaPmtilesJob {
  readonly #listeners = new Set<PmtilesProgressListener>();
  #lastProgress: PmtilesJobProgress | undefined;

  public readonly id: string;
  public readonly operation: PmtilesJobOperation;

  public constructor(
    readonly owner: HonuaPmtilesLifecycle,
    public readonly receipt: PmtilesJobStartReceipt,
  ) {
    this.id = receipt.jobId;
    this.operation = receipt.operation;
  }

  public get lastProgress(): PmtilesJobProgress | undefined {
    return this.#lastProgress;
  }

  public watch(listener: PmtilesProgressListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async poll(options: PmtilesRequestOptions = {}): Promise<PmtilesJobProgress> {
    const progress = await this.owner.getJob(this.id, options);
    if (progress.operation !== this.operation) {
      throw error("invalid-response", `PMTiles job ${this.id} changed operation.`, {
        expected: this.operation,
        actual: progress.operation,
      });
    }
    this.#lastProgress = progress;
    for (const listener of this.#listeners) listener(progress);
    return progress;
  }

  public async wait(options: PmtilesJobWaitOptions = {}): Promise<PmtilesJobProgress> {
    const attempts = positiveInteger(options.maxAttempts ?? 600, "maxAttempts");
    const interval = nonNegativeInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
    const deadline = Date.now() + nonNegativeInteger(options.deadlineMs ?? 600_000, "deadlineMs");
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(options.signal);
      if (Date.now() > deadline) {
        throw error("job-poll-timeout", `PMTiles job ${this.id} exceeded its deadline.`, { reason: "deadline" });
      }
      const progress = await this.poll(options);
      if (isPmtilesJobTerminal(progress.status)) return progress;
      if (attempt < attempts) await delay(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
    }
    throw error("job-poll-timeout", `PMTiles job ${this.id} exceeded its attempt limit.`, {
      reason: "max-attempts",
      attempts,
    });
  }

  public cancel(options: PmtilesRequestOptions = {}): Promise<PmtilesJobCancellation> {
    return this.owner.cancelJob(this.id, options);
  }

  /** Clears client listeners only; use `cancel()` to request a server transition. */
  public dispose(): void {
    this.#listeners.clear();
  }
}

export class HonuaPmtilesLifecycle {
  readonly #maxResponseBytes: number;

  public constructor(
    readonly client: HonuaClient,
    options: CreateHonuaPmtilesLifecycleOptions = {},
  ) {
    this.#maxResponseBytes = Math.min(
      positiveInteger(options.maxResponseBytes ?? MAX_RESPONSE_BYTES, "maxResponseBytes"),
      MAX_RESPONSE_BYTES,
    );
  }

  public submitArchive(request: PmtilesJobRequest, options: PmtilesRequestOptions = {}): Promise<HonuaPmtilesJob> {
    return this.#submit("archive", request, options);
  }

  public submitPublish(request: PmtilesJobRequest, options: PmtilesRequestOptions = {}): Promise<HonuaPmtilesJob> {
    return this.#submit("publish", request, options);
  }

  public async getJob(jobId: string, options: PmtilesRequestOptions = {}): Promise<PmtilesJobProgress> {
    const value = await this.#json(
      "GET",
      `${JOBS_PATH}/${encodeURIComponent(identifier(jobId, "jobId"))}`,
      undefined,
      options,
    );
    return parseProgress(value);
  }

  public async cancelJob(jobId: string, options: PmtilesRequestOptions = {}): Promise<PmtilesJobCancellation> {
    const id = identifier(jobId, "jobId");
    const record = object(
      await this.#json("POST", `${JOBS_PATH}/${encodeURIComponent(id)}/cancel`, undefined, options),
      "cancel receipt",
    );
    return Object.freeze({ jobId: string(record, "jobId"), message: string(record, "message") });
  }

  public registerSource(options: RegisterPmtilesSourceOptions): PmtilesRendererSourceDescriptor {
    return registerPmtilesSource(options);
  }

  async #submit(
    operation: PmtilesJobOperation,
    request: PmtilesJobRequest,
    options: PmtilesRequestOptions,
  ): Promise<HonuaPmtilesJob> {
    const record = object(
      await this.#json("POST", JOBS_PATH, normalizeRequest(operation, request), options, [202]),
      "start receipt",
    );
    return new HonuaPmtilesJob(
      this,
      Object.freeze({
        jobId: string(record, "jobId"),
        operation,
        message: string(record, "message"),
        statusUrl: string(record, "statusUrl"),
        cancelUrl: string(record, "cancelUrl"),
      }),
    );
  }

  async #json(
    method: "GET" | "POST",
    path: string,
    body: Readonly<Record<string, unknown>> | undefined,
    options: PmtilesRequestOptions,
    okStatuses?: readonly number[],
  ): Promise<unknown> {
    throwIfAborted(options.signal);
    let admitted: Uint8Array | undefined;
    await this.client.pipelineFetch(
      method,
      path,
      {
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      options.signal,
      {
        ...(okStatuses ? { okStatuses } : {}),
        redirect: "error",
        prepareResponse: async (response, signal) => {
          admitted = await bounded(response, this.#maxResponseBytes, signal);
          return new Response(admitted.slice().buffer as ArrayBuffer, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      },
    );
    if (!admitted) throw error("invalid-response", "PMTiles lifecycle response was not admitted.");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(admitted)) as unknown;
    } catch (cause) {
      throw error("invalid-response", "PMTiles lifecycle response was not valid UTF-8 JSON.", undefined, { cause });
    }
  }
}

export function createHonuaPmtilesLifecycle(
  client: HonuaClient,
  options: CreateHonuaPmtilesLifecycleOptions = {},
): HonuaPmtilesLifecycle {
  return new HonuaPmtilesLifecycle(client, options);
}

export function isPmtilesJobTerminal(status: PmtilesJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function requirePmtilesJobSuccess(progress: PmtilesJobProgress): PmtilesJobProgress {
  if (progress.status === "failed") {
    throw error("job-failed", progress.errorMessage ?? `PMTiles job ${progress.jobId} failed.`, {
      warnings: progress.warnings,
    });
  }
  if (progress.status === "cancelled") throw error("job-cancelled", `PMTiles job ${progress.jobId} was cancelled.`);
  if (progress.status !== "completed") throw error("invalid-request", `PMTiles job ${progress.jobId} is not complete.`);
  return progress;
}

export function registerPmtilesSource(options: RegisterPmtilesSourceOptions): PmtilesRendererSourceDescriptor {
  const artifact = options.publishedArtifact;
  if (artifact) {
    const expired =
      artifact.accessUrlExpiresAt !== undefined &&
      Date.parse(artifact.accessUrlExpiresAt) <= (options.now ?? new Date()).getTime();
    if (!expired) return publishedDescriptor(artifact, options.honuaBaseUrl, options.directTileKind);
    if (!options.directArchiveUrl) {
      throw error("access-url-expired", `PMTiles artifact ${artifact.artifactId} has an expired access URL.`, {
        artifactId: artifact.artifactId,
        accessUrlExpiresAt: artifact.accessUrlExpiresAt,
      });
    }
    return directDescriptor(options.directArchiveUrl, options.directTileKind, "expired-signed-url");
  }
  if (options.archiveJob) {
    const job = requirePmtilesJobSuccess(options.archiveJob);
    if (job.operation !== "archive" || !job.downloadUrl)
      throw error("invalid-request", "archiveJob must be a completed archive job.");
    return rendererDescriptor({
      archiveUrl: httpUrl(job.downloadUrl, options.honuaBaseUrl, "archiveJob.downloadUrl"),
      maturity: "temporary-archive",
      tileKind: options.directTileKind ?? "mvt",
      serverManaged: true,
      artifactDurable: false,
      accessStable: false,
      ...(job.archiveFileId ? { artifactId: job.archiveFileId } : {}),
    });
  }
  if (options.directArchiveUrl)
    return directDescriptor(options.directArchiveUrl, options.directTileKind, "missing-published-artifact");
  throw error("invalid-request", "A published artifact, archive job, or direct archive fallback is required.");
}

export function pmtilesCleanupDisposition(source: PmtilesRendererSourceDescriptor): PmtilesCleanupDisposition {
  if (source.maturity === "direct-archive") return Object.freeze({ mode: "caller-owned", manualDeleteSupported: true });
  if (source.maturity === "temporary-archive") {
    return Object.freeze({ mode: "server-ttl", manualDeleteSupported: false, retentionHours: ARCHIVE_RETENTION_HOURS });
  }
  return Object.freeze({ mode: "republish-overwrite", manualDeleteSupported: false });
}

export function assertPmtilesManualCleanupSupported(source: PmtilesRendererSourceDescriptor): void {
  const disposition = pmtilesCleanupDisposition(source);
  if (!disposition.manualDeleteSupported) {
    throw error("manual-cleanup-unsupported", "Honua Server does not expose manual PMTiles artifact deletion.", {
      maturity: source.maturity,
      cleanupMode: disposition.mode,
    });
  }
}

function normalizeRequest(operation: PmtilesJobOperation, input: PmtilesJobRequest): Readonly<Record<string, unknown>> {
  const minZoom = input.minZoom === undefined ? undefined : zoom(input.minZoom, "minZoom");
  const maxZoom = input.maxZoom === undefined ? undefined : zoom(input.maxZoom, "maxZoom");
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom)
    throw error("invalid-request", "minZoom exceeds maxZoom.");
  return Object.freeze({
    operation,
    layerId: nonNegativeInteger(input.layerId, "layerId"),
    ...(input.serviceId === undefined ? {} : { serviceId: identifier(input.serviceId, "serviceId") }),
    ...(minZoom === undefined ? {} : { minZoom }),
    ...(maxZoom === undefined ? {} : { maxZoom }),
    ...(input.tileMatrixSetId === undefined
      ? {}
      : { tileMatrixSetId: identifier(input.tileMatrixSetId, "tileMatrixSetId") }),
    ...(input.bbox === undefined ? {} : { bbox: bounds(input.bbox, "bbox") }),
    ...(input.maxTiles === undefined ? {} : { maxTiles: positiveInteger(input.maxTiles, "maxTiles") }),
  });
}

function parseProgress(value: unknown): PmtilesJobProgress {
  const record = object(value, "job status");
  const operation = enumeration(record, "operation", ["archive", "publish"] as const);
  const status = statusValue(required(record, "status"));
  const totalTiles = nonNegativeNumber(record, "totalTiles");
  const processedTiles = nonNegativeNumber(record, "processedTiles");
  const rawArtifact = optional(record, "publishedArtifact");
  const publishedArtifact = rawArtifact === undefined || rawArtifact === null ? undefined : parseArtifact(rawArtifact);
  const result: PmtilesJobProgress = Object.freeze({
    jobId: string(record, "jobId"),
    operation,
    ...optionalStringField(record, "serviceId"),
    ...optionalIntegerField(record, "layerId"),
    ...optionalStringField(record, "tileMatrixSetId"),
    status,
    totalTiles,
    processedTiles,
    successfulTiles: nonNegativeNumber(record, "successfulTiles"),
    failedTiles: nonNegativeNumber(record, "failedTiles"),
    ...(totalTiles > 0 ? { percentComplete: Math.min(100, (processedTiles / totalTiles) * 100) } : {}),
    archiveSizeBytes: nonNegativeNumber(record, "archiveSizeBytes"),
    ...optionalStringField(record, "archiveFileId"),
    ...optionalStringField(record, "downloadUrl"),
    ...(publishedArtifact ? { publishedArtifact } : {}),
    startedAt: timestamp(record, "startedAt"),
    ...optionalTimestampField(record, "completedAt"),
    ...optionalStringField(record, "currentPhase"),
    ...optionalStringField(record, "errorMessage"),
    warnings: stringArray(record, "warnings"),
  });
  if (status === "completed" && operation === "publish" && !publishedArtifact)
    throw error("invalid-response", "Completed publish job omitted publishedArtifact.");
  if (status === "completed" && operation === "archive" && (!result.archiveFileId || !result.downloadUrl)) {
    throw error("invalid-response", "Completed archive job omitted archiveFileId or downloadUrl.");
  }
  return result;
}

function parseArtifact(value: unknown): PmtilesPublishedArtifact {
  const record = object(value, "published artifact");
  const contentType = string(record, "contentType");
  if (contentType !== "application/vnd.pmtiles")
    throw error("invalid-response", `Unexpected content type ${contentType}.`);
  const minZoom = zoom(integer(record, "minZoom"), "minZoom");
  const maxZoom = zoom(integer(record, "maxZoom"), "maxZoom");
  if (minZoom > maxZoom) throw error("invalid-response", "Published minZoom exceeds maxZoom.");
  const rawBounds = optional(record, "bounds");
  return Object.freeze({
    artifactId: string(record, "artifactId"),
    storageProvider: enumeration(record, "storageProvider", ["Local", "AwsS3", "AzureBlob"] as const),
    bucket: string(record, "bucket"),
    objectKey: string(record, "objectKey"),
    contentType,
    sizeBytes: positiveNumber(record, "sizeBytes"),
    urlStrategy: enumeration(record, "urlStrategy", ["PublicUrl", "SignedUrl", "RangeProxy"] as const),
    accessUrl: string(record, "accessUrl"),
    ...optionalTimestampField(record, "accessUrlExpiresAt"),
    publishedAt: timestamp(record, "publishedAt"),
    minZoom,
    maxZoom,
    ...(rawBounds === undefined || rawBounds === null ? {} : { bounds: bounds(rawBounds, "bounds") }),
    ...optionalIntegerField(record, "layerId"),
    ...optionalStringField(record, "serviceId"),
    ...optionalStringField(record, "tileMatrixSetId"),
  });
}

function publishedDescriptor(
  artifact: PmtilesPublishedArtifact,
  baseUrl: string,
  tileKind?: PmtilesTileKind,
): PmtilesRendererSourceDescriptor {
  const maturity: PmtilesSourceMaturity =
    artifact.urlStrategy === "RangeProxy"
      ? "honua-range-proxy"
      : artifact.urlStrategy === "PublicUrl"
        ? "published-public-archive"
        : "published-signed-archive";
  return rendererDescriptor({
    archiveUrl: httpUrl(artifact.accessUrl, baseUrl, "accessUrl"),
    maturity,
    tileKind: tileKind ?? "mvt",
    serverManaged: true,
    artifactDurable: true,
    accessStable: artifact.urlStrategy !== "SignedUrl",
    minZoom: artifact.minZoom,
    maxZoom: artifact.maxZoom,
    ...(artifact.bounds ? { bounds: artifact.bounds } : {}),
    ...(artifact.accessUrlExpiresAt ? { accessUrlExpiresAt: artifact.accessUrlExpiresAt } : {}),
    artifactId: artifact.artifactId,
  });
}

function directDescriptor(
  url: string,
  tileKind: PmtilesTileKind | undefined,
  fallbackReason: PmtilesRendererSourceDescriptor["fallbackReason"],
): PmtilesRendererSourceDescriptor {
  return rendererDescriptor({
    archiveUrl: httpUrl(url, undefined, "directArchiveUrl"),
    maturity: "direct-archive",
    tileKind: tileKind ?? "mvt",
    serverManaged: false,
    artifactDurable: false,
    accessStable: false,
    fallbackReason,
  });
}

function rendererDescriptor(input: {
  archiveUrl: string;
  maturity: PmtilesSourceMaturity;
  tileKind: PmtilesTileKind;
  serverManaged: boolean;
  artifactDurable: boolean;
  accessStable: boolean;
  minZoom?: number;
  maxZoom?: number;
  bounds?: readonly [number, number, number, number];
  accessUrlExpiresAt?: string;
  artifactId?: string;
  fallbackReason?: PmtilesRendererSourceDescriptor["fallbackReason"];
}): PmtilesRendererSourceDescriptor {
  const maplibreUrl = toPmtilesSourceUrl(input.archiveUrl);
  return Object.freeze({
    archiveUrl: input.archiveUrl,
    maplibreUrl,
    maplibreSource: Object.freeze({
      type: input.tileKind === "mvt" ? "vector" : "raster",
      url: maplibreUrl,
      ...(input.minZoom === undefined ? {} : { minzoom: input.minZoom }),
      ...(input.maxZoom === undefined ? {} : { maxzoom: input.maxZoom }),
      ...(input.bounds ? { bounds: input.bounds } : {}),
    }),
    maturity: input.maturity,
    serverManaged: input.serverManaged,
    artifactDurable: input.artifactDurable,
    accessStable: input.accessStable,
    ...(input.accessUrlExpiresAt ? { accessUrlExpiresAt: input.accessUrlExpiresAt } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
  });
}

async function bounded(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maximum) {
    void response.body?.cancel().catch(() => undefined);
    throw error("response-too-large", `PMTiles lifecycle response exceeds ${maximum} bytes.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw error("response-too-large", `PMTiles lifecycle response exceeds ${maximum} bytes.`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function statusValue(value: unknown): PmtilesJobStatus {
  const numeric: Record<number, PmtilesJobStatus> = {
    0: "queued",
    1: "processing",
    2: "completed",
    3: "failed",
    4: "cancelled",
  };
  if (typeof value === "number" && numeric[value]) return numeric[value];
  if (
    typeof value === "string" &&
    ["queued", "processing", "completed", "failed", "cancelled"].includes(value.toLowerCase())
  ) {
    return value.toLowerCase() as PmtilesJobStatus;
  }
  throw error("invalid-response", "Unknown PMTiles job status.", { status: value });
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw error("invalid-response", `${label} must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}

function key(record: Readonly<Record<string, unknown>>, name: string): string | undefined {
  return Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function required(record: Readonly<Record<string, unknown>>, name: string): unknown {
  const actual = key(record, name);
  if (!actual) throw error("invalid-response", `PMTiles response omitted ${name}.`);
  return record[actual];
}

function optional(record: Readonly<Record<string, unknown>>, name: string): unknown {
  const actual = key(record, name);
  return actual ? record[actual] : undefined;
}

function string(record: Readonly<Record<string, unknown>>, name: string): string {
  const value = required(record, name);
  if (typeof value !== "string" || !value.trim())
    throw error("invalid-response", `${name} must be a non-empty string.`);
  return value;
}

function integer(record: Readonly<Record<string, unknown>>, name: string): number {
  const value = required(record, name);
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw error("invalid-response", `${name} must be an integer.`);
  return value;
}

function nonNegativeNumber(record: Readonly<Record<string, unknown>>, name: string): number {
  const value = required(record, name);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw error("invalid-response", `${name} must be non-negative.`);
  return value;
}

function positiveNumber(record: Readonly<Record<string, unknown>>, name: string): number {
  const value = nonNegativeNumber(record, name);
  if (value === 0) throw error("invalid-response", `${name} must be positive.`);
  return value;
}

function enumeration<const T extends readonly string[]>(
  record: Readonly<Record<string, unknown>>,
  name: string,
  allowed: T,
): T[number] {
  const value = string(record, name);
  if (!(allowed as readonly string[]).includes(value))
    throw error("invalid-response", `${name} has unsupported value ${value}.`);
  return value as T[number];
}

function optionalStringField(record: Readonly<Record<string, unknown>>, name: string): Record<string, string> {
  const value = optional(record, name);
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") throw error("invalid-response", `${name} must be a string.`);
  return { [name]: value };
}

function optionalIntegerField(record: Readonly<Record<string, unknown>>, name: string): Record<string, number> {
  const value = optional(record, name);
  if (value === undefined || value === null) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw error("invalid-response", `${name} must be an integer.`);
  return { [name]: value };
}

function timestamp(record: Readonly<Record<string, unknown>>, name: string): string {
  const value = string(record, name);
  if (!Number.isFinite(Date.parse(value))) throw error("invalid-response", `${name} must be a timestamp.`);
  return value;
}

function optionalTimestampField(record: Readonly<Record<string, unknown>>, name: string): Record<string, string> {
  const field = optionalStringField(record, name);
  const value = field[name];
  if (value !== undefined && !Number.isFinite(Date.parse(value)))
    throw error("invalid-response", `${name} must be a timestamp.`);
  return field;
}

function stringArray(record: Readonly<Record<string, unknown>>, name: string): readonly string[] {
  const value = optional(record, name) ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw error("invalid-response", `${name} must be a string array.`);
  return Object.freeze([...value] as string[]);
}

function bounds(value: unknown, label: string): readonly [number, number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw error("invalid-request", `${label} must contain four finite numbers.`);
  }
  const result = value as [number, number, number, number];
  if (result[0] > result[2] || result[1] > result[3])
    throw error("invalid-request", `${label} minimums exceed maximums.`);
  return Object.freeze([...result]) as readonly [number, number, number, number];
}

function httpUrl(value: string, base: string | undefined, label: string): string {
  let parsed: URL;
  try {
    parsed = base ? new URL(value, base) : new URL(value);
  } catch (cause) {
    throw error("invalid-request", `${label} must be an HTTP(S) URL.`, { value }, { cause });
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw error("invalid-request", `${label} must be a credential-free HTTP(S) URL.`);
  }
  return parsed.toString();
}

function identifier(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw error("invalid-request", `${label} is required.`);
  return value.trim();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw error("invalid-request", `${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw error("invalid-request", `${label} must be a non-negative integer.`);
  return value;
}

function zoom(value: number, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result > 30) throw error("invalid-request", `${label} must not exceed 30.`);
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HonuaAbortError("PMTiles lifecycle request was aborted.");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const aborted = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(new HonuaAbortError("PMTiles lifecycle polling was aborted."));
    };
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function error(
  code: HonuaPmtilesLifecycleErrorCode,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
  options: HonuaErrorOptions = {},
): HonuaPmtilesLifecycleError {
  return new HonuaPmtilesLifecycleError(code, message, detail, options);
}
