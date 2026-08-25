import type {
  OfflineEditEnqueueResult,
  OfflineEditJsonValue,
  OfflineEditQueue,
  OfflineEditQueuePartition,
  OfflineQueuedEdit,
} from "../offline/edit-queue.js";
import type {
  HonuaFeatureEditorConflictChoice,
  HonuaFeatureEditorOfflineState,
  HonuaFeatureEditorSnapshot,
  HonuaFeatureEditorWorkflow,
} from "./feature-editor-workflow.js";

export type HonuaFeatureEditorOfflineErrorCode = "invalid-draft" | "attachment-payload" | "invalid-value";

/** A draft cannot be persisted without an explicit, lossless queue mapping. */
export class HonuaFeatureEditorOfflineError extends Error {
  public readonly name = "HonuaFeatureEditorOfflineError";

  public constructor(
    public readonly code: HonuaFeatureEditorOfflineErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface QueueHonuaFeatureEditorDraftOptions {
  /** Precomputed authorization partition digest. Raw credentials are never accepted. */
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly idempotencyKey: string;
  readonly dependencyIds?: readonly `sha256:${string}`[];
}

export interface QueueHonuaFeatureEditorDraftResult<T = Record<string, unknown>> {
  readonly enqueue: OfflineEditEnqueueResult;
  readonly snapshot: HonuaFeatureEditorSnapshot<T>;
}

/**
 * Persist the current validated draft in the canonical offline edit queue.
 * Attachment payloads fail closed because the queue contract cannot represent
 * them; silently dropping a staged upload would make the recovered edit lie.
 */
export async function queueHonuaFeatureEditorDraft<T>(
  workflow: HonuaFeatureEditorWorkflow<T>,
  queue: OfflineEditQueue,
  options: QueueHonuaFeatureEditorDraftOptions,
): Promise<QueueHonuaFeatureEditorDraftResult<T>> {
  const snapshot = workflow.snapshot();
  const model = workflow.sketchModel();
  if (!model || !snapshot.operation || !snapshot.form) {
    throw new HonuaFeatureEditorOfflineError(
      "invalid-draft",
      "Open an edit draft before adding it to the offline queue.",
    );
  }
  if (!workflow.validate().valid) {
    throw new HonuaFeatureEditorOfflineError(
      "invalid-draft",
      "Fix validation errors before adding the edit to the offline queue.",
    );
  }
  if (snapshot.attachments.length > 0) {
    throw new HonuaFeatureEditorOfflineError(
      "attachment-payload",
      "Offline feature edits do not persist attachment payloads. Remove the staged attachments or submit while online.",
    );
  }

  const feature = model.snapshot().feature;
  const attributes = jsonRecord(feature.attributes, "attributes");
  const geometry = feature.geometry === undefined ? undefined : jsonValue(feature.geometry, "geometry");
  const enqueue = await queue.enqueue({
    authorizationScopeDigest: options.authorizationScopeDigest,
    sourceId: workflow.source.descriptor.id,
    idempotencyKey: requiredText(options.idempotencyKey, "idempotencyKey"),
    edit: {
      operation: snapshot.operation === "create" ? "add" : snapshot.operation,
      ...(feature.id !== undefined ? { featureId: feature.id } : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(geometry !== undefined ? { geometry } : {}),
    },
    ...(options.dependencyIds ? { dependencyIds: options.dependencyIds } : {}),
  });
  return Object.freeze({
    enqueue,
    snapshot: workflow.applyOfflineState(offlineStateFromQueuedEdit(enqueue.edit)),
  });
}

/** Project a later replay/reconnect transition back into the same workflow. */
export function reconcileHonuaFeatureEditorOfflineEdit<T>(
  workflow: HonuaFeatureEditorWorkflow<T>,
  edit: OfflineQueuedEdit,
): HonuaFeatureEditorSnapshot<T> {
  return workflow.applyOfflineState(offlineStateFromQueuedEdit(edit));
}

/** Resolve a queued conflict durably before updating the component state. */
export async function resolveHonuaFeatureEditorOfflineConflict<T>(
  workflow: HonuaFeatureEditorWorkflow<T>,
  queue: OfflineEditQueue,
  edit: OfflineQueuedEdit,
  choice: HonuaFeatureEditorConflictChoice,
  partition: OfflineEditQueuePartition,
): Promise<HonuaFeatureEditorSnapshot<T>> {
  const conflictId = edit.conflict?.conflictId;
  if (edit.state !== "conflicted" || !conflictId) {
    throw new HonuaFeatureEditorOfflineError("invalid-draft", "The offline edit does not have a conflict to resolve.");
  }
  const resolved = await queue.resolveConflict(edit.id, partition, {
    conflictId,
    choice: choice === "keep-mine" ? "accept-client" : "accept-server",
  });
  return reconcileHonuaFeatureEditorOfflineEdit(workflow, resolved);
}

/** Convert the durable queue record to the payload-free component projection. */
export function offlineStateFromQueuedEdit(edit: OfflineQueuedEdit): HonuaFeatureEditorOfflineState {
  const state =
    edit.state === "leased"
      ? "pending"
      : edit.state === "cancelled" && edit.conflictResolution?.disposition === "discarded"
        ? "discarded"
        : edit.state;
  return Object.freeze({
    sourceId: edit.sourceId,
    queueId: edit.id,
    idempotencyKey: edit.idempotencyKey,
    state,
    ...(edit.retry?.retryAt ? { retryAt: edit.retry.retryAt } : {}),
    ...(edit.retry?.reasonCode ? { reasonCode: edit.retry.reasonCode } : {}),
    ...(edit.applied?.appliedAt ? { appliedAt: edit.applied.appliedAt } : {}),
    ...(edit.conflict?.conflictId ? { conflictId: edit.conflict.conflictId } : {}),
    ...(edit.conflict?.serverGeneration ? { serverGeneration: edit.conflict.serverGeneration } : {}),
    ...(edit.cancellation?.reasonCode ? { reasonCode: edit.cancellation.reasonCode } : {}),
  });
}

function jsonRecord(value: unknown, path: string): Readonly<Record<string, OfflineEditJsonValue>> {
  if (!isRecord(value)) throw invalidValue(path);
  const output: Record<string, OfflineEditJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = jsonValue(item, `${path}.${key}`);
  }
  return output;
}

function jsonValue(value: unknown, path: string): OfflineEditJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  if (isRecord(value)) return jsonRecord(value, path);
  throw invalidValue(path);
}

function invalidValue(path: string): HonuaFeatureEditorOfflineError {
  return new HonuaFeatureEditorOfflineError("invalid-value", `${path} must contain only JSON-compatible values.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new HonuaFeatureEditorOfflineError("invalid-draft", `${name} is required.`);
  return normalized;
}
