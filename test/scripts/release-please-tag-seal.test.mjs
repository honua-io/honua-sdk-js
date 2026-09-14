import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Where a release tag ends up decides whether a published version can ever pass
// `release-seal check`. It stopped producing publishable tags for three
// consecutive releases and nobody could tell from the logs, because every abort
// surfaced as a bare "Process completed with exit code 1" (#1337); the ordering
// that made those tags unrepairable is #1350. These tests execute the
// workflow's own shell against a stubbed `gh` so both the loud reporting and
// the seal-before-publish ordering are proven, not asserted about.

const WORKFLOW = resolve(".github/workflows/release-please.yml");
const RELEASE_COMMIT = "1".repeat(40);
const RESEALED_COMMIT = "2".repeat(40);
// The commit an already-created release tag names, in the half-stranded case.
const SEALED_TAG_COMMIT = "3".repeat(40);
const TAG = "js-sdk-v9.9.9-beta.0";
const RELEASE_ID = "424242";

/** Extract one `run: |` block from a workflow step, de-indented. */
function runBlock(stepName) {
  const source = readFileSync(WORKFLOW, "utf8").split("\n");
  const step = source.findIndex((line) => line.includes(`- name: ${stepName}`));
  assert.ok(step >= 0, `no step named ${stepName}`);
  const start = source.findIndex((line, index) => index > step && line.trim() === "run: |");
  assert.ok(start > step, `step ${stepName} has no run block`);
  const indent = source[start].length - source[start].trimStart().length + 2;
  const body = [];
  for (let index = start + 1; index < source.length; index += 1) {
    const line = source[index];
    if (line.trim().length > 0 && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/**
 * Drive `dispatch_resealed_js_publish` with a fake `gh` whose behaviour is set
 * by the scenario, plus a no-op `sleep` so the reseal poll does not wait.
 *
 * `tagResolves` is the sequence of commits `gh api .../commits/<tag>` answers
 * with, one per call, the last entry repeating: the step reads the tag once
 * after creating it and once after publishing the release, and those two reads
 * are the two post-conditions.
 */
function runReleaseStep({
  releaseDraft = "true",
  releaseId = RELEASE_ID,
  tagCreateFails = false,
  tagResolves = [RESEALED_COMMIT],
  draftState = `true ${TAG}`,
  draftReadFails = false,
  publishDraftFails = false,
  publishedDraftState = "false",
  // One conclusion per `gh run view` on a reseal run, last entry repeating.
  resealConclusions = ["success"],
  // One answer per `gh run list`, last entry repeating; `EMPTY` answers with no
  // run at all. The first call is the pre-dispatch `before_id`, the second
  // finds the dispatched reseal, and each later one is a supersession lookup.
  //
  // A bare id is answered verbatim. An entry that is a JSON array of run rows
  // (newest first, e.g. `[{"databaseId":102,"headBranch":"trunk"}]`) is instead
  // fed through the step's real `--branch` / `--jq` selection, so the filter
  // itself is executed rather than assumed.
  runListIds = ["100", "101"],
  // When false the stub ignores `--branch`, modelling a `gh` that returns
  // unfiltered rows. The `headBranch` assertion in the jq must then carry the
  // guarantee on its own.
  runListHonoursBranchFlag = true,
  // Stranded-draft re-entry (#1337).
  finishStrandedDraft = "",
  eventName = "workflow_dispatch",
  jsSdkReleaseCreated = "false",
  // Releases the stubbed `gh` lists, so the resolve-by-tag jq is executed.
  releases = [{ id: Number(RELEASE_ID), tag_name: TAG, draft: true }],
  // Whether `git/ref/tags/<tag>` resolves, i.e. the tag already exists.
  strandedTagExists = false,
  // package.json version at trunk, for the recovery version anchor. The default
  // matches TAG so recovery proceeds.
  trunkVersion = "9.9.9-beta.0",
  // `compare/<tag sha>...<trunk head>` status: "behind" means the tag is an
  // ancestor of trunk, which is what a real sealed release commit looks like.
  tagAncestryStatus = "behind",
  // When false the step's own trailing `if` blocks decide what runs, which is
  // what the re-entry path needs; the default drives the function directly.
  directInvoke = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "honua-release-tag-seal-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const summary = join(root, "summary.md");
  writeFileSync(summary, "");
  writeFileSync(join(root, "trace"), "");
  writeFileSync(join(root, "tag-resolves"), `${tagResolves.join("\n")}\n`);
  writeFileSync(join(root, "reseal-conclusions"), `${resealConclusions.join("\n")}\n`);
  writeFileSync(join(root, "run-list-ids"), `${runListIds.join("\n")}\n`);
  writeFileSync(join(root, "releases.json"), JSON.stringify(releases));

  // A tiny `gh` that answers only the calls this step makes. Every unexpected
  // call is fatal, so the test cannot pass by accident.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -uo pipefail
# Answer a scripted sequence, one entry per call, the last entry repeating.
# "EMPTY" answers with nothing, which is how "no such run exists" is expressed.
next_line() {
  local seq="$1"
  local idx_file="$2"
  local idx
  idx="$(cat "$idx_file" 2>/dev/null || echo 0)"
  echo "$((idx + 1))" > "$idx_file"
  local line
  line="$(sed -n "$((idx + 1))p" "$seq")"
  if [[ -z "$line" ]]; then line="$(tail -n 1 "$seq")"; fi
  if [[ "$line" == "EMPTY" ]]; then return 0; fi
  echo "$line"
}
ARGS="$*"
case "$ARGS" in
  "run list"*)
    entry="$(next_line "${root}/run-list-ids" "${root}/run-list-index")"
    if [[ "$entry" == \\[* ]]; then
      # Model \`gh run list\`: honour --branch, then evaluate --jq over the rows.
      branch=""
      jqexpr=""
      prev=""
      for a in "$@"; do
        case "$prev" in
          --branch) branch="$a" ;;
          --jq) jqexpr="$a" ;;
        esac
        prev="$a"
      done
      rows="$entry"
      if [[ -n "$branch" && "${runListHonoursBranchFlag ? "1" : "0"}" == "1" ]]; then
        rows="$(jq -c --arg b "$branch" '[.[] | select(.headBranch == $b)]' <<<"$rows")"
      fi
      if [[ -n "$jqexpr" ]]; then
        jq -r "$jqexpr" <<<"$rows"
      else
        echo "$rows"
      fi
    else
      echo "$entry"
    fi
    ;;
  "run view"*) next_line "${root}/reseal-conclusions" "${root}/reseal-index" ;;
  "workflow run regenerate-derived-artifacts.yml"*) echo "reseal-dispatch" >> "${root}/trace" ;;
  "run watch"*) ;;
  *"git/ref/heads/trunk"*) echo "${RESEALED_COMMIT}" ;;
  *"git/ref/tags/"*)
    if [[ "${strandedTagExists ? "1" : "0"}" == "1" ]]; then
      echo "${SEALED_TAG_COMMIT}"
    else
      echo "gh: Not Found (HTTP 404)" >&2
      exit 1
    fi
    ;;
  *"contents/package.json"*) echo "${trunkVersion}" ;;
  # This call uses gh's own --jq .status, so the stub answers the resolved value.
  *"compare/${SEALED_TAG_COMMIT}"*) echo "${tagAncestryStatus}" ;;
  *"/releases --paginate"*)
    # Evaluate the step's real resolve-by-tag jq against the release fixture.
    jqexpr=""
    prev=""
    for a in "$@"; do
      case "$prev" in --jq) jqexpr="$a" ;; esac
      prev="$a"
    done
    jq -r "$jqexpr" "${root}/releases.json"
    ;;
  *"compare/"*)
    echo '{"status":"ahead","merge_base_commit":{"sha":"${RELEASE_COMMIT}"},"files":[{"filename":"llms.txt"}]}'
    ;;
  *"--method POST"*"git/refs"*)
    echo "tag-create" >> "${root}/trace"
    if [[ "${tagCreateFails ? "1" : "0"}" == "1" ]]; then
      echo "gh: Reference already exists (HTTP 422)" >&2
      exit 1
    fi
    ;;
  *"--method PATCH"*"/releases/"*)
    echo "draft-publish" >> "${root}/trace"
    if [[ "${publishDraftFails ? "1" : "0"}" == "1" ]]; then
      echo "gh: Repository rule violations found" >&2
      exit 1
    fi
    echo "${publishedDraftState}"
    ;;
  *"/releases/"*)
    if [[ "${draftReadFails ? "1" : "0"}" == "1" ]]; then
      echo "gh: Bad credentials (HTTP 401)" >&2
      exit 1
    fi
    echo "${draftState}"
    ;;
  *"commits/${TAG}"*)
    index="$(cat "${root}/tag-index" 2>/dev/null || echo 0)"
    echo "$((index + 1))" > "${root}/tag-index"
    sed -n "$((index + 1))p" "${root}/tag-resolves" || true
    tail -n 1 "${root}/tag-resolves" > "${root}/tag-last"
    if [[ -z "$(sed -n "$((index + 1))p" "${root}/tag-resolves")" ]]; then
      cat "${root}/tag-last"
    fi
    ;;
  "workflow run publish-js-sdk.yml"*) echo "npm-publish-dispatch" >> "${root}/trace" ;;
  "workflow run first-map-release-smoke.yml"*) echo "smoke-dispatch" >> "${root}/trace" ;;
  *) echo "unexpected gh call: $ARGS" >&2; exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "sleep"), 0o755);

  const script = directInvoke
    ? `${runBlock("Dispatch package publish workflows")}\n` +
      `dispatch_resealed_js_publish "${TAG}" "${releaseId}" "${releaseDraft}"\n`
    : `${runBlock("Dispatch package publish workflows")}\n`;
  const scriptPath = join(root, "step.sh");
  writeFileSync(scriptPath, script);
  try {
    const result = execFileSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_SHA: RELEASE_COMMIT,
        GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
        GITHUB_STEP_SUMMARY: summary,
        JS_SDK_RELEASE_CREATED: jsSdkReleaseCreated,
        MCP_RELEASE_CREATED: "false",
        CREATE_APP_RELEASE_CREATED: "false",
        FINISH_STRANDED_DRAFT: finishStrandedDraft,
        GITHUB_EVENT_NAME: eventName,
        JS_SDK_TAG_NAME: TAG,
        JS_SDK_RELEASE_ID: releaseId,
        JS_SDK_RELEASE_DRAFT: releaseDraft,
        MCP_TAG_NAME: "",
        CREATE_APP_TAG_NAME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: true,
      output: result,
      summary: readFileSync(summary, "utf8"),
      trace: readFileSync(join(root, "trace"), "utf8").split("\n").filter(Boolean),
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      summary: readFileSync(summary, "utf8"),
      trace: readFileSync(join(root, "trace"), "utf8").split("\n").filter(Boolean),
      status: error.status,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the release tag is created on the resealed commit and only then is the draft published", () => {
  const result = runReleaseStep({ tagResolves: [RESEALED_COMMIT, RESEALED_COMMIT] });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /verified on resealed commit/u);
  assert.match(result.output, /published on resealed commit/u);
  assert.match(result.summary, /Release tag sealed/u);
  // Ordering is the fix: the tag exists before the release is published, so
  // immutability attaches to a tag that already names the sealed commit, and
  // npm only publishes after that.
  assert.deepEqual(result.trace, [
    "reseal-dispatch",
    "tag-create",
    "draft-publish",
    "npm-publish-dispatch",
    "smoke-dispatch",
  ]);
});

