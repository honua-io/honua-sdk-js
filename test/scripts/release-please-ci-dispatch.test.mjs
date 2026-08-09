import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { githubRequest } from "../../scripts/lib/github-pr-issue-disposition.mjs";
import {
  CI_WORKFLOW_PATH,
  dispatchReleasePleaseCi,
  releasePleaseCiRunTitle,
} from "../../scripts/lib/release-please-ci-dispatch.mjs";
import { RELEASE_PLEASE_HEAD } from "../../scripts/lib/release-please-disposition-check.mjs";

const repository = "honua-io/honua-sdk-js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(root, "test/fixtures/pr-issue-disposition/release-please-pr-382.json"),
    "utf8",
  ),
);

function restPull(snapshot = fixture) {
  return {
    number: snapshot.pullRequestNumber,
    body: snapshot.body,
    title: snapshot.title,
    state: snapshot.state.toLowerCase(),
    updated_at: snapshot.updatedAt,
    user: { login: snapshot.authorLogin, type: snapshot.authorType },
    head: {
      ref: snapshot.headRefName,
      sha: snapshot.headSha,
      repo: { full_name: snapshot.headRepository },
    },
    base: {
      ref: snapshot.baseRefName,
      sha: snapshot.baseSha,
      repo: { full_name: snapshot.baseRepository },
    },
  };
}

