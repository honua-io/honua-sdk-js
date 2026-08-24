import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TRANSIENT_BASE_PATTERNS,
  MERGED_EDITS_MISSING,
  MERGED_INDETERMINATE,
  MERGED_LANDED,
  MERGED_ON_DEFAULT,
  MERGED_STRANDED,
  MERGED_SUPERSEDED,
  MERGED_TRANSIENT_BASE,
  OPEN_LIVE_BASE,
  OPEN_NEEDS_RETARGET,
  OPEN_ON_DEFAULT,
  OPEN_UNKNOWN_BASE,
  PATH_ABSENT,
  PATH_DELETION_PENDING,
  PATH_IDENTICAL,
  PATH_INDETERMINATE,
  PATH_MISSING,
  PATH_PARTIAL,
  PATH_PATCH_LANDED,
  PATH_PRESENT,
  SCHEMA_VERSION,
  classifyMergedPullRequest,
  classifyOpenPullRequest,
  classifyPath,
  matchesAnyBasePattern,
  normalizePullRequest,
  renderReport,
  significantAddedLines,
  summarize,
  unquoteDiffPath,
} from "../../scripts/lib/stranded-merge-detector.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(root, "test/scripts/fixtures/stranded-merges-1317.json");

/** Runs the CLI over recorded facts. No `gh`, no network, no git. */
function sweepFixture(extraArgs = []) {
  const result = execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/stranded-merge-detector.mjs"),
      "--fixture",
      fixturePath,
      "--default-branch",
      "trunk",
      "--no-fetch",
      ...extraArgs,
    ],
    { encoding: "utf8", cwd: root },
  );
  return result;
}

function sweepFixtureJson(extraArgs = []) {
  return JSON.parse(sweepFixture(["--json", "--fail-on", "never", ...extraArgs]));
}

function byNumber(findings) {
  return new Map(findings.map((finding) => [finding.number, finding]));
}

describe("stranded merge detector — path adjudication", () => {
  it("calls a path absent when the default branch does not have it at all", () => {
    const verdict = classifyPath({
      path: "src/query/planner-hint.ts",
      headBlob: "aaa",
      addedLines: ["export function planSpatialIndexHint(query) {"],
    });
    assert.equal(verdict.verdict, PATH_ABSENT);
  });

  it("calls a path identical when the blobs match, whatever the merge commit's ancestry", () => {
    const verdict = classifyPath({ path: "a.ts", headBlob: "aaa", defaultBlob: "aaa", addedLines: ["something long"] });
    assert.equal(verdict.verdict, PATH_IDENTICAL);
  });

  it("trusts patch identity over the added-line heuristic, because a re-land re-words lines", () => {
    const verdict = classifyPath({
      path: "a.ts",
      headBlob: "aaa",
      defaultBlob: "bbb",
      addedLines: ["const wording = 'the original';"],
      defaultText: "const wording = 'reworded during the re-land';",
      patchLanded: true,
    });
    assert.equal(verdict.verdict, PATH_PATCH_LANDED);
  });

  it("calls a path present when every probed added line is in the default branch's text", () => {
    const verdict = classifyPath({
      path: "a.ts",
      headBlob: "aaa",
      defaultBlob: "bbb",
      addedLines: ["readonly instantField: string;"],
      defaultText: "type T = {\n  readonly instantField: string;\n};\n",
    });
    assert.equal(verdict.verdict, PATH_PRESENT);
  });

  it("splits partial from missing, and only calls a partial landing superseded", () => {
    const partial = classifyPath({
      path: "a.ts",
      headBlob: "aaa",
      defaultBlob: "bbb",
      addedLines: ["first added line here", "second added line here"],
      defaultText: "first added line here\n",
      touchedOnDefaultSinceMerge: true,
    });
    assert.equal(partial.verdict, PATH_PARTIAL);
    assert.equal(partial.supersededOnDefault, true);
    assert.equal(partial.addedLinesFound, 1);

    // A hot path the default branch rewrites every week must not launder a
    // wholly absent edit into a non-actionable finding.
    const missing = classifyPath({
      path: "a.ts",
      headBlob: "aaa",
      defaultBlob: "bbb",
      addedLines: ["first added line here", "second added line here"],
      defaultText: "nothing of the sort\n",
      touchedOnDefaultSinceMerge: true,
    });
    assert.equal(missing.verdict, PATH_MISSING);
    assert.equal(missing.supersededOnDefault, false);
  });

  it("says indeterminate rather than guessing when the payload added no probeable lines", () => {
    const verdict = classifyPath({ path: "logo.png", headBlob: "aaa", defaultBlob: "bbb", addedLines: [] });
    assert.equal(verdict.verdict, PATH_INDETERMINATE);
  });

  it("treats a deletion that has not landed as pending, not as lost work", () => {
    const removed = classifyPath({ path: "old.ts", defaultBlob: "bbb" });
    assert.equal(removed.verdict, PATH_DELETION_PENDING);
    const gone = classifyPath({ path: "old.ts" });
    assert.equal(gone.verdict, PATH_IDENTICAL);
  });

  it("ignores short and structural added lines, which match by accident", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1,3 @@",
      "+}",
      "+  else {",
      "+export function meaningfulAddition(): void {}",
    ].join("\n");
    assert.deepEqual(significantAddedLines(diff).get("src/a.ts"), ["export function meaningfulAddition(): void {}"]);
  });

  it("attributes a rename to the new path and ignores deleted files", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export const renamedSymbol = 1;",
      "diff --git a/src/dead.ts b/dev/null",
      "--- a/src/dead.ts",
      "+++ /dev/null",
    ].join("\n");
    const added = significantAddedLines(diff);
    assert.deepEqual([...added.keys()], ["src/new.ts"]);
  });

  it("decodes C-quoted diff paths, so a non-ASCII path is not silently called landed", () => {
    assert.equal(unquoteDiffPath('"docs/h\\303\\251llo.md"'), "docs/héllo.md");
    assert.equal(unquoteDiffPath("docs/plain.md"), "docs/plain.md");
  });
});

