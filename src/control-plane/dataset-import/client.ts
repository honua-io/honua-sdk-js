import { DatasetImportWorkspaceTransport, validId } from "./transport.js";
export { DatasetImportTaskApiError } from "./errors.js";
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

/**
 * Canonical task/authority APIs only. Never dispatches an import, retries a POST,
 * invents an authority revision, or treats preparation as an accepted job.
 * Persist original intent/renewal IDs before calling mutation methods. On lost
 * replies use readIntent or replay the SAME renewal ID, never mint a replacement.
 */
export class DatasetImportTaskClient {
  private readonly workspaceId: string;
  private readonly targetId: string;
  private readonly transport: DatasetImportWorkspaceTransport;

  constructor(options: DatasetImportTaskClientOptions) {
    this.transport = new DatasetImportWorkspaceTransport(options);
    this.workspaceId = options.workspaceId;
    this.targetId = options.targetId;
  }

  async createTask(request: CreateDatasetImportTask, signal?: AbortSignal): Promise<DatasetImportTask> {
    // Serialize before the first await so later form edits cannot change the request.
    const body = JSON.stringify(request);
    const task = await this.transport.request<DatasetImportTask>("/dataset-import-tasks", "POST", body, signal);
    this.assertTask(task);
    return task;
  }

  async readIntent(intentId: string, signal?: AbortSignal): Promise<DatasetImportTask | null> {
    validId(intentId);
    const task = await this.transport.request<DatasetImportTask>(
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
    const task = await this.transport.request<DatasetImportTask>(path(pinned), "GET", undefined, signal, true);
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
    const descriptor = await this.transport.request<DatasetImportAuthorityDescriptor>(
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
        descriptor.authorityRevision < 1 ||
        !validDigest(descriptor.authorityFingerprint) ||
        !validDigest(descriptor.policyContextFingerprint) ||
        !validDigest(descriptor.originalTurnHash) ||
        typeof descriptor.executorActorId !== "string" ||
        descriptor.executorActorId.length < 1 ||
        typeof descriptor.originatingTurnId !== "string" ||
        descriptor.originatingTurnId.length < 1 ||
        !Number.isFinite(Date.parse(descriptor.uploadAdmissionDeadline)) ||
        (descriptor.preparedOperationId != null &&
          (descriptor.preparedOperationId.length !== 32 || !/^[a-f0-9]{32}$/.test(descriptor.preparedOperationId))))
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
    const receipt = await this.transport.request<DatasetImportAuthorityRenewal>(
      `${path(pinned)}/authority-renewals`,
      "POST",
      body,
      signal,
    );
    if (
      receipt.renewalId !== renewalId ||
      receipt.previousAuthorityRevision !== previousRevision ||
      receipt.authorityRevision !== previousRevision + 1 ||
      !validDigest(receipt.authorityFingerprint) ||
      !Number.isFinite(Date.parse(receipt.renewedAt))
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

function validDigest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
