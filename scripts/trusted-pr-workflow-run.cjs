"use strict";

const SHA = /^[0-9a-f]{40}$/u;
const TERMINAL_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
]);
const TERMINAL_PULL_REQUEST_STATES = new Set(["open", "closed"]);
// A workflow run is immutable; the check-run -> pull-request association that
// names it is not. GitHub recomputes that association from live repository
// state, so two ordinary lifecycle events detach it from the run it describes:
//
//   * another push to the pull request moves the association onto the newer
//     head while this run stays pinned to the head it actually ran, and
//   * merging or closing the pull request and deleting its head branch
//     withdraws the association entirely (the run-attempt endpoint reports an
//     empty `pull_requests` array for the same reason).
//
// Neither is an integrity failure and neither is repairable: the immutable run
// evidence no longer names an observable pull request. Callers get a typed
// SupersededSourceRunError so they can record the outcome explicitly instead of
// reporting a red build for a race the observer's own design creates. Every
// other inconsistency stays a hard Error.
const SUPERSEDED_SOURCE_RUN = "superseded-source-run";
const SUPERSEDE_REASONS = new Set([
  "pull-request-association-withdrawn",
  "source-run-head-superseded",
  "pull-request-head-moved",
]);

class SupersededSourceRunError extends Error {
  constructor(reason, detail = {}) {
    if (!SUPERSEDE_REASONS.has(reason)) {
      throw new Error(`unknown superseded source-run reason: ${reason}`);
    }
    super(`source run observation is superseded: ${reason}`);
    this.name = "SupersededSourceRunError";
    this.code = SUPERSEDED_SOURCE_RUN;
    this.reason = reason;
    this.detail = detail;
  }
}

const WORKFLOW_RUN_ATTEMPT_ROUTE =
  "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}";
const WORKFLOW_RUN_ATTEMPT_JOBS_ROUTE =
  "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs";