test("a reseal cancelled by the derived-artifacts concurrency group is followed to its successor", () => {
  // The js-sdk-v0.1.8-beta.0 stranding (#1337). `derived-artifacts` uses
  // cancel-in-progress: false, and GitHub keeps only ONE run pending per group,
  // so the reseal this step dispatches queues behind the push-triggered reseal
  // of the same release commit and is cancelled when the next pair arrives.
  // Release run 33007925674 refused to tag for exactly this reason while a
  // successful reseal of that very commit already existed. A cancelled reseal
  // means a newer run is doing the same job, so the chain is followed.
  const result = runReleaseStep({
    resealConclusions: ["cancelled", "success"],
    runListIds: ["100", "101", "102"],
    tagResolves: [RESEALED_COMMIT, RESEALED_COMMIT],
  });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /Reseal run 101 was superseded in the derived-artifacts concurrency group/u);
  assert.match(result.output, /following the chain to 102/u);
  assert.match(result.output, /reseal run 102 succeeded/u);
  assert.match(result.output, /published on resealed commit/u);
  assert.ok(result.trace.includes("npm-publish-dispatch"));
});

// The `derived-artifacts` concurrency group carries no ref, and the reseal
// workflow accepts `workflow_dispatch` on an arbitrary ref, so a run started
// from a feature branch joins the very same group and can be the run that
// evicted ours. Following one would conclude "a reseal succeeded" from a run
// that never checked out trunk; because the comparison downstream accepts
// `identical`, an unresealed trunk would then take the tag on the UNSEALED
// version-bump commit -- the exact #1337 failure this ordering prevents.
const TRUNK_THEN_FEATURE = '[{"databaseId":102,"headBranch":"trunk"},{"databaseId":101,"headBranch":"feat/rogue"}]';
const FEATURE_SUPERSESSOR = '[{"databaseId":104,"headBranch":"trunk"},{"databaseId":103,"headBranch":"feat/rogue"}]';

