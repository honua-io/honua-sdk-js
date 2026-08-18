import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  publishReleasePleaseCiChecks,
  REQUIRED_RELEASE_PLEASE_CI_CHECKS,
} from "../../scripts/lib/release-please-ci-checks.mjs";
import {
  CI_WORKFLOW_PATH,
  releasePleaseCiRunTitle,
} from "../../scripts/lib/release-please-ci-dispatch.mjs";
import {
  GITHUB_ACTIONS_APP_ID,
  RELEASE_PLEASE_HEAD,
} from "../../scripts/lib/release-please-disposition-check.mjs";

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

function graphqlMetadata(snapshot = fixture) {
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

function workflowRun(overrides = {}) {
  return {
    id: 9001,
    event: "workflow_dispatch",
    head_branch: RELEASE_PLEASE_HEAD,
    head_sha: fixture.headSha,
    display_title: releasePleaseCiRunTitle(fixture.pullRequestNumber, fixture.headSha),
    path: CI_WORKFLOW_PATH,
    head_repository: { full_name: repository },
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${repository}/actions/runs/9001`,
    ...overrides,
  };
}

function requiredJob(name, id, overrides = {}) {
  return {
    id,
    run_id: 9001,
    run_attempt: 1,
    name,
    head_sha: fixture.headSha,
    workflow_name: releasePleaseCiRunTitle(fixture.pullRequestNumber, fixture.headSha),
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${repository}/actions/runs/9001/job/${id}`,
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/${id}`,
    ...overrides,
  };
}

function harness({
  snapshot = fixture,
  branchHead = snapshot.headSha,
  run = workflowRun(),
  jobs = [requiredJob("JS SDK", 9101), requiredJob("MCP SDK", 9102)],
  createdApp = { id: GITHUB_ACTIONS_APP_ID, slug: "github-actions" },
  createdDetailsUrl = (id) => `https://github.com/${repository}/runs/${id}`,
  rollup = "visible",
} = {}) {
  const calls = [];
  const created = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/pulls")) return [restPull(snapshot)];
    if (pathname.endsWith("/graphql")) {
      const body = JSON.parse(options.body);
      if (!body.query.includes("ReleasePleaseCiCheckRollup")) return graphqlMetadata(snapshot);
      const headRefOid = rollup === "moved" ? "f".repeat(40) : snapshot.headSha;
      const nodes = rollup === "visible"
        ? created.map((check) => ({
            __typename: "CheckRun",
            databaseId: check.id,
            name: check.name,
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: check.details_url,
          }))
        : [];
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid,
              commits: {
                nodes: [{
                  commit: {
                    oid: headRefOid,
                    statusCheckRollup: {
                      contexts: { nodes, pageInfo: { hasNextPage: false } },
                    },
                  },
                }],
              },
            },
          },
        },
      };
    }
    if (pathname.includes("/git/ref/heads/")) {
      return {
        ref: `refs/heads/${RELEASE_PLEASE_HEAD}`,
        object: { type: "commit", sha: branchHead },
      };
    }
    if (pathname.endsWith("/actions/workflows/ci.yml/runs")) return { workflow_runs: [run] };
    if (pathname.endsWith("/actions/runs/9001/jobs")) return { total_count: jobs.length, jobs };
    if (pathname.endsWith("/check-runs") && options.method === "POST") {
      const body = JSON.parse(options.body);
      const id = 9200 + created.length;
      const check = { id, ...body, details_url: createdDetailsUrl(id), app: createdApp };
      created.push(check);
      return check;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, created, request };
}

function publishOptions(overrides = {}) {
  return {
    repository,
    trustedPolicySha: fixture.baseSha,
    associationAttempts: 1,
    associationDelayMs: 0,
    ...overrides,
  };
}

function jobSlice(workflow, jobId) {
  const start = workflow.indexOf(`  ${jobId}:\n`);
  assert.notEqual(start, -1, `missing ${jobId} job`);
  const remainder = workflow.slice(start + 2);
  const next = remainder.search(/\n  [a-z0-9-]+:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 2 + next);
}

