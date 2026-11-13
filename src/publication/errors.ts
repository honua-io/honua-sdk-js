import { HonuaSdkError, mergeHonuaErrorContext } from "../core/error-envelope.js";

export type HonuaPublicationErrorCode =
  | "invalid-descriptor"
  | "artifact-mismatch"
  | "non-public-field"
  | "query-budget-exceeded";

export interface HonuaPublicationErrorDetails {
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Typed failure while opening or querying a paired publication. */
export class HonuaPublicationError extends HonuaSdkError {
  public readonly detail: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    public readonly code: HonuaPublicationErrorCode,
    message: string,
    { detail, cause }: HonuaPublicationErrorDetails = {},
  ) {
    super(`core.publication.${code}`, message, {
      ...(cause !== undefined ? { cause } : {}),
      context: mergeHonuaErrorContext(detail),
    });
    this.name = "HonuaPublicationError";
    this.detail = detail;
  }
}
