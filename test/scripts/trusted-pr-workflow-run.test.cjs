"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseRunId,
  resolveTrustedPullRequestWorkflowRun,
} = require("../../scripts/trusted-pr-workflow-run.cjs");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function fixtures(overrides = {}) {
  const run = {
    id: 123,
    path: ".github/workflows/ci.yml",
    name: "SDK CI",
    event: "pull_request",
    status: "completed",
    conclusion: "failure",
    repository: { id: 1, full_name: "honua-io/honua-sdk-js" },
    head_repository: { id: 1, full_name: "honua-io/honua-sdk-js" },
    head_sha: HEAD,
    run_attempt: 2,
    pull_requests: [],
    ...overrides.run,
  };
  const job = {
    id: 456,
    run_id: 123,
    run_attempt: 2,
    workflow_name: "SDK CI",
    name: "JS SDK",
    head_sha: HEAD,
    status: "completed",
    conclusion: "success",
    ...overrides.job,
  };
  const associated = {
    number: 42,
    base: { ref: "trunk", sha: BASE, repo: { id: 1 } },
    head: { sha: HEAD, repo: { id: 1 } },
  };
  const checkRun = {
    id: 456,
    name: "JS SDK",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD,
    pull_requests: [associated],
    ...overrides.checkRun,
  };
  const pullRequest = {
    number: 42,
    state: "open",
    base: {
      ref: "trunk",
      sha: BASE,
      repo: { id: 1, full_name: "honua-io/honua-sdk-js" },
    },
    head: {
      sha: HEAD,
      repo: { id: 1, full_name: "honua-io/honua-sdk-js" },
    },
    ...overrides.pullRequest,
  };
  const jobs = overrides.jobs || [job];
  const listJobs = Symbol("list-jobs");
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: run }),
        listJobsForWorkflowRun: listJobs,
      },
      checks: {
        get: async (input) => {
          assert.equal(input.check_run_id, 456);
          return { data: checkRun };
        },
      },
      pulls: {
        get: async () => ({ data: pullRequest }),
      },
    },
    paginate: async (method, input) => {
      assert.equal(method, listJobs);
      assert.equal(input.run_id, 123);
      assert.equal(input.filter, "latest");
      assert.equal(input.per_page, 100);
      return jobs;
    },
  };
  return { github };
}

function resolve(github, { runAttempt = "2", runConclusion = "failure" } = {}) {
  return resolveTrustedPullRequestWorkflowRun({
    github,
    owner: "honua-io",
    repo: "honua-sdk-js",
    runId: "123",
    runAttempt,
    runConclusion,
    workflowPath: ".github/workflows/ci.yml",
    workflowName: "SDK CI",
    jobName: "JS SDK",
    defaultBranch: "trunk",
    repositoryId: 1,
  });
}

test("binds a multi-job workflow to the exact browser authority job", async () => {
  const { github } = fixtures();
  const result = await resolve(github);
  assert.equal(result.pullRequestNumber, 42);
  assert.equal(result.baseSha, BASE);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.run.conclusion, "failure");
  assert.equal(result.job.conclusion, "success");
});

test("explicitly excludes fork workflow runs from the evidence denominator", async () => {
  const { github } = fixtures({
    run: { head_repository: { id: 2, full_name: "contributor/honua-sdk-js" } },
  });
  await assert.rejects(resolve(github), /completed canonical/u);
});

test("binds resolution to the triggering run attempt and conclusion", async () => {
  const { github } = fixtures();
  await assert.rejects(resolve(github, { runAttempt: "1" }), /completed canonical/u);
  await assert.rejects(resolve(github, { runConclusion: "success" }), /completed canonical/u);
  await assert.rejects(resolve(github, { runAttempt: "0" }), /workflow run attempt/u);
  await assert.rejects(
    resolve(github, { runConclusion: "in_progress" }),
    /workflow run conclusion/u,
  );
});

