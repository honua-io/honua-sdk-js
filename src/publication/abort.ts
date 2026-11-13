import { HonuaAbortError } from "../core/errors.js";

/** Settles with `work`, or rejects as soon as `signal` aborts even if `work` never settles. */
export function settleOrAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new HonuaAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new HonuaAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
