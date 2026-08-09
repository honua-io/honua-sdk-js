import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { refreshReleasePleaseBase } from "../../scripts/lib/release-please-base-refresh.mjs";
import { RELEASE_PLEASE_HEAD } from "../../scripts/lib/release-please-disposition-check.mjs";

const repository = "honua-io/honua-sdk-js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "test/fixtures/pr-issue-disposition/release-please-pr-382.json"), "utf8"),
);
const trustedPolicySha = "d".repeat(40);
const refreshedHeadSha = "e".repeat(40);

function restPull(snapshot) {
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
          author: { __typename: snapshot.authorType, login: snapshot.authorLogin },
          closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    },
  };
}

function harness(options = {}) {
  const stale = { ...fixture, ...(options.snapshot ?? {}) };
  const refreshed = {
    ...stale,
    baseSha: trustedPolicySha,
    headSha: refreshedHeadSha,
    updatedAt: "2026-08-09T04:10:00Z",
  };
  const calls = [];
  let updateAccepted = false;
  const request = async (url, requestOptions = {}) => {
    calls.push({ url, options: requestOptions });
    const pathname = new URL(url).pathname;
    const current = updateAccepted && options.confirmRefresh !== false ? refreshed : stale;
    if (pathname.endsWith("/pulls")) return options.noPullRequest ? [] : [restPull(current)];
    if (pathname.endsWith("/graphql")) return graphqlPayload(current);
    if (pathname.endsWith("/git/ref/heads/trunk")) {
      return {
        ref: "refs/heads/trunk",
        object: { type: "commit", sha: options.trunkHead ?? trustedPolicySha },
      };
    }
    if (pathname.endsWith(`/git/ref/heads/${RELEASE_PLEASE_HEAD}`)) {
      return {
        ref: `refs/heads/${RELEASE_PLEASE_HEAD}`,
        object: {
          type: "commit",
          sha: options.releaseBranchHead ?? current.headSha,
        },
      };
    }
    if (pathname.includes("/compare/")) {
      return options.comparison ?? {
        status: "ahead",
        ahead_by: 2,
        behind_by: 0,
        base_commit: { sha: stale.baseSha },
        merge_base_commit: { sha: stale.baseSha },
        commits: [{ sha: "c".repeat(40) }, { sha: trustedPolicySha }],
      };
    }
    if (pathname.endsWith(`/pulls/${stale.pullRequestNumber}/update-branch`)) {
      if (options.writeError) throw new Error("simulated update failure");
      updateAccepted = true;
      return options.updateResponse ?? {
        message: "Updating pull request branch.",
        url: `https://api.github.com/repos/${repository}/pulls/${stale.pullRequestNumber}`,
      };
    }
    if (pathname.endsWith(`/git/commits/${refreshedHeadSha}`)) {
      return options.refreshCommit ?? {
        sha: refreshedHeadSha,
        parents: [{ sha: stale.headSha }, { sha: trustedPolicySha }],
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, request, stale, refreshed };
}

describe("trusted Release Please base refresh", () => {
  it("refreshes only an unchanged exact bot PR from an ancestor base", async () => {
    const testHarness = harness();
    const result = await refreshReleasePleaseBase(
      {
        repository,
        trustedPolicySha,
        releasePleaseReportedUpdate: false,
        confirmationAttempts: 1,
        confirmationDelayMs: 0,
      },
      testHarness.request,
    );
    assert.equal(result.status, "refreshed");
    assert.equal(result.previousHeadSha, fixture.headSha);
    assert.equal(result.headSha, refreshedHeadSha);
    const update = testHarness.calls.find(({ url }) => new URL(url).pathname.endsWith("/update-branch"));
    assert.equal(update.options.method, "PUT");
    assert.deepEqual(JSON.parse(update.options.body), { expected_head_sha: fixture.headSha });
  });

  it("does not write when no release PR exists or the exact PR is already current", async () => {
    const absent = harness({ noPullRequest: true });
    assert.equal(
      (
        await refreshReleasePleaseBase(
          { repository, trustedPolicySha, releasePleaseReportedUpdate: false },
          absent.request,
        )
      ).status,
      "not-found",
    );
    assert.equal(absent.calls.some(({ url }) => new URL(url).pathname.endsWith("/update-branch")), false);

    const current = harness({ snapshot: { baseSha: trustedPolicySha } });
    assert.equal(
      (
        await refreshReleasePleaseBase(
          { repository, trustedPolicySha, releasePleaseReportedUpdate: false },
          current.request,
        )
      ).status,
      "already-current",
    );
    assert.equal(current.calls.some(({ url }) => new URL(url).pathname.endsWith("/update-branch")), false);
  });

  it("fails closed when Release Please claimed an update but its base stayed stale", async () => {
    const testHarness = harness();
    await assert.rejects(
      refreshReleasePleaseBase(
        { repository, trustedPolicySha, releasePleaseReportedUpdate: true },
        testHarness.request,
      ),
      /reported an update but left its pull request on a stale trusted base/u,
    );
    assert.equal(testHarness.calls.some(({ url }) => new URL(url).pathname.endsWith("/update-branch")), false);
  });

  it("rejects moved refs, divergent ancestry, update failure, and malformed refresh commits", async () => {
    const cases = [
      [harness({ snapshot: { headRepository: "attacker/honua-sdk-js" } }), /exact Release Please automation policy/u],
      [harness({ snapshot: { baseRefName: "attacker-base" } }), /exact Release Please automation policy/u],
      [harness({ trunkHead: "f".repeat(40) }), /trusted trunk branch moved/u],
      [harness({ releaseBranchHead: "f".repeat(40) }), /branch does not match the validated pull-request head/u],
      [harness({ comparison: { status: "diverged" } }), /not a strict ancestor/u],
      [harness({ writeError: true }), /simulated update failure/u],
      [
        harness({
          updateResponse: {
            message: "not accepted",
            url: `https://api.github.com/repos/${repository}/pulls/${fixture.pullRequestNumber}`,
          },
        }),
        /did not accept/u,
      ],
      [
        harness({
          updateResponse: {
            message: "Updating pull request branch.",
            url: `https://github.com/repos/${repository}/pulls/${fixture.pullRequestNumber}`,
          },
        }),
        /did not accept/u,
      ],
      [harness({ refreshCommit: { sha: refreshedHeadSha, parents: [{ sha: fixture.headSha }] } }), /two-parent/u],
    ];
    for (const [testHarness, expected] of cases) {
      await assert.rejects(
        refreshReleasePleaseBase(
          {
            repository,
            trustedPolicySha,
            releasePleaseReportedUpdate: false,
            confirmationAttempts: 1,
            confirmationDelayMs: 0,
          },
          testHarness.request,
        ),
        expected,
      );
    }
  });

  it("fails when an accepted update never becomes the exact current PR", async () => {
    const testHarness = harness({ confirmRefresh: false });
    await assert.rejects(
      refreshReleasePleaseBase(
        {
          repository,
          trustedPolicySha,
          releasePleaseReportedUpdate: false,
          confirmationAttempts: 1,
          confirmationDelayMs: 0,
        },
        testHarness.request,
      ),
      /was not confirmed/u,
    );
  });
});
