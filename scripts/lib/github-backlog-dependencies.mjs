import process from "node:process";

import {
  BacklogDependencyError,
  DEFAULT_MAX_BACKLOG_ISSUES,
  DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
  MAX_BACKLOG_ISSUE_BODY_LENGTH,
  MAX_SUPPORTED_BACKLOG_ISSUES,
  backlogIssueKey,
  normalizeRepository,
  parseBacklogDependencies,
} from "./backlog-dependencies.mjs";

const DEFAULT_MAX_PAGES = 2;
const DEFAULT_CONCURRENCY = 4;
const PAGE_SIZE = 100;
const HARD_MAX_PAGES = 10;
const HARD_MAX_DEPENDENCIES = 100;
const HARD_MAX_CONCURRENCY = 10;
const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_API_RESPONSE_CHUNKS = 16_384;
const MAX_API_URL_LENGTH = 4_096;
const MAX_LABELS = 100;
const MAX_LABEL_LENGTH = 100;
const MAX_UPDATED_AT_LENGTH = 64;
const UNSAFE_LABEL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const INVALID_TOKEN_CHARACTER_PATTERN = /[^A-Za-z0-9._~-]/u;
const NONNEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)(?![\s\S])/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*(?![\s\S])/u;
const UPDATED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z(?![\s\S])/u;

const METADATA_ERROR_MESSAGES = Object.freeze({
  "degraded-api": "GitHub issue metadata could not be read safely.",
  "duplicate-metadata": "GitHub returned duplicate issue metadata.",
  "invalid-api-root": "GitHub API root is invalid.",
  "invalid-bound": "A configured metadata bound is invalid.",
  "invalid-label-mutation": "GitHub label mutation metadata is invalid.",
  "invalid-request-url": "GitHub request URL is outside the configured API root.",
  "invalid-token": "GitHub token has an invalid format.",
  "issue-bound-exceeded": "The configured issue metadata bound was exceeded.",
  "malformed-metadata": "GitHub returned malformed issue metadata.",
  "missing-token": "A GitHub token is required for live reconciliation.",
  "mutation-rejected": "GitHub rejected the bounded label mutation.",
  "not-found": "GitHub issue metadata is not readable.",
  "pagination-bound-exceeded": "The configured pagination bound was exceeded.",
  "rate-limited": "GitHub API rate capacity is insufficient for safe reconciliation.",
  "response-bound-exceeded": "GitHub response exceeds the configured resource bounds.",
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
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    metadataFail("invalid-bound");
  }
  return result;
}

function normalizeApiRoot(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_API_URL_LENGTH) {
    metadataFail("invalid-api-root");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    metadataFail("invalid-api-root");
  }
  if (url.username || url.password || url.search || url.hash) metadataFail("invalid-api-root");
  const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localHttp) {
    metadataFail("invalid-api-root");
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  return Object.freeze({ href: `${url.origin}${pathname}`, origin: url.origin, pathname });
}

function positiveIntegerText(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || !POSITIVE_INTEGER_PATTERN.test(value)) return null;
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : null;
}

function validateRequestUrl(value, apiRoot) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_API_URL_LENGTH) {
    metadataFail("invalid-request-url");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    metadataFail("invalid-request-url");
  }
  if (url.origin !== apiRoot.origin || url.username || url.password || url.hash) {
    metadataFail("invalid-request-url");
  }
  const prefix = `${apiRoot.pathname}/repos/`;
  if (!url.pathname.startsWith(prefix)) metadataFail("invalid-request-url");
  const parts = url.pathname.slice(prefix.length).split("/");
  if (parts.length !== 3 && parts.length !== 4) metadataFail("invalid-request-url");
  let repository;
  try {
    repository = normalizeRepository(`${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`);
  } catch {
    metadataFail("invalid-request-url");
  }
  if (parts[2] !== "issues") metadataFail("invalid-request-url");
  let issueNumber = null;
  if (parts.length === 4) {
    issueNumber = positiveIntegerText(parts[3]);
    if (issueNumber === null || url.search !== "") metadataFail("invalid-request-url");
  } else {
    const expected = new Map([
      ["state", "open"],
      ["sort", "created"],
      ["direction", "asc"],
      ["per_page", String(PAGE_SIZE)],
    ]);
    if (url.searchParams.size !== expected.size + 1) metadataFail("invalid-request-url");
    for (const [key, expectedValue] of expected) {
      if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== expectedValue) {
        metadataFail("invalid-request-url");
      }
    }
    const pages = url.searchParams.getAll("page");
    if (pages.length !== 1 || positiveIntegerText(pages[0], HARD_MAX_PAGES) === null) {
      metadataFail("invalid-request-url");
    }
  }
  return { href: url.href, repository, issueNumber };
}

