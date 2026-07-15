import process from "node:process";

import { automationExemption, parsePullRequestDisposition } from "./pr-issue-disposition.mjs";

const GITHUB_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      number
      body
      title
      state
      updatedAt
      headRefName
      headRefOid
      baseRefName
      author { __typename login }
      closingIssuesReferences(first: 100) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

function normalizedRepository(value) {
  return String(value ?? "").toLowerCase();
}

function repositoryFromApiUrl(value) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "repos") return null;
    return `${decodeURIComponent(parts[1])}/${decodeURIComponent(parts[2])}`;
  } catch {
    return null;
  }
}

function snapshotKey(input) {
  return JSON.stringify({
    body: input.body,
    title: input.title,
    state: input.state,
    updatedAt: input.updatedAt,
    headRefName: input.headRefName,
    headSha: input.headSha,
    baseRefName: input.baseRefName,
    authorLogin: input.authorLogin,
    authorType: input.authorType,
    closingIssueNumbers: input.closingIssueNumbers,
  });
}

function parseGraphqlSnapshot(payload, input) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error("GitHub GraphQL returned an error while reading current pull-request metadata.");
  }

  const repository = payload?.data?.repository;
  const pullRequest = repository?.pullRequest;
  if (
    normalizedRepository(repository?.nameWithOwner) !== normalizedRepository(input.repository) ||
    pullRequest?.number !== input.pullRequestNumber
  ) {
    throw new Error(`GitHub did not return ${input.repository}#${input.pullRequestNumber}.`);
  }
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Pull request #${input.pullRequestNumber} is ${String(pullRequest.state).toLowerCase()}.`);
  }

  const closing = pullRequest.closingIssuesReferences;
  if (!Array.isArray(closing?.nodes) || closing.pageInfo?.hasNextPage !== false) {
    throw new Error("GitHub closingIssuesReferences metadata is missing or exceeds the 100-item bound.");
  }

  const closingIssueNumbers = [];
  for (const issue of closing.nodes) {
    if (normalizedRepository(issue?.repository?.nameWithOwner) !== normalizedRepository(input.repository)) {
      throw new Error(`GitHub parsed a cross-repository closing reference to ${issue?.repository?.nameWithOwner}.`);
    }
    closingIssueNumbers.push(issue.number);
  }

  return {
    ...input,
    body: pullRequest.body ?? "",
    title: pullRequest.title ?? "",
    state: pullRequest.state,
    updatedAt: pullRequest.updatedAt,
    headRefName: pullRequest.headRefName ?? "",
    headSha: pullRequest.headRefOid ?? "",
    baseRefName: pullRequest.baseRefName ?? "",
    authorLogin: pullRequest.author?.login ?? "",
    authorType: pullRequest.author?.__typename ?? "",
    closingIssueNumbers,
  };
}

/** Make an authenticated GitHub JSON request with a bounded timeout. */
export async function githubRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required when --metadata is not supplied.");
  const response = await fetch(url, {
    ...options,
    redirect: "follow",
    signal: options.signal ?? AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "honua-pr-issue-disposition",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status} for ${new URL(url).pathname}.`);
  }
  return response.json();
}

async function queryPullRequest(input, request) {
  const [owner, name] = input.repository.split("/");
  const apiRoot = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? `${apiRoot}/graphql`;
  const payload = await request(graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: GITHUB_GRAPHQL_QUERY,
      variables: { owner, name, number: input.pullRequestNumber },
    }),
  });
  return parseGraphqlSnapshot(payload, input);
}

async function loadIssue(input, issueNumber, request) {
  const apiRoot = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const issue = await request(`${apiRoot}/repos/${input.repository}/issues/${issueNumber}`);
  const repository = repositoryFromApiUrl(issue?.repository_url);
  if (!repository) {
    throw new Error(`Issue #${issueNumber} returned malformed repository metadata.`);
  }
  if (issue?.number !== issueNumber) {
    throw new Error(`Issue #${issueNumber} redirected to unexpected issue #${issue?.number}.`);
  }
  return {
    number: issue?.number,
    repository,
    state: issue?.state,
    isPullRequest: Boolean(issue?.pull_request),
  };
}

/**
 * Load and stabilize the current PR snapshot instead of trusting a queued event
 * body. The final query fails a stale or reordered workflow run closed.
 */
export async function loadCurrentPullRequestDisposition(input, request = githubRequest) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input?.repository) ||
    !Number.isSafeInteger(input?.pullRequestNumber) ||
    input.pullRequestNumber <= 0
  ) {
    throw new Error("A valid repository and pull-request number are required.");
  }
  const initial = await queryPullRequest(input, request);
  const exemption = automationExemption(initial);
  const dispositions = exemption ? [] : parsePullRequestDisposition(initial.body);
  const issueNumbers = [...new Set(dispositions.map(({ issueNumber }) => issueNumber))];
  const issues = await Promise.all(issueNumbers.map((issueNumber) => loadIssue(initial, issueNumber, request)));
  const current = await queryPullRequest(input, request);

  if (snapshotKey(initial) !== snapshotKey(current)) {
    throw new Error("Pull-request metadata changed during validation; a current workflow run is required.");
  }
  return { ...current, issues };
}
