type DeprecationWarningEmitter = {
  emitWarning(message: string, options: { code: string; type: string }): void;
};

type DeprecationNoticeRuntime = {
  process?: Partial<DeprecationWarningEmitter>;
  console?: { warn?: (message: string) => void };
};

export interface DeprecationNotice {
  /** Stable `process.emitWarning` code, also the once-per-process key. */
  code: string;
  message: string;
}

/**
 * Emits `notice` at most once per process (once per page in a browser), however
 * many copies of the calling module are evaluated. Node routes it through
 * `process.emitWarning` as a `DeprecationWarning`, so `--no-deprecation` and
 * `--trace-deprecation` apply; runtimes without `process` get `console.warn`.
 *
 * Returns true when this call emitted the notice.
 */
export function emitDeprecationNoticeOnce(
  notice: DeprecationNotice,
  runtime: DeprecationNoticeRuntime = globalThis as DeprecationNoticeRuntime,
): boolean {
  const key = Symbol.for(`@honua/sdk-js:deprecation:${notice.code}`);
  const registry = runtime as Record<symbol, unknown>;
  if (registry[key] === true) return false;
  registry[key] = true;

  if (typeof runtime.process?.emitWarning === "function") {
    runtime.process.emitWarning(notice.message, { code: notice.code, type: "DeprecationWarning" });
  } else {
    runtime.console?.warn?.(`DeprecationWarning [${notice.code}]: ${notice.message}`);
  }
  return true;
}
