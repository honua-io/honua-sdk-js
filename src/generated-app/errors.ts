/**
 * Structured error surface for the generated-app preview/runtime.
 *
 * The preview host catches this class and returns serializable diagnostics
 * instead of leaving the embedder with a blank draft surface.
 *
 * @module
 */

import { type HonuaErrorCode, HonuaSdkError } from "../core/error-envelope.js";

export type HonuaGeneratedAppErrorCode =
  | "unsupported-profile"
  | "unsupported-widget"
  | "missing-manifest"
  | "missing-manifest-artifact"
  | "missing-map-package"
  | "map-package-mismatch"
  | "missing-widget"
  | "missing-binding"
  | "map-load-failed"
  | "data-load-failed"
  | "render-failed"
  | "disposed";

export type HonuaGeneratedAppErrorStage = "manifest" | "projection" | "load" | "interaction" | "render" | "dispose";

export interface HonuaGeneratedAppErrorDetail {
  readonly appId?: string;
  readonly widgetId?: string;
  readonly widgetKind?: string;
  readonly sourceId?: string;
  readonly path?: string;
  readonly expected?: unknown;
  readonly received?: unknown;
  readonly [extra: string]: unknown;
}

export interface HonuaGeneratedAppDiagnostic {
  readonly name: "HonuaGeneratedAppError";
  readonly code: HonuaGeneratedAppErrorCode;
  readonly stage: HonuaGeneratedAppErrorStage;
  readonly message: string;
  readonly detail?: HonuaGeneratedAppErrorDetail;
}

/**
 * Legacy detailed reason codes mapped to registered `app.*` `sdkCode`
 * values, one-to-one.
 */
const GENERATED_APP_ERROR_SDK_CODES = {
  "unsupported-profile": "app.unsupported-profile",
  "unsupported-widget": "app.unsupported-widget",
  "missing-manifest": "app.missing-manifest",
  "missing-manifest-artifact": "app.missing-manifest-artifact",
  "missing-map-package": "app.missing-map-package",
  "map-package-mismatch": "app.map-package-mismatch",
  "missing-widget": "app.missing-widget",
  "missing-binding": "app.missing-binding",
  "map-load-failed": "app.map-load-failed",
  "data-load-failed": "app.data-load-failed",
  "render-failed": "app.render-failed",
  disposed: "app.disposed",
} as const satisfies Readonly<Record<HonuaGeneratedAppErrorCode, HonuaErrorCode>>;

/**
 * Tagged generated-app preview/runtime failure. Participates in the shared
 * SDK error envelope (`isHonuaError`, `serializeHonuaError`) while
 * preserving the legacy `.code`/`.stage`/`.detail`/`.cause` fields consumed
 * by {@link toGeneratedAppDiagnostic}. `detail` is an open, caller-supplied
 * bag (`expected`/`received`/etc.) and is deliberately kept local-only — it
 * is never placed in the envelope's serialized `context`.
 *
 * The base `HonuaSdkError.toJSON()` (the redacted envelope projection) is
 * inherited unchanged, so `JSON.stringify(error)` now returns the safe,
 * sanitized `SerializedHonuaError` shape rather than the raw diagnostic
 * (which could otherwise echo an unsanitized `detail`). Callers that need
 * the legacy `{name, code, stage, message, detail}` diagnostic shape use
 * {@link toGeneratedAppDiagnostic}, which reads the documented fields
 * directly rather than relying on `toJSON()`.
 */
export class HonuaGeneratedAppError extends HonuaSdkError {
  public readonly code: HonuaGeneratedAppErrorCode;
  public readonly stage: HonuaGeneratedAppErrorStage;
  public readonly detail: HonuaGeneratedAppErrorDetail | undefined;
  public override readonly cause: unknown;

  public constructor(
    code: HonuaGeneratedAppErrorCode,
    message: string,
    options: {
      readonly stage: HonuaGeneratedAppErrorStage;
      readonly detail?: HonuaGeneratedAppErrorDetail;
      readonly cause?: unknown;
    },
  ) {
    super(GENERATED_APP_ERROR_SDK_CODES[code], message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "HonuaGeneratedAppError";
    this.code = code;
    this.stage = options.stage;
    this.detail = options.detail;
    this.cause = options.cause;
  }
}

export function toGeneratedAppDiagnostic(error: unknown): HonuaGeneratedAppDiagnostic {
  if (error instanceof HonuaGeneratedAppError) {
    return {
      name: "HonuaGeneratedAppError",
      code: error.code,
      stage: error.stage,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }
  return {
    name: "HonuaGeneratedAppError",
    code: "render-failed",
    stage: "render",
    message: error instanceof Error ? error.message : String(error),
  };
}
