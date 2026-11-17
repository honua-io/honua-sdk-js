// A bounded retry around the `gh` CLI for read-only collectors that make many
// API calls per run. GitHub answers an occasional request with a 5xx (gh's
// "Server Error", HTTP 500/502/503/504) that a
// retry minutes later serves normally; one such answer must not fail a run that
// made sixty good calls. Anything else (404, auth, a bad --jq) fails at once.

import { execFileSync } from "node:child_process";

const TRANSIENT = /HTTP 50[234]\b|Server Error|Bad Gateway|Service Unavailable|Gateway Timeout/i;
const INT32_BYTES = 4;
const GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const GH_TIMEOUT_MS = 300_000;

export function isTransientGhFailure(error) {
  return TRANSIENT.test(String(error?.stderr ?? "")) || TRANSIENT.test(String(error?.message ?? ""));
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, milliseconds);
}

function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER_BYTES, timeout: GH_TIMEOUT_MS });
}

function attempt(exec, args) {
  try {
    return { output: exec(args) };
  } catch (error) {
    return { error };
  }
}

export function ghWithRetry(args, { attempts = 4, baseDelayMs = 5_000, exec = runGh, sleep = sleepSync } = {}) {
  for (let tried = 1; ; tried += 1) {
    const { output, error } = attempt(exec, args);
    if (!error) return output;
    if (tried >= attempts || !isTransientGhFailure(error)) throw error;
    const delayMs = baseDelayMs * 2 ** (tried - 1);
    process.stderr.write(`gh ${args[0] ?? ""}: transient GitHub error; retry ${tried + 1}/${attempts} in ${delayMs} ms\n`);
    sleep(delayMs);
  }
}
