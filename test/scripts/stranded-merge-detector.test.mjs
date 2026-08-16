import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TRANSIENT_BASE_PATTERNS,
  classifyMergedPullRequests,
  classifyOpenStacks,
  matchesAnyBasePattern,
  normalizePullRequest,
  renderReport,
} from "../../scripts/lib/stranded-merge-detector.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function pr(number, baseRefName, mergeCommit, extra = {}) {
  return { number, baseRefName, mergeCommit: { oid: mergeCommit }, title: `pr ${number}`, ...extra };
}

/** Ancestry oracle: every sha in `onTrunk` is an ancestor, the rest are not. */
function ancestryOracle(onTrunk, missing = []) {
  return (sha) => {
    if (missing.includes(sha)) return undefined;
    return onTrunk.includes(sha);
  };
}

describe("stranded merge detector", () => {
  it("flags the honua-sdk-js#863 shape: merged into a stack base that never reached trunk", () => {
    const classification = classifyMergedPullRequests({
      pullRequests: [
        pr(863, "codex/395-polygon-holes", "b6f246180"),
        pr(858, "codex/394-geoarrow-filter", "91a27a715"),
        pr(578, "codex/issue-524-error-envelope", "d0bdb55e9"),
      ],
      defaultBranch: "trunk",
      isAncestor: ancestryOracle(["91a27a715", "d0bdb55e9"]),
    });

    assert.deepEqual(
      classification.stranded.map((entry) => entry.number),
      [863],
    );
    assert.deepEqual(
      classification.landed.map((entry) => entry.number),
      [858, 578],
    );
    assert.equal(classification.unresolved.length, 0);
  });

  it("flags a default-branch merge that was later dropped, because MERGED is not evidence", () => {
    const classification = classifyMergedPullRequests({
      pullRequests: [pr(100, "trunk", "deadbeef1")],
      defaultBranch: "trunk",
      isAncestor: ancestryOracle([]),
    });

    assert.deepEqual(
      classification.stranded.map((entry) => entry.number),
      [100],
    );
  });

  it("does not report an in-flight merge-train base as stranded", () => {
    const classification = classifyMergedPullRequests({
      pullRequests: [pr(200, "train/batch/2026-08-16", "aaaa1111")],
      defaultBranch: "trunk",
      isAncestor: ancestryOracle([]),
    });

    assert.equal(classification.stranded.length, 0);
    assert.deepEqual(
      classification.transient.map((entry) => entry.number),
      [200],
    );
  });

  it("reports an unfetchable merge commit as unresolved rather than stranded", () => {
    const classification = classifyMergedPullRequests({
      pullRequests: [pr(300, "some/base", "cccc3333")],
      defaultBranch: "trunk",
      isAncestor: ancestryOracle([], ["cccc3333"]),
    });

    assert.equal(classification.stranded.length, 0);
    assert.equal(classification.unresolved.length, 1);
    assert.match(classification.unresolved[0].reason, /not present locally/u);
  });

  it("reports a merged pull request with no merge commit as unresolved", () => {
    const classification = classifyMergedPullRequests({
      pullRequests: [{ number: 400, baseRefName: "trunk", title: "no oid" }],
      defaultBranch: "trunk",
      isAncestor: ancestryOracle([]),
    });

    assert.equal(classification.unresolved.length, 1);
    assert.match(classification.unresolved[0].reason, /no merge commit/u);
  });

  it("accepts a bare merge-commit string as well as the gh object shape", () => {
    assert.equal(normalizePullRequest({ number: 1, baseRefName: "trunk", mergeCommit: "abc" }).mergeCommit, "abc");
    assert.equal(
      normalizePullRequest({ number: 1, baseRefName: "trunk", mergeCommit: { oid: "abc" } }).mergeCommit,
      "abc",
    );
  });

  it("rejects malformed records instead of silently skipping them", () => {
    assert.throws(() => normalizePullRequest({ baseRefName: "trunk" }), /positive integer/u);
    assert.throws(() => normalizePullRequest({ number: 1 }), /baseRefName/u);
    assert.throws(
      () => classifyMergedPullRequests({ pullRequests: [], defaultBranch: "", isAncestor: () => true }),
      /defaultBranch/u,
    );
  });

  it("matches transient base globs across slashes and anchors the pattern", () => {
    assert.equal(matchesAnyBasePattern("train/batch/2026-08-16/3", DEFAULT_TRANSIENT_BASE_PATTERNS), true);
    assert.equal(matchesAnyBasePattern("not-train/batch/x", DEFAULT_TRANSIENT_BASE_PATTERNS), false);
    assert.equal(matchesAnyBasePattern("train/batch", DEFAULT_TRANSIENT_BASE_PATTERNS), false);
  });

  it("names open stacked pull requests whose base has already merged or vanished", () => {
    const openStacks = classifyOpenStacks({
      pullRequests: [
        { number: 10, baseRefName: "trunk", title: "fine" },
        { number: 11, baseRefName: "feat/base-still-open", title: "stacked" },
        { number: 12, baseRefName: "feat/base-gone", title: "needs re-target" },
      ],
      defaultBranch: "trunk",
      baseState: (base) => (base === "feat/base-gone" ? "missing" : "open"),
    });

    assert.deepEqual(
      openStacks.retarget.map((entry) => entry.number),
      [12],
    );
    assert.deepEqual(
      openStacks.stacked.map((entry) => entry.number),
      [11],
    );
  });

  it("renders a report that names the stranded pull request and the detection command", () => {
    const classification = classifyMergedPullRequests({
      pullRequests: [pr(863, "codex/395-polygon-holes", "b6f246180", { url: "https://example.invalid/863" })],
      defaultBranch: "trunk",
      isAncestor: ancestryOracle([]),
    });
    const report = renderReport({
      repo: "honua-io/honua-sdk-js",
      defaultBranch: "trunk",
      scanned: 1,
      classification,
      openStacks: { retarget: [], stacked: [] },
    });

    assert.match(report, /git merge-base --is-ancestor <mergeCommit> origin\/trunk/u);
    assert.match(report, /https:\/\/example\.invalid\/863/u);
    assert.match(report, /stranded: 1/u);
  });

  it("keeps the workflow calling the in-repo detector rather than a dangling reusable workflow", () => {
    // The first attempt at this ticket shipped a caller pointing at
    // honua-io/honua-server/.github/workflows/stranded-merge-detector.yml@trunk,
    // which does not exist -- the sweep silently never ran, which is the exact
    // failure class the detector is for.
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/stranded-merge-detector.yml"), "utf8");
    assert.doesNotMatch(workflow, /uses:\s*honua-io\/honua-server/u);
    assert.match(workflow, /scripts\/stranded-merge-detector\.mjs/u);
    assert.match(workflow, /schedule:/u);
    assert.match(workflow, /workflow_dispatch:/u);
  });
});
