/**
 * Error contracts for disconnected replica and sync-conflict review.
 *
 * Unsupported capabilities are explicit errors so clients can hide manual
 * conflict review when it is unavailable, instead of inferring it from empty
 * responses.
 *
 * @module
 */

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

export class HonuaReplicaSyncError extends Error {
  public readonly code: ReplicaSyncErrorCode;
  public readonly details: unknown;

  public constructor(
    code: ReplicaSyncErrorCode,
    message: string,
    options: { readonly details?: unknown; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
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
