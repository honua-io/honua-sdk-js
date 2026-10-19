import type { DatasetImportTaskClientOptions } from "./client.js";
import { hashDatasetImportFile } from "./file-hash.js";
import { DatasetImportWorkspaceTransport, validId } from "./transport.js";
import type {
  DatasetImportTaskReference,
  DatasetImportUploadCapabilities,
  DatasetImportUploadReceipt,
} from "./types.js";

const maximumChunkBytes = 4 * 1024 * 1024;
const maximumChunks = 65536;

/**
 * Canonical transfer primitives. No import submission or automatic mutation retry.
 * Persist the original immutable task reference before create; recover uncertain
 * create/chunk/seal/source outcomes using read against that SAME task. Always
 * verify the complete reselected file SHA-256 before sending any resumed chunk.
 */
export class DatasetImportUploadClient {
  private readonly transport: DatasetImportWorkspaceTransport;
  constructor(options: DatasetImportTaskClientOptions) {
    this.transport = new DatasetImportWorkspaceTransport(options);
  }

  async capabilities(
    reference: DatasetImportTaskReference,
    signal?: AbortSignal,
  ): Promise<DatasetImportUploadCapabilities | null> {
    const pinned = pin(reference);
    const value = await this.transport.request<DatasetImportUploadCapabilities>(
      `${path(pinned)}/capabilities?contentHash=${pinned.contentHash}`,
      "GET",
      undefined,
      signal,
      true,
    );
    if (
      value !== null &&
      (!validChunkBytes(value.chunkBytes) ||
        !Number.isSafeInteger(value.maximumFileBytes) ||
        value.maximumFileBytes < 1 ||
        value.maximumFileBytes > value.chunkBytes * maximumChunks ||
        value.importAcceptanceSupported !== false)
    )
      throw new Error("The host returned an unsupported transfer capability contract.");
    return value;
  }

  async read(reference: DatasetImportTaskReference, signal?: AbortSignal): Promise<DatasetImportUploadReceipt | null> {
    const pinned = pin(reference);
    const value = await this.transport.request<DatasetImportUploadReceipt>(
      `${path(pinned)}?contentHash=${pinned.contentHash}`,
      "GET",
      undefined,
      signal,
      true,
    );
    if (value !== null) validate(value, pinned);
    return value;
  }

  /** Read-only recovery of a known session, preserving its immutable fields and terminal receipts. */
  async reconcile(
    reference: DatasetImportTaskReference,
    original: DatasetImportUploadReceipt,
    signal?: AbortSignal,
  ): Promise<DatasetImportUploadReceipt | null> {
    const pinned = pin(reference);
    const session = captureSession(original, pinned);
    const value = await this.transport.request<DatasetImportUploadReceipt>(
      `${path(pinned)}?contentHash=${pinned.contentHash}`,
      "GET",
      undefined,
      signal,
      true,
    );
    if (value !== null) validate(value, pinned, session);
    return value;
  }

  async create(reference: DatasetImportTaskReference, signal?: AbortSignal): Promise<DatasetImportUploadReceipt> {
    const pinned = pin(reference);
    const body = JSON.stringify({ taskContentHash: pinned.contentHash });
    const value = await this.transport.request<DatasetImportUploadReceipt>(path(pinned), "POST", body, signal);
    validate(value, pinned);
    return value;
  }

