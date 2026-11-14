import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { prepareReleasePleaseCandidates } from "../../scripts/lib/release-please-candidates.mjs";
import { RELEASE_PLEASE_HEADS } from "../../scripts/lib/release-please-disposition-check.mjs";
import { prepareReleasePleaseRefresh, ReleasePleaseRefreshRecoveryRequired } from "../../scripts/lib/release-please-refresh-recovery.mjs";

test("only a recoverable first attempt requests a fresh workflow", async () => {
  const failure = new ReleasePleaseRefreshRecoveryRequired("trunk moved");
  const prepare = async () => { throw failure; };
  assert.deepEqual(await prepareReleasePleaseRefresh({}, prepare), { recoveryRequired: true, reason: "trunk moved" });
  await assert.rejects(prepareReleasePleaseRefresh({ retryAttempted: true }, prepare), (error) => error === failure);
  const unexpected = new Error("authentication failed");
  await assert.rejects(prepareReleasePleaseRefresh({}, async () => { throw unexpected; }), (error) => error === unexpected);
  const success = { candidates: [] };
  assert.equal(await prepareReleasePleaseRefresh({}, async () => success), success);
});

test("all conflicting candidates close before regeneration and no normalization or readiness is emitted", async () => {
  const calls = [];
  const forbidden = async () => { assert.fail("Closed candidates must never reach normalization"); };
  const result = await prepareReleasePleaseRefresh({}, (input) => prepareReleasePleaseCandidates(input, {
    refresh: async ({ headRefName }) => {
      calls.push(headRefName);
      return { status: "not-found", closedPullRequestNumber: calls.length };
    },
    locks: forbidden, mcpNotes: forbidden, workspaceNotes: forbidden,
  }));
  assert.deepEqual(calls, RELEASE_PLEASE_HEADS);
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.legacy, undefined);
  assert.match(result.reason, /#1, #2, #3, #4/u);
});

test("workflow retries on trunk once with publication disabled and separate actions permission", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-please.yml", import.meta.url), "utf8");
  const retry = workflow.split("\n  release-please-refresh-retry:\n")[1].split("\n  release-please-ci:\n")[0];
  assert.match(retry, /recovery_required == 'true' && !inputs\.retry_release_pr_refresh/u);
  const disposition = workflow.split("\n  release-please-disposition:\n")[1].split("\n  release-please-continuation:\n")[0];
  assert.match(disposition, /outputs\.recovery_required != 'true'/u);
  assert.match(retry, /permissions:\n      actions: write/u);
  assert.match(retry, /gh workflow run release-please.yml --ref trunk\n          -f retry_release_pr_refresh=true/u);
  assert.match(workflow, /id: release\n        if: >-\n          \$\{\{ !inputs\.retry_release_pr_refresh &&/u);
  assert.match(workflow, /RELEASE_PLEASE_REFRESH_RETRY: \$\{\{ inputs\.retry_release_pr_refresh \|\| false \}\}/u);
  assert.match(workflow, /inputs\.retry_release_pr_refresh && \(inputs\.finish_stranded_draft != '' \|\| inputs\.recover_sealed_source != ''\)/u);
});
