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
const INVALID_TOKEN_CHARACTER_PATTERN = /[^A-Za-z0-9._~-]/u;

const METADATA_ERROR_MESSAGES = Object.freeze({
  "degraded-api": "GitHub issue metadata could not be read safely.",
  "duplicate-metadata": "GitHub returned duplicate issue metadata.",
  "invalid-api-root": "GitHub API root is invalid.",
  "invalid-bound": "A configured metadata bound is invalid.",
  "invalid-token": "GitHub token has an invalid format.",
  "issue-bound-exceeded": "The configured issue metadata bound was exceeded.",
  "malformed-metadata": "GitHub returned malformed issue metadata.",
  "missing-token": "A GitHub token is required for a live dry run.",
  "not-found": "GitHub issue metadata is not readable.",
  "pagination-bound-exceeded": "The configured pagination bound was exceeded.",
  "request-setup-failed": "GitHub request headers could not be created safely.",
  "unexpected-issue": "GitHub returned unexpected issue metadata.",
});

export class GitHubBacklogMetadataError extends Error {
  constructor(code, status = null) {
    const knownCode = Object.hasOwn(METADATA_ERROR_MESSAGES, code) ? code : "metadata-error";
    super(METADATA_ERROR_MESSAGES[knownCode] ?? "GitHub metadata validation failed.");
    this.name = "GitHubBacklogMetadataError";
    this.code = knownCode;
    this.status = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
  }
}

function metadataFail(code, status = null) {
  throw new GitHubBacklogMetadataError(code, status);
}

function positiveBound(value, fallback, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    metadataFail("invalid-bound");
  }
  return result;
}

function repositoryFromApiUrl(value) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const repositoriesIndex = parts.length - 3;
    if (repositoriesIndex < 0 || parts[repositoriesIndex] !== "repos") return null;
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

function normalizedLabels(labels) {
  if (!Array.isArray(labels)) metadataFail("malformed-metadata");
  const result = labels.map((label) => label?.name);
  if (result.some((name) => typeof name !== "string")) {
    metadataFail("malformed-metadata");
  }
  return [...new Set(result)].sort();
}

function parseIssuePayloadUnsafe(payload, expected = null) {
  const repository = repositoryFromApiUrl(payload?.repository_url);
  const number = payload?.number;
  if (!repository || !Number.isSafeInteger(number) || number <= 0) {
    metadataFail("malformed-metadata");
  }
  const key = backlogIssueKey(repository, number);
  if (expected && key !== expected.key) {
    metadataFail("unexpected-issue");
  }
  const state = String(payload?.state ?? "").toLowerCase();
  if (state !== "open" && state !== "closed") {
    metadataFail("malformed-metadata");
  }
  if (typeof payload?.updated_at !== "string" || payload.updated_at.length === 0) {
    metadataFail("malformed-metadata");
  }
  return {
    repository,
    number,
    key,
    state,
    body: typeof payload.body === "string" ? payload.body : "",
    labels: normalizedLabels(payload.labels),
    isPullRequest: Boolean(payload.pull_request),
    updatedAt: payload.updated_at,
    stable: true,
    target: false,
  };
}

function parseIssuePayload(payload, expected = null) {
  try {
    return parseIssuePayloadUnsafe(payload, expected);
  } catch (error) {
    if (error instanceof GitHubBacklogMetadataError) metadataFail(error.code, error.status);
    metadataFail("malformed-metadata");
  }
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

async function sanitizedRequest(request, url) {
  try {
    return await request(url);
  } catch (error) {
    if (error instanceof GitHubBacklogMetadataError) metadataFail(error.code, error.status);
    metadataFail("degraded-api");
  }
}

/** Make a read-only authenticated GitHub request with bounded execution time. */
export async function githubBacklogRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) metadataFail("missing-token");
  if (token.length > 1024 || INVALID_TOKEN_CHARACTER_PATTERN.test(token)) metadataFail("invalid-token");

  let headers;
  try {
    headers = new Headers();
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", "honua-backlog-dependency-dry-run");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
  } catch {
    metadataFail("request-setup-failed");
  }

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(15_000),
      headers,
    });
  } catch {
    metadataFail("degraded-api");
  }

  let responseOk;
  let responseStatus;
  try {
    responseOk = response.ok;
    responseStatus = response.status;
  } catch {
    metadataFail("degraded-api");
  }
  if (typeof responseOk !== "boolean" || !Number.isSafeInteger(responseStatus)) {
    metadataFail("degraded-api");
  }
  if (!responseOk) {
    if (responseStatus === 404) metadataFail("not-found", 404);
    metadataFail("degraded-api", responseStatus);
  }
  try {
    return await response.json();
  } catch {
    metadataFail("degraded-api");
  }
}

