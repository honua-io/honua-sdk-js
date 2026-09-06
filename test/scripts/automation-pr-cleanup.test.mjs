import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = (name, job) => parse(fs.readFileSync(`.github/workflows/${name}.yml`, "utf8")).jobs[job].steps;
const renewal = workflow("kepler-audit-renewal", "renew").find((s) => s.name === "Publish renewal pull request");
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
  *) exit 0 ;;
esac`,
    };
    for (const [name, body] of Object.entries(commands)) fs.writeFileSync(`${dir}/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env,
      PATH: `${dir}:${process.env.PATH}`, TRACE: `${dir}/trace`, FIXTURES: `${dir}/prs.json`, FAIL: "",
      GITHUB_SHA: "source", TRUNK_SHA: "source", GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
      GITHUB_OUTPUT: `${dir}/output`, GITHUB_RUN_ID: "current", GITHUB_RUN_ATTEMPT: "1",
      REGEN_MARKER: "chore(evidence): regenerate", branch: `${prefix}current`, ...overrides } });
    return { ...result, trace: fs.existsSync(`${dir}/trace`) ? fs.readFileSync(`${dir}/trace`, "utf8").trim().split("\n") : [] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const [name, script, prefix] of [
  ["renewal", renewal.run, "automation/kepler-audit-renewal-"],
  ["regeneration cleanup", cleanup.run, "automation/derived-artifacts-"],
]) {
  test(`${name} closes only upstream automation PRs`, () => {
    const result = run(script, prefix);
    assert.equal(result.status, 0, result.stderr);
    const expected = name === "renewal" ? ["close 1", "close 5", "close 7"] : ["close 1", "close 5"];
    assert.deepEqual(result.trace.filter((line) => line.startsWith("close")), expected);
    if (name === "renewal") assert.deepEqual(result.trace.slice(0, 2), ["push", "create"]);
  });
  test(`${name} retains candidates when trunk moves`, () => {
    assert.equal(run(script, prefix, { TRUNK_SHA: "newer" }).trace.some((line) => line.startsWith("close")), false);
  });
}

test("failed replacement publication preserves old PRs in both workflows", () => {
  assert.ok(steps.indexOf(cleanup) > steps.indexOf(publish));
  for (const script of [renewal.run, `${publish.run}\n${cleanup.run}`]) {
    for (const FAIL of ["push", "create"]) {
      const result = run(script, "automation/derived-artifacts-", { FAIL });
      assert.notEqual(result.status, 0);
      assert.equal(result.trace.some((line) => line.startsWith("close")), false);
    }
  }
});

test("old reruns stop before publication or cleanup", () => {
  assert.ok(steps.indexOf(fresh) < steps.indexOf(publish));
  const result = run(`${fresh.run}\n${publish.run}\n${cleanup.run}`, "automation/derived-artifacts-", { TRUNK_SHA: "newer" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.trace, []);
});

test("successful no-change and loop-guard paths still clean stale PRs", () => {
  assert.equal(cleanup.if, undefined);
  assert.equal(fresh.if, undefined);
  const result = run(`${fresh.run}\n${cleanup.run}`, "automation/derived-artifacts-", { branch: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.trace, ["close 1", "close 5", "close 7"]);
});
