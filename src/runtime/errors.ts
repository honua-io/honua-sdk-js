/**
 * Runtime-specific error surface. Other Honua SDK errors
 * (`HonuaCapabilityNotSupportedError`, `HonuaHttpError`, etc.) bubble
 * through unchanged; this class wraps only the runtime-binding failures
 * so callers can discriminate stage of failure.
 *
 * @module
 */

/**
 * Stage of the runtime pipeline a failure occurred in. Keeping this as a
 * string union lets callers switch on it without a dependency on the
 * error class itself.
 */
export type HonuaMapPackageErrorStage =
  | "load"
  | "update"
  | "style-compose"
  | "source-bind"
  | "view"
  | "popup"
  | "dispose";

/**
 * Thrown for runtime-level binding failures. Per-source / per-request
 * protocol failures keep their existing error classes
 * (`HonuaCapabilityNotSupportedError`, `HonuaHttpError`) and surface on
 * the per-`Source` promises from `runtime.dataset` and through the
 * shared `HonuaClient` interceptor chain. The `source-error` event is
 * declared on `HonuaRuntimeEvent` but is reserved for future `#22` /
 * `#29` wiring and is not emitted by the loader today.
 */
export class HonuaMapPackageError extends Error {
  public readonly packageId: string | undefined;
  public readonly stage: HonuaMapPackageErrorStage;
  public readonly detail: unknown;
  public override readonly cause: unknown;

  public constructor(
    message: string,
    options: {
      packageId?: string;
      stage: HonuaMapPackageErrorStage;
      detail?: unknown;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "HonuaMapPackageError";
    this.packageId = options.packageId;
    this.stage = options.stage;
    this.detail = options.detail;
    this.cause = options.cause;
  }
}