describe("stranded merge detector — merged pull requests", () => {
  const pr863 = {
    number: 863,
    title: "feat(scene): project temporal instants to Cesium availability",
    baseRefName: "codex/395-polygon-holes",
    mergeCommit: { oid: "b6f246180" },
    url: "https://github.com/honua-io/honua-sdk-js/pull/863",
  };

  it("does not call a merge stranded just because its commit is not an ancestor", () => {
    // This is the honua-sdk-js#863 shape and the whole reason for schema
    // version 2. The merge commit really is off trunk; the payload really is on
    // trunk, re-landed by #921. Schema version 1 filed it as lost every week.
    const finding = classifyMergedPullRequest(pr863, {
      onDefaultBranch: false,
      pathVerdicts: [
        { path: "src/scene-workspace/index.ts", verdict: PATH_PRESENT },
        { path: "src/scene-workspace/source-to-cesium.ts", verdict: PATH_PRESENT },
      ],
    });
    assert.equal(finding.classification, MERGED_LANDED);
    assert.deepEqual(finding.absentPaths, []);
  });

  it("calls a merge stranded when the payload's files are absent from the default branch", () => {
    const finding = classifyMergedPullRequest(
      { ...pr863, number: 1207, baseRefName: "agent/1200-query-planner" },
      {
        onDefaultBranch: false,
        pathVerdicts: [
          { path: "src/query/planner-hint.ts", verdict: PATH_ABSENT },
          { path: "test/query-planner-hint.test.ts", verdict: PATH_ABSENT },
        ],
      },
    );
    assert.equal(finding.classification, MERGED_STRANDED);
    assert.deepEqual(finding.absentPaths, ["src/query/planner-hint.ts", "test/query-planner-hint.test.ts"]);
  });

  it("separates edits-missing from stranded, because the file being there is weaker evidence", () => {
    const finding = classifyMergedPullRequest(pr863, {
      onDefaultBranch: false,
      pathVerdicts: [{ path: "src/tiles/overzoom.ts", verdict: PATH_MISSING, supersededOnDefault: false }],
    });
    assert.equal(finding.classification, MERGED_EDITS_MISSING);
    assert.deepEqual(finding.unlandedEditPaths, ["src/tiles/overzoom.ts"]);
  });

  it("calls it superseded when the default branch has part of the change and moved past it", () => {
    const finding = classifyMergedPullRequest(pr863, {
      onDefaultBranch: false,
      pathVerdicts: [{ path: "src/a.ts", verdict: PATH_PARTIAL, supersededOnDefault: true }],
    });
    assert.equal(finding.classification, MERGED_SUPERSEDED);
  });

  it("never reports an unknown merge commit as landed", () => {
    for (const onDefaultBranch of [undefined, null]) {
      const finding = classifyMergedPullRequest(pr863, { onDefaultBranch });
      assert.equal(finding.classification, MERGED_INDETERMINATE);
      assert.match(finding.reason, /not in this clone/u);
    }
  });

  it("reports a pull request with no merge commit recorded as indeterminate, not as fine", () => {
    const finding = classifyMergedPullRequest({ number: 5, baseRefName: "trunk" }, { onDefaultBranch: true });
    assert.equal(finding.classification, MERGED_INDETERMINATE);
  });

  it("probes even a default-branch merge, because a force-push can drop one", () => {
    const finding = classifyMergedPullRequest(
      { number: 100, baseRefName: "trunk", mergeCommit: { oid: "deadbeef1" } },
      { onDefaultBranch: false, pathVerdicts: [{ path: "src/a.ts", verdict: PATH_ABSENT }] },
    );
    assert.equal(finding.classification, MERGED_STRANDED);
  });

  it("surfaces an in-flight merge-train base without failing on it", () => {
    const finding = classifyMergedPullRequest(
      { number: 1250, baseRefName: "train/batch/9d20f0cb4/7", mergeCommit: { oid: "cc33dd44e" } },
      { onDefaultBranch: false, transientBase: true },
    );
    assert.equal(finding.classification, MERGED_TRANSIENT_BASE);
  });

  it("classifies a merge that is on the default branch without adjudicating anything", () => {
    const finding = classifyMergedPullRequest(
      { number: 921, baseRefName: "trunk", mergeCommit: { oid: "c7775d0d4" } },
      { onDefaultBranch: true },
    );
    assert.equal(finding.classification, MERGED_ON_DEFAULT);
    assert.equal(finding.paths, undefined);
  });
});

