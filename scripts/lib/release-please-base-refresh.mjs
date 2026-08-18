import process from "node:process";

import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import { BOUND_PIN_PATHS, PIN_COMMIT_MESSAGE } from "./lockfile-pin.mjs";
import { automationExemption } from "./pr-issue-disposition.mjs";
import {
  assertMatchingReleasePleaseSnapshots,
  findCurrentReleasePleasePullRequest,
  RELEASE_PLEASE_BASE,
  RELEASE_PLEASE_EXEMPTION,
  RELEASE_PLEASE_HEAD,
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

async function loadExactReleasePleasePullRequest(repository, request) {
  const rest = await findCurrentReleasePleasePullRequest(repository, request);
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

/**
 * Drop the lockfile-digest pin commit before merging trunk into the branch.
 *
 * The pin and any trunk dependency bump edit the same one line in both bound
 * files, so merging trunk into a pinned branch would conflict and this refresh
 * would fail (honua-io/honua-sdk-js#1357). Dropping it costs nothing: the
 * `release-please-lockfile-pin` job re-applies the pin immediately after this
 * job, computed for the refreshed lockfile, which is the only correct value
 * anyway. The rewind is deliberately narrow -- it accepts only a single-parent
 * commit carrying the exact pin message and changing exactly the bound files,
 * and refuses anything else rather than force-rewinding a branch it does not
 * fully recognise.
 */
async function rewindLockfilePinCommit(repository, current, request) {
  const commit = await request(`${apiRoot()}/repos/${repository}/git/commits/${current.headSha}`);
  if (commit?.sha !== current.headSha) throw new Error("GitHub returned the wrong Release Please head commit.");
  if (commit.message !== PIN_COMMIT_MESSAGE) return current;

  const parents = Array.isArray(commit.parents) ? commit.parents.map((parent) => parent?.sha) : [];
  if (parents.length !== 1) {
    throw new Error("The Release Please lockfile-digest pin commit is not a single-parent commit.");
  }
  assertSha(String(parents[0]), "Release Please lockfile-digest pin parent");
  const comparison = await request(`${apiRoot()}/repos/${repository}/compare/${parents[0]}...${current.headSha}`);
  const changed = (Array.isArray(comparison?.files) ? comparison.files : []).map((file) => file?.filename).sort();
  if (
    comparison?.status !== "ahead" ||
    comparison?.ahead_by !== 1 ||
    comparison?.behind_by !== 0 ||
    JSON.stringify(changed) !== JSON.stringify([...BOUND_PIN_PATHS].sort())
  ) {
    throw new Error(
      `The Release Please head carries the lockfile-digest pin message but changes more than ${BOUND_PIN_PATHS.join(" and ")}.`,
    );
  }

  const updated = await request(
    `${apiRoot()}/repos/${repository}/git/refs/heads/${encodeURIComponent(RELEASE_PLEASE_HEAD)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: parents[0], force: true }),
    },
  );
  if (updated?.ref !== `refs/heads/${RELEASE_PLEASE_HEAD}` || updated?.object?.sha !== parents[0]) {
    throw new Error("GitHub did not rewind the Release Please branch off its lockfile-digest pin commit.");
  }
  const rewound = await loadExactReleasePleasePullRequest(repository, request);
  if (
    !rewound ||
    rewound.pullRequestNumber !== current.pullRequestNumber ||
    rewound.headSha !== parents[0] ||
    rewound.baseSha !== current.baseSha
  ) {
    throw new Error("The exact Release Please pull request did not settle on the rewound head.");
  }
  return rewound;
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

/** Refresh an unchanged exact Release Please bot branch onto trusted trunk. */
export async function refreshReleasePleaseBase(input, request = githubRequest, wait = setTimeout) {
  const repository = String(input?.repository ?? "");
  const trustedPolicySha = String(input?.trustedPolicySha ?? "");
  const releasePleaseReportedUpdate = input?.releasePleaseReportedUpdate;
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("A valid repository owner/name pair is required.");
  assertSha(trustedPolicySha, "Trusted policy revision");
  if (typeof releasePleaseReportedUpdate !== "boolean") {
    throw new Error("Release Please update disposition must be an exact boolean.");
  }
  const { attempts, delayMs } = pollingOptions(input ?? {});

  let current = await loadExactReleasePleasePullRequest(repository, request);
  if (!current) return { status: "not-found", repository, trustedPolicySha };
  const trustedBranchHead = await branchHead(repository, RELEASE_PLEASE_BASE, request);
  if (trustedBranchHead !== trustedPolicySha) {
    throw new Error("The trusted trunk branch moved before Release Please base refresh.");
  }
  const currentBranchHead = await branchHead(repository, RELEASE_PLEASE_HEAD, request);
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

  await assertRefreshAncestry(repository, current.baseSha, trustedPolicySha, request);
  current = await rewindLockfilePinCommit(repository, current, request);
  const response = await request(
    `${apiRoot()}/repos/${repository}/pulls/${current.pullRequestNumber}/update-branch`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_head_sha: current.headSha }),
    },
  );
  validateUpdateResponse(response, repository, current.pullRequestNumber);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const refreshed = await loadExactReleasePleasePullRequest(repository, request);
    if (!refreshed || refreshed.pullRequestNumber !== current.pullRequestNumber) {
      throw new Error("The exact Release Please pull request disappeared during base refresh.");
    }
    if (refreshed.baseSha === trustedPolicySha && refreshed.headSha !== current.headSha) {
      const refreshedBranchHead = await branchHead(repository, RELEASE_PLEASE_HEAD, request);
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
