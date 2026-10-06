import assert from "node:assert/strict";
import { it } from "node:test";
import { continueReleasePleaseCi, validateReleasePleaseCiCompletion } from "../../scripts/lib/release-please-ci-continuation.mjs";

const repository = "honua-io/honua-sdk-js";
const head = "a".repeat(40);
const policy = "b".repeat(40);
function input(overrides = {}) {
  return {
    eventName: "workflow_run", repository, ref: "refs/heads/trunk", trustedPolicySha: policy, githubSha: policy,
    event: {
      repository: { full_name: repository },
      workflow_run: {
        id: 42, run_attempt: 1, event: "workflow_dispatch", path: ".github/workflows/ci.yml",
        head_branch: "release-please--branches--trunk", head_repository: { full_name: repository },
        head_sha: head, display_title: `SDK CI | trusted release #123 @ ${head}`,
        status: "completed", conclusion: "success", ...overrides,
      },
    },
  };
}
it("binds a completed release-head CI event to trusted trunk policy", () => {
  assert.deepEqual(validateReleasePleaseCiCompletion(input()), {
    repository, trustedPolicySha: policy, expectedWorkflowRunId: 42, expectedHeadSha: head,
  });
});
it("rejects untrusted, failed, mismatched and rerun events before any API write", async () => {
  const variants = [
    { event: "pull_request" }, { head_branch: "trunk" }, { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "fork/sdk-js" } }, { status: "in_progress" },
    { conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: "skipped" },
    { run_attempt: 2 }, { id: -1 }, { display_title: "SDK CI" }, { head_sha: "c".repeat(40) },
  ].map(input);
  variants.push({ ...input(), trustedPolicySha: head }, { ...input(), ref: "refs/heads/feature" },
    { ...input(), eventName: "push" });
  for (const candidate of variants) {
    let calls = 0;
    await assert.rejects(continueReleasePleaseCi(candidate, async () => { calls += 1; }));
    assert.equal(calls, 0);
  }
});
