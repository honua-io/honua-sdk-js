import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const workflow = readFileSync(".github/workflows/claude-second-review.yml", "utf8");
const inlineCode = workflow.split("node --input-type=module <<'NODE'\n")[1]
  .split("          NODE")[0].replace(/^ {10}/gm, "");

function runReporter(directory, cwd) {
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: inlineCode, encoding: "utf8", cwd,
    env: { ...process.env, RUNNER_TEMP: directory },
  });
}

function assertReport(directory, expected, cwd) {
  const result = runReporter(directory, cwd);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `Second-pass review failed; error category hint: ${expected}. Raw output withheld.\n`);
}

function classifySecondReviewFailure(messages) {
  const directory = mkdtempSync(join(tmpdir(), "review-failure-"));
  try {
    writeFileSync(join(directory, "claude-execution-output.json"), JSON.stringify(messages));
    return runReporter(directory).stdout.match(/hint: ([a-z-]+)\./)?.[1];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const failure = (result) => ({ type: "result", is_error: true, subtype: "success", result });

test("classifies error-bearing SDK messages without exposing their contents", () => {
  for (const [text, expected] of [
    ["OAuth token expired: secret-token", "authentication"],
    ["Model not found: secret-model", "access-or-model"],
    ["429 Too many requests: secret-account", "rate-limit"],
    ["fetch failed: secret-url", "network-or-service"],
    ["unrecognized error: secret-value", "unknown"],
  ]) assert.equal(classifySecondReviewFailure([failure(text)]), expected);
  assert.equal(classifySecondReviewFailure([
    { type: "assistant", error: "authentication_failed", message: { content: [{ text: "secret-token" }] } },
  ]), "authentication");
  assert.equal(classifySecondReviewFailure([
    { type: "result", is_error: true, errors: ["ECONNRESET", { secret: "private" }] },
  ]), "network-or-service");
});

test("ignores ordinary prompts, tool responses and successful result text", () => {
  assert.equal(classifySecondReviewFailure([
    { type: "user", message: { content: "401 unauthorized" } },
    { type: "assistant", message: { content: [{ text: "429 rate limit" }] } },
    { type: "result", is_error: false, result: "fetch failed" },
  ]), "unknown");
  assert.equal(classifySecondReviewFailure([failure("401 unauthorized and 503 service failure")]), "unknown");
  assert.equal(classifySecondReviewFailure(null), "unavailable");
  assert.equal(classifySecondReviewFailure([null, {}, { type: "assistant", error: true }]), "unknown");
});

test("handles unavailable, malformed and oversized files without emitting exceptions", () => {
  const directory = mkdtempSync(join(tmpdir(), "review-failure-"));
  const path = join(directory, "claude-execution-output.json");
  try {
    assertReport(directory, "unavailable");

    writeFileSync(path, "secret-token {bad json");
    assertReport(directory, "unavailable");
    writeFileSync(path, JSON.stringify([failure("invalid token: secret-token")]));
    assertReport(directory, "authentication");
    truncateSync(path, 16 * 1024 * 1024 + 1);
    assertReport(directory, "unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI emits only a fixed category even with secret-bearing workflow commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "review-failure-"));
  try {
    writeFileSync(join(directory, "claude-execution-output.json"), JSON.stringify([
      failure("401 unauthorized secret-token\n::error::secret-prompt\n::add-mask::secret-output"),
    ]));
    assertReport(directory, "authentication");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failure reporting cannot turn a failed review into success", () => {
  assert.match(workflow, /name: Run the second-pass review\n        id: second_review/);
  assert.match(workflow, /if: \$\{\{ failure\(\) && steps\.second_review\.outcome == 'failure' \}\}/);
  assert.match(workflow, /node --input-type=module/);
  assert.doesNotMatch(inlineCode, /import .*from ["\']\./);
  assert.doesNotMatch(workflow, /continue-on-error:|show_full_output:|upload-artifact/);
});

test("workspace script tampering cannot alter the inline failure reporter", () => {
  const directory = mkdtempSync(join(tmpdir(), "review-tampering-"));
  try {
    mkdirSync(join(directory, "scripts/lib"), { recursive: true });
    writeFileSync(join(directory, "scripts/report-second-review-failure.mjs"), 'throw new Error("secret-token");');
    writeFileSync(join(directory, "scripts/lib/second-review-failure.mjs"), 'throw new Error("secret-prompt");');
    writeFileSync(join(directory, "claude-execution-output.json"), JSON.stringify([
      failure("401 unauthorized secret-token"),
    ]));
    assertReport(directory, "authentication", directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
