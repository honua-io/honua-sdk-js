import process from "node:process";

import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import {
  assertMatchingReleasePleaseSnapshots,
  findCurrentReleasePleasePullRequest,
  RELEASE_PLEASE_EXEMPTION,
  RELEASE_PLEASE_HEAD,
} from "./release-please-disposition-check.mjs";
import { validatePullRequestDisposition } from "./pr-issue-disposition.mjs";

export const CI_WORKFLOW_FILE = "ci.yml";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DEFAULT_CONFIRMATION_ATTEMPTS = 30;
const DEFAULT_CONFIRMATION_DELAY_MS = 2_000;

function apiRoot() {
  return process.env.GITHUB_API_URL ?? "https://api.github.com";
}

function assertRepository(repository) {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("A valid repository owner/name pair is required.");
  }
}

function assertSha(sha, label) {
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a full lowercase commit SHA.`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function normalizedRepository(value) {
  return String(value ?? "").toLowerCase();
}

export function releasePleaseCiRunTitle(pullRequestNumber, headSha) {
  assertPositiveInteger(pullRequestNumber, "Release Please pull-request number");
  assertSha(headSha, "Release Please head");
  return `SDK CI | trusted release #${pullRequestNumber} @ ${headSha}`;
}

async function loadExactReleasePleasePullRequest(repository, trustedPolicySha, request) {
  const restCandidate = await findCurrentReleasePleasePullRequest(repository, request);
  if (!restCandidate) {
    throw new Error(
      "Release Please reported a created or updated pull request, but no current automation pull request resolved.",
    );
  }

  const current = await loadCurrentPullRequestDisposition(
    { repository, pullRequestNumber: restCandidate.pullRequestNumber },
    request,
  );
  assertMatchingReleasePleaseSnapshots(restCandidate, current);
  if (current.baseSha !== trustedPolicySha) {
    throw new Error("The current Release Please base does not match the trusted trunk policy revision.");
  }
  const disposition = validatePullRequestDisposition(current);
  if (disposition.status !== "exempt" || disposition.exemption !== RELEASE_PLEASE_EXEMPTION) {
    throw new Error(`Pull request #${current.pullRequestNumber} is not exact Release Please automation.`);
  }
  return current;
}

async function assertReleaseBranchHead(repository, expectedHeadSha, request) {
  const refUrl = `${apiRoot()}/repos/${repository}/git/ref/heads/${encodeURIComponent(RELEASE_PLEASE_HEAD)}`;
  const ref = await request(refUrl);
  if (
    ref?.ref !== `refs/heads/${RELEASE_PLEASE_HEAD}` ||
    ref?.object?.type !== "commit" ||
    ref?.object?.sha !== expectedHeadSha
  ) {
    throw new Error(
      `Release Please branch no longer resolves to the validated head ${expectedHeadSha}.`,
    );
  }
}

async function listCiWorkflowRuns(repository, request) {
  const runsUrl = new URL(
    `${apiRoot()}/repos/${repository}/actions/workflows/${CI_WORKFLOW_FILE}/runs`,
  );
  runsUrl.searchParams.set("event", "workflow_dispatch");
  runsUrl.searchParams.set("branch", RELEASE_PLEASE_HEAD);
  runsUrl.searchParams.set("per_page", "50");
  const payload = await request(runsUrl.toString());
  if (!Array.isArray(payload?.workflow_runs)) {
    throw new Error("GitHub returned malformed canonical CI workflow-run metadata.");
  }
  return payload.workflow_runs;
}

function exactRunIdentity(run, expected) {
  return (
    run?.event === "workflow_dispatch" &&
    run?.head_branch === RELEASE_PLEASE_HEAD &&
    run?.head_sha === expected.headSha &&
    run?.display_title === expected.runTitle &&
    run?.path === CI_WORKFLOW_PATH &&
    normalizedRepository(run?.head_repository?.full_name) ===
      normalizedRepository(expected.repository)
  );
}

function validatedExactRun(run, expected) {
  if (!exactRunIdentity(run, expected)) return null;
  assertPositiveInteger(run.id, "Canonical CI workflow-run id");
  if (typeof run.status !== "string" || !run.status) {
    throw new Error("GitHub returned an invalid status for the exact canonical CI workflow run.");
  }
  const runUrl = new URL(String(run.html_url ?? ""));
  const expectedPath = `/${expected.repository}/actions/runs/${run.id}`.toLowerCase();
  if (
    runUrl.protocol !== "https:" ||
    runUrl.hostname !== "github.com" ||
    runUrl.pathname.toLowerCase() !== expectedPath
  ) {
    throw new Error("GitHub returned an invalid URL for the exact canonical CI workflow run.");
  }
  return {
    id: run.id,
    url: runUrl.toString(),
    status: run.status,
    conclusion: run.conclusion ?? null,
  };
}

