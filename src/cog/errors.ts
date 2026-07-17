export type HonuaCogErrorCode =
  | "invalid-candidate"
  | "unsafe-asset-url"
  | "invalid-range"
  | "request-limit-exceeded"
  | "byte-limit-exceeded"
  | "range-unsupported"
  | "cors-unavailable"
  | "redirect-disallowed"
  | "http-error"
  | "invalid-range-response"
  | "range-overflow"
  | "whole-file-disallowed"
  | "asset-changed"
  | "unsupported-format"
  | "unsupported-crs"
  | "invalid-metadata"
  | "invalid-window"
  | "decoder-failed"
  | "aborted"
  | "obsolete-read"
  | "disposed";

/** Typed, fail-closed error from the direct COG boundary. */
export class HonuaCogError extends Error {
  readonly code: HonuaCogErrorCode;

  constructor(code: HonuaCogErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HonuaCogError";
    this.code = code;
  }
}
