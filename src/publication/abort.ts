import { HonuaAbortError } from "../core/errors.js";

/**
 * Settles with `work`, or rejects as soon as `signal` aborts even if `work`
 * never settles. Abandoned work may still reject later; that rejection is
 * observed here so it is never reported as unhandled.
 */
export function settleOrAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new HonuaAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new HonuaAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