describe("stranded merge detector — open pull requests", () => {
  const open = (number, baseRefName) => ({ number, baseRefName, title: `pr ${number}` });

  it("tells an open stacked pull request to re-target once its base has merged", () => {
    const finding = classifyOpenPullRequest(open(1334, "agent/1300-scene-landed"), {
      defaultBranch: "trunk",
      baseExists: true,
      baseMerged: true,
      baseIsAncestor: true,
    });
    assert.equal(finding.classification, OPEN_NEEDS_RETARGET);
    assert.equal(finding.remedy, "gh pr edit 1334 --base trunk");
  });

  it("tells an open stacked pull request to re-target when its base is gone", () => {
    const finding = classifyOpenPullRequest(open(1335, "agent/1290-odata-gone"), {
      defaultBranch: "trunk",
      baseExists: false,
    });
    assert.equal(finding.classification, OPEN_NEEDS_RETARGET);
  });

  it("leaves a live stack alone, because a fresh base is an ancestor while being alive", () => {
    const finding = classifyOpenPullRequest(open(1333, "agent/1331-scene-base"), {
      defaultBranch: "trunk",
      baseExists: true,
      baseMerged: false,
      baseIsAncestor: true,
    });
    assert.equal(finding.classification, OPEN_LIVE_BASE);
    assert.equal(finding.remedy, undefined);
  });

  it("says unknown rather than recommending a detach it cannot justify", () => {
    for (const baseExists of [undefined, null]) {
      const finding = classifyOpenPullRequest(open(1336, "agent/1289-unknown"), { defaultBranch: "trunk", baseExists });
      assert.equal(finding.classification, OPEN_UNKNOWN_BASE);
    }
    const merged = classifyOpenPullRequest(open(1336, "agent/1289-unknown"), {
      defaultBranch: "trunk",
      baseExists: true,
      baseMerged: null,
    });
    assert.equal(merged.classification, OPEN_UNKNOWN_BASE);
  });

  it("ignores default-branch and merge-train bases", () => {
    assert.equal(
      classifyOpenPullRequest(open(1330, "trunk"), { defaultBranch: "trunk" }).classification,
      OPEN_ON_DEFAULT,
    );
    assert.equal(
      classifyOpenPullRequest(open(1331, "train/batch/abc/1"), { defaultBranch: "trunk" }).classification,
      OPEN_ON_DEFAULT,
    );
  });
});

