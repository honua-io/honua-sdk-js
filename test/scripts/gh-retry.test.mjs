import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createGh, isTransientGhError } from "../../scripts/lib/gh-retry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function ghFailure(stderr, extra = {}) {
  return Object.assign(new Error(`Command failed: gh\n${stderr}`), { status: 1, stderr, ...extra });
}

function scripted(outcomes) {
  const calls = [];
  const sleeps = [];
  const gh = createGh({
    run: (args) => {
      calls.push(args);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: (ms) => sleeps.push(ms),
    log: () => {},
  });
  return { gh, calls, sleeps };
}

describe("gh transient-error retry (#2629)", () => {
  it("retries a GitHub 502 with backoff and returns the later answer", () => {
    const { gh, calls, sleeps } = scripted([
      ghFailure("gh: Server Error (HTTP 502)"),
      ghFailure("HTTP 503: Service Unavailable"),
      "[]",
    ]);
    assert.equal(gh(["api", "repos/o/r/actions/runs/1/jobs"]), "[]");
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [2_000, 4_000]);
  });

  it("gives up after the bounded number of attempts and rethrows the last error", () => {
    const { gh, calls, sleeps } = scripted([
      ghFailure("gh: Server Error (HTTP 502)"),
      ghFailure("gh: Server Error (HTTP 502)"),
      ghFailure("HTTP 504: Gateway Timeout"),
      ghFailure("gh: Server Error (HTTP 502)"),
      "never reached",
    ]);
    assert.throws(() => gh(["api", "x"]), /HTTP 502/);
    assert.equal(calls.length, 4);
    assert.deepEqual(sleeps, [2_000, 4_000, 8_000]);
  });

});

describe("gh failures that are not transient", () => {
  for (const [label, error] of [
    ["404", ghFailure("gh: Not Found (HTTP 404)")],
    ["authentication", ghFailure("gh: Bad credentials (HTTP 401)")],
    ["a bad jq expression", ghFailure("failed to parse jq expression (line 1, column 4)")],
    ["a timeout", ghFailure("", { code: "ETIMEDOUT", signal: "SIGTERM" })],
  ]) {
    it(`fails immediately on ${label}`, () => {
      const { gh, calls, sleeps } = scripted([error, "never reached"]);
      assert.throws(() => gh(["api", "x"]), (thrown) => thrown === error);
      assert.equal(calls.length, 1);
      assert.deepEqual(sleeps, []);
    });
  }

  it("classifies only GitHub 5xx answers as transient", () => {
    assert.equal(isTransientGhError(ghFailure("HTTP 500: Internal Server Error")), true);
    assert.equal(isTransientGhError(ghFailure("gh: Bad Gateway")), true);
    assert.equal(isTransientGhError(ghFailure("HTTP 422: Validation Failed")), false);
    assert.equal(isTransientGhError(undefined), false);
  });
});

  const RUNS = JSON.stringify([{ databaseId: 7, conclusion: "success", createdAt: "2026-11-17T00:00:00Z", headSha: "a".repeat(40) }]);
  const JOBS = JSON.stringify([
    { name: "build", conclusion: "success", started_at: "2026-11-17T00:00:00Z", completed_at: "2026-11-17T00:05:00Z" },
  ]);

  function fakeGh(dir) {
    const state = path.join(dir, "api-calls");
    const script = path.join(dir, "gh");
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "run") { process.stdout.write(${JSON.stringify(RUNS)}); process.exit(0); }
const n = fs.existsSync(${JSON.stringify(state)}) ? Number(fs.readFileSync(${JSON.stringify(state)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(state)}, String(n + 1));
if (n === 0) { process.stderr.write("gh: Server Error (HTTP 502)\\n"); process.exit(1); }
process.stdout.write(${JSON.stringify(JOBS)});
`,
      { mode: 0o755 },
    );
    return state;
  }

describe("collectors survive one transient 502 from the real gh shell-out", () => {
  for (const [script, observedHead] of [
    ["scripts/ci-timing-baseline.mjs", (doc) => doc.runs[0].headSha],
    ["scripts/ci-shadow-parity.mjs", (doc) => doc.observations[0].headSha],
  ]) {
    it(`${script} collect writes its document after a retried 502`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-retry-"));
      try {
        const state = fakeGh(dir);
        const output = path.join(dir, "evidence.json");
        const result = spawnSync(process.execPath, [script, "collect", "--limit", "1", "--output", output], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /transient GitHub error \(gh: Server Error \(HTTP 502\)\), retry 1\/3/);
        assert.ok(Number(fs.readFileSync(state, "utf8")) >= 2);
        assert.equal(observedHead(JSON.parse(fs.readFileSync(output, "utf8"))), "a".repeat(40));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
