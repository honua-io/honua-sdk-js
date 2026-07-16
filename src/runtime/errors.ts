/**
 * Runtime-specific error surface. Other Honua SDK errors
 * (`HonuaCapabilityNotSupportedError`, `HonuaHttpError`, etc.) bubble
 * through unchanged; this class wraps only the runtime-binding failures
 * so callers can discriminate stage of failure.
 *
 * @module
 */

import {
  type HonuaErrorMetadata,
  HonuaSdkError,
  mergeHonuaErrorContext,
  ownDataProperty,
  ownHonuaErrorContext,
  withHonuaErrorClassification,
} from "../core/error-base.js";

/**
 * Stage of the runtime pipeline a failure occurred in. Keeping this as a
 * string union lets callers switch on it without a dependency on the
 * error class itself.
 */
export type HonuaMapPackageErrorStage =
  | "fetch"
  | "load"
  | "validate"
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
 * shared `HonuaClient` interceptor chain. The `source-error` event on
 * `HonuaRuntimeEvent` is the canonical observable for per-source
 * failures: the loader emits it for tolerant bind-time failures
 * (`sourceErrorPolicy: "tolerant"`, the default) and
 * `HonuaMapRuntime.reportSourceError` emits the same event for
 * query-time rejections forwarded by mixed-source consumers — see
 * `docs/composition.md`.
 */
export class HonuaMapPackageError extends HonuaSdkError {
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
    } & HonuaErrorMetadata,
  ) {
    super(
      MAP_PACKAGE_ERROR_CODES[options.stage],
      message,
      withHonuaErrorClassification(
        options,
        "runtime",
        options.stage === "fetch"
          ? "network"
          : options.stage === "validate" || options.stage === "style-compose" || options.stage === "popup"
            ? "validation"
            : "internal",
        options.stage === "fetch" || options.stage === "dispose",
        mergeHonuaErrorContext(ownHonuaErrorContext(options), {
          packageId: options.packageId,
          stage: options.stage,
        }),
      ),
    );
    this.name = "HonuaMapPackageError";
    this.packageId = options.packageId;
    this.stage = options.stage;
    this.detail = options.detail;
    this.cause = ownDataProperty(options, "cause");
  }
}

const MAP_PACKAGE_ERROR_CODES = {
  fetch: "runtime.map-package.fetch",
  load: "runtime.map-package.load",
  validate: "runtime.map-package.validate",
  update: "runtime.map-package.update",
  "style-compose": "runtime.map-package.style-compose",
  "source-bind": "runtime.map-package.source-bind",
  view: "runtime.map-package.view",
  popup: "runtime.map-package.popup",
  dispose: "runtime.map-package.dispose",
} as const satisfies Record<HonuaMapPackageErrorStage, `runtime.map-package.${string}`>;