test("fails closed on missing or ambiguous check-run associations", async () => {
  for (const pull_requests of [
    [],
    [
      {
        number: 41,
        base: { ref: "trunk", sha: BASE, repo: { id: 1 } },
        head: { sha: HEAD },
      },
      {
        number: 42,
        base: { ref: "trunk", sha: BASE, repo: { id: 1 } },
        head: { sha: HEAD },
      },
    ],
  ]) {
    const { github } = fixtures({ checkRun: { pull_requests } });
    await assert.rejects(resolve(github), /exactly one pull request/u);
  }
});

test("preserves the event base when the live default branch advances", async () => {
  const { github } = fixtures({
    pullRequest: {
      base: {
        ref: "trunk",
        sha: "c".repeat(40),
        repo: { id: 1, full_name: "honua-io/honua-sdk-js" },
      },
    },
  });
  const result = await resolve(github);
  assert.equal(result.baseSha, BASE);
  assert.equal(result.headSha, HEAD);
});

test("accepts immutable run evidence after the associated pull request closes", async () => {
  for (const pullRequest of [
    { state: "closed", merged: false },
    { state: "closed", merged: true, merged_at: "2026-08-14T19:40:00Z" },
  ]) {
    const { github } = fixtures({ pullRequest });
    const result = await resolve(github);
    assert.equal(result.pullRequestNumber, 42);
    assert.equal(result.baseSha, BASE);
    assert.equal(result.headSha, HEAD);
  }
});

test("rejects a current PR whose head moved after the workflow run", async () => {
  const { github } = fixtures({
    pullRequest: {
      head: {
        sha: "c".repeat(40),
        repo: { id: 1, full_name: "honua-io/honua-sdk-js" },
      },
    },
  });
  await assert.rejects(resolve(github), /moved after/u);
});

test("rejects an unknown pull-request state", async () => {
  const { github } = fixtures({ pullRequest: { state: "unknown" } });
  await assert.rejects(resolve(github), /moved after/u);
});

test("rejects malformed or lookalike workflow runs", async () => {
  const cases = [
    { path: ".github/workflows/lookalike.yml" },
    { name: "Lookalike" },
    { event: "workflow_dispatch" },
    { status: "in_progress", conclusion: null },
    { conclusion: null },
    { repository: { full_name: "other/repository" } },
    { head_sha: "short" },
    { run_attempt: 0 },
  ];
  for (const run of cases) {
    const { github } = fixtures({ run });
    await assert.rejects(resolve(github), /completed canonical/u);
  }
});

test("rejects missing, duplicate, or mismatched canonical jobs", async () => {
  const wrong = {
    id: 457,
    run_id: 123,
    run_attempt: 2,
    workflow_name: "SDK CI",
    name: "MCP SDK",
    head_sha: HEAD,
    status: "completed",
    conclusion: "success",
  };
  for (const jobs of [
    [],
    [wrong],
    [
      { ...wrong, id: 456, name: "JS SDK" },
      { ...wrong, id: 458, name: "JS SDK" },
    ],
  ]) {
    const { github } = fixtures({ jobs });
    await assert.rejects(resolve(github), /exactly one canonical/u);
  }
});

test("rejects inconsistent check-run and event-time association identities", async () => {
  const cases = [
    { id: 999 },
    { name: "Lookalike" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { head_sha: "c".repeat(40) },
    {
      pull_requests: [
        {
          number: 42,
          base: { ref: "other", sha: BASE, repo: { id: 1 } },
          head: { sha: HEAD },
        },
      ],
    },
    {
      pull_requests: [
        {
          number: 42,
          base: { ref: "trunk", sha: BASE, repo: { id: 99 } },
          head: { sha: HEAD },
        },
      ],
    },
    {
      pull_requests: [
        {
          number: 42,
          base: { ref: "trunk", sha: BASE, repo: { id: 1 } },
          head: { sha: HEAD, repo: { id: 99 } },
        },
      ],
    },
  ];
  for (const checkRun of cases) {
    const { github } = fixtures({ checkRun });
    await assert.rejects(resolve(github), /check|identity/u);
  }
});

test("accepts only positive safe integer workflow run ids", () => {
  assert.equal(parseRunId("123"), 123);
  for (const value of ["", "0", "-1", "1.5", "01", "9007199254740992", true]) {
    assert.throws(() => parseRunId(value), /workflow run id/u);
  }
});
