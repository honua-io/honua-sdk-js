/**
 * Error contracts for disconnected replica and sync-conflict review.
 *
 * Unsupported capabilities are explicit errors so clients can hide manual
 * conflict review when it is unavailable, instead of inferring it from empty
 * responses.
 *
 * @module
 */

import {
  type HonuaErrorCode,
  HonuaSdkError,
  isRetryableNetworkOrTimeoutHonuaError,
  withHonuaErrorReasonClassification,
} from "../core/error-base.js";

export type ReplicaSyncErrorCode =
  | "unsupported-sync"
  | "unsupported-conflict-review"
  | "unsupported-conflict-resolution"
  | "replica-not-found"
  | "conflict-not-found"
  | "replica-expired"
  | "conflict-already-resolved"
  | "merge-required"
  | "permission-denied"
  | "transport-failure";

export class HonuaReplicaSyncError extends HonuaSdkError {
  public readonly code: ReplicaSyncErrorCode;
  public readonly details: unknown;

  public constructor(
    code: ReplicaSyncErrorCode,
    message: string,
    options: { readonly details?: unknown; readonly cause?: unknown } = {},
  ) {
    const cause = options.cause;
    const sdkCode = replicaSyncSdkCode(code, cause);
    super(
      sdkCode,
      message,
      withHonuaErrorReasonClassification(
        cause === undefined ? {} : { cause },
        "offline",
        replicaSyncErrorCategory(sdkCode),
        sdkCode === "offline.transport.transient",
        replicaSyncContextReason(code),
      ),
    );
    this.name = "HonuaReplicaSyncError";
    this.code = code;
    this.details = options.details;
  }
}

function replicaSyncErrorCategory(code: HonuaErrorCode) {
  if (code === "offline.replica-sync.capability") return "capability" as const;
  if (code === "offline.replica-sync.permission-denied") return "authentication" as const;
  if (code === "offline.transport.failure" || code === "offline.transport.transient") return "network" as const;
  return "validation" as const;
}

export function isHonuaReplicaSyncError(error: unknown): error is HonuaReplicaSyncError {
  return error instanceof HonuaReplicaSyncError;
}

/** True for the `unsupported-*` family of codes. */
export function isUnsupportedReplicaSyncError(error: unknown): error is HonuaReplicaSyncError {
  return (
    isHonuaReplicaSyncError(error) &&
    (error.code === "unsupported-sync" ||
      error.code === "unsupported-conflict-review" ||
      error.code === "unsupported-conflict-resolution")
  );
}

const REPLICA_SYNC_ERROR_CODES = {
  "unsupported-sync": "offline.replica-sync.capability",
  "unsupported-conflict-review": "offline.replica-sync.capability",
  "unsupported-conflict-resolution": "offline.replica-sync.capability",
  "replica-not-found": "offline.replica-sync.validation",
  "conflict-not-found": "offline.replica-sync.validation",
  "replica-expired": "offline.replica-sync.validation",
  "conflict-already-resolved": "offline.replica-sync.validation",
  "merge-required": "offline.replica-sync.validation",
  "permission-denied": "offline.replica-sync.permission-denied",
  "transport-failure": "offline.transport.failure",
} as const satisfies Record<ReplicaSyncErrorCode, HonuaErrorCode>;

function replicaSyncSdkCode(code: unknown, cause: unknown): HonuaErrorCode {
  if (!isReplicaSyncErrorCode(code)) return "offline.replica-sync.validation";
  if (code === "transport-failure" && isRetryableNetworkOrTimeoutHonuaError(cause)) {
    return "offline.transport.transient";
  }
  return REPLICA_SYNC_ERROR_CODES[code];
}

function replicaSyncContextReason(code: unknown): ReplicaSyncErrorCode | "invalid-error-code" {
  return isReplicaSyncErrorCode(code) ? code : "invalid-error-code";
}

function isReplicaSyncErrorCode(code: unknown): code is ReplicaSyncErrorCode {
  return typeof code === "string" && Object.hasOwn(REPLICA_SYNC_ERROR_CODES, code);
}
