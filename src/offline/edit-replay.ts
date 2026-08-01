import {
  HonuaOfflineEditQueueError,
  MAX_OFFLINE_EDIT_LEASE_DURATION_MS,
  type OfflineEditQueue,
  type OfflineEditQueuePartition,
  type OfflineFeatureEdit,
  type OfflineQueuedEdit,
} from "./edit-queue.js";

export const HONUA_OFFLINE_EDIT_REPLAY_VERSION = "1.0" as const;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_STRING_BYTES = 1024;
const encoder = new TextEncoder();
const OPTION_KEYS = new Set(["authorizationScopeDigest", "sourceId", "workerId", "limit", "leaseDurationMs", "signal"]);
const COMMON_ACKNOWLEDGEMENT_KEYS = ["kind", "editId", "requestFingerprint", "idempotencyKey"] as const;
const APPLIED_ACKNOWLEDGEMENT_KEYS = new Set([...COMMON_ACKNOWLEDGEMENT_KEYS, "serverOperationId", "serverGeneration"]);
const RETRYABLE_ACKNOWLEDGEMENT_KEYS = new Set([...COMMON_ACKNOWLEDGEMENT_KEYS, "retryAt", "reasonCode"]);
const CONFLICTED_ACKNOWLEDGEMENT_KEYS = new Set([...COMMON_ACKNOWLEDGEMENT_KEYS, "conflictId", "serverGeneration"]);

export interface OfflineEditReplayIdentity {
  readonly editId: `sha256:${string}`;
  readonly requestFingerprint: `sha256:${string}`;
  readonly idempotencyKey: string;
}

export interface OfflineEditReplayRequest extends OfflineEditReplayIdentity {
  readonly version: typeof HONUA_OFFLINE_EDIT_REPLAY_VERSION;
  readonly sourceId: string;
  readonly edit: OfflineFeatureEdit;
}

export interface OfflineEditAppliedAcknowledgement extends OfflineEditReplayIdentity {
  readonly kind: "applied";
  readonly serverOperationId: string;
  readonly serverGeneration?: string;
}

export interface OfflineEditRetryableAcknowledgement extends OfflineEditReplayIdentity {
  readonly kind: "retryable";
  readonly retryAt: string;
  readonly reasonCode: string;
}

export interface OfflineEditConflictedAcknowledgement extends OfflineEditReplayIdentity {
  readonly kind: "conflicted";
  readonly conflictId: string;
  readonly serverGeneration?: string;
}

export type OfflineEditReplayAcknowledgement =
  | OfflineEditAppliedAcknowledgement
  | OfflineEditRetryableAcknowledgement
  | OfflineEditConflictedAcknowledgement;

export interface OfflineEditReplayTransportContext {
  readonly signal?: AbortSignal;
}

/**
 * Application-owned binding to a server mutation transport. Returned values
 * are treated as untrusted and validated before queue state changes.
 */
export type OfflineEditReplayTransport = (
  request: OfflineEditReplayRequest,
  context: OfflineEditReplayTransportContext,
) => unknown | Promise<unknown>;

export interface ReplayOfflineEditPassOptions extends OfflineEditQueuePartition {
  readonly workerId: string;
  /** Required, between 1 and 100 inclusive. */
  readonly limit: number;
  /** Required, positive, and no more than 24 hours. */
  readonly leaseDurationMs: number;
  readonly signal?: AbortSignal;
}

export type OfflineEditReplayUnacknowledgedReason =
  | "cancelled"
  | "identity-mismatch"
  | "invalid-acknowledgement"
  | "missing-lease"
  | "transition-rejected"
  | "transport-threw";

export interface OfflineEditReplayItemReceipt {
  readonly editId: `sha256:${string}`;
  readonly outcome: "applied" | "retryable" | "conflicted" | "unacknowledged";
  readonly reasonCode?: OfflineEditReplayUnacknowledgedReason;
}

