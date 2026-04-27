/**
 * Operator-stage errors. Mirrors the discriminated-union pattern from
 * `src/core/errors.ts`: each concrete class extends `Error` directly,
 * the `HonuaOperatorError` type is the union of those classes, and
 * `isHonuaOperatorError()` is the narrowing type guard.
 *
 * The set is independent of `HonuaError` in `src/core/errors.ts`; the
 * two coexist so that adapter-level failures and operator-level failures
 * can be discriminated separately.
 *
 * @module
 */

export type HonuaOperatorErrorStage = "intent" | "plan" | "execution" | "approval" | "map" | "app";

/**
 * Failure-kind taxonomy aligned with `AI_OPERATOR_CONTRACT`. Server
 * responses with a structured failure kind populate the controller's
 * error verbatim; unknown values are preserved as strings.
 */
export type HonuaOperatorExecutionFailureKind =
  | "ValidationFailed"
  | "AuthorizationDenied"
  | "UnknownDataset"
  | "UnknownProcess"
  | "ExecutionFailed"
  | "Timeout"
  | "Cancelled"
  | "OutputBindingFailed"
  | (string & { readonly __brand?: never });

interface OperatorErrorContext {
  intentId?: string;
  planId?: string;
  executionId?: string;
  detail?: Record<string, unknown>;
  cause?: unknown;
}

abstract class HonuaOperatorErrorBase extends Error {
  public readonly stage: HonuaOperatorErrorStage;
  public readonly intentId: string | undefined;
  public readonly planId: string | undefined;
  public readonly executionId: string | undefined;
  public readonly detail: Record<string, unknown> | undefined;
  public override readonly cause: unknown;

  protected constructor(stage: HonuaOperatorErrorStage, message: string, context: OperatorErrorContext = {}) {
    super(message);
    this.stage = stage;
    this.intentId = context.intentId;
    this.planId = context.planId;
    this.executionId = context.executionId;
    this.detail = context.detail;
    this.cause = context.cause;
  }
}

export class HonuaOperatorIntentError extends HonuaOperatorErrorBase {
  public constructor(message: string, context: OperatorErrorContext = {}) {
    super("intent", message, context);
    this.name = "HonuaOperatorIntentError";
  }
}

export class HonuaOperatorPlanError extends HonuaOperatorErrorBase {
  public constructor(message: string, context: OperatorErrorContext = {}) {
    super("plan", message, context);
    this.name = "HonuaOperatorPlanError";
  }
}

export class HonuaOperatorExecutionError extends HonuaOperatorErrorBase {
  public readonly failureKind: HonuaOperatorExecutionFailureKind | undefined;

  public constructor(
    message: string,
    context: OperatorErrorContext & { failureKind?: HonuaOperatorExecutionFailureKind } = {},
  ) {
    super("execution", message, context);
    this.name = "HonuaOperatorExecutionError";
    this.failureKind = context.failureKind;
  }
}

export class HonuaOperatorApprovalError extends HonuaOperatorErrorBase {
  public constructor(message: string, context: OperatorErrorContext = {}) {
    super("approval", message, context);
    this.name = "HonuaOperatorApprovalError";
  }
}

export class HonuaOperatorMapError extends HonuaOperatorErrorBase {
  public constructor(message: string, context: OperatorErrorContext = {}) {
    super("map", message, context);
    this.name = "HonuaOperatorMapError";
  }
}

export class HonuaOperatorAppError extends HonuaOperatorErrorBase {
  public constructor(message: string, context: OperatorErrorContext = {}) {
    super("app", message, context);
    this.name = "HonuaOperatorAppError";
  }
}

export type HonuaOperatorError =
  | HonuaOperatorIntentError
  | HonuaOperatorPlanError
  | HonuaOperatorExecutionError
  | HonuaOperatorApprovalError
  | HonuaOperatorMapError
  | HonuaOperatorAppError;

export function isHonuaOperatorError(error: unknown): error is HonuaOperatorError {
  return (
    error instanceof HonuaOperatorIntentError ||
    error instanceof HonuaOperatorPlanError ||
    error instanceof HonuaOperatorExecutionError ||
    error instanceof HonuaOperatorApprovalError ||
    error instanceof HonuaOperatorMapError ||
    error instanceof HonuaOperatorAppError
  );
}
