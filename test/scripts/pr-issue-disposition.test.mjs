import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadCurrentPullRequestDisposition } from "../../scripts/lib/github-pr-issue-disposition.mjs";
import {
  PullRequestDispositionError,
  automationExemption,
  parsePullRequestDisposition,
  validatePullRequestDisposition,
} from "../../scripts/lib/pr-issue-disposition.mjs";
import {
  GITHUB_ACTIONS_APP_ID,
  publishReleasePleaseDispositionCheck,
  RELEASE_PLEASE_EXEMPTION,
  REQUIRED_DISPOSITION_CHECK,
} from "../../scripts/lib/release-please-disposition-check.mjs";

const repository = "honua-io/honua-sdk-js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "scripts/check-pr-issue-disposition.mjs");
const releasePleaseFixture = JSON.parse(
  fs.readFileSync(
    path.join(root, "test/fixtures/pr-issue-disposition/release-please-pr-382.json"),
    "utf8",
  ),
);

function graphqlPayload({
  body = "Refs #550 (S2; S3 remains)",
  closingIssueNumbers = [],
  updatedAt = "2026-07-14T22:00:00Z",
  number = 595,
  title = "docs(samples): project gallery metadata",
  headRefName = "codex/issue-550-gallery-s2",
  headSha = "a".repeat(40),
  headRepository = repository,
  baseRefName = "trunk",
  baseSha = "b".repeat(40),
  baseRepository = repository,
  authorLogin = "mikemcdougall",
  authorType = "User",
} = {}) {
  return {
    data: {
      repository: {
        nameWithOwner: repository,
        pullRequest: {
          number,
          body,
          title,
          state: "OPEN",
          updatedAt,
          headRefName,
          headRefOid: headSha,
          headRepository: headRepository ? { nameWithOwner: headRepository } : null,
          baseRefName,
          baseRefOid: baseSha,
          baseRepository: baseRepository ? { nameWithOwner: baseRepository } : null,
          author: { __typename: authorType, login: authorLogin },
          closingIssuesReferences: {
            nodes: closingIssueNumbers.map((number) => ({
              number,
              repository: { nameWithOwner: repository },
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  };
}

function issue(number, overrides = {}) {
  return { number, repository, state: "open", isPullRequest: false, ...overrides };
}

function releasePleaseRestPull(overrides = {}) {
  return {
    number: releasePleaseFixture.pullRequestNumber,
    body: releasePleaseFixture.body,
    title: releasePleaseFixture.title,
    state: "open",
    updated_at: releasePleaseFixture.updatedAt,
    user: { login: "github-actions[bot]", type: "Bot" },
    head: {
      ref: releasePleaseFixture.headRefName,
      sha: releasePleaseFixture.headSha,
      repo: { full_name: releasePleaseFixture.headRepository },
    },
    base: {
      ref: releasePleaseFixture.baseRefName,
      sha: releasePleaseFixture.baseSha,
      repo: { full_name: releasePleaseFixture.baseRepository },
    },
    ...overrides,
  };
}

function releasePleaseGraphqlPayload(overrides = {}) {
  return graphqlPayload({
    body: releasePleaseFixture.body,
    number: releasePleaseFixture.pullRequestNumber,
    title: releasePleaseFixture.title,
    updatedAt: releasePleaseFixture.updatedAt,
    headRefName: releasePleaseFixture.headRefName,
    headSha: releasePleaseFixture.headSha,
    headRepository: releasePleaseFixture.headRepository,
    baseRefName: releasePleaseFixture.baseRefName,
    baseSha: releasePleaseFixture.baseSha,
    baseRepository: releasePleaseFixture.baseRepository,
    authorLogin: releasePleaseFixture.authorLogin,
    authorType: releasePleaseFixture.authorType,
    ...overrides,
  });
}

function validate(overrides = {}) {
  return validatePullRequestDisposition({
    repository,
    body: "## Summary\n\nA bounded change.\n\nCloses #594",
    authorLogin: "mikemcdougall",
    headRefName: "codex/issue-594-pr-disposition",
    title: "ci: enforce issue disposition",
    issues: [issue(594)],
    closingIssueNumbers: [594],
    ...overrides,
  });
}

function expectFailure(code, action) {
  assert.throws(action, (error) => error instanceof PullRequestDispositionError && error.code === code);
}

describe("pull request issue disposition policy", () => {
  it("keeps the required workflow pinned, least-privilege, and bound to trusted base code", () => {
    const workflow = fs.readFileSync(
      path.join(root, ".github/workflows/pr-issue-disposition.yml"),
      "utf8",
    );
    assert.match(workflow, /^  pull_request:\n/mu);
    assert.doesNotMatch(workflow, /pull_request_target/u);
    assert.match(workflow, /^  contents: read\n  issues: read\n  pull-requests: read$/mu);
    assert.doesNotMatch(workflow, /(?:write|secrets:)/u);
    assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/u);
    assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/u);
    assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/u);
    assert.doesNotMatch(workflow, /pull_request\.base\.sha/u);
    assert.match(workflow, /path: trusted-policy/u);
    assert.match(workflow, /persist-credentials: false/u);
    assert.match(workflow, /working-directory: trusted-policy/u);
    assert.match(workflow, /name: PR Issue Disposition/u);
  });

  it("emits Release Please checks only from pinned code on a trusted trunk push", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/release-please.yml"), "utf8");
    assert.match(workflow, /^  push:\n    branches:\n      - trunk$/mu);
    assert.doesNotMatch(workflow, /pull_request(?:_target)?:/u);
    assert.match(workflow, /^  checks: write$/mu);
    assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/u);
    assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/u);
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
    assert.match(workflow, /path: trusted-policy/u);
    assert.match(workflow, /persist-credentials: false/u);
    assert.match(workflow, /working-directory: trusted-policy/u);
    assert.match(workflow, /TRUSTED_POLICY_SHA: \$\{\{ github\.sha \}\}/u);
    assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\{TRUSTED_POLICY_SHA\}"/u);
    assert.match(workflow, /node scripts\/check-release-please-disposition\.mjs/u);
    assert.doesNotMatch(workflow, /pull_request\.head|\/approve|approveWorkflow|gh api .*approve/u);
  });

  it("accepts exact completion and partial-slice footer blocks", () => {
    assert.deepEqual(validate(), { status: "valid", exemption: null, closes: [594], refs: [] });
    assert.deepEqual(
      validate({
        body: "## Summary\n\nGallery metadata.\n\nRefs #550 (S2; S3 visual evidence remains)",
        issues: [issue(550)],
        closingIssueNumbers: [],
      }),
      { status: "valid", exemption: null, closes: [], refs: [550] },
    );
    assert.deepEqual(
      validate({
        body:
          "Completes one prerequisite and advances an epic.\n\nCloses #591\n" +
          "Refs #384 (partial workstream; later slices remain)",
        issues: [issue(384), issue(591)],
        closingIssueNumbers: [591],
      }),
      { status: "valid", exemption: null, closes: [591], refs: [384] },
    );
  });

  it("keeps the pull request template compatible with the exact footer parser", () => {
    const template = fs
      .readFileSync(path.join(root, ".github/pull_request_template.md"), "utf8")
      .replace("Closes #000", "Closes #594");
    assert.deepEqual(validate({ body: template }), {
      status: "valid",
      exemption: null,
      closes: [594],
      refs: [],
    });
  });

  it("requires the exact footer as the final nonblank block", () => {
    expectFailure("missing-footer", () => validate({ body: "No disposition" }));
    expectFailure("missing-footer", () => validate({ body: "Closes #594\n\nTrailing prose" }));
    expectFailure("missing-footer", () => validate({ body: "Fixes #594" }));
    expectFailure("missing-footer", () => validate({ body: "Refs honua-io/honua-site#120" }));
    expectFailure("invalid-reference-explanation", () => validate({ body: "Refs #550 (gallery)" }));
    expectFailure("invalid-reference-explanation", () => validate({ body: "Refs #550 ( S2 remains)" }));
    for (const malformed of [
      "Refs #550",
      "Refs #550 (S2; S3 remains)   ",
      "Refs #550 (S2; S3 remains) extra",
    ]) {
      expectFailure("misplaced-reference", () => validate({ body: `${malformed}\nCloses #594` }));
    }
  });

  it("rejects dangerous closing keywords outside the exact footer", () => {
    for (const prose of ["does not close #520", "Do not fix #520", "will not resolve: #520", "Fixes #520"]) {
      expectFailure("ambiguous-closing-keyword", () =>
        validate({ body: `${prose}\n\nRefs #550 (S2; S3 remains)` }),
      );
    }
    expectFailure("ambiguous-closing-keyword", () =>
      validate({ body: "Refs #550 (S2; does not close #520 and S3 remains)" }),
    );
    expectFailure("nested-reference", () =>
      validate({ body: "Refs #550 (S2; Refs #520 remains)" }),
    );
  });

  it("rejects duplicate and excessive dispositions", () => {
    expectFailure("duplicate-disposition", () =>
      parsePullRequestDisposition("Closes #594\nRefs #594 (S1; S2 remains)"),
    );
    const excessive = Array.from({ length: 21 }, (_, index) => `Closes #${index + 1}`).join("\n");
    expectFailure("too-many-dispositions", () => parsePullRequestDisposition(excessive));
  });

  it("requires same-repository open issues rather than pull requests", () => {
    expectFailure("missing-referenced-issue", () => validate({ issues: [] }));
    expectFailure("closed-issue-target", () => validate({ issues: [issue(594, { state: "closed" })] }));
    expectFailure("pull-request-target", () => validate({ issues: [issue(594, { isPullRequest: true })] }));
    expectFailure("cross-repository-issue", () =>
      validate({ issues: [issue(594, { repository: "honua-io/honua-site" })] }),
    );
  });

  it("requires exact agreement with GitHub closingIssuesReferences", () => {
    expectFailure("github-closing-mismatch", () => validate({ closingIssueNumbers: [] }));
    expectFailure("github-closing-mismatch", () => validate({ closingIssueNumbers: [594, 520] }));
    expectFailure("reference-would-close", () =>
      validate({
        body: "Refs #550 (S2; S3 remains)",
        issues: [issue(550)],
        closingIssueNumbers: [550],
      }),
    );
  });

  it("exempts the held #382 metadata only as the complete Release Please identity tuple", () => {
    assert.equal(
      automationExemption({
        authorLogin: "dependabot[bot]",
        authorType: "Bot",
        headRefName: "dependabot/npm_and_yarn/vite-8.1.4",
        title: "chore(deps): bump vite",
      }),
      "Dependabot dependency update",
    );
    assert.equal(automationExemption(releasePleaseFixture), RELEASE_PLEASE_EXEMPTION);

    const lookalikes = [
      { authorLogin: "octocat[bot]" },
      { authorType: "User" },
      { headRefName: "feature/arbitrary-github-actions-branch" },
      { headRefName: "release-please--branches--preview" },
      { title: "chore: release preview" },
      { title: "chore: release trunk (lookalike)" },
      { baseRefName: "preview" },
      { baseSha: "not-a-commit" },
      { headSha: "not-a-commit" },
      { headRepository: "mallory/honua-sdk-js" },
      { baseRepository: "mallory/honua-sdk-js" },
      { repository: "mallory/honua-sdk-js" },
    ];
    for (const override of lookalikes) {
      assert.equal(
        automationExemption({ ...releasePleaseFixture, ...override }),
        null,
        `unexpected exemption for ${JSON.stringify(override)}`,
      );
    }

    assert.equal(
      automationExemption({
        ...releasePleaseFixture,
        authorLogin: "github-actions[bot]",
        headRefName: "feature/arbitrary-github-actions-branch",
        title: "chore: release trunk",
      }),
      null,
    );
    assert.equal(
      automationExemption({
        ...releasePleaseFixture,
        authorLogin: "github-actions[bot]",
        headRepository: "fork-owner/honua-sdk-js",
      }),
      null,
    );
    assert.equal(
      automationExemption({
        authorLogin: "mallory[bot]",
        authorType: "Bot",
        headRefName: "dependabot/npm_and_yarn/vite",
        title: "chore(deps): bump vite",
      }),
      null,
    );
  });

  it("returns an explicit exemption without issue metadata", () => {
    assert.deepEqual(
      validatePullRequestDisposition({
        repository,
        body: "",
        authorLogin: "app/dependabot",
        authorType: "Bot",
        headRefName: "dependabot/github_actions/actions/checkout-7",
        title: "chore(deps): bump actions/checkout",
        issues: [],
        closingIssueNumbers: [],
      }),
      { status: "exempt", exemption: "Dependabot dependency update", closes: [], refs: [] },
    );
  });
});

describe("trusted Release Please disposition publication", () => {
  it("re-reads current REST and GraphQL metadata before creating the exact source-bound check", async () => {
    const requests = [];
    const request = async (url, options = {}) => {
      requests.push({ url, options });
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/pulls")) return [releasePleaseRestPull()];
      if (pathname.endsWith("/graphql")) return releasePleaseGraphqlPayload();
      if (pathname.endsWith("/check-runs")) {
        const body = JSON.parse(options.body);
        return {
          id: 987654,
          name: body.name,
          head_sha: body.head_sha,
          status: body.status,
          conclusion: body.conclusion,
          app: { id: GITHUB_ACTIONS_APP_ID, slug: "github-actions" },
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const trustedPolicySha = releasePleaseFixture.baseSha;

    const result = await publishReleasePleaseDispositionCheck(
      {
        repository,
        trustedPolicySha,
        detailsUrl: "https://github.com/honua-io/honua-sdk-js/actions/runs/1234",
      },
      request,
    );

    assert.deepEqual(result, {
      status: "published",
      exemption: RELEASE_PLEASE_EXEMPTION,
      repository,
      pullRequestNumber: 382,
      headSha: releasePleaseFixture.headSha,
      trustedPolicySha,
      checkRunId: 987654,
    });
    assert.equal(requests.filter(({ url }) => new URL(url).pathname.endsWith("/graphql")).length, 2);
    const discovery = requests.find(({ url }) => new URL(url).pathname.endsWith("/pulls"));
    assert.equal(new URL(discovery.url).searchParams.get("head"), "honua-io:release-please--branches--trunk");
    assert.equal(new URL(discovery.url).searchParams.get("base"), "trunk");

    const creation = requests.find(({ url }) => new URL(url).pathname.endsWith("/check-runs"));
    assert.equal(creation.options.method, "POST");
    const body = JSON.parse(creation.options.body);
    assert.equal(body.name, REQUIRED_DISPOSITION_CHECK);
    assert.equal(body.head_sha, releasePleaseFixture.headSha);
    assert.equal(body.conclusion, "success");
    assert.equal(body.output.title, RELEASE_PLEASE_EXEMPTION);
    assert.match(body.output.summary, /Release Please automation/u);
    assert.match(body.output.summary, new RegExp(trustedPolicySha, "u"));
    assert.equal(body.details_url, "https://github.com/honua-io/honua-sdk-js/actions/runs/1234");
  });

  it("does nothing when the trusted release workflow has no open release PR", async () => {
    const requests = [];
    const result = await publishReleasePleaseDispositionCheck(
      { repository, trustedPolicySha: "d".repeat(40) },
      async (url) => {
        requests.push(url);
        return [];
      },
    );
    assert.deepEqual(result, { status: "not-found", trustedPolicySha: "d".repeat(40) });
    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/pulls\?/u);
  });

  it("fails closed for arbitrary GitHub Actions metadata, Dependabot, and fork-origin heads", async () => {
    const hostileCandidates = [
      releasePleaseRestPull({ title: "chore: release attacker-title" }),
      releasePleaseRestPull({
        head: {
          ...releasePleaseRestPull().head,
          ref: "release-please--branches--attacker",
        },
      }),
      releasePleaseRestPull({
        head: {
          ...releasePleaseRestPull().head,
          repo: { full_name: "attacker/honua-sdk-js" },
        },
      }),
      releasePleaseRestPull({
        title: "chore(deps): bump vite",
        user: { login: "dependabot[bot]", type: "Bot" },
        head: {
          ...releasePleaseRestPull().head,
          ref: "dependabot/npm_and_yarn/vite-9",
        },
      }),
    ];

    for (const candidate of hostileCandidates) {
      let calls = 0;
      await assert.rejects(
        publishReleasePleaseDispositionCheck(
          { repository, trustedPolicySha: "e".repeat(40) },
          async () => {
            calls += 1;
            return [candidate];
          },
        ),
        /did not match the exact Release Please automation policy/u,
      );
      assert.equal(calls, 1);
    }
  });

  it("does not publish when REST and stable GraphQL metadata disagree", async () => {
    const requests = [];
    await assert.rejects(
      publishReleasePleaseDispositionCheck(
        { repository, trustedPolicySha: "f".repeat(40) },
        async (url) => {
          requests.push(url);
          const pathname = new URL(url).pathname;
          if (pathname.endsWith("/pulls")) return [releasePleaseRestPull()];
          if (pathname.endsWith("/graphql")) {
            return releasePleaseGraphqlPayload({ headSha: "1".repeat(40) });
          }
          throw new Error("A check run must not be created for mismatched metadata.");
        },
      ),
      /headSha changed between REST and GraphQL/u,
    );
    assert.equal(requests.filter((url) => new URL(url).pathname.endsWith("/check-runs")).length, 0);
  });

  it("binds the validated PR base to the exact trusted trunk policy revision", async () => {
    const requests = [];
    await assert.rejects(
      publishReleasePleaseDispositionCheck(
        { repository, trustedPolicySha: "f".repeat(40) },
        async (url) => {
          requests.push(url);
          const pathname = new URL(url).pathname;
          if (pathname.endsWith("/pulls")) return [releasePleaseRestPull()];
          if (pathname.endsWith("/graphql")) return releasePleaseGraphqlPayload();
          throw new Error("A check run must not be created for a stale trusted base.");
        },
      ),
      /base does not match the trusted trunk policy revision/u,
    );
    assert.equal(requests.filter((url) => new URL(url).pathname.endsWith("/check-runs")).length, 0);
  });

  it("verifies that GitHub attached the check to the GitHub Actions integration", async () => {
    await assert.rejects(
      publishReleasePleaseDispositionCheck(
        { repository, trustedPolicySha: releasePleaseFixture.baseSha },
        async (url, options = {}) => {
          const pathname = new URL(url).pathname;
          if (pathname.endsWith("/pulls")) return [releasePleaseRestPull()];
          if (pathname.endsWith("/graphql")) return releasePleaseGraphqlPayload();
          const body = JSON.parse(options.body);
          return {
            id: 42,
            name: body.name,
            head_sha: body.head_sha,
            status: body.status,
            conclusion: body.conclusion,
            app: { id: 1, slug: "untrusted-app" },
          };
        },
      ),
      /source-bound GitHub Actions disposition check/u,
    );
  });
});

describe("pull request issue disposition CLI", () => {
  it("loads current GraphQL and REST metadata and fails a reordered snapshot closed", async () => {
    const livePayload = graphqlPayload();
    const requests = [];
    const request = async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/graphql")) return livePayload;
      if (url.endsWith("/issues/550")) {
        return {
          number: 550,
          state: "open",
          repository_url: "https://api.github.com/repos/honua-io/honua-sdk-js",
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const current = await loadCurrentPullRequestDisposition(
      { repository, pullRequestNumber: 595 },
      request,
    );
    assert.equal(current.body, "Refs #550 (S2; S3 remains)");
    assert.deepEqual(current.closingIssueNumbers, []);
    assert.deepEqual(current.issues, [issue(550)]);
    assert.equal(requests.filter(({ url }) => url.endsWith("/graphql")).length, 2);
    assert.equal(requests.filter(({ url }) => url.endsWith("/issues/550")).length, 1);

    let graphqlCalls = 0;
    const reorderedRequest = async (url) => {
      if (url.endsWith("/issues/550")) {
        return {
          number: 550,
          state: "open",
          repository_url: "https://api.github.com/repos/honua-io/honua-sdk-js",
        };
      }
      graphqlCalls += 1;
      return graphqlCalls === 1
        ? livePayload
        : graphqlPayload({ body: "Footer removed", updatedAt: "2026-07-14T22:01:00Z" });
    };
    await assert.rejects(
      loadCurrentPullRequestDisposition({ repository, pullRequestNumber: 595 }, reorderedRequest),
      /changed during validation/u,
    );

    const incompletePayload = graphqlPayload();
    delete incompletePayload.data.repository.pullRequest.closingIssuesReferences.nodes;
    await assert.rejects(
      loadCurrentPullRequestDisposition(
        { repository, pullRequestNumber: 595 },
        async () => incompletePayload,
      ),
      /closingIssuesReferences metadata is missing/u,
    );
  });

  it("validates offline event metadata and fails closed on ambiguous prose", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-pr-disposition-"));
    try {
      const eventPath = path.join(temporaryRoot, "event.json");
      const metadataPath = path.join(temporaryRoot, "metadata.json");
      const event = {
        repository: { full_name: repository },
        pull_request: {
          number: 595,
          title: "ci: enforce issue disposition",
          body: "A bounded change.\n\nCloses #594",
          user: { login: "mikemcdougall" },
          head: { ref: "codex/issue-594-pr-disposition", sha: "a".repeat(40) },
        },
      };
      fs.writeFileSync(eventPath, JSON.stringify(event));
      fs.writeFileSync(
        metadataPath,
        JSON.stringify({ issues: [issue(594)], closingIssueNumbers: [594] }),
      );

      const valid = spawnSync(process.execPath, [cli, "--event", eventPath, "--metadata", metadataPath], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /Validated honua-io\/honua-sdk-js#595/u);
      assert.match(valid.stdout, /Closes: #594/u);

      event.pull_request.body = "This does not close #520.\n\nRefs #550 (S2; S3 remains)";
      fs.writeFileSync(eventPath, JSON.stringify(event));
      fs.writeFileSync(
        metadataPath,
        JSON.stringify({ issues: [issue(550)], closingIssueNumbers: [520] }),
      );
      const invalid = spawnSync(process.execPath, [cli, "--event", eventPath, "--metadata", metadataPath], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /ambiguous|Closing keyword/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("exempts only an allowlisted automation identity without API access", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-pr-disposition-bot-"));
    try {
      const eventPath = path.join(temporaryRoot, "event.json");
      const metadataPath = path.join(temporaryRoot, "metadata.json");
      fs.writeFileSync(
        eventPath,
        JSON.stringify({
          repository: { full_name: repository },
          pull_request: {
            number: 600,
            title: "chore(deps): bump vite",
            body: "",
            user: { login: "dependabot[bot]", type: "Bot" },
            head: { ref: "dependabot/npm_and_yarn/vite-8.1.4", sha: "b".repeat(40) },
          },
        }),
      );
      fs.writeFileSync(metadataPath, JSON.stringify({ issues: [], closingIssueNumbers: [] }));
      const result = spawnSync(process.execPath, [
        cli,
        "--event",
        eventPath,
        "--metadata",
        metadataPath,
      ], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Exempt: Dependabot dependency update/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