export interface OfflineEditReplayPassReceipt {
  readonly version: typeof HONUA_OFFLINE_EDIT_REPLAY_VERSION;
  readonly claimedCount: number;
  readonly invokedCount: number;
  readonly appliedCount: number;
  readonly retryableCount: number;
  readonly conflictedCount: number;
  readonly unacknowledgedCount: number;
  readonly stoppedReason?: "cancelled";
  readonly outcomes: readonly OfflineEditReplayItemReceipt[];
}

interface NormalizedReplayOptions extends OfflineEditQueuePartition {
  readonly workerId: string;
  readonly limit: number;
  readonly leaseDurationMs: number;
  readonly signal?: AbortSignal;
}

class AcknowledgementError extends Error {
  public constructor(public readonly code: "identity-mismatch" | "invalid-acknowledgement") {
    super(code);
    this.name = "AcknowledgementError";
  }
}

/** Claim and replay one bounded, deterministic queue pass. */
export async function replayOfflineEditPass(
  queue: OfflineEditQueue,
  transport: OfflineEditReplayTransport,
  options: ReplayOfflineEditPassOptions,
): Promise<OfflineEditReplayPassReceipt> {
  if (!queue || typeof queue.claimReady !== "function") {
    invalid("queue must implement OfflineEditQueue.", "queue");
  }
  if (typeof transport !== "function") invalid("transport must be a function.", "transport");
  const normalized = captureOptions(options);
  if (normalized.signal?.aborted) return createReceipt([], 0, "cancelled");

  const claimed = (
    await queue.claimReady({
      authorizationScopeDigest: normalized.authorizationScopeDigest,
      sourceId: normalized.sourceId,
      workerId: normalized.workerId,
      limit: normalized.limit,
      leaseDurationMs: normalized.leaseDurationMs,
    })
  ).slice(0, normalized.limit);
  const outcomes: OfflineEditReplayItemReceipt[] = [];
  let invokedCount = 0;
  let stoppedReason: "cancelled" | undefined;

  for (let index = 0; index < claimed.length; index += 1) {
    const queued = claimed[index];
    if (normalized.signal?.aborted) {
      stoppedReason = "cancelled";
      for (const remaining of claimed.slice(index)) {
        outcomes.push(unacknowledged(remaining.id, "cancelled"));
      }
      break;
    }
    const leaseToken = queued.lease?.token;
    if (!leaseToken) {
      outcomes.push(unacknowledged(queued.id, "missing-lease"));
      continue;
    }

    let rawAcknowledgement: unknown;
    invokedCount += 1;
    try {
      rawAcknowledgement = await transport(replayRequest(queued), transportContext(normalized.signal));
    } catch {
      const cancelled = normalized.signal?.aborted === true;
      outcomes.push(unacknowledged(queued.id, cancelled ? "cancelled" : "transport-threw"));
      if (cancelled) stoppedReason = "cancelled";
      continue;
    }

    let acknowledgement: OfflineEditReplayAcknowledgement;
    try {
      acknowledgement = captureAcknowledgement(rawAcknowledgement, queued);
    } catch (error) {
      outcomes.push(
        unacknowledged(queued.id, error instanceof AcknowledgementError ? error.code : "invalid-acknowledgement"),
      );
      continue;
    }

    try {
      if (acknowledgement.kind === "applied") {
        await queue.markApplied(queued.id, leaseToken, {
          serverOperationId: acknowledgement.serverOperationId,
          ...(acknowledgement.serverGeneration === undefined
            ? {}
            : { serverGeneration: acknowledgement.serverGeneration }),
        });
      } else if (acknowledgement.kind === "retryable") {
        await queue.markRetry(queued.id, leaseToken, {
          retryAt: acknowledgement.retryAt,
          reasonCode: acknowledgement.reasonCode,
        });
      } else {
        await queue.markConflicted(queued.id, leaseToken, {
          conflictId: acknowledgement.conflictId,
          ...(acknowledgement.serverGeneration === undefined
            ? {}
            : { serverGeneration: acknowledgement.serverGeneration }),
        });
      }
      outcomes.push(deepFreeze({ editId: queued.id, outcome: acknowledgement.kind }));
    } catch {
      outcomes.push(unacknowledged(queued.id, "transition-rejected"));
    }
  }

  return createReceipt(outcomes, invokedCount, stoppedReason);
}