function responseIsRateLimited(response) {
  let remaining;
  let retryAfter;
  try {
    remaining = response.headers.get("x-ratelimit-remaining");
    retryAfter = response.headers.get("retry-after");
  } catch {
    metadataFail("degraded-api");
  }
  if (remaining !== null) {
    if (!NONNEGATIVE_INTEGER_PATTERN.test(remaining)) metadataFail("degraded-api");
    const value = Number.parseInt(remaining, 10);
    if (!Number.isSafeInteger(value)) metadataFail("degraded-api");
  }
  return remaining === "0" || retryAfter !== null;
}

function repositoryFromApiUrl(value, apiRoot) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_API_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.origin !== apiRoot.origin || url.username || url.password || url.search || url.hash) return null;
    const prefix = `${apiRoot.pathname}/repos/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const parts = url.pathname.slice(prefix.length).split("/");
    if (parts.length !== 2) return null;
    return normalizeRepository(`${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`);
  } catch {
    return null;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedLabels(labels) {
  if (!Array.isArray(labels) || labels.length > MAX_LABELS) metadataFail("malformed-metadata");
  const result = [];
  const seen = new Set();
  for (const label of labels) {
    if (label === null || typeof label !== "object" || Array.isArray(label)) metadataFail("malformed-metadata");
    const name = label.name;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > MAX_LABEL_LENGTH ||
      UNSAFE_LABEL_PATTERN.test(name) ||
      seen.has(name)
    ) {
      metadataFail("malformed-metadata");
    }
    seen.add(name);
    result.push(name);
  }
  return result.sort(compareText);
}

function normalizedLabelNames(labels) {
  if (!Array.isArray(labels) || labels.length > MAX_LABELS) metadataFail("invalid-label-mutation");
  const result = [];
  const seen = new Set();
  for (const name of labels) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > MAX_LABEL_LENGTH ||
      UNSAFE_LABEL_PATTERN.test(name) ||
      seen.has(name)
    ) {
      metadataFail("invalid-label-mutation");
    }
    seen.add(name);
    result.push(name);
  }
  return result.sort(compareText);
}

function validUpdatedAt(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_UPDATED_AT_LENGTH) return false;
  const match = UPDATED_AT_PATTERN.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  const date = new Date(timestamp);
  return (
    date.getUTCFullYear() === Number.parseInt(match[1], 10) &&
    date.getUTCMonth() + 1 === Number.parseInt(match[2], 10) &&
    date.getUTCDate() === Number.parseInt(match[3], 10) &&
    date.getUTCHours() === Number.parseInt(match[4], 10) &&
    date.getUTCMinutes() === Number.parseInt(match[5], 10) &&
    date.getUTCSeconds() === Number.parseInt(match[6], 10)
  );
}

function parseIssuePayloadUnsafe(payload, apiRoot, expected = null) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) metadataFail("malformed-metadata");
  const repository = repositoryFromApiUrl(payload.repository_url, apiRoot);
  const number = payload.number;
  if (!repository || !Number.isSafeInteger(number) || number <= 0) {
    metadataFail("malformed-metadata");
  }
  const key = backlogIssueKey(repository, number);
  if (expected && key !== expected.key) {
    metadataFail("unexpected-issue");
  }
  const state = payload.state;
  if (state !== "open" && state !== "closed") {
    metadataFail("malformed-metadata");
  }
  if (!validUpdatedAt(payload.updated_at)) {
    metadataFail("malformed-metadata");
  }
  const body = payload.body === null || payload.body === undefined ? "" : payload.body;
  if (typeof body !== "string" || body.length > MAX_BACKLOG_ISSUE_BODY_LENGTH) metadataFail("malformed-metadata");
  const hasPullRequest = Object.hasOwn(payload, "pull_request");
  if (
    hasPullRequest &&
    (payload.pull_request === null || typeof payload.pull_request !== "object" || Array.isArray(payload.pull_request))
  ) {
    metadataFail("malformed-metadata");
  }
  return {
    repository,
    number,
    key,
    state,
    body,
    labels: normalizedLabels(payload.labels),
    isPullRequest: hasPullRequest,
    updatedAt: payload.updated_at,
    stable: true,
    target: false,
  };
}

function parseIssuePayload(payload, apiRoot, expected = null) {
  try {
    return parseIssuePayloadUnsafe(payload, apiRoot, expected);
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
  return `${apiRoot.href}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`;
}

function inaccessibleError(error) {
  return error instanceof GitHubBacklogMetadataError && error.code === "not-found";
}

async function sanitizedRequest(request, url, apiRoot) {
  try {
    return await request(url, { apiRoot: apiRoot.href });
  } catch (error) {
    if (error instanceof GitHubBacklogMetadataError) metadataFail(error.code, error.status);
    metadataFail("degraded-api");
  }
}

async function boundedResponseJson(response, maxBytes) {
  let contentLength;
  let contentType;
  let reader;
  let declaredLength = null;
  try {
    contentLength = response.headers.get("content-length");
    contentType = response.headers.get("content-type");
    reader = response.body?.getReader();
  } catch {
    metadataFail("degraded-api");
  }
  if (
    typeof contentType !== "string" ||
    !/^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:[\t ]*;|$)/iu.test(contentType)
  ) {
    metadataFail("degraded-api");
  }
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)(?![\s\S])/u.test(contentLength)) metadataFail("degraded-api");
    declaredLength = Number.parseInt(contentLength, 10);
    if (!Number.isSafeInteger(declaredLength)) metadataFail("degraded-api");
    if (declaredLength > maxBytes) metadataFail("response-bound-exceeded");
  }
  if (!reader || typeof reader.read !== "function") metadataFail("degraded-api");

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (!result || typeof result.done !== "boolean") metadataFail("degraded-api");
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) metadataFail("degraded-api");
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes || chunks.length >= MAX_API_RESPONSE_CHUNKS) {
        try {
          await reader.cancel();
        } catch {
          // The fixed boundary error below remains authoritative.
        }
        metadataFail("response-bound-exceeded");
      }
      chunks.push(result.value);
    }
    if (declaredLength !== null && total !== declaredLength) metadataFail("degraded-api");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof GitHubBacklogMetadataError) throw error;
    metadataFail("degraded-api");
  }
}

/** Make a read-only authenticated GitHub request with bounded execution time. */
export async function githubBacklogRequest(url, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) metadataFail("invalid-bound");
  const apiRootValue =
    options.apiRoot === undefined ? (process.env.GITHUB_API_URL ?? "https://api.github.com") : options.apiRoot;
  const apiRoot = normalizeApiRoot(apiRootValue);
  const requestUrl = validateRequestUrl(url, apiRoot).href;
  const maxResponseBytes = positiveBound(options.maxResponseBytes, MAX_API_RESPONSE_BYTES, MAX_API_RESPONSE_BYTES);
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
    const timeoutSignal = AbortSignal.timeout(15_000);
    const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
    response = await fetch(requestUrl, {
      method: "GET",
      redirect: "error",
      signal,
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
  if (
    typeof responseOk !== "boolean" ||
    !Number.isSafeInteger(responseStatus) ||
    responseStatus < 100 ||
    responseStatus > 599 ||
    (responseOk && (responseStatus < 200 || responseStatus > 299))
  ) {
    metadataFail("degraded-api");
  }
  const rateLimited = responseIsRateLimited(response);
  if (!responseOk) {
    if (rateLimited || responseStatus === 429) metadataFail("rate-limited", responseStatus);
    if (responseStatus === 404) metadataFail("not-found", 404);
    metadataFail("degraded-api", responseStatus);
  }
  if (rateLimited) metadataFail("rate-limited", responseStatus);
  return boundedResponseJson(response, maxResponseBytes);
}

/** Replace an issue's labels through one bounded, origin-locked GitHub request. */
export async function githubBacklogLabelRequest(url, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    metadataFail("invalid-label-mutation");
  }
  const apiRootValue =
    options.apiRoot === undefined ? (process.env.GITHUB_API_URL ?? "https://api.github.com") : options.apiRoot;
  const apiRoot = normalizeApiRoot(apiRootValue);
  const validatedUrl = validateRequestUrl(url, apiRoot);
  if (validatedUrl.issueNumber === null) metadataFail("invalid-request-url");
  const requestUrl = validatedUrl.href;
  const labels = normalizedLabelNames(options.labels);
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) metadataFail("missing-token");
  if (token.length > 1024 || INVALID_TOKEN_CHARACTER_PATTERN.test(token)) metadataFail("invalid-token");

  let headers;
  let body;
  try {
    headers = new Headers();
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    headers.set("User-Agent", "honua-backlog-dependency-apply");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    body = JSON.stringify({ labels });
  } catch {
    metadataFail("request-setup-failed");
  }

  let response;
  try {
    const timeoutSignal = AbortSignal.timeout(15_000);
    const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
    response = await fetch(requestUrl, {
      method: "PATCH",
      redirect: "error",
      signal,
      headers,
      body,
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
  const rateLimited = responseIsRateLimited(response);
  if (responseOk !== true || responseStatus !== 200) {
    if (responseOk === false && Number.isSafeInteger(responseStatus)) {
      if (rateLimited || responseStatus === 429) metadataFail("rate-limited", responseStatus);
      metadataFail("mutation-rejected", responseStatus);
    }
    metadataFail("degraded-api");
  }
  return boundedResponseJson(response, MAX_API_RESPONSE_BYTES);
}

async function readTargetIssues({ apiRoot, repository, maxPages, maxIssues, request }) {
  const [owner, name] = repository.split("/");
  const issues = new Map();
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      `${apiRoot.href}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues` +
      `?state=open&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`;
    const payload = await sanitizedRequest(request, url, apiRoot);
    if (!Array.isArray(payload) || payload.length > PAGE_SIZE) {
      metadataFail("malformed-metadata");
    }
    for (const rawIssue of payload) {
      const issue = parseIssuePayload(rawIssue, apiRoot);
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
    if (issues.size + unavailable.size >= maxIssues) {
      metadataFail("issue-bound-exceeded");
    }
    try {
      const payload = await sanitizedRequest(
        request,
        issueApiUrl(apiRoot, dependency.repository, dependency.number),
        apiRoot,
      );
      const issue = parseIssuePayload(payload, apiRoot, dependency);
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
      const payload = await sanitizedRequest(request, issueApiUrl(apiRoot, issue.repository, issue.number), apiRoot);
      const current = parseIssuePayload(payload, apiRoot, issue);
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

async function verifyTargetAfterGraph({ apiRoot, stabilized, targetKey, request }) {
  const index = stabilized.findIndex((issue) => issue.key === targetKey);
  if (index < 0) metadataFail("unexpected-issue");
  const target = stabilized[index];
  try {
    const payload = await sanitizedRequest(request, issueApiUrl(apiRoot, target.repository, target.number), apiRoot);
    const current = parseIssuePayload(payload, apiRoot, target);
    if (target.stable && snapshotFingerprint(target) === snapshotFingerprint(current)) return stabilized;
  } catch (error) {
    if (!inaccessibleError(error)) throw error;
  }
  stabilized[index] = {
    ...target,
    stable: false,
    driftReason: "Issue metadata changed during the required double-read.",
  };
  return stabilized;
}

async function loadGitHubBacklogSnapshotUnsafe(input, request) {
  const repository = normalizeRepository(input?.repository);
  const maxPages = positiveBound(input?.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
  const maxIssues = positiveBound(input?.maxIssues, DEFAULT_MAX_BACKLOG_ISSUES, MAX_SUPPORTED_BACKLOG_ISSUES);
  const maxDependencies = positiveBound(
    input?.maxDependencies,
    DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
    HARD_MAX_DEPENDENCIES,
  );
  const concurrency = positiveBound(input?.concurrency, DEFAULT_CONCURRENCY, HARD_MAX_CONCURRENCY);
  const apiRootValue = input?.apiRoot;
  const apiRoot = normalizeApiRoot(
    apiRootValue === undefined ? (process.env.GITHUB_API_URL ?? "https://api.github.com") : apiRootValue,
  );

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

async function loadGitHubBacklogTargetSnapshotUnsafe(input, request) {
  const repository = normalizeRepository(input?.repository);
  const issueNumber = input?.issueNumber;
  const expected = { key: backlogIssueKey(repository, issueNumber) };
  const maxIssues = positiveBound(input?.maxIssues, DEFAULT_MAX_BACKLOG_ISSUES, MAX_SUPPORTED_BACKLOG_ISSUES);
  const maxDependencies = positiveBound(
    input?.maxDependencies,
    DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
    HARD_MAX_DEPENDENCIES,
  );
  const concurrency = positiveBound(input?.concurrency, DEFAULT_CONCURRENCY, HARD_MAX_CONCURRENCY);
  const apiRootValue = input?.apiRoot;
  const apiRoot = normalizeApiRoot(
    apiRootValue === undefined ? (process.env.GITHUB_API_URL ?? "https://api.github.com") : apiRootValue,
  );

  const payload = await sanitizedRequest(request, issueApiUrl(apiRoot, repository, issueNumber), apiRoot);
  const target = parseIssuePayload(payload, apiRoot, expected);
  target.target = true;
  const issues = new Map([[target.key, target]]);
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
  await verifyTargetAfterGraph({ apiRoot, stabilized, targetKey: target.key, request });
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
      targeted: true,
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

/** Load one target's transitive dependency graph and double-read it before planning. */
export async function loadGitHubBacklogTargetSnapshot(input, request = githubBacklogRequest) {
  try {
    return await loadGitHubBacklogTargetSnapshotUnsafe(input, request);
  } catch (error) {
    if (error instanceof GitHubBacklogMetadataError) metadataFail(error.code, error.status);
    if (error instanceof BacklogDependencyError) throw new BacklogDependencyError(error.code);
    metadataFail("degraded-api");
  }
}

/** Atomically replace one issue's full label set and validate the returned issue metadata. */
export async function replaceGitHubBacklogIssueLabels(input, request = githubBacklogLabelRequest) {
  try {
    const repository = normalizeRepository(input?.repository);
    const issueNumber = input?.issueNumber;
    const expected = { key: backlogIssueKey(repository, issueNumber) };
    const labels = normalizedLabelNames(input?.labels);
    const apiRootValue = input?.apiRoot;
    const apiRoot = normalizeApiRoot(
      apiRootValue === undefined ? (process.env.GITHUB_API_URL ?? "https://api.github.com") : apiRootValue,
    );
    const payload = await request(issueApiUrl(apiRoot, repository, issueNumber), {
      apiRoot: apiRoot.href,
      labels,
    });
    const issue = parseIssuePayload(payload, apiRoot, expected);
    if (JSON.stringify(issue.labels) !== JSON.stringify(labels)) metadataFail("mutation-rejected");
    const { key: _key, updatedAt: _updatedAt, ...result } = issue;
    return result;
  } catch (error) {
    if (error instanceof GitHubBacklogMetadataError) metadataFail(error.code, error.status);
    if (error instanceof BacklogDependencyError) throw new BacklogDependencyError(error.code);
    metadataFail("degraded-api");
  }
}
