import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ghWithRetry, isTransientGhFailure } from "../../scripts/lib/gh-transient-retry.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const failure = (stderr) => Object.assign(new Error("Command failed: gh api"), { stderr });

function scripted(outcomes) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, exec };
}

test("a GitHub 5xx is retried with backoff and the later answer is returned", () => {
  const { calls, exec } = scripted([failure("gh: Server Error (HTTP 502)"), failure("HTTP 503: Service Unavailable"), "[]"]);
  const delays = [];
  assert.equal(ghWithRetry(["api", "x"], { exec, sleep: (ms) => delays.push(ms), baseDelayMs: 10 }), "[]");
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("retries are bounded and the last transient failure is raised", () => {
  const { calls, exec } = scripted([1, 2, 3].map(() => failure("gh: Server Error (HTTP 502)")));
  assert.throws(() => ghWithRetry(["api", "x"], { attempts: 3, exec, sleep: () => {} }), /Command failed/);
  assert.equal(calls.length, 3);
});

test("a non-transient failure is raised at once", () => {
  for (const stderr of ["gh: Not Found (HTTP 404)", "HTTP 401: Bad credentials", "failed to parse jq expression"]) {
    const { calls, exec } = scripted([failure(stderr), "[]"]);
    assert.throws(() => ghWithRetry(["api", "x"], { exec, sleep: () => {} }));
    assert.equal(calls.length, 1, stderr);
    assert.equal(isTransientGhFailure(failure(stderr)), false);
  }
});

test("both run collectors call gh through the bounded retry", async () => {
  for (const script of ["scripts/ci-shadow-parity.mjs", "scripts/ci-timing-baseline.mjs"]) {
    const source = await readFile(path.join(root, script), "utf8");
    assert.match(source, /from "\.\/lib\/gh-transient-retry\.mjs"/, script);
    assert.doesNotMatch(source, /execFileSync\("gh"/, script);
  }
});
