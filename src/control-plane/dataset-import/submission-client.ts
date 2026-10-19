import type { DatasetImportTaskClientOptions } from "./client.js";
import { DatasetImportWorkspaceTransport, validId } from "./transport.js";
import type {
  DatasetImportAuthorityDescriptor,
  DatasetImportOutputReceipt,
  DatasetImportSubmissionReceipt,
  DatasetImportTaskReference,
} from "./types.js";

/**
 * Shared canonical submission/status transport. Human POST prepares the original
 * task and awaits its actual agent; only an authenticated executor can dispatch.
 * Persist the task and reviewed authority BEFORE POST. After an unknown reply,
 * read/reconcile the SAME task; GET never dispatches and there is no POST retry.
 * Explicit original POST replay is a deliberate caller action, never automatic.
 */
export class DatasetImportSubmissionClient {
  private readonly transport: DatasetImportWorkspaceTransport;
  constructor(options: DatasetImportTaskClientOptions) {
    this.transport = new DatasetImportWorkspaceTransport(options);
  }

  async read(
    reference: DatasetImportTaskReference,
    signal?: AbortSignal,
  ): Promise<DatasetImportSubmissionReceipt | null> {
    const pinned = pin(reference);
    const value = await this.transport.request<DatasetImportSubmissionReceipt>(
      `${path(pinned)}?contentHash=${pinned.contentHash}`,
      "GET",
      undefined,
      signal,
      true,
    );
    if (value !== null) validate(value, pinned);
    return value;
  }

  /** Snapshot and validate the original known receipt before the authentication await. */
  async reconcile(
    reference: DatasetImportTaskReference,
    original: DatasetImportSubmissionReceipt,
    signal?: AbortSignal,
  ): Promise<DatasetImportSubmissionReceipt | null> {
    const pinned = pin(reference);
    const before = structuredClone(original);
    validate(before, pinned);
    const value = await this.read(pinned, signal);
    if (value !== null) {
      if (before.state !== "not-prepared") requireOriginal(before, value);
      if (before.state === "accepted") {
        if (
          value.state !== "accepted" ||
          value.job!.jobId !== before.job!.jobId ||
          value.job!.leaseId !== before.job!.leaseId ||
          value.job!.createdAt !== before.job!.createdAt
        )
          fail();
        if (
          terminal(before.job!.status) &&
          (value.job!.status !== before.job!.status ||
            outputKey(value.job!.output) !== outputKey(before.job!.output) ||
            value.job!.completedAt !== before.job!.completedAt ||
            value.job!.errorCode !== before.job!.errorCode)
        )
          fail();
      }
    }
    return value;
  }

  async submit(
    reference: DatasetImportTaskReference,
    reviewed: DatasetImportAuthorityDescriptor,
    signal?: AbortSignal,
  ): Promise<DatasetImportSubmissionReceipt> {
    const pinned = pin(reference);
    if (
      !reviewed ||
      reviewed.taskId !== pinned.taskId ||
      reviewed.taskRevision !== pinned.revision ||
      reviewed.taskContentHash !== pinned.contentHash ||
      !positive(reviewed.authorityRevision) ||
      !digest(reviewed.authorityFingerprint) ||
      !digest(reviewed.policyContextFingerprint) ||
      !date(reviewed.uploadAdmissionDeadline) ||
      (reviewed.preparedOperationId != null && !operation(reviewed.preparedOperationId))
    )
      throw new TypeError("An exact reviewed task authority and original admission deadline are required.");
    const expected = {
      authorityRevision: reviewed.authorityRevision,
      authorityFingerprint: reviewed.authorityFingerprint,
      policyContextFingerprint: reviewed.policyContextFingerprint,
      acceptBefore: reviewed.uploadAdmissionDeadline,
      operationId: reviewed.preparedOperationId,
    };
    const body = JSON.stringify({
      taskContentHash: pinned.contentHash,
      authorityRevision: expected.authorityRevision,
      authorityFingerprint: expected.authorityFingerprint,
      policyContextFingerprint: expected.policyContextFingerprint,
    });
    const value = await this.transport.request<DatasetImportSubmissionReceipt>(path(pinned), "POST", body, signal);
    validate(value, pinned);
    if (
      value.state === "not-prepared" ||
      value.authorityRevision !== expected.authorityRevision ||
      value.authorityFingerprint !== expected.authorityFingerprint ||
      value.policyContextFingerprint !== expected.policyContextFingerprint ||
      Date.parse(value.acceptBefore!) !== Date.parse(expected.acceptBefore) ||
      (expected.operationId != null && value.operationId !== expected.operationId)
    )
      fail();
    return value;
  }
}

