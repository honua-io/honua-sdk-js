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

interface SharedRun<T> {
  readonly promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
}

/**
 * Runs `task` once for every caller. The run is cancelled only when every
 * caller waiting on it has cancelled, so one caller's cancellation never fails
 * another's; a failed or cancelled run is started again by the next caller.
 */
export function sharedTask<T>(task: (signal: AbortSignal) => Promise<T>): (signal?: AbortSignal) => Promise<T> {
  let shared: SharedRun<T> | undefined;
  function start(): SharedRun<T> {
    const controller = new AbortController();
    const run = { controller, waiters: 0, settled: false } as SharedRun<T> & { promise: Promise<T> };
    run.promise = task(controller.signal).then(
      (value) => {
        run.settled = true;
        return value;
      },
      (error) => {
        run.settled = true;
        if (shared === run) shared = undefined;
        throw error;
      },
    );
    return run;
  }
  return (signal?: AbortSignal): Promise<T> => {
    shared ??= start();
    const run = shared;
    run.waiters++;
    const wait = settleOrAbort(run.promise, signal);
    wait.catch(() => {
      if (!signal?.aborted || run.settled) return;
      run.waiters--;
      if (run.waiters > 0) return;
      if (shared === run) shared = undefined;
      run.controller.abort();
    });
    return wait;
  };
}
