import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// The release tag-move is the step that decides whether a published version can
// ever pass `release-seal check`. It stopped producing publishable tags for
// three consecutive releases and nobody could tell from the logs, because every
// abort surfaced as a bare "Process completed with exit code 1" (#1337). These
// tests execute the workflow's own shell against a stubbed `gh` so the loud
// reporting and the post-move verification are proven, not asserted about.

const WORKFLOW = resolve(".github/workflows/release-please.yml");
const RELEASE_COMMIT = "1".repeat(40);
const RESEALED_COMMIT = "2".repeat(40);
const TAG = "js-sdk-v9.9.9-beta.0";

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
 * by the scenario file, plus a no-op `sleep` so the reseal poll does not wait.
 */
function runTagMove({ tagResolves, patchFails, movedTagResolves }) {
  const root = mkdtempSync(join(tmpdir(), "honua-release-tag-seal-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const summary = join(root, "summary.md");
  writeFileSync(summary, "");

  // A tiny `gh` that answers only the calls this function makes. Every
  // unexpected call is fatal, so the test cannot pass by accident.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -uo pipefail
ARGS="$*"
case "$ARGS" in
  "run list"*) echo "100" ;;
  "workflow run regenerate-derived-artifacts.yml"*) ;;
  "run watch"*) ;;
  *"git/ref/heads/trunk"*) echo "${RESEALED_COMMIT}" ;;
  *"compare/"*)
    echo '{"status":"ahead","merge_base_commit":{"sha":"${RELEASE_COMMIT}"},"files":[{"filename":"llms.txt"}]}'
    ;;
  *"--method PATCH"*)
    if [[ "${patchFails ? "1" : "0"}" == "1" ]]; then
      echo "gh: Repository rule violations found" >&2
      echo "Cannot update this protected ref." >&2
      exit 1
    fi
    ;;
  *"commits/${TAG}"*)
    if [[ -f "${root}/moved" ]]; then
      echo "${movedTagResolves}"
    else
      touch "${root}/moved"
      echo "${tagResolves}"
    fi
    ;;
  "workflow run publish-js-sdk.yml"*) echo "PUBLISH_DISPATCHED" ;;
  "workflow run first-map-release-smoke.yml"*) echo "SMOKE_DISPATCHED" ;;
  *) echo "unexpected gh call: $ARGS" >&2; exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "sleep"), 0o755);

  const script = `${runBlock("Dispatch package publish workflows")}\ndispatch_resealed_js_publish "${TAG}"\n`;
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
        MCP_TAG_NAME: "",
        CREATE_APP_TAG_NAME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: result, summary: readFileSync(summary, "utf8") };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      summary: readFileSync(summary, "utf8"),
      status: error.status,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a moved release tag is verified on the resealed commit before anything publishes", () => {
  const result = runTagMove({
    tagResolves: RELEASE_COMMIT,
    patchFails: false,
    movedTagResolves: RESEALED_COMMIT,
  });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /verified on resealed commit/u);
  assert.match(result.output, /PUBLISH_DISPATCHED/u);
  assert.match(result.output, /SMOKE_DISPATCHED/u);
  assert.match(result.summary, /Release tag sealed/u);
});

test("a rejected tag move fails loudly and publishes nothing", () => {
  // Org-enforced immutable releases reject the PATCH once the release is
  // published. 0.1.7-beta.0 hit exactly this and reported only exit code 1.
  const result = runTagMove({
    tagResolves: RELEASE_COMMIT,
    patchFails: true,
    movedTagResolves: RESEALED_COMMIT,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /::error title=Release blocked for js-sdk-v9\.9\.9-beta\.0::/u);
  assert.match(result.output, /Immutable releases protect a tag once its release is published/u);
  assert.doesNotMatch(result.output, /PUBLISH_DISPATCHED/u);
  assert.match(result.summary, /Nothing was published for this tag/u);
});

test("a tag move that silently does not land is caught by the post-condition", () => {
  // The regression this ticket exists for: a fire-and-forget PATCH whose result
  // nothing checked. Here the PATCH "succeeds" and the tag still names the
  // unsealed version-bump commit.
  const result = runTagMove({
    tagResolves: RELEASE_COMMIT,
    patchFails: false,
    movedTagResolves: RELEASE_COMMIT,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /Post-condition failed/u);
  assert.match(result.output, /not the resealed commit/u);
  assert.match(result.output, /release-seal\.mjs check --tag js-sdk-v9\.9\.9-beta\.0/u);
  assert.doesNotMatch(result.output, /PUBLISH_DISPATCHED/u);
});

test("the release step aborts under strict shell settings", () => {
  const block = runBlock("Dispatch package publish workflows");
  assert.match(block, /^set -euo pipefail$/mu);
  // Every abort path routes through fail(), which annotates and summarises, so
  // the only `exit 1` left in the step is the one inside fail() itself.
  assert.equal((block.match(/^\s*exit 1$/gmu) ?? []).length, 1);
  assert.match(block, /^\s*fail\(\) \{$/mu);
  assert.ok((block.match(/\bfail "/gu) ?? []).length >= 7, "every abort must be reported");
});
