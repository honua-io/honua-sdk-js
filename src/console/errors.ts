/**
 * Typed error surface for the Console SDK contracts.
 *
 * Console UI surfaces (content browser, dashboard/report viewers, embed hosts)
 * need serializable, code-tagged diagnostics rather than thrown strings so they
 * can render an explicit "unsupported" or "missing binding" state instead of a
 * blank panel. The canonical server objects remain authoritative; these errors
 * only describe the browser-side projection failures the SDK can detect.
 *
 * @module
 */

export type HonuaConsoleErrorCode =
  | "unsupported-content-kind"
  | "unsupported-package-format"
  | "unsupported-chart-spec"
  | "missing-binding"
  | "missing-panel"
  | "missing-chart-spec"
  | "invalid-vega-lite-spec"
  | "projection-failed";

export type HonuaConsoleErrorStage = "content" | "metadata" | "projection" | "chart" | "render";

export interface HonuaConsoleErrorDetail {
  readonly contentId?: string;
  readonly packageId?: string;
  readonly panelId?: string;
  readonly chartId?: string;
  readonly path?: string;
  readonly expected?: unknown;
  readonly received?: unknown;
  readonly [extra: string]: unknown;
}

export interface HonuaConsoleDiagnostic {
  readonly name: "HonuaConsoleError";
  readonly code: HonuaConsoleErrorCode;
  readonly stage: HonuaConsoleErrorStage;
  readonly message: string;
  readonly detail?: HonuaConsoleErrorDetail;
}

/**
 * Structured error raised by Console contract projection helpers. Console hosts
 * should catch this class and call {@link HonuaConsoleError.toJSON} (or
 * {@link toConsoleDiagnostic}) to obtain a serializable diagnostic for the UI.
 */
export class HonuaConsoleError extends Error {
  public readonly code: HonuaConsoleErrorCode;
  public readonly stage: HonuaConsoleErrorStage;
  public readonly detail: HonuaConsoleErrorDetail | undefined;
  public override readonly cause: unknown;

  public constructor(
    code: HonuaConsoleErrorCode,
    message: string,
    options: {
      readonly stage: HonuaConsoleErrorStage;
      readonly detail?: HonuaConsoleErrorDetail;
      readonly cause?: unknown;
    },
  ) {
    super(message);
    this.name = "HonuaConsoleError";
    this.code = code;
    this.stage = options.stage;
    this.detail = options.detail;
    this.cause = options.cause;
  }

  public toJSON(): HonuaConsoleDiagnostic {
    return {
      name: "HonuaConsoleError",
      code: this.code,
      stage: this.stage,
      message: this.message,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export function toConsoleDiagnostic(error: unknown): HonuaConsoleDiagnostic {
  if (error instanceof HonuaConsoleError) return error.toJSON();
  return {
    name: "HonuaConsoleError",
    code: "projection-failed",
    stage: "projection",
    message: error instanceof Error ? error.message : String(error),
  };
}