describe("stranded merge detector — base patterns and normalization", () => {
  it("matches transient base globs across slashes and anchors the pattern", () => {
    assert.equal(matchesAnyBasePattern("train/batch/2026-08-16/3", DEFAULT_TRANSIENT_BASE_PATTERNS), true);
    assert.equal(matchesAnyBasePattern("not-train/batch/x", DEFAULT_TRANSIENT_BASE_PATTERNS), false);
    assert.equal(matchesAnyBasePattern("train/batch", DEFAULT_TRANSIENT_BASE_PATTERNS), false);
  });

  it("treats every glob character except * as a literal", () => {
    assert.equal(matchesAnyBasePattern("release/v1.2", ["release/v1.2"]), true);
    assert.equal(matchesAnyBasePattern("release/v1x2", ["release/v1.2"]), false);
    assert.equal(matchesAnyBasePattern("fix/(auth)+", ["fix/(auth)+"]), true);
  });

  it("accepts both the gh object shape and a bare merge-commit string", () => {
    assert.equal(normalizePullRequest({ number: 1, baseRefName: "trunk", mergeCommit: { oid: "abc" } }).mergeCommit, "abc");
    assert.equal(normalizePullRequest({ number: 1, baseRefName: "trunk", mergeCommit: "abc" }).mergeCommit, "abc");
    assert.throws(() => normalizePullRequest({ number: 0, baseRefName: "trunk" }), /positive integer/u);
    assert.throws(() => normalizePullRequest({ number: 1 }), /baseRefName/u);
  });

  it("counts only findings a human must act on as actionable", () => {
    const { counts, actionable } = summarize({
      mergedFindings: [
        { classification: MERGED_ON_DEFAULT },
        { classification: MERGED_LANDED },
        { classification: MERGED_SUPERSEDED },
        { classification: MERGED_TRANSIENT_BASE },
        { classification: MERGED_STRANDED },
        { classification: MERGED_EDITS_MISSING },
        { classification: MERGED_INDETERMINATE },
      ],
      openFindings: [{ classification: OPEN_NEEDS_RETARGET }, { classification: OPEN_LIVE_BASE }],
    });
    assert.equal(actionable, 4);
    assert.equal(counts[MERGED_LANDED], 1);
  });
});