  async appendChunk(
    reference: DatasetImportTaskReference,
    original: DatasetImportUploadReceipt,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<DatasetImportUploadReceipt> {
    const pinned = pin(reference);
    const session = captureSession(original, pinned);
    // Snapshot every mutable receipt field before hashing or authentication awaits.
    const { version, acceptedBytes, totalBytes, chunkBytes, state } = session;
    const expectedBytes = Math.min(chunkBytes, totalBytes - acceptedBytes);
    if (state !== "receiving" || expectedBytes < 1 || chunk.size !== expectedBytes)
      throw new TypeError("Exactly one original next chunk is required.");
    const sha256 = await hashDatasetImportFile(chunk, { signal });
    const value = await this.transport.request<DatasetImportUploadReceipt>(
      `${path(pinned)}/chunks?contentHash=${pinned.contentHash}&expectedVersion=${version}&offset=${acceptedBytes}&sha256=${sha256}`,
      "PUT",
      chunk,
      signal,
      false,
      "application/octet-stream",
    );
    validate(value, pinned, session);
    return value;
  }

  async seal(
    reference: DatasetImportTaskReference,
    original: DatasetImportUploadReceipt,
    signal?: AbortSignal,
  ): Promise<DatasetImportUploadReceipt> {
    return await this.mutate(reference, original, "/seal", signal);
  }
  async retainSource(
    reference: DatasetImportTaskReference,
    original: DatasetImportUploadReceipt,
    signal?: AbortSignal,
  ): Promise<DatasetImportUploadReceipt> {
    return await this.mutate(reference, original, "/source", signal);
  }
  async cancel(
    reference: DatasetImportTaskReference,
    original: DatasetImportUploadReceipt,
    signal?: AbortSignal,
  ): Promise<DatasetImportUploadReceipt> {
    const pinned = pin(reference);
    const session = captureSession(original, pinned);
    const { version } = session;
    const value = await this.transport.request<DatasetImportUploadReceipt>(
      `${path(pinned)}?contentHash=${pinned.contentHash}&expectedVersion=${version}`,
      "DELETE",
      undefined,
      signal,
    );
    validate(value, pinned, session);
    return value;
  }
  private async mutate(
    reference: DatasetImportTaskReference,
    original: DatasetImportUploadReceipt,
    action: "/seal" | "/source",
    signal?: AbortSignal,
  ): Promise<DatasetImportUploadReceipt> {
    const pinned = pin(reference);
    const session = captureSession(original, pinned);
    const { version } = session;
    const body = JSON.stringify({ taskContentHash: pinned.contentHash, expectedVersion: version });
    const value = await this.transport.request<DatasetImportUploadReceipt>(
      `${path(pinned)}${action}`,
      "POST",
      body,
      signal,
    );
    validate(value, pinned, session);
    return value;
  }
}

function pin(reference: DatasetImportTaskReference): DatasetImportTaskReference {
  validId(reference.taskId);
  if (!Number.isSafeInteger(reference.revision) || reference.revision < 1 || !digest(reference.contentHash))
    throw new TypeError("An exact immutable task reference is required.");
  return { taskId: reference.taskId, revision: reference.revision, contentHash: reference.contentHash };
}
function digest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function validChunkBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 65536 && value <= maximumChunkBytes;
}
function path(reference: DatasetImportTaskReference): string {
  return `/dataset-import-tasks/${encodeURIComponent(reference.taskId)}/versions/${reference.revision}/upload`;
}
function validate(
  value: DatasetImportUploadReceipt,
  reference: DatasetImportTaskReference,
  session?: SessionSnapshot,
): void {
  if (
    !value ||
    value.taskId !== reference.taskId ||
    value.taskRevision !== reference.revision ||
    value.taskContentHash !== reference.contentHash ||
    typeof value.uploadId !== "string" ||
    value.uploadId.length !== 32 ||
    !/^[a-f0-9]{32}$/.test(value.uploadId) ||
    (session !== undefined && !matchesOriginalSession(value, session)) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 1 ||
    !validChunkBytes(value.chunkBytes) ||
    value.totalBytes > value.chunkBytes * maximumChunks ||
    !Number.isSafeInteger(value.acceptedBytes) ||
    value.acceptedBytes < 0 ||
    value.acceptedBytes > value.totalBytes ||
    value.chunkCount !== Math.ceil(value.acceptedBytes / value.chunkBytes) ||
    value.acceptedBytes !== Math.min(value.chunkCount * value.chunkBytes, value.totalBytes) ||
    !["receiving", "sealed", "cancelled"].includes(value.state) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    (value.state === "sealed"
      ? value.acceptedBytes !== value.totalBytes || !digest(value.contentSha256)
      : value.contentSha256 != null)
  )
    throw new Error("The transfer receipt changed its immutable task/session binding or canonical byte range.");
  if (
    session?.sourceRetention !== undefined &&
    (value.sourceRetention == null ||
      value.sourceRetention.bytes !== session.sourceRetention.bytes ||
      value.sourceRetention.sha256 !== session.sourceRetention.sha256 ||
      (value.sourceRetention.expiresAt ?? null) !== session.sourceRetention.expiresAt)
  )
    throw new Error("The original retained source receipt changed.");
  if (
    value.sourceRetention != null &&
    (value.state !== "sealed" ||
      value.sourceRetention.bytes !== value.totalBytes ||
      value.sourceRetention.sha256 !== value.contentSha256 ||
      (value.sourceRetention.expiresAt != null && !Number.isFinite(Date.parse(value.sourceRetention.expiresAt))))
  )
    throw new Error("The retained source receipt does not match the sealed original bytes.");
}

interface SessionSnapshot {
  readonly uploadId: string;
  readonly version: number;
  readonly state: DatasetImportUploadReceipt["state"];
  readonly acceptedBytes: number;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly expiresAt: string;
  readonly contentSha256?: string | null;
  readonly sourceRetention?: { readonly bytes: number; readonly sha256: string; readonly expiresAt: string | null };
}
function captureSession(original: DatasetImportUploadReceipt, reference: DatasetImportTaskReference): SessionSnapshot {
  validate(original, reference);
  return {
    uploadId: original.uploadId,
    version: original.version,
    state: original.state,
    acceptedBytes: original.acceptedBytes,
    totalBytes: original.totalBytes,
    chunkBytes: original.chunkBytes,
    expiresAt: original.expiresAt,
    contentSha256: original.contentSha256,
    ...(original.sourceRetention == null
      ? {}
      : {
          sourceRetention: {
            bytes: original.sourceRetention.bytes,
            sha256: original.sourceRetention.sha256,
            expiresAt: original.sourceRetention.expiresAt ?? null,
          },
        }),
  };
}

function matchesOriginalSession(value: DatasetImportUploadReceipt, original: SessionSnapshot): boolean {
  if (
    value.uploadId !== original.uploadId ||
    value.totalBytes !== original.totalBytes ||
    value.chunkBytes !== original.chunkBytes ||
    value.expiresAt !== original.expiresAt ||
    value.version < original.version ||
    value.acceptedBytes < original.acceptedBytes ||
    (original.state !== "receiving" && value.state !== original.state) ||
    (original.state === "cancelled" && value.acceptedBytes !== original.acceptedBytes) ||
    (original.contentSha256 != null && value.contentSha256 !== original.contentSha256)
  )
    return false;
  // Every byte/state/source mutation advances canonical CAS version. A same-version
  // response cannot add bytes, a seal, cancellation or a retained source receipt.
  return (
    value.version !== original.version ||
    (value.acceptedBytes === original.acceptedBytes &&
      value.state === original.state &&
      (value.contentSha256 ?? null) === (original.contentSha256 ?? null) &&
      sameRetention(value.sourceRetention, original.sourceRetention))
  );
}
function sameRetention(
  left: DatasetImportUploadReceipt["sourceRetention"],
  right: SessionSnapshot["sourceRetention"],
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left.bytes === right.bytes && left.sha256 === right.sha256 && (left.expiresAt ?? null) === (right.expiresAt ?? null)
  );
}