function pin(reference: DatasetImportTaskReference): DatasetImportTaskReference {
  if (!reference) throw new TypeError("An immutable task reference is required.");
  validId(reference.taskId);
  if (!positive(reference.revision) || !digest(reference.contentHash))
    throw new TypeError("An immutable task reference is required.");
  return { taskId: reference.taskId, revision: reference.revision, contentHash: reference.contentHash };
}
function path(reference: DatasetImportTaskReference): string {
  return `/dataset-import-tasks/${encodeURIComponent(reference.taskId)}/versions/${reference.revision}/submission`;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function operation(value: unknown): value is string {
  return typeof value === "string" && value.length === 32 && /^[a-f0-9]{32}$/.test(value);
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}
function outputKey(output: DatasetImportOutputReceipt | null | undefined): string {
  return output == null
    ? "null"
    : JSON.stringify([output.schema, output.physicalTableName, output.featureCount, output.detectedSrid ?? null]);
}
function terminal(value: string): boolean {
  return ["succeeded", "failed", "cancelled"].includes(value);
}
function fail(): never {
  throw new Error("Submission response changed the original task, authority, operation or accepted job receipt.");
}
function requireOriginal(before: DatasetImportSubmissionReceipt, value: DatasetImportSubmissionReceipt): void {
  if (
    value.state === "not-prepared" ||
    value.operationId !== before.operationId ||
    value.authorityRevision !== before.authorityRevision ||
    value.authorityFingerprint !== before.authorityFingerprint ||
    value.policyContextFingerprint !== before.policyContextFingerprint ||
    value.acceptBefore !== before.acceptBefore
  )
    fail();
}
function validate(value: DatasetImportSubmissionReceipt, reference: DatasetImportTaskReference): void {
  if (
    !value ||
    value.taskId !== reference.taskId ||
    value.taskRevision !== reference.revision ||
    value.taskContentHash !== reference.contentHash ||
    !["not-prepared", "prepared", "accepted"].includes(value.state)
  )
    fail();
  if (value.state === "not-prepared") {
    if (
      [
        value.operationId,
        value.authorityRevision,
        value.authorityFingerprint,
        value.policyContextFingerprint,
        value.acceptBefore,
        value.job,
      ].some((item) => item != null)
    )
      fail();
    return;
  }
  if (
    !operation(value.operationId) ||
    !positive(value.authorityRevision) ||
    !digest(value.authorityFingerprint) ||
    !digest(value.policyContextFingerprint) ||
    !date(value.acceptBefore)
  )
    fail();
  if (value.state === "prepared") {
    if (value.job != null) fail();
    return;
  }
  const job = value.job;
  if (
    !job ||
    job.jobId !== value.operationId ||
    !text(job.leaseId) ||
    !["queued", "provisioning", "running", "succeeded", "failed", "cancelled"].includes(job.status) ||
    !date(job.createdAt) ||
    !date(job.updatedAt) ||
    Date.parse(job.updatedAt) < Date.parse(job.createdAt) ||
    (job.completedAt != null && (!date(job.completedAt) || !terminal(job.status))) ||
    (job.percentComplete != null &&
      (!Number.isFinite(job.percentComplete) || job.percentComplete < 0 || job.percentComplete > 100)) ||
    (job.errorCode != null && (job.status !== "failed" || job.errorCode !== "import-failed"))
  )
    fail();
  const output = job.output;
  if (
    output != null &&
    (job.status !== "succeeded" ||
      !text(output.schema) ||
      !text(output.physicalTableName) ||
      !Number.isSafeInteger(output.featureCount) ||
      output.featureCount < 0 ||
      output.featureCount > 2147483647 ||
      (output.detectedSrid != null &&
        (!Number.isInteger(output.detectedSrid) ||
          output.detectedSrid < -2147483648 ||
          output.detectedSrid > 2147483647)))
  )
    fail();
}
