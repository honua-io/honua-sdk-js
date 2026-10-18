import type {
  CreateDatasetImportTask,
  DatasetImportAuthorityDescriptor,
  DatasetImportAuthorityRenewal,
  DatasetImportTask,
  DatasetImportTaskReference,
  RenewDatasetImportAuthority,
} from "./types.js";

export interface DatasetImportTaskClientOptions {
  /** Deployment origin, optionally with its reverse-proxy path prefix. */
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly targetId: string;
  /** Framework-retained turn, never a moving current-view value. Omit for human actions. */
  readonly originatingTurnId?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Reads fresh authentication for each request; credentials are never persisted here. */
  readonly headers?: () => HeadersInit | Promise<HeadersInit>;
}

export class DatasetImportTaskApiError extends Error {
  constructor(readonly status: number) {
    super(`Dataset import request failed (${status}).`);
    this.name = "DatasetImportTaskApiError";
  }
}

/**
 * Canonical task/authority APIs only. Never dispatches an import, retries a POST,
 * invents an authority revision, or treats preparation as an accepted job.
 * Persist original intent/renewal IDs before calling mutation methods. On lost
 * replies use readIntent or replay the SAME renewal ID, never mint a replacement.
 */
export class DatasetImportTaskClient {
  private readonly base: string;
  private readonly workspaceId: string;
  private readonly targetId: string;
  private readonly originatingTurnId?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly headers?: DatasetImportTaskClientOptions["headers"];

  constructor(options: DatasetImportTaskClientOptions) {
    const base = new URL(options.baseUrl);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new TypeError("A deployment HTTP(S) URL without credentials, query or fragment is required.");
    validId(options.workspaceId);
    validId(options.targetId);
    if (options.originatingTurnId !== undefined) validId(options.originatingTurnId);
    this.base = `${base.href.replace(/\/$/, "")}/api/v1/agent/workspaces/${encodeURIComponent(options.workspaceId)}`;
    this.workspaceId = options.workspaceId;
    this.targetId = options.targetId;
    this.originatingTurnId = options.originatingTurnId;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.headers = options.headers;
  }

  async createTask(request: CreateDatasetImportTask, signal?: AbortSignal): Promise<DatasetImportTask> {
    // Serialize before the first await so later form edits cannot change the request.
    const body = JSON.stringify(request);
    const task = await this.request<DatasetImportTask>("/dataset-import-tasks", "POST", body, signal);
    this.assertTask(task);
    return task;
  }

  async readIntent(intentId: string, signal?: AbortSignal): Promise<DatasetImportTask | null> {
    validId(intentId);
    const task = await this.request<DatasetImportTask>(
      `/dataset-import-task-intents/${encodeURIComponent(intentId)}`,
      "GET",
      undefined,
      signal,
      true,
    );
    if (task !== null) this.assertTask(task);
    return task;
  }

  async readTask(reference: DatasetImportTaskReference, signal?: AbortSignal): Promise<DatasetImportTask | null> {
    const pinned = pin(reference);
    const task = await this.request<DatasetImportTask>(path(pinned), "GET", undefined, signal, true);
    if (task !== null) {
      this.assertTask(task);
      if (task.taskId !== pinned.taskId || task.revision !== pinned.revision || task.contentHash !== pinned.contentHash)
        throw new Error("Import task response changed the immutable task binding.");
    }
    return task;
  }

  async readAuthority(
    reference: DatasetImportTaskReference,
    signal?: AbortSignal,
  ): Promise<DatasetImportAuthorityDescriptor | null> {
    const pinned = pin(reference);
    const descriptor = await this.request<DatasetImportAuthorityDescriptor>(
      `${path(pinned)}/authority?contentHash=${pinned.contentHash}`,
      "GET",
      undefined,
      signal,
      true,
    );
    if (
      descriptor !== null &&
      (descriptor.taskId !== pinned.taskId ||
        descriptor.taskRevision !== pinned.revision ||
        descriptor.taskContentHash !== pinned.contentHash ||
        !Number.isSafeInteger(descriptor.authorityRevision) ||
        descriptor.authorityRevision < 1)
    )
      throw new Error("Import authority response changed the immutable task binding.");
    return descriptor;
  }

  async renewAuthority(
    reference: DatasetImportTaskReference,
    request: RenewDatasetImportAuthority,
    signal?: AbortSignal,
  ): Promise<DatasetImportAuthorityRenewal> {
    const pinned = pin(reference);
    validId(request.renewalId);
    if (
      request.taskContentHash !== pinned.contentHash ||
      !Number.isSafeInteger(request.expectedAuthorityRevision) ||
      request.expectedAuthorityRevision < 1
    )
      throw new TypeError("An exact task hash and positive authority revision are required.");
    const body = JSON.stringify(request);
    const renewalId = request.renewalId;
    const previousRevision = request.expectedAuthorityRevision;
    const receipt = await this.request<DatasetImportAuthorityRenewal>(
      `${path(pinned)}/authority-renewals`,
      "POST",
      body,
      signal,
    );
    if (
      receipt.renewalId !== renewalId ||
      receipt.previousAuthorityRevision !== previousRevision ||
      receipt.authorityRevision !== previousRevision + 1
    )
      throw new Error("Import renewal response changed the original renewal binding.");
    return receipt;
  }

  private assertTask(task: DatasetImportTask): void {
    if (!task || task.workspaceId !== this.workspaceId || task.targetId !== this.targetId)
      throw new Error("Import task response changed workspace or deployment target.");
    pin({
      taskId: task.taskId,
      revision: task.revision,
      contentHash: task.contentHash,
    });
  }

  private async request<T>(
    suffix: string,
    method: "GET" | "POST",
    body: string | undefined,
    signal?: AbortSignal,
  ): Promise<T>;
  private async request<T>(
    suffix: string,
    method: "GET" | "POST",
    body: string | undefined,
    signal: AbortSignal | undefined,
    allowMissing: true,
  ): Promise<T | null>;
  private async request<T>(
    suffix: string,
    method: "GET" | "POST",
    body: string | undefined,
    signal: AbortSignal | undefined,
    allowMissing = false,
  ): Promise<T | null> {
    const headers = new Headers(await this.headers?.());
    headers.set("Accept", "application/json");
    // These scope headers are controlled by the pinned client, never fresh auth input.
    headers.delete("X-Honua-Workspace");
    headers.delete("X-Honua-Turn");
    if (this.originatingTurnId !== undefined) {
      headers.set("X-Honua-Workspace", this.workspaceId);
      headers.set("X-Honua-Turn", this.originatingTurnId);
    }
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.fetcher(`${this.base}${suffix}`, {
      method,
      headers,
      body,
      signal,
      redirect: "error",
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new DatasetImportTaskApiError(response.status);
    return (await response.json()) as T;
  }
}

function validId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  )
    throw new TypeError("A bounded canonical identity is required.");
}
function pin(reference: DatasetImportTaskReference): DatasetImportTaskReference {
  validId(reference.taskId);
  if (
    !Number.isSafeInteger(reference.revision) ||
    reference.revision < 1 ||
    typeof reference.contentHash !== "string" ||
    reference.contentHash.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(reference.contentHash)
  )
    throw new TypeError("A positive revision and lowercase whole SHA-256 task hash are required.");
  return {
    taskId: reference.taskId,
    revision: reference.revision,
    contentHash: reference.contentHash,
  };
}
function path(reference: DatasetImportTaskReference): string {
  return `/dataset-import-tasks/${encodeURIComponent(reference.taskId)}/versions/${reference.revision}`;
}
