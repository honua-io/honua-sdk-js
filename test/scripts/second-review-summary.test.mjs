import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { completedFirstPassCommit, evaluateCompletedFirstPassSummary } from "../../scripts/lib/second-review-summary.mjs";

const head = "b".repeat(40);
const repository = "honua-io/honua-sdk-js";
const workflow = readFileSync(new URL("../../.github/workflows/claude-second-review.yml", import.meta.url), "utf8");

function summary(prefix = head.slice(0, 7)) {
  return {
    user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    performed_via_github_app: { id: 1144995, slug: "chatgpt-codex-connector" },
    updated_at: "2026-10-14T15:04:58Z",
    body: `<!-- codex-pull-request-review-summary -->\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-14T15:04:57.475714Z">2026-10-14T15:04:57.475714Z</relative-time> | \`${prefix}\` | Manual request |`,
  };
}

function resolve(comments = [summary()], resolveCommit = () => head, headSha = head) {
  return evaluateCompletedFirstPassSummary({ comments, resolveCommit, headSha });
}

describe("authenticated completed summary", () => {
  it("admits the real connector format only after resolving its exact full commit", () => {
    let requested;
    assert.deepEqual(resolve([summary()], (prefix) => { requested = prefix; return head; }), {
      completedSummary: true, commitPrefix: head.slice(0, 7), resolvedCommit: head, resolution: "exact-head",
    });
    assert.equal(requested, head.slice(0, 7));
  });

  const mutations = {
    human: (c) => ({ ...c, user: { login: "mikemcdougall", type: "User" } }),
    "lookalike-login": (c) => ({ ...c, user: { ...c.user, login: "fake-chatgpt-codex-connector[bot]" } }),
    "wrong-type": (c) => ({ ...c, user: { ...c.user, type: "User" } }),
    "missing-app": (c) => ({ ...c, performed_via_github_app: null }),
    "wrong-app-id": (c) => ({ ...c, performed_via_github_app: { ...c.performed_via_github_app, id: 1 } }),
    "wrong-app-slug": (c) => ({ ...c, performed_via_github_app: { ...c.performed_via_github_app, slug: "other" } }),
    "bad-updated-time": (c) => ({ ...c, updated_at: "invalid" }),
    running: (c) => ({ ...c, body: c.body.replace("Completed", "Running") }),
    queued: (c) => ({ ...c, body: c.body.replace("Completed", "Queued") }),
    failed: (c) => ({ ...c, body: c.body.replace("Completed", "Failed") }),
    "security-only": (c) => ({ ...c, body: c.body.replace("Code Review", "Security Review") }),
    "mismatched-time": (c) => ({ ...c, body: c.body.replace('datetime="2026', 'datetime="2025') }),
    "invalid-completion-time": (c) => ({ ...c, body: c.body.replaceAll("2026-10-14T15:04:57.475714Z", "invalid") }),
    "missing-marker": (c) => ({ ...c, body: c.body.replace("<!-- codex-pull-request-review-summary -->", "") }),
    "duplicate-row": (c) => ({ ...c, body: `${c.body}\n${c.body.split("\n").at(-1)}` }),
    "short-prefix": () => summary("bbb"),
    "injected-prefix": () => summary("$(touch /tmp/never)"),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    it(`rejects ${name} before performing any commit lookup`, () => {
      let lookedUp = false;
      assert.equal(resolve([mutate(summary())], () => { lookedUp = true; return head; }).completedSummary, false);
      assert.equal(lookedUp, false);
    });
  }

  it("never reuses an older completion while the latest summary is running", () => {
    const old = summary();
    const latest = { ...old, updated_at: "2026-10-14T15:05:00Z", body: old.body.replace("Completed", "Running") };
    assert.equal(resolve([old, latest]).completedSummary, false);
    assert.equal(resolve([latest, old]).completedSummary, false);
  });
  it("rejects ambiguous latest summaries and a configured different reviewer", () => {
    assert.equal(resolve([summary(), summary()]).completedSummary, false);
    assert.equal(completedFirstPassCommit([summary()], "other-reviewer"), undefined);
  });
  for (const [name, lookup] of Object.entries({
    "different-commit": () => "c".repeat(40),
    "prefix-collision": () => head.slice(0, 7) + "c".repeat(33),
    "unresolved-prefix": () => head.slice(0, 7),
    "lookup-failure": () => { throw new Error("GitHub rejected an ambiguous or unavailable commit"); },
  })) {
    it(`refuses ${name}`, () => assert.equal(resolve([summary()], lookup).completedSummary, false));
  }
  it("refuses a malformed current head before lookup", () => {
    assert.equal(resolve([summary()], () => { throw new Error("must not call"); }, "bad-head").completedSummary, false);
  });
});

function pr() {
  return {
    state: "OPEN", isDraft: false, headRefOid: head, headRepository: { nameWithOwner: repository },
    reviews: { totalCount: 0, nodes: [] }, reviewThreads: { totalCount: 0, nodes: [] },
  };
}