function parsePositiveSafeInteger(value, label) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(text)) throw new Error(`invalid ${label}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error(`unsafe ${label}`);
  return number;
}

function parseRunId(value) {
  return parsePositiveSafeInteger(value, "workflow run id");
}

async function resolveTrustedPullRequestWorkflowRun({
  github,
  owner,
  repo,
  runId,
  runAttempt,
  runConclusion,
  workflowPath,
  workflowName,
  jobName,
  defaultBranch,
  repositoryId,
}) {
  if (
    !github ||
    !owner ||
    !repo ||
    !workflowPath ||
    !workflowName ||
    !jobName ||
    !defaultBranch ||
    !Number.isSafeInteger(repositoryId) ||
    repositoryId <= 0
  ) {
    throw new Error("trusted workflow-run resolver input is incomplete");
  }
  const repository = `${owner}/${repo}`;
  const id = parseRunId(runId);
  const expectedAttempt = parsePositiveSafeInteger(runAttempt, "workflow run attempt");
  if (typeof runConclusion !== "string" || !TERMINAL_CONCLUSIONS.has(runConclusion)) {
    throw new Error("invalid workflow run conclusion");
  }

  const { data: run } = await github.request(WORKFLOW_RUN_ATTEMPT_ROUTE, {
    owner,
    repo,
    run_id: id,
    attempt_number: expectedAttempt,
  });
  if (
    run?.id !== id ||
    run.path !== workflowPath ||
    run.name !== workflowName ||
    run.event !== "pull_request" ||
    run.status !== "completed" ||
    !TERMINAL_CONCLUSIONS.has(run.conclusion) ||
    run.repository?.full_name !== repository ||
    run.repository?.id !== repositoryId ||
    run.head_repository?.full_name !== repository ||
    run.head_repository?.id !== repositoryId ||
    !SHA.test(run.head_sha || "") ||
    run.run_attempt !== expectedAttempt ||
    run.conclusion !== runConclusion
  ) {
    throw new Error("source run is not a completed canonical pull-request workflow");
  }

  const jobs = await github.paginate(WORKFLOW_RUN_ATTEMPT_JOBS_ROUTE, {
    owner,
    repo,
    run_id: id,
    attempt_number: expectedAttempt,
    per_page: 100,
  });
  const canonicalJobs = jobs.filter(
    (job) =>
      job.run_id === id &&
      job.run_attempt === run.run_attempt &&
      job.workflow_name === workflowName &&
      job.name === jobName &&
      job.head_sha === run.head_sha &&
      job.status === "completed" &&
      TERMINAL_CONCLUSIONS.has(job.conclusion),
  );
  if (canonicalJobs.length !== 1) {
    throw new Error("source run does not identify exactly one canonical workflow job");
  }

  const job = canonicalJobs[0];
  if (!Number.isSafeInteger(job.id) || job.id <= 0) {
    throw new Error("canonical workflow job identity is invalid");
  }
  const { data: checkRun } = await github.rest.checks.get({
    owner,
    repo,
    check_run_id: job.id,
  });
  if (
    checkRun?.id !== job.id ||
    checkRun.name !== jobName ||
    checkRun.status !== "completed" ||
    checkRun.conclusion !== job.conclusion ||
    checkRun.head_sha !== run.head_sha
  ) {
    throw new Error("canonical workflow job check identity is inconsistent");
  }

  const associations = checkRun.pull_requests || [];
  if (associations.length === 0) {
    throw new SupersededSourceRunError("pull-request-association-withdrawn", {
      runId: id,
      runAttempt: expectedAttempt,
      runHeadSha: run.head_sha,
      checkRunId: checkRun.id,
    });
  }
  if (
    associations.length !== 1 ||
    !Number.isSafeInteger(associations[0]?.number) ||
    associations[0].number <= 0
  ) {
    throw new Error("canonical workflow check does not identify exactly one pull request");
  }
  const associated = associations[0];
  const associatedBase = associated.base?.sha;
  const associatedHead = associated.head?.sha;
  if (
    associated.base?.ref !== defaultBranch ||
    associated.base?.repo?.id !== repositoryId ||
    associated.head?.repo?.id !== repositoryId ||
    !SHA.test(associatedBase || "") ||
    !SHA.test(associatedHead || "")
  ) {
    throw new Error("canonical workflow check pull-request identity is inconsistent");
  }
  if (associatedHead !== run.head_sha) {
    throw new SupersededSourceRunError("source-run-head-superseded", {
      runId: id,
      runAttempt: expectedAttempt,
      runHeadSha: run.head_sha,
      checkRunId: checkRun.id,
      pullRequestNumber: associated.number,
      currentHeadSha: associatedHead,
    });
  }

  const { data: pullRequest } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: associated.number,
  });
  if (
    pullRequest?.number !== associated.number ||
    !TERMINAL_PULL_REQUEST_STATES.has(pullRequest.state) ||
    pullRequest.base?.ref !== defaultBranch ||
    pullRequest.base?.repo?.full_name !== repository ||
    pullRequest.base?.repo?.id !== repositoryId ||
    pullRequest.head?.repo?.full_name !== repository ||
    pullRequest.head?.repo?.id !== repositoryId
  ) {
    throw new Error("pull request moved after the canonical workflow run");
  }
  if (pullRequest.head?.sha !== associatedHead) {
    // The head advanced between the check-run read and this read: the same
    // benign race as `source-run-head-superseded`, caught one call later.
    throw new SupersededSourceRunError("pull-request-head-moved", {
      runId: id,
      runAttempt: expectedAttempt,
      runHeadSha: run.head_sha,
      checkRunId: checkRun.id,
      pullRequestNumber: associated.number,
      currentHeadSha: pullRequest.head?.sha ?? "",
    });
  }

  return {
    run,
    job,
    checkRun,
    pullRequest,
    pullRequestNumber: associated.number,
    baseSha: associatedBase,
    headSha: associatedHead,
  };
}

module.exports = {
  SUPERSEDED_SOURCE_RUN,
  SUPERSEDE_REASONS,
  SupersededSourceRunError,
  TERMINAL_CONCLUSIONS,
  parseRunId,
  resolveTrustedPullRequestWorkflowRun,
};
