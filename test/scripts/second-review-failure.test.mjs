import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { classifySecondReviewFailure, readSecondReviewFailure } from "../../scripts/lib/second-review-failure.mjs";

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
  const path = join(directory, "output.json");
  try {
    assert.equal(readSecondReviewFailure(path), "unavailable");
    assert.equal(readSecondReviewFailure(directory), "unavailable");
    writeFileSync(path, "secret-token {bad json");
    assert.equal(readSecondReviewFailure(path), "unavailable");
    writeFileSync(path, JSON.stringify([failure("invalid token: secret-token")]));
    assert.equal(readSecondReviewFailure(path), "authentication");
    truncateSync(path, 16 * 1024 * 1024 + 1);
    assert.equal(readSecondReviewFailure(path), "unavailable");
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
    const result = spawnSync(process.execPath, ["scripts/report-second-review-failure.mjs"], {
      encoding: "utf8", env: { ...process.env, RUNNER_TEMP: directory },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "Second-pass review failed; error category hint: authentication. Raw output withheld.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failure reporting cannot turn a failed review into success", () => {
  const workflow = readFileSync(".github/workflows/claude-second-review.yml", "utf8");
  assert.match(workflow, /name: Run the second-pass review\n        id: second_review/);
  assert.match(workflow, /if: \$\{\{ failure\(\) && steps\.second_review\.outcome == 'failure' \}\}/);
  assert.match(workflow, /run: node scripts\/report-second-review-failure\.mjs/);
  assert.doesNotMatch(workflow, /continue-on-error:|show_full_output:|upload-artifact/);
});
