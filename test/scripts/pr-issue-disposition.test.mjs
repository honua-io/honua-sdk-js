import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadCurrentPullRequestDisposition } from "../../scripts/lib/github-pr-issue-disposition.mjs";
import {
  DERIVED_ARTIFACT_EXEMPTION,
  KEPLER_AUDIT_RENEWAL_EXEMPTION,
  MCP_CERTIFICATION_EXEMPTION,
  PullRequestDispositionError,
  RELEASE_AUTOMATION_APP_SLUGS,
  SCHEDULED_AUTOMATION_APP_SLUGS,
  automationExemption,
  parsePullRequestDisposition,
  validatePullRequestDisposition,
} from "../../scripts/lib/pr-issue-disposition.mjs";

it("exempts only the exact same-repository Kepler renewal automation", () => {
  const input = {
    repository,
    baseRepository: repository,
    headRepository: repository,
    baseRefName: "trunk",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    headRefName: "automation/kepler-audit-renewal-2026-09-01",
    title: "chore(kepler): renew reviewed audit exception",
    authorLogin: "github-actions[bot]",
    authorType: "Bot",
  };
  assert.equal(automationExemption(input), KEPLER_AUDIT_RENEWAL_EXEMPTION);
  assert.equal(automationExemption({ ...input, headRepository: "attacker/fork" }), null);
  assert.equal(automationExemption({ ...input, title: "chore: arbitrary" }), null);
});
import {
  GITHUB_ACTIONS_APP_ID,
  publishReleasePleaseDispositionCheck,
  RELEASE_PLEASE_EXEMPTION,
  REQUIRED_DISPOSITION_CHECK,
  validateTrustedReleasePleaseWorkflowContext,
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

function graphqlIssuePayload(number, { state = "OPEN", type = "Issue" } = {}) {
  return {
    data: {
      repository: {
        nameWithOwner: repository,
        issueOrPullRequest: { __typename: type, number, state },
      },
    },
  };
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
    const workflow = fs
      .readFileSync(path.join(root, ".github/workflows/pr-issue-disposition.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    assert.match(workflow, /^  pull_request:\n/mu);
    assert.match(workflow, /^  workflow_dispatch:\n/mu);
    assert.doesNotMatch(workflow, /pull_request_target/u);
    assert.match(workflow, /^  contents: read\n  issues: read\n  pull-requests: read$/mu);
    assert.doesNotMatch(workflow, /(?:write|secrets:)/u);
    assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/u);
    assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/u);
    assert.match(
      workflow,
      /ref: \$\{\{ github\.event\.pull_request\.base\.ref \|\| github\.event\.repository\.default_branch \}\}/u,
    );
    assert.doesNotMatch(workflow, /pull_request\.base\.sha/u);
    assert.match(workflow, /path: trusted-policy/u);
    assert.match(workflow, /persist-credentials: false/u);
    assert.match(workflow, /working-directory: trusted-policy/u);
    assert.match(workflow, /name: PR Issue Disposition/u);
  });

  it("routes regeneration through an exact, strictly checked automation PR", () => {
    const workflow = fs
      .readFileSync(path.join(root, ".github/workflows/regenerate-derived-artifacts.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    assert.match(workflow, /^  workflow_dispatch:$/mu);
    assert.match(
      workflow,
      /^  commit-and-validate:\n    name: Publish artifacts PR \+ gate strict validation[\s\S]*?^      pull-requests: write$/mu,
    );
    assert.match(workflow, /branch="automation\/derived-artifacts-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/u);
    assert.match(workflow, /gh pr create/u);
    const prCreation = workflow.indexOf("gh pr create");
    const strictDispatch = workflow.indexOf("name: Dispatch strict CI for regeneration PR");
    const nativeApproval = workflow.indexOf("name: Approve native checks for regeneration PR");
    const requiredCheckWait = workflow.indexOf('gh pr checks "$PR_NUMBER"');
    assert.ok(
      prCreation >= 0 &&
        strictDispatch > prCreation &&
        nativeApproval > strictDispatch &&
        requiredCheckWait > nativeApproval,
    );
    assert.match(workflow, /gh workflow run ci\.yml[\s\S]*--ref "\$BRANCH"/u);
    assert.doesNotMatch(workflow, /gh workflow run pr-issue-disposition\.yml/u);
    assert.match(workflow, /gh run view "\$STRICT_CI_RUN_ID"[\s\S]*--json headSha/u);
    assert.match(workflow, /gh run watch "\$STRICT_CI_RUN_ID"[\s\S]*--exit-status/u);
    assert.match(workflow, /gh run list[\s\S]*--event pull_request/u);
    assert.match(workflow, /\.headSha == \$generated/u);
    assert.match(workflow, /actions\/runs\/\$run_id\/approve/u);
    assert.match(workflow, /\["SDK CI","PR issue disposition","Schema sync gate","Security"\]/u);
    assert.match(workflow, /gh pr checks "\$PR_NUMBER"[\s\S]*--required --json name,bucket/u);
    const mergeWait = workflow.slice(
      workflow.indexOf("- name: Merge validated regeneration PR"),
      workflow.indexOf("- name: Dispatch strict trunk CI and docs validation"),
    );
    assert.match(mergeWait, /timeout-minutes: 60/u);
    assert.doesNotMatch(mergeWait, /--auto/u);
    assert.doesNotMatch(mergeWait, /--watch/u);
    assert.match(mergeWait, /all\(\.\[\]; \.bucket == "pass"\)/u);
    assert.match(mergeWait, /\.bucket == "fail" or \.bucket == "cancel"/u);
    assert.match(mergeWait, /Required checks did not all pass/u);
    const boundedRequiredCheckWait = mergeWait.indexOf(
      'gh pr checks "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --required --json name,bucket',
    );
    const postWaitPrRead = mergeWait.indexOf('post_wait_pr="$(gh pr view');
    const postWaitTopologyRead = mergeWait.indexOf(
      'git merge-base --is-ancestor "$GITHUB_SHA" "$GENERATED"',
    );
    const immediateMerge = mergeWait.indexOf('gh pr merge "$PR_NUMBER"');
    assert.ok(boundedRequiredCheckWait >= 0);
    assert.ok(postWaitPrRead > boundedRequiredCheckWait);
    assert.ok(postWaitTopologyRead > postWaitPrRead);
    assert.ok(immediateMerge > postWaitTopologyRead);
    assert.match(mergeWait, /\.headRefOid/u);
    assert.match(mergeWait, /\.baseRefOid/u);
    assert.match(mergeWait, /post_wait_base_ref" != "trunk"/u);
    assert.match(mergeWait, /--match-head-commit "\$GENERATED"/u);
    assert.match(workflow, /current_trunk="\$\(git rev-parse refs\/remotes\/origin\/trunk\)"/u);
    assert.match(workflow, /gh pr merge "\$PR_NUMBER"[\s\S]*--merge[\s\S]*--match-head-commit "\$GENERATED"/u);
    assert.match(workflow, /gh workflow run regenerate-derived-artifacts\.yml --repo "\$GITHUB_REPOSITORY" --ref trunk/u);
    assert.match(
      workflow,
      /name: Dispatch strict trunk CI and docs validation[\s\S]*gh workflow run ci\.yml[\s\S]*--ref trunk/u,
    );
    // The rolling `sample-bundles-release` job that this block used to guard was
    // retired: org-enforced immutable releases froze `sample-bundles-latest`
    // permanently, so the job could only ever fail. Publication is now the
    // content-addressed, one-release-per-commit workflow, which carries its own
    // gates. Nothing here asserts a `ci.yml` publication surface any more.
    const migrationGeneration = workflow.indexOf("name: Regenerate migration-workbench artifacts");
    const llmsGeneration = workflow.indexOf("name: Regenerate llms.txt and comparison page");
    const comparisonCommand = workflow.indexOf("npm run docs:comparison", llmsGeneration);
    const llmsCommand = workflow.indexOf("npm run docs:llms", llmsGeneration);
    const llmsVerification = workflow.indexOf("name: Verify llms.txt freshness before publication");
    assert.ok(migrationGeneration >= 0 && llmsGeneration > migrationGeneration);
    assert.ok(comparisonCommand > llmsGeneration && llmsCommand > comparisonCommand);
    assert.ok(llmsVerification > llmsGeneration);
    assert.match(workflow, /name: Verify llms\.txt freshness before publication[\s\S]*run: npm run verify:llms/u);
    const sampleGeneration = workflow.indexOf("name: Regenerate sample dist projections");
    const finalLlmsGeneration = workflow.indexOf(
      "name: Regenerate and verify llms aggregate after sample projection",
    );
    const finalLlmsCommand = workflow.indexOf("npm run docs:llms", finalLlmsGeneration);
    const finalLlmsVerification = workflow.indexOf("npm run verify:llms", finalLlmsGeneration);
    const evidenceCommit = workflow.indexOf("name: Stage and commit resealed evidence locally");
    assert.ok(
      sampleGeneration >= 0 &&
        finalLlmsGeneration > sampleGeneration &&
        finalLlmsCommand > finalLlmsGeneration &&
        finalLlmsVerification > finalLlmsCommand &&
        evidenceCommit > finalLlmsVerification,
    );
    assert.match(
      workflow,
      /name: Stage and commit resealed evidence locally[\s\S]*git add -A --[\s\S]*llms\.txt \\[\s\S]*llms-full\.txt \\/u,
    );
    assert.doesNotMatch(workflow, /git push origin "\$generated:refs\/heads\/trunk"/u);
  });

  it("emits Release Please checks only from pinned code on a trusted trunk push", () => {
    const workflow = fs
      .readFileSync(path.join(root, ".github/workflows/release-please.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    const usesLines = workflow.split("\n").filter((line) => /^\s*(?:-\s*)?uses:/u.test(line));
    const actionUses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu)].map(
      (match) => match[1],
    );
    assert.match(workflow, /^  push:\n    branches:\n      - trunk$/mu);
    assert.match(workflow, /^  workflow_dispatch:$/mu);
    assert.doesNotMatch(workflow, /pull_request(?:_target)?:/u);
    assert.match(workflow, /^permissions: read-all$/mu);
    assert.match(
      workflow,
      /^  release-please:\n    if: \$\{\{ github\.ref == 'refs\/heads\/trunk' \}\}\n    runs-on: ubuntu-latest\n(?:    #[^\n]*\n)*    concurrency:\n      group: release-please-\$\{\{ github\.repository \}\}\n      cancel-in-progress: false\n    permissions:\n      actions: write\n      contents: write\n      pull-requests: write$/mu,
    );
    assert.match(
      workflow,
      /^  release-please-disposition:\n    needs: \[release-please, release-please-refresh, release-please-ci\]\n[\s\S]*?    runs-on: ubuntu-latest\n    permissions:\n      actions: read\n      checks: write\n      contents: read\n      issues: read\n      pull-requests: read$/mu,
    );
    assert.equal(actionUses.length, usesLines.length);
    assert.ok(actionUses.length > 0);
    for (const actionUse of actionUses) {
      assert.match(actionUse, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u);
    }
    assert.ok(
      actionUses.includes("googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7"),
    );
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

  it("exempts only the exact derived-artifact automation identity", () => {
    const fixture = {
      repository,
      body: "",
      authorLogin: "github-actions[bot]",
      authorType: "Bot",
      headRefName: "automation/derived-artifacts-29712056688-1",
      headSha: "a".repeat(40),
      headRepository: repository,
      baseRefName: "trunk",
      baseSha: "b".repeat(40),
      baseRepository: repository,
      title: "chore(evidence): regenerate derived artifacts",
    };
    assert.equal(automationExemption(fixture), DERIVED_ARTIFACT_EXEMPTION);
    assert.deepEqual(validatePullRequestDisposition(fixture), {
      status: "exempt",
      exemption: DERIVED_ARTIFACT_EXEMPTION,
      closes: [],
      refs: [],
    });

    for (const override of [
      { authorLogin: "octocat[bot]" },
      { authorType: "User" },
      { headRefName: "automation/derived-artifacts-29712056688" },
      { headRefName: "automation/derived-artifacts-29712056688-1-extra" },
      { title: "chore(evidence): regenerate derived artifacts lookalike" },
      { baseRefName: "release/next" },
      { baseSha: "not-a-commit" },
      { headSha: "not-a-commit" },
      { headRepository: "mallory/honua-sdk-js" },
      { baseRepository: "mallory/honua-sdk-js" },
    ]) {
      assert.equal(
        automationExemption({ ...fixture, ...override }),
        null,
        `unexpected exemption for ${JSON.stringify(override)}`,
      );
    }
  });

  it("accepts every release-automation identity form without widening any other condition", () => {
    // honua-sdk-js#1093: the release pull request moves from `GITHUB_TOKEN` to
    // a GitHub App. The gate has to accept the App login before the token is
    // switched, or the first pull request that identity opens fails the
    // required check.
    assert.deepEqual([...RELEASE_AUTOMATION_APP_SLUGS], ["github-actions", "honua-io-bot"]);

    const acceptedLogins = [
      "github-actions",
      "github-actions[bot]",
      "app/github-actions",
      "honua-io-bot",
      "honua-io-bot[bot]",
      "app/honua-io-bot",
      "HONUA-IO-BOT[BOT]",
    ];
    const derivedArtifactFixture = {
      repository,
      body: "",
      authorType: "Bot",
      headRefName: "automation/derived-artifacts-29712056688-1",
      headSha: "a".repeat(40),
      headRepository: repository,
      baseRefName: "trunk",
      baseSha: "b".repeat(40),
      baseRepository: repository,
      title: "chore(evidence): regenerate derived artifacts",
    };

    for (const authorLogin of acceptedLogins) {
      assert.equal(
        automationExemption({ ...releasePleaseFixture, authorLogin }),
        RELEASE_PLEASE_EXEMPTION,
        `release-please exemption refused for ${authorLogin}`,
      );
      assert.equal(
        automationExemption({ ...derivedArtifactFixture, authorLogin }),
        DERIVED_ARTIFACT_EXEMPTION,
        `derived-artifact exemption refused for ${authorLogin}`,
      );
    }

    // An arbitrary bot login stays refused: only the listed App slugs pass.
    for (const authorLogin of [
      "honua-release-dispatch[bot]",
      "honua-io-bots[bot]",
      "release-please[bot]",
      "octocat[bot]",
      "app/octocat",
      "honua-io-bot-impostor",
    ]) {
      assert.equal(
        automationExemption({ ...releasePleaseFixture, authorLogin }),
        null,
        `unexpected release-please exemption for ${authorLogin}`,
      );
      assert.equal(
        automationExemption({ ...derivedArtifactFixture, authorLogin }),
        null,
        `unexpected derived-artifact exemption for ${authorLogin}`,
      );
    }

    // The wider login set must not relax a single other condition.
    for (const override of [
      { authorType: "User" },
      { headRefName: "release-please--branches--preview" },
      { headRefName: "feature/arbitrary-release-branch" },
      { title: "chore: release trunk (lookalike)" },
      { baseRefName: "preview" },
      { baseSha: "not-a-commit" },
      { headSha: "not-a-commit" },
      { headRepository: "mallory/honua-sdk-js" },
      { baseRepository: "mallory/honua-sdk-js" },
      { repository: "mallory/honua-sdk-js" },
    ]) {
      assert.equal(
        automationExemption({ ...releasePleaseFixture, authorLogin: "honua-io-bot[bot]", ...override }),
        null,
        `unexpected release-please exemption for ${JSON.stringify(override)}`,
      );
    }
    for (const override of [
      { authorType: "User" },
      { headRefName: "automation/derived-artifacts-29712056688" },
      { headRefName: "automation/derived-artifacts-29712056688-1-extra" },
      { title: "chore(evidence): regenerate derived artifacts lookalike" },
      { baseRefName: "release/next" },
      { baseSha: "not-a-commit" },
      { headSha: "not-a-commit" },
      { headRepository: "mallory/honua-sdk-js" },
      { baseRepository: "mallory/honua-sdk-js" },
    ]) {
      assert.equal(
        automationExemption({ ...derivedArtifactFixture, authorLogin: "honua-io-bot[bot]", ...override }),
        null,
        `unexpected derived-artifact exemption for ${JSON.stringify(override)}`,
      );
    }
  });

  it("accepts both automation identities on the scheduled report lanes and nothing else", () => {
    // honua-sdk-js#1093: these lanes now mint the same `honua-io-bot` App token
    // the release lanes do, so the ruleset bypass actor covers the pull request
    // they open and merge. `github-actions` stays accepted because every lane
    // falls back to `GITHUB_TOKEN` when `BOT_APP_ID` is absent.
    assert.deepEqual([...SCHEDULED_AUTOMATION_APP_SLUGS], ["github-actions", "honua-io-bot"]);
    const scheduled = [
      {
        headRefName: "automation/mcp-certification-32007819760-1",
        title: "chore(mcp): publish scheduled live-certification report",
        exemption: MCP_CERTIFICATION_EXEMPTION,
      },
      {
        headRefName: "automation/kepler-audit-renewal-2026-09-01",
        title: "chore(kepler): renew reviewed audit exception",
        exemption: KEPLER_AUDIT_RENEWAL_EXEMPTION,
      },
    ];
    for (const { headRefName, title, exemption } of scheduled) {
      const fixture = {
        repository,
        body: "",
        authorType: "Bot",
        headRefName,
        headSha: "c".repeat(40),
        headRepository: repository,
        baseRefName: "trunk",
        baseSha: "d".repeat(40),
        baseRepository: repository,
        title,
      };
      for (const authorLogin of [
        "github-actions",
        "github-actions[bot]",
        "app/github-actions",
        "honua-io-bot",
        "honua-io-bot[bot]",
        "app/honua-io-bot",
        "HONUA-IO-BOT[BOT]",
      ]) {
        assert.equal(
          automationExemption({ ...fixture, authorLogin }),
          exemption,
          `scheduled exemption refused for ${authorLogin}`,
        );
      }
      for (const authorLogin of [
        "honua-release-dispatch[bot]",
        "honua-io-bots[bot]",
        "honua-io-bot-impostor",
        "octocat[bot]",
        "app/octocat",
      ]) {
        assert.equal(
          automationExemption({ ...fixture, authorLogin }),
          null,
          `unexpected scheduled exemption for ${authorLogin}`,
        );
      }
      // The wider login set relaxes no other condition on these lanes either.
      for (const override of [
        { authorType: "User" },
        { baseRefName: "release/next" },
        { title: `${title} (lookalike)` },
        { headSha: "not-a-commit" },
        { baseSha: "not-a-commit" },
        { headRepository: "mallory/honua-sdk-js" },
        { baseRepository: "mallory/honua-sdk-js" },
      ]) {
        assert.equal(
          automationExemption({ ...fixture, authorLogin: "honua-io-bot[bot]", ...override }),
          null,
          `unexpected scheduled exemption for ${JSON.stringify(override)}`,
        );
      }
    }
  });

  it("exempts only the exact MCP scheduled-certification automation identity", () => {
    const fixture = {
      repository,
      body: "",
      authorLogin: "github-actions[bot]",
      authorType: "Bot",
      headRefName: "automation/mcp-certification-32007819760-1",
      headSha: "c".repeat(40),
      headRepository: repository,
      baseRefName: "trunk",
      baseSha: "d".repeat(40),
      baseRepository: repository,
      title: "chore(mcp): publish scheduled live-certification report",
    };
    assert.equal(automationExemption(fixture), MCP_CERTIFICATION_EXEMPTION);
    assert.deepEqual(validatePullRequestDisposition(fixture), {
      status: "exempt",
      exemption: MCP_CERTIFICATION_EXEMPTION,
      closes: [],
      refs: [],
    });

    for (const override of [
      { authorLogin: "octocat[bot]" },
      { authorType: "User" },
      { headRefName: "automation/mcp-certification-32007819760" },
      { headRefName: "automation/mcp-certification-32007819760-1-extra" },
      { headRefName: "automation/derived-artifacts-32007819760-1" },
      { title: "chore(mcp): publish scheduled live-certification report lookalike" },
      { baseRefName: "release/next" },
      { baseSha: "not-a-commit" },
      { headSha: "not-a-commit" },
      { headRepository: "mallory/honua-sdk-js" },
      { baseRepository: "mallory/honua-sdk-js" },
    ]) {
      assert.equal(
        automationExemption({ ...fixture, ...override }),
        null,
        `unexpected exemption for ${JSON.stringify(override)}`,
      );
    }
  });

  it("publishes the scheduled MCP certification through a checked automation PR, never a trunk push", () => {
    const workflow = fs
      .readFileSync(path.join(root, ".github/workflows/mcp-cert-scheduled.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    // A scheduled push at trunk can only ever be rejected by the ruleset.
    assert.doesNotMatch(workflow, /^\s*git push\s*$/mu);
    assert.match(workflow, /branch="automation\/mcp-certification-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/u);
    assert.match(workflow, /--title "chore\(mcp\): publish scheduled live-certification report"/u);
    assert.match(workflow, /git commit -m "chore\(mcp\): publish scheduled live-certification report"/u);
    // The report must not be able to skip the checks it is merged on.
    assert.doesNotMatch(workflow, /\[skip ci\]/u);
    const prCreation = workflow.indexOf("gh pr create");
    const nativeApproval = workflow.indexOf("name: Approve native checks for the publication pull request");
    const requiredCheckWait = workflow.indexOf('gh pr checks "$PR_NUMBER"');
    const merge = workflow.indexOf('gh pr merge "$PR_NUMBER"');
    assert.ok(prCreation >= 0);
    assert.ok(nativeApproval > prCreation);
    assert.ok(requiredCheckWait > nativeApproval);
    assert.ok(merge > requiredCheckWait);
    assert.match(workflow, /actions\/runs\/\$run_id\/approve/u);
    // The approval wait names the workflows carrying trunk's required contexts,
    // so a late-appearing held run cannot stall the check wait unnoticed.
    assert.match(workflow, /\["SDK CI","PR issue disposition"\]/u);
    assert.match(workflow, /gh pr checks "\$PR_NUMBER"[\s\S]*--required --watch --fail-fast/u);
    assert.match(workflow, /--match-head-commit "\$PUBLISHED"/u);
    assert.doesNotMatch(workflow, /--auto/u);
    // A token merge emits no push event, so trunk would otherwise carry no core
    // check runs for the resulting head. Re-entering the derived-artifact
    // automation reseals first and then dispatches strict trunk CI itself;
    // dispatching ci.yml directly would validate an unresealed head.
    assert.match(
      workflow,
      /gh workflow run regenerate-derived-artifacts\.yml --repo "\$GITHUB_REPOSITORY" --ref trunk/u,
    );
    assert.doesNotMatch(workflow, /gh workflow run ci\.yml/u);
    // Nothing outside the certification corpus may ride the automation merge.
    assert.match(workflow, /Certification publication contains an unexpected path/u);
    // The evidence stays visible even when nothing is published.
    assert.match(workflow, /name: Summarize publication/u);
    assert.match(workflow, /mcp-scheduled-cert/u);
    assert.doesNotMatch(workflow, /continue-on-error/u);
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

describe("trusted Release Please workflow context", () => {
  const trustedPolicySha = "a".repeat(40);

  for (const eventName of ["push", "workflow_dispatch"]) {
    it(`accepts an exact trunk ${eventName}`, () => {
      assert.deepEqual(
        validateTrustedReleasePleaseWorkflowContext({
          eventName,
          ref: "refs/heads/trunk",
          trustedPolicySha,
          githubSha: trustedPolicySha,
        }),
        { eventName, ref: "refs/heads/trunk", trustedPolicySha },
      );
    });
  }

  it("fails closed for other events and refs", () => {
    for (const [eventName, ref] of [
      ["pull_request", "refs/heads/trunk"],
      ["schedule", "refs/heads/trunk"],
      ["workflow_dispatch", "refs/heads/feature"],
    ]) {
      assert.throws(
        () =>
          validateTrustedReleasePleaseWorkflowContext({
            eventName,
            ref,
            trustedPolicySha,
            githubSha: trustedPolicySha,
          }),
        /only for a trunk push or manual dispatch/u,
      );
    }
  });

  it("fails closed for malformed or mismatched workflow revisions", () => {
    assert.throws(
      () =>
        validateTrustedReleasePleaseWorkflowContext({
          eventName: "workflow_dispatch",
          ref: "refs/heads/trunk",
          trustedPolicySha: "not-a-sha",
          githubSha: trustedPolicySha,
        }),
      /Trusted policy revision must be a full lowercase commit SHA/u,
    );
    assert.throws(
      () =>
        validateTrustedReleasePleaseWorkflowContext({
          eventName: "workflow_dispatch",
          ref: "refs/heads/trunk",
          trustedPolicySha,
          githubSha: "b".repeat(40),
        }),
      /must match the triggering trunk revision/u,
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
  it("loads current GraphQL metadata and fails a reordered snapshot closed", async () => {
    const livePayload = graphqlPayload();
    const requests = [];
    const request = async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(options.body);
        return body.query.includes("issueOrPullRequest") ? graphqlIssuePayload(550) : livePayload;
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
    assert.equal(requests.filter(({ url }) => url.endsWith("/graphql")).length, 3);
    assert.equal(
      requests.filter(({ options }) => JSON.parse(options.body).query.includes("issueOrPullRequest")).length,
      1,
    );

    let graphqlCalls = 0;
    const reorderedRequest = async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      if (body.query.includes("issueOrPullRequest")) {
        return graphqlIssuePayload(550);
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

      fs.writeFileSync(
        metadataPath,
        JSON.stringify({
          repository,
          pullRequestNumber: 601,
          body: "",
          authorLogin: "github-actions[bot]",
          authorType: "Bot",
          headRefName: "automation/derived-artifacts-29712056688-1",
          headSha: "c".repeat(40),
          headRepository: repository,
          baseRefName: "trunk",
          baseSha: "d".repeat(40),
          baseRepository: repository,
          title: "chore(evidence): regenerate derived artifacts",
          issues: [],
          closingIssueNumbers: [],
        }),
      );
      const dispatched = spawnSync(
        process.execPath,
        [
          cli,
          "--repository",
          repository,
          "--pull-request",
          "601",
          "--metadata",
          metadataPath,
        ],
        { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } },
      );
      assert.equal(dispatched.status, 0, dispatched.stderr);
      assert.match(dispatched.stdout, /Exempt: Derived-artifact regeneration/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
