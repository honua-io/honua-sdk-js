import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareReleasePleaseCandidates } from "../../scripts/lib/release-please-candidates.mjs";
import { RELEASE_PLEASE_HEADS } from "../../scripts/lib/release-please-disposition-check.mjs";
import {
  renderReleasePleaseDispositionSummary,
  renderReleasePleaseRefreshSummary,
} from "../../scripts/lib/release-please-run-summary.mjs";

const [combined, sdk, mcp, createApp] = RELEASE_PLEASE_HEADS;
const sha = (letter) => letter.repeat(40);
const trustedPolicySha = sha("a");
const repository = "honua-io/honua-sdk-js";

function componentOnlyDependencies() {
  const current = new Map([
    [sdk, { pullRequestNumber: 2406, headSha: sha("b"), stale: true }],
    [mcp, { pullRequestNumber: 2405, headSha: sha("c"), stale: true }],
    [createApp, { pullRequestNumber: 2407, headSha: sha("d"), stale: false }],
  ]);
  return {
    refresh: async ({ headRefName, requireCurrent }) => {
      const candidate = current.get(headRefName);
      if (!candidate) return { status: "not-found", repository, trustedPolicySha };
      if (candidate.stale && !requireCurrent) {
        candidate.stale = false;
        candidate.headSha = headRefName === sdk ? sha("e") : sha("f");
        return { status: "refreshed", repository, trustedPolicySha, ...candidate };
      }
      return { status: "already-current", repository, trustedPolicySha, ...candidate };
    },
    locks: async () => [],
    mcpNotes: async () => {
      current.get(mcp).headSha = sha("9");
      return { status: "normalized", headSha: sha("9") };
    },
    workspaceNotes: async () => {
      throw new Error("The combined branch is absent.");
    },
  };
}

test("refresh summary reports every release branch when only component pull requests are open", async () => {
  const { candidates, refreshedCandidates } = await prepareReleasePleaseCandidates(
    { repository, trustedPolicySha, releasePleasePullRequests: "[]" },
    componentOnlyDependencies(),
  );

  assert.equal(
    renderReleasePleaseRefreshSummary({ trustedPolicySha, candidates, refreshedCandidates }),
    [
      "## Trusted Release Please base refresh",
      "",
      `Trusted trunk policy revision: ${trustedPolicySha}.`,
      "",
      `- \`${combined}\`: absent.`,
      `- \`${sdk}\`: refreshed; ${repository}#2406 at ${sha("e")}.`,
      `- \`${mcp}\`: refreshed, normalized; ${repository}#2405 at ${sha("9")}.`,
      `- \`${createApp}\`: unchanged; ${repository}#2407 at ${sha("d")}.`,
      "",
    ].join("\n"),
  );
});

test("refresh summary keeps the combined branch workspace notes and Release Please updates", () => {
  const candidates = [
    { headRefName: combined, status: "release-please-updated", repository, pullRequestNumber: 7,
      headSha: sha("b"), workspaceNotes: "normalized" },
    ...[sdk, mcp, createApp].map((headRefName) => ({ headRefName, status: "not-found" })),
  ];

  assert.equal(
    renderReleasePleaseRefreshSummary({ trustedPolicySha, candidates, refreshedCandidates: structuredClone(candidates) }),
    [
      "## Trusted Release Please base refresh",
      "",
      `Trusted trunk policy revision: ${trustedPolicySha}.`,
      "",
      `- \`${combined}\`: updated by Release Please; ${repository}#7 at ${sha("b")}; workspace dependency notes normalized.`,
      `- \`${sdk}\`: absent.`,
      `- \`${mcp}\`: absent.`,
      `- \`${createApp}\`: absent.`,
      "",
    ].join("\n"),
  );
});

test("disposition summary names the checked branch and defers component pull requests", () => {
  assert.equal(
    renderReleasePleaseDispositionSummary({ status: "not-found", trustedPolicySha }),
    [
      "## Trusted Release Please issue disposition",
      "",
      `Checked \`${combined}\`: no open combined Release Please pull request; no disposition check was emitted.`,
      "Component release pull requests are verified by the pull request workflows.",
      `Trusted trunk policy revision: ${trustedPolicySha}.`,
      "",
    ].join("\n"),
  );

  assert.equal(
    renderReleasePleaseDispositionSummary({
      status: "published", exemption: "Release Please automation", repository, pullRequestNumber: 7,
      headSha: sha("b"), trustedPolicySha, checkRunId: 42,
    }),
    [
      "## Trusted Release Please issue disposition",
      "",
      `Checked \`${combined}\`: validated ${repository}#7 at ${sha("b")}.`,
      "Exempt: Release Please automation.",
      "Created source-bound check run 42.",
      "Component release pull requests are verified by the pull request workflows.",
      `Trusted trunk policy revision: ${trustedPolicySha}.`,
      "",
    ].join("\n"),
  );
});
