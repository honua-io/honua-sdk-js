import process from "node:process";

import { githubRequest } from "./github-pr-issue-disposition.mjs";
import { loadSuccessfulReleasePleaseCi } from "./release-please-ci-dispatch.mjs";
import { GITHUB_ACTIONS_APP_ID } from "./release-please-disposition-check.mjs";

export const REQUIRED_RELEASE_PLEASE_CI_CHECKS = Object.freeze(["JS SDK", "MCP SDK"]);

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function apiRoot() {
  return process.env.GITHUB_API_URL ?? "https://api.github.com";
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

function exactJobUrl(repository, workflowRunId, jobId, value) {
  const url = new URL(String(value ?? ""));
  const expected = `/${repository}/actions/runs/${workflowRunId}/job/${jobId}`.toLowerCase();
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname.toLowerCase() !== expected) {
    throw new Error(`Canonical CI job ${jobId} returned an invalid GitHub URL.`);
  }
  return url.toString();
}

function assertCheckRunUrl(repository, jobId, value) {
  const url = new URL(String(value ?? ""));
  const root = new URL(apiRoot());
  const expected = `/repos/${repository}/check-runs/${jobId}`.toLowerCase();
  if (url.origin !== root.origin || url.pathname.toLowerCase() !== expected) {
    throw new Error(`Canonical CI job ${jobId} returned an invalid check-run URL.`);
  }
}

function exactCreatedCheckUrl(repository, checkId, value) {
  const url = new URL(String(value ?? ""));
  const expected = `/${repository}/runs/${checkId}`.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.pathname.toLowerCase() !== expected ||
    url.search ||
    url.hash
  ) {
    throw new Error(`GitHub created source-bound check ${checkId} with an invalid URL.`);
  }
  return url.toString();
}

async function loadRequiredJobs(run, request) {
  const url = new URL(`${apiRoot()}/repos/${run.repository}/actions/runs/${run.workflowRunId}/jobs`);
  url.searchParams.set("filter", "latest");
  url.searchParams.set("per_page", "100");
  const payload = await request(url.toString());
  if (
    !Number.isSafeInteger(payload?.total_count) ||
    payload.total_count < 0 ||
    payload.total_count > 100 ||
    !Array.isArray(payload?.jobs) ||
    payload.jobs.length !== payload.total_count
  ) {
    throw new Error("GitHub returned incomplete canonical CI job metadata.");
  }

  return REQUIRED_RELEASE_PLEASE_CI_CHECKS.map((name) => {
    const matches = payload.jobs.filter((job) => job?.name === name);
    if (matches.length !== 1) {
      throw new Error(`Canonical CI must expose exactly one ${name} job; found ${matches.length}.`);
    }
    const [job] = matches;
    assertPositiveInteger(job.id, `${name} job id`);
    if (
      job.run_id !== run.workflowRunId ||
      job.run_attempt !== 1 ||
      job.workflow_name !== run.workflowRunTitle ||
      job.head_sha !== run.headSha ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    ) {
      throw new Error(`${name} does not prove terminal success for the exact canonical CI run and head.`);
    }
    assertCheckRunUrl(run.repository, job.id, job.check_run_url);
    return {
      id: job.id,
      name,
      url: exactJobUrl(run.repository, run.workflowRunId, job.id, job.html_url),
    };
  });
}

function checkSummary(run, job) {
  return [
    `Canonical job: ${job.name}.`,
    `Canonical job URL: ${job.url}.`,
    `Validated current Release Please pull request: ${run.repository}#${run.pullRequestNumber}.`,
    `Exact release head: ${run.headSha}.`,
    `Canonical workflow run: ${run.workflowRunId}.`,
    `Canonical job id: ${job.id}.`,
    `Trusted trunk policy revision: ${run.trustedPolicySha}.`,
  ].join("\n");
}

