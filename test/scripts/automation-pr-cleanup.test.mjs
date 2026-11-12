import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = (name, job) => parse(fs.readFileSync(`.github/workflows/${name}.yml`, "utf8")).jobs[job].steps;
const steps = workflow("regenerate-derived-artifacts", "commit-and-validate");
const fresh = steps.find((s) => s.name === "Verify regeneration source is current trunk");
const publish = steps.find((s) => s.name === "Validate and publish regeneration commits");
const cleanup = steps.find((s) => s.name === "Close superseded regeneration pull requests");

function run(script, prefix, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-cleanup-"));
  const pr = (number, extra = {}) => ({ number, headRefName: `${prefix}old-${number}`, isCrossRepository: false,
    author: { is_bot: true, login: "app/honua-io-bot" }, ...extra });
  try {
    fs.writeFileSync(`${dir}/prs.json`, JSON.stringify([pr(1), pr(2, { isCrossRepository: true }),
      pr(3, { author: { is_bot: false, login: "contributor" } }),
      pr(4, { author: { is_bot: true, login: "app/other-bot" } }),
      pr(5, { author: { is_bot: true, login: "app/github-actions" } }),
      pr(6, { headRefName: "unrelated" }), pr(7, { headRefName: `${prefix}current` })]));
    const commands = {
      git: `case "$1" in
  ls-remote) printf '%s\\trefs/heads/trunk\\n' "$TRUNK_SHA" ;;
  rev-parse) echo source ;;
  rev-list) echo 1 ;;
  log) echo "$REGEN_MARKER" ;;
  push) echo push >> "$TRACE"; [ "$FAIL" != push ] ;;
  *) exit 0 ;;
esac`,
      gh: `case "$1 $2" in
  "pr list") while [ "$1" != --jq ]; do shift; done; jq -r "$2" "$FIXTURES" ;;
  "pr create") echo create >> "$TRACE"; [ "$FAIL" != create ] || exit 1; echo https://github.com/honua-io/honua-sdk-js/pull/99 ;;
  "pr close") echo "close $3" >> "$TRACE" ;;
  "run list") echo "\${PENDING:-0}" ;;
  "workflow run"|"run cancel") echo "$*" >> "$TRACE" ;;
  *) exit 0 ;;
esac`,
    };
    for (const [name, body] of Object.entries(commands)) fs.writeFileSync(`${dir}/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    // The step body comes out of the workflow YAML, so it can never be a
    // literal here. Run it as a file rather than through `bash -c`: an inline
    // command string is an unanalyzable shell launch to
    // scripts/lib/test-build-ownership.mjs, which has to be able to prove no
    // test reaches the root compiler. Executing a script file is the pattern
    // test/scripts/release-please-tag-seal.test.mjs already uses for workflow
    // step bodies, and it runs the same bytes the workflow runs.
    const scriptPath = `${dir}/step.sh`;
    fs.writeFileSync(scriptPath, `${script}\n`);
    const result = spawnSync("bash", [scriptPath], { encoding: "utf8", env: { ...process.env,
      PATH: `${dir}:${process.env.PATH}`, TRACE: `${dir}/trace`, FIXTURES: `${dir}/prs.json`, FAIL: "",
      GITHUB_SHA: "source", TRUNK_SHA: "source", GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
      GITHUB_OUTPUT: `${dir}/output`, GITHUB_RUN_ID: "current", GITHUB_RUN_ATTEMPT: "1",
      REGEN_MARKER: "chore(evidence): regenerate", branch: `${prefix}current`, ...overrides } });
    return { ...result, trace: fs.existsSync(`${dir}/trace`) ? fs.readFileSync(`${dir}/trace`, "utf8").trim().split("\n") : [] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const prefix = "automation/derived-artifacts-";

test("regeneration cleanup closes only upstream automation PRs", () => {
  const result = run(cleanup.run, prefix);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.trace.filter((line) => line.startsWith("close")), ["close 1", "close 5"]);
});

test("regeneration cleanup retains candidates when trunk moves", () => {
  assert.equal(run(cleanup.run, prefix, { TRUNK_SHA: "newer" }).trace.some((line) => line.startsWith("close")), false);
});

test("failed replacement publication preserves old PRs", () => {
  assert.ok(steps.indexOf(cleanup) > steps.indexOf(publish));
  for (const FAIL of ["push", "create"]) {
    const result = run(`${publish.run}\n${cleanup.run}`, prefix, { FAIL });
    assert.notEqual(result.status, 0);
    assert.equal(result.trace.some((line) => line.startsWith("close")), false);
  }
});

test("superseded source hands off to current trunk, cancels itself and publishes nothing", () => {
  assert.ok(steps.indexOf(fresh) < steps.indexOf(publish));
  assert.equal(fresh.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(fresh.env.RELEASE_MATRIX_RECEIPT_RUN_ID, "${{ inputs.release_matrix_receipt_run_id }}");
  const dispatch = "workflow run regenerate-derived-artifacts.yml --repo honua-io/honua-sdk-js --ref trunk";
  const cancel = "run cancel current --repo honua-io/honua-sdk-js";
  for (const [receipt, PENDING, expected] of [
    ["", "0", [dispatch, cancel]],
    ["4242", "0", [`${dispatch} -f release_matrix_receipt_run_id=4242`, cancel]],
    ["", "1", [cancel]],
    ["4242", "1", []],
  ]) {
    const result = run(`${fresh.run}\n${publish.run}\n${cleanup.run}`, prefix,
      { TRUNK_SHA: "newer", RELEASE_MATRIX_RECEIPT_RUN_ID: receipt, PENDING, CANCEL_WAIT_SECONDS: "0" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.trace, expected, `receipt=${receipt} pending=${PENDING}`);
  }
});

test("current source does not dispatch or cancel", () => {
  const result = run(fresh.run, prefix, { CANCEL_WAIT_SECONDS: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.trace, []);
});

test("successful no-change and loop-guard paths still clean stale PRs", () => {
  assert.equal(cleanup.if, undefined);
  assert.equal(fresh.if, undefined);
  const result = run(`${fresh.run}\n${cleanup.run}`, "automation/derived-artifacts-", { branch: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.trace, ["close 1", "close 5", "close 7"]);
});
