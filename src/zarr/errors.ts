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

const HONUA_ZARR_ERROR_CODES = {
  "invalid-request": "core.zarr.invalid-request",
  "invalid-response": "core.zarr.invalid-response",
  "response-too-large": "core.zarr.response-too-large",
  "metadata-pending": "core.zarr.metadata-pending",
  "missing-spatial-extent": "core.zarr.missing-spatial-extent",
  "no-tileable-variable": "core.zarr.no-tileable-variable",
  "missing-spatial-reference": "core.zarr.missing-spatial-reference",
  "spatial-reference-mismatch": "core.zarr.spatial-reference-mismatch",
  "unsupported-version": "core.zarr.unsupported-version",
  "unsupported-codec": "core.zarr.unsupported-codec",
  "unsupported-dtype": "core.zarr.unsupported-dtype",
  "ambiguous-dimensions": "core.zarr.ambiguous-dimensions",
  "service-error": "core.zarr.service-error",
} as const satisfies Readonly<Record<HonuaZarrErrorCode, `core.zarr.${HonuaZarrErrorCode}`>>;

/** Typed failure at the experimental Honua Zarr client boundary. */
export class HonuaZarrError extends HonuaSdkError {
  public constructor(
    public readonly code: HonuaZarrErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(HONUA_ZARR_ERROR_CODES[code], message, {
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
