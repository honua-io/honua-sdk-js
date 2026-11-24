import process from "node:process";

import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import { automationExemption } from "./pr-issue-disposition.mjs";
import { ReleasePleaseRefreshRecoveryRequired } from "./release-please-refresh-recovery.mjs";
import {
  assertMatchingReleasePleaseSnapshots,
  findCurrentReleasePleasePullRequest,
  RELEASE_PLEASE_BASE,
  RELEASE_PLEASE_EXEMPTION,
  RELEASE_PLEASE_HEAD,
  RELEASE_PLEASE_HEADS,
} from "./release-please-disposition-check.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function apiRoot() {
  return process.env.GITHUB_API_URL ?? "https://api.github.com";
}

function assertSha(value, label) {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} must be a full lowercase commit SHA.`);
}

function pollingOptions(input) {
  const attempts = input.confirmationAttempts ?? 30;
  const delayMs = input.confirmationDelayMs ?? 2_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
    throw new Error("Release Please refresh confirmation attempts must be an integer from 1 through 60.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new Error("Release Please refresh confirmation delay must be an integer from 0 through 10000 ms.");
  }
  return { attempts, delayMs };
}

export async function loadExactReleasePleasePullRequest(repository, request, headRefName = RELEASE_PLEASE_HEAD) {
  const rest = await findCurrentReleasePleasePullRequest(repository, request, headRefName);
  if (!rest) return null;
  const current = await loadCurrentPullRequestDisposition(
    { repository, pullRequestNumber: rest.pullRequestNumber },
    request,
  );
  assertMatchingReleasePleaseSnapshots(rest, current);
  if (automationExemption(current) !== RELEASE_PLEASE_EXEMPTION) {
    throw new Error(`Pull request #${current.pullRequestNumber} is not exact Release Please automation.`);
  }
  return current;
}

