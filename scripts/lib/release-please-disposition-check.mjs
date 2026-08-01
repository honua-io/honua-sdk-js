import process from "node:process";

import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import { automationExemption, validatePullRequestDisposition } from "./pr-issue-disposition.mjs";

export const RELEASE_PLEASE_EXEMPTION = "Release Please automation";
export const REQUIRED_DISPOSITION_CHECK = "PR Issue Disposition";
export const GITHUB_ACTIONS_APP_ID = 15368;

export const RELEASE_PLEASE_BASE = "trunk";
export const RELEASE_PLEASE_HEAD = "release-please--branches--trunk";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function normalizedRepository(value) {
  return String(value ?? "").toLowerCase();
}

function assertRepository(repository) {
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("A valid repository owner/name pair is required.");
}

function assertSha(sha, label) {
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a full lowercase commit SHA.`);
}

/**
 * Validate that trusted release automation is executing the exact policy at
 * the current trunk revision. Manual dispatches provide a safe regeneration
 * path without weakening the source-bound Release Please checks.
 */
export function validateTrustedReleasePleaseWorkflowContext(input) {
  const eventName = String(input?.eventName ?? "");
  const ref = String(input?.ref ?? "");
  const trustedPolicySha = String(input?.trustedPolicySha ?? "");
  const githubSha = String(input?.githubSha ?? "");

  if ((eventName !== "push" && eventName !== "workflow_dispatch") || ref !== "refs/heads/trunk") {
    throw new Error("Trusted Release Please disposition checks may run only for a trunk push or manual dispatch.");
  }
  assertSha(trustedPolicySha, "Trusted policy revision");
  assertSha(githubSha, "GitHub workflow revision");
  if (trustedPolicySha !== githubSha) {
    throw new Error("The checked-out trusted policy must match the triggering trunk revision.");
  }

  return { eventName, ref, trustedPolicySha };
}

function apiRoot() {
  return process.env.GITHUB_API_URL ?? "https://api.github.com";
}

function releasePleaseCandidateFromRest(pullRequest, repository) {
  const candidate = {
    repository,
    pullRequestNumber: pullRequest?.number,
    body: pullRequest?.body ?? "",
    title: pullRequest?.title ?? "",
    state: String(pullRequest?.state ?? "").toUpperCase(),
    updatedAt: pullRequest?.updated_at ?? "",
    headRefName: pullRequest?.head?.ref ?? "",
    headSha: pullRequest?.head?.sha ?? "",
    headRepository: pullRequest?.head?.repo?.full_name ?? "",
    baseRefName: pullRequest?.base?.ref ?? "",
    baseSha: pullRequest?.base?.sha ?? "",
    baseRepository: pullRequest?.base?.repo?.full_name ?? "",
    authorLogin: pullRequest?.user?.login ?? "",
    authorType: pullRequest?.user?.type ?? "",
  };

  if (!Number.isSafeInteger(candidate.pullRequestNumber) || candidate.pullRequestNumber <= 0) {
    throw new Error("GitHub returned invalid Release Please pull-request metadata.");
  }
  if (candidate.state !== "OPEN") {
    throw new Error(`Release Please pull request #${candidate.pullRequestNumber} is not open.`);
  }
  assertSha(candidate.headSha, "Release Please head");
  if (automationExemption(candidate) !== RELEASE_PLEASE_EXEMPTION) {
    throw new Error(
      `Pull request #${candidate.pullRequestNumber} did not match the exact Release Please automation policy.`,
    );
  }
  return candidate;
}

/** Locate the one exact, open, same-repository Release Please pull request. */
export async function findCurrentReleasePleasePullRequest(repository, request = githubRequest) {
  assertRepository(repository);
  const [owner] = repository.split("/");
  const url = new URL(`${apiRoot()}/repos/${repository}/pulls`);
  url.searchParams.set("state", "open");
  url.searchParams.set("base", RELEASE_PLEASE_BASE);
  url.searchParams.set("head", `${owner}:${RELEASE_PLEASE_HEAD}`);
  url.searchParams.set("per_page", "2");

  const payload = await request(url.toString());
  if (!Array.isArray(payload)) throw new Error("GitHub returned malformed open pull-request metadata.");
  if (payload.length === 0) return null;
  if (payload.length !== 1) throw new Error("GitHub returned more than one Release Please pull-request candidate.");
  return releasePleaseCandidateFromRest(payload[0], repository);
}

export function assertMatchingReleasePleaseSnapshots(rest, graphql) {
  const exactFields = [
    "pullRequestNumber",
    "body",
    "title",
    "state",
    "updatedAt",
    "headRefName",
    "headSha",
    "baseRefName",
    "baseSha",
  ];
  for (const field of exactFields) {
    if (rest[field] !== graphql[field]) {
      throw new Error(`Release Please ${field} changed between REST and GraphQL validation.`);
    }
  }
  for (const field of ["headRepository", "baseRepository"]) {
    if (normalizedRepository(rest[field]) !== normalizedRepository(graphql[field])) {
      throw new Error(`Release Please ${field} changed between REST and GraphQL validation.`);
    }
  }
}

function checkRunDetailsUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("The workflow run URL must be an https://github.com URL.");
  }
  return url.toString();
}

function checkRunSummary(current, trustedPolicySha) {
  return [
    `Exemption: ${RELEASE_PLEASE_EXEMPTION}.`,
    `Validated current REST and GraphQL metadata for ${current.repository}#${current.pullRequestNumber}.`,
    `Pull-request head: ${current.headSha}.`,
    `Trusted trunk policy revision: ${trustedPolicySha}.`,
  ].join("\n");
}

/**
 * Validate the current automation PR from trusted trunk code, then emit the
 * source-bound required check directly on the exact validated head.
 */
export async function publishReleasePleaseDispositionCheck(input, request = githubRequest) {
  const repository = String(input?.repository ?? "");
  const trustedPolicySha = String(input?.trustedPolicySha ?? "");
  assertRepository(repository);
  assertSha(trustedPolicySha, "Trusted policy revision");

  const restCandidate = await findCurrentReleasePleasePullRequest(repository, request);
  if (!restCandidate) {
    return { status: "not-found", trustedPolicySha };
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
    throw new Error(`Pull request #${current.pullRequestNumber} did not receive the Release Please exemption.`);
  }

  const requestBody = {
    name: REQUIRED_DISPOSITION_CHECK,
    head_sha: current.headSha,
    status: "completed",
    conclusion: "success",
    output: {
      title: RELEASE_PLEASE_EXEMPTION,
      summary: checkRunSummary(current, trustedPolicySha),
    },
  };
  const detailsUrl = checkRunDetailsUrl(input?.detailsUrl);
  if (detailsUrl) requestBody.details_url = detailsUrl;

  const created = await request(`${apiRoot()}/repos/${repository}/check-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (
    !Number.isSafeInteger(created?.id) ||
    created.id <= 0 ||
    created?.name !== REQUIRED_DISPOSITION_CHECK ||
    created?.head_sha !== current.headSha ||
    created?.status !== "completed" ||
    created?.conclusion !== "success" ||
    created?.app?.id !== GITHUB_ACTIONS_APP_ID ||
    created?.app?.slug !== "github-actions"
  ) {
    throw new Error("GitHub did not create the required source-bound GitHub Actions disposition check.");
  }

  return {
    status: "published",
    exemption: disposition.exemption,
    repository,
    pullRequestNumber: current.pullRequestNumber,
    headSha: current.headSha,
    trustedPolicySha,
    checkRunId: created.id,
  };
}
