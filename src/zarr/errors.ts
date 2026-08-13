import { type HonuaErrorOptions, HonuaSdkError, mergeHonuaErrorContext } from "../core/error-envelope.js";

export type HonuaZarrErrorCode =
  | "invalid-request"
  | "invalid-response"
  | "response-too-large"
  | "metadata-pending"
  | "missing-spatial-extent"
  | "no-tileable-variable"
  | "missing-spatial-reference"
  | "spatial-reference-mismatch"
  | "unsupported-version"
  | "unsupported-codec"
  | "unsupported-dtype"
  | "ambiguous-dimensions"
  | "service-error";

/** Typed failure at the experimental Honua Zarr client boundary. */
export class HonuaZarrError extends HonuaSdkError {
  public constructor(
    public readonly code: HonuaZarrErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(`core.zarr.${code}`, message, {
      ...options,
      context: mergeHonuaErrorContext(detail, options.context),
    });
    this.name = "HonuaZarrError";
  }
}

export class HonuaZarrServiceError extends HonuaZarrError {
  public constructor(
    public readonly statusCode: number,
    message: string,
    public readonly body: unknown,
    options: HonuaErrorOptions = {},
  ) {
    super("service-error", message, { statusCode }, options);
    this.name = "HonuaZarrServiceError";
  }
}