async function readTargetIssues({ apiRoot, repository, maxPages, maxIssues, request }) {
  const [owner, name] = repository.split("/");
  const issues = new Map();
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      `${apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues` +
      `?state=open&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`;
    const payload = await sanitizedRequest(request, url);
    if (!Array.isArray(payload) || payload.length > PAGE_SIZE) {
      metadataFail("malformed-metadata");
    }
    for (const rawIssue of payload) {
      const issue = parseIssuePayload(rawIssue);
      if (issue.repository !== repository) {
        metadataFail("unexpected-issue");
      }
      if (issue.isPullRequest) continue;
      if (issues.has(issue.key)) metadataFail("duplicate-metadata");
      issue.target = true;
      issues.set(issue.key, issue);
      if (issues.size > maxIssues) {
        metadataFail("issue-bound-exceeded");
      }
    }
    if (payload.length < PAGE_SIZE) return issues;
  }
  metadataFail("pagination-bound-exceeded");
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
      metadataFail("issue-bound-exceeded");
    }
    try {
      const payload = await sanitizedRequest(request, issueApiUrl(apiRoot, dependency.repository, dependency.number));
      const issue = parseIssuePayload(payload, dependency);
      issues.set(issue.key, issue);
      enqueue(issue);
    } catch (error) {
      if (!inaccessibleError(error)) throw error;
      unavailable.set(dependency.key, {
        repository: dependency.repository,
        number: dependency.number,
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
      const payload = await sanitizedRequest(request, issueApiUrl(apiRoot, issue.repository, issue.number));
      const current = parseIssuePayload(payload, issue);
      if (snapshotFingerprint(issue) === snapshotFingerprint(current)) return issue;
      return {
        ...issue,
        stable: false,
        driftReason: "Issue metadata changed during the required double-read.",
      };
    } catch (error) {
      if (!inaccessibleError(error)) throw error;
      return {
        ...issue,
        stable: false,
        driftReason: "Issue metadata changed during the required double-read.",
      };
    }
  });
  return stabilized;
}

async function loadGitHubBacklogSnapshotUnsafe(input, request) {
  const repository = normalizeRepository(input?.repository);
  const maxPages = positiveBound(input?.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
  const maxIssues = positiveBound(input?.maxIssues, DEFAULT_MAX_ISSUES, HARD_MAX_ISSUES);
  const maxDependencies = positiveBound(
    input?.maxDependencies,
    DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
    HARD_MAX_DEPENDENCIES,
  );
  const concurrency = positiveBound(input?.concurrency, DEFAULT_CONCURRENCY, HARD_MAX_CONCURRENCY);
  const apiRoot = String(input?.apiRoot ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/u, "");
  let apiUrl;
  try {
    apiUrl = new URL(apiRoot);
  } catch {
    metadataFail("invalid-api-root");
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    metadataFail("invalid-api-root");
  }
  if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "127.0.0.1" && apiUrl.hostname !== "localhost") {
    metadataFail("invalid-api-root");
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

/** Load a bounded dependency graph and re-read every accessible issue before planning. */
export async function loadGitHubBacklogSnapshot(input, request = githubBacklogRequest) {
  try {
    return await loadGitHubBacklogSnapshotUnsafe(input, request);
  } catch (error) {
    if (error instanceof GitHubBacklogMetadataError) metadataFail(error.code, error.status);
    if (error instanceof BacklogDependencyError) throw new BacklogDependencyError(error.code);
    metadataFail("degraded-api");
  }
}