// Execute the actual workflow's jq policy rather than a second JS implementation.
function gate(value, completedSummary = true, alreadyReviewed = false) {
  const command = workflow.match(/          jq -r \\\n            --arg reviewer[\s\S]+?' pull-request\.json \| tee gate\.txt/)?.[0];
  assert.ok(command, "the production jq gate must remain discoverable");
  const directory = mkdtempSync(path.join(tmpdir(), "honua-second-review-policy-"));
  try {
    writeFileSync(path.join(directory, "pull-request.json"), JSON.stringify({ data: { repository: { pullRequest: value } } }));
    writeFileSync(path.join(directory, "summary-admission.json"), JSON.stringify({ completedSummary }));
    const scriptPath = path.join(directory, "gate.sh");
    writeFileSync(scriptPath, command.replace(/^ {10}/gm, ""));
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", scriptPath], {
      cwd: directory, encoding: "utf8",
      env: { ...process.env, FIRST_PASS_REVIEWER: "chatgpt-codex-connector", REPOSITORY: repository, already_reviewed: String(alreadyReviewed) },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("actual sequential gate composition", () => {
  it("adds the summary-only path while retaining legacy review-object admission", () => {
    assert.match(gate(pr()), /should_review=true/);
    assert.match(gate(pr(), false), /blocked_by=first_pass_done/);
    const recorded = { ...pr(), reviews: { totalCount: 1, nodes: [{ author: { login: "chatgpt-codex-connector" } }] } };
    assert.match(gate(recorded, false), /should_review=true/);
  });
  for (const scenario of ["closed", "draft", "fork", "truncated-reviews", "truncated-threads", "already-reviewed"]) {
    it(`retains ${scenario} refusal`, () => {
      const value = pr();
      if (scenario === "closed") value.state = "CLOSED";
      if (scenario === "draft") value.isDraft = true;
      if (scenario === "fork") value.headRepository.nameWithOwner = "outsider/fork";
      if (scenario === "truncated-reviews") value.reviews.totalCount = 101;
      if (scenario === "truncated-threads") value.reviewThreads.totalCount = 101;
      assert.match(gate(value, true, scenario === "already-reviewed"), /should_review=false/);
    });
  }
  for (const login of ["chatgpt-codex-connector", "another-reviewer"]) {
    it(`refuses unresolved ${login} findings on summary-only admission`, () => {
      const value = pr();
      value.reviewThreads = { totalCount: 1, nodes: [{ isResolved: false, comments: { nodes: [{ author: { login } }] } }] };
      assert.match(gate(value), /should_review=false/);
      value.reviewThreads.nodes[0].isResolved = true;
      assert.match(gate(value), /should_review=true/);
    });
  }
});

it("keeps comment-triggered review privileged code on the workflow implementation", () => {
  assert.match(workflow, /issue_comment:\n    types: \[created, edited\]/);
  assert.ok(workflow.includes("github.event.issue.pull_request &&"));
  assert.ok(workflow.includes("github.event.comment.user.login == 'chatgpt-codex-connector[bot]'"));
  assert.ok(workflow.includes("github.event.pull_request.number || github.event.issue.number || inputs.pull_request_number"));
  assert.ok(workflow.includes("--paginate --slurp"));
  assert.ok(workflow.includes("node scripts/evaluate-second-review-summary.mjs"));
  assert.equal((workflow.match(/ref: \$\{\{ github\.workflow_sha \}\}/g) ?? []).length, 2);
  assert.ok(!workflow.includes("ref: ${{ needs.gate.outputs.head_sha }}"));
  assert.ok(workflow.includes("contents/PATH --method GET -f ref=${{ needs.gate.outputs.head_sha }}"));
  assert.ok(workflow.includes("Never execute PR code"));
  assert.ok(workflow.includes("Before reading the diff and again before posting"));
  assert.ok(workflow.includes("--max-turns 60"));
  assert.ok(workflow.includes("timeout-minutes: 20"));
  assert.ok(!workflow.includes("post_merge_audit"));
  for (const [file, count] of [["ci.yml", 2], ["sdk-verification.yml", 1]]) {
    const text = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
    assert.equal(text.split("node --test test/scripts/second-review-summary.test.mjs").length - 1, count);
  }
});

it("isolates skipped comment events from the real pending-review concurrency group", () => {
  const concurrency = workflow.match(/concurrency:\n([\s\S]*?)\nenv:/)?.[1];
  assert.ok(concurrency);
  assert.ok(concurrency.includes("github.event_name == 'issue_comment' && (!github.event.issue.pull_request || github.event.comment.user.login != 'chatgpt-codex-connector[bot]') && github.run_id || github.event.pull_request.number || github.event.issue.number || inputs.pull_request_number"));
  assert.match(concurrency, /cancel-in-progress: false/);
});

it("explicitly reduces the exchanged reviewer App token's repository contents permission", () => {
  const review = workflow.slice(workflow.indexOf("  review:\n"));
  assert.match(review, /allowed_bots: chatgpt-codex-connector\[bot\]\n/);
  assert.equal((review.match(/allowed_bots:/g) ?? []).length, 1);
  assert.match(review, /additional_permissions: \|\n            contents: read\n/);
  assert.match(review, /permissions:\n      contents: read\n      pull-requests: write\n      id-token: write/);
});