function captureOptions(value: ReplayOfflineEditPassOptions): NormalizedReplayOptions {
  const record = optionRecord(value);
  for (const key of Object.keys(record)) {
    if (!OPTION_KEYS.has(key)) invalid(`options.${key} is not allowed.`, `options.${key}`);
  }
  const authorizationScopeDigest = optionDigest(record.authorizationScopeDigest, "options.authorizationScopeDigest");
  const sourceId = optionString(record.sourceId, "options.sourceId");
  const workerId = optionString(record.workerId, "options.workerId");
  const limit = boundedInteger(record.limit, "options.limit", 100);
  const leaseDurationMs = boundedInteger(
    record.leaseDurationMs,
    "options.leaseDurationMs",
    MAX_OFFLINE_EDIT_LEASE_DURATION_MS,
  );
  const signal = record.signal;
  if (signal !== undefined && !isAbortSignal(signal)) {
    invalid("options.signal must be an AbortSignal.", "options.signal");
  }
  return {
    authorizationScopeDigest,
    sourceId,
    workerId,
    limit,
    leaseDurationMs,
    ...(signal === undefined ? {} : { signal }),
  };
}

function replayRequest(queued: OfflineQueuedEdit): OfflineEditReplayRequest {
  return deepFreeze({
    version: HONUA_OFFLINE_EDIT_REPLAY_VERSION,
    editId: queued.id,
    requestFingerprint: queued.requestFingerprint,
    idempotencyKey: queued.idempotencyKey,
    sourceId: queued.sourceId,
    edit: queued.edit,
  });
}

function transportContext(signal: AbortSignal | undefined): OfflineEditReplayTransportContext {
  return Object.freeze(signal === undefined ? {} : { signal });
}

function captureAcknowledgement(value: unknown, queued: OfflineQueuedEdit): OfflineEditReplayAcknowledgement {
  const record = dataRecord(value, "acknowledgement");
  const kind = record.kind;
  if (kind === "applied") {
    allowedKeys(record, APPLIED_ACKNOWLEDGEMENT_KEYS, "acknowledgement");
    const identity = acknowledgementIdentity(record, queued);
    return deepFreeze({
      kind,
      ...identity,
      serverOperationId: normalizedString(record.serverOperationId, "acknowledgement.serverOperationId"),
      ...(record.serverGeneration === undefined
        ? {}
        : { serverGeneration: normalizedString(record.serverGeneration, "acknowledgement.serverGeneration") }),
    });
  }
  if (kind === "retryable") {
    allowedKeys(record, RETRYABLE_ACKNOWLEDGEMENT_KEYS, "acknowledgement");
    const identity = acknowledgementIdentity(record, queued);
    return deepFreeze({
      kind,
      ...identity,
      retryAt: normalizedTimestamp(record.retryAt, "acknowledgement.retryAt"),
      reasonCode: normalizedString(record.reasonCode, "acknowledgement.reasonCode"),
    });
  }
  if (kind === "conflicted") {
    allowedKeys(record, CONFLICTED_ACKNOWLEDGEMENT_KEYS, "acknowledgement");
    const identity = acknowledgementIdentity(record, queued);
    return deepFreeze({
      kind,
      ...identity,
      conflictId: normalizedString(record.conflictId, "acknowledgement.conflictId"),
      ...(record.serverGeneration === undefined
        ? {}
        : { serverGeneration: normalizedString(record.serverGeneration, "acknowledgement.serverGeneration") }),
    });
  }
  throw new AcknowledgementError("invalid-acknowledgement");
}

