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

const repository = "honua-io/honua-sdk-js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "scripts/check-pr-issue-disposition.mjs");

function graphqlPayload({
  body = "Refs #550 (S2; S3 remains)",
  closingIssueNumbers = [],
  updatedAt = "2026-07-14T22:00:00Z",
} = {}) {
  return {
    data: {
      repository: {
        nameWithOwner: repository,
        pullRequest: {
          number: 595,
          body,
          title: "docs(samples): project gallery metadata",
          state: "OPEN",
          updatedAt,
          headRefName: "codex/issue-550-gallery-s2",
          headRefOid: "a".repeat(40),
          baseRefName: "trunk",
          author: { __typename: "User", login: "mikemcdougall" },
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
    assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
    assert.match(workflow, /path: trusted-policy/u);
    assert.match(workflow, /persist-credentials: false/u);
    assert.match(workflow, /working-directory: trusted-policy/u);
    assert.match(workflow, /name: PR Issue Disposition/u);
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

  it("exempts only tightly identified Dependabot and Release Please branches", () => {
    assert.equal(
      automationExemption({
        authorLogin: "dependabot[bot]",
        authorType: "Bot",
        headRefName: "dependabot/npm_and_yarn/vite-8.1.4",
        title: "chore(deps): bump vite",
      }),
      "Dependabot dependency update",
    );
    assert.equal(
      automationExemption({
        authorLogin: "github-actions[bot]",
        authorType: "Bot",
        headRefName: "release-please--branches--trunk",
        title: "chore: release trunk",
      }),
      "Release Please automation",
    );
    assert.equal(
      automationExemption({
        authorLogin: "github-actions[bot]",
        authorType: "Bot",
        headRefName: "feature/not-release-please",
        title: "chore: release trunk",
      }),
      null,
    );
    assert.equal(
      automationExemption({
        authorLogin: "github-actions",
        authorType: "User",
        headRefName: "release-please--branches--trunk",
        title: "chore: release trunk",
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