test("a feature-ref run sharing the concurrency group is never followed as the supersessor", () => {
  const result = runReleaseStep({
    runListIds: ["100", TRUNK_THEN_FEATURE, FEATURE_SUPERSESSOR],
    resealConclusions: ["cancelled", "success"],
    tagResolves: [RESEALED_COMMIT, RESEALED_COMMIT],
  });
  assert.equal(result.ok, true, result.output);
  // 103 is the next-newer run, and is skipped because it is not on trunk.
  assert.match(result.output, /following the chain to 104/u);
  assert.doesNotMatch(result.output, /chain to 103/u);
  assert.match(result.output, /reseal run 104 succeeded/u);
  assert.ok(result.trace.includes("npm-publish-dispatch"));
});

test("the headBranch assertion skips a feature-ref run even when --branch is ignored", () => {
  // Defence in depth: the guarantee must not rest on the CLI flag alone, so the
  // stub returns unfiltered rows and the jq assertion has to carry it.
  const result = runReleaseStep({
    runListIds: ["100", TRUNK_THEN_FEATURE, FEATURE_SUPERSESSOR],
    runListHonoursBranchFlag: false,
    resealConclusions: ["cancelled", "success"],
    tagResolves: [RESEALED_COMMIT, RESEALED_COMMIT],
  });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /following the chain to 104/u);
  assert.doesNotMatch(result.output, /chain to 103/u);
  assert.ok(result.trace.includes("npm-publish-dispatch"));
});

