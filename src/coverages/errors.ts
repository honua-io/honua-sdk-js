import { type HonuaErrorOptions, HonuaSdkError, mergeHonuaErrorContext } from "../core/error-envelope.js";

export type HonuaCoverageErrorCode =
  | "invalid-request"
  | "invalid-response"
  | "response-too-large"
  | "unsupported-format"
  | "service-error"
  | "wcs-exception";

export class HonuaCoverageError extends HonuaSdkError {
  public constructor(
    public readonly code: HonuaCoverageErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(`core.coverage.${code}`, message, {
      ...options,
      context: mergeHonuaErrorContext(detail, options.context),
    });
    this.name = "HonuaCoverageError";
  }
}

export class HonuaCoverageServiceError extends HonuaCoverageError {
  public constructor(
    public readonly statusCode: number,
    message: string,
    public readonly body: unknown,
    options: HonuaErrorOptions = {},
  ) {
    super("service-error", message, { statusCode }, options);
    this.name = "HonuaCoverageServiceError";
  }
}

export class HonuaWcsExceptionError extends HonuaCoverageError {
  public constructor(
    public readonly exceptionCode: string,
    public readonly locator: string | undefined,
    message: string,
    public readonly statusCode: number | undefined,
    options: HonuaErrorOptions = {},
  ) {
    super(
      "wcs-exception",
      message,
      {
        exceptionCode,
        ...(locator ? { locator } : {}),
        ...(statusCode === undefined ? {} : { statusCode }),
      },
      options,
    );
    this.name = "HonuaWcsExceptionError";
  }
}