async function createSourceBoundCheck(run, job, request) {
  const body = {
    name: job.name,
    head_sha: run.headSha,
    status: "completed",
    conclusion: "success",
    details_url: job.url,
    external_id: `release-please-ci:${run.workflowRunId}:${job.id}`,
    output: {
      title: `Trusted ${job.name}`,
      summary: checkSummary(run, job),
    },
  };
  const created = await request(`${apiRoot()}/repos/${run.repository}/check-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (
    !Number.isSafeInteger(created?.id) ||
    created.id <= 0 ||
    created?.name !== job.name ||
    created?.head_sha !== run.headSha ||
    created?.status !== "completed" ||
    created?.conclusion !== "success" ||
    created?.external_id !== body.external_id ||
    created?.app?.id !== GITHUB_ACTIONS_APP_ID ||
    created?.app?.slug !== "github-actions"
  ) {
    throw new Error(`GitHub did not create the source-bound ${job.name} check with trusted provenance.`);
  }
  return {
    id: created.id,
    name: job.name,
    detailsUrl: exactCreatedCheckUrl(run.repository, created.id, created.details_url),
  };
}

const ROLLUP_QUERY = `
  query ReleasePleaseCiCheckRollup($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      databaseId
                      name
                      status
                      conclusion
                      detailsUrl
                    }
                  }
                  pageInfo { hasNextPage }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function checksVisibleInRollup(run, checks, request) {
  const [owner, name] = run.repository.split("/");
  const payload = await request(`${apiRoot()}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: ROLLUP_QUERY,
      variables: { owner, name, number: run.pullRequestNumber },
    }),
  });
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(`GitHub rejected the Release Please check-rollup query: ${payload.errors[0]?.message ?? "unknown error"}.`);
  }
  const pullRequest = payload?.data?.repository?.pullRequest;
  const commits = pullRequest?.commits?.nodes;
  if (!pullRequest || pullRequest.headRefOid !== run.headSha || !Array.isArray(commits) || commits.length !== 1) {
    throw new Error("The Release Please pull-request head changed before required checks entered its rollup.");
  }
  const commit = commits[0]?.commit;
  if (commit?.oid !== run.headSha) {
    throw new Error("GitHub returned the wrong Release Please commit rollup.");
  }
  const contexts = commit?.statusCheckRollup?.contexts;
  if (!contexts || !Array.isArray(contexts.nodes)) return false;
  if (contexts.pageInfo?.hasNextPage) {
    throw new Error("The Release Please check rollup exceeded the auditable 100-context bound.");
  }

  return checks.every((check) => {
    const context = contexts.nodes.find(
      (candidate) => candidate?.__typename === "CheckRun" && candidate?.databaseId === check.id,
    );
    if (!context) return false;
    if (
      context.name !== check.name ||
      context.status !== "COMPLETED" ||
      context.conclusion !== "SUCCESS" ||
      context.detailsUrl !== check.detailsUrl
    ) {
      throw new Error(`The PR rollup changed the published ${check.name} check provenance.`);
    }
    return true;
  });
}

function associationOptions(input) {
  const attempts = input?.associationAttempts ?? 30;
  const delayMs = input?.associationDelayMs ?? 2_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
    throw new Error("Check-rollup association attempts must be an integer from 1 through 60.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new Error("Check-rollup association delay must be an integer from 0 through 10000 ms.");
  }
  return { attempts, delayMs };
}

/** Project exact successful dispatch jobs into PR-visible required checks. */
export async function publishReleasePleaseCiChecks(input, request = githubRequest, wait = setTimeout) {
  const repository = String(input?.repository ?? "");
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("A valid repository owner/name pair is required.");
  const { attempts, delayMs } = associationOptions(input);
  const run = await loadSuccessfulReleasePleaseCi(input, request);
  const jobs = await loadRequiredJobs(run, request);
  const checks = [];
  for (const job of jobs) checks.push(await createSourceBoundCheck(run, job, request));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await checksVisibleInRollup(run, checks, request)) {
      return { ...run, status: "published", checks };
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => wait(resolve, delayMs));
  }
  throw new Error(
    `GitHub did not associate the exact ${REQUIRED_RELEASE_PLEASE_CI_CHECKS.join(" and ")} checks with ${repository}#${run.pullRequestNumber}.`,
  );
}
