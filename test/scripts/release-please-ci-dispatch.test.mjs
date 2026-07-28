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

function restPull(snapshot) {
  return {
    number: snapshot.pullRequestNumber,
    body: snapshot.body,
    title: snapshot.title,
    state: snapshot.state.toLowerCase(),
    updated_at: snapshot.updatedAt,
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
    user: {
      login: snapshot.authorLogin,
      type: snapshot.authorType,
    },
  };
}

function graphqlPayload(snapshot) {
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
          author: {
            __typename: snapshot.authorType,
            login: snapshot.authorLogin,
          },
          closingIssuesReferences: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  };
}

function workflowRun(snapshot, id, overrides = {}) {
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

function createHarness({
  snapshot = fixture,
  initialRuns = [],
  dispatchedRuns = [],
  branchHeadSha = snapshot.headSha,
  graphqlSnapshots = [],
  pullRequests,
} = {}) {
  const calls = [];
  let dispatched = false;
  let graphqlCall = 0;
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/pulls")) {
      return pullRequests ?? [restPull(snapshot)];
    }
    if (pathname.endsWith("/graphql")) {
      const current = graphqlSnapshots[graphqlCall] ?? snapshot;
      graphqlCall += 1;
      return graphqlPayload(current);
    }
    if (pathname.includes("/git/ref/heads/")) {
      return {
        ref: `refs/heads/${RELEASE_PLEASE_HEAD}`,
        object: { type: "commit", sha: branchHeadSha },
      };
    }
    if (pathname.endsWith("/actions/workflows/ci.yml/runs")) {
      return { workflow_runs: dispatched ? dispatchedRuns : initialRuns };
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
  it("accepts GitHub's empty 204 workflow-dispatch response", async () => {
    const previousFetch = globalThis.fetch;
    const previousToken = process.env.GITHUB_TOKEN;
    let requestHeaders;
    try {
      process.env.GITHUB_TOKEN = "test-token";
      globalThis.fetch = async (_url, options) => {
        requestHeaders = options.headers;
        return { ok: true, status: 204 };
      };
      assert.equal(
        await githubRequest(
          `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/dispatches`,
          { method: "POST" },
        ),
        null,
      );
      assert.equal(requestHeaders.Authorization, "Bearer test-token");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });

  it("dispatches canonical CI with exact PR/head inputs and confirms the new run", async () => {
    const confirmedRun = workflowRun(fixture, 9001);
    const harness = createHarness({ dispatchedRuns: [confirmedRun] });

    const result = await dispatchReleasePleaseCi(
      {
        repository,
        trustedPolicySha: fixture.baseSha,
        confirmationAttempts: 1,
        confirmationDelayMs: 0,
      },
      harness.request,
      async () => {},
    );

    assert.deepEqual(result, {
      status: "dispatched",
      repository,
      pullRequestNumber: fixture.pullRequestNumber,
      headSha: fixture.headSha,
      trustedPolicySha: fixture.baseSha,
      workflowRunId: 9001,
      workflowRunUrl: `https://github.com/${repository}/actions/runs/9001`,
    });
    const dispatch = harness.calls.find(({ url }) =>
      new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
    );
    assert.equal(dispatch.options.method, "POST");
    assert.deepEqual(JSON.parse(dispatch.options.body), {
      ref: RELEASE_PLEASE_HEAD,
      inputs: {
        release_pull_request_number: String(fixture.pullRequestNumber),
        release_head_sha: fixture.headSha,
      },
    });
    assert.equal(
      harness.calls.filter(({ url }) => new URL(url).pathname.endsWith("/graphql")).length,
      4,
    );
  });

  it("is idempotent when the exact non-cancelled head already has a confirmed run", async () => {
    const existingRun = workflowRun(fixture, 9002, {
      status: "completed",
      conclusion: "failure",
    });
    const harness = createHarness({ initialRuns: [existingRun] });

    const result = await dispatchReleasePleaseCi(
      { repository, trustedPolicySha: fixture.baseSha },
      harness.request,
    );

    assert.equal(result.status, "already-dispatched");
    assert.equal(result.workflowRunId, 9002);
    assert.equal(
      harness.calls.some(({ url }) =>
        new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
      ),
      false,
    );
  });

  it("does not reuse a stale-head run after Release Please updates the branch", async () => {
    const previous = { ...fixture, headSha: "1".repeat(40) };
    const updated = { ...fixture, headSha: "2".repeat(40) };
    const oldRun = workflowRun(previous, 9003, {
      status: "completed",
      conclusion: "success",
    });
    const newRun = workflowRun(updated, 9004);
    const harness = createHarness({
      snapshot: updated,
      branchHeadSha: updated.headSha,
      initialRuns: [oldRun],
      dispatchedRuns: [newRun, oldRun],
    });

    const result = await dispatchReleasePleaseCi(
      {
        repository,
        trustedPolicySha: updated.baseSha,
        confirmationAttempts: 1,
        confirmationDelayMs: 0,
      },
      harness.request,
      async () => {},
    );

    assert.equal(result.status, "dispatched");
    assert.equal(result.headSha, updated.headSha);
    assert.equal(result.workflowRunId, 9004);
    const dispatch = harness.calls.find(({ url }) =>
      new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
    );
    assert.equal(JSON.parse(dispatch.options.body).inputs.release_head_sha, updated.headSha);
    assert.notEqual(
      releasePleaseCiRunTitle(updated.pullRequestNumber, updated.headSha),
      releasePleaseCiRunTitle(previous.pullRequestNumber, previous.headSha),
    );
  });

  it("fails closed before dispatch for a missing PR, fork identity, or stale branch ref", async () => {
    const missing = createHarness({ pullRequests: [] });
    await assert.rejects(
      dispatchReleasePleaseCi(
        { repository, trustedPolicySha: fixture.baseSha },
        missing.request,
      ),
      /no current automation pull request resolved/u,
    );

    const forkSnapshot = { ...fixture, headRepository: "attacker/honua-sdk-js" };
    const fork = createHarness({ snapshot: forkSnapshot });
    await assert.rejects(
      dispatchReleasePleaseCi(
        { repository, trustedPolicySha: forkSnapshot.baseSha },
        fork.request,
      ),
      /did not match the exact Release Please automation policy/u,
    );

    const stale = createHarness({ branchHeadSha: "3".repeat(40) });
    await assert.rejects(
      dispatchReleasePleaseCi(
        { repository, trustedPolicySha: fixture.baseSha },
        stale.request,
      ),
      /branch no longer resolves to the validated head/u,
    );
    assert.equal(
      stale.calls.some(({ url }) =>
        new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
      ),
      false,
    );
  });

  it("fails closed when stabilized metadata changes and never dispatches", async () => {
    const changed = {
      ...fixture,
      updatedAt: "2026-07-16T05:38:00Z",
      headSha: "4".repeat(40),
    };
    const harness = createHarness({ graphqlSnapshots: [fixture, changed] });

    await assert.rejects(
      dispatchReleasePleaseCi(
        { repository, trustedPolicySha: fixture.baseSha },
        harness.request,
      ),
      /changed during validation/u,
    );
    assert.equal(
      harness.calls.some(({ url }) =>
        new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
      ),
      false,
    );
  });

  it("fails visibly after a bounded confirmation timeout", async () => {
    const harness = createHarness();
    let waits = 0;

    await assert.rejects(
      dispatchReleasePleaseCi(
        {
          repository,
          trustedPolicySha: fixture.baseSha,
          confirmationAttempts: 2,
          confirmationDelayMs: 0,
        },
        harness.request,
        async () => {
          waits += 1;
        },
      ),
      /dispatch was not confirmed.*after 2 attempts/u,
    );
    assert.equal(waits, 1);
    assert.equal(
      harness.calls.filter(({ url }) =>
        new URL(url).pathname.endsWith("/actions/workflows/ci.yml/dispatches"),
      ).length,
      1,
    );
  });
});

describe("Release Please workflow policy", () => {
  it("keeps write authority in trusted trunk code and dispatches only after a PR update", () => {
    const releaseWorkflow = fs
      .readFileSync(path.join(root, ".github/workflows/release-please.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    const dispatcher = jobSlice(releaseWorkflow, "release-please-ci");
    const disposition = jobSlice(releaseWorkflow, "release-please-disposition");
    const actionUses = [
      ...releaseWorkflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu),
    ].map((match) => match[1]);

    assert.match(
      releaseWorkflow,
      /prs_created: \$\{\{ steps\.release\.outputs\.prs_created \}\}/u,
    );
    assert.match(
      dispatcher,
      /^  release-please-ci:\n    needs: release-please\n    if: \$\{\{ needs\.release-please\.outputs\.prs_created == 'true' \}\}/mu,
    );
    assert.match(
      dispatcher,
      /permissions:\n      actions: write\n      contents: read\n      pull-requests: read/u,
    );
    assert.match(
      dispatcher,
      /concurrency:\n      group: release-please-ci-dispatch-\$\{\{ github\.repository \}\}\n      cancel-in-progress: true/u,
    );
    assert.match(dispatcher, /ref: \$\{\{ github\.sha \}\}/u);
    assert.match(dispatcher, /path: trusted-ci-policy/u);
    assert.match(dispatcher, /persist-credentials: false/u);
    assert.match(dispatcher, /node-version: "20\.19\.0"/u);
    assert.match(dispatcher, /working-directory: trusted-ci-policy/u);
    assert.match(dispatcher, /node scripts\/dispatch-release-please-ci\.mjs/u);
    assert.doesNotMatch(dispatcher, /checks: write|contents: write|pull-requests: write/u);
    assert.match(
      disposition,
      /permissions:\n      checks: write\n      contents: read\n      issues: read\n      pull-requests: read/u,
    );
    assert.match(disposition, /node scripts\/check-release-please-disposition\.mjs/u);
    assert.ok(actionUses.length > 0);
    for (const actionUse of actionUses) {
      assert.match(actionUse, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u);
    }
  });

  it("binds both required SDK contexts to exact dispatch inputs under read-only CI", () => {
    const ciWorkflow = fs
      .readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    const benchmarkLab = jobSlice(ciWorkflow, "benchmark-lab");
    const jsSdk = jobSlice(ciWorkflow, "js-sdk");
    const mcpSdk = jobSlice(ciWorkflow, "mcp-sdk");
    const samplePublisher = jobSlice(ciWorkflow, "sample-bundles-release");

    assert.match(
      ciWorkflow,
      /run-name: >-\n  \$\{\{ inputs\.release_head_sha && format\('SDK CI \| trusted release #\{0\} @ \{1\}'/u,
    );
    assert.match(ciWorkflow, /release_pull_request_number:\n[\s\S]*?type: string/u);
    assert.match(ciWorkflow, /release_head_sha:\n[\s\S]*?type: string/u);
    assert.match(ciWorkflow, /^permissions:\n  contents: read$/mu);
    assert.match(
      ciWorkflow,
      /concurrency:\n(?:  #[^\n]*\n)+  group: sdk-ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true/u,
    );
    assert.equal((ciWorkflow.match(/^\s+contents: write$/gmu) ?? []).length, 1);
    assert.match(
      samplePublisher,
      /needs: js-sdk\n    if: github\.ref == 'refs\/heads\/trunk' && github\.event_name == 'push'[\s\S]*permissions:\n      contents: write/u,
    );
    assert.equal((ciWorkflow.match(/name: JS SDK/gmu) ?? []).length, 1);
    assert.equal((ciWorkflow.match(/name: MCP SDK/gmu) ?? []).length, 1);
    assert.equal(
      (ciWorkflow.match(/name: Validate trusted Release Please dispatch/gmu) ?? []).length,
      2,
    );
    const trustedReleaseRelax =
      /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/release-please--branches--trunk' && inputs\.release_head_sha == github\.sha/u;
    assert.match(benchmarkLab, trustedReleaseRelax);
    assert.match(jsSdk, trustedReleaseRelax);
    assert.match(
      jsSdk,
      /HONUA_RELEASE_MATRIX_RECEIPT_RELAX: \$\{\{ inputs\.release_matrix_receipt_relax && '1' \|\| '' \}\}/u,
    );
    for (const job of [jsSdk, mcpSdk]) {
      assert.ok(
        job.indexOf("name: Validate trusted Release Please dispatch") <
          job.indexOf("uses: actions/checkout@"),
      );
      assert.match(
        job,
        /github\.event_name == 'workflow_dispatch' && \(github\.ref == 'refs\/heads\/release-please--branches--trunk' \|\| inputs\.release_pull_request_number != '' \|\| inputs\.release_head_sha != ''\)/u,
      );
      assert.match(job, /working-directory: \.\n        shell: bash/u);
      assert.match(job, /\^\[1-9\]\[0-9\]\*\$/u);
      assert.match(job, /\^\[0-9a-f\]\{40\}\$/u);
      assert.match(job, /refs\/heads\/release-please--branches--trunk/u);
      assert.match(job, /"\$\{GITHUB_SHA\}" != "\$\{RELEASE_HEAD_SHA\}"/u);
      assert.doesNotMatch(job, /^\s+[a-z-]+: write$/mu);
    }
    assert.equal(
      (
        ciWorkflow.match(
          /node --test test\/scripts\/release-please-ci-dispatch\.test\.mjs/gmu,
        ) ?? []
      ).length,
      2,
    );
  });
});