function acknowledgementIdentity(
  record: Record<string, unknown>,
  queued: OfflineQueuedEdit,
): OfflineEditReplayIdentity {
  const identity = {
    editId: digest(record.editId, "acknowledgement.editId"),
    requestFingerprint: digest(record.requestFingerprint, "acknowledgement.requestFingerprint"),
    idempotencyKey: normalizedString(record.idempotencyKey, "acknowledgement.idempotencyKey"),
  };
  if (
    identity.editId !== queued.id ||
    identity.requestFingerprint !== queued.requestFingerprint ||
    identity.idempotencyKey !== queued.idempotencyKey
  ) {
    throw new AcknowledgementError("identity-mismatch");
  }
  return identity;
}

function createReceipt(
  outcomes: readonly OfflineEditReplayItemReceipt[],
  invokedCount: number,
  stoppedReason?: "cancelled",
): OfflineEditReplayPassReceipt {
  return deepFreeze({
    version: HONUA_OFFLINE_EDIT_REPLAY_VERSION,
    claimedCount: outcomes.length,
    invokedCount,
    appliedCount: outcomes.filter((outcome) => outcome.outcome === "applied").length,
    retryableCount: outcomes.filter((outcome) => outcome.outcome === "retryable").length,
    conflictedCount: outcomes.filter((outcome) => outcome.outcome === "conflicted").length,
    unacknowledgedCount: outcomes.filter((outcome) => outcome.outcome === "unacknowledged").length,
    ...(stoppedReason === undefined ? {} : { stoppedReason }),
    outcomes: [...outcomes],
  });
}

function unacknowledged(
  editId: `sha256:${string}`,
  reasonCode: OfflineEditReplayUnacknowledgedReason,
): OfflineEditReplayItemReceipt {
  return deepFreeze({ editId, outcome: "unacknowledged", reasonCode });
}

function dataRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    acknowledgementInvalid(`${path} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    acknowledgementInvalid(`${path} must use a safe prototype.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    acknowledgementInvalid(`${path} cannot contain symbol keys.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) acknowledgementInvalid(`${path}.${key} must be a data property.`);
    record[key] = descriptor.value;
  }
  return record;
}

function optionRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("options must be a plain data object.", "options");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("options must use a safe prototype.", "options");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid("options cannot contain symbol keys.", "options");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) invalid(`options.${key} must be a data property.`, `options.${key}`);
    record[key] = descriptor.value;
  }
  return record;
}

function allowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) acknowledgementInvalid(`${path}.${key} is not allowed.`);
  }
}

function normalizedString(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_BYTES ||
    value.trim() !== value ||
    encoder.encode(value).byteLength > MAX_STRING_BYTES
  ) {
    acknowledgementInvalid(`${path} must be a normalized non-empty string of at most 1024 UTF-8 bytes.`);
  }
  return value;
}

function optionString(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_BYTES ||
    value.trim() !== value ||
    encoder.encode(value).byteLength > MAX_STRING_BYTES
  ) {
    invalid(`${path} must be a normalized non-empty string of at most 1024 UTF-8 bytes.`, path);
  }
  return value;
}

function optionDigest(value: unknown, path: string): `sha256:${string}` {
  const result = optionString(value, path);
  if (!DIGEST_PATTERN.test(result)) invalid(`${path} must be a lowercase SHA-256 digest.`, path);
  return result as `sha256:${string}`;
}

function digest(value: unknown, path: string): `sha256:${string}` {
  const result = normalizedString(value, path);
  if (!DIGEST_PATTERN.test(result)) acknowledgementInvalid(`${path} must be a lowercase SHA-256 digest.`);
  return result as `sha256:${string}`;
}

function normalizedTimestamp(value: unknown, path: string): string {
  const result = normalizedString(value, path);
  const time = Date.parse(result);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== result) {
    acknowledgementInvalid(`${path} must be a normalized ISO timestamp.`);
  }
  return result;
}

function boundedInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    invalid(`${path} must be a positive safe integer no greater than ${maximum}.`, path);
  }
  return value as number;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function"
  );
}

function acknowledgementInvalid(message: string): never {
  void message;
  throw new AcknowledgementError("invalid-acknowledgement");
}

function invalid(message: string, path: string): never {
  throw new HonuaOfflineEditQueueError("invalid-edit", message, { path });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
