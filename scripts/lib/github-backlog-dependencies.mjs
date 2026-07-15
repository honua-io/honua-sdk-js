import process from "node:process";

import {
  BacklogDependencyError,
  DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
  backlogIssueKey,
  normalizeRepository,
  parseBacklogDependencies,
} from "./backlog-dependencies.mjs";

const DEFAULT_MAX_PAGES = 2;
const DEFAULT_MAX_ISSUES = 200;
const DEFAULT_CONCURRENCY = 4;
const PAGE_SIZE = 100;
const HARD_MAX_PAGES = 10;
const HARD_MAX_ISSUES = 1_000;
const HARD_MAX_DEPENDENCIES = 100;
const HARD_MAX_CONCURRENCY = 10;

export class GitHubBacklogMetadataError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "GitHubBacklogMetadataError";
    this.code = code;
    this.status = status;
  }
}

function metadataFail(code, message, status = null) {
  throw new GitHubBacklogMetadataError(code, message, status);
}

function positiveBound(value, fallback, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    metadataFail("invalid-bound", `${label} must be between 1 and ${maximum}.`);
  }
  return result;
}

function repositoryFromApiUrl(value) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const repositoriesIndex = parts.lastIndexOf("repos");
    if (repositoriesIndex < 0 || parts.length !== repositoriesIndex + 3) return null;
    return normalizeRepository(
      `${decodeURIComponent(parts[repositoriesIndex + 1])}/${decodeURIComponent(parts[repositoriesIndex + 2])}`,
    );
  } catch {
    return null;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedLabels(labels, reference) {
  if (!Array.isArray(labels)) metadataFail("malformed-metadata", `${reference} returned malformed labels.`);
  const result = labels.map((label) => label?.name);
  if (result.some((name) => typeof name !== "string")) {
    metadataFail("malformed-metadata", `${reference} returned a label without a name.`);
  }
  return [...new Set(result)].sort();
}

function parseIssuePayload(payload, expected = null) {
  const repository = repositoryFromApiUrl(payload?.repository_url);
  const number = payload?.number;
  if (!repository || !Number.isSafeInteger(number) || number <= 0) {
    metadataFail("malformed-metadata", "GitHub returned malformed issue repository or number metadata.");
  }
  const key = backlogIssueKey(repository, number);
  if (expected && key !== expected.key) {
    metadataFail("unexpected-issue", `GitHub returned ${key} while reading ${expected.key}.`);
  }
  const state = String(payload?.state ?? "").toLowerCase();
  if (state !== "open" && state !== "closed") {
    metadataFail("malformed-metadata", `${key} returned invalid state ${JSON.stringify(payload?.state)}.`);
  }
  if (typeof payload?.updated_at !== "string" || payload.updated_at.length === 0) {
    metadataFail("malformed-metadata", `${key} returned no updated_at value.`);
  }
  return {
    repository,
    number,
    key,
    state,
    body: typeof payload.body === "string" ? payload.body : "",
    labels: normalizedLabels(payload.labels, key),
    isPullRequest: Boolean(payload.pull_request),
    updatedAt: payload.updated_at,
    stable: true,
    target: false,
  };
}

function snapshotFingerprint(issue) {
  return JSON.stringify({
    repository: issue.repository,
    number: issue.number,
    state: issue.state,
    body: issue.body,
    labels: issue.labels,
    isPullRequest: issue.isPullRequest,
    updatedAt: issue.updatedAt,
  });
}

function issueApiUrl(apiRoot, repository, number) {
  const [owner, name] = repository.split("/");
  return `${apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`;
}

function inaccessibleError(error) {
  return error instanceof GitHubBacklogMetadataError && error.code === "not-found";
}

/** Make a read-only authenticated GitHub request with bounded execution time. */
export async function githubBacklogRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) metadataFail("missing-token", "GITHUB_TOKEN or GH_TOKEN is required for a live dry run.");
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: options.signal ?? AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "honua-backlog-dependency-dry-run",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 404) metadataFail("not-found", "GitHub issue metadata is not readable.", 404);
    metadataFail(
      "degraded-api",
      `GitHub API request failed with HTTP ${response.status} for ${new URL(url).pathname}` +
        `${remaining === "0" ? " after exhausting the rate limit" : ""}.`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch {
    metadataFail("degraded-api", `GitHub API returned non-JSON metadata for ${new URL(url).pathname}.`);
  }
}

async function readTargetIssues({ apiRoot, repository, maxPages, maxIssues, request }) {
  const [owner, name] = repository.split("/");
  const issues = new Map();
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      `${apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues` +
      `?state=open&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`;
    const payload = await request(url);
    if (!Array.isArray(payload) || payload.length > PAGE_SIZE) {
      metadataFail("malformed-metadata", `GitHub returned a malformed issue page for ${repository}.`);
    }
    for (const rawIssue of payload) {
      const issue = parseIssuePayload(rawIssue);
      if (issue.repository !== repository) {
        metadataFail("unexpected-issue", `GitHub returned ${issue.key} in the ${repository} issue listing.`);
      }
      if (issue.isPullRequest) continue;
      if (issues.has(issue.key)) metadataFail("duplicate-metadata", `GitHub returned ${issue.key} more than once.`);
      issue.target = true;
      issues.set(issue.key, issue);
      if (issues.size > maxIssues) {
        metadataFail("issue-bound-exceeded", `Repository has more than the configured ${maxIssues} issue bound.`);
      }
    }
    if (payload.length < PAGE_SIZE) return issues;
  }
  metadataFail("pagination-bound-exceeded", `Repository issue listing exceeded ${maxPages} pages.`);
}