describe("stranded merge detector — end-to-end over recorded facts", () => {
  it("reproduces the #1317 sweep: #863 landed elsewhere, #1207 genuinely stranded", () => {
    const findings = sweepFixtureJson();
    assert.equal(findings.schemaVersion, SCHEMA_VERSION);
    const merged = byNumber(findings.mergedFindings);

    // Merged into trunk.
    assert.equal(merged.get(921).classification, MERGED_ON_DEFAULT);
    // Merged into a stack base that never reached trunk -- and yet present.
    assert.equal(merged.get(863).classification, MERGED_LANDED);
    // Merged into a stack base that never reached trunk -- and absent.
    assert.equal(merged.get(1207).classification, MERGED_STRANDED);
    assert.deepEqual(merged.get(1207).absentPaths, ["src/query/planner-hint.ts", "test/query-planner-hint.test.ts"]);
    // File present, the added line is not.
    assert.equal(merged.get(1211).classification, MERGED_EDITS_MISSING);
    // Merge-train batch base, expected to resolve.
    assert.equal(merged.get(1250).classification, MERGED_TRANSIENT_BASE);
    // Merge commit not in the clone.
    assert.equal(merged.get(1266).classification, MERGED_INDETERMINATE);

    const open = byNumber(findings.openFindings);
    assert.equal(open.get(1330).classification, OPEN_ON_DEFAULT);
    assert.equal(open.get(1333).classification, OPEN_LIVE_BASE);
    assert.equal(open.get(1334).classification, OPEN_NEEDS_RETARGET);
    assert.equal(open.get(1335).classification, OPEN_NEEDS_RETARGET);
    assert.equal(open.get(1336).classification, OPEN_UNKNOWN_BASE);

    // stranded + edits-missing + indeterminate + two re-targets.
    assert.equal(findings.actionable, 5);
  });

  it("gates on actionable findings by default, and on absent files only with --fail-on stranded", () => {
    // The fixture has a real stranded pull request, so both gates fail here.
    // The flag's effect is the *count* it reports, which is what a maintainer
    // reads, so assert that rather than the exit code alone.
    assert.throws(() => sweepFixture([]), (error) => error.status === 1);
    assert.throws(
      () => sweepFixture(["--fail-on", "stranded"]),
      (error) => error.status === 1 && /1 finding\(s\) need a human, out of 5 actionable/u.test(error.stderr),
    );
    assert.doesNotThrow(() => sweepFixture(["--fail-on", "never"]));
  });

  it("renders a report that names the actionable findings and the remedy", () => {
    const report = sweepFixture(["--fail-on", "never"]);
    assert.match(report, /\*\*stranded \(files absent\): 1\*\*/u);
    assert.match(report, /src\/query\/planner-hint\.ts/u);
    assert.match(report, /gh pr edit 1334 --base trunk/u);
    // The landed-elsewhere section exists so nobody reads a non-ancestor merge
    // commit as a loss report -- that misreading is what #1317 corrected.
    assert.match(report, /## Landed elsewhere — stranded merge, content present/u);
    assert.match(report, /pull\/863/u);
  });

  it("renders the same report from a recorded findings.json, so gate and report cannot disagree", () => {
    const jsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stranded-merges-")), "findings.json");
    try {
      fs.writeFileSync(jsonPath, sweepFixture(["--json", "--fail-on", "never"]), "utf8");
      const fromJson = execFileSync(
        process.execPath,
        [path.join(root, "scripts/stranded-merge-detector.mjs"), "--from-json", jsonPath],
        { encoding: "utf8", cwd: root },
      );
      assert.equal(fromJson, sweepFixture(["--fail-on", "never"]));
    } finally {
      fs.rmSync(path.dirname(jsonPath), { recursive: true, force: true });
    }
  });

  it("renders directly from findings with no pull requests at all", () => {
    const report = renderReport({ repo: "honua-io/honua-sdk-js", defaultBranch: "trunk", scanned: 0 });
    assert.match(report, /Actionable findings: 0\./u);
  });
});

describe("stranded merge detector — the detector itself must actually run", () => {
  it("keeps the detector sources free of control bytes, so grep can see them", () => {
    // A raw NUL makes git and grep classify a source file as binary and return
    // no matches without -a. That is what hid the #863 payload during this
    // ticket's own investigation (#1332), and an earlier draft of this module
    // reintroduced it via a sentinel character.
    for (const relative of ["scripts/lib/stranded-merge-detector.mjs", "scripts/stranded-merge-detector.mjs"]) {
      const bytes = fs.readFileSync(path.join(root, relative));
      assert.equal(bytes.includes(0), false, `${relative} contains a NUL byte`);
    }
  });

  it("keeps the workflow calling the in-repo detector rather than a dangling reusable workflow", () => {
    // The first attempt at this ticket shipped a caller pointing at
    // honua-io/honua-server/.github/workflows/stranded-merge-detector.yml@trunk,
    // which did not exist at the time -- the sweep silently never ran once,
    // which is the exact failure class the detector is for.
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/stranded-merge-detector.yml"), "utf8");
    assert.doesNotMatch(workflow, /uses:\s*honua-io\/honua-server/u);
    assert.match(workflow, /scripts\/stranded-merge-detector\.mjs/u);
    assert.match(workflow, /schedule:/u);
    assert.match(workflow, /workflow_dispatch:/u);
    // The gate must read the adjudicated actionable count, not the raw count of
    // merge commits that are not ancestors of trunk.
    assert.match(workflow, /steps\.sweep\.outputs\.actionable/u);
    assert.match(workflow, /--from-json stranded-merge-findings\.json/u);
  });

  it("validates itself against the recorded fixture before trusting a live sweep", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/stranded-merge-detector.yml"), "utf8");
    assert.match(workflow, /node --test test\/scripts\/stranded-merge-detector\.test\.mjs/u);
    assert.ok(fs.existsSync(fixturePath), "the recorded fixture must exist");
  });
});
