import type { SavedMapCollaborationErrorCode } from "./types.js";

export class HonuaCollaborationError extends Error {
  public readonly code: SavedMapCollaborationErrorCode;
  public readonly details: unknown;
  public readonly retryAfterMs: number | undefined;
  public readonly resyncRequired: boolean;

  public constructor(
    code: SavedMapCollaborationErrorCode,
    message: string,
    options: {
      readonly details?: unknown;
      readonly retryAfterMs?: number;
      readonly resyncRequired?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HonuaCollaborationError";
    this.code = code;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
    this.resyncRequired = options.resyncRequired ?? (code === "resync-required" || code === "stale-cursor");
  }
}

export function isHonuaCollaborationError(error: unknown): error is HonuaCollaborationError {
  return error instanceof HonuaCollaborationError;
}
