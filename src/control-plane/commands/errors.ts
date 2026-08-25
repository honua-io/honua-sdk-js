/**
 * Typed failure taxonomy for the shared control-plane command layer.
 *
 * Every transport surfaces the *same* five discriminants for the same
 * underlying failure, so a negative RBAC or cross-tenant test written once
 * behaves identically from the CLI, MCP, Studio, and direct JS.
 *
 * Like {@link ../../studio/lifecycle-errors.js | HonuaStudioError} and
 * `HonuaCollaborationError`, this module intentionally does not join the
 * central `HonuaSdkError` registry (`src/core/error-code-registry.ts`):
 * `control-plane` is an `@experimental`, not-yet-semver-covered domain and a
 * registry migration is scoped separately.
 *
 * @experimental
 * @module
 */

import { HonuaHttpError } from "../../core/errors.js";
import type { HonuaProblemDetails } from "../types.js";

/**
 * Failure classes a command can raise.
 *
 * - `validation` — input failed the command's declared JSON schema, or the
 *   server rejected the request shape (`400`/`422`).
 * - `conflict` — optimistic concurrency lost: a stale `If-Match` validator or
 *   Studio `generation` (`409`/`412`). Reload and retry.
 * - `authorization` — the caller is not permitted (`401`/`403`), or the caller
 *   tried to override authority locally (a reserved credential/authority
 *   header). Never retry with different local state.
 * - `cancelled` — the caller's `AbortSignal` fired.
 * - `transport` — everything else: network failure, unsupported capability,
 *   `5xx`, or a missing client the command needs.
 */
export type HonuaCommandErrorKind = "validation" | "conflict" | "authorization" | "cancelled" | "transport";

/** One schema or domain validation finding. */
export interface HonuaCommandValidationIssue {
  /** Dotted path into the input, e.g. `package.sources[0].id`; `""` for the root. */
  readonly path: string;
  readonly message: string;
}

/** Constructor options for {@link HonuaCommandError}. */
export interface HonuaCommandErrorOptions {
  readonly cause?: unknown;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly statusCode?: number;
  readonly problem?: HonuaProblemDetails;
  readonly issues?: readonly HonuaCommandValidationIssue[];
}

/** Serialization-safe projection of a {@link HonuaCommandError}. */
export interface SerializedHonuaCommandError {
  readonly kind: "honua.command.error.v1";
  readonly errorKind: HonuaCommandErrorKind;
  readonly commandId: string;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly statusCode?: number;
  readonly issues?: readonly HonuaCommandValidationIssue[];
}

const RETRYABLE_KINDS: ReadonlySet<HonuaCommandErrorKind> = new Set<HonuaCommandErrorKind>(["conflict", "transport"]);

/**
 * The single error type every command raises. Callers branch on `.kind`
 * rather than on HTTP status numbers or transport-specific error classes.
 */
export class HonuaCommandError extends Error {
  public readonly kind: HonuaCommandErrorKind;
  public readonly commandId: string;
  public readonly correlationId: string | undefined;
  public readonly idempotencyKey: string | undefined;
  public readonly statusCode: number | undefined;
  public readonly problem: HonuaProblemDetails | undefined;
  public readonly issues: readonly HonuaCommandValidationIssue[] | undefined;
  /** `conflict` and `transport` are worth retrying; the rest are terminal. */
  public readonly retryable: boolean;

  public constructor(
    kind: HonuaCommandErrorKind,
    commandId: string,
    message: string,
    options: HonuaCommandErrorOptions = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "HonuaCommandError";
    this.kind = kind;
    this.commandId = commandId;
    this.correlationId = options.correlationId;
    this.idempotencyKey = options.idempotencyKey;
    this.statusCode = options.statusCode;
    this.problem = options.problem;
    this.issues = options.issues;
    this.retryable = RETRYABLE_KINDS.has(kind);
  }

  /** Safe JSON projection: no message, stack, cause, or response body. */
  public toJSON(): SerializedHonuaCommandError {
    return {
      kind: "honua.command.error.v1",
      errorKind: this.kind,
      commandId: this.commandId,
      retryable: this.retryable,
      ...(this.correlationId ? { correlationId: this.correlationId } : {}),
      ...(this.idempotencyKey ? { idempotencyKey: this.idempotencyKey } : {}),
      ...(this.statusCode !== undefined ? { statusCode: this.statusCode } : {}),
      ...(this.issues ? { issues: this.issues } : {}),
    };
  }
}

/** Type guard for {@link HonuaCommandError}. */
export function isHonuaCommandError(error: unknown): error is HonuaCommandError {
  return error instanceof HonuaCommandError;
}

/** True when the failure is an optimistic-concurrency loss worth reloading and retrying. */
export function isHonuaCommandConflict(error: unknown): error is HonuaCommandError {
  return isHonuaCommandError(error) && error.kind === "conflict";
}

/** Map an HTTP status code onto the command taxonomy. */
export function classifyCommandStatus(statusCode: number): HonuaCommandErrorKind {
  if (statusCode === 400 || statusCode === 422) return "validation";
  if (statusCode === 401 || statusCode === 403) return "authorization";
  if (statusCode === 409 || statusCode === 412 || statusCode === 428) return "conflict";
  return "transport";
}

/**
 * Normalize anything thrown beneath a command into a {@link HonuaCommandError}.
 *
 * Recognizes `AbortError`/`AbortSignal.reason` (→ `cancelled`), `HonuaHttpError`
 * and any structurally equivalent error carrying `statusCode` (→ the status
 * classification, which also covers `HonuaStudioError`'s `409`
 * `generation-conflict`), and falls back to `transport`.
 */
export function toHonuaCommandError(
  error: unknown,
  commandId: string,
  context: { readonly correlationId: string; readonly idempotencyKey: string; readonly signal?: AbortSignal },
): HonuaCommandError {
  if (isHonuaCommandError(error)) return error;

  const base = {
    cause: error,
    correlationId: context.correlationId,
    idempotencyKey: context.idempotencyKey,
  } as const;

  if (isAbortLike(error) || context.signal?.aborted === true) {
    return new HonuaCommandError("cancelled", commandId, `Command ${commandId} was cancelled by the caller.`, base);
  }

  const statusCode = httpStatusOf(error);
  if (statusCode !== undefined) {
    const kind = classifyCommandStatus(statusCode);
    return new HonuaCommandError(kind, commandId, `Command ${commandId} failed with HTTP ${statusCode}.`, {
      ...base,
      statusCode,
      ...(problemOf(error) ? { problem: problemOf(error) } : {}),
    });
  }

  return new HonuaCommandError("transport", commandId, `Command ${commandId} failed before a response was read.`, base);
}

function isAbortLike(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Read an HTTP status off `HonuaHttpError` or any structurally equivalent
 * error. Studio's `HonuaStudioError` is matched structurally on purpose — it
 * ships in a different split package, so `instanceof` is not reliable.
 */
function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof HonuaHttpError) return error.statusCode;
  if (typeof error !== "object" || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : undefined;
}

function problemOf(error: unknown): HonuaProblemDetails | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const problem = (error as { readonly problem?: unknown }).problem;
  return typeof problem === "object" && problem !== null ? (problem as HonuaProblemDetails) : undefined;
}