function findReusableExactRun(runs, expected, excludedIds = new Set()) {
  for (const run of runs) {
    const exact = validatedExactRun(run, expected);
    if (
      exact &&
      !excludedIds.has(exact.id) &&
      !(exact.status === "completed" && exact.conclusion === "cancelled")
    ) {
      return exact;
    }
  }
  return null;
}

function workflowRunIds(runs) {
  return new Set(
    runs
      .map((run) => run?.id)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
}

async function verifyStillCurrent(input, expected, request) {
  const current = await loadExactReleasePleasePullRequest(
    input.repository,
    input.trustedPolicySha,
    request,
  );
  if (
    current.pullRequestNumber !== expected.pullRequestNumber ||
    current.headSha !== expected.headSha
  ) {
    throw new Error("The Release Please pull request changed while canonical CI was dispatched.");
  }
  await assertReleaseBranchHead(input.repository, expected.headSha, request);
}

function boundedConfirmationOptions(input) {
  const attempts = input.confirmationAttempts ?? DEFAULT_CONFIRMATION_ATTEMPTS;
  const delayMs = input.confirmationDelayMs ?? DEFAULT_CONFIRMATION_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
    throw new Error("Canonical CI confirmation attempts must be an integer from 1 through 60.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new Error("Canonical CI confirmation delay must be an integer from 0 through 10000 ms.");
  }
  return { attempts, delayMs };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Resolve and stabilize the current Release Please PR from trusted trunk code,
 * then dispatch read-only canonical CI against its exact same-repository head.
 */
export async function dispatchReleasePleaseCi(
  input,
  request = githubRequest,
  wait = delay,
) {
  const repository = String(input?.repository ?? "");
  const trustedPolicySha = String(input?.trustedPolicySha ?? "");
  assertRepository(repository);
  assertSha(trustedPolicySha, "Trusted policy revision");
  const { attempts, delayMs } = boundedConfirmationOptions(input ?? {});

  const current = await loadExactReleasePleasePullRequest(repository, trustedPolicySha, request);
  const expected = {
    repository,
    pullRequestNumber: current.pullRequestNumber,
    headSha: current.headSha,
    runTitle: releasePleaseCiRunTitle(current.pullRequestNumber, current.headSha),
  };
  await assertReleaseBranchHead(repository, expected.headSha, request);

  const initialRuns = await listCiWorkflowRuns(repository, request);
  const existing = findReusableExactRun(initialRuns, expected);
  if (existing) {
    await verifyStillCurrent({ repository, trustedPolicySha }, expected, request);
    return {
      status: "already-dispatched",
      repository,
      pullRequestNumber: expected.pullRequestNumber,
      headSha: expected.headSha,
      trustedPolicySha,
      workflowRunId: existing.id,
      workflowRunUrl: existing.url,
    };
  }

  const baselineRunIds = workflowRunIds(initialRuns);
  await assertReleaseBranchHead(repository, expected.headSha, request);
  const dispatchUrl = `${apiRoot()}/repos/${repository}/actions/workflows/${CI_WORKFLOW_FILE}/dispatches`;
  await request(dispatchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: RELEASE_PLEASE_HEAD,
      inputs: {
        release_pull_request_number: String(expected.pullRequestNumber),
        release_head_sha: expected.headSha,
      },
    }),
  });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const runs = await listCiWorkflowRuns(repository, request);
    const confirmed = findReusableExactRun(runs, expected, baselineRunIds);
    if (confirmed) {
      await verifyStillCurrent({ repository, trustedPolicySha }, expected, request);
      return {
        status: "dispatched",
        repository,
        pullRequestNumber: expected.pullRequestNumber,
        headSha: expected.headSha,
        trustedPolicySha,
        workflowRunId: confirmed.id,
        workflowRunUrl: confirmed.url,
      };
    }
    if (attempt + 1 < attempts) await wait(delayMs);
  }

  throw new Error(
    `Canonical CI dispatch was not confirmed for Release Please head ${expected.headSha} after ${attempts} attempts.`,
  );
}
