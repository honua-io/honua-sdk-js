import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const steps = parse(fs.readFileSync(".github/workflows/regenerate-derived-artifacts.yml", "utf8"))
  .jobs["commit-and-validate"].steps;
const wait = steps.find((step) => step.name === "Wait for exact regeneration validation");
const refresh = steps.find((step) => step.id === "merge-token");
const checkout = steps.find((step) => step.name === "Refresh merge checkout credentials");
const merge = steps.find((step) => step.name === "Merge validated regeneration PR");

function run(step, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reseal-token-lifetime-"));
  try {
    const stubs = {
      gh: `set -euo pipefail
[[ "$GH_TOKEN" != expired-app ]] || exit 41
printf '%s\\n' "$*" >> "$TRACE"
case "$1 $2" in
  "run view") echo "$RUN_HEAD" ;;
  "run watch") exit "$STRICT_EXIT" ;;
  "pr checks") echo "$CHECKS" ;;
  "api repos/"*) echo '["gate","disposition","review"]' ;;
  "pr view") echo "$PR_JSON" ;;
  "run list") echo "$PENDING" ;;
  "pr merge"|"pr close"|"workflow run") [[ "$GH_TOKEN" == fresh-app ]] ;;
  *) exit 99 ;;
esac`,
      git: `set -euo pipefail
[[ "$GH_TOKEN" == fresh-app ]] || exit 41
printf 'git %s\\n' "$*" >> "$TRACE"
case "$1" in
  fetch) exit 0 ;;
  rev-parse) if [[ "$2" == refs/remotes/origin/trunk ]]; then echo "$TRUNK_SHA"; else echo "$REMOTE_HEAD"; fi ;;
  merge-base)
    [[ "$3" != generated || "$4" != merged ]] || exit "$MERGED_HEAD_EXIT"
    [[ "$3" != merged ]] || exit "$MERGED_TRUNK_EXIT"
    exit "$ANCESTRY_EXIT" ;;
  *) exit 99 ;;
esac`,
      sleep: "exit 0",
    };
    for (const [name, body] of Object.entries(stubs)) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    }
    const script = path.join(dir, "step.sh");
    fs.writeFileSync(script, step.run);
    const result = spawnSync("bash", [script], {
      encoding: "utf8", timeout: 15000,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, TRACE: path.join(dir, "trace"),
        GH_TOKEN: step === wait ? "job-token" : "fresh-app",
        GENERATED: "generated", RUN_HEAD: "generated", REMOTE_HEAD: "generated", TRUNK_SHA: "source",
        STRICT_CI_RUN_ID: "123", STRICT_EXIT: "0", ANCESTRY_EXIT: "0", PR_NUMBER: "456",
        MERGED_HEAD_EXIT: "0", MERGED_TRUNK_EXIT: "0", PENDING: "0", RELEASE_MATRIX_RECEIPT_RUN_ID: "",
        GITHUB_SHA: "source", GITHUB_RUN_ID: "789", GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
        CHECKS: JSON.stringify(["gate", "disposition", "review"].map((name) => ({ name, bucket: "pass" }))),
        PR_JSON: JSON.stringify({ state: "OPEN", headRefName: "automation/derived-artifacts-789-1",
          headRefOid: "generated", baseRefName: "trunk", baseRefOid: "source" }),
        ...overrides,
      },
    });
    return { ...result, trace: fs.existsSync(path.join(dir, "trace")) ? fs.readFileSync(path.join(dir, "trace"), "utf8") : "" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("long validation uses the job token and refreshes both API and Git credentials before merging", () => {
  assert.equal(wait.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(steps.indexOf(wait) < steps.indexOf(refresh));
  assert.ok(steps.indexOf(refresh) < steps.indexOf(checkout));
  assert.ok(steps.indexOf(checkout) < steps.indexOf(merge));
  assert.equal(checkout.with.token, "${{ steps.merge-token.outputs.token || github.token }}");
  assert.equal(merge.env.GH_TOKEN, checkout.with.token);
  assert.equal(checkout.with["persist-credentials"], true);
  assert.equal(refresh.if, "needs.regenerate.outputs.changed == 'true' && steps.creds.outputs.available == 'true'");
});

test("validation completes independently of an expired installation token", () => {
  const result = run(wait);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /run watch 123 .*--exit-status/);
  assert.doesNotMatch(result.trace, /pr merge|workflow run|git /);
  assert.notEqual(run(wait, { GH_TOKEN: "expired-app" }).status, 0);
});

test("a different strict head or failed strict run never reaches required-check acceptance", () => {
  for (const overrides of [{ RUN_HEAD: "changed" }, { STRICT_EXIT: "1" }]) {
    const result = run(wait, overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.trace, /pr checks|pr merge/);
  }
});

test("failed or cancelled required checks refuse validation", () => {
  for (const bucket of ["fail", "cancel"]) {
    const result = run(wait, { CHECKS: JSON.stringify([{ name: "gate", bucket }]) });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /failed or was cancelled/);
  }
});