describe("trusted Release Please required-check publication", () => {
  it("projects both exact successful jobs into the current PR rollup", async () => {
    const testHarness = harness();
    const result = await publishReleasePleaseCiChecks(
      publishOptions(),
      testHarness.request,
      setTimeout,
    );

    assert.equal(result.status, "published");
    assert.equal(result.headSha, fixture.headSha);
    assert.equal(
      result.workflowRunTitle,
      releasePleaseCiRunTitle(fixture.pullRequestNumber, fixture.headSha),
    );
    assert.equal(result.workflowRunPath, CI_WORKFLOW_PATH);
    assert.deepEqual(result.checks.map(({ name }) => name), REQUIRED_RELEASE_PLEASE_CI_CHECKS);
    assert.equal(testHarness.created.length, 2);
    for (const [index, check] of testHarness.created.entries()) {
      const expectedName = REQUIRED_RELEASE_PLEASE_CI_CHECKS[index];
      assert.equal(check.name, expectedName);
      assert.equal(check.head_sha, fixture.headSha);
      assert.equal(check.conclusion, "success");
      assert.equal(check.external_id, `release-please-ci:9001:${9101 + index}`);
      assert.match(check.output.summary, new RegExp(`Canonical job: ${expectedName}`, "u"));
      assert.match(
        check.output.summary,
        new RegExp(`actions/runs/9001/job/${9101 + index}`, "u"),
      );
      assert.match(check.output.summary, new RegExp(fixture.baseSha, "u"));
      assert.equal(result.checks[index].detailsUrl, `https://github.com/${repository}/runs/${9200 + index}`);
    }
  });

  it("fails closed for stale base, branch, or canonical workflow identity", async () => {
    const staleBase = harness({ snapshot: { ...fixture, baseSha: "f".repeat(40) } });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), staleBase.request),
      /base does not match the trusted trunk policy revision/u,
    );
    assert.equal(staleBase.created.length, 0);

    const staleBranch = harness({ branchHead: "f".repeat(40) });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), staleBranch.request),
      /branch no longer resolves to the validated head/u,
    );
    assert.equal(staleBranch.created.length, 0);

    const wrongWorkflow = harness({ run: workflowRun({ path: ".github/workflows/lookalike.yml" }) });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), wrongWorkflow.request),
      /No canonical CI run resolved/u,
    );
    assert.equal(wrongWorkflow.created.length, 0);

    const wrongOrigin = harness({
      run: workflowRun({ head_repository: { full_name: "attacker/honua-sdk-js" } }),
    });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), wrongOrigin.request),
      /No canonical CI run resolved/u,
    );
    assert.equal(wrongOrigin.created.length, 0);

    const wrongHead = harness({ run: workflowRun({ head_sha: "f".repeat(40) }) });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), wrongHead.request),
      /No canonical CI run resolved/u,
    );
    assert.equal(wrongHead.created.length, 0);
  });

  it("rejects jobs outside the exact dynamic canonical run title or head", async () => {
    const wrongWorkflowName = harness({
      jobs: [
        requiredJob("JS SDK", 9101, { workflow_name: "SDK CI" }),
        requiredJob("MCP SDK", 9102),
      ],
    });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), wrongWorkflowName.request),
      /terminal success for the exact canonical CI run and head/u,
    );
    assert.equal(wrongWorkflowName.created.length, 0);

    const wrongHead = harness({
      jobs: [requiredJob("JS SDK", 9101), requiredJob("MCP SDK", 9102, { head_sha: "f".repeat(40) })],
    });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), wrongHead.request),
      /terminal success for the exact canonical CI run and head/u,
    );
    assert.equal(wrongHead.created.length, 0);
  });

  it("rejects missing, duplicate, skipped, and failed required jobs", async () => {
    const cases = [
      ["missing", [requiredJob("JS SDK", 9101)]],
      ["duplicate", [requiredJob("JS SDK", 9101), requiredJob("MCP SDK", 9102), requiredJob("MCP SDK", 9103)]],
      ["skipped", [requiredJob("JS SDK", 9101), requiredJob("MCP SDK", 9102, { conclusion: "skipped" })]],
      ["failed", [requiredJob("JS SDK", 9101, { conclusion: "failure" }), requiredJob("MCP SDK", 9102)]],
    ];
    for (const [label, jobs] of cases) {
      const testHarness = harness({ jobs });
      await assert.rejects(
        publishReleasePleaseCiChecks(publishOptions(), testHarness.request),
        /exactly one MCP SDK job|terminal success/u,
        label,
      );
      assert.equal(testHarness.created.length, 0, label);
    }
  });

  it("rejects checks not owned by GitHub Actions", async () => {
    const testHarness = harness({ createdApp: { id: 1, slug: "untrusted-app" } });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), testHarness.request),
      /trusted provenance/u,
    );
  });

  it("rejects returned created-check URLs for the wrong repository or check id", async () => {
    const cases = [
      ["wrong repository", (id) => `https://github.com/attacker/honua-sdk-js/runs/${id}`],
      ["wrong check id", (id) => `https://github.com/${repository}/runs/${id + 1}`],
    ];
    for (const [label, createdDetailsUrl] of cases) {
      const testHarness = harness({ createdDetailsUrl });
      await assert.rejects(
        publishReleasePleaseCiChecks(publishOptions(), testHarness.request),
        /created source-bound check 9200 with an invalid URL/u,
        label,
      );
      assert.equal(testHarness.created.length, 1, label);
    }
  });

  it("fails when GitHub omits the created checks from the PR rollup", async () => {
    const testHarness = harness({ rollup: "missing" });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), testHarness.request),
      /did not associate the exact JS SDK and MCP SDK checks/u,
    );
    assert.equal(testHarness.created.length, 2);
  });

  it("fails when the PR head moves before rollup association", async () => {
    const testHarness = harness({ rollup: "moved" });
    await assert.rejects(
      publishReleasePleaseCiChecks(publishOptions(), testHarness.request),
      /head changed before required checks entered its rollup/u,
    );
  });
});

describe("Release Please check-writer workflow policy", () => {
  it("separates read-only Actions provenance from source-bound check publication", () => {
    const release = fs
      .readFileSync(path.join(root, ".github/workflows/release-please.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8").replaceAll("\r\n", "\n");
    const disposition = jobSlice(release, "release-please-disposition");

    assert.match(
      disposition,
      /needs: \[release-please, release-please-refresh, release-please-lockfile-pin, release-please-ci\]/u,
    );
    assert.match(disposition, /needs\.release-please-ci\.result == 'success'/u);
    assert.match(
      disposition,
      /permissions:\n      actions: read\n      checks: write\n      contents: read\n      issues: read\n      pull-requests: read/u,
    );
    assert.doesNotMatch(disposition, /actions: write|contents: write|pull-requests: write/u);
    assert.match(disposition, /persist-credentials: false/u);
    assert.match(disposition, /node scripts\/publish-release-please-ci-checks\.mjs/u);
    assert.ok(
      disposition.indexOf("node scripts/publish-release-please-ci-checks.mjs") <
        disposition.indexOf("node scripts/check-release-please-disposition.mjs"),
    );
    assert.equal(
      (ci.match(/name: Test Release Please CI check publication policy/gmu) ?? []).length,
      2,
    );
  });
});