function parsedDependencies(issue, maxDependencies) {
  if (issue.state !== "open" || issue.isPullRequest) return [];
  try {
    const result = parseBacklogDependencies(issue.body, {
      repository: issue.repository,
      issueNumber: issue.number,
      maxDependencies,
    });
    return result.mode === "automatic" ? result.dependencies : [];
  } catch (error) {
    if (error instanceof BacklogDependencyError) return [];
    throw error;
  }
}

async function expandDependencyGraph({ apiRoot, issues, unavailable, maxIssues, maxDependencies, request }) {
  const queued = new Set();
  const queue = [];
  const enqueue = (issue) => {
    for (const dependency of parsedDependencies(issue, maxDependencies)) {
      if (issues.has(dependency.key) || unavailable.has(dependency.key) || queued.has(dependency.key)) continue;
      queued.add(dependency.key);
      queue.push(dependency);
    }
  };
  for (const issue of issues.values()) enqueue(issue);

  while (queue.length > 0) {
    const dependency = queue.shift();
    if (issues.size >= maxIssues) {
      metadataFail("issue-bound-exceeded", `Dependency graph reached the configured ${maxIssues} issue bound.`);
    }
    try {
      const payload = await request(issueApiUrl(apiRoot, dependency.repository, dependency.number));
      const issue = parseIssuePayload(payload, dependency);
      issues.set(issue.key, issue);
      enqueue(issue);
    } catch (error) {
      if (!inaccessibleError(error)) throw error;
      unavailable.set(dependency.key, {
        repository: dependency.repository,
        number: dependency.number,
        reason: error.message,
      });
    }
  }
}

async function mapWithConcurrency(values, concurrency, task) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function stabilizeIssues({ apiRoot, issues, concurrency, request }) {
  const initial = [...issues.values()].sort((left, right) => compareText(left.key, right.key));
  const stabilized = await mapWithConcurrency(initial, concurrency, async (issue) => {
    try {
      const payload = await request(issueApiUrl(apiRoot, issue.repository, issue.number));
      const current = parseIssuePayload(payload, issue);
      if (snapshotFingerprint(issue) === snapshotFingerprint(current)) return issue;
      return {
        ...issue,
        stable: false,
        driftReason: "issue body, labels, state, or updated_at changed during the double-read",
      };
    } catch (error) {
      if (!inaccessibleError(error)) throw error;
      return {
        ...issue,
        stable: false,
        driftReason: "issue became inaccessible during the double-read",
      };
    }
  });
  return stabilized;
}

/** Load a bounded dependency graph and re-read every accessible issue before planning. */
export async function loadGitHubBacklogSnapshot(input, request = githubBacklogRequest) {
  const repository = normalizeRepository(input?.repository);
  const maxPages = positiveBound(input?.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES, "maxPages");
  const maxIssues = positiveBound(input?.maxIssues, DEFAULT_MAX_ISSUES, HARD_MAX_ISSUES, "maxIssues");
  const maxDependencies = positiveBound(
    input?.maxDependencies,
    DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
    HARD_MAX_DEPENDENCIES,
    "maxDependencies",
  );
  const concurrency = positiveBound(input?.concurrency, DEFAULT_CONCURRENCY, HARD_MAX_CONCURRENCY, "concurrency");
  const apiRoot = String(input?.apiRoot ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/u, "");
  let apiUrl;
  try {
    apiUrl = new URL(apiRoot);
  } catch {
    metadataFail("invalid-api-root", "GitHub API root must be an absolute URL.");
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    metadataFail("invalid-api-root", "GitHub API root may not contain credentials, a query, or a fragment.");
  }
  if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "127.0.0.1" && apiUrl.hostname !== "localhost") {
    metadataFail("invalid-api-root", "GitHub API root must use HTTPS unless it is a loopback test server.");
  }

  const issues = await readTargetIssues({ apiRoot, repository, maxPages, maxIssues, request });
  const unavailable = new Map();
  await expandDependencyGraph({
    apiRoot,
    issues,
    unavailable,
    maxIssues,
    maxDependencies,
    request,
  });
  const stabilized = await stabilizeIssues({ apiRoot, issues, concurrency, request });
  return {
    repository,
    issues: stabilized
      .map(({ key: _key, updatedAt: _updatedAt, ...issue }) => issue)
      .sort((left, right) =>
        compareText(backlogIssueKey(left.repository, left.number), backlogIssueKey(right.repository, right.number)),
      ),
    unavailable: [...unavailable.values()].sort((left, right) =>
      compareText(backlogIssueKey(left.repository, left.number), backlogIssueKey(right.repository, right.number)),
    ),
    metadata: {
      doubleRead: true,
      maxPages,
      maxIssues,
      maxDependencies,
      concurrency,
    },
  };
}