test("fresh credentials merge only the rechecked head through normal branch protection", () => {
  const result = run(merge);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /pr merge 456 .*--merge .*--match-head-commit generated/);
  assert.doesNotMatch(result.trace, /--admin/);
  assert.match(result.trace, /workflow run regenerate-derived-artifacts.yml/);
  assert.notEqual(run(merge, { GH_TOKEN: "expired-app" }).status, 0);
});

test("changed remote head or ancestry is refused after validation", () => {
  for (const overrides of [{ REMOTE_HEAD: "changed" }, { ANCESTRY_EXIT: "1" }]) {
    const result = run(merge, overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.trace, /pr merge|workflow run/);
  }
});

test("moving trunk closes the stale regeneration PR and re-enters regeneration for the new tip", () => {
  const result = run(merge, { TRUNK_SHA: "new-source" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /pr close 456[\s\S]*workflow run regenerate-derived-artifacts.yml --repo honua-io\/honua-sdk-js --ref trunk\n/);
  assert.doesNotMatch(result.trace, /pr merge|release_matrix_receipt_run_id/);
});

test("moving trunk hands a carried release-matrix receipt to the re-entered regeneration", () => {
  const result = run(merge, { TRUNK_SHA: "new-source", RELEASE_MATRIX_RECEIPT_RUN_ID: "321" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /workflow run regenerate-derived-artifacts.yml .* -f release_matrix_receipt_run_id=321/);
});

test("moving trunk never evicts a pending regeneration run", () => {
  const plain = run(merge, { TRUNK_SHA: "new-source", PENDING: "1" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.trace, /pr close 456/);
  assert.doesNotMatch(plain.trace, /workflow run|pr merge/);

  const carried = run(merge, { TRUNK_SHA: "new-source", PENDING: "1", RELEASE_MATRIX_RECEIPT_RUN_ID: "321" });
  assert.notEqual(carried.status, 0);
  assert.match(carried.stdout, /cannot be handed off without evicting it/);
  assert.doesNotMatch(carried.trace, /workflow run|pr merge/);
});

const mergedPr = { state: "MERGED", headRefName: "automation/derived-artifacts-789-1",
  headRefOid: "generated", baseRefName: "trunk", baseRefOid: "merged",
  mergeCommit: { oid: "merged" } };

test("already merged approved regeneration dispatches follow-through without its deleted branch", () => {
  const result = run(merge, { PR_JSON: JSON.stringify(mergedPr), TRUNK_SHA: "later-trunk" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.trace, /git merge-base --is-ancestor source generated/);
  assert.match(result.trace, /git merge-base --is-ancestor generated merged/);
  assert.match(result.trace, /git merge-base --is-ancestor merged later-trunk/);
  assert.match(result.trace, /workflow run regenerate-derived-artifacts.yml/);
  assert.doesNotMatch(result.trace, /pr merge|pr close|fetch origin refs\/heads\/automation/);
});

test("merged regeneration rejects identity drift, missing merge and uncontained approved commits", () => {
  const cases = [
    { PR_JSON: JSON.stringify({ ...mergedPr, state: "CLOSED" }) },
    { PR_JSON: JSON.stringify({ ...mergedPr, headRefOid: "changed" }) },
    { PR_JSON: JSON.stringify({ ...mergedPr, headRefName: "another-branch" }) },
    { PR_JSON: JSON.stringify({ ...mergedPr, baseRefName: "another-base" }) },
    { PR_JSON: JSON.stringify({ ...mergedPr, mergeCommit: null }) },
    { ANCESTRY_EXIT: "1" }, { MERGED_HEAD_EXIT: "1" }, { MERGED_TRUNK_EXIT: "1" },
  ];
  for (const overrides of cases) {
    const result = run(merge, { PR_JSON: JSON.stringify(mergedPr), ...overrides });
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.doesNotMatch(result.trace, /pr merge|pr close|workflow run/);
  }
});