test("a feature-ref run is not mistaken for the dispatched reseal", () => {
  // The same hazard at the first selection rather than the supersession hop: if
  // the only newer run is a feature-ref dispatch, the release must time out and
  // say so, not adopt it.
  const result = runReleaseStep({
    runListIds: ["100", '[{"databaseId":101,"headBranch":"feat/rogue"}]'],
    runListHonoursBranchFlag: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /never appeared in the run list/u);
  assert.deepEqual(result.trace, ["reseal-dispatch"]);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("both reseal-run selections are scoped to trunk", () => {
  // Belt to the braces above: the flag and the assertion must both be present
  // at both selection sites, so neither can be dropped as redundant.
  const block = runBlock("Dispatch package publish workflows");
  const selections = block.match(/gh run list \\\n(?:.*\\\n)*?.*--jq[^\n]*\n/gu) ?? [];
  // Only the queries that pick a run to watch. The pre-dispatch `before_id`
  // watermark is deliberately unscoped: it is a high-water mark over all runs,
  // and a higher one is strictly safer than a trunk-only one.
  const resealSelections = selections.filter(
    (s) => s.includes("regenerate-derived-artifacts.yml") && s.includes("select(. >"),
  );
  assert.equal(resealSelections.length, 2, "expected the poll and the supersession lookup");
  for (const selection of resealSelections) {
    assert.match(selection, /--branch trunk/u);
    assert.match(selection, /select\(\.headBranch == \\"trunk\\"\)/u);
  }
});

test("a reseal that genuinely fails still stops the release", () => {
  // Following supersession must not soften a real reseal failure: only
  // `cancelled` is retryable, and anything else aborts before the tag exists.
  const result = runReleaseStep({ resealConclusions: ["failure"] });
  assert.equal(result.ok, false);
  assert.match(result.output, /::error title=Release blocked for js-sdk-v9\.9\.9-beta\.0::/u);
  assert.match(result.output, /concluded 'failure'/u);
  assert.deepEqual(result.trace, ["reseal-dispatch"]);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("a cancelled reseal with no superseding run stops the release", () => {
  const result = runReleaseStep({
    resealConclusions: ["cancelled"],
    runListIds: ["100", "101", "EMPTY"],
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /no superseding reseal run appeared/u);
  assert.deepEqual(result.trace, ["reseal-dispatch"]);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("endless reseal supersession is bounded rather than followed forever", () => {
  // A permanently busy trunk must end the release with a diagnosis, not spin.
  const result = runReleaseStep({
    resealConclusions: ["cancelled"],
    runListIds: ["100", "101", "102", "103", "104", "105", "106"],
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /superseded repeatedly without reaching a successful run/u);
  assert.match(result.output, /Trunk is too busy to seal this release/u);
  assert.deepEqual(result.trace, ["reseal-dispatch"]);
});

test("a release Release Please published instead of drafting is refused before the reseal", () => {
  // The ordering guard. If the "." package ever loses `"draft": true`, Release
  // Please creates the tag on the unsealed bump commit and publishes it, and
  // immutable releases freeze it there: this must stop immediately, not after a
  // 40-minute reseal it can no longer use.
  const result = runReleaseStep({ releaseDraft: "false" });
  assert.equal(result.ok, false);
  assert.match(result.output, /::error title=Release blocked for js-sdk-v9\.9\.9-beta\.0::/u);
  assert.match(result.output, /published .* instead of drafting it/u);
  assert.match(result.output, /release-please-config\.json/u);
  assert.deepEqual(result.trace, []);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("a rejected tag creation fails loudly and publishes nothing", () => {
  const result = runReleaseStep({ tagCreateFails: true, tagResolves: [RELEASE_COMMIT] });
  assert.equal(result.ok, false);
  assert.match(result.output, /::error title=Release blocked for js-sdk-v9\.9\.9-beta\.0::/u);
  assert.match(result.output, /Creating js-sdk-v9\.9\.9-beta\.0 on the resealed commit/u);
  assert.deepEqual(result.trace, ["reseal-dispatch", "tag-create"]);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("a tag creation that already names the resealed commit is an idempotent resume", () => {
  const result = runReleaseStep({
    tagCreateFails: true,
    tagResolves: [RESEALED_COMMIT, RESEALED_COMMIT, RESEALED_COMMIT],
  });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /already named the resealed commit/u);
  assert.ok(result.trace.includes("npm-publish-dispatch"));
});

test("a tag creation that silently does not land is caught before the release is published", () => {
  // The regression #1337 exists for: a fire-and-forget ref write whose result
  // nothing checked. Here the create "succeeds" and the tag still names the
  // unsealed version-bump commit.
  const result = runReleaseStep({ tagResolves: [RELEASE_COMMIT] });
  assert.equal(result.ok, false);
  assert.match(result.output, /Post-condition failed/u);
  assert.match(result.output, /not the resealed commit/u);
  assert.match(result.output, /release-seal\.mjs check --tag js-sdk-v9\.9\.9-beta\.0/u);
  assert.deepEqual(result.trace, ["reseal-dispatch", "tag-create"]);
});

test("publishing a draft that repoints the tag is caught by the second post-condition", () => {
  // GitHub creates the tag itself, at the release's target_commitish (the
  // unsealed bump commit), when a draft is published while its tag does not
  // exist. Publication is therefore the last operation that can still misplace
  // a release, and it is re-checked.
  const result = runReleaseStep({ tagResolves: [RESEALED_COMMIT, RELEASE_COMMIT] });
  assert.equal(result.ok, false);
  assert.match(result.output, /Post-condition failed: publishing release 424242 repointed/u);
  assert.deepEqual(result.trace, ["reseal-dispatch", "tag-create", "draft-publish"]);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("a rejected draft publication fails loudly and says the tag is already sealed", () => {
  const result = runReleaseStep({ publishDraftFails: true, tagResolves: [RESEALED_COMMIT] });
  assert.equal(result.ok, false);
  assert.match(result.output, /Publishing draft release 424242/u);
  assert.match(result.output, /already names the sealed commit/u);
  assert.deepEqual(result.trace, ["reseal-dispatch", "tag-create", "draft-publish"]);
});

test("a release id that is not the expected draft is refused", () => {
  const result = runReleaseStep({ draftState: "false js-sdk-v0.0.1-beta.0" });
  assert.equal(result.ok, false);
  assert.match(result.output, /not the unpublished draft for js-sdk-v9\.9\.9-beta\.0/u);
  assert.deepEqual(result.trace, ["reseal-dispatch", "tag-create"]);
});

test("a missing draft release id is refused before the reseal", () => {
  const result = runReleaseStep({ releaseId: "" });
  assert.equal(result.ok, false);
  assert.match(result.output, /did not expose a numeric draft release id/u);
  assert.deepEqual(result.trace, []);
});

test("an unexpected gh failure is annotated by the ERR trap, not reported bare", () => {
  // errexit would otherwise end the step with "Process completed with exit code
  // 1" -- the anonymous abort #1337 was diagnosed through.
  const result = runReleaseStep({ draftReadFails: true, tagResolves: [RESEALED_COMMIT] });
  assert.equal(result.ok, false);
  assert.match(result.output, /::error title=Release blocked for js-sdk-v9\.9\.9-beta\.0::/u);
  assert.match(result.output, /The release step failed at line \d+/u);
  assert.deepEqual(result.trace, ["reseal-dispatch", "tag-create"]);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("the release step aborts under strict shell settings", () => {
  const block = runBlock("Dispatch package publish workflows");
  assert.match(block, /^set -Eeuo pipefail$/mu);
  // Every abort path routes through fail(), which annotates and summarises, so
  // the only `exit 1` left in the step is the one inside fail() itself, and the
  // ERR trap catches the aborts errexit would otherwise report bare.
  assert.equal((block.match(/^\s*exit 1$/gmu) ?? []).length, 1);
  assert.match(block, /^\s*fail\(\) \{$/mu);
  assert.match(block, /^\s*trap 'fail ".*"' ERR$/mu);
  assert.ok((block.match(/\bfail "/gu) ?? []).length >= 7, "every abort must be reported");
  // The release path must never write to an existing ref or an existing
  // published release: immutable releases reject both. Creation only.
  assert.doesNotMatch(block, /git\/refs\/tags/u);
});

test("release runs are serialized so none observes a drafted release without its tag", () => {
  // A draft release has no tag commit, so Release Please's release iterator
  // skips it. Any run of this workflow between the draft being cut and its tag
  // being created would therefore rebuild the release pull request from far too
  // much history -- and the reseal's own automation merge is exactly such a
  // trunk push.
  const source = readFileSync(WORKFLOW, "utf8");
  assert.match(
    source,
    /concurrency:\n\s+group: release-please-\$\{\{ github\.repository \}\}\n\s+cancel-in-progress: false\n/u,
  );
});

test("the js-sdk release is configured to be cut as a draft", () => {
  // The workflow's ordering is only possible because no tag exists when it
  // starts. That is entirely a property of this config flag.
  const config = JSON.parse(readFileSync(resolve("release-please-config.json"), "utf8"));
  assert.equal(config.packages["."].draft, true);
  // force-tag-creation would put the tag back on the unsealed bump commit.
  assert.equal(config.packages["."]["force-tag-creation"], undefined);
});

// Stranded-draft re-entry (#1337). Release Please's tag/id/draft outputs exist
// only in the run that cuts the release, so a draft whose run died afterwards
// is unreachable: every re-run and re-dispatch skips the finish sequence and
// reports success having done nothing. js-sdk-v0.1.8-beta.0 sat in exactly that
// state from 2026-08-26.

test("a stranded draft is resolved by tag and finished through the full seal path", () => {
  const result = runReleaseStep({
    directInvoke: false,
    finishStrandedDraft: TAG,
    releases: [{ id: Number(RELEASE_ID), tag_name: TAG, draft: true }],
    tagResolves: [RESEALED_COMMIT, RESEALED_COMMIT],
  });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /Re-entering the release finish sequence for stranded draft release 424242/u);
  assert.match(result.summary, /Finishing stranded draft/u);
  // The whole sequence runs, not a shortcut: reseal, tag on the sealed commit,
  // publish the draft, then the gated npm publish and the smoke.
  assert.deepEqual(result.trace, [
    "reseal-dispatch",
    "tag-create",
    "draft-publish",
    "npm-publish-dispatch",
    "smoke-dispatch",
  ]);
  assert.match(result.output, /verified on resealed commit/u);
});

test("the re-entry input is refused when the release is already published", () => {
  const result = runReleaseStep({
    directInvoke: false,
    finishStrandedDraft: TAG,
    releases: [{ id: Number(RELEASE_ID), tag_name: TAG, draft: false }],
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /already published, not a stranded draft/u);
  assert.deepEqual(result.trace, []);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("a half-stranded release whose tag is already sealed resumes at publication", () => {
  // The second failure shape: the original run created the tag on a sealed
  // commit and died before publishing the draft. Nothing needs resealing and
  // the tag must not be rewritten, so recovery resumes at publication.
  const result = runReleaseStep({
    directInvoke: false,
    finishStrandedDraft: TAG,
    strandedTagExists: true,
    tagResolves: [SEALED_TAG_COMMIT],
  });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /already names sealed commit/u);
  assert.match(result.output, /resuming at the draft publication step/u);
  assert.match(result.summary, /Resuming half-finished release/u);
  // No reseal and no tag write -- that is the whole point of this path.
  assert.deepEqual(result.trace, ["draft-publish", "npm-publish-dispatch", "smoke-dispatch"]);
});

test("a half-stranded resume is refused when the tag is not an ancestor of trunk", () => {
  // A tag pointing at a side branch is not a sealed release commit; publishing
  // it would ship bytes trunk never carried.
  const result = runReleaseStep({
    directInvoke: false,
    finishStrandedDraft: TAG,
    strandedTagExists: true,
    tagAncestryStatus: "diverged",
    tagResolves: [SEALED_TAG_COMMIT],
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /is 'diverged' relative to trunk rather than an ancestor of it/u);
  assert.deepEqual(result.trace, []);
});

test("an already-published release is refused even when its tag exists", () => {
  const result = runReleaseStep({
    directInvoke: false,
    finishStrandedDraft: TAG,
    strandedTagExists: true,
    releases: [{ id: Number(RELEASE_ID), tag_name: TAG, draft: false }],
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /already published, not a stranded draft/u);
  assert.deepEqual(result.trace, []);
});

test("recovery is refused when trunk has moved to a different version", () => {
  // On a normal cut GITHUB_SHA is the bump commit, so version consistency is
  // structural. A recovery dispatch runs on whatever trunk is now, and tagging
  // this release onto a tree carrying another version would be caught only
  // after the tag and release are immutable.
  const result = runReleaseStep({
    directInvoke: false,
    finishStrandedDraft: TAG,
    trunkVersion: "9.9.10-beta.0",
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /Trunk's package\.json is version 9\.9\.10-beta\.0/u);
  assert.match(result.output, /would publish 9\.9\.9-beta\.0/u);
  assert.match(result.output, /Re-cut the release instead/u);
  assert.deepEqual(result.trace, []);
});

test("the release iterator is skipped during a draft recovery", () => {
  // A stranded draft is by definition inside the draft-no-tag window this
  // workflow's own concurrency comment calls dangerous: the release iterator
  // cannot see a tagless draft and would rebuild the release pull request from
  // far too much history. Recovery must touch nothing but the finish path.
  const source = readFileSync(WORKFLOW, "utf8");
  assert.match(
    source,
    /uses: googleapis\/release-please-action@[0-9a-f]+ # v5\n\s+id: release\n\s+if: >-\n[\s\S]{0,200}?inputs\.finish_stranded_draft == ''/u,
  );
});

test("the re-entry input is refused when no release matches the tag", () => {
  const result = runReleaseStep({
    directInvoke: false,
    finishStrandedDraft: TAG,
    releases: [{ id: 1, tag_name: "js-sdk-v0.0.1-beta.0", draft: true }],
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /No release found for tag js-sdk-v9\.9\.9-beta\.0/u);
  assert.deepEqual(result.trace, []);
});

test("the re-entry input is refused on a non-dispatch event", () => {
  const result = runReleaseStep({
    directInvoke: false,
    finishStrandedDraft: TAG,
    eventName: "push",
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /only accepted on a workflow_dispatch run/u);
  assert.match(result.output, /this run's event is push/u);
  assert.deepEqual(result.trace, []);
});

test("a normal-path run ignores the re-entry input instead of double-dispatching", () => {
  const result = runReleaseStep({
    directInvoke: false,
    jsSdkReleaseCreated: "true",
    finishStrandedDraft: "js-sdk-v0.0.9-beta.0",
    tagResolves: [RESEALED_COMMIT, RESEALED_COMMIT],
  });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /finish_stranded_draft=js-sdk-v0\.0\.9-beta\.0 was ignored/u);
  assert.match(result.summary, /`finish_stranded_draft` ignored/u);
  // Exactly one finish sequence, for the tag Release Please actually cut.
  assert.equal(result.trace.filter((entry) => entry === "tag-create").length, 1);
  assert.deepEqual(result.trace, [
    "reseal-dispatch",
    "tag-create",
    "draft-publish",
    "npm-publish-dispatch",
    "smoke-dispatch",
  ]);
});

test("the release step runs on a dispatch that only finishes a stranded draft", () => {
  // The gap that made the draft unreachable is the STEP-level condition, not
  // the code inside it: guarded on `releases_created` alone, the step is
  // skipped outright on a re-dispatch and the job succeeds having done nothing.
  const source = readFileSync(WORKFLOW, "utf8");
  assert.match(
    source,
    /- name: Dispatch package publish workflows\n\s+if: >-\n[\s\S]{0,400}?inputs\.finish_stranded_draft != ''\) \}\}/u,
  );
  // And the input has to exist to be passed in.
  assert.match(source, /workflow_dispatch:\n\s+inputs:\n\s+finish_stranded_draft:/u);
  assert.match(source, /FINISH_STRANDED_DRAFT: \$\{\{ inputs\.finish_stranded_draft \}\}/u);
});
