export function bufferInWorker(
  geometry,
  signal,
  makeWorker = () => new Worker(new URL("./buffer.worker.ts", import.meta.url), { type: "module" }),
) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const worker = makeWorker();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    worker.onmessage = ({ data }) => {
      if (data?.error) finish(reject, new Error(data.error));
      else if (data?.geometry) finish(resolve, data.geometry);
      else finish(reject, new Error("The search area worker returned an invalid result."));
    };
    worker.onerror = () => finish(reject, new Error("Unable to construct the half-mile search area."));
    worker.onmessageerror = () => finish(reject, new Error("Unable to read the search area result."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage(geometry);
    } catch (error) {
      finish(reject, error);
    }
  });
}