function graphqlPayload(snapshot = fixture) {
  return {
    data: {
      repository: {
        nameWithOwner: snapshot.repository,
        pullRequest: {
          number: snapshot.pullRequestNumber,
          body: snapshot.body,
          title: snapshot.title,
          state: snapshot.state,
          updatedAt: snapshot.updatedAt,
          headRefName: snapshot.headRefName,
          headRefOid: snapshot.headSha,
          headRepository: { nameWithOwner: snapshot.headRepository },
          baseRefName: snapshot.baseRefName,
          baseRefOid: snapshot.baseSha,
          baseRepository: { nameWithOwner: snapshot.baseRepository },
          author: { __typename: snapshot.authorType, login: snapshot.authorLogin },
          closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    },
  };
}

function workflowRun(snapshot = fixture, id = 9001, overrides = {}) {
  return {
    id,
    event: "workflow_dispatch",
    head_branch: RELEASE_PLEASE_HEAD,
    head_sha: snapshot.headSha,
    display_title: releasePleaseCiRunTitle(snapshot.pullRequestNumber, snapshot.headSha),
    path: CI_WORKFLOW_PATH,
    head_repository: { full_name: repository },
    status: "queued",
    conclusion: null,
    html_url: `https://github.com/${repository}/actions/runs/${id}`,
    ...overrides,
  };
}

function harness({ snapshot = fixture, branchHead = snapshot.headSha, initialRuns = [], confirmedRuns = [] } = {}) {
  const calls = [];
  let dispatched = false;
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/pulls")) return [restPull(snapshot)];
    if (pathname.endsWith("/graphql")) return graphqlPayload(snapshot);
    if (pathname.includes("/git/ref/heads/")) {
      return {
        ref: `refs/heads/${RELEASE_PLEASE_HEAD}`,
        object: { type: "commit", sha: branchHead },
      };
    }
    if (pathname.endsWith("/actions/workflows/ci.yml/runs")) {
      return { workflow_runs: dispatched ? (typeof confirmedRuns === "function" ? confirmedRuns() : confirmedRuns) : initialRuns };
    }
    if (pathname.endsWith("/actions/workflows/ci.yml/dispatches")) {
      dispatched = true;
      return null;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, request };
}

function jobSlice(workflow, jobId) {
  const start = workflow.indexOf(`  ${jobId}:\n`);
  assert.notEqual(start, -1, `missing ${jobId} job`);
  const remainder = workflow.slice(start + 2);
  const next = remainder.search(/\n  [a-z0-9-]+:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 2 + next);
}

describe("trusted Release Please canonical CI dispatch", () => {
  it("accepts GitHub's empty workflow-dispatch response", async () => {
    const previousFetch = globalThis.fetch;
    const previousToken = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = "test-token";
      globalThis.fetch = async () => ({ ok: true, status: 204 });
      assert.equal(
        await githubRequest(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/dispatches`, {
          method: "POST",
        }),
        null,
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });

  it("dispatches and confirms canonical CI for the exact current release head", async () => {
    const confirmed = workflowRun();
    const testHarness = harness({ confirmedRuns: [confirmed] });
    const result = await dispatchReleasePleaseCi(
      {
        repository,
        trustedPolicySha: fixture.baseSha,
        confirmationAttempts: 1,
        confirmationDelayMs: 0,
      },
      testHarness.request,
    );
    assert.equal(result.status, "dispatched");
    assert.equal(result.headSha, fixture.headSha);
    assert.equal(result.workflowRunId, confirmed.id);
    const dispatch = testHarness.calls.find(({ url }) =>
      new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
    );
    assert.deepEqual(JSON.parse(dispatch.options.body), {
      ref: RELEASE_PLEASE_HEAD,
      inputs: {
        release_pull_request_number: String(fixture.pullRequestNumber),
        release_head_sha: fixture.headSha,
      },
    });
  });

  it("reuses only the exact non-cancelled run identity", async () => {
    const existing = workflowRun(fixture, 9002, { status: "completed", conclusion: "success" });
    const testHarness = harness({ initialRuns: [existing] });
    const result = await dispatchReleasePleaseCi(
      { repository, trustedPolicySha: fixture.baseSha },
      testHarness.request,
    );
    assert.equal(result.status, "already-dispatched");
    assert.equal(result.workflowRunId, existing.id);
    assert.equal(
      testHarness.calls.some(({ url }) =>
        new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
      ),
      false,
    );
  });

  it("waits for terminal success on the exact dispatched head", async () => {
    let reads = 0;
    const queued = workflowRun(fixture, 9003);
    const success = workflowRun(fixture, 9003, { status: "completed", conclusion: "success" });
    const testHarness = harness({ confirmedRuns: () => (reads++ === 0 ? [queued] : [success]) });
    const result = await dispatchReleasePleaseCi(
      {
        repository,
        trustedPolicySha: fixture.baseSha,
        confirmationAttempts: 1,
        confirmationDelayMs: 0,
        completionAttempts: 2,
        completionDelayMs: 0,
        waitForCompletion: true,
      },
      testHarness.request,
    );
    assert.equal(result.workflowRunId, success.id);
    assert.equal(result.workflowRunConclusion, "success");
  });

  it("fails closed when exact-head canonical CI reaches terminal failure", async () => {
    const failure = workflowRun(fixture, 9004, { status: "completed", conclusion: "failure" });
    const testHarness = harness({ initialRuns: [failure] });
    await assert.rejects(
      dispatchReleasePleaseCi(
        {
          repository,
          trustedPolicySha: fixture.baseSha,
          completionAttempts: 1,
          completionDelayMs: 0,
          waitForCompletion: true,
        },
        testHarness.request,
      ),
      /Canonical CI concluded failure/u,
    );
  });

  it("fails closed before dispatch when the canonical release branch moved", async () => {
    const testHarness = harness({ branchHead: "f".repeat(40) });
    await assert.rejects(
      dispatchReleasePleaseCi(
        { repository, trustedPolicySha: fixture.baseSha },
        testHarness.request,
      ),
      /branch no longer resolves to the validated head/u,
    );
    assert.equal(
      testHarness.calls.some(({ url }) =>
        new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
      ),
      false,
    );
  });
});

describe("Release Please workflow policy", () => {
  it("dispatches exact-head read-only CI only from trusted release policy", () => {
    const release = fs
      .readFileSync(path.join(root, ".github/workflows/release-please.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8").replaceAll("\r\n", "\n");
    const dispatcher = jobSlice(release, "release-please-ci");
    const refresher = jobSlice(release, "release-please-refresh");
    const disposition = jobSlice(release, "release-please-disposition");
    const jsSdk = jobSlice(ci, "js-sdk");
    const mcpSdk = jobSlice(ci, "mcp-sdk");

    assert.match(release, /prs_created: \$\{\{ steps\.release\.outputs\.prs_created \}\}/u);
    assert.match(refresher, /if: \$\{\{ always\(\) && needs\.release-please\.result == 'success' \}\}/u);
    assert.match(refresher, /permissions:\n      contents: write\n      pull-requests: write/u);
    assert.match(refresher, /persist-credentials: false/u);
    assert.match(refresher, /node scripts\/refresh-release-please-base\.mjs/u);
    assert.doesNotMatch(refresher, /actions: write|checks: write/u);

    assert.match(dispatcher, /needs: \[release-please, release-please-refresh\]/u);
    assert.match(dispatcher, /release_pr_present == 'true'/u);
    assert.match(dispatcher, /permissions:\n      actions: write\n      contents: read\n      pull-requests: read/u);
    assert.match(dispatcher, /ref: \$\{\{ github\.sha \}\}/u);
    assert.match(dispatcher, /persist-credentials: false/u);
    assert.match(dispatcher, /node scripts\/dispatch-release-please-ci\.mjs/u);
    assert.doesNotMatch(dispatcher, /checks: write|contents: write|pull-requests: write/u);
    assert.match(disposition, /needs: \[release-please, release-please-refresh, release-please-ci\]/u);
    assert.match(disposition, /needs\.release-please-ci\.result == 'success'/u);

    assert.match(
      ci,
      /run-name: >-\n  \$\{\{ inputs\.release_head_sha && format\('SDK CI \| trusted release #\{0\} @ \{1\}'/u,
    );
    assert.match(ci, /release_pull_request_number:\n[\s\S]*?release_head_sha:/u);
    assert.equal((ci.match(/name: Validate trusted Release Please dispatch/gmu) ?? []).length, 2);
    for (const job of [jsSdk, mcpSdk]) {
      assert.ok(
        job.indexOf("name: Validate trusted Release Please dispatch") < job.indexOf("uses: actions/checkout@"),
      );
      assert.match(job, /refs\/heads\/release-please--branches--trunk/u);
      assert.match(job, /\^\[1-9\]\[0-9\]\*\$/u);
      assert.match(job, /\^\[0-9a-f\]\{40\}\$/u);
      assert.match(job, /"\$\{GITHUB_SHA\}" != "\$\{RELEASE_HEAD_SHA\}"/u);
    }
  });
});
