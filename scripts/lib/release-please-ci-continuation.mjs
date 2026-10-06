import { CI_WORKFLOW_PATH, releasePleaseCiRunTitle } from "./release-please-ci-dispatch.mjs";
import { publishReleasePleaseCiChecks } from "./release-please-ci-checks.mjs";
import { publishReleasePleaseDispositionCheck, RELEASE_PLEASE_HEAD } from "./release-please-disposition-check.mjs";

/** Validate event identity before invoking the existing source-bound publishers. */
export function validateReleasePleaseCiCompletion({ event, eventName, repository, ref, trustedPolicySha, githubSha }) {
  const run = event?.workflow_run;
  if (eventName !== "workflow_run" || ref !== "refs/heads/trunk" ||
      !/^[0-9a-f]{40}$/u.test(trustedPolicySha) || trustedPolicySha !== githubSha) {
    throw new Error("Continuation must execute trusted trunk policy from a workflow_run event.");
  }
  if (!run || run.event !== "workflow_dispatch" || run.path !== CI_WORKFLOW_PATH ||
      run.head_branch !== RELEASE_PLEASE_HEAD || run.head_repository?.full_name !== repository ||
      event.repository?.full_name !== repository || run.status !== "completed" ||
      run.conclusion !== "success" || run.run_attempt !== 1 ||
      !Number.isSafeInteger(run.id) || run.id <= 0) {
    throw new Error("Continuation requires an exact successful same-repository canonical CI dispatch.");
  }
  const title = /^SDK CI \| trusted release #([1-9][0-9]*) @ ([0-9a-f]{40})$/u.exec(run.display_title ?? "");
  if (!title || title[2] !== run.head_sha ||
      run.display_title !== releasePleaseCiRunTitle(Number(title[1]), run.head_sha)) {
    throw new Error("Completion title does not bind the exact release pull request and head.");
  }
  return { repository, trustedPolicySha, expectedWorkflowRunId: run.id, expectedHeadSha: run.head_sha };
}

export async function continueReleasePleaseCi(input, request, wait) {
  const policy = validateReleasePleaseCiCompletion(input);
  const checks = await publishReleasePleaseCiChecks(policy, request, wait);
  const disposition = await publishReleasePleaseDispositionCheck(policy, request);
  return { checks, disposition };
}
