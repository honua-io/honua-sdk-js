// Bounded retry for the `gh` CLI calls made by the CI evidence collectors
// (scripts/ci-shadow-parity.mjs, scripts/ci-timing-baseline.mjs).
//
// One collection makes 60+ `gh api` calls. GitHub answers an occasional one
// with a transient 5xx (usually 502), and failing the whole job on it turns a
// scheduled readout red for no reason. Anything
// else -- 404, authentication, a bad jq expression, a timeout -- is not going to
// get better on its own, so it still fails on the first attempt.

import { execFileSync } from "node:child_process";

export const GH_RETRY_ATTEMPTS = 4;
export const GH_RETRY_BASE_DELAY_MS = 2_000;
const GH_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const GH_CALL_TIMEOUT_MS = 300_000;

const TRANSIENT_GH_ERROR =
  /\bHTTP 5\d\d\b|Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when a failed `gh` call reported a GitHub-side 5xx. */
export function isTransientGhError(error) {
  if (!error || error.code === "ETIMEDOUT" || error.signal) return false;
  const stderr = typeof error.stderr === "string" ? error.stderr : String(error.stderr ?? "");
  return TRANSIENT_GH_ERROR.test(stderr);
}

/**
 * Returns a synchronous `gh(args)` that retries transient GitHub 5xx answers
 * with exponential backoff and rethrows every other failure immediately.
 */
export function createGh({
  run = (args) =>
    execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: GH_MAX_OUTPUT_BYTES,
      timeout: GH_CALL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  sleep = sleepSync,
  attempts = GH_RETRY_ATTEMPTS,
  baseDelayMs = GH_RETRY_BASE_DELAY_MS,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const attemptOnce = (args) => {
    try {
      return { ok: true, value: run(args) };
    } catch (error) {
      return { ok: false, error };
    }
  };
  return function gh(args) {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = attemptOnce(args);
      if (outcome.ok) return outcome.value;
      if (attempt >= attempts || !isTransientGhError(outcome.error)) throw outcome.error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      const reason = String(outcome.error.stderr ?? "").trim().split("\n")[0];
      log(`gh ${args.slice(0, 2).join(" ")}: transient GitHub error (${reason}), retry ${attempt}/${attempts - 1} in ${delayMs} ms`);
      sleep(delayMs);
    }
  };
}
