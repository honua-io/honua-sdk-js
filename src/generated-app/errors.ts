/**
 * Structured error surface for the generated-app preview/runtime.
 *
 * The preview host catches this class and returns serializable diagnostics
 * instead of leaving the embedder with a blank draft surface.
 *
 * @module
 */

export type HonuaGeneratedAppErrorCode =
  | "unsupported-profile"
  | "unsupported-widget"
  | "missing-manifest"
  | "missing-manifest-artifact"
  | "missing-map-package"
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

export class HonuaGeneratedAppError extends Error {
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
    super(message);
    this.name = "HonuaGeneratedAppError";
    this.code = code;
    this.stage = options.stage;
    this.detail = options.detail;
    this.cause = options.cause;
  }

  public toJSON(): HonuaGeneratedAppDiagnostic {
    return {
      name: "HonuaGeneratedAppError",
      code: this.code,
      stage: this.stage,
      message: this.message,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export function toGeneratedAppDiagnostic(error: unknown): HonuaGeneratedAppDiagnostic {
  if (error instanceof HonuaGeneratedAppError) return error.toJSON();
  return {
    name: "HonuaGeneratedAppError",
    code: "render-failed",
    stage: "render",
    message: error instanceof Error ? error.message : String(error),
  };
}