async function branchHead(repository, branch, request) {
  const ref = await request(`${apiRoot()}/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (ref?.ref !== `refs/heads/${branch}` || ref?.object?.type !== "commit") {
    throw new Error(`GitHub returned malformed ${branch} branch metadata.`);
  }
  assertSha(ref.object.sha, `${branch} branch head`);
  return ref.object.sha;
}

async function assertRefreshAncestry(repository, baseSha, trustedPolicySha, request) {
  const comparison = await request(`${apiRoot()}/repos/${repository}/compare/${baseSha}...${trustedPolicySha}`);
  if (
    comparison?.status !== "ahead" ||
    comparison?.base_commit?.sha !== baseSha ||
    comparison?.merge_base_commit?.sha !== baseSha ||
    comparison?.commits?.at(-1)?.sha !== trustedPolicySha ||
    !Number.isSafeInteger(comparison?.ahead_by) ||
    comparison.ahead_by < 1 ||
    comparison?.behind_by !== 0
  ) {
    throw new Error("The stale Release Please base is not a strict ancestor of the trusted trunk revision.");
  }
}

function validateUpdateResponse(response, repository, pullRequestNumber) {
  const url = new URL(String(response?.url ?? ""));
  const expected = new URL(
    `${apiRoot().replace(/\/+$/u, "")}/repos/${repository}/pulls/${pullRequestNumber}`,
  );
  if (
    response?.message !== "Updating pull request branch." ||
    expected.protocol !== "https:" ||
    url.protocol !== "https:" ||
    url.origin !== expected.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname.toLowerCase() !== expected.pathname.toLowerCase() ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("GitHub did not accept the exact Release Please branch refresh.");
  }
}

async function assertRefreshCommit(repository, newHeadSha, oldHeadSha, trustedPolicySha, request) {
  const commit = await request(`${apiRoot()}/repos/${repository}/git/commits/${newHeadSha}`);
  const parentShas = Array.isArray(commit?.parents) ? commit.parents.map((parent) => parent?.sha) : [];
  if (
    commit?.sha !== newHeadSha ||
    parentShas.length !== 2 ||
    parentShas[0] !== oldHeadSha ||
    parentShas[1] !== trustedPolicySha
  ) {
    throw new Error("The refreshed Release Please head is not the exact trusted two-parent base update.");
  }
}

async function readCandidate({ repository, trustedPolicySha, headRefName, reportedPullRequestNumber }, request) {
  const current = await loadExactReleasePleasePullRequest(repository, request, headRefName);
  if (reportedPullRequestNumber !== undefined && current?.pullRequestNumber !== reportedPullRequestNumber) {
    throw new Error("Release Please action output does not match the exact current candidate.");
  }
  if (!current) return { current };
  const trustedBranchHead = await branchHead(repository, RELEASE_PLEASE_BASE, request);
  if (trustedBranchHead !== trustedPolicySha) {
    throw new ReleasePleaseRefreshRecoveryRequired("The trusted trunk branch moved before Release Please base refresh.");
  }
  return { current, currentBranchHead: await branchHead(repository, headRefName, request) };
}

function isSettled({ current, currentBranchHead }, trustedPolicySha) {
  return !current || (currentBranchHead === current.headSha && current.baseSha === trustedPolicySha);
}

async function closeConflictingCandidate(target, expected, request) {
  const url = `${apiRoot()}/repos/${target.repository}/pulls/${expected.pullRequestNumber}`;
  const detail = await request(url);
  if (detail?.mergeable !== false || detail?.number !== expected.pullRequestNumber ||
      detail?.state !== "open" || detail?.head?.sha !== expected.headSha ||
      detail?.base?.sha !== expected.baseSha) return false;
  const { current, currentBranchHead } = await readCandidate(target, request);
  if (current?.pullRequestNumber !== expected.pullRequestNumber || current?.headSha !== expected.headSha ||
      current?.baseSha !== expected.baseSha || currentBranchHead !== expected.headSha) {
    throw new Error("Release Please candidate changed before conflict recovery.");
  }
  const closed = await request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  if (closed?.number !== expected.pullRequestNumber || closed?.state !== "closed" ||
      closed?.head?.sha !== expected.headSha) {
    throw new Error("GitHub did not confirm closing the exact conflicting Release Please candidate.");
  }
  return true;
}

async function updateCandidateBranch(target, current, request) {
  try {
    const response = await request(
      `${apiRoot()}/repos/${target.repository}/pulls/${current.pullRequestNumber}/update-branch`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_head_sha: current.headSha }),
      },
    );
    validateUpdateResponse(response, target.repository, current.pullRequestNumber);
    return false;
  } catch (error) {
    if (error.status !== 422 || !await closeConflictingCandidate(target, current, request)) throw error;
    return true;
  }
}

/**
 * Confirm an exact Release Please bot branch sits on trusted trunk. A branch
 * Release Please rebuilt must settle on trusted trunk; an unreported one that
 * is behind is refreshed with a two-parent update-branch merge.
 */
export async function refreshReleasePleaseBase(input, request = githubRequest, wait = setTimeout) {
  const repository = String(input?.repository ?? "");
  const trustedPolicySha = String(input?.trustedPolicySha ?? "");
  const releasePleaseReportedUpdate = input?.releasePleaseReportedUpdate;
  const headRefName = input?.headRefName ?? RELEASE_PLEASE_HEAD;
  if (!RELEASE_PLEASE_HEADS.includes(headRefName)) throw new Error("Unsupported exact Release Please candidate branch.");
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("A valid repository owner/name pair is required.");
  assertSha(trustedPolicySha, "Trusted policy revision");
  if (typeof releasePleaseReportedUpdate !== "boolean") {
    throw new Error("Release Please update disposition must be an exact boolean.");
  }
  const { attempts, delayMs } = pollingOptions(input ?? {});

  // GitHub settles a force-pushed pull request's head and base metadata shortly
  // after the push, so a reported update is read until it settles.
  const settleAttempts = releasePleaseReportedUpdate ? attempts : 1;
  const reportedPullRequestNumber = input?.reportedPullRequestNumber;
  const target = { repository, trustedPolicySha, headRefName, reportedPullRequestNumber };
  const read = () => readCandidate(target, request);
  let candidate = await read();
  for (let attempt = 1; attempt < settleAttempts && !isSettled(candidate, trustedPolicySha); attempt += 1) {
    await new Promise((resolve) => wait(resolve, delayMs));
    candidate = await read();
  }
  const { current, currentBranchHead } = candidate;
  if (!current) return { status: "not-found", repository, trustedPolicySha };
  if (currentBranchHead !== current.headSha) {
    throw new Error("The Release Please branch does not match the validated pull-request head.");
  }
  if (current.baseSha === trustedPolicySha) {
    return {
      status: releasePleaseReportedUpdate ? "release-please-updated" : "already-current",
      repository,
      pullRequestNumber: current.pullRequestNumber,
      headSha: current.headSha,
      trustedPolicySha,
    };
  }
  if (releasePleaseReportedUpdate) {
    throw new Error("Release Please reported an update but left its pull request on a stale trusted base.");
  }
  if (input.requireCurrent === true) throw new Error("Release Please candidate base moved during normalization.");

  await assertRefreshAncestry(repository, current.baseSha, trustedPolicySha, request);
  if (await updateCandidateBranch(target, current, request)) {
    return { status: "not-found", repository, trustedPolicySha, closedPullRequestNumber: current.pullRequestNumber };
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const refreshed = await loadExactReleasePleasePullRequest(repository, request, headRefName);
    if (!refreshed || refreshed.pullRequestNumber !== current.pullRequestNumber) {
      throw new Error("The exact Release Please pull request disappeared during base refresh.");
    }
    if (refreshed.baseSha === trustedPolicySha && refreshed.headSha !== current.headSha) {
      const refreshedBranchHead = await branchHead(repository, headRefName, request);
      if (refreshedBranchHead !== refreshed.headSha) {
        throw new Error("The refreshed Release Please branch does not match its pull-request head.");
      }
      await assertRefreshCommit(repository, refreshed.headSha, current.headSha, trustedPolicySha, request);
      return {
        status: "refreshed",
        repository,
        pullRequestNumber: refreshed.pullRequestNumber,
        previousHeadSha: current.headSha,
        headSha: refreshed.headSha,
        trustedPolicySha,
      };
    }
    if (refreshed.baseSha !== current.baseSha || refreshed.headSha !== current.headSha) {
      throw new Error("Release Please metadata changed to an unexpected intermediate refresh state.");
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => wait(resolve, delayMs));
  }
  throw new Error(`Release Please base refresh was not confirmed after ${attempts} attempts.`);
}
