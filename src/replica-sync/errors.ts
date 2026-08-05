/**
 * Error contracts for disconnected replica and sync-conflict review.
 *
 * Unsupported capabilities are explicit errors so clients can hide manual
 * conflict review when it is unavailable, instead of inferring it from empty
 * responses.
 *
 * @module
 */

import { type HonuaErrorCode, HonuaSdkError, isRetryableNetworkOrTimeoutHonuaError } from "../core/error-envelope.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";

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
  /**
   * A server response did not match the dialect this build was written against:
   * an unknown classification code, a missing required member, or a value that
   * cannot be read losslessly. Raised instead of guessing a mapping.
   */
  | "response-drift"
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
    super(replicaSyncSdkCode(code, cause), message, {
      ...(cause === undefined ? {} : { cause }),
      context: { reasonCode: replicaSyncContextReason(code) },
    });
    this.name = "HonuaReplicaSyncError";
    this.code = code;
    this.details = options.details;
  }
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

/**
 * True for every typed refusal that means "this deployment does not offer the
 * replica-sync capability you asked for".
 *
 * Two vocabularies legitimately answer that question: a transport that infers
 * it from its own state raises the `unsupported-*` family, while a transport
 * that reads a server's advertised capability surface raises the SDK-wide
 * {@link HonuaCapabilityNotSupportedError} naming the capability. A caller
 * deciding whether to hide manual conflict review must accept both, so the
 * predicate lives here rather than being re-derived per call site.
 */
export function isReplicaSyncCapabilityRefusal(error: unknown): boolean {
  return isUnsupportedReplicaSyncError(error) || error instanceof HonuaCapabilityNotSupportedError;
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
  "response-drift": "offline.replica-sync.validation",
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
