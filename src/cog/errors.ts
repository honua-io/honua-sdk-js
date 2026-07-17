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
  | "unsupported-extent"
  | "unsupported-nodata"
  | "unsupported-sample-type"
  | "invalid-metadata"
  | "invalid-window"
  | "render-unavailable"
  | "render-overflow"
  | "encoding-failed"
  | "map-conflict"
  | "map-mutation-failed"
  | "source-drift"
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
