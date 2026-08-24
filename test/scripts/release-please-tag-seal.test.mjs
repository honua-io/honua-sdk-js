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
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "honua-release-tag-seal-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const summary = join(root, "summary.md");
  writeFileSync(summary, "");
  writeFileSync(join(root, "trace"), "");
  writeFileSync(join(root, "tag-resolves"), `${tagResolves.join("\n")}\n`);

  // A tiny `gh` that answers only the calls this step makes. Every unexpected
  // call is fatal, so the test cannot pass by accident.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -uo pipefail
ARGS="$*"
case "$ARGS" in
  "run list"*) echo "100" ;;
  "workflow run regenerate-derived-artifacts.yml"*) echo "reseal-dispatch" >> "${root}/trace" ;;
  "run watch"*) ;;
  *"git/ref/heads/trunk"*) echo "${RESEALED_COMMIT}" ;;
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

  const script =
    `${runBlock("Dispatch package publish workflows")}\n` +
    `dispatch_resealed_js_publish "${TAG}" "${releaseId}" "${releaseDraft}"\n`;
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
        JS_SDK_RELEASE_CREATED: "false",
        MCP_RELEASE_CREATED: "false",
        CREATE_APP_RELEASE_CREATED: "false",
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
